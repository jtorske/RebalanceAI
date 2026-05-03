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
  const summary = isUsableSummary(rawSummary)
    ? rawSummary
    : deriveRiskSummary(concerns);
  return {
    summary,
    concerns: concerns.slice(0, 5),
    concernTotal: concerns.length,
    severityCounts: {
      high: concerns.filter((c) => c.severity === "high").length,
      medium: concerns.filter((c) => c.severity === "medium").length,
      low: concerns.filter((c) => c.severity === "low").length,
    },
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
          setIsLoadingRebalance(false);
          setIsLoadingRisk(false);
          return;
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
          /* leave previous value on error */
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
