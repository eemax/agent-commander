export function renderUsage(): string {
  return [
    "Usage:",
    "  acmd",
    "  acmd help",
    "  acmd status",
    "  acmd start [--rebuild]",
    "  acmd stop",
    "  acmd restart [--rebuild]",
    "  acmd doctor"
  ].join("\n");
}
