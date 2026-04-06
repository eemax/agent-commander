import type { JsonValue, ToolDef } from "./types.js";
import {
  subagentInputSchema,
  type SubagentInput
} from "./subagent-schemas.js";
import type { SpawnTaskParams, SupervisorMessage, DirectiveType, TaskState } from "./subagent-types.js";
import type { SubagentManager } from "./subagent-manager.js";

function requireSubagentManager(manager: SubagentManager | undefined): SubagentManager {
  if (!manager) {
    throw new Error("SubagentManager not initialized. Ensure subagents are enabled in config.");
  }
  return manager;
}

function requireOwnerId(ownerId: string | null): string {
  if (!ownerId) {
    throw new Error("Missing owner context for subagent tool execution");
  }
  return ownerId;
}

export const subagentsTool: ToolDef<typeof subagentInputSchema> = {
  name: "subagents",
  description:
    "Manage subagent tasks. Actions: spawn(task); recv(tasks, max_events?); send(task_id, message); inspect(task_id); list(filter?); cancel(task_id, reason); await(task_id, until, timeout_ms, cursor?) — pass cursor from last recv/spawn to avoid missing events.",
  schema: subagentInputSchema,
  async run(ctx, input: SubagentInput): Promise<JsonValue> {
    const manager = requireSubagentManager(ctx.subagentManager);
    const ownerId = requireOwnerId(ctx.ownerId);

    switch (input.action) {
      case "spawn": {
        const task = input.task;
        const completionContract = task.completion_contract;

        const params: SpawnTaskParams = {
          title: task.title,
          goal: task.goal,
          instructions: task.instructions,
          context: task.context as Record<string, unknown> | undefined,
          artifacts: task.artifacts,
          completionContract: completionContract
            ? {
                requireFinalSummary: completionContract.require_final_summary,
                requireStructuredResult: completionContract.require_structured_result
              }
            : undefined,
          labels: task.labels
        };

        return JSON.parse(JSON.stringify(manager.spawn(ownerId, params)));
      }

      case "recv": {
        const result = manager.recv(ownerId, input.tasks, input.max_events);
        return JSON.parse(JSON.stringify(result));
      }

      case "send": {
        const message: SupervisorMessage = {
          role: "supervisor",
          content: input.message.content,
          directiveType: input.message.directive_type as DirectiveType | undefined
        };
        return JSON.parse(JSON.stringify(manager.send(ownerId, input.task_id, message)));
      }

      case "inspect": {
        return JSON.parse(JSON.stringify(manager.inspect(ownerId, input.task_id)));
      }

      case "list": {
        const filter = input.filter
          ? {
              states: input.filter.states as TaskState[] | undefined,
              labels: input.filter.labels
            }
          : undefined;
        const tasks = manager.list(ownerId, filter);
        return JSON.parse(JSON.stringify({ tasks }));
      }

      case "cancel": {
        return JSON.parse(JSON.stringify(manager.cancel(ownerId, input.task_id, input.reason)));
      }

      case "await": {
        const result = await manager.await_(ownerId, input.task_id, input.until, input.timeout_ms, input.cursor);
        return JSON.parse(JSON.stringify(result));
      }

      default:
        throw new Error(`Unsupported subagents action: ${(input as { action: string }).action}`);
    }
  }
};
