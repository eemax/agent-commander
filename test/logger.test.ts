import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

  it("writes readable text log lines to app.log", () => {
    const root = createTempDir("acmd-logger-");
    const appLogPath = path.join(root, "app.log");
    const logger = createLogger("debug", { appLogPath });

    logger.info("hello");
    logger.warn("careful");

    const raw = fs.readFileSync(appLogPath, "utf8");
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

  it("buffers app log writes when flushIntervalMs is configured", async () => {
    const root = createTempDir("acmd-logger-");
    const appLogPath = path.join(root, "app.log");
    const logger = createLogger("debug", { appLogPath, flushIntervalMs: 5 });

    logger.info("buffered");
    expect(fs.existsSync(appLogPath)).toBe(false);
    await sleep(20);

    const raw = fs.readFileSync(appLogPath, "utf8");
    expect(raw).toContain("[INFO] buffered");
  });

  it("keeps only the newest app log lines when maxLines is configured", () => {
    const root = createTempDir("acmd-logger-cap-");
    const appLogPath = path.join(root, "app.log");
    const logger = createLogger("debug", { appLogPath, maxLines: 2 });

    logger.info("first");
    logger.info("second");
    logger.info("third");

    const lines = fs.readFileSync(appLogPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[INFO] second");
    expect(lines[1]).toContain("[INFO] third");
  });
});
