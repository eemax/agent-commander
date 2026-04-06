import { describe, it, expect } from "vitest";
import { subagentInputSchema } from "../src/harness/subagent-schemas.js";

describe("subagentInputSchema", () => {
  describe("spawn", () => {
    it("parses a minimal spawn input", () => {
      const input = {
        action: "spawn",
        task: {
          title: "Fix flaky test",
          goal: "Identify and fix the root cause",
          instructions: "Reproduce the flake, then fix it."
        }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe("spawn");
      }
    });

    it("parses spawn with all optional task fields", () => {
      const input = {
        action: "spawn",
        task: {
          title: "Refactor auth",
          goal: "Simplify auth middleware",
          instructions: "Consolidate token validation.",
          context: { repo: "my-app" },
          artifacts: [{ type: "file", ref: "sandbox:/src/auth.ts" }],
          completion_contract: {
            require_final_summary: true,
            require_structured_result: false
          },
          labels: { initiative: "auth-rewrite", role: "implementer" }
        }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("rejects spawn with missing goal", () => {
      const input = {
        action: "spawn",
        task: {
          title: "Fix",
          instructions: "Do the thing"
        }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("rejects spawn with empty title", () => {
      const input = {
        action: "spawn",
        task: {
          title: "",
          goal: "Something",
          instructions: "Do it"
        }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("recv", () => {
    it("parses recv with tasks map", () => {
      const input = {
        action: "recv",
        tasks: { "satask_ABC": "saevt_001", "satask_DEF": "" }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("parses recv with optional fields", () => {
      const input = {
        action: "recv",
        tasks: { "satask_ABC": "saevt_001" },
        max_events: 25
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("rejects recv without tasks", () => {
      const result = subagentInputSchema.safeParse({ action: "recv" });
      expect(result.success).toBe(false);
    });
  });

  describe("send", () => {
    it("parses send with message", () => {
      const input = {
        action: "send",
        task_id: "satask_ABC",
        message: {
          role: "supervisor",
          content: "Choose option B."
        }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("parses send with directive_type", () => {
      const input = {
        action: "send",
        task_id: "satask_ABC",
        message: {
          role: "supervisor",
          content: "Stop that approach.",
          directive_type: "correction"
        }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("rejects send with empty content", () => {
      const input = {
        action: "send",
        task_id: "satask_ABC",
        message: {
          role: "supervisor",
          content: ""
        }
      };
      const result = subagentInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("inspect", () => {
    it("parses inspect", () => {
      const result = subagentInputSchema.safeParse({
        action: "inspect",
        task_id: "satask_ABC"
      });
      expect(result.success).toBe(true);
    });

    it("rejects inspect without task_id", () => {
      const result = subagentInputSchema.safeParse({ action: "inspect" });
      expect(result.success).toBe(false);
    });
  });

  describe("list", () => {
    it("parses list without filter", () => {
      const result = subagentInputSchema.safeParse({ action: "list" });
      expect(result.success).toBe(true);
    });

    it("parses list with state filter", () => {
      const result = subagentInputSchema.safeParse({
        action: "list",
        filter: { states: ["running", "needs_steer"] }
      });
      expect(result.success).toBe(true);
    });

    it("parses list with label filter", () => {
      const result = subagentInputSchema.safeParse({
        action: "list",
        filter: { labels: { initiative: "payments" } }
      });
      expect(result.success).toBe(true);
    });
  });

  describe("cancel", () => {
    it("parses cancel", () => {
      const result = subagentInputSchema.safeParse({
        action: "cancel",
        task_id: "satask_ABC",
        reason: "User changed priorities"
      });
      expect(result.success).toBe(true);
    });

    it("rejects cancel without reason", () => {
      const result = subagentInputSchema.safeParse({
        action: "cancel",
        task_id: "satask_ABC"
      });
      expect(result.success).toBe(false);
    });
  });

  describe("await", () => {
    it("parses await with terminal condition", () => {
      const result = subagentInputSchema.safeParse({
        action: "await",
        task_id: "satask_ABC",
        until: ["terminal"],
        timeout_ms: 5000
      });
      expect(result.success).toBe(true);
    });

    it("parses await with multiple conditions", () => {
      const result = subagentInputSchema.safeParse({
        action: "await",
        task_id: "satask_ABC",
        until: ["requires_response", "terminal"],
        timeout_ms: 10000
      });
      expect(result.success).toBe(true);
    });

    it("rejects await with empty until array", () => {
      const result = subagentInputSchema.safeParse({
        action: "await",
        task_id: "satask_ABC",
        until: [],
        timeout_ms: 5000
      });
      expect(result.success).toBe(false);
    });

    it("rejects await without timeout_ms", () => {
      const result = subagentInputSchema.safeParse({
        action: "await",
        task_id: "satask_ABC",
        until: ["terminal"]
      });
      expect(result.success).toBe(false);
    });
  });

  describe("unknown action", () => {
    it("rejects unknown action", () => {
      const result = subagentInputSchema.safeParse({
        action: "resume",
        task_id: "satask_ABC"
      });
      expect(result.success).toBe(false);
    });
  });
});
