import type { OpenAIModelCatalogEntry } from "./runtime/contracts.js";
import { createCatalogResolver } from "./catalog-utils.js";

const resolver = createCatalogResolver<OpenAIModelCatalogEntry>("model");

export const getModelById = resolver.getById;
export const resolveModelReference = resolver.resolveReference;

export function resolveActiveModel(params: {
  models: OpenAIModelCatalogEntry[];
  defaultModelId: string;
  overrideModelId: string | null;
}): OpenAIModelCatalogEntry {
  return resolver.resolveActive({
    models: params.models,
    defaultId: params.defaultModelId,
    overrideId: params.overrideModelId
  });
}
