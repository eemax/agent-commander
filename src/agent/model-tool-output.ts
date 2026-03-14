import type { ToolErrorCode, ToolErrorPayload } from "../types.js";

type ModelToolSuccessEnvelope = {
  ok: true;
  summary: string;
  data: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

type ModelToolFailureEnvelope = {
  ok: false;
  summary: string;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
  meta?: Record<string, unknown>;
};

export type ModelToolEnvelope = ModelToolSuccessEnvelope | ModelToolFailureEnvelope;

export type NormalizedToolEnvelopeResult = {
  envelope: ModelToolEnvelope;
  report: {
    success: boolean;
    error: string | null;
    errorCode: ToolErrorCode | null;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  const stringValue = readString(value);
  return stringValue && stringValue.length > 0 ? stringValue : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return out.length > 0 ? out : null;
}

function toToolLabel(tool: string): string {
  const normalized = tool.trim().replaceAll("_", " ");
  if (normalized.length === 0) {
    return "Tool";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function appendNonEmptyString(target: Record<string, unknown>, key: string, value: unknown): void {
  const stringValue = readNonEmptyString(value);
  if (stringValue !== null) {
    target[key] = stringValue;
  }
}

function appendNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  const numberValue = readNumber(value);
  if (numberValue !== null) {
    target[key] = numberValue;
  }
}

function addTruncationMeta(record: Record<string, unknown>, meta: Record<string, unknown>): void {
  const stdoutTruncated = readNumber(record.truncatedStdoutChars) ?? 0;
  const stderrTruncated = readNumber(record.truncatedStderrChars) ?? 0;
  const combinedTruncated = readNumber(record.truncatedCombinedChars) ?? 0;

  if (stdoutTruncated <= 0 && stderrTruncated <= 0 && combinedTruncated <= 0) {
    return;
  }

  meta.truncated = true;
  if (stdoutTruncated > 0) {
    meta.stdout_chars_omitted = stdoutTruncated;
  }
  if (stderrTruncated > 0) {
    meta.stderr_chars_omitted = stderrTruncated;
  }
  if (combinedTruncated > 0) {
    meta.combined_chars_omitted = combinedTruncated;
  }
}

function normalizeBashResult(args: unknown, result: unknown): NormalizedToolEnvelopeResult {
  const record = asRecord(result);
  const status = readNonEmptyString(record.status);

  if (status === "running") {
    const data: Record<string, unknown> = {
      status: "running"
    };
    appendNonEmptyString(data, "session_id", record.sessionId);
    appendNumber(data, "pid", record.pid);
    appendNonEmptyString(data, "tail", record.tail);

    const meta: Record<string, unknown> = {};
    addTruncationMeta(record, meta);

    return {
      envelope: {
        ok: true,
        summary: "Bash command is still running.",
        data,
        ...(Object.keys(meta).length > 0 ? { meta } : {})
      },
      report: {
        success: true,
        error: null,
        errorCode: null
      }
    };
  }

  if (status === "completed") {
    const stdout = readNonEmptyString(record.stdout);
    const stderr = readNonEmptyString(record.stderr);
    const exitCode = readNumber(record.exitCode);
    const signal = readNonEmptyString(record.signal);

    const meta: Record<string, unknown> = {};
    if (exitCode !== null) {
      meta.exit_code = exitCode;
    }
    appendNumber(meta, "duration_ms", record.durationMs);
    appendNonEmptyString(meta, "signal", signal);
    addTruncationMeta(record, meta);

    if (exitCode === 0) {
      const data: Record<string, unknown> = {};
      if (stdout !== null) {
        data.stdout = stdout;
      }
      if (stderr !== null) {
        data.stderr = stderr;
      }

      return {
        envelope: {
          ok: true,
          summary: "Bash command completed successfully.",
          data,
          ...(Object.keys(meta).length > 0 ? { meta } : {})
        },
        report: {
          success: true,
          error: null,
          errorCode: null
        }
      };
    }

    const details: Record<string, unknown> = {};
    if (stdout !== null) {
      details.stdout = stdout;
    }
    if (stderr !== null) {
      details.stderr = stderr;
    }

    const hasSignal = signal !== null && signal.length > 0;
    const failureMessage = hasSignal
      ? `Command terminated by signal ${signal}`
      : `Command exited with status ${exitCode === null ? "unknown" : exitCode}`;

    return {
      envelope: {
        ok: false,
        summary: hasSignal
          ? "Bash command terminated before completion."
          : `Bash command failed with exit code ${exitCode === null ? "unknown" : exitCode}.`,
        error: {
          code: hasSignal ? "PROCESS_TERMINATED" : "NON_ZERO_EXIT",
          message: failureMessage,
          ...(Object.keys(details).length > 0 ? { details } : {})
        },
        ...(Object.keys(meta).length > 0 ? { meta } : {})
      },
      report: {
        success: false,
        error: failureMessage,
        errorCode: null
      }
    };
  }

  return {
    envelope: {
      ok: true,
      summary: "Bash command returned output.",
      data: {
        result: record
      }
    },
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

function normalizeProcessListResult(result: unknown): ModelToolEnvelope {
  const record = asRecord(result);
  const sessionsRaw = Array.isArray(record.sessions) ? record.sessions : [];

  const sessions = sessionsRaw.map((entry) => {
    const sessionRecord = asRecord(entry);
    const session: Record<string, unknown> = {};
    appendNonEmptyString(session, "session_id", sessionRecord.sessionId);
    appendNonEmptyString(session, "status", sessionRecord.status);
    appendNonEmptyString(session, "command", sessionRecord.command);
    appendNumber(session, "pid", sessionRecord.pid);

    const exitCode = readNumber(sessionRecord.exitCode);
    if (exitCode !== null) {
      session.exit_code = exitCode;
    }

    appendNonEmptyString(session, "signal", sessionRecord.signal);
    if (readBoolean(sessionRecord.timedOut) === true) {
      session.timed_out = true;
    }

    return session;
  });

  return {
    ok: true,
    summary: sessions.length === 0 ? "No process sessions found." : `Listed ${sessions.length} process session(s).`,
    data: {
      sessions
    }
  };
}

function normalizeProcessPollResult(result: unknown): ModelToolEnvelope {
  const record = asRecord(result);
  const status = readNonEmptyString(record.status) ?? "unknown";
  const data: Record<string, unknown> = {
    status
  };
  appendNonEmptyString(data, "session_id", record.sessionId);
  appendNonEmptyString(data, "stdout", record.stdout);
  appendNonEmptyString(data, "stderr", record.stderr);

  const meta: Record<string, unknown> = {};
  appendNumber(meta, "exit_code", record.exitCode);
  appendNonEmptyString(meta, "signal", record.signal);
  addTruncationMeta(record, meta);

  return {
    ok: true,
    summary: status === "completed" ? "Process poll returned completed status." : "Process poll returned running status.",
    data,
    ...(Object.keys(meta).length > 0 ? { meta } : {})
  };
}

function normalizeProcessLogResult(result: unknown): ModelToolEnvelope {
  const record = asRecord(result);
  const status = readNonEmptyString(record.status) ?? "unknown";
  const data: Record<string, unknown> = {
    status
  };
  appendNonEmptyString(data, "session_id", record.sessionId);
  appendNonEmptyString(data, "output", record.combined);

  const meta: Record<string, unknown> = {};
  appendNumber(meta, "exit_code", record.exitCode);
  appendNonEmptyString(meta, "signal", record.signal);
  addTruncationMeta(record, meta);

  return {
    ok: true,
    summary: "Fetched process log output.",
    data,
    ...(Object.keys(meta).length > 0 ? { meta } : {})
  };
}

function normalizeProcessWriteResult(result: unknown): ModelToolEnvelope {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};
  appendNonEmptyString(data, "session_id", record.sessionId);

  return {
    ok: true,
    summary: "Wrote input to process session.",
    data
  };
}

function normalizeProcessKillResult(result: unknown): ModelToolEnvelope {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};
  appendNonEmptyString(data, "session_id", record.sessionId);
  appendNonEmptyString(data, "status", record.status);
  appendNonEmptyString(data, "signal", record.signal);

  return {
    ok: true,
    summary: "Sent signal to process session.",
    data
  };
}

function normalizeProcessClearResult(result: unknown): ModelToolEnvelope {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};
  appendNonEmptyString(data, "session_id", record.sessionId);

  return {
    ok: true,
    summary: "Cleared pending process output.",
    data
  };
}

function normalizeProcessRemoveResult(result: unknown): ModelToolEnvelope {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};
  appendNonEmptyString(data, "session_id", record.sessionId);

  return {
    ok: true,
    summary: "Removed process session.",
    data
  };
}

function normalizeProcessResult(args: unknown, result: unknown): NormalizedToolEnvelopeResult {
  const action = readNonEmptyString(asRecord(args).action);

  const envelope =
    action === "list"
      ? normalizeProcessListResult(result)
      : action === "poll"
        ? normalizeProcessPollResult(result)
        : action === "log"
          ? normalizeProcessLogResult(result)
          : action === "write"
            ? normalizeProcessWriteResult(result)
            : action === "kill"
              ? normalizeProcessKillResult(result)
              : action === "clear"
                ? normalizeProcessClearResult(result)
                : action === "remove"
                  ? normalizeProcessRemoveResult(result)
                  : {
                    ok: true as const,
                    summary: "Process action completed.",
                    data: {
                      result: asRecord(result)
                    }
                  };

  return {
    envelope,
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

function normalizeReadFileResult(result: unknown): NormalizedToolEnvelopeResult {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};

  const path = readNonEmptyString(record.path);
  if (path !== null) {
    data.path = path;
  }

  const content = readString(record.content);
  if (content !== null) {
    data.content = content;
  }

  const meta: Record<string, unknown> = {};
  appendNumber(meta, "start_line", record.startLine);
  appendNumber(meta, "end_line", record.endLine);
  appendNumber(meta, "total_lines", record.totalLines);
  if (readBoolean(record.truncated) === true) {
    meta.truncated = true;
  }

  return {
    envelope: {
      ok: true,
      summary: path ? `Read file ${path}.` : "Read file content.",
      data,
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    },
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

function normalizeWriteFileResult(result: unknown): NormalizedToolEnvelopeResult {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};
  const path = readNonEmptyString(record.path);
  if (path !== null) {
    data.path = path;
  }

  const meta: Record<string, unknown> = {};
  const size = readNumber(record.size);
  if (size !== null) {
    meta.bytes_written = size;
  }

  return {
    envelope: {
      ok: true,
      summary: path ? `Wrote file ${path}.` : "Wrote file content.",
      data,
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    },
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

function normalizeReplaceInFileResult(result: unknown): NormalizedToolEnvelopeResult {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};
  const targetPath = readNonEmptyString(record.path);
  if (targetPath !== null) {
    data.path = targetPath;
  }

  const meta: Record<string, unknown> = {};
  const replacements = readNumber(record.replacements);
  if (replacements !== null) {
    meta.replacements = replacements;
  }

  return {
    envelope: {
      ok: true,
      summary: targetPath ? `Updated file ${targetPath}.` : "Updated file content.",
      data,
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    },
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

function normalizeApplyPatchResult(result: unknown): NormalizedToolEnvelopeResult {
  const record = asRecord(result);
  const data: Record<string, unknown> = {};

  const engine = readNonEmptyString(record.engine);
  if (engine !== null) {
    data.engine = engine;
  }
  appendNonEmptyString(data, "stdout", record.stdout);
  appendNonEmptyString(data, "stderr", record.stderr);

  const meta: Record<string, unknown> = {};
  appendNumber(meta, "operations", record.operations);

  return {
    envelope: {
      ok: true,
      summary: engine ? `Patch applied via ${engine}.` : "Patch applied.",
      data,
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    },
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

function countWebSearchResults(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countWebSearchResults(item), 0);
  }

  if (typeof value === "object" && value !== null) {
    return 1;
  }

  return 0;
}

function normalizeWebSearchResult(result: unknown): NormalizedToolEnvelopeResult {
  const record = asRecord(result);
  const results = Array.isArray(record.results) ? record.results : [];
  const nestedResultCount = countWebSearchResults(results);
  const resultCount = nestedResultCount > 0 ? nestedResultCount : results.length;

  const data: Record<string, unknown> = {
    results
  };

  appendNonEmptyString(data, "id", record.id);
  const query = readNonEmptyString(record.query);
  if (query !== null) {
    data.query = query;
  } else {
    const queryArray = readStringArray(record.query);
    if (queryArray !== null) {
      data.query = queryArray;
    }
  }

  const meta: Record<string, unknown> = {};
  meta.result_count = resultCount;
  appendNonEmptyString(meta, "server_time", record.server_time ?? record.serverTime);

  return {
    envelope: {
      ok: true,
      summary: resultCount > 0 ? `Web search returned ${resultCount} result(s).` : "Web search returned no results.",
      data,
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    },
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

function normalizeWebFetchResult(result: unknown): NormalizedToolEnvelopeResult {
  const record = asRecord(result);
  const fetchResults = Array.isArray(record.fetch_results) ? record.fetch_results : [];

  const data: Record<string, unknown> = {};
  appendNonEmptyString(data, "url", record.url);
  appendNonEmptyString(data, "mode", record.mode);
  appendNonEmptyString(data, "content", record.content);
  if (fetchResults.length > 0) {
    data.fetch_results = fetchResults;
  }

  const meta: Record<string, unknown> = {
    fetched_count: fetchResults.length
  };
  const summary = "Web fetch returned content via defuddle.";

  return {
    envelope: {
      ok: true,
      summary,
      data,
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    },
    report: {
      success: true,
      error: null,
      errorCode: null
    }
  };
}

export function normalizeToolSuccessOutput(params: {
  tool: string;
  args: unknown;
  result: unknown;
}): NormalizedToolEnvelopeResult {
  switch (params.tool) {
    case "bash":
      return normalizeBashResult(params.args, params.result);
    case "process":
      return normalizeProcessResult(params.args, params.result);
    case "read_file":
      return normalizeReadFileResult(params.result);
    case "write_file":
      return normalizeWriteFileResult(params.result);
    case "replace_in_file":
      return normalizeReplaceInFileResult(params.result);
    case "apply_patch":
      return normalizeApplyPatchResult(params.result);
    case "web_search":
      return normalizeWebSearchResult(params.result);
    case "web_fetch":
      return normalizeWebFetchResult(params.result);
    default:
      return {
        envelope: {
          ok: true,
          summary: `${toToolLabel(params.tool)} completed successfully.`,
          data: {
            result: asRecord(params.result)
          }
        },
        report: {
          success: true,
          error: null,
          errorCode: null
        }
      };
  }
}

export function normalizeToolFailureOutput(params: {
  tool: string;
  payload: ToolErrorPayload;
}): NormalizedToolEnvelopeResult {
  const details: Record<string, unknown> = {};

  if (params.payload.hints.length > 0) {
    details.hints = params.payload.hints;
  }

  if (params.payload.expected) {
    details.expected = {
      ...(params.payload.expected.action ? { action: params.payload.expected.action } : {}),
      required: params.payload.expected.required,
      optional: params.payload.expected.optional
    };
  }

  return {
    envelope: {
      ok: false,
      summary: `${toToolLabel(params.tool)} failed.`,
      error: {
        code: params.payload.errorCode,
        message: params.payload.error,
        ...(Object.keys(details).length > 0 ? { details } : {}),
        ...(params.payload.retryable ? { retryable: true } : {})
      }
    },
    report: {
      success: false,
      error: params.payload.error,
      errorCode: params.payload.errorCode
    }
  };
}
