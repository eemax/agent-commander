import * as path from "node:path";
import type { ObservabilitySink, TraceContext } from "../observability.js";
import { ToolCallLogger } from "./logger.js";
import { applyPatchTool } from "./patch-tools.js";
import { ProcessManager } from "./process-manager.js";
import { ToolRegistry } from "./registry.js";
import { bashTool, processTool } from "./shell-tools.js";
import { readFileTool, replaceInFileTool, writeFileTool } from "./file-tools.js";
import { createWebSearchTool, type WebSearchClientFactory } from "./web-search-tool.js";
import { createWebFetchTool, type DefuddleRunner, type WebFetchClientFactory } from "./web-fetch-tool.js";
import type { HarnessConfig, JsonValue, ProviderFunctionTool, ToolContext, ToolRuntimeMetrics } from "./types.js";

export type ToolHarness = {
  config: HarnessConfig;
  context: ToolContext;
  registry: ToolRegistry;
  metrics: ToolRuntimeMetrics;
  execute: (name: string, args: unknown, trace?: TraceContext) => Promise<JsonValue>;
  executeWithOwner: (ownerId: string, name: string, args: unknown, trace?: TraceContext) => Promise<JsonValue>;
  exportProviderTools: () => ProviderFunctionTool[];
};

export function createToolHarness(
  config: HarnessConfig,
  deps: {
    observability?: ObservabilitySink;
    createWebSearchClient?: WebSearchClientFactory;
    createWebFetchClient?: WebFetchClientFactory;
    runDefuddle?: DefuddleRunner;
  } = {}
): ToolHarness {
  const defaultCwd = path.resolve(config.defaultCwd);
  const webSearchConfig = config.webSearch ?? {
    apiKey: null,
    maxTokens: 10_000,
    maxTokensPerPage: 4_096
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
    createWebFetchTool(
      {
        apiKey: webSearchConfig.apiKey
      },
      {
        createClient: deps.createWebFetchClient,
        runDefuddle: deps.runDefuddle
      }
    )
  );
  if (webSearchConfig.apiKey !== null) {
    registry.register(
      createWebSearchTool(
        {
          apiKey: webSearchConfig.apiKey,
          maxTokens: webSearchConfig.maxTokens,
          maxTokensPerPage: webSearchConfig.maxTokensPerPage
        },
        {
          createClient: deps.createWebSearchClient
        }
      )
    );
  }

  const executeWithOwner = (ownerId: string, name: string, args: unknown, trace?: TraceContext): Promise<JsonValue> => {
    const scopedContext: ToolContext = {
      ...context,
      ownerId,
      trace
    };

    return registry.execute(name, args, scopedContext);
  };

  return {
    config: context.config,
    context,
    registry,
    metrics,
    execute: (name, args, trace) => registry.execute(name, args, { ...context, trace }),
    executeWithOwner,
    exportProviderTools: () => registry.exportProviderTools()
  };
}

export * from "./types.js";
export * from "./schemas.js";
export { ToolRegistry } from "./registry.js";
export { ProcessManager } from "./process-manager.js";
