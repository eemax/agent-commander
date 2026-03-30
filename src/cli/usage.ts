export function renderUsage(): string {
  return [
    "acmd — agent-commander lifecycle manager",
    "",
    "Usage:",
    "  acmd help",
    "  acmd version",
    "  acmd status",
    "  acmd start [--rebuild]",
    "  acmd stop",
    "  acmd restart [--rebuild]",
    "  acmd doctor"
  ].join("\n");
}
