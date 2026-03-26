import { describe, it, expect, vi } from "vitest";
import { createAssistantTurnHandler } from "../src/routing/assistant-turn.js";
import { ToolWorkflowAbortError } from "../src/agent/tool-loop.js";
import { ProviderError } from "../src/provider-error.js";
import { createToolErrorPayload } from "../src/harness/errors.js";
import { makeConfig } from "./helpers.js";
import type { RuntimeLogger, StateStore, WorkspaceCatalog } from "../src/runtime/contracts.js";
import type { ToolHarness } from "../src/harness/index.js";
import type { Provider, NormalizedTelegramMessage } from "../src/types.js";
import type { TraceContext } from "../src/observability.js";

function makeLogger(): RuntimeLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined)
  } as unknown as RuntimeLogger;
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    generateReply: vi.fn().mockResolvedValue("assistant reply"),
    ...overrides
  } as unknown as Provider;
}

function makeConversations(): StateStore {
  return {
    ensureActiveConversation: vi.fn().mockResolvedValue("conv-1"),
    getVerboseMode: vi.fn().mockResolvedValue("off"),
    getThinkingEffort: vi.fn().mockResolvedValue("medium"),
    getCacheRetention: vi.fn().mockResolvedValue("in_memory"),
    getTransportMode: vi.fn().mockResolvedValue("http"),
    getAuthMode: vi.fn().mockResolvedValue("api"),
    getActiveModelOverride: vi.fn().mockResolvedValue(null),
    appendUserMessageAndGetPromptContext: vi.fn().mockResolvedValue({
      promptCountBeforeAppend: 1,
      historyAfterAppend: [{ role: "user", content: "hello" }]
    }),
    appendAssistantMessage: vi.fn().mockResolvedValue(undefined),
    appendProviderFailure: vi.fn().mockResolvedValue(undefined),
    recordToolResult: vi.fn().mockResolvedValue(undefined),
    setLatestUsageSnapshot: vi.fn().mockResolvedValue(undefined),
    setLastProviderFailure: vi.fn().mockResolvedValue(undefined),
    incrementCompactionCount: vi.fn().mockResolvedValue(undefined)
  } as unknown as StateStore;
}

function makeWorkspace(): WorkspaceCatalog {
  return {
    getSnapshot: vi.fn().mockReturnValue({
      workspaceRoot: "/tmp/test",
      systemPath: "/tmp/test/SYSTEM.md",
      systemContent: "",
      systemSha256: "",
      agentsPath: "/tmp/test/AGENTS.md",
      agentsContent: "",
      agentsSha256: "",
      soulPath: "/tmp/test/SOUL.md",
      soulContent: "",
      soulSha256: "",
      skillsDir: "/tmp/test/skills",
      skills: [],
      commands: [],
      signature: "test"
    })
  } as unknown as WorkspaceCatalog;
}

function makeHarness(): ToolHarness {
  return {
    exportProviderTools: vi.fn().mockReturnValue([])
  } as unknown as ToolHarness;
}

function makeMessage(overrides: Partial<NormalizedTelegramMessage> = {}): NormalizedTelegramMessage {
  return {
    chatId: "chat-1",
    senderId: "user-1",
    senderName: "Alice",
    messageId: "msg-1",
    text: "hello",
    attachments: [],
    receivedAt: new Date().toISOString(),
    ...overrides
  } as NormalizedTelegramMessage;
}

function makeTrace(): TraceContext {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    operationName: "test"
  } as unknown as TraceContext;
}

function createHandler(overrides: {
  provider?: Provider;
  conversations?: StateStore;
} = {}) {
  return createAssistantTurnHandler({
    logger: makeLogger(),
    provider: overrides.provider ?? makeProvider(),
    config: makeConfig(),
    conversations: overrides.conversations ?? makeConversations(),
    workspace: makeWorkspace(),
    harness: makeHarness()
  });
}

describe("createAssistantTurnHandler", () => {
  it("happy path: returns reply from provider", async () => {
    const handler = createHandler();
    const result = await handler({
      message: makeMessage(),
      userContent: "hello",
      trace: makeTrace()
    });

    expect(result.type).toBe("reply");
    if (result.type !== "reply") throw new Error("unreachable");
    expect(result.text).toBe("assistant reply");
  });

  it("appends user message and assistant response to store", async () => {
    const conversations = makeConversations();
    const handler = createHandler({ conversations });

    await handler({
      message: makeMessage(),
      userContent: "hello",
      trace: makeTrace()
    });

    expect(conversations.appendUserMessageAndGetPromptContext).toHaveBeenCalled();
    expect(conversations.appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "assistant reply" })
    );
  });

  it("returns ignore for WORKFLOW_INTERRUPTED", async () => {
    const provider = makeProvider({
      generateReply: vi.fn().mockRejectedValue(
        new ToolWorkflowAbortError(
          createToolErrorPayload({
            error: "interrupted",
            errorCode: "WORKFLOW_INTERRUPTED",
            retryable: false
          })
        )
      )
    });

    const handler = createHandler({ provider });
    const result = await handler({
      message: makeMessage(),
      userContent: "hello",
      trace: makeTrace()
    });

    expect(result.type).toBe("ignore");
  });

  it("returns fallback for ProviderError", async () => {
    const conversations = makeConversations();
    const provider = makeProvider({
      generateReply: vi.fn().mockRejectedValue(
        new ProviderError({
          message: "rate limited",
          kind: "rate_limit",
          statusCode: 429,
          attempts: 3,
          retryable: true
        })
      )
    });

    const handler = createHandler({ provider, conversations });
    const result = await handler({
      message: makeMessage(),
      userContent: "hello",
      trace: makeTrace()
    });

    expect(result.type).toBe("fallback");
    if (result.type !== "fallback") throw new Error("unreachable");
    expect(result.text).toContain("rate limit");
    expect(conversations.appendProviderFailure).toHaveBeenCalled();
    expect(conversations.setLastProviderFailure).toHaveBeenCalled();
  });

  it("rethrows non-ProviderError exceptions", async () => {
    const provider = makeProvider({
      generateReply: vi.fn().mockRejectedValue(new Error("unexpected"))
    });

    const handler = createHandler({ provider });
    await expect(
      handler({
        message: makeMessage(),
        userContent: "hello",
        trace: makeTrace()
      })
    ).rejects.toThrow("unexpected");
  });

  it("returns ignore for empty reply", async () => {
    const provider = makeProvider({
      generateReply: vi.fn().mockResolvedValue("   ")
    });

    const handler = createHandler({ provider });
    const result = await handler({
      message: makeMessage(),
      userContent: "hello",
      trace: makeTrace()
    });

    expect(result.type).toBe("ignore");
  });

  it("adds interrupted notice when interruptedPreviousTurn is true", async () => {
    const deltas: string[] = [];
    const handler = createHandler();
    await handler({
      message: makeMessage(),
      userContent: "hello",
      trace: makeTrace(),
      interruptedPreviousTurn: true,
      onTextDelta: (d) => { deltas.push(d); }
    });

    expect(deltas.some((d) => d.includes("Interrupted"))).toBe(true);
  });
});
