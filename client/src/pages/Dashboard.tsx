import { FiAlertCircle, FiBarChart2, FiLock } from "react-icons/fi";
import { HiOutlineLightBulb } from "react-icons/hi";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar";
import { TickerLogoBadge } from "../components/TickerLogoBadge";
import DashboardOnboardingBanner from "../components/DashboardOnboardingBanner";
import "./Dashboard.css";
import { API_BASE_URL } from "../lib/constants";
import { DONUT_COLORS, OTHER_DONUT_COLOR } from "../lib/dashboardUtils";
import { convertToCad } from "../lib/holdingsUtils";
import { useUserSettings } from "../lib/userSettings";
import { useAuth } from "../context/AuthContext";
import { useDemoMode } from "../lib/demoMode";
import { useDashboardSummary } from "../hooks/useDashboardSummary";
import { useTickerEnrichment } from "../hooks/useTickerEnrichment";
import { loadActiveHoldings } from "../services/activeHoldings";
import { DataStatusPanel } from "../components/common/DataStatusPanel";
import {
  computeHoldingsHash,
  loadMarketSummaryCache,
  saveMarketSummaryCache,
} from "../lib/dashboardCache";
import type {
  ImportedHolding,
  BenchmarkQuote,
  MarketComparisonResponse,
  WeightedHolding,
} from "../lib/types";

type AiSummaryResponse = {
  summary: string | null;
  source?: "ollama" | "fallback";
  cached?: boolean;
};

type MarketDriver = {
  symbol: string;
  contributionPercent: number;
  dailyPercent: number | null;
};

type FormattedMarketSummary = {
  headline: string;
  date: string;
  body: string[];
  contributors: MarketDriver[];
};

type SectorBreakdownEntry = {
  sector: string;
  valueCad: number;
  weight: number;
};

type SectorBreakdownResponse = {
  sectors: SectorBreakdownEntry[];
  totalValueCad: number;
  generatedAt: string;
};

const MAX_CARD_ACTION_ROWS = 5;

// Session-scoped cache — keyed by holdingsHash so tab-focus re-renders that
// produce a new `holdings` array reference (same data) skip the network call.
const sectorBreakdownCache = new Map<string, SectorBreakdownEntry[]>();

const formatSummaryDirection = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "unavailable";
  }
  if (value > 0) return `up ${Math.abs(value).toFixed(2)}%`;
  if (value < 0) return `down ${Math.abs(value).toFixed(2)}%`;
  return "flat at 0.00%";
};

const buildMarketSummaryFallback = (
  comparison: MarketComparisonResponse | null,
) => {
  if (!comparison) {
    return "Market summary cannot be calculated because current portfolio and benchmark quote data are unavailable.";
  }

  const portfolio = comparison.portfolioDailyPercent;
  const market = comparison.marketDailyPercent;
  if (portfolio !== null && portfolio !== undefined) {
    return `The portfolio is ${formatSummaryDirection(portfolio)} today, compared with a benchmark average that is ${formatSummaryDirection(market)}.`;
  }

  const benchmarkParts = (comparison.benchmarks ?? [])
    .filter((item) => typeof item.changePercent === "number")
    .slice(0, 3)
    .map((item) => `${item.symbol} ${formatSummaryDirection(item.changePercent)}`);

  if (benchmarkParts.length > 0) {
    return `Portfolio daily data is not available yet. Current benchmark moves include ${benchmarkParts.join(", ")}.`;
  }

  return "Market summary cannot be calculated because current portfolio and benchmark quote data are unavailable.";
};

const repairTextEncoding = (value: string) =>
  value
    .replaceAll("\u00e2\u0080\u0099", "'")
    .replaceAll("\u00e2\u0080\u0098", "'")
    .replaceAll("\u00e2\u0080\u009c", '"')
    .replaceAll("\u00e2\u0080\u009d", '"')
    .replaceAll("\u00e2\u0080\u0093", "-")
    .replaceAll("\u00e2\u0080\u0094", "-");

const MARKET_SUMMARY_META_PATTERNS = [
  /\bhere(?:'s| is)\s+(?:the\s+)?(?:polished\s+)?summary\b/i,
  /\balternatively\b/i,
  /\ba more concise version\b/i,
  /\boption\s+\d+\b/i,
  /\bversion\s+\d+\b/i,
  /\bsummary to polish\b/i,
  /\bbenchmark context\b/i,
  /\bi can\b/i,
];

const hasMarketSummaryMetaArtifacts = (text: string) =>
  MARKET_SUMMARY_META_PATTERNS.some((pattern) => pattern.test(text)) ||
  ((text.match(/\n/g) ?? []).length >= 2 &&
    /\b(summary|version|option|alternatively)\b/i.test(text));

const sanitizeAiSummary = (text: string): string | null => {
  const repaired = repairTextEncoding(text)
    .replace(/\*\*/g, "")
    .replace(/^[-*\d.\s]*(?:summary|option|version)\s*\d*\s*:\s*/i, "")
    .trim();

  if (!repaired || hasMarketSummaryMetaArtifacts(repaired)) {
    return null;
  }

  const firstLine = repaired
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine || hasMarketSummaryMetaArtifacts(firstLine)) {
    return null;
  }

  return firstLine;
};

const formatSymbolList = (symbols: string[]) => {
  const cleaned = symbols.map((symbol) => symbol.trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(", ")}, and ${
    cleaned[cleaned.length - 1]
  }`;
};

const stripTickerWeights = (symbols: string[]) =>
  symbols.map((symbol) => symbol.replace(/\s*\([^)]*\)\s*$/g, "").trim());

const getPerformanceHeadline = (portfolioDailyPercent: number | null) => {
  if (portfolioDailyPercent === null) return "Today's market update";
  const sign = portfolioDailyPercent >= 0 ? "+" : "";
  if (portfolioDailyPercent >= 0.5) {
    return `Portfolio up ${sign}${portfolioDailyPercent.toFixed(2)}% today`;
  }
  if (portfolioDailyPercent <= -0.5) {
    return `Portfolio down ${portfolioDailyPercent.toFixed(2)}% today`;
  }
  return `Portfolio roughly flat at ${sign}${portfolioDailyPercent.toFixed(2)}% today`;
};

const getTopMarketContributors = (
  marketData: MarketComparisonResponse | null,
  weightedHoldings: WeightedHolding[],
  totalMarketValueCad: number,
): MarketDriver[] => {
  if (!marketData?.perTicker || weightedHoldings.length === 0) {
    return [];
  }

  const dailyBySymbol = new Map<string, number[]>();
  for (const item of marketData.perTicker) {
    if (typeof item.dailyPercent !== "number") continue;
    const symbol = item.symbol.trim().toUpperCase();
    dailyBySymbol.set(symbol, [
      ...(dailyBySymbol.get(symbol) ?? []),
      item.dailyPercent,
    ]);
  }

  const valueBySymbol = new Map<string, number>();
  for (const holding of weightedHoldings) {
    const symbol = holding.symbol.trim().toUpperCase();
    valueBySymbol.set(
      symbol,
      (valueBySymbol.get(symbol) ?? 0) + holding.marketValueCad,
    );
  }

  return [...dailyBySymbol.entries()]
    .map(([symbol, dailyValues]) => {
      const marketValueCad = valueBySymbol.get(symbol) ?? 0;
      const dailyPercent =
        dailyValues.reduce((sum, value) => sum + value, 0) /
        dailyValues.length;
      return {
        symbol,
        dailyPercent,
        contributionPercent:
          totalMarketValueCad > 0
            ? (marketValueCad / totalMarketValueCad) * dailyPercent
            : 0,
      };
    })
    .filter(
      (item) =>
        item.contributionPercent !== 0 ||
        (item.dailyPercent !== null && item.dailyPercent !== 0),
    )
    .sort(
      (a, b) =>
        Math.abs(b.contributionPercent) - Math.abs(a.contributionPercent),
    )
    .slice(0, 3);
};

const formatMarketDriverImpact = (driver: MarketDriver) => {
  if (Number.isFinite(driver.contributionPercent)) {
    return `${driver.contributionPercent >= 0 ? "+" : ""}${driver.contributionPercent.toFixed(2)}%`;
  }

  if (driver.dailyPercent !== null && Number.isFinite(driver.dailyPercent)) {
    return `${driver.dailyPercent >= 0 ? "+" : ""}${driver.dailyPercent.toFixed(1)}%`;
  }

  return null;
};

const getPortfolioDailyFromTickerData = (
  marketData: MarketComparisonResponse | null,
  weightedHoldings: WeightedHolding[],
  totalMarketValueCad: number,
): number | null => {
  if (!marketData?.perTicker || totalMarketValueCad <= 0) {
    return null;
  }

  const valueBySymbol = new Map<string, number>();
  for (const holding of weightedHoldings) {
    const symbol = holding.symbol.trim().toUpperCase();
    valueBySymbol.set(
      symbol,
      (valueBySymbol.get(symbol) ?? 0) + holding.marketValueCad,
    );
  }

  let weightedDailySum = 0;
  let coveredValueCad = 0;
  for (const item of marketData.perTicker) {
    if (typeof item.dailyPercent !== "number") continue;
    const valueCad = valueBySymbol.get(item.symbol.trim().toUpperCase()) ?? 0;
    if (valueCad <= 0) continue;
    weightedDailySum += (valueCad / totalMarketValueCad) * item.dailyPercent;
    coveredValueCad += valueCad;
  }

  return coveredValueCad > 0 ? weightedDailySum : null;
};

const hasUsableMarketComparison = (
  marketData: MarketComparisonResponse | null,
) =>
  !!marketData &&
  (marketData.portfolioDailyPercent !== null ||
    marketData.marketDailyPercent !== null ||
    (marketData.benchmarks ?? []).some(
      (item) => typeof item.changePercent === "number",
    ) ||
    (marketData.perTicker ?? []).some(
      (item) => typeof item.dailyPercent === "number",
    ));

const formatMarketSummary = (
  rawSummary: string | null,
  marketData: MarketComparisonResponse | null,
  weightedHoldings: WeightedHolding[],
  totalMarketValueCad: number,
): FormattedMarketSummary => {
  const portfolioDailyPercent =
    marketData?.portfolioDailyPercent ??
    getPortfolioDailyFromTickerData(
      marketData,
      weightedHoldings,
      totalMarketValueCad,
    );
  const marketDailyPercent = marketData?.marketDailyPercent ?? null;
  const safeRawSummary = rawSummary ? sanitizeAiSummary(rawSummary) : null;
  const contributors = getTopMarketContributors(
    marketData,
    weightedHoldings,
    totalMarketValueCad,
  );

  if (portfolioDailyPercent !== null && marketDailyPercent !== null) {
    const spread = portfolioDailyPercent - marketDailyPercent;
    if (Math.abs(spread) < 0.005) {
      return {
        headline: getPerformanceHeadline(portfolioDailyPercent),
        date: new Date().toLocaleDateString("en-CA", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        body: [
          "Matched the benchmark today.",
          "Portfolio holdings moved broadly in line with benchmark averages.",
        ],
        contributors,
      };
    }

    const verb = spread >= 0 ? "Outperformed" : "Underperformed";
    const reason =
      spread >= 0
        ? "Stronger relative performance across core holdings widened the lead."
        : "Weaker relative performance across core holdings drove the gap.";

    return {
      headline: getPerformanceHeadline(portfolioDailyPercent),
      date: new Date().toLocaleDateString("en-CA", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      body: [
        `${verb} the benchmark by ${Math.abs(spread).toFixed(2)}%.`,
        reason,
      ],
      contributors,
    };
  }

  return {
    headline: getPerformanceHeadline(portfolioDailyPercent),
    date: new Date().toLocaleDateString("en-CA", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    body: [
      safeRawSummary ??
        buildMarketSummaryFallback(marketData) ??
        "Market summary will appear once portfolio and benchmark data are available.",
    ],
    contributors,
  };
};

const getFallbackRebalanceSummary = (holdings: ImportedHolding[]): string => {
  if (holdings.length === 0) {
    return "Import holdings to get a rebalance suggestion based on your current weights.";
  }

  const normalizeSymbol = (symbol: string) =>
    symbol.trim().toUpperCase().replace(/\s+/g, "");

  const isStockLike = (securityType: string) =>
    !securityType.includes("OPTION") &&
    !securityType.includes("ETF") &&
    !securityType.includes("FUND") &&
    !securityType.includes("BOND") &&
    !securityType.includes("CASH");

  const bySymbol = new Map<
    string,
    { symbol: string; valueCad: number; hasStockLike: boolean }
  >();

  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding.symbol);
    if (!symbol) {
      continue;
    }

    const valueCad = convertToCad(
      holding.market_value,
      holding.market_value_currency,
    );
    if (valueCad <= 0) {
      continue;
    }

    const securityType = holding.security_type.trim().toUpperCase();
    const existing = bySymbol.get(symbol);
    if (existing) {
      existing.valueCad += valueCad;
      existing.hasStockLike =
        existing.hasStockLike || isStockLike(securityType);
      continue;
    }

    bySymbol.set(symbol, {
      symbol,
      valueCad,
      hasStockLike: isStockLike(securityType),
    });
  }

  const mergedHoldings = [...bySymbol.values()];
  const totalValueCad = mergedHoldings.reduce(
    (sum, item) => sum + item.valueCad,
    0,
  );
  if (totalValueCad <= 0) {
    return "The current holdings could not be valued for rebalance analysis yet.";
  }

  const weighted = mergedHoldings
    .map((item) => ({
      symbol: item.symbol,
      weight: (item.valueCad / totalValueCad) * 100,
      hasStockLike: item.hasStockLike,
    }))
    .sort((a, b) => b.weight - a.weight)
    .filter((item) => item.weight > 0);

  if (weighted.length === 0) {
    return "The current holdings could not be valued for rebalance analysis yet.";
  }

  const estimatedMarketCapBillions: Record<string, number> = {
    GOOG: 2050,
    AMD: 285,
    MU: 150,
    WDC: 22,
    SNDK: 18,
    ETN: 140,
    CEG: 80,
    VST: 55,
    SLS: 0.2,
    ONDS: 0.2,
    HG: 0.05,
  };

  const stockLike = weighted.filter((item) => item.hasStockLike);
  const nonStockLike = weighted.filter((item) => !item.hasStockLike);

  const stockWeightBudget = stockLike.reduce(
    (sum, item) => sum + item.weight,
    0,
  );

  const stockCapScores = stockLike.map((item) => ({
    ...item,
    // Unknown symbols default to current-weight proxy to avoid unstable guesses.
    capScore:
      estimatedMarketCapBillions[item.symbol] ?? Math.max(item.weight, 0.1),
  }));
  const totalCapScore = stockCapScores.reduce(
    (sum, item) => sum + item.capScore,
    0,
  );

  const targetBySymbol = new Map<string, number>();
  for (const item of nonStockLike) {
    targetBySymbol.set(item.symbol, item.weight);
  }
  if (totalCapScore > 0 && stockWeightBudget > 0) {
    for (const item of stockCapScores) {
      targetBySymbol.set(
        item.symbol,
        (item.capScore / totalCapScore) * stockWeightBudget,
      );
    }
  } else {
    for (const item of stockLike) {
      targetBySymbol.set(item.symbol, item.weight);
    }
  }

  const overweights = weighted
    .map((item) => ({
      symbol: item.symbol,
      weight: item.weight,
      targetWeight: targetBySymbol.get(item.symbol) ?? item.weight,
    }))
    .filter((item) => item.weight - item.targetWeight >= 1.5)
    .sort((a, b) => b.weight - b.targetWeight - (a.weight - a.targetWeight));

  const underweights = weighted
    .map((item) => ({
      symbol: item.symbol,
      weight: item.weight,
      targetWeight: targetBySymbol.get(item.symbol) ?? item.weight,
    }))
    .filter((item) => item.targetWeight - item.weight >= 1.5)
    .sort((a, b) => b.targetWeight - b.weight - (a.targetWeight - a.weight));

  if (overweights.length === 0 && underweights.length === 0) {
    return "Your portfolio is relatively close to a market-cap-weighted target; no major allocation drift stands out.";
  }

  const topOver = overweights
    .slice(0, 3)
    .map((item) => `${item.symbol} (${item.weight.toFixed(1)}%)`)
    .join(", ");
  const topUnder = underweights
    .slice(0, 3)
    .map((item) => `${item.symbol} (${item.weight.toFixed(1)}%)`)
    .join(", ");

  return `Current weights suggest trimming ${topOver || "overweight names"} and adding to ${topUnder || "underweight names"} to improve balance.`;
};

const getFallbackRiskAnalysis = (
  holdings: ImportedHolding[],
): {
  summary: string;
  severityCounts: { high: number; medium: number; low: number };
} => {
  if (holdings.length === 0) {
    return {
      summary:
        "Import holdings to scan for concentration, volatility, market-cap, and catalyst risks.",
      severityCounts: { high: 0, medium: 0, low: 0 },
    };
  }

  const totalValueCad = holdings.reduce(
    (sum, holding) =>
      sum + convertToCad(holding.market_value, holding.market_value_currency),
    0,
  );

  if (totalValueCad <= 0) {
    return {
      summary:
        "Risk scan is limited because portfolio values are not available.",
      severityCounts: { high: 0, medium: 0, low: 1 },
    };
  }

  const weighted = holdings
    .map((holding) => ({
      symbol: holding.symbol,
      securityType: holding.security_type,
      weight:
        (convertToCad(holding.market_value, holding.market_value_currency) /
          totalValueCad) *
        100,
    }))
    .sort((a, b) => b.weight - a.weight);

  const topWeight = weighted[0]?.weight ?? 0;
  const topThreeWeight = weighted
    .slice(0, 3)
    .reduce((sum, item) => sum + item.weight, 0);
  const optionWeight = weighted
    .filter((item) => item.securityType.toUpperCase().includes("OPTION"))
    .reduce((sum, item) => sum + item.weight, 0);

  const severityCounts = { high: 0, medium: 0, low: 0 };
  const notes: string[] = [];

  if (topWeight >= 25) {
    severityCounts.high += 1;
    notes.push(
      `${weighted[0]?.symbol ?? "Top holding"} is ${topWeight.toFixed(1)}% of the portfolio`,
    );
  }
  if (topThreeWeight >= 65) {
    severityCounts.medium += 1;
    notes.push(`top 3 positions are ${topThreeWeight.toFixed(1)}% combined`);
  }
  if (optionWeight >= 10) {
    severityCounts.high += 1;
    notes.push(`options represent ${optionWeight.toFixed(1)}% of total value`);
  }

  if (notes.length === 0) {
    return {
      summary:
        "No major concentration risk stands out from the current holdings snapshot, but continue monitoring position sizing and catalysts.",
      severityCounts,
    };
  }

  return {
    summary: `Risk flags detected: ${notes.join("; ")}.`,
    severityCounts,
  };
};

const normalizeTickerForSector = (symbol: string) =>
  symbol.trim().toUpperCase().replace(/\s+/g, "");

const inferSectorFromHolding = (holding: ImportedHolding): string => {
  const securityType = holding.security_type.trim().toUpperCase();
  const symbol = normalizeTickerForSector(holding.symbol);
  const name = (holding.name ?? "").trim().toUpperCase();

  if (securityType.includes("OPTION")) return "Derivatives";
  if (securityType.includes("BOND")) return "Fixed Income";
  if (securityType.includes("FUND") || securityType.includes("ETF")) {
    return "ETF / Diversified";
  }

  const symbolSectorMap: Record<string, string> = {
    AMD: "Technology",
    GOOG: "Communication Services",
    MU: "Technology",
    WDC: "Technology",
    SNDK: "Technology",
    CEG: "Utilities",
    ETN: "Industrials",
    VST: "Utilities",
    SLS: "Healthcare",
    ONDS: "Technology",
    HG: "Materials",
    GDX: "Materials",
    XEQT: "ETF / Diversified",
  };

  if (symbolSectorMap[symbol]) {
    return symbolSectorMap[symbol];
  }

  if (name.includes("TECH") || name.includes("SEMICONDUCTOR")) {
    return "Technology";
  }
  if (
    name.includes("HEALTH") ||
    name.includes("PHARMA") ||
    name.includes("BIO")
  ) {
    return "Healthcare";
  }
  if (
    name.includes("ENERGY") ||
    name.includes("POWER") ||
    name.includes("OIL")
  ) {
    return "Energy";
  }
  if (
    name.includes("BANK") ||
    name.includes("FINANC") ||
    name.includes("INSURANCE")
  ) {
    return "Financials";
  }
  if (
    name.includes("MINING") ||
    name.includes("GOLD") ||
    name.includes("METAL")
  ) {
    return "Materials";
  }
  if (name.includes("REIT") || name.includes("REAL ESTATE")) {
    return "Real Estate";
  }
  if (name.includes("COMM") || name.includes("MEDIA")) {
    return "Communication Services";
  }

  return "Other";
};

const buildSectorBreakdownFromHoldings = (
  holdings: ImportedHolding[],
): SectorBreakdownEntry[] => {
  const bySector = new Map<string, number>();
  let totalValueCad = 0;

  for (const holding of holdings) {
    const valueCad = convertToCad(
      holding.market_value,
      holding.market_value_currency,
    );
    if (valueCad <= 0) {
      continue;
    }

    const sector = inferSectorFromHolding(holding);

    totalValueCad += valueCad;
    bySector.set(sector, (bySector.get(sector) ?? 0) + valueCad);
  }

  if (totalValueCad <= 0) {
    return [];
  }

  return [...bySector.entries()]
    .map(([sector, valueCad]) => ({
      sector,
      valueCad,
      weight: (valueCad / totalValueCad) * 100,
    }))
    .sort((a, b) => b.valueCad - a.valueCad);
};

function Dashboard() {
  const { settings } = useUserSettings();
  const { user, portfolio, hasHoldings, portfolioLoading } = useAuth();
  const { isDemoMode, enableDemoMode } = useDemoMode();
  const [holdings, setHoldings] = useState<ImportedHolding[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkQuote[]>([]);
  const [isLoadingBenchmarks, setIsLoadingBenchmarks] = useState(true);
  const [marketComparison, setMarketComparison] =
    useState<MarketComparisonResponse | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [sectorBreakdown, setSectorBreakdown] = useState<
    SectorBreakdownEntry[]
  >([]);
  const [isLoadingSectorBreakdown, setIsLoadingSectorBreakdown] =
    useState(true);
  const [hoveredChipSymbol, setHoveredChipSymbol] = useState<string | null>(
    null,
  );
  // One-shot flag: removed after the enter animation completes so tab-switch
  // visibility events can never restart the donut-appear animation.
  const [donutAppeared, setDonutAppeared] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDonutAppeared(true), 550);
    return () => clearTimeout(t);
  }, []);
  const holdingsHash = useMemo(() => computeHoldingsHash(holdings), [holdings]);
  const shouldWaitForSyncedHoldings =
    !!user && (portfolioLoading || (hasHoldings && holdings.length === 0));

  useEffect(() => {
    const loadHoldings = async () => {
      if (user && !portfolio && portfolioLoading) return;
      try {
        setHoldings(
          await loadActiveHoldings({
            portfolioId: portfolio?.id,
            isDemoMode,
          }),
        );
      } catch {
        setHoldings([]);
      }
    };

    const refreshHoldings = () => {
      void loadHoldings();
    };

    void loadHoldings();
    window.addEventListener("holdings-changed", refreshHoldings);

    return () => {
      window.removeEventListener("holdings-changed", refreshHoldings);
    };
  }, [isDemoMode, portfolio, portfolioLoading, user]);

  useEffect(() => {
    // Restore from cache instantly — market data only changes per trading day
    const cached = loadMarketSummaryCache();
    if (shouldWaitForSyncedHoldings) return;

    if (
      cached?.marketComparison &&
      cached.holdingsHash === holdingsHash &&
      hasUsableMarketComparison(cached.marketComparison as MarketComparisonResponse)
    ) {
      setBenchmarks((cached.marketComparison.benchmarks as BenchmarkQuote[]) ?? []);
      setMarketComparison(cached.marketComparison as MarketComparisonResponse);
      setIsLoadingBenchmarks(false);
      return; // skip network fetch for today
    }

    const loadBenchmarks = async () => {
      setIsLoadingBenchmarks(true);
      const controller = new AbortController();
      const abortTimeoutId = window.setTimeout(() => controller.abort(), 8000);
      const loadingWatchdogId = window.setTimeout(() => setIsLoadingBenchmarks(false), 10000);

      try {
        const response = (await Promise.race([
          fetch(`${API_BASE_URL}/market/portfolio-vs-market`, {
            signal: controller.signal,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ holdings }),
          }),
          new Promise<Response>((_, reject) => {
            window.setTimeout(() => reject(new Error("Benchmark request timed out.")), 8500);
          }),
        ])) as Response;

        if (!response.ok) throw new Error("Failed to load market comparison.");

        const data = (await response.json()) as MarketComparisonResponse;
        if (!hasUsableMarketComparison(data)) {
          throw new Error("Market comparison returned no usable daily data.");
        }
        setBenchmarks(data.benchmarks ?? []);
        setMarketComparison(data);
        saveMarketSummaryCache({ holdingsHash, marketComparison: data });
      } catch {
        setBenchmarks((currentBenchmarks) => currentBenchmarks);
        setMarketComparison((currentComparison) => currentComparison);
      } finally {
        window.clearTimeout(abortTimeoutId);
        window.clearTimeout(loadingWatchdogId);
        setIsLoadingBenchmarks(false);
      }
    };

    void loadBenchmarks();
  }, [holdings, holdingsHash, shouldWaitForSyncedHoldings]);

  useEffect(() => {
    const cached = loadMarketSummaryCache();
    if (shouldWaitForSyncedHoldings) return;

    if (cached?.aiSummary && cached.holdingsHash === holdingsHash) {
      const cachedSummary = sanitizeAiSummary(cached.aiSummary);
      if (!cachedSummary) {
        setAiSummary(null);
      } else {
        setAiSummary(cachedSummary);
        return;
      }
    }

    if (cached?.marketComparison && cached.holdingsHash === holdingsHash) {
      return;
    }

    const loadAiSummary = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/market/ai-summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ holdings }),
        });
        if (!res.ok) throw new Error("ai-summary fetch failed");
        const data = (await res.json()) as AiSummaryResponse;
        const summary = data.summary ? sanitizeAiSummary(data.summary) : null;
        setAiSummary((currentSummary) => summary ?? currentSummary);
        if (summary) {
          saveMarketSummaryCache({ holdingsHash, aiSummary: summary });
        }
      } catch {
        setAiSummary((currentSummary) => currentSummary);
      }
    };
    void loadAiSummary();
  }, [holdings, holdingsHash, marketComparison, shouldWaitForSyncedHoldings]);

  const {
    rebalance: rebalanceData,
    risk: riskData,
    isLoadingRebalance: isLoadingRebalanceSummary,
    isLoadingRisk: isLoadingRiskSummary,
  } = useDashboardSummary(holdings, user?.id);

  useEffect(() => {
    // Return cached result immediately if holdings content hasn't changed.
    // This prevents re-fetching when a Supabase auth refresh on tab focus
    // produces a new `holdings` array reference with identical data.
    const cached = sectorBreakdownCache.get(holdingsHash);
    if (cached) {
      setSectorBreakdown(cached);
      setIsLoadingSectorBreakdown(false);
      return;
    }

    const loadSectorBreakdown = async () => {
      setIsLoadingSectorBreakdown(true);
      try {
        const res = await fetch(`${API_BASE_URL}/portfolio/sector-breakdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ holdings }),
        });
        if (!res.ok) throw new Error("sector-breakdown fetch failed");
        const data = (await res.json()) as SectorBreakdownResponse;
        if ((data.sectors ?? []).length > 0) {
          sectorBreakdownCache.set(holdingsHash, data.sectors ?? []);
          setSectorBreakdown(data.sectors ?? []);
          return;
        }
        throw new Error("sector-breakdown returned empty sectors");
      } catch {
        const fallback = buildSectorBreakdownFromHoldings(holdings);
        sectorBreakdownCache.set(holdingsHash, fallback);
        setSectorBreakdown(fallback);
      } finally {
        setIsLoadingSectorBreakdown(false);
      }
    };

    const refreshSectorBreakdown = () => { void loadSectorBreakdown(); };

    void loadSectorBreakdown();
    window.addEventListener("holdings-changed", refreshSectorBreakdown);

    return () => {
      window.removeEventListener("holdings-changed", refreshSectorBreakdown);
    };
  }, [holdings, holdingsHash]);


  const totalMarketValueCad = useMemo(
    () =>
      holdings.reduce(
        (sum, holding) =>
          sum +
          convertToCad(holding.market_value, holding.market_value_currency),
        0,
      ),
    [holdings],
  );

  const totalBookValueMarketCad = useMemo(
    () =>
      holdings.reduce(
        (sum, holding) =>
          sum +
          convertToCad(
            holding.book_value_market,
            holding.book_value_currency_market,
          ),
        0,
      ),
    [holdings],
  );

  const totalGainLossCad = useMemo(
    () => totalMarketValueCad - totalBookValueMarketCad,
    [totalBookValueMarketCad, totalMarketValueCad],
  );

  const performancePct = useMemo(() => {
    if (totalBookValueMarketCad <= 0) {
      return 0;
    }
    return (totalGainLossCad / totalBookValueMarketCad) * 100;
  }, [totalBookValueMarketCad, totalGainLossCad]);

  const weightedHoldings = useMemo<WeightedHolding[]>(() => {
    if (totalMarketValueCad <= 0) {
      return [];
    }

    return holdings
      .map((holding) => {
        const marketValueCad = convertToCad(
          holding.market_value,
          holding.market_value_currency,
        );
        return {
          ...holding,
          marketValueCad,
          weight: (marketValueCad / totalMarketValueCad) * 100,
        };
      })
      .sort((a, b) => b.marketValueCad - a.marketValueCad);
  }, [holdings, totalMarketValueCad]);

  const donutSegments = useMemo(() => {
    const visibleHoldings = weightedHoldings
      .slice(0, 7)
      .map((holding, index) => ({
        symbol: holding.symbol,
        weight: holding.weight,
        valueCad: holding.marketValueCad,
        color: DONUT_COLORS[index % DONUT_COLORS.length],
        holdingCount: 1,
      }));

    const otherHoldings = weightedHoldings.slice(7);
    const remainderWeight = otherHoldings.reduce((sum, h) => sum + h.weight, 0);

    if (remainderWeight > 0.01) {
      visibleHoldings.push({
        symbol: "OTHER",
        weight: remainderWeight,
        valueCad: otherHoldings.reduce((sum, h) => sum + h.marketValueCad, 0),
        color: OTHER_DONUT_COLOR,
        holdingCount: otherHoldings.length,
      });
    }

    return visibleHoldings;
  }, [weightedHoldings]);

  const hoveredSegment = useMemo(
    () =>
      hoveredChipSymbol
        ? (donutSegments.find((s) => s.symbol === hoveredChipSymbol) ?? null)
        : null,
    [hoveredChipSymbol, donutSegments],
  );

  // Enrich chart symbols — non-blocking, resolves from cache or background fetch
  const chartSymbols = useMemo(
    () => donutSegments.map((s) => s.symbol).filter((s) => s !== "OTHER"),
    [donutSegments],
  );
  const chartMeta = useTickerEnrichment(chartSymbols);

  const donutStrokeSegments = useMemo(() => {
    const radius = 35;
    const circumference = 2 * Math.PI * radius;
    const gap = donutSegments.length > 1 ? 1.2 : 0;
    let offset = 0;

    return donutSegments.map((segment) => {
      const startOffset = offset;
      const rawLength = (Math.max(segment.weight, 0) / 100) * circumference;
      const length = Math.max(0, rawLength - gap);
      const midpoint = (startOffset + rawLength / 2) / circumference;
      const angle = midpoint * 360 - 90;
      const radians = (angle * Math.PI) / 180;
      const labelX = 50 + Math.cos(radians) * 46;
      const labelY = 50 + Math.sin(radians) * 46;
      const stroke = {
        ...segment,
        dasharray: `${length} ${circumference - length}`,
        dashoffset: -offset,
        labelSide: labelX >= 50 ? "right" : "left",
        labelStyle: {
          left: `${labelX}%`,
          top: `${labelY}%`,
        },
      };
      offset += rawLength;
      return stroke;
    });
  }, [donutSegments]);

  const allocationBySector = useMemo(
    () => sectorBreakdown.slice(0, 6),
    [sectorBreakdown],
  );

  const portfolioDailyPercent =
    marketComparison?.portfolioDailyPercent ??
    getPortfolioDailyFromTickerData(
      marketComparison,
      weightedHoldings,
      totalMarketValueCad,
    );
  const marketDailyPercent = marketComparison?.marketDailyPercent ?? null;

  const portfolioDailyAmountCad = useMemo(() => {
    if (portfolioDailyPercent === null) {
      return null;
    }

    const dailyRate = portfolioDailyPercent / 100;
    if (dailyRate <= -0.999999) {
      return null;
    }

    const priorCloseCad = totalMarketValueCad / (1 + dailyRate);
    const dailyChangeCad = totalMarketValueCad - priorCloseCad;
    return Number.isFinite(dailyChangeCad) ? dailyChangeCad : null;
  }, [portfolioDailyPercent, totalMarketValueCad]);

  const formatPercent = (value: number | null) =>
    value === null ? "--" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

  const formatCompactCad = (value: number) =>
    new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      maximumFractionDigits: 0,
    }).format(value);

  const formatSignedCad = (value: number | null) => {
    if (value === null) {
      return "--";
    }
    return `${value >= 0 ? "+" : "-"}${formatCompactCad(Math.abs(value))}`;
  };

  const maskDollar = (displayValue: string) =>
    settings.hideDollarAmounts ? "..." : displayValue;

  const formatSpread = (value: number | null) => {
    if (value === null || portfolioDailyPercent === null) {
      return "--";
    }
    const spread = value - portfolioDailyPercent;
    return `${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`;
  };

  const getVsPortfolioClass = (spread: number | null) => {
    if (spread === null) {
      return "dashboard-comparison-muted";
    }

    return spread > 0 ? "dashboard-negative" : "dashboard-positive";
  };

  const marketVsPortfolioDelta =
    marketDailyPercent === null || portfolioDailyPercent === null
      ? null
      : marketDailyPercent - portfolioDailyPercent;

  const formattedMarketSummary = useMemo(
    () =>
      formatMarketSummary(
        aiSummary,
        marketComparison,
        weightedHoldings,
        totalMarketValueCad,
      ),
    [aiSummary, marketComparison, totalMarketValueCad, weightedHoldings],
  );

  const isMarketSummaryLoading =
    !marketComparison
      ? isLoadingBenchmarks || !marketComparison
      : portfolioDailyPercent === null || marketDailyPercent === null;

  const suggestionCards = useMemo(() => {
    const text = (
      rebalanceData?.summary ??
      (holdings.length > 0 ? getFallbackRebalanceSummary(holdings) : null) ??
      "Import holdings to get a rebalance suggestion based on your current weights."
    ).trim();
    return {
      summary: text,
      trim: rebalanceData?.trimSymbols ?? [],
      add: rebalanceData?.addSymbols ?? [],
    };
  }, [rebalanceData, holdings]);

  const compactRebalanceInsight = useMemo(() => {
    const overweights = stripTickerWeights(suggestionCards.trim).slice(0, 3);
    const underweights = stripTickerWeights(suggestionCards.add).slice(0, 3);

    if (overweights.length === 0 && underweights.length === 0) {
      return [
        "Portfolio weights are close to the current target range.",
        "Suggested rebalance keeps allocations broadly unchanged.",
      ];
    }

    return [
      `Overweight: ${formatSymbolList(overweights) || "None"}`,
      `Underweight: ${formatSymbolList(underweights) || "None"}`,
      "Suggested rebalance trims concentration and improves diversification.",
    ];
  }, [suggestionCards.add, suggestionCards.trim]);

  const fallbackActionRows = useMemo(
    () =>
      [
        ...suggestionCards.trim.map((symbol) => ({
          symbol,
          side: "sell" as const,
        })),
        ...suggestionCards.add.map((symbol) => ({
          symbol,
          side: "buy" as const,
        })),
      ].slice(0, MAX_CARD_ACTION_ROWS),
    [suggestionCards],
  );

  const riskSeverityCounts = useMemo(() => {
    if (riskData?.severityCounts) return riskData.severityCounts;
    if (holdings.length > 0) return getFallbackRiskAnalysis(holdings).severityCounts;
    return { high: 0, medium: 0, low: 0 };
  }, [riskData, holdings]);

  const riskScore = useMemo(
    () =>
      Math.min(
        100,
        riskSeverityCounts.high * 15 +
          riskSeverityCounts.medium * 5 +
          riskSeverityCounts.low * 2,
      ),
    [riskSeverityCounts],
  );

  const gaugeColor =
    riskScore >= 67 ? "#ef4444" : riskScore >= 34 ? "#f59e0b" : "#22c55e";
  const gaugeLabel =
    riskScore >= 76
      ? "High Risk"
      : riskScore >= 51
        ? "Elevated"
        : riskScore >= 26
          ? "Moderate"
          : "Low";

  const showEmptyOnboarding =
    !!user && !isDemoMode && !portfolioLoading && !hasHoldings;

  if (showEmptyOnboarding) {
    const previewCards = [
      {
        title: "Portfolio Overview",
        copy: "Import holdings to see market value, asset allocation, and performance.",
      },
      {
        title: "Rebalancing",
        copy: "Import holdings to generate target allocations and suggested trades.",
      },
      {
        title: "Risk Manager",
        copy: "Import holdings to detect concentration, volatility, and catalyst risks.",
      },
      {
        title: "Key Insights",
        copy: "Import holdings to uncover portfolio patterns and diversification gaps.",
      },
    ];

    return (
      <div className="dashboard-shell">
        <div className="dashboard-page">
          <DashboardNavbar />
          <main className="dashboard-main dashboard-empty-main">
            <section className="dashboard-empty-onboarding">
              <div className="dashboard-empty-copy">
                <span className="dashboard-empty-eyebrow">New portfolio</span>
                <h1>Start by importing your holdings</h1>
                <p>
                  Upload a portfolio CSV to generate your dashboard, risk scan,
                  rebalancing plan, and AI-assisted insights.
                </p>
                <div className="dashboard-empty-actions">
                  <Link className="dashboard-empty-primary" to="/holdings">
                    Upload holdings
                  </Link>
                  <button
                    className="dashboard-empty-secondary"
                    type="button"
                    onClick={() => void enableDemoMode()}
                  >
                    Try demo portfolio
                  </button>
                </div>
              </div>

              <div className="dashboard-empty-preview-grid">
                {previewCards.map((card) => (
                  <article className="dashboard-empty-preview-card" key={card.title}>
                    <FiLock size={15} />
                    <h2>{card.title}</h2>
                    <p>{card.copy}</p>
                  </article>
                ))}
              </div>
            </section>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-shell">
      <div className="dashboard-page">
        <DashboardNavbar />

        <main className="dashboard-main">
          <section className="dashboard-top-section">
            <div className="dashboard-left-column">
              <div className="dashboard-stats-grid">
                <div className="dashboard-stat-card dashboard-stat-card--blue">
                  <div className="dashboard-stat-label">Market value</div>
                  <div className="dashboard-stat-value dashboard-stat-value--strong">
                    {maskDollar(
                      `CA$${totalMarketValueCad.toLocaleString("en-CA", {
                        maximumFractionDigits: 0,
                      })}`,
                    )}
                  </div>
                  <div className="dashboard-stat-sub">as of today</div>
                </div>

                <div className="dashboard-stat-card dashboard-stat-card--neutral">
                  <div className="dashboard-stat-label">Book value</div>
                  <div className="dashboard-stat-value dashboard-stat-value--strong">
                    {maskDollar(
                      `CA$${totalBookValueMarketCad.toLocaleString("en-CA", {
                        maximumFractionDigits: 0,
                      })}`,
                    )}
                  </div>
                  <div className="dashboard-stat-sub">avg cost basis</div>
                </div>

                <div
                  className={`dashboard-stat-card ${totalGainLossCad >= 0 ? "dashboard-stat-card--positive" : "dashboard-stat-card--negative"}`}
                >
                  <div className="dashboard-stat-label">Unrealized P&amp;L</div>
                  <div
                    className={`dashboard-stat-value dashboard-stat-value--strong ${totalGainLossCad >= 0 ? "dashboard-positive" : "dashboard-negative"}`}
                  >
                    {maskDollar(
                      `${totalGainLossCad >= 0 ? "+" : ""}CA$${Math.abs(
                        totalGainLossCad,
                      ).toLocaleString("en-CA", {
                        maximumFractionDigits: 0,
                      })}`,
                    )}
                  </div>
                  <div className="dashboard-stat-sub">
                    {performancePct >= 0 ? "+" : ""}
                    {performancePct.toFixed(2)}% total
                  </div>
                </div>

                <div className="dashboard-stat-card dashboard-stat-card--purple">
                  <div className="dashboard-stat-label">Open positions</div>
                  <div className="dashboard-stat-value dashboard-stat-value--strong">
                    {holdings.length}
                  </div>
                  <div className="dashboard-stat-sub">
                    {sectorBreakdown.length} sectors
                  </div>
                </div>
              </div>

              <section className="dashboard-cards-grid dashboard-cards-grid-inline">
                <div className="dashboard-card">
                  <div className="dashboard-card-header-row">
                    <div className="dashboard-card-title-row">
                      <FiBarChart2 size={30} />
                      <span>Today's Market Summary</span>
                    </div>
                  </div>

                  <div className="dashboard-card-content dashboard-market-content">
                    <div className="dashboard-ai-summary">
                      {isMarketSummaryLoading ? (
                        <div className="dashboard-ai-summary-loading">
                          <span className="dashboard-ai-summary-dot" />
                          <span className="dashboard-ai-summary-dot" />
                          <span className="dashboard-ai-summary-dot" />
                          <span>Preparing market summary...</span>
                        </div>
                      ) : (
                        <div>
                          <p className="dashboard-ai-summary-title">
                            {formattedMarketSummary.headline}
                          </p>
                          <p className="dashboard-market-date">
                            {formattedMarketSummary.date}
                          </p>
                          <div className="dashboard-market-insight-lines">
                            {formattedMarketSummary.body.map((line) => (
                              <p
                                className="dashboard-ai-summary-text"
                                key={line}
                              >
                                {line}
                              </p>
                            ))}
                          </div>
                          {formattedMarketSummary.contributors.length > 0 && (
                            <div className="dashboard-market-drivers">
                              <span className="dashboard-market-drivers-label">
                                Top contributors
                              </span>
                              <div className="dashboard-market-driver-chips">
                                {formattedMarketSummary.contributors.map(
                                  (driver) => {
                                    const impact =
                                      formatMarketDriverImpact(driver);
                                    const chipTone =
                                      driver.contributionPercent < 0
                                        ? "dashboard-market-driver-chip-negative"
                                        : "dashboard-market-driver-chip-positive";
                                    return (
                                    <span
                                      className={`dashboard-market-driver-chip ${chipTone}`}
                                      key={driver.symbol}
                                    >
                                      <span>{driver.symbol}</span>
                                      {impact && <strong>{impact}</strong>}
                                    </span>
                                    );
                                  },
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="dashboard-comparison-table">
                      <div className="dashboard-comparison-head">
                        <span>Asset</span>
                        <span>Daily</span>
                        <span>vs Portfolio</span>
                      </div>

                      {isMarketSummaryLoading ? (
                        <div className="dashboard-comparison-row dashboard-comparison-row-loading">
                          <span>Loading portfolio and benchmark comparison...</span>
                        </div>
                      ) : benchmarks.length === 0 ? (
                        <div className="dashboard-comparison-row dashboard-comparison-row-loading">
                          <span>Benchmark data unavailable right now.</span>
                        </div>
                      ) : (
                        <>
                          <div className="dashboard-comparison-row dashboard-comparison-row-portfolio">
                            <span>Portfolio</span>
                            <span className="dashboard-positive">
                              {formatPercent(portfolioDailyPercent)}
                            </span>
                            <span className="dashboard-comparison-muted">Base</span>
                          </div>

                          <div className="dashboard-comparison-row">
                            <span>Benchmark average</span>
                            <span
                              className={
                                marketDailyPercent! >= 0
                                  ? "dashboard-positive"
                                  : "dashboard-negative"
                              }
                            >
                              {formatPercent(marketDailyPercent)}
                            </span>
                            <span
                              className={getVsPortfolioClass(
                                marketVsPortfolioDelta,
                              )}
                            >
                              {formatSpread(marketDailyPercent)}
                            </span>
                          </div>

                          {benchmarks.map((item) => {
                            const spread =
                              item.changePercent === null
                                ? null
                                : item.changePercent - portfolioDailyPercent!;

                            return (
                              <div
                                className="dashboard-comparison-row"
                                key={item.symbol}
                              >
                                <span>{item.symbol}</span>
                                <span
                                  className={
                                    item.changePercent === null
                                      ? "dashboard-comparison-muted"
                                      : item.changePercent >= 0
                                        ? "dashboard-positive"
                                        : "dashboard-negative"
                                  }
                                >
                                  {formatPercent(item.changePercent)}
                                </span>
                                <span className={getVsPortfolioClass(spread)}>
                                  {spread === null
                                    ? "--"
                                    : `${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`}
                                </span>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="dashboard-card dashboard-structured-card">
                  <div className="dashboard-card-header-row dashboard-structured-card-header">
                    <div className="dashboard-card-title-row">
                      <HiOutlineLightBulb size={31} />
                      <span>AI Rebalance Assistant</span>
                    </div>
                  </div>

                  <div className="dashboard-card-content dashboard-structured-card-content">
                    {isLoadingRebalanceSummary ? (
                      <div className="dashboard-ai-summary-loading">
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                      </div>
                    ) : (
                      <>
                        <div className="dashboard-card-summary-block">
                          <div className="dashboard-suggestion-insights">
                            {compactRebalanceInsight.map((line) => (
                              <p
                                className="dashboard-suggestion-text"
                                key={line}
                              >
                                {line}
                              </p>
                            ))}
                          </div>
                        </div>

                        <div
                          className="dashboard-card-middle-block"
                          aria-hidden="true"
                        />

                        <div className="dashboard-card-table-section dashboard-action-list">
                          {(rebalanceData?.topTrades ?? []).length > 0 ? (
                            <>
                              <span className="dashboard-action-label">
                                Top Actions
                              </span>
                              {(rebalanceData?.topTrades ?? [])
                                .slice(0, MAX_CARD_ACTION_ROWS)
                                .map((trade) => (
                                  <div
                                    className={`dashboard-action-row ${
                                      trade.action === "sell"
                                        ? "dashboard-action-sell"
                                        : "dashboard-action-buy"
                                    }`}
                                    key={`${trade.action}-${trade.symbol}`}
                                  >
                                    <span className="dashboard-action-badge">
                                      {trade.action === "sell" ? "Sell" : "Buy"}
                                    </span>
                                    <span className="dashboard-action-symbol">
                                      {trade.symbol}
                                    </span>
                                    <span className="dashboard-action-value">
                                      {maskDollar(
                                        formatCompactCad(trade.tradeCad),
                                      )}
                                    </span>
                                  </div>
                                ))}
                              <Link
                                className="dashboard-inline-link"
                                to="/re-weight"
                              >
                                View all {rebalanceData?.tradeCount ?? 0} suggested trades →
                              </Link>
                            </>
                          ) : fallbackActionRows.length > 0 ? (
                            <>
                              <span className="dashboard-action-label">
                                Top Actions
                              </span>
                              {fallbackActionRows.map((row) => (
                                <div
                                  className={`dashboard-action-row ${
                                    row.side === "sell"
                                      ? "dashboard-action-sell"
                                      : "dashboard-action-buy"
                                  }`}
                                  key={`${row.side}-${row.symbol}`}
                                >
                                  <span className="dashboard-action-badge">
                                    {row.side === "sell" ? "Sell" : "Buy"}
                                  </span>
                                  <span className="dashboard-action-symbol">
                                    {row.symbol}
                                  </span>
                                </div>
                              ))}
                              <Link
                                className="dashboard-inline-link"
                                to="/re-weight"
                              >
                                View full rebalance plan →
                              </Link>
                            </>
                          ) : null}
                        </div>

                        <div className="dashboard-plan-snapshot">
                          <span className="dashboard-bottom-label">
                            Plan Snapshot
                          </span>
                          <div className="dashboard-plan-snapshot-grid">
                            <div className="dashboard-plan-snapshot-item">
                              <span className="dashboard-plan-snapshot-value dashboard-positive">
                                {maskDollar(formatCompactCad(rebalanceData?.totalBuyCad ?? 0))}
                              </span>
                              <span className="dashboard-plan-snapshot-key">
                                Buys
                              </span>
                            </div>
                            <div className="dashboard-plan-snapshot-item">
                              <span className="dashboard-plan-snapshot-value dashboard-negative">
                                {maskDollar(
                                  formatCompactCad(rebalanceData?.totalSellCad ?? 0),
                                )}
                              </span>
                              <span className="dashboard-plan-snapshot-key">
                                Sells
                              </span>
                            </div>
                            <div className="dashboard-plan-snapshot-item">
                              <span className="dashboard-plan-snapshot-value">
                                {maskDollar(
                                  formatCompactCad(
                                    Math.abs(
                                      (rebalanceData?.totalBuyCad ?? 0) - (rebalanceData?.totalSellCad ?? 0),
                                    ),
                                  ),
                                )}
                              </span>
                              <span className="dashboard-plan-snapshot-key">
                                Net drift
                              </span>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="dashboard-card dashboard-risk-card dashboard-structured-card">
                  <div className="dashboard-card-header-row dashboard-structured-card-header">
                    <div className="dashboard-card-title-row">
                      <FiAlertCircle size={31} />
                      <span>Risk Alert</span>
                    </div>
                  </div>

                  <div className="dashboard-card-content dashboard-structured-card-content">
                    {isLoadingRiskSummary ? (
                      <div className="dashboard-ai-summary-loading">
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                      </div>
                    ) : (
                      <>
                        <div className="dashboard-card-summary-block">
                          <p className="dashboard-risk-summary">
                            {riskData?.summary ??
                              "Import holdings to scan for concentration, volatility, market-cap, and catalyst risks."}
                          </p>
                        </div>

                        <div className="dashboard-card-middle-block dashboard-risk-middle-block">
                          <div className="dashboard-gauge-wrap">
                            <span
                              className="dashboard-gauge-status-label"
                              style={{ color: gaugeColor }}
                            >
                              {gaugeLabel}
                            </span>
                            <div
                              className="dashboard-risk-score"
                              aria-label={`Risk score ${riskScore} out of 100`}
                            >
                              <span
                                className="dashboard-risk-score-value"
                                style={{ color: gaugeColor }}
                              >
                                {riskScore}
                              </span>
                              <span className="dashboard-risk-score-denom">
                                /100
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="dashboard-card-table-section dashboard-risk-flags">
                          {(riskData?.concerns ?? []).length > 0 ? (
                            <>
                              <span className="dashboard-action-label">
                                Top Alerts
                              </span>
                              {(riskData?.concerns ?? []).map((concern, i) => (
                                <div
                                  className={`dashboard-risk-flag dashboard-risk-flag-${concern.severity}`}
                                  key={`${concern.symbol ?? ""}-${i}`}
                                >
                                  <span className="dashboard-risk-flag-dot" />
                                  <span className="dashboard-risk-flag-text">
                                    {concern.symbol && (
                                      <strong>{concern.symbol} </strong>
                                    )}
                                    {concern.title ??
                                      concern.category ??
                                      "Risk signal"}
                                  </span>
                                </div>
                              ))}
                              {(riskData?.concernTotal ?? 0) > (riskData?.concerns ?? []).length && (
                                <Link
                                  className="dashboard-inline-link"
                                  to="/risk-manager"
                                >
                                  Review all {riskData?.concernTotal ?? 0} risks →
                                </Link>
                              )}
                            </>
                          ) : null}
                        </div>

                        <div className="dashboard-severity-mix">
                          <div className="dashboard-severity-inline">
                            <span>
                              <strong style={{ color: "#ef4444" }}>
                                {riskSeverityCounts.high}
                              </strong>{" "}
                              High
                            </span>
                            <span className="dashboard-severity-sep">|</span>
                            <span>
                              <strong style={{ color: "#f59e0b" }}>
                                {riskSeverityCounts.medium}
                              </strong>{" "}
                              Medium
                            </span>
                            <span className="dashboard-severity-sep">|</span>
                            <span>
                              <strong>{riskSeverityCounts.low}</strong> Watch
                            </span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <div className="dashboard-right-column">
              <DashboardOnboardingBanner />

              <div className="dashboard-donut-wrap">
                <div className="dashboard-donut-stage">
                  <div className="dashboard-donut-panel">
                    <div className={`dashboard-donut-chart${donutAppeared ? "" : " dashboard-donut-chart--appearing"}`}>
                      <svg
                        className="dashboard-donut-svg"
                        viewBox="0 0 100 100"
                        role="img"
                        aria-label="Portfolio allocation by holding"
                      >
                        <circle
                          className="dashboard-donut-track"
                          cx="50"
                          cy="50"
                          r="35"
                        />
                        {donutStrokeSegments.map((segment) => (
                          <circle
                            className="dashboard-donut-slice"
                            cx="50"
                            cy="50"
                            r="35"
                            key={segment.symbol}
                            stroke={segment.color}
                            strokeDasharray={segment.dasharray}
                            strokeDashoffset={segment.dashoffset}
                          />
                        ))}
                      </svg>
                      <div className="dashboard-donut-core">
                        {donutSegments.length === 0 ? (
                          <div className="dashboard-donut-empty">
                            No allocation yet
                          </div>
                        ) : hoveredSegment ? (
                          <div className="dashboard-donut-center">
                            <span className="dashboard-donut-center-label">
                              {hoveredSegment.symbol}
                            </span>
                            {chartMeta[hoveredSegment.symbol]?.name && (
                              <span className="dashboard-donut-center-name">
                                {chartMeta[hoveredSegment.symbol].name}
                              </span>
                            )}
                            <span
                              className="dashboard-donut-center-value"
                              style={{ fontSize: "clamp(16px, 2.8vw, 26px)" }}
                            >
                              {maskDollar(
                                formatCompactCad(hoveredSegment.valueCad),
                              )}
                            </span>
                            <span
                              className="dashboard-donut-center-change"
                              style={{ color: "#a2a3a7" }}
                            >
                              {hoveredSegment.weight.toFixed(1)}% of portfolio
                            </span>
                            {hoveredSegment.holdingCount > 1 && (
                              <span className="dashboard-donut-center-period">
                                {hoveredSegment.holdingCount} positions
                              </span>
                            )}
                          </div>
                        ) : (
                          <div className="dashboard-donut-center">
                            <span className="dashboard-donut-center-label">
                              Portfolio
                            </span>
                            <span className="dashboard-donut-center-value">
                              {maskDollar(
                                formatCompactCad(totalMarketValueCad),
                              )}
                            </span>
                            <span
                              className={
                                portfolioDailyPercent === null
                                  ? "dashboard-donut-center-change dashboard-comparison-muted"
                                  : portfolioDailyPercent >= 0
                                    ? "dashboard-donut-center-change dashboard-positive"
                                    : "dashboard-donut-center-change dashboard-negative"
                              }
                            >
                              {portfolioDailyAmountCad === null
                                ? "--"
                                : `${maskDollar(formatSignedCad(portfolioDailyAmountCad))} (${formatPercent(portfolioDailyPercent)})`}
                            </span>
                            <span className="dashboard-donut-center-period">
                              Today
                            </span>
                          </div>
                        )}
                      </div>
                      {donutStrokeSegments.map((segment) => {
                        const meta = chartMeta[segment.symbol];
                        const tooltip = meta?.name
                          ? `${segment.symbol} — ${meta.name}\n${segment.weight.toFixed(1)}% · ${formatCompactCad(segment.valueCad)}`
                          : `${segment.symbol}\n${segment.weight.toFixed(1)}% · ${formatCompactCad(segment.valueCad)}`;
                        return (
                          <button
                            className={`dashboard-donut-chip dashboard-donut-chip-${segment.labelSide}`}
                            key={`${segment.symbol}-chip`}
                            style={segment.labelStyle}
                            type="button"
                            title={tooltip}
                            onMouseEnter={() =>
                              setHoveredChipSymbol(segment.symbol)
                            }
                            onMouseLeave={() => setHoveredChipSymbol(null)}
                          >
                            <TickerLogoBadge
                              symbol={segment.symbol}
                              color={segment.color}
                              className="dashboard-donut-chip-icon"
                            />
                            <span className="dashboard-donut-chip-weight">
                              {Math.round(segment.weight)}%
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="dashboard-allocation-card">
                <h4 className="dashboard-allocation-title">Sector Breakdown</h4>
                {isLoadingSectorBreakdown ? (
                  <div className="dashboard-allocation-empty">
                    Loading sector data...
                  </div>
                ) : allocationBySector.length === 0 ? (
                  <div className="dashboard-allocation-empty">
                    Upload holdings to see portfolio sector allocation.
                  </div>
                ) : (
                  <div className="dashboard-allocation-list">
                    {allocationBySector.map((entry) => (
                      <div
                        className="dashboard-allocation-row"
                        key={entry.sector}
                        style={{
                          background: `linear-gradient(to right, rgba(124,111,205,0.15) ${entry.weight}%, #f7f7fb ${entry.weight}%)`,
                        }}
                      >
                        <span>{entry.sector}</span>
                        <span className="dashboard-allocation-row-right">
                          <span className="dashboard-allocation-cad">
                            {maskDollar(formatCompactCad(entry.valueCad))}
                          </span>
                          <span className="dashboard-allocation-pct">
                            {entry.weight.toFixed(1)}%
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
          <DataStatusPanel />
        </main>
      </div>
    </div>
  );
}

export default Dashboard;
