import { createSteerChannel, type SteerChannel } from "../steer-channel.js";
import { createMessageQueue, type MessageQueue } from "../message-queue.js";

type ActiveTurn = {
  token: string;
  controller: AbortController;
  messageId: string;
  steerChannel: SteerChannel;
};

export type TurnHandle = {
  token: string;
  controller: AbortController;
  steerChannel: SteerChannel;
  interruptedPrevious: boolean;
};

export class TurnManager {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly latestTurnTokenByChat = new Map<string, string>();
  private readonly pendingMessages = new Map<string, MessageQueue>();

  beginTurn(chatId: string, messageId: string): TurnHandle {
    const previous = this.activeTurns.get(chatId);
    let interruptedPrevious = false;
    if (previous) {
      interruptedPrevious = true;
      previous.controller.abort();
    }

    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const controller = new AbortController();
    const steerChannel = createSteerChannel();
    this.latestTurnTokenByChat.set(chatId, token);
    this.activeTurns.set(chatId, { token, controller, messageId, steerChannel });

    return { token, controller, steerChannel, interruptedPrevious };
  }

  releaseTurn(chatId: string, token: string): void {
    const current = this.activeTurns.get(chatId);
    if (current?.token === token) {
      this.activeTurns.delete(chatId);
    }
  }

  isLatestTurn(chatId: string, token: string): boolean {
    return this.latestTurnTokenByChat.get(chatId) === token;
  }

  getActiveTurn(chatId: string): ActiveTurn | undefined {
    return this.activeTurns.get(chatId);
  }

  abortActiveTurn(chatId: string): boolean {
    const active = this.activeTurns.get(chatId);
    if (active) {
      active.controller.abort();
      return true;
    }
    return false;
  }

  getOrCreateQueue(chatId: string): MessageQueue {
    let queue = this.pendingMessages.get(chatId);
    if (!queue) {
      queue = createMessageQueue();
      this.pendingMessages.set(chatId, queue);
    }
    return queue;
  }

  getQueue(chatId: string): MessageQueue | undefined {
    return this.pendingMessages.get(chatId);
  }

  deleteQueue(chatId: string): void {
    this.pendingMessages.delete(chatId);
  }
}
