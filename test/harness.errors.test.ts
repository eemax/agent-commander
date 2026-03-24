import { describe, it, expect } from "vitest";
import {
  ToolExecutionError,
  createToolErrorPayload,
  toToolErrorPayload
} from "../src/harness/errors.js";

describe("createToolErrorPayload", () => {
  it("returns correct shape with defaults", () => {
    const payload = createToolErrorPayload({
      error: "something broke",
      errorCode: "TOOL_EXECUTION_ERROR",
      retryable: false
    });
    expect(payload).toEqual({
      ok: false,
      error: "something broke",
      errorCode: "TOOL_EXECUTION_ERROR",
      retryable: false,
      hints: []
    });
  });

  it("includes hints when provided", () => {
    const payload = createToolErrorPayload({
      error: "bad args",
      errorCode: "TOOL_VALIDATION_ERROR",
      retryable: true,
      hints: ["try a different format"]
    });
    expect(payload.hints).toEqual(["try a different format"]);
  });

  it("includes expected shape when provided", () => {
    const expected = { required: ["path"], optional: ["encoding"] };
    const payload = createToolErrorPayload({
      error: "missing path",
      errorCode: "TOOL_VALIDATION_ERROR",
      retryable: true,
      expected
    });
    expect(payload.expected).toEqual(expected);
  });

  it("omits expected when not provided", () => {
    const payload = createToolErrorPayload({
      error: "err",
      errorCode: "TOOL_EXECUTION_ERROR",
      retryable: false
    });
    expect(payload).not.toHaveProperty("expected");
  });
});

describe("ToolExecutionError", () => {
  it("has correct name, message, and payload", () => {
    const payload = createToolErrorPayload({
      error: "timeout",
      errorCode: "TOOL_TIMEOUT",
      retryable: true
    });
    const err = new ToolExecutionError(payload);
    expect(err.name).toBe("ToolExecutionError");
    expect(err.message).toBe("timeout");
    expect(err.payload).toBe(payload);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("toToolErrorPayload", () => {
  it("extracts payload from ToolExecutionError", () => {
    const payload = createToolErrorPayload({
      error: "test",
      errorCode: "TOOL_EXECUTION_ERROR",
      retryable: false
    });
    const err = new ToolExecutionError(payload);
    expect(toToolErrorPayload(err)).toBe(payload);
  });

  it("wraps generic Error", () => {
    const result = toToolErrorPayload(new Error("oops"));
    expect(result).toEqual({
      ok: false,
      error: "oops",
      errorCode: "TOOL_EXECUTION_ERROR",
      retryable: false,
      hints: []
    });
  });

  it("wraps string errors", () => {
    const result = toToolErrorPayload("raw string error");
    expect(result.error).toBe("raw string error");
    expect(result.errorCode).toBe("TOOL_EXECUTION_ERROR");
  });
});
