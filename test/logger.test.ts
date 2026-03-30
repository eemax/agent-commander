import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { createTempDir } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("returns logging methods for all levels", () => {
    const logger = createLogger("info");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("writes readable text log lines when a file sink is configured", () => {
    const root = createTempDir("acmd-logger-");
    const logPath = path.join(root, "runtime.log");
    const logger = createLogger("debug", { filePath: logPath });

    logger.info("hello");
    logger.warn("careful");

    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[INFO\] hello$/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[WARN\] careful$/);
  });

  it("filters by level and routes warn/error to stderr", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("warn");

    logger.debug("skip-debug");
    logger.info("skip-info");
    logger.warn("show-warn");
    logger.error("show-error");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("[WARN] show-warn");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("[ERROR] show-error");
  });

  it("does not create a log file when no file sink is configured", () => {
    const root = createTempDir("acmd-logger-");
    const logPath = path.join(root, "runtime.log");
    const logger = createLogger("debug");

    logger.info("terminal-only");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("suppresses console output when writeToConsole is false", () => {
    const root = createTempDir("acmd-logger-noconsole-");
    const logPath = path.join(root, "runtime.log");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("debug", { filePath: logPath, writeToConsole: false });

    logger.info("file-only");
    logger.warn("file-only-warn");
    logger.error("file-only-error");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[INFO] file-only");
    expect(lines[1]).toContain("[WARN] file-only-warn");
    expect(lines[2]).toContain("[ERROR] file-only-error");
  });

  it("keeps only the newest log lines when maxLines is configured", () => {
    const root = createTempDir("acmd-logger-cap-");
    const logPath = path.join(root, "runtime.log");
    const logger = createLogger("debug", { filePath: logPath, maxLines: 2 });

    logger.info("first");
    logger.info("second");
    logger.info("third");

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[INFO] second");
    expect(lines[1]).toContain("[INFO] third");
  });
});
