const DEFAULT_MAX_CHARS = 300;

export function sanitizeReason(raw: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const normalized = raw
    .replace(/\s+/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._\-=]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "sk-[REDACTED]")
    .trim();

  if (normalized.length === 0) {
    return "Provider request failed";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}
