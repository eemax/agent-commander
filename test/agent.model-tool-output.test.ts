import { describe, expect, it } from "vitest";
import { normalizeToolFailureOutput, normalizeToolSuccessOutput } from "../src/agent/model-tool-output.js";

describe("model tool output normalizer", () => {
  it("normalizes bash success output with compact data/meta fields", () => {
    const normalized = normalizeToolSuccessOutput({
      tool: "bash",
      args: { command: "echo hello" },
      result: {
        status: "completed",
        sessionId: "proc_123",
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
        combined: "hello\n",
        durationMs: 19,
        truncatedStdoutChars: 0,
        truncatedStderrChars: 0,
        truncatedCombinedChars: 0
      }
    });

    expect(normalized).toEqual({
      envelope: {
        ok: true,
        summary: "Bash command completed successfully.",
        data: {
          stdout: "hello\n"
        },
        meta: {
          exit_code: 0,
          duration_ms: 19
        }
      },
      report: {
        success: true,
        error: null,
        errorCode: null
      }
    });
  });

  it("normalizes bash failures for non-zero exit codes", () => {
    const normalized = normalizeToolSuccessOutput({
      tool: "bash",
      args: { command: "grep missing" },
      result: {
        status: "completed",
        sessionId: "proc_123",
        exitCode: 2,
        stdout: "",
        stderr: "grep: missing pattern",
        combined: "grep: missing pattern",
        durationMs: 11,
        truncatedStdoutChars: 0,
        truncatedStderrChars: 0,
        truncatedCombinedChars: 0
      }
    });

    expect(normalized).toEqual({
      envelope: {
        ok: false,
        summary: "Bash command failed with exit code 2.",
        error: {
          code: "NON_ZERO_EXIT",
          message: "Command exited with status 2",
          details: {
            stderr: "grep: missing pattern"
          }
        },
        meta: {
          exit_code: 2,
          duration_ms: 11
        }
      },
      report: {
        success: false,
        error: "Command exited with status 2",
        errorCode: null
      }
    });
  });

  it("normalizes bash running outputs with session state fields", () => {
    const normalized = normalizeToolSuccessOutput({
      tool: "bash",
      args: { command: "sleep 5", background: true },
      result: {
        status: "running",
        sessionId: "proc_999",
        pid: 4321,
        tail: "partial output",
        truncatedCombinedChars: 25
      }
    });

    expect(normalized).toEqual({
      envelope: {
        ok: true,
        summary: "Bash command is still running.",
        data: {
          status: "running",
          session_id: "proc_999",
          pid: 4321,
          tail: "partial output"
        },
        meta: {
          truncated: true,
          combined_chars_omitted: 25
        }
      },
      report: {
        success: true,
        error: null,
        errorCode: null
      }
    });
  });

  it.each([
    {
      name: "process list",
      tool: "process",
      args: { action: "list" },
      result: {
        sessions: [
          {
            sessionId: "proc_a",
            status: "running",
            command: "sleep 5",
            pid: 100,
            ownerId: "chat-1",
            cwd: "/tmp",
            shell: "/bin/bash",
            startedAt: "2026-03-13T00:00:00.000Z",
            finishedAt: null,
            exitCode: null,
            signal: null,
            timedOut: false,
            truncatedStdoutChars: 0,
            truncatedStderrChars: 0,
            truncatedCombinedChars: 0
          }
        ]
      },
      expected: {
        ok: true,
        summary: "Listed 1 process session(s).",
        data: {
          sessions: [
            {
              session_id: "proc_a",
              status: "running",
              command: "sleep 5",
              pid: 100
            }
          ]
        }
      }
    },
    {
      name: "process poll",
      tool: "process",
      args: { action: "poll", sessionId: "proc_a" },
      result: {
        status: "running",
        sessionId: "proc_a",
        stdout: "line\n",
        stderr: "",
        combined: "line\n",
        exitCode: null,
        signal: null,
        truncatedStdoutChars: 0,
        truncatedStderrChars: 0,
        truncatedCombinedChars: 10
      },
      expected: {
        ok: true,
        summary: "Process poll returned running status.",
        data: {
          status: "running",
          session_id: "proc_a",
          stdout: "line\n"
        },
        meta: {
          truncated: true,
          combined_chars_omitted: 10
        }
      }
    },
    {
      name: "process log",
      tool: "process",
      args: { action: "log", sessionId: "proc_a", tailLines: 20 },
      result: {
        status: "completed",
        sessionId: "proc_a",
        combined: "tail output",
        exitCode: 0,
        signal: null,
        truncatedCombinedChars: 0
      },
      expected: {
        ok: true,
        summary: "Fetched process log output.",
        data: {
          status: "completed",
          session_id: "proc_a",
          output: "tail output"
        },
        meta: {
          exit_code: 0
        }
      }
    },
    {
      name: "process write",
      tool: "process",
      args: { action: "write", sessionId: "proc_a", input: "hello" },
      result: {
        ok: true,
        sessionId: "proc_a"
      },
      expected: {
        ok: true,
        summary: "Wrote input to process session.",
        data: {
          session_id: "proc_a"
        }
      }
    },
    {
      name: "process kill",
      tool: "process",
      args: { action: "kill", sessionId: "proc_a", signal: "SIGTERM" },
      result: {
        ok: true,
        sessionId: "proc_a",
        signal: "SIGTERM",
        status: "running"
      },
      expected: {
        ok: true,
        summary: "Sent signal to process session.",
        data: {
          session_id: "proc_a",
          status: "running",
          signal: "SIGTERM"
        }
      }
    },
    {
      name: "process clear",
      tool: "process",
      args: { action: "clear", sessionId: "proc_a" },
      result: {
        ok: true,
        sessionId: "proc_a"
      },
      expected: {
        ok: true,
        summary: "Cleared pending process output.",
        data: {
          session_id: "proc_a"
        }
      }
    },
    {
      name: "process remove",
      tool: "process",
      args: { action: "remove", sessionId: "proc_a" },
      result: {
        ok: true,
        sessionId: "proc_a"
      },
      expected: {
        ok: true,
        summary: "Removed process session.",
        data: {
          session_id: "proc_a"
        }
      }
    },
    {
      name: "read_file",
      tool: "read_file",
      args: { path: "README.md" },
      result: {
        path: "/tmp/README.md",
        content: "hello\nworld\n",
        startLine: 3,
        endLine: 4,
        totalLines: 10,
        truncated: true
      },
      expected: {
        ok: true,
        summary: "Read file /tmp/README.md.",
        data: {
          path: "/tmp/README.md",
          content: "hello\nworld\n"
        },
        meta: {
          start_line: 3,
          end_line: 4,
          total_lines: 10,
          truncated: true
        }
      }
    },
    {
      name: "write_file",
      tool: "write_file",
      args: { path: "notes.txt" },
      result: {
        ok: true,
        path: "/tmp/notes.txt",
        size: 12
      },
      expected: {
        ok: true,
        summary: "Wrote file /tmp/notes.txt.",
        data: {
          path: "/tmp/notes.txt"
        },
        meta: {
          bytes_written: 12
        }
      }
    },
    {
      name: "replace_in_file",
      tool: "replace_in_file",
      args: { path: "notes.txt", oldText: "a", newText: "b" },
      result: {
        ok: true,
        path: "/tmp/notes.txt",
        replacements: 3
      },
      expected: {
        ok: true,
        summary: "Updated file /tmp/notes.txt.",
        data: {
          path: "/tmp/notes.txt"
        },
        meta: {
          replacements: 3
        }
      }
    },
    {
      name: "apply_patch",
      tool: "apply_patch",
      args: { patch: "*** Begin Patch\n*** End Patch" },
      result: {
        ok: true,
        engine: "git-apply",
        stdout: "",
        stderr: "",
        operations: 2
      },
      expected: {
        ok: true,
        summary: "Patch applied via git-apply.",
        data: {
          engine: "git-apply"
        },
        meta: {
          operations: 2
        }
      }
    },
    {
      name: "web_search (citations map with only referenced sources)",
      tool: "web_search",
      args: { query: "raspberry pi 6" },
      result: {
        query: "raspberry pi 6",
        model: "sonar",
        response_text: "Expected late 2026[1]. No official date[2].",
        search_results: [
          { id: 1, title: "Pi 6 Rumors", url: "https://example.com/pi6" },
          { id: 2, title: "Pi FAQ", url: "https://example.com/faq" },
          { id: 3, title: "Unrelated", url: "https://example.com/other" }
        ]
      },
      expected: {
        ok: true,
        summary: "Web search returned results with 2 cited source(s).",
        data: {
          response_text: "Expected late 2026[1]. No official date[2].",
          citations: {
            "1": "[Pi 6 Rumors](https://example.com/pi6)",
            "2": "[Pi FAQ](https://example.com/faq)"
          }
        },
        meta: {
          source_count: 2,
          model: "sonar"
        }
      }
    },
    {
      name: "web_search (raw <search_results> block in response_text)",
      tool: "web_search",
      args: { query: "openai symphony fuzz" },
      result: {
        model: "sonar",
        response_text:
          '<search_results>\n[1] Title: Symphony Faces Backlash\nLink: https://example.com/backlash\nSnippet: Some snippet text.\n\n[2] Title: Fuzz Testing Exposes Flaws\nLink: https://example.com/fuzz\nSnippet: Another snippet.\n\n[3] Title: Unused Result\nLink: https://example.com/unused\nSnippet: Not referenced.\n</search_results>\n\n**Symphony controversy centers on fuzz testing.** [1][2]\n\n- Fuzz revelations [1][2]\n- Musicians protest [1]'
      },
      expected: {
        ok: true,
        summary: "Web search returned results with 2 cited source(s).",
        data: {
          response_text:
            "**Symphony controversy centers on fuzz testing.** [1][2]\n\n- Fuzz revelations [1][2]\n- Musicians protest [1]",
          citations: {
            "1": "[Symphony Faces Backlash](https://example.com/backlash)",
            "2": "[Fuzz Testing Exposes Flaws](https://example.com/fuzz)"
          }
        },
        meta: {
          source_count: 2,
          model: "sonar"
        }
      }
    },
    {
      name: "web_search (raw block only, no summary text after)",
      tool: "web_search",
      args: { query: "test query" },
      result: {
        model: "sonar",
        response_text:
          "<search_results>\n[1] Title: Only Result\nLink: https://example.com/only\nSnippet: The sole result.\n</search_results>"
      },
      expected: {
        ok: true,
        summary: "Web search returned results with 1 cited source(s).",
        data: {
          citations: {
            "1": "[Only Result](https://example.com/only)"
          }
        },
        meta: {
          source_count: 1,
          model: "sonar"
        }
      }
    },
    {
      name: "web_search (raw entries without XML wrapper)",
      tool: "web_search",
      args: { query: "unwrapped query" },
      result: {
        model: "sonar",
        response_text:
          "[1] Title: First Result\nLink: https://example.com/first\nSnippet: First snippet.\n\n[2] Title: Second Result\nLink: https://example.com/second\nSnippet: Second snippet.\n\nSummary referencing [1] and [2]."
      },
      expected: {
        ok: true,
        summary: "Web search returned results with 2 cited source(s).",
        data: {
          response_text: "Summary referencing [1] and [2].",
          citations: {
            "1": "[First Result](https://example.com/first)",
            "2": "[Second Result](https://example.com/second)"
          }
        },
        meta: {
          source_count: 2,
          model: "sonar"
        }
      }
    },
    {
      name: "web_fetch",
      tool: "web_fetch",
      args: { url: "https://example.com/article" },
      result: {
        url: "https://example.com/article",
        mode: "defuddle",
        content: "Article content"
      },
      expected: {
        ok: true,
        summary: "Web fetch returned content via defuddle.",
        data: {
          url: "https://example.com/article",
          mode: "defuddle",
          content: "Article content"
        },
        meta: {
          fetched_count: 0
        }
      }
    }
  ])("normalizes %s results", ({ tool, args, result, expected }) => {
    const normalized = normalizeToolSuccessOutput({
      tool,
      args,
      result
    });

    expect(normalized.envelope).toEqual(expected);
    expect(normalized.report).toEqual({
      success: true,
      error: null,
      errorCode: null
    });
  });

  it("normalizes tool failures into nested error envelopes", () => {
    const normalized = normalizeToolFailureOutput({
      tool: "read_file",
      payload: {
        ok: false,
        error: "File not found: /tmp/missing.txt",
        errorCode: "TOOL_EXECUTION_ERROR",
        retryable: true,
        hints: ["check path"],
        expected: {
          required: ["path"],
          optional: ["offsetLine", "limitLines"],
          action: "read"
        }
      }
    });

    expect(normalized).toEqual({
      envelope: {
        ok: false,
        summary: "Read file failed.",
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: "File not found: /tmp/missing.txt",
          retryable: true,
          details: {
            hints: ["check path"],
            expected: {
              action: "read",
              required: ["path"],
              optional: ["offsetLine", "limitLines"]
            }
          }
        }
      },
      report: {
        success: false,
        error: "File not found: /tmp/missing.txt",
        errorCode: "TOOL_EXECUTION_ERROR"
      }
    });
  });
});
