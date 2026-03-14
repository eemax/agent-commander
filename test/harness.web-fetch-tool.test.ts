import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolHarness } from "../src/harness/index.js";

function createHarnessRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("web_fetch tool", () => {
  it("uses defuddle markdown extraction by default", async () => {
    const root = createHarnessRoot("acmd-web-fetch-defuddle-");
    const runDefuddle = vi.fn(async () => ({
      markdown: "# Example\n\nHello from defuddle."
    }));
    const createWebFetchClient = vi.fn();

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
          apiKey: null,
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        runDefuddle,
        createWebFetchClient
      }
    );

    const output = await harness.execute("web_fetch", {
      url: "https://example.com/article"
    });

    expect(runDefuddle).toHaveBeenCalledWith("https://example.com/article", 1_800_000);
    expect(createWebFetchClient).not.toHaveBeenCalled();
    expect(output).toEqual({
      url: "https://example.com/article",
      mode: "defuddle",
      content: "# Example\n\nHello from defuddle."
    });
  });

  it("falls back to Perplexity fetch_url when defuddle fails in auto mode", async () => {
    const root = createHarnessRoot("acmd-web-fetch-fallback-");
    const runDefuddle = vi.fn(async () => {
      throw new Error("defuddle command not found");
    });
    const responsesCreate = vi.fn(async () => ({
      id: "resp_fetch_123",
      output_text: "Fetched markdown body",
      output: [
        {
          type: "fetch_url_results",
          contents: [
            {
              title: "Example",
              url: "https://example.com/article",
              snippet: "Fetched snippet"
            }
          ]
        }
      ]
    }));
    const createWebFetchClient = vi.fn(() => ({
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        runDefuddle,
        createWebFetchClient
      }
    );

    const output = await harness.execute("web_fetch", {
      url: "https://example.com/article"
    });

    expect(createWebFetchClient).toHaveBeenCalledWith("pplx-key");
    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonar",
        tools: [{ type: "fetch_url", max_urls: 1 }],
        stream: false
      })
    );
    expect(output).toEqual({
      url: "https://example.com/article",
      mode: "perplexity",
      content: "Fetched markdown body",
      fetch_results: [
        {
          title: "Example",
          url: "https://example.com/article",
          snippet: "Fetched snippet"
        }
      ],
      response_id: "resp_fetch_123",
      fallback_used: true,
      defuddle_error: "defuddle command not found"
    });
  });

  it("supports explicit perplexity mode without invoking defuddle", async () => {
    const root = createHarnessRoot("acmd-web-fetch-perplexity-");
    const runDefuddle = vi.fn(async () => ({
      markdown: "unused"
    }));
    const responsesCreate = vi.fn(async () => ({
      id: "resp_fetch_234",
      output: [
        {
          type: "fetch_url_results",
          contents: [
            {
              title: "Doc",
              url: "https://example.com/doc",
              snippet: "Only snippet content"
            }
          ]
        }
      ]
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
        runDefuddle,
        createWebFetchClient: () => ({
          responses: {
            create: responsesCreate
          }
        })
      }
    );

    const output = await harness.execute("web_fetch", {
      url: "https://example.com/doc",
      mode: "perplexity"
    });

    expect(runDefuddle).not.toHaveBeenCalled();
    expect(output).toEqual({
      url: "https://example.com/doc",
      mode: "perplexity",
      content: "Only snippet content",
      fetch_results: [
        {
          title: "Doc",
          url: "https://example.com/doc",
          snippet: "Only snippet content"
        }
      ],
      response_id: "resp_fetch_234"
    });
  });

  it("normalizes url/mode aliases before validation", async () => {
    const root = createHarnessRoot("acmd-web-fetch-alias-");
    const runDefuddle = vi.fn(async () => ({
      markdown: "alias mode content"
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
        maxOutputChars: 200_000
      },
      {
        runDefuddle
      }
    );

    const output = await harness.execute("web_fetch", {
      link: "https://example.com/alias",
      fetchMode: "DEFUDDLE"
    });

    expect(runDefuddle).toHaveBeenCalledWith("https://example.com/alias", 1_800_000);
    expect(output).toEqual({
      url: "https://example.com/alias",
      mode: "defuddle",
      content: "alias mode content"
    });
  });

  it("fails clearly when defuddle fails and perplexity fallback is unavailable", async () => {
    const root = createHarnessRoot("acmd-web-fetch-no-fallback-");
    const runDefuddle = vi.fn(async () => {
      throw new Error("defuddle command not found");
    });

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
          apiKey: null,
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        runDefuddle
      }
    );

    await expect(
      harness.execute("web_fetch", {
        url: "https://example.com/article"
      })
    ).rejects.toThrow("Perplexity fallback unavailable");
  });

  it("rejects non-http URLs", async () => {
    const root = createHarnessRoot("acmd-web-fetch-validate-");
    const harness = createToolHarness({
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: ".agent-commander/tool-calls.jsonl",
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    await expect(
      harness.execute("web_fetch", {
        url: "ftp://example.com/file.txt"
      })
    ).rejects.toThrow("Invalid arguments for web_fetch");
  });
});
