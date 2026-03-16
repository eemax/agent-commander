import type { TraceContext } from "./observability.js";

export type PromptRole = "user" | "assistant";

export const THINKING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORT_VALUES)[number];

export type NormalizedTelegramMessage = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  receivedAt: string;
};

export type NormalizedTelegramCallbackQuery = {
  callbackQueryId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  data: string;
  receivedAt: string;
};

export type TelegramInlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramInlineKeyboard = TelegramInlineButton[][];

export type PromptMessage = {
  role: PromptRole;
  content: string;
  createdAt: string;
  senderId: string | null;
  senderName: string | null;
};

export type ProviderRequest = {
  chatId: string;
  conversationId: string;
  messageId?: string;
  model: string;
  history: PromptMessage[];
  instructions: string;
  thinkingEffort: ThinkingEffort;
  compactionTokens: number | null;
  compactionThreshold: number;
  trace?: TraceContext;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onToolCall?: (event: ToolCallReport) => void | Promise<void>;
  onToolProgress?: (event: ToolProgressEvent) => void | Promise<void>;
  onUsage?: (usage: ProviderUsageSnapshot) => void | Promise<void>;
};

export type Provider = {
  generateReply(input: ProviderRequest): Promise<string>;
};

export type MessageStreamingSink = {
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export type ToolErrorCode =
  | "TOOL_VALIDATION_ERROR"
  | "TOOL_EXECUTION_ERROR"
  | "TOOL_TIMEOUT"
  | "TOOL_LOOP_BREAKER"
  | "WORKFLOW_TIMEOUT"
  | "WORKFLOW_INTERRUPTED"
  | "CLEANUP_ERROR";

export type ToolErrorPayload = {
  ok: false;
  error: string;
  errorCode: ToolErrorCode;
  retryable: boolean;
  hints: string[];
  expected?: {
    action?: string;
    required: string[];
    optional: string[];
  };
};

export type ToolWorkflowState =
  | "INIT"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "INTERRUPTED"
  | "CLEANUP"
  | "DONE";

export type ToolProgressEvent = {
  type: "state" | "step" | "tool" | "poll" | "heartbeat" | "cleanup";
  message: string;
  elapsedMs: number;
  state?: ToolWorkflowState;
  step?: number;
  attempt?: number;
  maxAttempts?: number;
  tool?: string;
  sessionId?: string;
  errorCode?: ToolErrorCode;
};

export type ToolCallReport = {
  tool: string;
  args: unknown;
  result: unknown;
  success: boolean;
  error: string | null;
  errorCode?: ToolErrorCode | null;
};

export type ProviderUsageSnapshot = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  peakInputTokens?: number | null;
  peakOutputTokens?: number | null;
  peakContextTokens?: number | null;
};

export type ProviderErrorKind =
  | "timeout"
  | "network"
  | "http_408"
  | "http_409"
  | "rate_limit"
  | "server_error"
  | "client_error"
  | "invalid_response"
  | "unknown";

export type MessageRouteResult =
  | {
      type: "reply";
      text: string;
      extraReplies?: string[];
      origin?: "assistant" | "system";
      inlineKeyboard?: TelegramInlineKeyboard;
    }
  | {
      type: "unauthorized";
      text: string;
      inlineKeyboard?: TelegramInlineKeyboard;
    }
  | {
      type: "fallback";
      text: string;
      extraReplies?: string[];
      inlineKeyboard?: TelegramInlineKeyboard;
    }
  | {
      type: "ignore";
    };

export type SkillDefinition = {
  slug: string;
  name: string;
  description: string;
  path: string;
  content: string;
};

export type TelegramCommandDefinition = {
  command: string;
  description: string;
  kind: "core" | "skill";
  skillSlug?: string;
};

export type WorkspaceSnapshot = {
  workspaceRoot: string;
  agentsPath: string;
  agentsContent: string;
  agentsSha256: string;
  soulPath: string;
  soulContent: string;
  soulSha256: string;
  skillsDir: string;
  skills: SkillDefinition[];
  commands: TelegramCommandDefinition[];
  signature: string;
};
