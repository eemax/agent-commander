import * as path from "node:path";
import type { ObservabilityRedactionConfig, ObservabilitySink, TraceContext } from "../observability.js";
import { ToolCallLogger } from "./logger.js";
import { applyPatchTool } from "./patch-tools.js";
import { ProcessManager } from "./process-manager.js";
import { ToolRegistry } from "./registry.js";
import { bashTool, processTool } from "./shell-tools.js";
import { readFileTool, replaceInFileTool, writeFileTool } from "./file-tools.js";
import { createWebSearchTool, type WebSearchClientFactory } from "./web-search-tool.js";
import { createWebFetchTool, type DefuddleRunner } from "./web-fetch-tool.js";
import { SubagentManager } from "./subagent-manager.js";
import { createSubagentLogSink, type SubagentLogSink } from "../subagent-log.js";
import { subagentsTool } from "./subagent-tool.js";
import type { HarnessConfig, JsonValue, ProviderFunctionTool, ToolContext, ToolRuntimeMetrics } from "./types.js";

export type ToolHarness = {
  config: HarnessConfig;
  context: ToolContext;
  registry: ToolRegistry;
  metrics: ToolRuntimeMetrics;
  execute: (name: string, args: unknown, trace?: TraceContext, abortSignal?: AbortSignal) => Promise<JsonValue>;
  executeWithOwner: (ownerId: string, name: string, args: unknown, trace?: TraceContext, abortSignal?: AbortSignal) => Promise<JsonValue>;
  exportProviderTools: () => ProviderFunctionTool[];
  resolveDefaultCwd?: (ownerId: string | null) => Promise<string>;
};

export function createToolHarness(
  config: HarnessConfig,
  deps: {
    observability?: ObservabilitySink;
    subagentLog?: SubagentLogSink;
    subagentLogRedaction?: Partial<ObservabilityRedactionConfig>;
    createWebSearchClient?: WebSearchClientFactory;
    resolveDefaultCwd?: (ownerId: string | null) => Promise<string>;
    resolveWebSearchModel?: (ownerId: string | null) => Promise<string>;
    runDefuddle?: DefuddleRunner;
  } = {}
): ToolHarness {
  const defaultCwd = path.resolve(config.defaultCwd);
  const webSearchConfig = config.webSearch ?? {
    apiKey: null,
    defaultPreset: "pro-search",
    presets: []
  };
  const logger = new ToolCallLogger(config.logPath, defaultCwd);
  const processManager = new ProcessManager({
    completedSessionRetentionMs: config.completedSessionRetentionMs,
    maxCompletedSessions: config.maxCompletedSessions,
    maxOutputChars: config.maxOutputChars
  });
  const metrics: ToolRuntimeMetrics = {
    toolSuccessCount: 0,
    toolFailureCount: 0,
    errorCodeCounts: {},
    workflowsStarted: 0,
    workflowsSucceeded: 0,
    workflowsFailed: 0,
    workflowsTimedOut: 0,
    workflowsInterrupted: 0,
    workflowsCleanupErrors: 0,
    workflowLoopBreakerTrips: 0
  };

  const subagentConfig = config.subagents;
  const subagentLog = subagentConfig?.enabled === true
    ? (deps.subagentLog ?? createSubagentLogSink({
        enabled: true,
        logPath: subagentConfig.logPath,
        redaction: deps.subagentLogRedaction
      }))
    : undefined;
  const subagentManager = subagentConfig?.enabled === true
    ? new SubagentManager(
        {
          defaultModel: subagentConfig?.defaultModel ?? "gpt-5.4-mini",
          maxConcurrentTasks: subagentConfig?.maxConcurrentTasks ?? 10,
          defaultTimeBudgetSec: subagentConfig?.defaultTimeBudgetSec ?? 900,
          defaultMaxTurns: subagentConfig?.defaultMaxTurns ?? 30,
          defaultMaxTotalTokens: subagentConfig?.defaultMaxTotalTokens ?? 500_000,
          defaultHeartbeatIntervalSec: subagentConfig?.defaultHeartbeatIntervalSec ?? 30,
          defaultIdleTimeoutSec: subagentConfig?.defaultIdleTimeoutSec ?? 120,
          defaultStallTimeoutSec: subagentConfig?.defaultStallTimeoutSec ?? 300,
          defaultRequirePlanByTurn: subagentConfig?.defaultRequirePlanByTurn ?? 3,
          recvMaxEvents: subagentConfig?.recvMaxEvents ?? 100,
          recvDefaultWaitMs: subagentConfig?.recvDefaultWaitMs ?? 200,
          awaitMaxTimeoutMs: subagentConfig?.awaitMaxTimeoutMs ?? 30_000
        },
        undefined,
        deps.observability,
        subagentLog
      )
    : undefined;

  const context: ToolContext = {
    config: {
      ...config,
      defaultCwd,
      webSearch: webSearchConfig
    },
    processManager,
    logger,
    metrics,
    ownerId: null,
    trace: undefined,
    observability: deps.observability,
    subagentLog,
    subagentManager
  };

  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(processTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(replaceInFileTool);
  registry.register(applyPatchTool);
  registry.register(
    createWebFetchTool({
      runDefuddle: deps.runDefuddle
    })
  );
  if (webSearchConfig.apiKey !== null) {
    const defaultPreset = webSearchConfig.defaultPreset;
    const resolveModel = deps.resolveWebSearchModel ?? (async () => defaultPreset);
    registry.register(
      createWebSearchTool(
        {
          apiKey: webSearchConfig.apiKey,
          resolveModel
        },
        {
          createClient: deps.createWebSearchClient
        }
      )
    );
  }
  if (subagentManager) {
    registry.register(subagentsTool);
  }

  const executeScoped = (
    ownerId: string | null,
    name: string,
    args: unknown,
    trace?: TraceContext,
    abortSignal?: AbortSignal
  ): Promise<JsonValue> => {
    return (async () => {
      const resolvedDefaultCwd = deps.resolveDefaultCwd
        ? path.resolve(await deps.resolveDefaultCwd(ownerId))
        : defaultCwd;
      const scopedContext: ToolContext = {
        ...context,
        config: {
          ...context.config,
          defaultCwd: resolvedDefaultCwd
        },
        ownerId,
        trace,
        abortSignal
      };

      return registry.execute(name, args, scopedContext);
    })();
  };

  const executeWithOwner = (ownerId: string, name: string, args: unknown, trace?: TraceContext, abortSignal?: AbortSignal): Promise<JsonValue> =>
    executeScoped(ownerId, name, args, trace, abortSignal);

  return {
    config: context.config,
    context,
    registry,
    metrics,
    execute: (name, args, trace, abortSignal) => executeScoped(null, name, args, trace, abortSignal),
    executeWithOwner,
    exportProviderTools: () => registry.exportProviderTools(),
    resolveDefaultCwd: deps.resolveDefaultCwd
  };
}

export * from "./types.js";
export * from "./schemas.js";
export { ToolRegistry } from "./registry.js";
export { ProcessManager } from "./process-manager.js";
