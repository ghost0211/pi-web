import {
  flattenModelsDevCatalog,
  type ModelCatalogEntry,
} from "./model-catalog";

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface CatalogCache {
  entries: ModelCatalogEntry[];
  expiresAt: number;
  inFlight?: Promise<ModelCatalogEntry[]>;
}

declare global {
  var __piModelsDevCatalogCache: CatalogCache | undefined;
}

function getCache(): CatalogCache {
  return globalThis.__piModelsDevCatalogCache ??= { entries: [], expiresAt: 0 };
}

async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
  const response = await fetch(MODELS_DEV_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const entries = flattenModelsDevCatalog(await response.json());
  if (entries.length === 0) throw new Error("models.dev returned an empty catalog");
  return entries;
}

/** Shared single-flight models.dev catalog cache (per server process). */
export async function loadModelsDevCatalog(): Promise<ModelCatalogEntry[]> {
  const cache = getCache();
  if (cache.entries.length > 0 && cache.expiresAt > Date.now()) return cache.entries;
  if (!cache.inFlight) {
    cache.inFlight = fetchCatalog().then((entries) => {
      cache.entries = entries;
      cache.expiresAt = Date.now() + CATALOG_TTL_MS;
      return entries;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.entries.length > 0) return cache.entries;
    throw error;
  }
}
