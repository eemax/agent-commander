type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

export type ToolExpectedShape = {
  action?: string;
  required: string[];
  optional: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function firstDefined(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return out.length > 0 ? out : undefined;
  }

  if (typeof value === "string") {
    const normalized = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function readQueryValue(value: unknown): string | string[] | undefined {
  const single = readNonEmptyString(value);
  if (single !== undefined) {
    return single;
  }

  return readStringArray(value);
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

function readEnvRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      out[key] = item;
      continue;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      out[key] = String(item);
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      out[key] = item;
    }
  }
  return out;
}

function normalizeBashArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    command: readString(firstDefined(source, ["command", "cmd"])),
    cwd: readNonEmptyString(firstDefined(source, ["cwd", "working_directory", "workingDirectory"])),
    env: readEnvRecord(source.env),
    timeoutMs: readPositiveInt(firstDefined(source, ["timeoutMs", "timeout_ms", "timeout"])),
    yieldMs: readPositiveInt(firstDefined(source, ["yieldMs", "yield_ms"])),
    background: readBoolean(firstDefined(source, ["background", "bg"])),
    shell: readNonEmptyString(source.shell)
  });
}

function normalizeProcessArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  const action = readNonEmptyString(firstDefined(source, ["action", "op", "cmd"]))?.toLowerCase();
  const sessionId = readNonEmptyString(firstDefined(source, ["sessionId", "session_id", "session"]));
  const tailLines = readPositiveInt(firstDefined(source, ["tailLines", "tail_lines", "tail"]));
  const input = readString(firstDefined(source, ["input", "stdin", "data"]));
  const signal = readNonEmptyString(source.signal);

  const normalized = { action, sessionId, tailLines, input, signal };

  switch (action) {
    case "list":
      return dropUndefined({ action: "list" });
    case "poll":
      return dropUndefined({ action: "poll", sessionId });
    case "log":
      return dropUndefined({ action: "log", sessionId, tailLines });
    case "write":
      return dropUndefined({ action: "write", sessionId, input });
    case "kill":
      return dropUndefined({ action: "kill", sessionId, signal });
    case "clear":
      return dropUndefined({ action: "clear", sessionId });
    case "remove":
      return dropUndefined({ action: "remove", sessionId });
    default:
      return dropUndefined(normalized);
  }
}

function normalizeReadFileArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    path: readString(firstDefined(source, ["path", "file", "filePath", "file_path"])),
    offsetLine: readPositiveInt(firstDefined(source, ["offsetLine", "offset_line", "startLine", "start_line"])),
    limitLines: readPositiveInt(firstDefined(source, ["limitLines", "limit_lines", "maxLines", "max_lines"])),
    encoding: readNonEmptyString(source.encoding)
  });
}

function normalizeWriteFileArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    path: readString(firstDefined(source, ["path", "file", "filePath", "file_path"])),
    content: readString(firstDefined(source, ["content", "text", "body"])),
    encoding: readNonEmptyString(source.encoding)
  });
}

function normalizeReplaceInFileArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    path: readString(firstDefined(source, ["path", "file", "filePath", "file_path"])),
    oldText: readString(firstDefined(source, ["oldText", "old_text", "findText", "find_text"])),
    newText: readString(firstDefined(source, ["newText", "new_text", "replaceText", "replace_text"])),
    replaceAll: readBoolean(firstDefined(source, ["replaceAll", "replace_all"]))
  });
}

function normalizeApplyPatchArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    patch: readString(firstDefined(source, ["patch", "diff"])),
    cwd: readNonEmptyString(firstDefined(source, ["cwd", "working_directory", "workingDirectory"]))
  });
}

function normalizeWebSearchArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    query: readQueryValue(firstDefined(source, ["query", "q", "queries"])),
    country: readNonEmptyString(firstDefined(source, ["country", "country_code", "region"])),
    max_results: readPositiveInt(firstDefined(source, ["max_results", "maxResults", "max_results_count", "limit"])),
    search_domain_filter: readStringArray(
      firstDefined(source, ["search_domain_filter", "searchDomainFilter", "domain_filter", "domainFilter", "domains"])
    ),
    search_language_filter: readStringArray(
      firstDefined(source, ["search_language_filter", "searchLanguageFilter", "language_filter", "languageFilter", "languages"])
    ),
    search_after_date_filter: readNonEmptyString(
      firstDefined(source, ["search_after_date_filter", "searchAfterDateFilter"])
    ),
    search_before_date_filter: readNonEmptyString(
      firstDefined(source, ["search_before_date_filter", "searchBeforeDateFilter"])
    ),
    last_updated_after_filter: readNonEmptyString(
      firstDefined(source, ["last_updated_after_filter", "lastUpdatedAfterFilter"])
    ),
    last_updated_before_filter: readNonEmptyString(
      firstDefined(source, ["last_updated_before_filter", "lastUpdatedBeforeFilter"])
    ),
    display_server_time: readBoolean(firstDefined(source, ["display_server_time", "displayServerTime"])),
    search_recency_filter: readNonEmptyString(
      firstDefined(source, ["search_recency_filter", "searchRecencyFilter", "recency", "timeframe"])
    )?.toLowerCase()
  });
}

function normalizeWebFetchArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    url: readNonEmptyString(firstDefined(source, ["url", "uri", "link", "href"]))
  });
}

function getProcessExpectedShape(args: Record<string, unknown>): ToolExpectedShape {
  const action = readNonEmptyString(args.action)?.toLowerCase();
  switch (action) {
    case "list":
      return { action: "list", required: ["action"], optional: [] };
    case "poll":
      return { action: "poll", required: ["action", "sessionId"], optional: [] };
    case "log":
      return { action: "log", required: ["action", "sessionId"], optional: ["tailLines"] };
    case "write":
      return { action: "write", required: ["action", "sessionId", "input"], optional: [] };
    case "kill":
      return { action: "kill", required: ["action", "sessionId"], optional: ["signal"] };
    case "clear":
      return { action: "clear", required: ["action", "sessionId"], optional: [] };
    case "remove":
      return { action: "remove", required: ["action", "sessionId"], optional: [] };
    default:
      return { required: ["action"], optional: ["sessionId", "tailLines", "input", "signal"] };
  }
}

export function getExpectedShapeForTool(tool: string, args: Record<string, unknown>): ToolExpectedShape | undefined {
  switch (tool) {
    case "bash":
      return { required: ["command"], optional: ["cwd", "env", "timeoutMs", "yieldMs", "background", "shell"] };
    case "process":
      return getProcessExpectedShape(args);
    case "read_file":
      return { required: ["path"], optional: ["offsetLine", "limitLines", "encoding"] };
    case "write_file":
      return { required: ["path", "content"], optional: ["encoding"] };
    case "replace_in_file":
      return { required: ["path", "oldText", "newText"], optional: ["replaceAll"] };
    case "apply_patch":
      return { required: ["patch"], optional: ["cwd"] };
    case "web_search":
      return {
        required: ["query"],
        optional: ["country", "max_results", "search_domain_filter", "search_recency_filter"]
      };
    case "web_fetch":
      return {
        required: ["url"],
        optional: []
      };
    default:
      return undefined;
  }
}

export function normalizeToolArgs(tool: string, args: unknown): Record<string, unknown> {
  switch (tool) {
    case "bash":
      return normalizeBashArgs(args);
    case "process":
      return normalizeProcessArgs(args);
    case "read_file":
      return normalizeReadFileArgs(args);
    case "write_file":
      return normalizeWriteFileArgs(args);
    case "replace_in_file":
      return normalizeReplaceInFileArgs(args);
    case "apply_patch":
      return normalizeApplyPatchArgs(args);
    case "web_search":
      return normalizeWebSearchArgs(args);
    case "web_fetch":
      return normalizeWebFetchArgs(args);
    default:
      return asRecord(args);
  }
}

function stableValue(value: unknown): JsonLike {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (typeof value === "object") {
    const out: { [key: string]: JsonLike } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return String(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
