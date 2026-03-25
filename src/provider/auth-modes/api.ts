import type { AuthModeAdapter } from "../auth-mode-contracts.js";

export function createApiAdapter(params: {
  apiKey: string;
}): AuthModeAdapter {
  return {
    id: "api",

    describe() {
      return {
        label: "OpenAI API",
        capabilities: {
          allowedTransports: ["http", "wss"] as const,
          defaultTransport: "http",
          statelessToolLoop: false
        }
      };
    },

    availability() {
      return { ok: true };
    },

    async resolveRequest() {
      return {
        httpUrl: "https://api.openai.com/v1/responses",
        wsUrl: "wss://api.openai.com/v1/responses",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.apiKey}`
        },
        extraBodyFields: {},
        stripBodyFields: []
      };
    }
  };
}
