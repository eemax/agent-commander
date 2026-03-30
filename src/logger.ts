import * as fs from "node:fs";
import * as path from "node:path";
import { appendTextWithTailRetentionSync } from "./file-retention.js";
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

function formatLine(level: LogLevel, message: string, tag?: string): string {
  const tagPrefix = tag ? ` [${tag}]` : "";
  return `${new Date().toISOString()} [${level.toUpperCase()}]${tagPrefix} ${message}`;
}

export function createLogger(
  level: LogLevel,
  options: { filePath?: string; tag?: string; maxLines?: number | null; writeToConsole?: boolean } = {}
): RuntimeLogger {
  const tag = options.tag;
  const filePath = options.filePath;
  const maxLines = options.maxLines ?? null;
  const writeToConsole = options.writeToConsole ?? true;
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const writeLine = (targetLevel: LogLevel, message: string): void => {
    if (!shouldLog(level, targetLevel)) {
      return;
    }

    const line = formatLine(targetLevel, message, tag);

    if (writeToConsole) {
      if (targetLevel === "warn") {
        console.warn(line);
      } else if (targetLevel === "error") {
        console.error(line);
      } else {
        console.log(line);
      }
    }

    if (!filePath) {
      return;
    }

    try {
      appendTextWithTailRetentionSync({
        filePath,
        text: `${line}\n`,
        maxLines
      });
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
