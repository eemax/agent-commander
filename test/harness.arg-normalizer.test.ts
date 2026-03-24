import { describe, it, expect } from "vitest";
import { normalizeToolArgs, getExpectedShapeForTool, stableStringify } from "../src/harness/arg-normalizer.js";

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – bash                                          */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – bash", () => {
  it("maps canonical keys", () => {
    expect(normalizeToolArgs("bash", { command: "ls", cwd: "/tmp" })).toEqual({
      command: "ls",
      cwd: "/tmp"
    });
  });

  it("resolves aliases", () => {
    expect(normalizeToolArgs("bash", { cmd: "echo hi", working_directory: "/opt", bg: true })).toEqual({
      command: "echo hi",
      cwd: "/opt",
      background: true
    });
  });

  it("coerces string numbers for timeoutMs", () => {
    expect(normalizeToolArgs("bash", { command: "ls", timeout_ms: "5000" })).toEqual({
      command: "ls",
      timeoutMs: 5000
    });
  });

  it("drops undefined keys", () => {
    const result = normalizeToolArgs("bash", { command: "ls" });
    expect(Object.keys(result)).toEqual(["command"]);
  });

  it("returns empty object for non-object input", () => {
    expect(normalizeToolArgs("bash", null)).toEqual({});
    expect(normalizeToolArgs("bash", "string")).toEqual({});
    expect(normalizeToolArgs("bash", 42)).toEqual({});
  });

  it("coerces boolean strings for background", () => {
    expect(normalizeToolArgs("bash", { command: "ls", background: "true" })).toEqual({
      command: "ls",
      background: true
    });
    expect(normalizeToolArgs("bash", { command: "ls", background: "false" })).toEqual({
      command: "ls",
      background: false
    });
  });

  it("trims whitespace-only cwd to undefined", () => {
    const result = normalizeToolArgs("bash", { command: "ls", cwd: "   " });
    expect(result).toEqual({ command: "ls" });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – process                                       */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – process", () => {
  it("normalizes list action", () => {
    expect(normalizeToolArgs("process", { action: "list" })).toEqual({ action: "list" });
  });

  it("normalizes poll action with alias", () => {
    expect(normalizeToolArgs("process", { op: "poll", session: "s1" })).toEqual({
      action: "poll",
      sessionId: "s1"
    });
  });

  it("normalizes log action with tailLines coercion", () => {
    expect(normalizeToolArgs("process", { action: "log", sessionId: "s1", tail: "50" })).toEqual({
      action: "log",
      sessionId: "s1",
      tailLines: 50
    });
  });

  it("normalizes write action", () => {
    expect(normalizeToolArgs("process", { action: "write", session_id: "s1", stdin: "hello" })).toEqual({
      action: "write",
      sessionId: "s1",
      input: "hello"
    });
  });

  it("normalizes kill action with signal", () => {
    expect(normalizeToolArgs("process", { action: "kill", sessionId: "s1", signal: "SIGTERM" })).toEqual({
      action: "kill",
      sessionId: "s1",
      signal: "SIGTERM"
    });
  });

  it("normalizes clear and remove actions", () => {
    expect(normalizeToolArgs("process", { action: "clear", sessionId: "s1" })).toEqual({
      action: "clear",
      sessionId: "s1"
    });
    expect(normalizeToolArgs("process", { action: "remove", sessionId: "s1" })).toEqual({
      action: "remove",
      sessionId: "s1"
    });
  });

  it("passes through unknown action with all fields", () => {
    const result = normalizeToolArgs("process", { action: "unknown_action", sessionId: "s1", tailLines: 10 });
    expect(result).toEqual({
      action: "unknown_action",
      sessionId: "s1",
      tailLines: 10
    });
  });

  it("lowercases action", () => {
    expect(normalizeToolArgs("process", { action: "POLL", sessionId: "s1" })).toEqual({
      action: "poll",
      sessionId: "s1"
    });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – read_file                                     */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – read_file", () => {
  it("resolves path aliases", () => {
    expect(normalizeToolArgs("read_file", { file: "/a.txt" })).toEqual({ path: "/a.txt" });
    expect(normalizeToolArgs("read_file", { filePath: "/b.txt" })).toEqual({ path: "/b.txt" });
    expect(normalizeToolArgs("read_file", { file_path: "/c.txt" })).toEqual({ path: "/c.txt" });
  });

  it("coerces string offset/limit", () => {
    expect(normalizeToolArgs("read_file", { path: "/a.txt", start_line: "10", max_lines: "50" })).toEqual({
      path: "/a.txt",
      offsetLine: 10,
      limitLines: 50
    });
  });

  it("rejects non-positive integers", () => {
    const result = normalizeToolArgs("read_file", { path: "/a.txt", offsetLine: 0, limitLines: -5 });
    expect(result).toEqual({ path: "/a.txt" });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – write_file                                    */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – write_file", () => {
  it("resolves content aliases", () => {
    expect(normalizeToolArgs("write_file", { path: "/a.txt", text: "hello" })).toEqual({
      path: "/a.txt",
      content: "hello"
    });
    expect(normalizeToolArgs("write_file", { file: "/a.txt", body: "world" })).toEqual({
      path: "/a.txt",
      content: "world"
    });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – replace_in_file                               */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – replace_in_file", () => {
  it("resolves aliases", () => {
    expect(
      normalizeToolArgs("replace_in_file", {
        file: "/a.txt",
        find_text: "old",
        replace_text: "new",
        replace_all: "true"
      })
    ).toEqual({
      path: "/a.txt",
      oldText: "old",
      newText: "new",
      replaceAll: true
    });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – apply_patch                                   */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – apply_patch", () => {
  it("resolves diff alias", () => {
    expect(normalizeToolArgs("apply_patch", { diff: "--- a\n+++ b" })).toEqual({
      patch: "--- a\n+++ b"
    });
  });

  it("resolves workingDirectory alias", () => {
    expect(normalizeToolArgs("apply_patch", { patch: "p", workingDirectory: "/tmp" })).toEqual({
      patch: "p",
      cwd: "/tmp"
    });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – web_search / web_fetch                        */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – web_search", () => {
  it("resolves q alias", () => {
    expect(normalizeToolArgs("web_search", { q: "test query" })).toEqual({ query: "test query" });
  });
});

describe("normalizeToolArgs – web_fetch", () => {
  it.each(["uri", "link", "href"])("resolves %s alias", (alias) => {
    expect(normalizeToolArgs("web_fetch", { [alias]: "https://x.com" })).toEqual({ url: "https://x.com" });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – subagents                                     */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – subagents", () => {
  it("normalizes spawn", () => {
    const task = { prompt: "do something" };
    expect(normalizeToolArgs("subagents", { action: "spawn", task })).toEqual({
      action: "spawn",
      task
    });
  });

  it("converts recv array of task IDs to record with default cursor", () => {
    const result = normalizeToolArgs("subagents", {
      action: "recv",
      tasks: ["t1", "t2"],
      cursor: "c1"
    });
    expect(result).toEqual({
      action: "recv",
      tasks: { t1: "c1", t2: "c1" }
    });
  });

  it("fills empty cursors in recv record when default cursor provided", () => {
    const result = normalizeToolArgs("subagents", {
      action: "recv",
      tasks: { t1: "existing", t2: "" },
      last_cursor: "default"
    });
    expect(result).toEqual({
      action: "recv",
      tasks: { t1: "existing", t2: "default" }
    });
  });

  it("normalizes send role to supervisor", () => {
    const result = normalizeToolArgs("subagents", {
      action: "send",
      taskId: "t1",
      message: { role: "user", content: "hi" }
    });
    expect(result).toEqual({
      action: "send",
      task_id: "t1",
      message: { role: "supervisor", content: "hi" }
    });
  });

  it("normalizes send directiveType to directive_type", () => {
    const result = normalizeToolArgs("subagents", {
      action: "send",
      task_id: "t1",
      message: { role: "supervisor", directiveType: "plan", content: "x" }
    });
    expect(result.message).toEqual(
      expect.objectContaining({ directive_type: "plan" })
    );
    expect((result.message as Record<string, unknown>).directiveType).toBeUndefined();
  });

  it("normalizes inspect", () => {
    expect(normalizeToolArgs("subagents", { action: "inspect", task: "t1" })).toEqual({
      action: "inspect",
      task_id: "t1"
    });
  });

  it("normalizes list with filter", () => {
    expect(normalizeToolArgs("subagents", { action: "list", filter: "active" })).toEqual({
      action: "list",
      filter: "active"
    });
  });

  it("normalizes cancel", () => {
    expect(normalizeToolArgs("subagents", { action: "cancel", taskId: "t1", message: "done" })).toEqual({
      action: "cancel",
      task_id: "t1",
      reason: "done"
    });
  });

  it("normalizes await", () => {
    expect(
      normalizeToolArgs("subagents", {
        action: "await",
        task: "t1",
        until: "completed",
        timeoutMs: "5000"
      })
    ).toEqual({
      action: "await",
      task_id: "t1",
      until: "completed",
      timeout_ms: 5000
    });
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeToolArgs – unknown tool                                  */
/* ------------------------------------------------------------------ */
describe("normalizeToolArgs – unknown tool", () => {
  it("returns asRecord passthrough", () => {
    expect(normalizeToolArgs("custom_tool", { foo: "bar" })).toEqual({ foo: "bar" });
  });

  it("returns empty object for non-object", () => {
    expect(normalizeToolArgs("custom_tool", "string")).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  getExpectedShapeForTool                                           */
/* ------------------------------------------------------------------ */
describe("getExpectedShapeForTool", () => {
  it("returns shape for bash", () => {
    const shape = getExpectedShapeForTool("bash", {});
    expect(shape?.required).toContain("command");
    expect(shape?.optional).toContain("cwd");
  });

  it("returns action-dependent shape for process", () => {
    expect(getExpectedShapeForTool("process", { action: "poll" })?.required).toContain("sessionId");
    expect(getExpectedShapeForTool("process", { action: "list" })?.required).toEqual(["action"]);
  });

  it("returns action-dependent shape for subagents", () => {
    expect(getExpectedShapeForTool("subagents", { action: "spawn" })?.required).toContain("task");
    expect(getExpectedShapeForTool("subagents", { action: "recv" })?.required).toContain("tasks");
  });

  it("returns undefined for unknown tool", () => {
    expect(getExpectedShapeForTool("custom_tool", {})).toBeUndefined();
  });

  it("returns default shape for unknown process action", () => {
    const shape = getExpectedShapeForTool("process", { action: "nope" });
    expect(shape?.required).toEqual(["action"]);
    expect(shape?.optional).toContain("sessionId");
  });

  it.each(["read_file", "write_file", "replace_in_file", "apply_patch", "web_search", "web_fetch"])(
    "returns shape for %s",
    (tool) => {
      const shape = getExpectedShapeForTool(tool, {});
      expect(shape).toBeDefined();
      expect(shape!.required.length).toBeGreaterThan(0);
    }
  );
});

/* ------------------------------------------------------------------ */
/*  stableStringify                                                   */
/* ------------------------------------------------------------------ */
describe("stableStringify", () => {
  it("sorts object keys deterministically", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("handles nested objects", () => {
    expect(stableStringify({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it("handles arrays (preserves order)", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles null", () => {
    expect(stableStringify(null)).toBe("null");
  });

  it("handles primitives", () => {
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(true)).toBe("true");
  });

  it("converts non-JSON values to strings", () => {
    expect(stableStringify(undefined)).toBe('"undefined"');
  });
});
