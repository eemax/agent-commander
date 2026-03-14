import type { ToolErrorCode, ToolErrorPayload } from "../types.js";

type ToolExpectedShape = {
  action?: string;
  required: string[];
  optional: string[];
};

export class ToolExecutionError extends Error {
  public readonly payload: ToolErrorPayload;

  public constructor(payload: ToolErrorPayload) {
    super(payload.error);
    this.name = "ToolExecutionError";
    this.payload = payload;
  }
}

export function createToolErrorPayload(params: {
  error: string;
  errorCode: ToolErrorCode;
  retryable: boolean;
  hints?: string[];
  expected?: ToolExpectedShape;
}): ToolErrorPayload {
  return {
    ok: false,
    error: params.error,
    errorCode: params.errorCode,
    retryable: params.retryable,
    hints: params.hints ?? [],
    ...(params.expected ? { expected: params.expected } : {})
  };
}

export function toToolErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof ToolExecutionError) {
    return error.payload;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createToolErrorPayload({
    error: message,
    errorCode: "TOOL_EXECUTION_ERROR",
    retryable: false
  });
}
