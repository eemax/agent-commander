import type { ProviderErrorKind } from "./types.js";

export type ProviderFailureDetail = {
  reason: string;
  openaiErrorType: string | null;
  openaiErrorCode: string | null;
  openaiErrorParam: string | null;
  requestId: string | null;
  retryAfterMs: number | null;
  timedOutBy: "local_timeout" | "upstream_abort" | null;
};

export class ProviderError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly statusCode: number | null;
  public readonly attempts: number;
  public readonly retryable: boolean;
  public readonly detail: ProviderFailureDetail | null;

  public constructor(params: {
    message: string;
    kind: ProviderErrorKind;
    statusCode?: number | null;
    attempts: number;
    retryable: boolean;
    detail?: ProviderFailureDetail | null;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "ProviderError";
    this.kind = params.kind;
    this.statusCode = params.statusCode ?? null;
    this.attempts = params.attempts;
    this.retryable = params.retryable;
    this.detail = params.detail ?? null;
  }
}
