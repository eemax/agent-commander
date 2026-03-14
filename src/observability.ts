import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createSpanId, createTraceId } from "./id.js";

export type TraceOrigin = "telegram" | "routing" | "provider" | "state" | "tool" | "runtime" | "system" | string;

export type TraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  origin: TraceOrigin;
};

export type ObservabilityEventV2 = {
  event: string;
  trace: TraceContext;
  timestamp?: string;
  chatId?: string;
  conversationId?: string;
  messageId?: string;
  [key: string]: unknown;
};

export type ObservabilityRedactionConfig = {
  enabled: boolean;
  maxStringChars: number;
  redactKeys: string[];
};

export const DEFAULT_OBSERVABILITY_REDACTION_KEYS = [
  "authorization",
  "api_key",
  "token",
  "secret",
  "password",
  "cookie",
  "set-cookie"
] as const;

export const DEFAULT_OBSERVABILITY_REDACTION: ObservabilityRedactionConfig = {
  enabled: true,
  maxStringChars: 4_000,
  redactKeys: [...DEFAULT_OBSERVABILITY_REDACTION_KEYS]
};

export type ObservabilitySink = {
  enabled: boolean;
  path: string | null;
  record: (event: ObservabilityEventV2) => Promise<void>;
};

function serializeValue(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const raw = JSON.stringify(value, (_key, current) => {
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
        cause: current.cause
      };
    }

    if (typeof current === "bigint") {
      return current.toString();
    }

    if (typeof current === "function") {
      return "[Function]";
    }

    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);
    }

    return current;
  });

  if (raw === undefined) {
    return null;
  }

  return JSON.parse(raw);
}

function normalizeRedactionConfig(
  redaction: Partial<ObservabilityRedactionConfig> | undefined
): ObservabilityRedactionConfig {
  const maxStringChars = Math.max(1, Math.floor(redaction?.maxStringChars ?? DEFAULT_OBSERVABILITY_REDACTION.maxStringChars));
  const redactKeys =
    redaction?.redactKeys && redaction.redactKeys.length > 0
      ? redaction.redactKeys
      : [...DEFAULT_OBSERVABILITY_REDACTION.redactKeys];
  return {
    enabled: redaction?.enabled ?? DEFAULT_OBSERVABILITY_REDACTION.enabled,
    maxStringChars,
    redactKeys
  };
}

function normalizeRedactionKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function applyRedactionAndTruncation(
  value: unknown,
  config: ObservabilityRedactionConfig,
  redactKeySet: Set<string>
): unknown {
  if (typeof value === "string") {
    if (value.length <= config.maxStringChars) {
      return value;
    }

    const truncatedChars = value.length - config.maxStringChars;
    return `${value.slice(0, config.maxStringChars)}...[TRUNCATED:+${truncatedChars} chars]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyRedactionAndTruncation(item, config, redactKeySet));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source)) {
    const normalizedKey = normalizeRedactionKey(key);
    if (config.enabled && redactKeySet.has(normalizedKey)) {
      redacted[key] = "[REDACTED]";
      continue;
    }

    redacted[key] = applyRedactionAndTruncation(raw, config, redactKeySet);
  }

  return redacted;
}

export function createTraceRootContext(origin: TraceOrigin): TraceContext {
  return {
    traceId: createTraceId(),
    spanId: createSpanId(),
    parentSpanId: null,
    origin
  };
}

export function createChildTraceContext(parent: TraceContext, origin: TraceOrigin = parent.origin): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: createSpanId(),
    parentSpanId: parent.spanId,
    origin
  };
}

export function createNoopObservabilitySink(): ObservabilitySink {
  return {
    enabled: false,
    path: null,
    async record(): Promise<void> {
      // no-op
    }
  };
}

export function createObservabilitySink(params: {
  enabled: boolean;
  logPath: string;
  redaction?: Partial<ObservabilityRedactionConfig>;
}): ObservabilitySink {
  if (!params.enabled) {
    return createNoopObservabilitySink();
  }

  const resolvedPath = path.resolve(params.logPath);
  const redactionConfig = normalizeRedactionConfig(params.redaction);
  const redactKeySet = new Set(redactionConfig.redactKeys.map((key) => normalizeRedactionKey(key)));
  let hasReportedWriteFailure = false;
  let ensureDirectoryPromise: Promise<void> | null = null;

  const ensureLogDirectory = async (): Promise<void> => {
    if (!ensureDirectoryPromise) {
      ensureDirectoryPromise = fs
        .mkdir(path.dirname(resolvedPath), { recursive: true })
        .then(() => undefined)
        .catch((error) => {
          ensureDirectoryPromise = null;
          throw error;
        });
    }
    await ensureDirectoryPromise;
  };

  return {
    enabled: true,
    path: resolvedPath,
    async record(event): Promise<void> {
      const serialized = serializeValue({
        timestamp: event.timestamp ?? new Date().toISOString(),
        ...event
      });
      const payload = applyRedactionAndTruncation(serialized, redactionConfig, redactKeySet);

      try {
        await ensureLogDirectory();
        await fs.appendFile(resolvedPath, `${JSON.stringify(payload)}\n`, "utf8");
      } catch (error) {
        if (hasReportedWriteFailure) {
          return;
        }

        hasReportedWriteFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `${new Date().toISOString()} [WARN] observability: failed to append event to ${resolvedPath}: ${message}`
        );
      }
    }
  };
}
