import type { Config } from "./contracts.js";
import { loadConfig } from "../config.js";
import { createToolHarness } from "../harness/index.js";
import { createLogger } from "../logger.js";
import { createObservabilitySink, createTraceRootContext } from "../observability.js";
import { createOpenAIProvider } from "../provider.js";
import { createMessageRouter } from "../routing.js";
import { createConversationStore } from "../state/conversations.js";
import { createTelegramBot } from "../telegram/bot.js";
import { createWorkspaceManager } from "../workspace.js";
import { resolveActiveModel } from "../model-catalog.js";
import { resolveActiveWebSearchModel } from "../web-search-catalog.js";

export async function startRuntime(repoRoot: string): Promise<void> {
  const config = loadConfig(repoRoot);
  const logger = createLogger(config.runtime.logLevel, {
    appLogPath: config.paths.appLogPath,
    flushIntervalMs: config.runtime.appLogFlushIntervalMs
  });

  const observability = createObservabilitySink({
    enabled: config.observability.enabled,
    logPath: config.observability.logPath,
    redaction: config.observability.redaction
  });

  logger.info(`startup: config loaded from ${config.configPath}`);
  logger.info(
    `startup: full observability ${config.observability.enabled ? "enabled" : "disabled"}${
      config.observability.enabled ? ` (${config.observability.logPath})` : ""
    }`
  );
  const startupTrace = createTraceRootContext("runtime");
  await observability.record({
    event: "runtime.startup",
    trace: startupTrace,
    enabled: observability.enabled,
    path: observability.path,
    configPath: config.configPath
  });

  await bootstrapRuntime(config, logger, observability);
}

async function bootstrapRuntime(
  config: Config,
  logger: ReturnType<typeof createLogger>,
  observability: ReturnType<typeof createObservabilitySink>
): Promise<void> {
  const workspace = createWorkspaceManager(config);
  await workspace.bootstrap();
  logger.info(`startup: workspace ready at ${config.paths.workspaceRoot}`);
  if (config.tools.webSearch.apiKey === null) {
    logger.warn("startup: web_search disabled (config.tools.web_search.api_key is null)");
  } else {
    logger.info("startup: web_search enabled");
  }

  const conversations = createConversationStore({
    conversationsDir: config.paths.conversationsDir,
    stashedConversationsPath: config.paths.stashedConversationsPath,
    activeConversationsPath: config.paths.activeConversationsPath,
    defaultVerboseMode: config.runtime.defaultVerbose,
    defaultThinkingEffort: resolveActiveModel({
      models: config.openai.models,
      defaultModelId: config.openai.model,
      overrideModelId: null
    }).defaultThinking,
    sessionCacheMaxEntries: config.runtime.sessionCacheMaxEntries,
    observability
  });

  const harness = createToolHarness(
    {
      defaultCwd: config.tools.defaultCwd,
      defaultShell: config.tools.defaultShell,
      execTimeoutMs: config.tools.execTimeoutMs,
      execYieldMs: config.tools.execYieldMs,
      processLogTailLines: config.tools.processLogTailLines,
      logPath: config.tools.logPath,
      completedSessionRetentionMs: config.tools.completedSessionRetentionMs,
      maxCompletedSessions: config.tools.maxCompletedSessions,
      maxOutputChars: config.tools.maxOutputChars,
      webSearch: config.tools.webSearch
    },
    {
      observability,
      resolveWebSearchModel: async (ownerId) => {
        if (!ownerId) return config.tools.webSearch.model;
        const override = await conversations.getActiveWebSearchModelOverride(ownerId);
        return resolveActiveWebSearchModel({
          models: config.tools.webSearch.models,
          defaultModelId: config.tools.webSearch.model,
          overrideModelId: override
        }).id;
      }
    }
  );

  const provider = createOpenAIProvider(config, logger, {
    harness,
    observability
  });
  logger.info(`startup: provider initialized (openai/responses/${config.openai.model})`);

  let syncCommandsRef: (() => Promise<void>) | null = null;

  const router = createMessageRouter({
    logger,
    provider,
    config,
    conversations,
    workspace,
    harness,
    observability,
    onCommandCatalogChanged: async () => {
      if (syncCommandsRef) {
        await syncCommandsRef();
      }
    }
  });
  logger.info("startup: router initialized");

  const telegram = createTelegramBot({
    token: config.telegram.botToken,
    streamingEnabled: config.telegram.streamingEnabled,
    streamingMinUpdateMs: config.telegram.streamingMinUpdateMs,
    assistantFormat: config.telegram.assistantFormat,
    logger,
    handleMessage: router.handleIncomingMessage,
    handleCallbackQuery: router.handleIncomingCallbackQuery,
    getCommands: async () => workspace.getSnapshot().commands,
    observability
  });
  syncCommandsRef = telegram.syncCommands;

  await telegram.syncCommands();

  const me = await telegram.bot.api.getMe();
  logger.info(`startup: telegram initialized as @${me.username ?? me.id}`);

  const shutdown = (signal: string) => {
    logger.info(`shutdown: received ${signal}`);
    telegram.bot.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("startup: starting telegram polling loop");
  await telegram.bot.start({
    drop_pending_updates: false,
    onStart: () => {
      logger.info("startup: bot polling active");
    }
  });
}
