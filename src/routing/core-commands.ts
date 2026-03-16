import type { ToolHarness } from "../harness/index.js";
import type { TraceContext } from "../observability.js";
import { resolveActiveModel, resolveModelReference } from "../model-catalog.js";
import { resolveActiveWebSearchModel, resolveWebSearchModelReference } from "../web-search-catalog.js";
import type { StateStore, WorkspaceCatalog, Config, StashedConversationSummary } from "../runtime/contracts.js";
import {
  THINKING_EFFORT_VALUES,
  type MessageRouteResult,
  type NormalizedTelegramCallbackQuery,
  type NormalizedTelegramMessage,
  type TelegramInlineButton,
  type TelegramInlineKeyboard
} from "../types.js";
import { formatConversationIdForUi, formatConversationIdTail } from "./conversation-id.js";
import { buildStatusReply, formatBashReply, formatCompactNumber } from "./formatters.js";

const THINKING_EFFORT_SET: ReadonlySet<string> = new Set(THINKING_EFFORT_VALUES);
const MENU_PAGE_SIZE = 6;
const CALLBACK_PREFIX = "convmenu";

type ConversationMenuKind = "new" | "stash";

type PendingConversationMenu = {
  token: string;
  kind: ConversationMenuKind;
  chatId: string;
  senderId: string;
  stashAlias: string | null;
  stashes: StashedConversationSummary[];
  page: number;
};

export type CoreCommandHandler = {
  handleCommand: (
    command: string,
    args: string,
    message: NormalizedTelegramMessage,
    trace?: TraceContext
  ) => Promise<MessageRouteResult | null>;
  handleCallbackQuery: (
    query: NormalizedTelegramCallbackQuery,
    trace?: TraceContext
  ) => Promise<MessageRouteResult | null>;
};

function isThinkingEffort(value: string): value is (typeof THINKING_EFFORT_VALUES)[number] {
  return THINKING_EFFORT_SET.has(value);
}

function pluralize(value: number, singular: string): string {
  return value === 1 ? singular : `${singular}s`;
}

function formatRelativeStashAge(stashedAt: string, nowMs: number): string {
  const parsedMs = Date.parse(stashedAt);
  if (!Number.isFinite(parsedMs)) {
    return "unknown";
  }

  const elapsedMs = Math.max(0, nowMs - parsedMs);
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes <= 0) {
    return "just now";
  }

  if (totalMinutes < 60) {
    return `${totalMinutes} ${pluralize(totalMinutes, "minute")} ago`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `${totalHours}h ${minutes}m ago` : `${totalHours}h ago`;
  }

  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (totalDays < 7) {
    return hours > 0 ? `${totalDays}d ${hours}h ago` : `${totalDays}d ago`;
  }

  const totalWeeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;
  if (totalWeeks < 5) {
    return days > 0 ? `${totalWeeks}w ${days}d ago` : `${totalWeeks}w ago`;
  }

  const totalMonths = Math.floor(totalDays / 30);
  if (totalMonths < 12) {
    const monthDays = totalDays % 30;
    return monthDays > 0 ? `${totalMonths}mo ${monthDays}d ago` : `${totalMonths}mo ago`;
  }

  const totalYears = Math.floor(totalDays / 365);
  const yearMonths = Math.floor((totalDays % 365) / 30);
  return yearMonths > 0 ? `${totalYears}y ${yearMonths}mo ago` : `${totalYears}y ago`;
}

function buildStashListReply(stashes: StashedConversationSummary[], now: Date = new Date()): string {
  if (stashes.length === 0) {
    return "No stashes found. Use /stash <name> to create one.";
  }

  const nowMs = now.getTime();
  const lines = ["stashes:"];
  for (const stash of stashes) {
    lines.push(
      `- ${stash.alias} · ${formatConversationIdTail(stash.conversationId)} · ${formatRelativeStashAge(
        stash.stashedAt,
        nowMs
      )}`
    );
  }
  return lines.join("\n");
}

function createMenuToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function buildCallbackData(token: string, action: string): string {
  return `${CALLBACK_PREFIX}:${token}:${action}`;
}

function parseCallbackData(data: string): { token: string; action: string } | null {
  const parts = data.split(":");
  if (parts.length < 3 || parts[0] !== CALLBACK_PREFIX) {
    return null;
  }

  const token = parts[1]?.trim();
  const action = parts.slice(2).join(":").trim();
  if (!token || !action) {
    return null;
  }

  return {
    token,
    action
  };
}

function normalizePage(page: number, totalItems: number): number {
  const totalPages = Math.max(1, Math.ceil(totalItems / MENU_PAGE_SIZE));
  if (page < 0) {
    return 0;
  }
  if (page >= totalPages) {
    return totalPages - 1;
  }
  return page;
}

function buildMenuKeyboard(menu: PendingConversationMenu): TelegramInlineKeyboard {
  const page = normalizePage(menu.page, menu.stashes.length);
  const start = page * MENU_PAGE_SIZE;
  const pageItems = menu.stashes.slice(start, start + MENU_PAGE_SIZE);

  const rows: TelegramInlineKeyboard = [];
  for (let index = 0; index < pageItems.length; index += 2) {
    const pair = pageItems.slice(index, index + 2);
    const row: TelegramInlineButton[] = pair.map((item) => ({
      text: `${item.alias} · ${formatConversationIdTail(item.conversationId)}`,
      callbackData: buildCallbackData(menu.token, `s:${item.conversationId}`)
    }));
    rows.push(row);
  }

  rows.push([
    {
      text: "New",
      callbackData: buildCallbackData(menu.token, "n")
    }
  ]);

  const totalPages = Math.max(1, Math.ceil(menu.stashes.length / MENU_PAGE_SIZE));
  if (totalPages > 1) {
    const navRow: TelegramInlineButton[] = [];
    if (page > 0) {
      navRow.push({
        text: "Prev",
        callbackData: buildCallbackData(menu.token, `p:${page - 1}`)
      });
    }
    if (page < totalPages - 1) {
      navRow.push({
        text: "Next",
        callbackData: buildCallbackData(menu.token, `p:${page + 1}`)
      });
    }
    if (navRow.length > 0) {
      rows.push(navRow);
    }
  }

  return rows;
}

function buildMenuText(menu: PendingConversationMenu): string {
  const totalPages = Math.max(1, Math.ceil(menu.stashes.length / MENU_PAGE_SIZE));
  const page = normalizePage(menu.page, menu.stashes.length);
  const pageLine = `menu page: ${page + 1}/${totalPages}`;

  if (menu.kind === "new") {
    return [
      "Select a stashed conversation or choose New.",
      "The current conversation will be archived when you select an option.",
      pageLine
    ].join("\n");
  }

  return [
    `Stash current conversation as: ${menu.stashAlias ?? "(missing alias)"}`,
    "Then select a stashed conversation or choose New.",
    pageLine
  ].join("\n");
}

function buildSelectionTarget(action: string): { type: "new" } | { type: "stash"; conversationId: string } | null {
  if (action === "n") {
    return { type: "new" };
  }

  if (action.startsWith("s:")) {
    const conversationId = action.slice(2).trim();
    if (conversationId.length === 0) {
      return null;
    }
    return {
      type: "stash",
      conversationId
    };
  }

  return null;
}

export function createCoreCommandHandler(params: {
  config: Config;
  conversations: StateStore;
  workspace: WorkspaceCatalog;
  harness: ToolHarness;
}): CoreCommandHandler {
  const { config, conversations, workspace, harness } = params;
  const pendingMenus = new Map<string, PendingConversationMenu>();

  const createMenuReply = (menu: PendingConversationMenu): MessageRouteResult => ({
    type: "reply",
    text: buildMenuText(menu),
    inlineKeyboard: buildMenuKeyboard(menu)
  });

  const registerMenu = (menuInput: Omit<PendingConversationMenu, "token">): PendingConversationMenu => {
    const token = createMenuToken();
    const menu: PendingConversationMenu = {
      ...menuInput,
      token
    };
    pendingMenus.set(token, menu);
    return menu;
  };

  return {
    async handleCommand(
      command: string,
      args: string,
      message: NormalizedTelegramMessage,
      trace?: TraceContext
    ): Promise<MessageRouteResult | null> {
      switch (command) {
        case "start":
          return {
            type: "reply",
            text: "Agent Commander is online. Use /status to inspect the active session."
          };
        case "new": {
          const stashes = await conversations.listStashedConversations(message.chatId);
          const menu = registerMenu({
            kind: "new",
            chatId: message.chatId,
            senderId: message.senderId,
            stashAlias: null,
            stashes,
            page: 0
          });
          return createMenuReply(menu);
        }
        case "stash": {
          const stashAlias = args.trim();
          if (stashAlias.length === 0) {
            return {
              type: "reply",
              text: "Usage: /stash <name>"
            };
          }

          if (stashAlias.toLowerCase() === "list") {
            const stashes = await conversations.listStashedConversations(message.chatId);
            return {
              type: "reply",
              text: buildStashListReply(stashes)
            };
          }

          const stashes = await conversations.listStashedConversations(message.chatId);
          const menu = registerMenu({
            kind: "stash",
            chatId: message.chatId,
            senderId: message.senderId,
            stashAlias,
            stashes,
            page: 0
          });
          return createMenuReply(menu);
        }
        case "status": {
          const statusArg = args.trim().toLowerCase();
          const includeDiagnostics = statusArg === "full";
          if (statusArg.length > 0 && !includeDiagnostics) {
            return {
              type: "reply",
              text: "Usage: /status [full]"
            };
          }

          const conversationId = await conversations.ensureActiveConversation(message.chatId);
          const [verboseEnabled, thinkingEffort, activeModelOverride, webSearchModelOverride, latestUsage, toolResultStats] = await Promise.all([
            conversations.getVerboseMode(message.chatId),
            conversations.getThinkingEffort(message.chatId),
            conversations.getActiveModelOverride(message.chatId),
            conversations.getActiveWebSearchModelOverride(message.chatId),
            conversations.getLatestUsageSnapshot(message.chatId),
            conversations.getToolResultStats(message.chatId)
          ]);
          const activeModel = resolveActiveModel({
            models: config.openai.models,
            defaultModelId: config.openai.model,
            overrideModelId: activeModelOverride
          });
          const webSearchModel = config.tools.webSearch.apiKey !== null
            ? resolveActiveWebSearchModel({
                models: config.tools.webSearch.models,
                defaultModelId: config.tools.webSearch.model,
                overrideModelId: webSearchModelOverride
              }).id
            : null;
          const ownedSessions = harness.context.processManager.listSessionsByOwner(message.chatId);
          const runningSessions = ownedSessions
            .filter((session) => session.status === "running")
            .map((session) => ({
              sessionId: session.sessionId,
              command: session.command
            }));
          const completedProcessCount = ownedSessions.length - runningSessions.length;

          const snapshot = workspace.getSnapshot();
          const processHealth = harness.context.processManager.getHealth();
          const toolRuntime = harness.metrics;
          return {
            type: "reply",
            text: buildStatusReply({
              conversationId,
              model: activeModel.id,
              webSearchModel,
              modelContextWindow: activeModel.contextWindow,
              modelMaxOutputTokens: activeModel.maxOutputTokens,
              workspaceRoot: config.paths.workspaceRoot,
              skillsCount: snapshot.skills.length,
              fullObservabilityEnabled: config.observability.enabled,
              verboseEnabled,
              thinkingEffort,
              latestUsage,
              sessions: runningSessions,
              completedProcessCount,
              stateHealth: conversations.getHealth(),
              workspaceHealth: workspace.getHealth(),
              processHealth: {
                truncatedCombinedChars: processHealth.truncatedCombinedChars,
                truncatedStdoutChars: processHealth.truncatedStdoutChars,
                truncatedStderrChars: processHealth.truncatedStderrChars
              },
              toolRuntime: {
                toolSuccessCount: toolRuntime.toolSuccessCount,
                toolFailureCount: toolRuntime.toolFailureCount,
                errorCodeCounts: { ...toolRuntime.errorCodeCounts },
                workflowsStarted: toolRuntime.workflowsStarted,
                workflowsSucceeded: toolRuntime.workflowsSucceeded,
                workflowsFailed: toolRuntime.workflowsFailed,
                workflowsTimedOut: toolRuntime.workflowsTimedOut,
                workflowsInterrupted: toolRuntime.workflowsInterrupted,
                workflowsCleanupErrors: toolRuntime.workflowsCleanupErrors,
                workflowLoopBreakerTrips: toolRuntime.workflowLoopBreakerTrips
              },
              toolResultStats,
              compactionTokens: activeModel.compactionTokens,
              compactionThreshold: activeModel.compactionThreshold,
              includeDiagnostics
            })
          };
        }
        case "stop": {
          const killed = harness.context.processManager.killRunningSessionsByOwner(message.chatId);
          const lines = [`stopped sessions: ${killed.killed}`];
          if (killed.sessionIds.length > 0) {
            lines.push(...killed.sessionIds.map((sessionId) => `- ${sessionId}`));
          }

          return {
            type: "reply",
            text: lines.join("\n")
          };
        }
        case "bash": {
          if (args.length === 0) {
            return {
              type: "reply",
              text: "Usage: /bash <shell command>"
            };
          }

          const result = await harness.executeWithOwner(message.chatId, "bash", {
            command: args
          });

          return {
            type: "reply",
            text: formatBashReply(result)
          };
        }
        case "verbose": {
          const state = args.trim().toLowerCase();

          if (state === "on") {
            await conversations.setVerboseMode(message.chatId, true, { trace });
            return {
              type: "reply",
              text: "verbose mode: on"
            };
          }

          if (state === "off") {
            await conversations.setVerboseMode(message.chatId, false, { trace });
            return {
              type: "reply",
              text: "verbose mode: off"
            };
          }

          const enabled = await conversations.getVerboseMode(message.chatId);
          return {
            type: "reply",
            text: [`Usage: /verbose <on|off>`, `verbose mode: ${enabled ? "on" : "off"}`].join("\n")
          };
        }
        case "thinking": {
          const nextEffort = args.trim().toLowerCase();

          if (isThinkingEffort(nextEffort)) {
            await conversations.setThinkingEffort(message.chatId, nextEffort, { trace });
            return {
              type: "reply",
              text: `thinking effort: ${nextEffort}`
            };
          }

          const current = await conversations.getThinkingEffort(message.chatId);
          return {
            type: "reply",
            text: [
              "Usage: /thinking <none|minimal|low|medium|high|xhigh>",
              `thinking effort: ${current}`
            ].join("\n")
          };
        }
        case "model": {
          const selection = args.trim();
          const activeModelOverride = await conversations.getActiveModelOverride(message.chatId);
          const activeModel = resolveActiveModel({
            models: config.openai.models,
            defaultModelId: config.openai.model,
            overrideModelId: activeModelOverride
          });

          if (selection.length === 0) {
            return {
              type: "reply",
              text: [
                "Usage: /model <id-or-alias>",
                "Tip: use /models to list available ids and aliases.",
                `model: ${activeModel.id}`
              ].join("\n")
            };
          }

          const resolved = resolveModelReference(config.openai.models, selection);
          if (!resolved) {
            return {
              type: "reply",
              text: [`Unknown model: ${selection}`, "Use /models to list available options."].join("\n")
            };
          }

          await conversations.setActiveModelOverride(message.chatId, resolved.id, { trace });
          await conversations.setThinkingEffort(message.chatId, resolved.defaultThinking, { trace });
          return {
            type: "reply",
            text: [`model: ${resolved.id}`, `thinking effort: ${resolved.defaultThinking} (model default)`].join("\n")
          };
        }
        case "models": {
          const activeModelOverride = await conversations.getActiveModelOverride(message.chatId);
          const activeModel = resolveActiveModel({
            models: config.openai.models,
            defaultModelId: config.openai.model,
            overrideModelId: activeModelOverride
          });

          const lines = ["models:"];
          for (const model of config.openai.models) {
            const marker = model.id === activeModel.id ? "*" : "-";
            const contextWindow =
              model.contextWindow === null ? "unknown context" : `${formatCompactNumber(model.contextWindow)} context`;
            const maxOutput =
              model.maxOutputTokens === null ? "unknown max output" : `${formatCompactNumber(model.maxOutputTokens)} max output`;
            const defaultThinking = `${model.defaultThinking} default think`;
            const aliasText = model.aliases.length > 0 ? `aliases: ${model.aliases.join(", ")}` : "aliases: none";
            lines.push(`${marker} ${model.id} (${contextWindow}; ${maxOutput}; ${defaultThinking}; ${aliasText})`);
          }
          lines.push(`active model: ${activeModel.id}`);
          lines.push("Use /model <id-or-alias> to switch.");
          return {
            type: "reply",
            text: lines.join("\n")
          };
        }
        case "search": {
          if (config.tools.webSearch.apiKey === null) {
            return {
              type: "reply",
              text: "Web search is disabled (no API key configured)."
            };
          }

          const selection = args.trim();
          const wsOverride = await conversations.getActiveWebSearchModelOverride(message.chatId);
          const activeWsModel = resolveActiveWebSearchModel({
            models: config.tools.webSearch.models,
            defaultModelId: config.tools.webSearch.model,
            overrideModelId: wsOverride
          });

          if (selection.length === 0) {
            const lines = [
              "Usage: /search <id-or-alias>",
              `search model: ${activeWsModel.id}`,
              "available:"
            ];
            for (const model of config.tools.webSearch.models) {
              const marker = model.id === activeWsModel.id ? "*" : "-";
              const aliasText = model.aliases.length > 0 ? `aliases: ${model.aliases.join(", ")}` : "aliases: none";
              lines.push(`${marker} ${model.id} (${aliasText})`);
            }
            return {
              type: "reply",
              text: lines.join("\n")
            };
          }

          const resolved = resolveWebSearchModelReference(config.tools.webSearch.models, selection);
          if (!resolved) {
            return {
              type: "reply",
              text: [`Unknown search model: ${selection}`, "Use /search to list available options."].join("\n")
            };
          }

          await conversations.setActiveWebSearchModelOverride(message.chatId, resolved.id, { trace });
          return {
            type: "reply",
            text: `search model: ${resolved.id}`
          };
        }
        default:
          return null;
      }
    },

    async handleCallbackQuery(query: NormalizedTelegramCallbackQuery, trace?: TraceContext): Promise<MessageRouteResult | null> {
      const parsed = parseCallbackData(query.data);
      if (!parsed) {
        return null;
      }

      const menu = pendingMenus.get(parsed.token);
      if (!menu) {
        return {
          type: "reply",
          text: "That menu is expired. Run /new or /stash again."
        };
      }

      if (menu.chatId !== query.chatId || menu.senderId !== query.senderId) {
        return {
          type: "reply",
          text: "That menu is not valid for this sender/chat."
        };
      }

      // Every callback token is single-use.
      pendingMenus.delete(parsed.token);

      if (parsed.action.startsWith("p:")) {
        const nextPageRaw = Number(parsed.action.slice(2));
        if (!Number.isInteger(nextPageRaw)) {
          return {
            type: "reply",
            text: "Invalid menu page. Run /new or /stash again."
          };
        }

        const nextMenu = registerMenu({
          ...menu,
          page: normalizePage(nextPageRaw, menu.stashes.length)
        });
        return createMenuReply(nextMenu);
      }

      const target = buildSelectionTarget(parsed.action);
      if (!target) {
        return {
          type: "reply",
          text: "Invalid menu action. Run /new or /stash again."
        };
      }

      try {
        if (menu.kind === "new") {
          const result = await conversations.completeNewSelection(query.chatId, target, "manual_new_command", { trace });
          const archived = result.archivedConversationId ? formatConversationIdForUi(result.archivedConversationId) : "none";
          return {
            type: "reply",
            text: [
              target.type === "new" ? "started new conversation" : "switched to stashed conversation",
              `conversation: ${formatConversationIdForUi(result.conversationId)}`,
              `alias: ${result.alias ?? "none"}`,
              `archived: ${archived}`
            ].join("\n")
          };
        }

        const stashAlias = menu.stashAlias?.trim() ?? "";
        if (stashAlias.length === 0) {
          return {
            type: "reply",
            text: "Usage: /stash <name>"
          };
        }

        const result = await conversations.completeStashSelection(
          query.chatId,
          stashAlias,
          target,
          "manual_stash_command",
          {
            trace
          }
        );

        return {
          type: "reply",
          text: [
            `stashed: ${formatConversationIdForUi(result.stashedConversationId)} as ${result.stashedAlias}`,
            target.type === "new" ? "started new conversation" : "switched to stashed conversation",
            `conversation: ${formatConversationIdForUi(result.conversationId)}`,
            `alias: ${result.alias ?? "none"}`
          ].join("\n")
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("stashed conversation not found")) {
          return {
            type: "reply",
            text: "That stash is no longer available. Run /new or /stash again."
          };
        }

        throw error;
      }
    }
  };
}
