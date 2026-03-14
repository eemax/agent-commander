import type { OpenAIModelCatalogEntry } from "./runtime/contracts.js";

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

export function getModelById(
  models: OpenAIModelCatalogEntry[],
  modelId: string
): OpenAIModelCatalogEntry | null {
  return models.find((item) => item.id === modelId) ?? null;
}

export function resolveModelReference(
  models: OpenAIModelCatalogEntry[],
  input: string
): OpenAIModelCatalogEntry | null {
  const normalized = normalizeLookup(input);
  if (normalized.length === 0) {
    return null;
  }

  return (
    models.find((item) => {
      if (normalizeLookup(item.id) === normalized) {
        return true;
      }

      return item.aliases.some((alias) => normalizeLookup(alias) === normalized);
    }) ?? null
  );
}

export function resolveActiveModel(params: {
  models: OpenAIModelCatalogEntry[];
  defaultModelId: string;
  overrideModelId: string | null;
}): OpenAIModelCatalogEntry {
  const override = params.overrideModelId ? getModelById(params.models, params.overrideModelId) : null;
  if (override) {
    return override;
  }

  const fallback = getModelById(params.models, params.defaultModelId);
  if (!fallback) {
    throw new Error(`Default model missing from catalog: ${params.defaultModelId}`);
  }

  return fallback;
}
