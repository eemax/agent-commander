import { normalizeLookup } from "./catalog-utils.js";

export type WebSearchModelCatalogEntry = {
  id: string;
  aliases: string[];
};

export function getWebSearchModelById(
  models: WebSearchModelCatalogEntry[],
  modelId: string
): WebSearchModelCatalogEntry | null {
  return models.find((item) => item.id === modelId) ?? null;
}

export function resolveWebSearchModelReference(
  models: WebSearchModelCatalogEntry[],
  input: string
): WebSearchModelCatalogEntry | null {
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

export function resolveActiveWebSearchModel(params: {
  models: WebSearchModelCatalogEntry[];
  defaultPresetId: string;
  overridePresetId: string | null;
}): WebSearchModelCatalogEntry {
  const override = params.overridePresetId ? getWebSearchModelById(params.models, params.overridePresetId) : null;
  if (override) {
    return override;
  }

  const fallback = getWebSearchModelById(params.models, params.defaultPresetId);
  if (!fallback) {
    throw new Error(`Default web search preset missing from catalog: ${params.defaultPresetId}`);
  }

  return fallback;
}
