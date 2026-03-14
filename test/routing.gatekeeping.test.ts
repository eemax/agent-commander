import { describe, expect, it, vi } from "vitest";
import { createTraceRootContext } from "../src/observability.js";
import { runMessageGatekeeping } from "../src/routing/gatekeeping.js";
import { createWorkspaceManager } from "../src/workspace.js";
import { makeConfig } from "./helpers.js";

describe("runMessageGatekeeping", () => {
  it("debounces workspace refresh checks for burst traffic", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const first = await runMessageGatekeeping({
      chatId: "chat-1",
      messageId: "msg-1",
      messageSenderId: "user-1",
      logger,
      config,
      workspace,
      trace: createTraceRootContext("routing")
    });
    const second = await runMessageGatekeeping({
      chatId: "chat-1",
      messageId: "msg-2",
      messageSenderId: "user-1",
      logger,
      config,
      workspace,
      trace: createTraceRootContext("routing")
    });
    const third = await runMessageGatekeeping({
      chatId: "chat-1",
      messageId: "msg-3",
      messageSenderId: "user-1",
      logger,
      config,
      workspace,
      trace: createTraceRootContext("routing")
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();

    const health = workspace.getHealth();
    expect(health.refreshCalls).toBe(1);
  });
});
