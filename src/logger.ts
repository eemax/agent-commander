import * as fs from "node:fs";
import * as path from "node:path";
import type { LogLevel, RuntimeLogger } from "./runtime/contracts.js";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function shouldLog(activeLevel: LogLevel, incomingLevel: LogLevel): boolean {
  return LEVEL_RANK[incomingLevel] >= LEVEL_RANK[activeLevel];
}

function formatLine(level: LogLevel, message: string): string {
  return `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
}

export function createLogger(
  level: LogLevel,
  options: { appLogPath?: string; flushIntervalMs?: number } = {}
): RuntimeLogger {
  const appLogPath = options.appLogPath;
  if (appLogPath) {
    fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  }
  const flushIntervalMs =
    typeof options.flushIntervalMs === "number" ? Math.max(1, Math.floor(options.flushIntervalMs)) : 0;
  const bufferedFileLogging = Boolean(appLogPath && flushIntervalMs > 0);
  let bufferedLines = "";
  let flushTimer: NodeJS.Timeout | null = null;
  let flushQueue: Promise<void> = Promise.resolve();

  const flushBufferedLinesAsync = (): void => {
    if (!bufferedFileLogging || !appLogPath || bufferedLines.length === 0) {
      return;
    }

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const payload = bufferedLines;
    bufferedLines = "";
    flushQueue = flushQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await fs.promises.appendFile(appLogPath, payload, "utf8");
        } catch {
          // Do not block runtime behavior on log file errors.
        }
      });
  };

  const flushBufferedLinesSync = (): void => {
    if (!bufferedFileLogging || !appLogPath || bufferedLines.length === 0) {
      return;
    }

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const payload = bufferedLines;
    bufferedLines = "";
    try {
      fs.appendFileSync(appLogPath, payload, "utf8");
    } catch {
      // Do not block runtime behavior on log file errors.
    }
  };

  const scheduleFlush = (): void => {
    if (!bufferedFileLogging || flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBufferedLinesAsync();
    }, flushIntervalMs);
    if (typeof flushTimer.unref === "function") {
      flushTimer.unref();
    }
  };

  if (bufferedFileLogging) {
    const flushOnExit = () => {
      flushBufferedLinesSync();
    };
    process.once("beforeExit", flushOnExit);
    process.once("exit", flushOnExit);
  }

  const writeLine = (targetLevel: LogLevel, message: string): void => {
    if (!shouldLog(level, targetLevel)) {
      return;
    }

    const line = formatLine(targetLevel, message);

    if (targetLevel === "warn") {
      console.warn(line);
    } else if (targetLevel === "error") {
      console.error(line);
    } else {
      console.log(line);
    }

    if (!appLogPath) {
      return;
    }

    if (bufferedFileLogging) {
      bufferedLines += `${line}\n`;
      // Flush quickly when the buffer grows large to cap memory usage.
      if (bufferedLines.length >= 64 * 1024) {
        flushBufferedLinesAsync();
      } else {
        scheduleFlush();
      }
      return;
    }

    try {
      fs.appendFileSync(appLogPath, `${line}\n`, "utf8");
    } catch {
      // Do not block runtime behavior on log file errors.
    }
  };

  return {
    debug: (message) => {
      writeLine("debug", message);
    },
    info: (message) => {
      writeLine("info", message);
    },
    warn: (message) => {
      writeLine("warn", message);
    },
    error: (message) => {
      writeLine("error", message);
    }
  };
}

export type Logger = RuntimeLogger;
