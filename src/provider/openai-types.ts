import type { ThinkingEffort } from "../types.js";

export type OpenAIInputText = {
  type: "input_text";
  text: string;
};

export type OpenAIInputImage = {
  type: "input_image";
  image_url: string;
  detail?: "auto" | "low" | "high";
};

export type OpenAIInputFile = {
  type: "input_file";
  filename: string;
  file_data: string;
};

export type OpenAIContentBlock = OpenAIInputText | OpenAIInputImage | OpenAIInputFile;

export type OpenAIInputMessage = {
  type: "message";
  role: "user" | "assistant";
  content: string | OpenAIContentBlock[];
};

export type OpenAIFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type OpenAIResponsesOutputContent = {
  type?: string;
  text?: string;
};

export type OpenAIResponsesOutputItem = {
  type?: string;
  text?: string;
  content?: OpenAIResponsesOutputContent[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

export type OpenAIResponsesResponse = {
  id?: string;
  output_text?: string;
  output?: OpenAIResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
};

export type OpenAIResponsesRequestBody = {
  model: string;
  instructions?: string;
  previous_response_id?: string;
  reasoning?: {
    effort: ThinkingEffort;
  };
  prompt_cache_key?: string;
  prompt_cache_retention?: "in_memory" | "24h";
  input: Array<OpenAIInputMessage | OpenAIFunctionCallOutput>;
  tools: unknown[];
  context_management?: Array<{ type: "compaction"; compact_threshold: number }>;
};
