export function formatConversationIdTail(conversationId: string): string {
  return conversationId.slice(-4);
}

export function formatConversationIdForUi(conversationId: string): string {
  return `conv...${formatConversationIdTail(conversationId)}`;
}
