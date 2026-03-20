export function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

export type CatalogEntry = { id: string; aliases: string[] };

export type CatalogResolver<T extends CatalogEntry> = {
  getById: (models: T[], modelId: string) => T | null;
  resolveReference: (models: T[], input: string) => T | null;
  resolveActive: (params: { models: T[]; defaultId: string; overrideId: string | null }) => T;
};

export function createCatalogResolver<T extends CatalogEntry>(label: string): CatalogResolver<T> {
  return {
    getById(models: T[], modelId: string): T | null {
      return models.find((item) => item.id === modelId) ?? null;
    },

    resolveReference(models: T[], input: string): T | null {
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
    },

    resolveActive(params: { models: T[]; defaultId: string; overrideId: string | null }): T {
      const override = params.overrideId ? this.getById(params.models, params.overrideId) : null;
      if (override) {
        return override;
      }

      const fallback = this.getById(params.models, params.defaultId);
      if (!fallback) {
        throw new Error(`Default ${label} missing from catalog: ${params.defaultId}`);
      }

      return fallback;
    }
  };
}
