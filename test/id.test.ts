import { describe, expect, it, vi } from "vitest";
import { createConversationId, createProcessSessionId } from "../src/id.js";

function assertLexicallySorted(ids: string[]): void {
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  expect(ids).toEqual(sorted);
}

describe("id generation", () => {
  it("generates prefixed monotonic conversation IDs", () => {
    const ids = Array.from({ length: 200 }, () => createConversationId());

    for (const id of ids) {
      expect(id.startsWith("conv_")).toBe(true);
    }

    expect(new Set(ids).size).toBe(ids.length);
    assertLexicallySorted(ids);
  });

  it("generates prefixed monotonic process session IDs", () => {
    const ids = Array.from({ length: 200 }, () => createProcessSessionId());

    for (const id of ids) {
      expect(id.startsWith("proc_")).toBe(true);
    }

    expect(new Set(ids).size).toBe(ids.length);
    assertLexicallySorted(ids);
  });

  it("stays unique and sorted under same-millisecond generation", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const ids = Array.from({ length: 250 }, () => createConversationId());
      expect(new Set(ids).size).toBe(ids.length);
      assertLexicallySorted(ids);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
