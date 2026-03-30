import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolHarness } from "../src/harness/index.js";

function createHarnessRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeResponseCreateResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_123",
    output_text: "Here is the answer.",
    output: [
      {
        type: "search_results",
        results: [
          { title: "Result 1", url: "https://example.com/1" },
          { title: "Result 2", url: "https://example.com/2" }
        ]
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Here is the answer.",
            annotations: [
              { url: "https://example.com/1", title: "Result 1" },
              { url: "https://example.com/2", title: "Result 2" }
            ]
          }
        ]
      }
    ],
    ...overrides
  };
}

describe("web_search tool", () => {
  it("calls Perplexity responses.create with preset from resolved model", async () => {
    const root = createHarnessRoot("acmd-web-search-");
    const responsesCreate = vi.fn(async () => makeResponseCreateResponse());
    const createWebSearchClient = vi.fn(() => ({
      responses: {
        create: responsesCreate
      }
    }));

    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        webSearch: {
          apiKey: "pplx-key",
          defaultPreset: "sonar",
          presets: [{ id: "sonar", aliases: [] }]
        }
      },
      {
        createWebSearchClient,
        resolveWebSearchModel: async () => "sonar"
      }
    );

    const output = (await harness.execute("web_search", {
      query: "latest ai research"
    })) as Record<string, unknown>;

    expect(createWebSearchClient).toHaveBeenCalledWith("pplx-key");
    expect(responsesCreate).toHaveBeenCalledWith({
      preset: "sonar",
      input: "latest ai research"
    });
    expect(output.model).toBe("sonar");
    expect(output.query).toBe("latest ai research");
    expect(output.response_text).toBe("Here is the answer.");
    expect(output.citations).toHaveLength(2);
    expect(output.search_results).toHaveLength(2);
  });

  it("normalizes q alias to query", async () => {
    const root = createHarnessRoot("acmd-web-search-alias-");
    const responsesCreate = vi.fn(async () => makeResponseCreateResponse());

    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        webSearch: {
          apiKey: "pplx-key",
          defaultPreset: "sonar",
          presets: [{ id: "sonar", aliases: [] }]
        }
      },
      {
        createWebSearchClient: () => ({
          responses: {
            create: responsesCreate
          }
        }),
        resolveWebSearchModel: async () => "sonar"
      }
    );

    await harness.execute("web_search", {
      q: "alias query"
    });

    expect(responsesCreate).toHaveBeenCalledWith({
      preset: "sonar",
      input: "alias query"
    });
  });

  it("uses sonar-pro when resolveWebSearchModel returns it", async () => {
    const root = createHarnessRoot("acmd-web-search-model-");
    const responsesCreate = vi.fn(async () => makeResponseCreateResponse());

    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        webSearch: {
          apiKey: "pplx-key",
          defaultPreset: "sonar",
          presets: [
            { id: "sonar", aliases: [] },
            { id: "sonar-pro", aliases: [] }
          ]
        }
      },
      {
        createWebSearchClient: () => ({
          responses: {
            create: responsesCreate
          }
        }),
        resolveWebSearchModel: async () => "sonar-pro"
      }
    );

    const output = (await harness.execute("web_search", {
      query: "test"
    })) as Record<string, unknown>;

    expect(responsesCreate).toHaveBeenCalledWith({
      preset: "sonar-pro",
      input: "test"
    });
    expect(output.model).toBe("sonar-pro");
  });

  it("resolves the preset from the supervisor owner during subagent runs", async () => {
    const root = createHarnessRoot("acmd-web-search-subagent-owner-");
    const responsesCreate = vi.fn(async () => makeResponseCreateResponse());
    const resolveWebSearchModel = vi.fn(async () => "sonar");

    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        webSearch: {
          apiKey: "pplx-key",
          defaultPreset: "sonar",
          presets: [{ id: "sonar", aliases: [] }]
        }
      },
      {
        createWebSearchClient: () => ({
          responses: {
            create: responsesCreate
          }
        }),
        resolveWebSearchModel
      }
    );

    await harness.registry.execute(
      "web_search",
      { query: "task scoped search" },
      {
        ...harness.context,
        ownerId: "satask_123",
        subagentSession: {
          taskId: "satask_123",
          ownerId: "owner-1"
        }
      }
    );

    expect(resolveWebSearchModel).toHaveBeenCalledWith("owner-1");
    expect(responsesCreate).toHaveBeenCalledWith({
      preset: "sonar",
      input: "task scoped search"
    });
  });

  it("surfaces client failures as tool execution errors", async () => {
    const root = createHarnessRoot("acmd-web-search-error-");
    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        webSearch: {
          apiKey: "pplx-key",
          defaultPreset: "sonar",
          presets: [{ id: "sonar", aliases: [] }]
        }
      },
      {
        createWebSearchClient: () => ({
          responses: {
            create: async () => {
              throw new Error("network down");
            }
          }
        }),
        resolveWebSearchModel: async () => "sonar"
      }
    );

    await expect(harness.execute("web_search", { query: "test" })).rejects.toThrow(
      "Perplexity search failed: network down"
    );
  });

  it("silently drops old fields that are no longer supported", async () => {
    const root = createHarnessRoot("acmd-web-search-strict-");
    const responsesCreate = vi.fn(async () => makeResponseCreateResponse());
    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        webSearch: {
          apiKey: "pplx-key",
          defaultPreset: "sonar",
          presets: [{ id: "sonar", aliases: [] }]
        }
      },
      {
        createWebSearchClient: () => ({
          responses: {
            create: responsesCreate
          }
        }),
        resolveWebSearchModel: async () => "sonar"
      }
    );

    await harness.execute("web_search", {
      query: "test",
      country: "US",
      max_results: 5,
      search_domain_filter: ["example.com"],
      search_recency_filter: "week"
    });

    expect(responsesCreate).toHaveBeenCalledWith({
      preset: "sonar",
      input: "test"
    });
  });
});
