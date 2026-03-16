import * as path from "node:path";
import type { ObservabilitySink, TraceContext } from "../observability.js";
import { ToolCallLogger } from "./logger.js";
import { applyPatchTool } from "./patch-tools.js";
import { ProcessManager } from "./process-manager.js";
import { ToolRegistry } from "./registry.js";
import { bashTool, processTool } from "./shell-tools.js";
import { readFileTool, replaceInFileTool, writeFileTool } from "./file-tools.js";
import { createWebSearchTool, type WebSearchClientFactory } from "./web-search-tool.js";
import { createWebFetchTool, type DefuddleRunner } from "./web-fetch-tool.js";
import type { HarnessConfig, JsonValue, ProviderFunctionTool, ToolContext, ToolRuntimeMetrics } from "./types.js";

export type ToolHarness = {
  config: HarnessConfig;
  context: ToolContext;
  registry: ToolRegistry;
  metrics: ToolRuntimeMetrics;
  execute: (name: string, args: unknown, trace?: TraceContext, abortSignal?: AbortSignal) => Promise<JsonValue>;
  executeWithOwner: (ownerId: string, name: string, args: unknown, trace?: TraceContext, abortSignal?: AbortSignal) => Promise<JsonValue>;
  exportProviderTools: () => ProviderFunctionTool[];
};

export function createToolHarness(
  config: HarnessConfig,
  deps: {
    observability?: ObservabilitySink;
    createWebSearchClient?: WebSearchClientFactory;
    resolveWebSearchModel?: (ownerId: string | null) => Promise<string>;
    runDefuddle?: DefuddleRunner;
  } = {}
): ToolHarness {
  const defaultCwd = path.resolve(config.defaultCwd);
  const webSearchConfig = config.webSearch ?? {
    apiKey: null,
    model: "sonar",
    models: []
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
    observability: deps.observability
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
    const defaultModel = webSearchConfig.model;
    const resolveModel = deps.resolveWebSearchModel ?? (async () => defaultModel);
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

  const executeWithOwner = (ownerId: string, name: string, args: unknown, trace?: TraceContext, abortSignal?: AbortSignal): Promise<JsonValue> => {
    const scopedContext: ToolContext = {
      ...context,
      ownerId,
      trace,
      abortSignal
    };

    return registry.execute(name, args, scopedContext);
  };

  return {
    config: context.config,
    context,
    registry,
    metrics,
    execute: (name, args, trace, abortSignal) => registry.execute(name, args, { ...context, trace, abortSignal }),
    executeWithOwner,
    exportProviderTools: () => registry.exportProviderTools()
  };
}

export * from "./types.js";
export * from "./schemas.js";
export { ToolRegistry } from "./registry.js";
export { ProcessManager } from "./process-manager.js";
