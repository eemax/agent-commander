import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Perplexity from "@perplexity-ai/perplexity_ai";
import type { JsonValue, ToolDef } from "./types.js";
import { webFetchInputSchema, type WebFetchInput } from "./schemas.js";

const execFileAsync = promisify(execFile);
const DEFUDDLE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_PERPLEXITY_FETCH_MODEL = "sonar";

type FetchResponseRequest = {
  model: string;
  input: string;
  instructions: string;
  tools: Array<{
    type: "fetch_url";
    max_urls?: number;
  }>;
  stream?: false;
};

type FetchResponse = {
  id?: string;
  output_text?: string;
  output?: unknown[];
};

type FetchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebFetchClient = {
  responses: {
    create: (params: FetchResponseRequest) => Promise<FetchResponse>;
  };
};

export type WebFetchClientFactory = (apiKey: string) => WebFetchClient;

export type DefuddleRunner = (url: string, timeoutMs: number) => Promise<{ markdown: string }>;

export type WebFetchToolConfig = {
  apiKey: string | null;
  model?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(item);
    }
    return out;
  }

  return String(value);
}

function formatDefuddleError(error: unknown): string {
  const nodeError = error as NodeJS.ErrnoException & { stderr?: string };
  if (nodeError?.code === "ENOENT") {
    return "defuddle command not found";
  }

  const message = error instanceof Error ? error.message : String(error);
  const stderr = readNonEmptyString(nodeError?.stderr);
  return stderr ? `${message} (${stderr})` : message;
}

async function defaultDefuddleRunner(url: string, timeoutMs: number): Promise<{ markdown: string }> {
  try {
    const { stdout } = await execFileAsync("defuddle", ["parse", url, "--md"], {
      timeout: timeoutMs,
      maxBuffer: DEFUDDLE_MAX_BUFFER_BYTES
    });
    const markdown = stdout.trim();
    if (markdown.length === 0) {
      throw new Error("defuddle returned empty content");
    }
    return { markdown };
  } catch (error) {
    throw new Error(formatDefuddleError(error));
  }
}

function defaultWebFetchClientFactory(apiKey: string): WebFetchClient {
  return new Perplexity({ apiKey }) as unknown as WebFetchClient;
}

function extractFetchResults(output: unknown): FetchResult[] {
  if (!Array.isArray(output)) {
    return [];
  }

  const out: FetchResult[] = [];
  for (const item of output) {
    const outputItem = asRecord(item);
    if (outputItem.type !== "fetch_url_results") {
      continue;
    }

    const contents = Array.isArray(outputItem.contents) ? outputItem.contents : [];
    for (const entry of contents) {
      const record = asRecord(entry);
      const title = readNonEmptyString(record.title);
      const url = readNonEmptyString(record.url);
      const snippet = readNonEmptyString(record.snippet);
      if (!title || !url || !snippet) {
        continue;
      }
      out.push({ title, url, snippet });
    }
  }

  return out;
}

async function fetchWithPerplexity(client: WebFetchClient, url: string, model: string): Promise<{
  responseId: string | null;
  content: string;
  fetchResults: FetchResult[];
}> {
  const response = await client.responses.create({
    model,
    input: `Retrieve the full content at this URL: ${url}`,
    tools: [{ type: "fetch_url", max_urls: 1 }],
    instructions:
      "Use fetch_url to retrieve the requested URL. Return the fetched page content in markdown with minimal commentary.",
    stream: false
  });

  const outputText = readNonEmptyString(response.output_text);
  const fetchResults = extractFetchResults(response.output);
  const snippets = fetchResults.map((item) => item.snippet).filter((item) => item.trim().length > 0);
  const content = outputText ?? (snippets.length > 0 ? snippets.join("\n\n") : null);
  if (!content) {
    throw new Error("Perplexity fetch_url returned no content");
  }

  return {
    responseId: readNonEmptyString(response.id),
    content,
    fetchResults
  };
}

export function createWebFetchTool(
  config: WebFetchToolConfig,
  deps: { createClient?: WebFetchClientFactory; runDefuddle?: DefuddleRunner } = {}
): ToolDef<typeof webFetchInputSchema> {
  const clientFactory = deps.createClient ?? defaultWebFetchClientFactory;
  const runDefuddle = deps.runDefuddle ?? defaultDefuddleRunner;
  const fallbackModel = config.model ?? DEFAULT_PERPLEXITY_FETCH_MODEL;
  const fallbackClient = config.apiKey !== null ? clientFactory(config.apiKey) : null;

  return {
    name: "web_fetch",
    description:
      "Fetch content from a specific URL. Uses defuddle markdown extraction first, then falls back to Perplexity fetch_url when needed.",
    schema: webFetchInputSchema,
    async run(ctx, input: WebFetchInput) {
      const mode = input.mode ?? "auto";
      let defuddleError: string | null = null;

      if (mode === "auto" || mode === "defuddle") {
        try {
          const result = await runDefuddle(input.url, ctx.config.execTimeoutMs);
          return {
            url: input.url,
            mode: "defuddle",
            content: result.markdown
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (mode === "defuddle") {
            throw new Error(`Defuddle fetch failed: ${message}`);
          }
          defuddleError = message;
        }
      }

      if (mode === "auto" || mode === "perplexity") {
        if (fallbackClient === null) {
          if (defuddleError) {
            throw new Error(
              `Defuddle fetch failed: ${defuddleError}; Perplexity fallback unavailable (config.tools.web_search.api_key is null)`
            );
          }
          throw new Error("Perplexity fetch unavailable (config.tools.web_search.api_key is null)");
        }

        try {
          const fetched = await fetchWithPerplexity(fallbackClient, input.url, fallbackModel);
          return {
            url: input.url,
            mode: "perplexity",
            content: fetched.content,
            fetch_results: toJsonValue(fetched.fetchResults),
            ...(fetched.responseId ? { response_id: fetched.responseId } : {}),
            ...(defuddleError ? { fallback_used: true, defuddle_error: defuddleError } : {})
          };
        } catch (error) {
          if (error instanceof Perplexity.APIError) {
            const status = error.status ?? "unknown";
            throw new Error(`Perplexity fetch_url failed (${status}): ${error.message}`);
          }

          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Perplexity fetch_url failed: ${message}`);
        }
      }

      throw new Error(`Unsupported web_fetch mode: ${mode}`);
    }
  };
}
