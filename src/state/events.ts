import { z } from "zod";
import type { ProviderErrorKind } from "../types.js";

const providerErrorKindSchema = z.enum([
  "timeout",
  "network",
  "http_408",
  "http_409",
  "rate_limit",
  "server_error",
  "client_error",
  "invalid_response",
  "unknown"
]);

const baseEventSchema = z.object({
  type: z.string(),
  timestamp: z.string().min(1),
  chatId: z.string().min(1),
  conversationId: z.string().min(1)
});

const conversationCreatedEventSchema = baseEventSchema.extend({
  type: z.literal("conversation_created"),
  reason: z.string().min(1)
});

const conversationArchiveEventSchema = baseEventSchema.extend({
  type: z.literal("conversation_archived"),
  reason: z.string().min(1)
});

const messageEventSchema = baseEventSchema.extend({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  senderId: z.string().nullable(),
  senderName: z.string().nullable(),
  telegramMessageId: z.string().nullable()
});

const providerFailureEventSchema = baseEventSchema.extend({
  type: z.literal("provider_failure"),
  kind: providerErrorKindSchema,
  statusCode: z.number().int().nullable(),
  attempts: z.number().int().nonnegative(),
  message: z.string().min(1),
  telegramMessageId: z.string().min(1)
});

const conversationEventSchema = z.discriminatedUnion("type", [
  conversationCreatedEventSchema,
  conversationArchiveEventSchema,
  messageEventSchema,
  providerFailureEventSchema
]);

export type ConversationCreatedEvent = z.infer<typeof conversationCreatedEventSchema>;
export type ConversationArchiveEvent = z.infer<typeof conversationArchiveEventSchema>;
export type MessageEvent = z.infer<typeof messageEventSchema>;
export type ProviderFailureEvent = z.infer<typeof providerFailureEventSchema> & {
  kind: ProviderErrorKind;
};
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

export function serializeConversationEvent(event: ConversationEvent): string {
  return JSON.stringify(event);
}

export function parseConversationEvent(line: string, sourcePath: string): ConversationEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Invalid JSONL event in ${sourcePath}`);
  }

  const result = conversationEventSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid conversation event in ${sourcePath}: ${message}`);
  }

  return result.data;
}
