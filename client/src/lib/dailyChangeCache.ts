import { DAILY_CHANGE_CACHE_KEY, LEGACY_DAILY_CHANGE_CACHE_KEY } from "./constants";

export function loadCachedDailyChangeMap(): Record<string, number> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(DAILY_CHANGE_CACHE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    const cachedMap: Record<string, number> = {};

    Object.entries(parsed).forEach(([symbol, value]) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        cachedMap[symbol] = value;
      }
    });

    return cachedMap;
  } catch {
    return {};
  }
}

export function clearLegacyDailyChangeCache(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(LEGACY_DAILY_CHANGE_CACHE_KEY);
  } catch {
    // Ignore storage failures and keep the live view working.
  }
}

export function saveCachedDailyChangeMap(map: Record<string, number>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(DAILY_CHANGE_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures and keep the live view working.
  }
}
