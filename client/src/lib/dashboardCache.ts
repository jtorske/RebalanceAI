import type { ImportedHolding } from "./types";

export interface TopTrade {
  symbol: string;
  action: "buy" | "sell" | "hold";
  tradeCad: number;
}

export interface RiskConcernItem {
  severity: "high" | "medium" | "low";
  title?: string;
  symbol?: string;
  category?: string;
}

export interface RebalanceSummaryData {
  summary: string | null;
  trimSymbols: string[];
  addSymbols: string[];
  totalBuyCad: number | null;
  totalSellCad: number | null;
  topTrades: TopTrade[];
  tradeCount: number;
}

export interface RiskAlertData {
  summary: string | null;
  concerns: RiskConcernItem[];
  concernTotal: number;
  severityCounts: { high: number; medium: number; low: number };
}

export interface DashboardSummaryCache {
  holdingsHash: string;
  rebalance: RebalanceSummaryData | null;
  risk: RiskAlertData | null;
  updatedAt: string;
}

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function computeHoldingsHash(holdings: ImportedHolding[]): string {
  const fingerprint = holdings
    .map((h) => `${h.symbol}:${h.market_value}:${h.security_type}:${h.quantity}`)
    .sort()
    .join("|");
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    hash = ((hash << 5) - hash + fingerprint.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function cacheKey(userId: string | null): string {
  return `rebalancex:dashboard-cache:${userId ?? "demo"}`;
}

export function loadDashboardCache(userId: string | null): DashboardSummaryCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DashboardSummaryCache;
    if (!parsed.holdingsHash || !parsed.updatedAt) return null;
    if (Date.now() - new Date(parsed.updatedAt).getTime() > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDashboardCache(
  userId: string | null,
  holdingsHash: string,
  patch: Partial<Pick<DashboardSummaryCache, "rebalance" | "risk">>,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = cacheKey(userId);
    const existing = loadDashboardCache(userId);
    const next: DashboardSummaryCache = {
      holdingsHash,
      rebalance: patch.rebalance ?? existing?.rebalance ?? null,
      risk: patch.risk ?? existing?.risk ?? null,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors
  }
}

export function clearDashboardCache(userId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(cacheKey(userId));
  } catch {
    // ignore
  }
}

// ── Market summary cache (date-keyed, expires at midnight) ────────────────

export interface BenchmarkQuoteCache {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
}

export interface MarketComparisonCache {
  portfolioDailyPercent: number | null;
  marketDailyPercent: number | null;
  deltaPercent: number | null;
  benchmarks: BenchmarkQuoteCache[];
  perTicker?: Array<{ symbol: string; dailyPercent: number | null }>;
}

export interface MarketSummaryCache {
  date: string; // ISO date "YYYY-MM-DD"
  aiSummary: string | null;
  marketComparison: MarketComparisonCache | null;
}

const MARKET_SUMMARY_KEY = "rebalancex:market-summary";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadMarketSummaryCache(): MarketSummaryCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MARKET_SUMMARY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketSummaryCache;
    if (parsed.date !== todayIso()) return null; // stale — new trading day
    return parsed;
  } catch {
    return null;
  }
}

export function saveMarketSummaryCache(patch: Partial<MarketSummaryCache>): void {
  if (typeof window === "undefined") return;
  try {
    const existing = loadMarketSummaryCache();
    const next: MarketSummaryCache = {
      date: todayIso(),
      aiSummary: patch.aiSummary ?? existing?.aiSummary ?? null,
      marketComparison: patch.marketComparison ?? existing?.marketComparison ?? null,
    };
    window.localStorage.setItem(MARKET_SUMMARY_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
}
