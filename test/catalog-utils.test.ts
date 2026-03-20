import { describe, expect, it } from "vitest";
import { createCatalogResolver, normalizeLookup, type CatalogEntry } from "../src/catalog-utils.js";

type TestEntry = CatalogEntry & { extra?: string };

const resolver = createCatalogResolver<TestEntry>("test item");

const catalog: TestEntry[] = [
  { id: "alpha", aliases: ["a", "first"], extra: "x" },
  { id: "beta", aliases: ["b"] },
  { id: "gamma", aliases: [] }
];

describe("normalizeLookup", () => {
  it("trims and lowercases", () => {
    expect(normalizeLookup("  Hello World  ")).toBe("hello world");
  });
});

describe("createCatalogResolver", () => {
  describe("getById", () => {
    it("finds entry by exact id", () => {
      expect(resolver.getById(catalog, "alpha")).toBe(catalog[0]);
    });

    it("returns null for missing id", () => {
      expect(resolver.getById(catalog, "missing")).toBe(null);
    });
  });

  describe("resolveReference", () => {
    it("resolves by exact id (case-insensitive)", () => {
      expect(resolver.resolveReference(catalog, "ALPHA")).toBe(catalog[0]);
    });

    it("resolves by alias (case-insensitive)", () => {
      expect(resolver.resolveReference(catalog, "First")).toBe(catalog[0]);
      expect(resolver.resolveReference(catalog, "B")).toBe(catalog[1]);
    });

    it("returns null for empty input", () => {
      expect(resolver.resolveReference(catalog, "")).toBe(null);
      expect(resolver.resolveReference(catalog, "   ")).toBe(null);
    });

    it("returns null for unmatched input", () => {
      expect(resolver.resolveReference(catalog, "delta")).toBe(null);
    });
  });

  describe("resolveActive", () => {
    it("returns override when provided and found", () => {
      expect(resolver.resolveActive({ models: catalog, defaultId: "gamma", overrideId: "alpha" })).toBe(catalog[0]);
    });

    it("falls back to default when override is null", () => {
      expect(resolver.resolveActive({ models: catalog, defaultId: "beta", overrideId: null })).toBe(catalog[1]);
    });

    it("falls back to default when override not found", () => {
      expect(resolver.resolveActive({ models: catalog, defaultId: "gamma", overrideId: "missing" })).toBe(catalog[2]);
    });

    it("throws when default is missing from catalog", () => {
      expect(() => resolver.resolveActive({ models: catalog, defaultId: "missing", overrideId: null })).toThrow(
        "Default test item missing from catalog: missing"
      );
    });
  });
});
