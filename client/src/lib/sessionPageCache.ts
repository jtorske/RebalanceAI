const KEY_PREFIX = "rebalancex:spc:";
const DEV = import.meta.env.DEV;

// Primary in-memory store — instant access, no serialization
const memCache = new Map<string, unknown>();

let _listening = false;

function ensureListener() {
  if (_listening || typeof window === "undefined") return;
  _listening = true;
  window.addEventListener("holdings-changed", () => {
    memCache.clear();
    try {
      const toRemove = Object.keys(sessionStorage).filter((k) =>
        k.startsWith(KEY_PREFIX),
      );
      toRemove.forEach((k) => sessionStorage.removeItem(k));
    } catch {
      // ignore
    }
    if (DEV) console.log("[session-cache] cleared — holdings changed");
  });
}

export function sessionCacheGet<T>(key: string): T | null {
  ensureListener();
  if (memCache.has(key)) {
    if (DEV) console.log(`[session-cache] HIT (mem)  ${key}`);
    return memCache.get(key) as T;
  }
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + key);
    if (raw) {
      const data = JSON.parse(raw) as T;
      memCache.set(key, data);
      if (DEV) console.log(`[session-cache] HIT (ss)   ${key}`);
      return data;
    }
  } catch {
    // ignore
  }
  if (DEV) console.log(`[session-cache] MISS       ${key}`);
  return null;
}

export function sessionCacheSet<T>(key: string, data: T): void {
  ensureListener();
  memCache.set(key, data);
  try {
    sessionStorage.setItem(KEY_PREFIX + key, JSON.stringify(data));
  } catch {
    // quota — mem cache still works
  }
}

export function sessionCacheInvalidate(key: string): void {
  memCache.delete(key);
  try {
    sessionStorage.removeItem(KEY_PREFIX + key);
  } catch {
    // ignore
  }
}

export function sessionCacheInvalidateByPrefix(prefix: string): void {
  for (const k of memCache.keys()) {
    if (k.startsWith(prefix)) memCache.delete(k);
  }
  try {
    const toRemove = Object.keys(sessionStorage).filter((k) =>
      k.startsWith(KEY_PREFIX + prefix),
    );
    toRemove.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // ignore
  }
}
