import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "../lib/constants";
import {
  computeHoldingsHash,
  loadDashboardCache,
  saveDashboardCache,
} from "../lib/dashboardCache";
import type { RebalanceSummaryData, RiskAlertData } from "../lib/dashboardCache";
import {
  buildFallbackRiskAnalysis,
  normalizeRiskAnalysis,
  type RiskAnalysisApiResponse,
} from "../lib/riskAnalysis";
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

function toRiskAlertData(analysis: ReturnType<typeof normalizeRiskAnalysis>): RiskAlertData {
  return {
    summary: analysis.summary,
    concerns: analysis.mainConcerns.slice(0, 5),
    concernTotal: analysis.concernTotal,
    severityCounts: analysis.severityCounts,
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
  const data = await (res.json() as Promise<RiskAnalysisApiResponse>);
  if (import.meta.env.DEV) console.timeEnd("computeRiskScan");
  return toRiskAlertData(normalizeRiskAnalysis(data, holdings));
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
          const fallback = toRiskAlertData(buildFallbackRiskAnalysis(holdings));
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
