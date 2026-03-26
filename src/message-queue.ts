import type { NormalizedTelegramMessage, MessageStreamingSink, ContentPart } from "./types.js";
import type { TraceContext } from "./observability.js";

export type AttachmentResolverResult = {
  userContent: string | ContentPart[] | undefined;
  errors: string[];
};

export type AttachmentResolver = () => Promise<AttachmentResolverResult>;

export type QueuedMessage = {
  message: NormalizedTelegramMessage;
  userContent?: string | ContentPart[];
  attachmentResolver?: AttachmentResolver;
  stream?: MessageStreamingSink;
  trace: TraceContext;
};

export type MessageQueue = {
  push(entry: QueuedMessage): number;
  drain(): QueuedMessage[];
  drainOne(): QueuedMessage | null;
  readonly length: number;
};

export function createMessageQueue(): MessageQueue {
  const buffer: QueuedMessage[] = [];

  return {
    push(entry: QueuedMessage): number {
      buffer.push(entry);
      return buffer.length;
    },
    drain(): QueuedMessage[] {
      const items = [...buffer];
      buffer.length = 0;
      return items;
    },
    drainOne(): QueuedMessage | null {
      return buffer.shift() ?? null;
    },
    get length(): number {
      return buffer.length;
    }
  };
}
