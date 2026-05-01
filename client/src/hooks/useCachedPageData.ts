import { useCallback, useEffect, useRef, useState } from "react";
import { sessionCacheGet, sessionCacheSet } from "../lib/sessionPageCache";

interface Options {
  enabled?: boolean;
  onSuccess?: (data: unknown) => void;
}

interface Result<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCachedPageData<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
  options: Options = {},
): Result<T> {
  const { enabled = true } = options;
  const [data, setData] = useState<T | null>(() => sessionCacheGet<T>(cacheKey));
  const [isLoading, setIsLoading] = useState(() => !sessionCacheGet<T>(cacheKey) && enabled);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(cacheKey);
  keyRef.current = cacheKey;

  const runFetch = useCallback(
    async (force = false) => {
      if (!force) {
        const cached = sessionCacheGet<T>(keyRef.current);
        if (cached !== null) {
          setData(cached);
          setIsLoading(false);
          return;
        }
      }
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetcherRef.current();
        sessionCacheSet(keyRef.current, result);
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load data.");
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    void runFetch();
  }, [enabled, cacheKey, runFetch]);

  const refresh = useCallback(() => void runFetch(true), [runFetch]);

  return { data, isLoading, error, refresh };
}
