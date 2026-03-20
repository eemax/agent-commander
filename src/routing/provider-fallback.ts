import type { ProviderFailureDetail } from "../provider-error.js";
import type { ProviderErrorKind } from "../types.js";

const DETAIL_MAX_CHARS = 240;

const FALLBACK_BY_KIND: Record<ProviderErrorKind, string> = {
  timeout: "The provider request timed out. Please try again.",
  network: "Network error while contacting provider. Please try again.",
  rate_limit: "Provider rate limit reached. Please retry shortly.",
  server_error: "Provider service error. Please try again shortly.",
  client_error: "Provider rejected this request configuration.",
  invalid_response: "Provider returned an invalid response.",
  unknown: "Temporary provider error. Please try again."
};

function sanitizeDetail(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  if (normalized.length <= DETAIL_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, DETAIL_MAX_CHARS - 3)}...`;
}

export function buildProviderFallbackText(params: {
  kind: ProviderErrorKind;
  detail?: ProviderFailureDetail | null;
  includeDetail?: boolean;
}): string {
  const base = FALLBACK_BY_KIND[params.kind] ?? FALLBACK_BY_KIND.unknown;
  const includeDetail = params.includeDetail ?? false;
  if (!includeDetail) {
    return base;
  }

  const reason = params.detail?.reason?.trim() ?? "";
  if (reason.length === 0) {
    return base;
  }

  return `${base}\nDetails: ${sanitizeDetail(reason)}`;
}
