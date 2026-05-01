const STORAGE_KEY = "rebalancex:ticker-metadata-v1";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface TickerMetadata {
  symbol: string;
  name?: string | null;
  exchange?: string | null;
  assetType?: string | null;
  sector?: string | null;
  marketCap?: number | null;
  currency?: string | null;
  status: "resolved" | "partial" | "unresolved";
  source?: string;
  updatedAt: string;
}

interface CachedEntry extends TickerMetadata {
  _cachedAt: number;
}

type CacheStore = Record<string, CachedEntry>;

export function loadTickerCache(): CacheStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CacheStore) : {};
  } catch {
    return {};
  }
}

export function saveTickerCache(store: CacheStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota errors
  }
}

export function getFromTickerCache(
  symbols: string[],
): { hit: Record<string, TickerMetadata>; miss: string[] } {
  const store = loadTickerCache();
  const now = Date.now();
  const hit: Record<string, TickerMetadata> = {};
  const miss: string[] = [];

  for (const sym of symbols) {
    const entry = store[sym];
    if (entry && now - entry._cachedAt < TTL_MS) {
      const { _cachedAt: _, ...data } = entry;
      hit[sym] = data;
    } else {
      miss.push(sym);
    }
  }
  return { hit, miss };
}

export function writeToTickerCache(data: Record<string, TickerMetadata>): void {
  const store = loadTickerCache();
  const now = Date.now();
  for (const [sym, meta] of Object.entries(data)) {
    store[sym] = { ...meta, _cachedAt: now };
  }
  saveTickerCache(store);
}
