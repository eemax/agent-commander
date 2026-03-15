export type WebSearchModelCatalogEntry = {
  id: string;
  aliases: string[];
};

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

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
  defaultModelId: string;
  overrideModelId: string | null;
}): WebSearchModelCatalogEntry {
  const override = params.overrideModelId ? getWebSearchModelById(params.models, params.overrideModelId) : null;
  if (override) {
    return override;
  }

  const fallback = getWebSearchModelById(params.models, params.defaultModelId);
  if (!fallback) {
    throw new Error(`Default web search model missing from catalog: ${params.defaultModelId}`);
  }

  return fallback;
}
