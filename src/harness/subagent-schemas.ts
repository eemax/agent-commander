import { z } from "zod";

// --- Shared sub-schemas ------------------------------------------------------

const attachmentSchema = z.object({
  type: z.string().min(1),
  ref: z.string().min(1),
  label: z.string().optional()
});

const approvalPolicySchema = z.object({
  can_edit_code: z.boolean().default(true),
  can_run_tests: z.boolean().default(true),
  can_open_pr: z.boolean().default(false),
  requires_supervisor_for: z.array(z.string()).default([])
});

const constraintsSchema = z.object({
  time_budget_sec: z.number().int().positive().optional(),
  max_turns: z.number().int().positive().optional(),
  max_total_tokens: z.number().int().positive().optional(),
  sandbox: z.string().default("repo-write"),
  network: z.enum(["off", "restricted", "full"]).default("off"),
  require_plan_by_turn: z.number().int().min(0).optional(),
  no_child_spawn: z.literal(true).default(true),
  approval_policy: approvalPolicySchema.optional()
});

const executionSchema = z.object({
  agent_type: z.string().default("coding"),
  model: z.string().optional(),
  heartbeat_interval_sec: z.number().int().positive().optional(),
  idle_timeout_sec: z.number().int().positive().optional(),
  stall_timeout_sec: z.number().int().positive().optional()
});

const completionContractSchema = z.object({
  require_final_summary: z.boolean().default(true),
  require_structured_result: z.boolean().default(true)
});

const taskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  instructions: z.string().min(1),
  context: z.record(z.unknown()).optional(),
  artifacts: z.array(attachmentSchema).optional(),
  constraints: constraintsSchema.optional(),
  execution: executionSchema.optional(),
  completion_contract: completionContractSchema.optional(),
  labels: z.record(z.string()).optional()
});

// --- Action schemas ----------------------------------------------------------

const spawnSchema = z.object({
  action: z.literal("spawn"),
  task: taskSchema
});

const recvSchema = z.object({
  action: z.literal("recv"),
  tasks: z.record(z.string().min(1), z.string()),
  max_events: z.number().int().positive().optional()
});

const sendMessageSchema = z.object({
  role: z.literal("supervisor"),
  content: z.string().min(1),
  directive_type: z.enum(["guidance", "correction", "override", "approval", "answer"]).optional()
});

const sendSchema = z.object({
  action: z.literal("send"),
  task_id: z.string().min(1),
  message: sendMessageSchema
});

const inspectSchema = z.object({
  action: z.literal("inspect"),
  task_id: z.string().min(1)
});

const listFilterSchema = z.object({
  states: z.array(z.string()).optional(),
  labels: z.record(z.string()).optional()
});

const listSchema = z.object({
  action: z.literal("list"),
  filter: listFilterSchema.optional()
});

const cancelSchema = z.object({
  action: z.literal("cancel"),
  task_id: z.string().min(1),
  reason: z.string().min(1)
});

const awaitSchema = z.object({
  action: z.literal("await"),
  task_id: z.string().min(1),
  until: z.array(z.enum(["requires_response", "terminal", "any_event", "progress"])).min(1),
  timeout_ms: z.number().int().positive(),
  cursor: z.string().optional()
});

// --- Combined discriminated union --------------------------------------------

export const subagentInputSchema = z.discriminatedUnion("action", [
  spawnSchema,
  recvSchema,
  sendSchema,
  inspectSchema,
  listSchema,
  cancelSchema,
  awaitSchema
]);

export type SubagentInput = z.infer<typeof subagentInputSchema>;
export type SpawnInput = z.infer<typeof spawnSchema>;
export type RecvInput = z.infer<typeof recvSchema>;
export type SendInput = z.infer<typeof sendSchema>;
export type InspectInput = z.infer<typeof inspectSchema>;
export type ListInput = z.infer<typeof listSchema>;
export type CancelInput = z.infer<typeof cancelSchema>;
export type AwaitInput = z.infer<typeof awaitSchema>;
