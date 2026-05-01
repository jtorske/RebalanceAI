import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "../lib/constants";
import {
  getFromTickerCache,
  writeToTickerCache,
  type TickerMetadata,
} from "../lib/tickerCache";

export type { TickerMetadata };

export function useTickerEnrichment(
  rawSymbols: string[],
): Record<string, TickerMetadata> {
  const [metadata, setMetadata] = useState<Record<string, TickerMetadata>>({});
  // Track which symbols have already been dispatched to the backend
  const requestedRef = useRef<Set<string>>(new Set());

  const symbols = useMemo(
    () => [...new Set(rawSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawSymbols.join(",")],
  );

  useEffect(() => {
    if (symbols.length === 0) return;

    const { hit, miss } = getFromTickerCache(symbols);

    // Apply cache hits immediately — no loading delay
    if (Object.keys(hit).length > 0) {
      setMetadata((prev) => ({ ...prev, ...hit }));
    }

    // Filter out symbols already in-flight
    const toFetch = miss.filter((s) => !requestedRef.current.has(s));
    if (toFetch.length === 0) return;

    for (const s of toFetch) requestedRef.current.add(s);

    fetch(`${API_BASE_URL}/tickers/enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: toFetch }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("enrich fetch failed");
        return r.json() as Promise<Record<string, TickerMetadata>>;
      })
      .then((data) => {
        writeToTickerCache(data);
        setMetadata((prev) => ({ ...prev, ...data }));
      })
      .catch(() => {
        // Gracefully degrade — symbol-only display remains intact
      });
  }, [symbols]);

  return metadata;
}
