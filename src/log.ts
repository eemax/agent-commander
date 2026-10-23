// stdout/stderr logger. Info, warnings and errors always print; debug is toggled at runtime.

let debugEnabled = false;

type Fields = Record<string, string | number | boolean | null | undefined>;

function format(level: string, message: string, fields?: Fields): string {
  const parts = [new Date().toISOString(), level, message];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    const text = String(value).replace(/\s+/g, " ");
    parts.push(`${key}=${/[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text}`);
  }
  return parts.join(" ");
}

export const log = {
  info: (message: string, fields?: Fields) => console.log(format("info", message, fields)),
  warn: (message: string, fields?: Fields) => console.error(format("warn", message, fields)),
  error: (message: string, fields?: Fields) => console.error(format("error", message, fields)),
  debug: (message: string, fields?: Fields) => {
    if (debugEnabled) console.log(format("debug", message, fields));
  },
  isDebug: () => debugEnabled,
  setDebug: (on: boolean) => {
    debugEnabled = on;
  }
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
