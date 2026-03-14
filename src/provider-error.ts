import type { ProviderErrorKind } from "./types.js";

export class ProviderError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly statusCode: number | null;
  public readonly attempts: number;
  public readonly retryable: boolean;

  public constructor(params: {
    message: string;
    kind: ProviderErrorKind;
    statusCode?: number | null;
    attempts: number;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "ProviderError";
    this.kind = params.kind;
    this.statusCode = params.statusCode ?? null;
    this.attempts = params.attempts;
    this.retryable = params.retryable;
  }
}
