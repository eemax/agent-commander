import type { RuntimeLogger, WorkspaceCatalog, Config } from "../runtime/contracts.js";
import { createChildTraceContext, type ObservabilitySink, type TraceContext } from "../observability.js";
import type { MessageRouteResult, TelegramCommandDefinition } from "../types.js";

type WorkspaceRefreshResult = Awaited<ReturnType<WorkspaceCatalog["refresh"]>>;
type WorkspaceRefreshState = {
  lastSuccessfulRefreshAtMs: number;
  inFlight: Promise<WorkspaceRefreshResult> | null;
};

const WORKSPACE_REFRESH_DEBOUNCE_MS = 1_000;
const workspaceRefreshState = new WeakMap<WorkspaceCatalog, WorkspaceRefreshState>();

async function refreshWorkspaceDebounced(workspace: WorkspaceCatalog): Promise<WorkspaceRefreshResult> {
  const now = Date.now();
  const state = workspaceRefreshState.get(workspace) ?? {
    lastSuccessfulRefreshAtMs: 0,
    inFlight: null
  };
  workspaceRefreshState.set(workspace, state);

  if (state.inFlight) {
    return state.inFlight;
  }

  if (now - state.lastSuccessfulRefreshAtMs < WORKSPACE_REFRESH_DEBOUNCE_MS) {
    return {
      snapshot: workspace.getSnapshot(),
      changed: false
    };
  }

  const refreshPromise = workspace
    .refresh()
    .then((result) => {
      state.lastSuccessfulRefreshAtMs = Date.now();
      return result;
    })
    .finally(() => {
      if (state.inFlight === refreshPromise) {
        state.inFlight = null;
      }
    });

  state.inFlight = refreshPromise;
  return refreshPromise;
}

export async function runMessageGatekeeping(params: {
  chatId: string;
  messageId: string;
  messageSenderId: string;
  logger: RuntimeLogger;
  config: Config;
  workspace: WorkspaceCatalog;
  trace: TraceContext;
  observability?: ObservabilitySink;
  onCommandCatalogChanged?: (commands: TelegramCommandDefinition[]) => Promise<void>;
}): Promise<MessageRouteResult | null> {
  const gatekeepingTrace = createChildTraceContext(params.trace, "routing");

  if (!params.config.access.allowedSenderIds.has(params.messageSenderId)) {
    params.logger.warn(`telegram: sender ${params.messageSenderId} is not in allowed_sender_ids`);
    await params.observability?.record({
      event: "routing.gatekeeping.checked",
      trace: gatekeepingTrace,
      stage: "checked",
      chatId: params.chatId,
      messageId: params.messageId,
      senderId: params.messageSenderId,
      allowed: false
    });
    return {
      type: "unauthorized",
      text: "This sender is not authorized for this bot."
    };
  }

  const refreshed = await refreshWorkspaceDebounced(params.workspace);
  await params.observability?.record({
    event: "routing.gatekeeping.checked",
    trace: gatekeepingTrace,
    stage: "checked",
    chatId: params.chatId,
    messageId: params.messageId,
    senderId: params.messageSenderId,
    allowed: true,
    workspaceChanged: refreshed.changed
  });

  if (refreshed.changed && params.onCommandCatalogChanged) {
    await params.onCommandCatalogChanged(refreshed.snapshot.commands);
  }

  return null;
}
