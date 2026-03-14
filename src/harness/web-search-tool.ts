import Perplexity from "@perplexity-ai/perplexity_ai";
import type { JsonValue, ToolDef } from "./types.js";
import { webSearchInputSchema, type WebSearchInput } from "./schemas.js";

type SearchRequest = {
  query: string | string[];
  country?: string;
  max_results?: number;
  search_domain_filter?: string[];
  search_recency_filter?: "hour" | "day" | "week" | "month" | "year";
  max_tokens: number;
  max_tokens_per_page: number;
};

type SearchResponse = {
  id: string;
  results: unknown[];
  server_time?: string | null;
};

export type WebSearchClient = {
  search: {
    create: (params: SearchRequest) => Promise<SearchResponse>;
  };
};

export type WebSearchClientFactory = (apiKey: string) => WebSearchClient;

export type WebSearchToolConfig = {
  apiKey: string;
  maxTokens: number;
  maxTokensPerPage: number;
};

function defaultWebSearchClientFactory(apiKey: string): WebSearchClient {
  return new Perplexity({ apiKey });
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

export function createWebSearchTool(
  config: WebSearchToolConfig,
  deps: { createClient?: WebSearchClientFactory } = {}
): ToolDef<typeof webSearchInputSchema> {
  const clientFactory = deps.createClient ?? defaultWebSearchClientFactory;
  const client = clientFactory(config.apiKey);

  return {
    name: "web_search",
    description:
      "Search the web via Perplexity. Supports single/multi-query input and optional country/domain/recency filters.",
    schema: webSearchInputSchema,
    async run(_ctx, input: WebSearchInput) {
      const request: SearchRequest = {
        query: input.query,
        max_tokens: config.maxTokens,
        max_tokens_per_page: config.maxTokensPerPage,
        ...(input.country ? { country: input.country } : {}),
        ...(input.max_results !== undefined ? { max_results: input.max_results } : {}),
        ...(input.search_domain_filter ? { search_domain_filter: input.search_domain_filter } : {}),
        ...(input.search_recency_filter ? { search_recency_filter: input.search_recency_filter } : {})
      };

      try {
        const response = await client.search.create(request);
        const serverTime = typeof response.server_time === "string" ? response.server_time : undefined;
        return {
          id: response.id,
          query: input.query,
          results: toJsonValue(Array.isArray(response.results) ? response.results : []),
          ...(serverTime ? { server_time: serverTime } : {})
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
