import type { JsonValue, ToolDef } from "./types.js";
import {
  subagentInputSchema,
  type SubagentInput
} from "./subagent-schemas.js";
import type { SpawnTaskParams, SupervisorMessage, DirectiveType } from "./subagent-types.js";
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
    "Manage subagent tasks. Actions: spawn(task); recv(tasks, wait_ms?, max_events?); send(task_id, message); inspect(task_id); list(filter?); cancel(task_id, reason); await(task_id, until, timeout_ms).",
  schema: subagentInputSchema,
  async run(ctx, input: SubagentInput): Promise<JsonValue> {
    const manager = requireSubagentManager(ctx.subagentManager);
    const ownerId = requireOwnerId(ctx.ownerId);

    switch (input.action) {
      case "spawn": {
        const task = input.task;
        const constraints = task.constraints;
        const execution = task.execution;
        const completionContract = task.completion_contract;

        const params: SpawnTaskParams = {
          title: task.title,
          goal: task.goal,
          instructions: task.instructions,
          context: task.context as Record<string, unknown> | undefined,
          artifacts: task.artifacts,
          constraints: constraints
            ? {
                timeBudgetSec: constraints.time_budget_sec,
                maxTurns: constraints.max_turns,
                maxTotalTokens: constraints.max_total_tokens,
                requirePlanByTurn: constraints.require_plan_by_turn,
                sandbox: constraints.sandbox,
                network: constraints.network,
                approvalPolicy: constraints.approval_policy
                  ? {
                      canEditCode: constraints.approval_policy.can_edit_code,
                      canRunTests: constraints.approval_policy.can_run_tests,
                      canOpenPr: constraints.approval_policy.can_open_pr,
                      requiresSupervisorFor: constraints.approval_policy.requires_supervisor_for
                    }
                  : undefined
              }
            : undefined,
          execution: execution
            ? {
                agentType: execution.agent_type,
                model: execution.model,
                heartbeatIntervalSec: execution.heartbeat_interval_sec,
                idleTimeoutSec: execution.idle_timeout_sec,
                stallTimeoutSec: execution.stall_timeout_sec
              }
            : undefined,
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
        const result = manager.recv(input.tasks, input.wait_ms, input.max_events);
        return JSON.parse(JSON.stringify(result));
      }

      case "send": {
        const message: SupervisorMessage = {
          role: "supervisor",
          content: input.message.content,
          directiveType: input.message.directive_type as DirectiveType | undefined
        };
        return JSON.parse(JSON.stringify(manager.send(input.task_id, message)));
      }

      case "inspect": {
        return JSON.parse(JSON.stringify(manager.inspect(input.task_id)));
      }

      case "list": {
        const tasks = manager.list(input.filter);
        return JSON.parse(JSON.stringify({ tasks }));
      }

      case "cancel": {
        return JSON.parse(JSON.stringify(manager.cancel(input.task_id, input.reason)));
      }

      case "await": {
        const result = await manager.await_(input.task_id, input.until, input.timeout_ms);
        return JSON.parse(JSON.stringify(result));
      }

      default:
        throw new Error(`Unsupported subagents action: ${(input as { action: string }).action}`);
    }
  }
};
