import { zodToJsonSchema } from "zod-to-json-schema";
import { ZodError, type ZodTypeAny } from "zod";
import { createChildTraceContext, createTraceRootContext } from "../observability.js";
import { createToolErrorPayload, ToolExecutionError, toToolErrorPayload } from "./errors.js";
import { getExpectedShapeForTool, normalizeToolArgs } from "./arg-normalizer.js";
import type { JsonObject, JsonValue, ProviderFunctionTool, ToolContext, ToolDef } from "./types.js";

function formatValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

function ensureJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function buildValidationHints(error: ZodError, name: string, normalizedArgs: Record<string, unknown>): string[] {
  const hints: string[] = [];
  const expected = getExpectedShapeForTool(name, normalizedArgs);

  for (const issue of error.issues) {
    if (issue.code === "invalid_union_discriminator" && name === "process") {
      hints.push("use process.action as one of: list, poll, log, write, kill, clear, remove");
      continue;
    }

    if (issue.code === "invalid_type" && issue.expected === "number" && issue.received === "string") {
      const path = issue.path.join(".") || "value";
      hints.push(`convert ${path} to an integer`);
      continue;
    }

    if (issue.code === "invalid_type" && issue.expected === "boolean" && issue.received === "string") {
      const path = issue.path.join(".") || "value";
      hints.push(`use true/false for ${path}`);
      continue;
    }

    if (issue.code === "too_small" && issue.type === "string") {
      const path = issue.path.join(".") || "value";
      hints.push(`${path} must be a non-empty string`);
      continue;
    }
  }

  if (expected) {
    const required = expected.required.length > 0 ? expected.required.join(", ") : "none";
    const optional = expected.optional.length > 0 ? expected.optional.join(", ") : "none";
    hints.push(`expected fields: required [${required}] optional [${optional}]`);
  }

  if (hints.length === 0) {
    hints.push(`check the '${name}' tool schema and required fields`);
  }

  return dedupe(hints);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (typeof value === "object") {
    const objectValue: JsonObject = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      objectValue[key] = toJsonValue(item);
    }
    return objectValue;
  }

  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (typeof left !== typeof right) {
    return false;
  }

  if (left === null || right === null) {
    return left === right;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }

    if (left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => isDeepEqual(item, right[index]));
  }

  if (typeof left === "object" && typeof right === "object") {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObject);
    const rightKeys = Object.keys(rightObject);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => key in rightObject && isDeepEqual(leftObject[key], rightObject[key]));
  }

  return false;
}

function mergePropertySchema(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  if (isDeepEqual(existing, incoming)) {
    return existing;
  }

  const values: string[] = [];
  const existingConst = existing.const;
  const incomingConst = incoming.const;
  const existingEnum = readStringArray(existing.enum);
  const incomingEnum = readStringArray(incoming.enum);

  if (typeof existingConst === "string") {
    values.push(existingConst);
  }
  values.push(...existingEnum);
  if (typeof incomingConst === "string") {
    values.push(incomingConst);
  }
  values.push(...incomingEnum);

  if (values.length > 0) {
    const mergedValues = Array.from(new Set(values));
    const mergedSchema: Record<string, unknown> = {
      ...existing,
      ...incoming,
      enum: mergedValues
    };
    delete mergedSchema.const;
    return mergedSchema;
  }

  return {
    ...existing,
    ...incoming
  };
}

function hasTopLevelForbiddenKeywords(schema: Record<string, unknown>): boolean {
  return (
    "anyOf" in schema || "oneOf" in schema || "allOf" in schema || "enum" in schema || "not" in schema
  );
}

function collectCompositeVariants(schema: Record<string, unknown>): Record<string, unknown>[] {
  const variants: Record<string, unknown>[] = [];
  const keys = ["anyOf", "oneOf", "allOf"] as const;

  for (const key of keys) {
    const value = schema[key];
    if (!Array.isArray(value)) {
      continue;
    }

    for (const candidate of value) {
      const objectCandidate = ensureJsonObject(candidate);
      if (
        objectCandidate.type === "object" ||
        "properties" in objectCandidate ||
        "required" in objectCandidate
      ) {
        variants.push(objectCandidate);
      }
    }
  }

  return variants;
}

function intersectAll(requiredGroups: string[][]): string[] {
  if (requiredGroups.length === 0) {
    return [];
  }

  let intersection = new Set(requiredGroups[0]);
  for (const group of requiredGroups.slice(1)) {
    const current = new Set(group);
    intersection = new Set(Array.from(intersection).filter((key) => current.has(key)));
  }

  return Array.from(intersection);
}

function flattenToObjectSchema(schema: Record<string, unknown>): ProviderFunctionTool["parameters"] {
  const variants = collectCompositeVariants(schema);
  const properties: JsonObject = {
    ...(toJsonValue(ensureJsonObject(schema.properties)) as JsonObject)
  };

  for (const variant of variants) {
    const variantProperties = ensureJsonObject(variant.properties);
    for (const [propertyName, propertySchema] of Object.entries(variantProperties)) {
      const incoming = ensureJsonObject(propertySchema);
      if (Object.prototype.hasOwnProperty.call(properties, propertyName)) {
        const existing = ensureJsonObject(properties[propertyName]);
        properties[propertyName] = toJsonValue(mergePropertySchema(existing, incoming));
      } else {
        properties[propertyName] = toJsonValue(incoming);
      }
    }
  }

  const requiredGroups = variants.map((variant) => readStringArray(variant.required));
  const required = Array.from(
    new Set([...readStringArray(schema.required), ...intersectAll(requiredGroups)])
  );

  const additionalProperties = toJsonValue(
    schema.additionalProperties ?? (variants.some((variant) => variant.additionalProperties === true) ? true : false)
  );

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties
  };
}

function toOpenAIFunctionParameters(schema: unknown): ProviderFunctionTool["parameters"] {
  const normalized = { ...ensureJsonObject(schema) };
  delete normalized.$schema;

  if (normalized.type === "object" && !hasTopLevelForbiddenKeywords(normalized)) {
    return normalized as ProviderFunctionTool["parameters"];
  }

  return flattenToObjectSchema(normalized);
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<ZodTypeAny>>();

  public register<TSchema extends ZodTypeAny>(tool: ToolDef<TSchema>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as unknown as ToolDef<ZodTypeAny>);
  }

  public list(): ToolDef<ZodTypeAny>[] {
    return Array.from(this.tools.values());
  }

  public get(name: string): ToolDef<ZodTypeAny> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool;
  }

  public exportProviderTools(): ProviderFunctionTool[] {
    return this.list().map((tool) => {
      const schema = zodToJsonSchema(tool.schema, {
        target: "jsonSchema7",
        $refStrategy: "none"
      });

      return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: toOpenAIFunctionParameters(schema)
      };
    });
  }

  public async execute(name: string, args: unknown, ctx: ToolContext): Promise<JsonValue> {
    const startedAt = new Date();
    const toolTrace = ctx.trace ? createChildTraceContext(ctx.trace, "tool") : createTraceRootContext("tool");
    let tool: ToolDef<ZodTypeAny>;
    try {
      tool = this.get(name);
    } catch {
      const payload = createToolErrorPayload({
        error: `Unknown tool: ${name}`,
        errorCode: "TOOL_VALIDATION_ERROR",
        retryable: true,
        hints: ["use one of the declared function tools in the tools list"]
      });
      ctx.metrics.toolFailureCount += 1;
      ctx.metrics.errorCodeCounts[payload.errorCode] = (ctx.metrics.errorCodeCounts[payload.errorCode] ?? 0) + 1;
      const finishedAt = new Date();
      await ctx.logger.write({
        timestamp: startedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        tool: name,
        args,
        success: false,
        error: payload.error,
        errorCode: payload.errorCode
      });
      await ctx.observability?.record({
        event: "tool.execution.completed",
        trace: toolTrace,
        stage: "failed",
        chatId: ctx.ownerId ?? undefined,
        tool: name,
        args,
        normalizedArgs: args,
        result: null,
        success: false,
        error: payload.error,
        errorCode: payload.errorCode,
        retryable: payload.retryable,
        hints: payload.hints,
        expected: payload.expected,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString()
      });
      throw new ToolExecutionError(payload);
    }

    const normalizedArgs = normalizeToolArgs(name, args);

    try {
      const input = tool.schema.parse(normalizedArgs);
      const result = await tool.run(ctx, input);
      const finishedAt = new Date();
      ctx.metrics.toolSuccessCount += 1;

      await ctx.logger.write({
        timestamp: startedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        tool: name,
        args: normalizedArgs,
        success: true,
        error: null,
        errorCode: null
      });
      await ctx.observability?.record({
        event: "tool.execution.completed",
        trace: toolTrace,
        stage: "completed",
        chatId: ctx.ownerId ?? undefined,
        tool: name,
        args,
        normalizedArgs,
        result,
        success: true,
        error: null,
        errorCode: null,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString()
      });

      return result;
    } catch (error) {
      const payload =
        error instanceof ZodError
          ? createToolErrorPayload({
            error: `Invalid arguments for ${name}: ${formatValidationError(error)}`,
            errorCode: "TOOL_VALIDATION_ERROR",
            retryable: true,
            hints: buildValidationHints(error, name, normalizedArgs),
            expected: getExpectedShapeForTool(name, normalizedArgs)
          })
          : toToolErrorPayload(error);
      const finishedAt = new Date();
      ctx.metrics.toolFailureCount += 1;
      ctx.metrics.errorCodeCounts[payload.errorCode] = (ctx.metrics.errorCodeCounts[payload.errorCode] ?? 0) + 1;

      await ctx.logger.write({
        timestamp: startedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        tool: name,
        args: normalizedArgs,
        success: false,
        error: payload.error,
        errorCode: payload.errorCode
      });
      await ctx.observability?.record({
        event: "tool.execution.completed",
        trace: toolTrace,
        stage: "failed",
        chatId: ctx.ownerId ?? undefined,
        tool: name,
        args,
        normalizedArgs,
        result: null,
        success: false,
        error: payload.error,
        errorCode: payload.errorCode,
        retryable: payload.retryable,
        hints: payload.hints,
        expected: payload.expected,
        errorDetail: error,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString()
      });

      throw new ToolExecutionError(payload);
    }
  }
}
