import * as fs from "node:fs";
import * as path from "node:path";
import type { ConversationState } from "@openrouter/agent";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { Store } from "../src/state.js";

let home: string;
const init = { model: "flash", effort: "medium" as const, cwd: "/tmp", instructions: "be terse" };

function state(messages: unknown[]): ConversationState {
  return { id: "s1", status: "complete", createdAt: 1, updatedAt: 2, messages } as unknown as ConversationState;
}

beforeEach(() => {
  home = tempDir("state");
});

describe("Store", () => {
  it("creates and finds the current conversation per chat", () => {
    const store = new Store(home);
    expect(store.current("1")).toBeNull();
    const meta = store.create("1", init);
    expect(meta.id).toMatch(/^conv_/);
    expect(store.current("1")).toBe(meta);
    expect(store.instructions(meta)).toBe("be terse");
    expect(new Store(home).current("1")?.id).toBe(meta.id);
  });

  it("round-trips SDK state through append-only JSONL", async () => {
    const store = new Store(home);
    const meta = store.create("1", init);
    const accessor = store.accessor(meta);
    expect(await accessor.load()).toBeNull();

    const a = { role: "user", content: "hi" };
    const b = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] };
    await accessor.save(state([a]));
    await accessor.save(state([a, b]));
    const file = path.join(store.conversationsDir, `${meta.id}.jsonl`);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);

    const reloaded = new Store(home);
    const loaded = await reloaded.accessor(reloaded.current("1")!).load();
    expect(loaded?.messages).toEqual([a, b]);
    expect(loaded?.status).toBe("complete");
    expect(reloaded.userTexts(reloaded.current("1")!)).toEqual(["hi"]);
  });

  it("rewrites the file when history is not an extension of what is on disk", async () => {
    const store = new Store(home);
    const meta = store.create("1", init);
    const accessor = store.accessor(meta);
    await accessor.save(state([{ role: "user", content: "a" }, { role: "user", content: "b" }]));
    await accessor.save(state([{ role: "user", content: "summary" }]));
    expect(await store.accessor(meta).load()).toMatchObject({ messages: [{ role: "user", content: "summary" }] });
  });

  it("repairs a torn last line so the next append starts on a fresh line", async () => {
    const store = new Store(home);
    const meta = store.create("1", init);
    const a = { role: "user", content: "a" };
    await store.accessor(meta).save(state([a]));
    const file = path.join(store.conversationsDir, `${meta.id}.jsonl`);
    fs.appendFileSync(file, '{"role":"us'); // crash mid-write
    const restarted = new Store(home); // a new process reads from disk
    const fresh = restarted.current("1")!;
    expect((await restarted.accessor(fresh).load())?.messages).toEqual([a]);
    const b = { role: "user", content: "b" };
    await restarted.accessor(fresh).save(state([a, b]));
    expect(fs.readFileSync(file, "utf8")).toBe(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
  });

  it("serves later loads from memory, isolated from what the SDK does with them", async () => {
    const store = new Store(home);
    const meta = store.create("1", init);
    const a = { role: "user", content: "a" };
    await store.accessor(meta).save(state([a]));
    const loaded = await store.accessor(meta).load();
    (loaded!.messages as unknown[]).push({ role: "user", content: "not saved" });
    fs.writeFileSync(path.join(store.conversationsDir, `${meta.id}.jsonl`), ""); // disk is not consulted again
    expect((await store.accessor(meta).load())?.messages).toEqual([a]);
    expect(store.userTexts(meta)).toEqual(["a"]);
  });

  it("archives on new conversation and counts both", () => {
    const store = new Store(home);
    const first = store.create("1", init);
    store.archive("1");
    expect(store.current("1")).toBeNull();
    expect(fs.existsSync(path.join(store.archiveDir, `${first.id}.meta.json`))).toBe(true);
    store.create("1", init);
    expect(store.conversationCount()).toBe(2);
  });

  it("filters usage by time", () => {
    const store = new Store(home);
    const row = { conversationId: "c", model: "flash", inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0, cost: 0.5 };
    store.recordUsage({ ...row, ts: "2020-01-01T00:00:00.000Z" });
    store.recordUsage({ ...row, ts: new Date().toISOString() });
    expect(store.usageSince(Date.now() - 86_400_000)).toHaveLength(1);
  });
});
