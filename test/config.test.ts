import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isRetryable, undelivered } from "../src/agent.js";
import { parseConfig, resolveModel } from "../src/config.js";

const valid = {
  telegram: { allowlist: [123456789] },
  models: [
    { id: "deepseek/deepseek-v4.1-flash", alias: "flash" },
    { id: "moonshotai/kimi-k3", alias: "kimi" }
  ]
};

describe("config", () => {
  it("applies defaults and normalizes ids", () => {
    const c = parseConfig(valid);
    expect(c.allowlist).toEqual(["123456789"]);
    expect(c.defaultEffort).toBe("medium");
    expect(c.bash).toEqual({ timeoutMs: 120_000, maxTimeoutMs: 600_000, outputCapChars: 30_000 });
    expect(c.maxTurnCostUsd).toBeNull();
    expect(c.home).toBe(path.join(os.homedir(), ".acmd"));
    expect(c.boxDir).toBe("/etc/acmd");
    expect(parseConfig({ ...valid, box_dir: "~/box" }).boxDir).toBe(path.join(os.homedir(), "box"));
  });

  it("refuses an empty allowlist", () => {
    expect(() => parseConfig({ ...valid, telegram: { allowlist: [] } })).toThrow(/allowlist is empty/);
  });

  it("refuses a max timeout below the default timeout", () => {
    expect(() => parseConfig({ ...valid, bash: { timeout_ms: 60_000, max_timeout_ms: 30_000 } })).toThrow(/max_timeout_ms/);
  });

  it("refuses unknown keys and duplicate aliases", () => {
    expect(() => parseConfig({ ...valid, extra: 1 })).toThrow();
    expect(() => parseConfig({ ...valid, models: [valid.models[0], valid.models[0]] })).toThrow(/duplicate alias/);
  });

  it("resolves models by alias or id", () => {
    const c = parseConfig(valid);
    expect(resolveModel(c, "kimi")?.id).toBe("moonshotai/kimi-k3");
    expect(resolveModel(c, "deepseek/deepseek-v4.1-flash")?.alias).toBe("flash");
    expect(resolveModel(c, "nope")).toBeNull();
  });
});

describe("retry policy", () => {
  it("retries server errors but not client errors", () => {
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 502 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 401 }))).toBe(false);
    expect(isRetryable(new Error('Response failed: {"code":"server_error"}'))).toBe(true);
    expect(isRetryable(new Error("invalid model"))).toBe(false);
  });
});

describe("steer tracking", () => {
  it("matches each delivered text once", () => {
    expect(undelivered(["a", "b"], ["a"])).toEqual(["b"]);
    expect(undelivered(["yes", "yes"], ["yes"])).toEqual(["yes"]);
    expect(undelivered(["x"], [])).toEqual(["x"]);
  });
});
