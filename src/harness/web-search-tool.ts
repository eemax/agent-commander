import Perplexity from "@perplexity-ai/perplexity_ai";
import type { JsonValue, ToolDef } from "./types.js";
import { webSearchInputSchema, type WebSearchInput } from "./schemas.js";

type ResponseCreateParams = {
  preset: string;
  input: string;
};

type OutputItem = {
  type: string;
  [key: string]: unknown;
};

type ResponseCreateResult = {
  id: string;
  output_text?: string;
  output?: OutputItem[];
  [key: string]: unknown;
};

export type WebSearchClient = {
  responses: {
    create: (params: ResponseCreateParams) => Promise<ResponseCreateResult>;
  };
};

export type WebSearchClientFactory = (apiKey: string) => WebSearchClient;

export type WebSearchToolConfig = {
  apiKey: string;
  resolveModel: (ownerId: string | null) => Promise<string>;
};

function defaultWebSearchClientFactory(apiKey: string): WebSearchClient {
  return new Perplexity({ apiKey }) as unknown as WebSearchClient;
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

function extractResult(query: string, response: ResponseCreateResult): Record<string, JsonValue> {
  const responseText = response.output_text ?? "";

  const citations: Array<{ url: string; title?: string }> = [];
  const searchResults: JsonValue[] = [];

  for (const outputItem of response.output ?? []) {
    if (outputItem.type === "search_results") {
      const results = outputItem.results;
      if (Array.isArray(results)) {
        for (const sr of results) {
          searchResults.push(toJsonValue(sr));
        }
      }
    }

    if (outputItem.type === "message") {
      const content = outputItem.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const partRecord = part as Record<string, unknown>;
          const annotations = partRecord.annotations;
          if (Array.isArray(annotations)) {
            for (const annotation of annotations) {
              const ann = annotation as Record<string, unknown>;
              if (typeof ann.url === "string") {
                const cite: { url: string; title?: string } = { url: ann.url };
                if (typeof ann.title === "string" && ann.title.length > 0) {
                  cite.title = ann.title;
                }
                citations.push(cite);
              }
            }
          }
        }
      }
    }
  }

  return {
    query,
    response_text: responseText,
    citations: toJsonValue(citations) as JsonValue,
    search_results: searchResults
  };
}

export function createWebSearchTool(
  config: WebSearchToolConfig,
  deps: { createClient?: WebSearchClientFactory } = {}
): ToolDef<typeof webSearchInputSchema> {
  const clientFactory = deps.createClient ?? defaultWebSearchClientFactory;
  const client = clientFactory(config.apiKey);

  return {
    name: "web_search",
    description:
      "Search the web via Perplexity.",
    schema: webSearchInputSchema,
    async run(ctx, input: WebSearchInput) {
      const preset = await config.resolveModel(ctx.ownerId);

      try {
        const response = await client.responses.create({
          preset,
          input: input.query
        });

        const result = extractResult(input.query, response);

        return {
          query: input.query,
          model: preset,
          ...result
        };
      } catch (error) {
        if (error instanceof Perplexity.APIError) {
          const status = error.status ?? "unknown";
          throw new Error(`Perplexity search failed (${status}): ${error.message}`);
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Perplexity search failed: ${message}`);
      }
    }
  };
}
