import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "../lib/constants";
import {
  computeHoldingsHash,
  loadDashboardCache,
  saveDashboardCache,
} from "../lib/dashboardCache";
import type {
  RebalanceSummaryData,
  RiskAlertData,
  RiskConcernItem,
} from "../lib/dashboardCache";
import type { ImportedHolding } from "../lib/types";

const ANALYTICS_TIMEOUT_MS = 30000;

function fetchWithTimeout(url: string, options: RequestInit) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    ANALYTICS_TIMEOUT_MS,
  );

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

const repairText = (v: string) =>
  v
    .replaceAll("â", "'")
    .replaceAll("â", "'")
    .replaceAll("â", '"')
    .replaceAll("â", '"')
    .replaceAll("â", "-")
    .replaceAll("â", "-");

const stripPreamble = (text: string) =>
  text
    .replace(/^here (?:are|is) (?:two|2|some|a few) (?:concise )?sentences?[^:]*:\s*/i, "")
    .replace(/^sure[,!]?\s+here (?:are|is)[^:]*:\s*/i, "")
    .trim();

function isUsableSummary(s: string | null | undefined): s is string {
  if (!s) return false;
  const t = s.trim();
  return t.length >= 15 && !/^\d+\.?\s*$/.test(t);
}

function deriveRiskSummary(concerns: RiskConcernItem[]): string {
  if (concerns.length === 0) {
    return "No major portfolio risks stand out from current holdings.";
  }
  const symbols = [
    ...new Set(concerns.slice(0, 3).map((c) => c.symbol).filter(Boolean)),
  ] as string[];
  if (symbols.length === 0) {
    return `${concerns.length} risk signal${concerns.length > 1 ? "s" : ""} detected across the portfolio.`;
  }
  return `The main risks to review are ${symbols.join(", ")} based on current portfolio signals.`;
}

function buildFallbackRiskAlert(holdings: ImportedHolding[]): RiskAlertData {
  const severityCounts = { high: 0, medium: 0, low: 0 };
  const concerns: RiskConcernItem[] = [];

  const valueBySymbol = new Map<string, number>();
  let totalValueCad = 0;
  let optionValueCad = 0;

  for (const holding of holdings) {
    const symbol = holding.symbol.trim().toUpperCase();
    const valueCad = Number.isFinite(holding.market_value)
      ? holding.market_value *
        (holding.market_value_currency?.trim().toUpperCase() === "USD"
          ? 1.37
          : 1)
      : 0;
    if (!symbol || valueCad <= 0) continue;

    totalValueCad += valueCad;
    valueBySymbol.set(symbol, (valueBySymbol.get(symbol) ?? 0) + valueCad);
    if (holding.security_type.toUpperCase().includes("OPTION")) {
      optionValueCad += valueCad;
    }
  }

  const weighted = [...valueBySymbol.entries()]
    .map(([symbol, valueCad]) => ({
      symbol,
      weight: totalValueCad > 0 ? (valueCad / totalValueCad) * 100 : 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  const top = weighted[0];
  if (top?.weight >= 30) {
    severityCounts.high += 1;
    concerns.push({
      severity: "high",
      symbol: top.symbol,
      title: "Large single-position weight",
      category: "Concentration",
    });
  } else if (top?.weight >= 18) {
    severityCounts.medium += 1;
    concerns.push({
      severity: "medium",
      symbol: top.symbol,
      title: "Meaningful single-position weight",
      category: "Concentration",
    });
  }

  const topThreeWeight = weighted
    .slice(0, 3)
    .reduce((sum, item) => sum + item.weight, 0);
  if (topThreeWeight >= 60) {
    severityCounts.medium += 1;
    concerns.push({
      severity: "medium",
      symbol: "Portfolio",
      title: "Top holdings concentration",
      category: "Concentration",
    });
  }

  const optionWeight = totalValueCad > 0 ? (optionValueCad / totalValueCad) * 100 : 0;
  if (optionWeight >= 10) {
    severityCounts.high += 1;
    concerns.push({
      severity: "high",
      symbol: "Options",
      title: "Options exposure",
      category: "Derivatives",
    });
  } else if (optionWeight >= 2) {
    severityCounts.low += 1;
    concerns.push({
      severity: "low",
      symbol: "Options",
      title: "Options exposure",
      category: "Derivatives",
    });
  }

  const summary =
    concerns.length > 0
      ? deriveRiskSummary(concerns)
      : "No major portfolio risks stand out from current holdings.";

  return {
    summary,
    concerns: concerns.slice(0, 5),
    concernTotal: concerns.length,
    severityCounts,
  };
}

async function fetchRebalanceSummary(
  holdings: ImportedHolding[],
): Promise<RebalanceSummaryData> {
  if (import.meta.env.DEV) console.time("computeRebalance");
  const res = await fetchWithTimeout(`${API_BASE_URL}/reweight/ai-summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdings }),
  });
  if (!res.ok) throw new Error("rebalance summary fetch failed");
  const data = await (res.json() as Promise<{
    summary?: string | null;
    trimSymbols?: string[];
    addSymbols?: string[];
    overweights?: Array<{ symbol: string }>;
    underweights?: Array<{ symbol: string }>;
    totalBuyCad?: number;
    totalSellCad?: number;
    topTrades?: Array<{ symbol: string; action: "buy" | "sell" | "hold"; tradeCad: number }>;
    tradeCount?: number;
  }>);
  if (import.meta.env.DEV) console.timeEnd("computeRebalance");
  return {
    summary: data.summary ? repairText(data.summary) : null,
    trimSymbols: data.trimSymbols ?? (data.overweights ?? []).map((o) => o.symbol).slice(0, 3),
    addSymbols: data.addSymbols ?? (data.underweights ?? []).map((u) => u.symbol).slice(0, 3),
    totalBuyCad: data.totalBuyCad ?? null,
    totalSellCad: data.totalSellCad ?? null,
    topTrades: data.topTrades ?? [],
    tradeCount: data.tradeCount ?? 0,
  };
}

async function fetchRiskAlert(holdings: ImportedHolding[]): Promise<RiskAlertData> {
  if (import.meta.env.DEV) console.time("computeRiskScan");
  const res = await fetchWithTimeout(`${API_BASE_URL}/risk/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdings }),
  });
  if (!res.ok) throw new Error("risk analysis fetch failed");
  const data = await (res.json() as Promise<{
    dashboardSummary?: string | null;
    concerns?: RiskConcernItem[];
  }>);
  if (import.meta.env.DEV) console.timeEnd("computeRiskScan");
  const concerns = data.concerns ?? [];
  const rawSummary = data.dashboardSummary
    ? stripPreamble(repairText(data.dashboardSummary))
    : null;
  let summary = isUsableSummary(rawSummary)
    ? rawSummary
    : deriveRiskSummary(concerns);
  let nextConcerns = concerns;
  let nextSeverityCounts = {
    high: concerns.filter((c) => c.severity === "high").length,
    medium: concerns.filter((c) => c.severity === "medium").length,
    low: concerns.filter((c) => c.severity === "low").length,
  };

  if (holdings.length > 0 && concerns.length === 0) {
    const fallback = buildFallbackRiskAlert(holdings);
    if (fallback.concernTotal > 0) {
      summary = fallback.summary ?? deriveRiskSummary(fallback.concerns);
      nextConcerns = fallback.concerns;
      nextSeverityCounts = fallback.severityCounts;
    }
  }

  return {
    summary,
    concerns: nextConcerns.slice(0, 5),
    concernTotal: nextConcerns.length,
    severityCounts: nextSeverityCounts,
  };
}

export interface DashboardSummaryState {
  rebalance: RebalanceSummaryData | null;
  risk: RiskAlertData | null;
  isLoadingRebalance: boolean;
  isLoadingRisk: boolean;
  refreshAll: () => void;
}

export function useDashboardSummary(
  holdings: ImportedHolding[],
  userId: string | null | undefined,
): DashboardSummaryState {
  const [rebalance, setRebalance] = useState<RebalanceSummaryData | null>(null);
  const [risk, setRisk] = useState<RiskAlertData | null>(null);
  const [isLoadingRebalance, setIsLoadingRebalance] = useState(true);
  const [isLoadingRisk, setIsLoadingRisk] = useState(true);

  const uid = userId ?? null;
  const holdingsHash = useMemo(() => computeHoldingsHash(holdings), [holdings]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeHashRef = useRef<string>("");

  const loadSummaries = useCallback(
    (hash: string, force = false) => {
      if (!force) {
        const cached = loadDashboardCache(uid);
        if (cached && cached.holdingsHash === hash) {
          if (cached.rebalance) setRebalance(cached.rebalance);
          if (cached.risk) setRisk(cached.risk);
        }
      }

      setIsLoadingRebalance(true);
      setIsLoadingRisk(true);

      fetchRebalanceSummary(holdings)
        .then((data) => {
          setRebalance(data);
          saveDashboardCache(uid, hash, { rebalance: data });
        })
        .catch(() => {
          /* leave previous value on error */
        })
        .finally(() => {
          setIsLoadingRebalance(false);
        });

      fetchRiskAlert(holdings)
        .then((data) => {
          setRisk(data);
          saveDashboardCache(uid, hash, { risk: data });
        })
        .catch(() => {
          const fallback = buildFallbackRiskAlert(holdings);
          setRisk(fallback);
          saveDashboardCache(uid, hash, { risk: fallback });
        })
        .finally(() => {
          setIsLoadingRisk(false);
        });
    },
    [holdings, uid],
  );

  // Load from cache only once holdings are known, so stale empty-backend summaries
  // do not mask the live portfolio on hosted deployments.
  useEffect(() => {
    const cached = loadDashboardCache(uid);
    if (!cached || cached.holdingsHash !== holdingsHash) return;
    if (cached.rebalance) setRebalance(cached.rebalance);
    if (cached.risk) setRisk(cached.risk);
    setIsLoadingRebalance(false);
    setIsLoadingRisk(false);
  }, [holdingsHash, uid]);

  // Debounced recompute when holdings/hash changes
  useEffect(() => {
    if (holdings.length === 0) {
      setIsLoadingRebalance(false);
      setIsLoadingRisk(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (activeHashRef.current === holdingsHash) return;
      activeHashRef.current = holdingsHash;
      loadSummaries(holdingsHash);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [holdingsHash, holdings.length, loadSummaries]);

  const refreshAll = useCallback(() => {
    loadSummaries(holdingsHash, true);
  }, [holdingsHash, loadSummaries]);

  return { rebalance, risk, isLoadingRebalance, isLoadingRisk, refreshAll };
}
