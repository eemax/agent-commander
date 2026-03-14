import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolLogEntry } from "./types.js";

function serializeValue(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const raw = JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      return current.toString();
    }

    if (typeof current === "function") {
      return "[Function]";
    }

    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);
    }

    return current;
  });

  if (raw === undefined) {
    return null;
  }

  return JSON.parse(raw);
}

export class ToolCallLogger {
  private readonly logPath: string;

  public constructor(logPath: string, defaultCwd: string) {
    this.logPath = path.isAbsolute(logPath) ? logPath : path.resolve(defaultCwd, logPath);
  }

  public get path(): string {
    return this.logPath;
  }

  public async write(entry: ToolLogEntry): Promise<void> {
    const directory = path.dirname(this.logPath);
    await fs.mkdir(directory, { recursive: true });

    const safeEntry = {
      ...entry,
      args: serializeValue(entry.args)
    };
    await fs.appendFile(this.logPath, `${JSON.stringify(safeEntry)}\n`, "utf8");
  }
}
