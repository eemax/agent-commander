import * as path from "node:path";
import { appendTextWithTailRetention } from "../file-retention.js";
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
  private readonly maxLines: number | null;
  private queue: Promise<void> = Promise.resolve();

  public constructor(logPath: string, defaultCwd: string, maxLines: number | null = null) {
    this.logPath = path.isAbsolute(logPath) ? logPath : path.resolve(defaultCwd, logPath);
    this.maxLines = maxLines;
  }

  public get path(): string {
    return this.logPath;
  }

  public async write(entry: ToolLogEntry): Promise<void> {
    const safeEntry = {
      ...entry,
      args: serializeValue(entry.args)
    };

    this.queue = this.queue.then(
      () =>
        appendTextWithTailRetention({
          filePath: this.logPath,
          text: `${JSON.stringify(safeEntry)}\n`,
          maxLines: this.maxLines
        }),
      () =>
        appendTextWithTailRetention({
          filePath: this.logPath,
          text: `${JSON.stringify(safeEntry)}\n`,
          maxLines: this.maxLines
        })
    );

    await this.queue;
  }
}
