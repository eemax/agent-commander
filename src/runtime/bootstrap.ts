import type { Config } from "./contracts.js";
import { loadAgentsManifest, loadAgentConfig, validateUniqueBotTokens, type AgentDefinition } from "../agents.js";
import { loadEnvFile, extractAgentSecrets } from "../env.js";
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
import { createCodexAuthManager, type CodexAuthManager } from "../auth/codex-auth.js";
import { createAuthModeRegistry } from "../provider/auth-mode-registry.js";

type AgentRuntime = {
  bot: ReturnType<typeof createTelegramBot>["bot"];
  logger: ReturnType<typeof createLogger>;
};

export async function startRuntime(repoRoot: string): Promise<void> {
  const envMap = loadEnvFile(repoRoot);
  const manifest = loadAgentsManifest(repoRoot);

  const agentConfigs: Array<{ agent: AgentDefinition; config: Config }> = [];
  for (const agent of manifest.agents) {
    const secrets = extractAgentSecrets(envMap, agent.id);
    const config = loadAgentConfig(repoRoot, agent, secrets);
    agentConfigs.push({ agent, config });
  }

  validateUniqueBotTokens(agentConfigs);

  const runtimes: AgentRuntime[] = [];
  for (const { agent, config } of agentConfigs) {
    const runtime = await bootstrapAgentRuntime(agent, config);
    runtimes.push(runtime);
  }

  const shutdown = (signal: string) => {
    for (const rt of runtimes) {
      rt.logger.info(`shutdown: received ${signal}`);
      try {
        rt.bot.stop();
      } catch {
        // best-effort stop
      }
    }
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await Promise.all(
    runtimes.map((rt) =>
      rt.bot.start({
        drop_pending_updates: false,
        onStart: () => {
          rt.logger.info("startup: bot polling active");
        }
      })
    )
  );
}

async function bootstrapAgentRuntime(
  agent: AgentDefinition,
  config: Config
): Promise<AgentRuntime> {
  const logger = createLogger(config.runtime.logLevel, {
    appLogPath: config.paths.appLogPath,
    flushIntervalMs: config.runtime.appLogFlushIntervalMs,
    tag: agent.id
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
    configPath: config.configPath,
    agentId: agent.id
  });
  const workspace = createWorkspaceManager(config, logger);
  await workspace.bootstrap();
  logger.info(`startup: workspace ready at ${config.paths.workspaceRoot}`);
  if (config.tools.webSearch.apiKey === null) {
    logger.warn("startup: web_search disabled (DEFAULT_PERPLEXITY_API_KEY is unset)");
  } else {
    logger.info("startup: web_search enabled");
  }
  const defaultModel = resolveActiveModel({
    models: config.openai.models,
    defaultModelId: config.openai.model,
    overrideModelId: null
  });

  const conversations = createConversationStore({
    conversationsDir: config.paths.conversationsDir,
    stashedConversationsPath: config.paths.stashedConversationsPath,
    activeConversationsPath: config.paths.activeConversationsPath,
    defaultWorkingDirectory: config.tools.defaultCwd,
    defaultVerboseMode: config.runtime.defaultVerbose,
    defaultThinkingEffort: defaultModel.defaultThinking,
    defaultCacheRetention: defaultModel.cacheRetention,
    defaultAuthMode: config.openai.authMode,
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
      webSearch: config.tools.webSearch,
      subagents: config.subagents
    },
    {
      observability,
      resolveDefaultCwd: async (ownerId) => {
        if (!ownerId) return config.tools.defaultCwd;
        return conversations.getWorkingDirectory(ownerId);
      },
      resolveWebSearchModel: async (ownerId) => {
        if (!ownerId) return config.tools.webSearch.defaultPreset;
        const override = await conversations.getActiveWebSearchModelOverride(ownerId);
        return resolveActiveWebSearchModel({
          models: config.tools.webSearch.presets,
          defaultPresetId: config.tools.webSearch.defaultPreset,
          overridePresetId: override
        }).id;
      }
    }
  );

  // Create CodexAuthManager eagerly so /auth codex works mid-conversation
  let codexAuth: CodexAuthManager | undefined;
  try {
    codexAuth = createCodexAuthManager(logger);
  } catch (err) {
    logger.info("startup: codex auth not available (no ~/.codex/auth.json), /auth codex will be unavailable");
  }

  const authModeRegistry = createAuthModeRegistry({
    apiKey: config.openai.apiKey,
    codexAuth: codexAuth ?? null
  });

  // Fail fast if the configured default auth mode is unavailable
  const defaultAuthAvail = authModeRegistry.get(config.openai.authMode).availability();
  if (!defaultAuthAvail.ok) {
    throw new Error(`auth_mode is "${config.openai.authMode}" but it is not available: ${defaultAuthAvail.reason}`);
  }

  const provider = createOpenAIProvider(config, logger, {
    harness,
    observability,
    authModeRegistry,
    resolveOwnerProviderSettings: async (ownerId: string) => ({
      authMode: await conversations.getAuthMode(ownerId),
      transportMode: await conversations.getTransportMode(ownerId)
    })
  });
  logger.info(`startup: provider initialized (openai/responses/${config.openai.model}, auth=${config.openai.authMode})`);

  let syncCommandsRef: (() => Promise<void>) | null = null;

  const router = createMessageRouter({
    logger,
    provider,
    config,
    conversations,
    workspace,
    harness,
    observability,
    authModeRegistry,
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
    maxFileSizeBytes: config.telegram.maxFileSizeBytes,
    fileDownloadTimeoutMs: config.telegram.fileDownloadTimeoutMs,
    maxConcurrentDownloads: config.telegram.maxConcurrentDownloads,
    logger,
    handleMessage: router.handleIncomingMessage,
    handleCallbackQuery: router.handleIncomingCallbackQuery,
    getCommands: async () => workspace.getSnapshot().commands,
    isAuthorizedSender: (senderId: string) => config.access.allowedSenderIds.has(senderId),
    observability
  });
  syncCommandsRef = telegram.syncCommands;

  await telegram.syncCommands();

  const me = await telegram.bot.api.getMe();
  logger.info(`startup: telegram initialized as @${me.username ?? me.id}`);
  return { bot: telegram.bot, logger };
}
