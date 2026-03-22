type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

export type ToolExpectedShape = {
  action?: string;
  required: string[];
  optional: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function firstDefined(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

function readEnvRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      out[key] = item;
      continue;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      out[key] = String(item);
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      out[key] = item;
    }
  }
  return out;
}

function normalizeBashArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    command: readString(firstDefined(source, ["command", "cmd"])),
    cwd: readNonEmptyString(firstDefined(source, ["cwd", "working_directory", "workingDirectory"])),
    env: readEnvRecord(source.env),
    timeoutMs: readPositiveInt(firstDefined(source, ["timeoutMs", "timeout_ms", "timeout"])),
    yieldMs: readPositiveInt(firstDefined(source, ["yieldMs", "yield_ms"])),
    background: readBoolean(firstDefined(source, ["background", "bg"])),
    shell: readNonEmptyString(source.shell)
  });
}

function normalizeProcessArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  const action = readNonEmptyString(firstDefined(source, ["action", "op", "cmd"]))?.toLowerCase();
  const sessionId = readNonEmptyString(firstDefined(source, ["sessionId", "session_id", "session"]));
  const tailLines = readPositiveInt(firstDefined(source, ["tailLines", "tail_lines", "tail"]));
  const input = readString(firstDefined(source, ["input", "stdin", "data"]));
  const signal = readNonEmptyString(source.signal);

  const normalized = { action, sessionId, tailLines, input, signal };

  switch (action) {
    case "list":
      return dropUndefined({ action: "list" });
    case "poll":
      return dropUndefined({ action: "poll", sessionId });
    case "log":
      return dropUndefined({ action: "log", sessionId, tailLines });
    case "write":
      return dropUndefined({ action: "write", sessionId, input });
    case "kill":
      return dropUndefined({ action: "kill", sessionId, signal });
    case "clear":
      return dropUndefined({ action: "clear", sessionId });
    case "remove":
      return dropUndefined({ action: "remove", sessionId });
    default:
      return dropUndefined(normalized);
  }
}

function normalizeReadFileArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    path: readString(firstDefined(source, ["path", "file", "filePath", "file_path"])),
    offsetLine: readPositiveInt(firstDefined(source, ["offsetLine", "offset_line", "startLine", "start_line"])),
    limitLines: readPositiveInt(firstDefined(source, ["limitLines", "limit_lines", "maxLines", "max_lines"])),
    encoding: readNonEmptyString(source.encoding)
  });
}

function normalizeWriteFileArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    path: readString(firstDefined(source, ["path", "file", "filePath", "file_path"])),
    content: readString(firstDefined(source, ["content", "text", "body"])),
    encoding: readNonEmptyString(source.encoding)
  });
}

function normalizeReplaceInFileArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    path: readString(firstDefined(source, ["path", "file", "filePath", "file_path"])),
    oldText: readString(firstDefined(source, ["oldText", "old_text", "findText", "find_text"])),
    newText: readString(firstDefined(source, ["newText", "new_text", "replaceText", "replace_text"])),
    replaceAll: readBoolean(firstDefined(source, ["replaceAll", "replace_all"]))
  });
}

function normalizeApplyPatchArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    patch: readString(firstDefined(source, ["patch", "diff"])),
    cwd: readNonEmptyString(firstDefined(source, ["cwd", "working_directory", "workingDirectory"]))
  });
}

function normalizeWebSearchArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    query: readNonEmptyString(firstDefined(source, ["query", "q"]))
  });
}

function normalizeWebFetchArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  return dropUndefined({
    url: readNonEmptyString(firstDefined(source, ["url", "uri", "link", "href"]))
  });
}

function normalizeSubagentsArgs(args: unknown): Record<string, unknown> {
  const source = asRecord(args);
  const action = readNonEmptyString(firstDefined(source, ["action", "op", "cmd"]))?.toLowerCase();

  switch (action) {
    case "spawn":
      return dropUndefined({ action: "spawn", task: source.task });
    case "recv": {
      // Normalize tasks: accept array of task IDs as a convenience → convert to record with cursors
      let tasks = source.tasks;
      const defaultCursor = readString(firstDefined(source, ["cursor", "last_cursor"])) ?? "";
      if (Array.isArray(tasks)) {
        const record: Record<string, string> = {};
        for (const item of tasks) {
          if (typeof item === "string" && item.length > 0) {
            record[item] = defaultCursor;
          }
        }
        tasks = record;
      } else if (typeof tasks === "object" && tasks !== null && defaultCursor) {
        // If a top-level cursor was provided, fill in any empty cursors in the record
        const record = tasks as Record<string, string>;
        for (const key of Object.keys(record)) {
          if (!record[key]) {
            record[key] = defaultCursor;
          }
        }
        tasks = record;
      }
      return dropUndefined({
        action: "recv",
        tasks,
        max_events: readPositiveInt(firstDefined(source, ["max_events", "maxEvents", "limit"]))
      });
    }
    case "send": {
      // Normalize message: ensure role is "supervisor" (common mistake: omitting or using "user")
      const message = asRecord(source.message ?? {});
      if (!message.role || message.role === "user") {
        message.role = "supervisor";
      }
      // Normalize directive_type casing
      if (message.directiveType && !message.directive_type) {
        message.directive_type = message.directiveType;
        delete message.directiveType;
      }
      return dropUndefined({
        action: "send",
        task_id: readNonEmptyString(firstDefined(source, ["task_id", "taskId", "task"])),
        message
      });
    }
    case "inspect":
      return dropUndefined({
        action: "inspect",
        task_id: readNonEmptyString(firstDefined(source, ["task_id", "taskId", "task"]))
      });
    case "list":
      return dropUndefined({ action: "list", filter: source.filter });
    case "cancel":
      return dropUndefined({
        action: "cancel",
        task_id: readNonEmptyString(firstDefined(source, ["task_id", "taskId", "task"])),
        reason: readNonEmptyString(firstDefined(source, ["reason", "message"]))
      });
    case "await":
      return dropUndefined({
        action: "await",
        task_id: readNonEmptyString(firstDefined(source, ["task_id", "taskId", "task"])),
        until: source.until,
        timeout_ms: readPositiveInt(firstDefined(source, ["timeout_ms", "timeoutMs", "timeout"])),
        cursor: readString(firstDefined(source, ["cursor", "last_cursor"]))
      });
    default:
      return dropUndefined({ action, ...source });
  }
}

function getSubagentsExpectedShape(args: Record<string, unknown>): ToolExpectedShape {
  const action = readNonEmptyString(args.action)?.toLowerCase();
  switch (action) {
    case "spawn":
      return { action: "spawn", required: ["action", "task"], optional: [] };
    case "recv":
      return { action: "recv", required: ["action", "tasks"], optional: ["wait_ms", "max_events"] };
    case "send":
      return { action: "send", required: ["action", "task_id", "message"], optional: [] };
    case "inspect":
      return { action: "inspect", required: ["action", "task_id"], optional: [] };
    case "list":
      return { action: "list", required: ["action"], optional: ["filter"] };
    case "cancel":
      return { action: "cancel", required: ["action", "task_id", "reason"], optional: [] };
    case "await":
      return { action: "await", required: ["action", "task_id", "until", "timeout_ms"], optional: [] };
    default:
      return { required: ["action"], optional: ["task", "tasks", "task_id", "message", "filter", "reason", "until", "timeout_ms", "wait_ms", "max_events"] };
  }
}

function getProcessExpectedShape(args: Record<string, unknown>): ToolExpectedShape {
  const action = readNonEmptyString(args.action)?.toLowerCase();
  switch (action) {
    case "list":
      return { action: "list", required: ["action"], optional: [] };
    case "poll":
      return { action: "poll", required: ["action", "sessionId"], optional: [] };
    case "log":
      return { action: "log", required: ["action", "sessionId"], optional: ["tailLines"] };
    case "write":
      return { action: "write", required: ["action", "sessionId", "input"], optional: [] };
    case "kill":
      return { action: "kill", required: ["action", "sessionId"], optional: ["signal"] };
    case "clear":
      return { action: "clear", required: ["action", "sessionId"], optional: [] };
    case "remove":
      return { action: "remove", required: ["action", "sessionId"], optional: [] };
    default:
      return { required: ["action"], optional: ["sessionId", "tailLines", "input", "signal"] };
  }
}

export function getExpectedShapeForTool(tool: string, args: Record<string, unknown>): ToolExpectedShape | undefined {
  switch (tool) {
    case "bash":
      return { required: ["command"], optional: ["cwd", "env", "timeoutMs", "yieldMs", "background", "shell"] };
    case "process":
      return getProcessExpectedShape(args);
    case "read_file":
      return { required: ["path"], optional: ["offsetLine", "limitLines", "encoding"] };
    case "write_file":
      return { required: ["path", "content"], optional: ["encoding"] };
    case "replace_in_file":
      return { required: ["path", "oldText", "newText"], optional: ["replaceAll"] };
    case "apply_patch":
      return { required: ["patch"], optional: ["cwd"] };
    case "web_search":
      return {
        required: ["query"],
        optional: []
      };
    case "web_fetch":
      return {
        required: ["url"],
        optional: []
      };
    case "subagents":
      return getSubagentsExpectedShape(args);
    default:
      return undefined;
  }
}

export function normalizeToolArgs(tool: string, args: unknown): Record<string, unknown> {
  switch (tool) {
    case "bash":
      return normalizeBashArgs(args);
    case "process":
      return normalizeProcessArgs(args);
    case "read_file":
      return normalizeReadFileArgs(args);
    case "write_file":
      return normalizeWriteFileArgs(args);
    case "replace_in_file":
      return normalizeReplaceInFileArgs(args);
    case "apply_patch":
      return normalizeApplyPatchArgs(args);
    case "web_search":
      return normalizeWebSearchArgs(args);
    case "web_fetch":
      return normalizeWebFetchArgs(args);
    case "subagents":
      return normalizeSubagentsArgs(args);
    default:
      return asRecord(args);
  }
}

function stableValue(value: unknown): JsonLike {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (typeof value === "object") {
    const out: { [key: string]: JsonLike } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return String(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
