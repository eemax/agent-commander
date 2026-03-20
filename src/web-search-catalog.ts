import { createCatalogResolver } from "./catalog-utils.js";

export type WebSearchModelCatalogEntry = {
  id: string;
  aliases: string[];
};

const resolver = createCatalogResolver<WebSearchModelCatalogEntry>("web search preset");

export const getWebSearchModelById = resolver.getById;
export const resolveWebSearchModelReference = resolver.resolveReference;

export function resolveActiveWebSearchModel(params: {
  models: WebSearchModelCatalogEntry[];
  defaultPresetId: string;
  overridePresetId: string | null;
}): WebSearchModelCatalogEntry {
  return resolver.resolveActive({
    models: params.models,
    defaultId: params.defaultPresetId,
    overrideId: params.overridePresetId
  });
}
