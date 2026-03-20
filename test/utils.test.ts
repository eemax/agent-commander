import { describe, expect, it } from "vitest";
import { asRecord, isPlainObject, normalizeNonEmptyString, isThinkingEffort, isCacheRetention } from "../src/utils.js";

describe("isPlainObject", () => {
  it("returns true for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
  });
});

describe("asRecord", () => {
  it("returns the object for plain objects", () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
  });

  it("returns empty object for non-objects", () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
    expect(asRecord("str")).toEqual({});
    expect(asRecord([1])).toEqual({});
  });
});

describe("normalizeNonEmptyString", () => {
  it("trims and returns non-empty strings", () => {
    expect(normalizeNonEmptyString("  hello  ")).toBe("hello");
  });

  it("returns null for empty or whitespace-only strings", () => {
    expect(normalizeNonEmptyString("")).toBe(null);
    expect(normalizeNonEmptyString("   ")).toBe(null);
  });

  it("returns null for non-string types", () => {
    expect(normalizeNonEmptyString(42)).toBe(null);
    expect(normalizeNonEmptyString(null)).toBe(null);
    expect(normalizeNonEmptyString(undefined)).toBe(null);
  });
});

describe("isThinkingEffort", () => {
  it("accepts valid thinking effort values", () => {
    expect(isThinkingEffort("none")).toBe(true);
    expect(isThinkingEffort("medium")).toBe(true);
    expect(isThinkingEffort("xhigh")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isThinkingEffort("ultra")).toBe(false);
    expect(isThinkingEffort("")).toBe(false);
    expect(isThinkingEffort(42)).toBe(false);
  });
});

describe("isCacheRetention", () => {
  it("accepts valid cache retention values", () => {
    expect(isCacheRetention("in_memory")).toBe(true);
    expect(isCacheRetention("24h")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isCacheRetention("1h")).toBe(false);
    expect(isCacheRetention("")).toBe(false);
    expect(isCacheRetention(null)).toBe(false);
  });
});
