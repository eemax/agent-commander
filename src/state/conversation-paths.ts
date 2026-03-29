import * as path from "node:path";

export type ConversationStorageBucket = "active" | "stashed" | "archive";

export function toChatFolder(chatId: string): string {
  return encodeURIComponent(chatId);
}

export function currentRootPath(conversationsDir: string): string {
  return path.join(conversationsDir, "current");
}

export function archiveRootPath(conversationsDir: string): string {
  return path.join(conversationsDir, "archive");
}

export function activeConversationsIndexPath(conversationsDir: string): string {
  return path.join(currentRootPath(conversationsDir), "active-conversations.json");
}

export function stashedConversationsIndexPath(conversationsDir: string): string {
  return path.join(currentRootPath(conversationsDir), "stashed-conversations.json");
}

export function conversationJsonlPath(
  conversationsDir: string,
  bucket: ConversationStorageBucket,
  chatId: string,
  conversationId: string
): string {
  if (bucket === "archive") {
    return path.join(archiveRootPath(conversationsDir), toChatFolder(chatId), `${conversationId}.jsonl`);
  }

  return path.join(currentRootPath(conversationsDir), bucket, toChatFolder(chatId), `${conversationId}.jsonl`);
}

export function conversationSnapshotPath(
  conversationsDir: string,
  bucket: Exclude<ConversationStorageBucket, "archive">,
  chatId: string,
  conversationId: string
): string {
  return path.join(currentRootPath(conversationsDir), bucket, toChatFolder(chatId), `${conversationId}.md`);
}
