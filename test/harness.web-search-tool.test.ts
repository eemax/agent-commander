import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolHarness } from "../src/harness/index.js";

function createHarnessRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("web_search tool", () => {
  it("calls Perplexity client with config-driven token budgets", async () => {
    const root = createHarnessRoot("acmd-web-search-");
    const searchCreate = vi.fn(async () => ({
      id: "search_123",
      results: [
        {
          title: "Result",
          url: "https://example.com",
          snippet: "hello"
        }
      ],
      server_time: "2026-03-14T10:00:00Z"
    }));
    const createWebSearchClient = vi.fn(() => ({
      search: {
        create: searchCreate
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
          maxTokens: 20_000,
          maxTokensPerPage: 2_048
        }
      },
      {
        createWebSearchClient
      }
    );

    const output = await harness.execute("web_search", {
      query: "latest ai research",
      country: "US",
      max_results: 5,
      search_domain_filter: ["nature.com"],
      search_recency_filter: "week"
    });

    expect(createWebSearchClient).toHaveBeenCalledWith("pplx-key");
    expect(searchCreate).toHaveBeenCalledWith({
      query: "latest ai research",
      country: "US",
      max_results: 5,
      search_domain_filter: ["nature.com"],
      search_recency_filter: "week",
      max_tokens: 20_000,
      max_tokens_per_page: 2_048
    });
    expect(output).toEqual({
      id: "search_123",
      query: "latest ai research",
      results: [
        {
          title: "Result",
          url: "https://example.com",
          snippet: "hello"
        }
      ],
      server_time: "2026-03-14T10:00:00Z"
    });
  });

  it("normalizes common alias fields before validation", async () => {
    const root = createHarnessRoot("acmd-web-search-alias-");
    const searchCreate = vi.fn(async () => ({
      id: "search_alias",
      results: []
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        createWebSearchClient: () => ({
          search: {
            create: searchCreate
          }
        })
      }
    );

    await harness.execute("web_search", {
      q: "alias query",
      maxResults: "7",
      searchDomainFilter: ["example.com"],
      recency: "month",
      mode: "academic"
    });

    expect(searchCreate).toHaveBeenCalledWith({
      query: "alias query",
      max_results: 7,
      search_domain_filter: ["example.com"],
      search_recency_filter: "month",
      max_tokens: 10_000,
      max_tokens_per_page: 4_096
    });
  });

  it("passes through multi-query responses", async () => {
    const root = createHarnessRoot("acmd-web-search-multi-");
    const nestedResults = [
      [
        { title: "A1", url: "https://example.com/a1", snippet: "a1" },
        { title: "A2", url: "https://example.com/a2", snippet: "a2" }
      ],
      [
        { title: "B1", url: "https://example.com/b1", snippet: "b1" }
      ]
    ];
    const searchCreate = vi.fn(async () => ({
      id: "search_multi",
      results: nestedResults
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        createWebSearchClient: () => ({
          search: {
            create: searchCreate
          }
        })
      }
    );

    const output = await harness.execute("web_search", {
      query: ["topic a", "topic b"]
    });

    expect(searchCreate).toHaveBeenCalledWith({
      query: ["topic a", "topic b"],
      max_tokens: 10_000,
      max_tokens_per_page: 4_096
    });
    expect(output).toEqual({
      id: "search_multi",
      query: ["topic a", "topic b"],
      results: nestedResults
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        createWebSearchClient: () => ({
          search: {
            create: async () => {
              throw new Error("network down");
            }
          }
        })
      }
    );

    await expect(harness.execute("web_search", { query: "test" })).rejects.toThrow(
      "Perplexity search failed: network down"
    );
  });

  it("rejects excluded fields from model input", async () => {
    const root = createHarnessRoot("acmd-web-search-strict-");
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        createWebSearchClient: () => ({
          search: {
            create: async () => ({
              id: "unused",
              results: []
            })
          }
        })
      }
    );

    const excludedFields: Array<Record<string, unknown>> = [
      { search_language_filter: ["en"] },
      { search_after_date_filter: "01/01/2026" },
      { search_before_date_filter: "01/31/2026" },
      { last_updated_after_filter: "01/01/2026" },
      { last_updated_before_filter: "01/31/2026" },
      { display_server_time: true }
    ];

    for (const payload of excludedFields) {
      await expect(
        harness.execute("web_search", {
          query: "test",
          ...payload
        })
      ).rejects.toThrow("Invalid arguments for web_search");
    }
  });
});
