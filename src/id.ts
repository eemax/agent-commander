import { monotonicFactory } from "ulid";

const nextUlid = monotonicFactory();

export function createConversationId(): string {
  return `conv_${nextUlid()}`;
}

export function createProcessSessionId(): string {
  return `proc_${nextUlid()}`;
}

export function createTraceId(): string {
  return `trace_${nextUlid()}`;
}

export function createSpanId(): string {
  return `span_${nextUlid()}`;
}
