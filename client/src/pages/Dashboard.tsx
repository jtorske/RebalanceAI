import { FiAlertCircle, FiBarChart2 } from "react-icons/fi";
import { HiOutlineLightBulb } from "react-icons/hi";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar";
import "./Dashboard.css";
import { API_BASE_URL } from "../lib/constants";
import { DONUT_COLORS, OTHER_DONUT_COLOR } from "../lib/dashboardUtils";
import { convertToCad } from "../lib/holdingsUtils";
import { useUserSettings } from "../lib/userSettings";
import type {
  ImportedHolding,
  HoldingsResponse,
  BenchmarkQuote,
  MarketComparisonResponse,
  WeightedHolding,
} from "../lib/types";

type AiSummaryResponse = {
  summary: string | null;
};

type RebalanceAiSummaryResponse = {
  summary: string | null;
  trimSymbols?: string[];
  addSymbols?: string[];
  overweights?: Array<{ symbol: string }>;
  underweights?: Array<{ symbol: string }>;
  totalBuyCad?: number;
  totalSellCad?: number;
  topTrades?: Array<{
    symbol: string;
    action: "buy" | "sell" | "hold";
    tradeCad: number;
  }>;
  tradeCount?: number;
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

type RiskConcernItem = {
  severity: "high" | "medium" | "low";
  title?: string;
  symbol?: string;
  category?: string;
};

type RiskAnalysisResponse = {
  dashboardSummary: string | null;
  concerns: RiskConcernItem[];
};

const MAX_CARD_ACTION_ROWS = 5;

const repairTextEncoding = (value: string) =>
  value
    .replaceAll("\u00e2\u0080\u0099", "'")
    .replaceAll("\u00e2\u0080\u0098", "'")
    .replaceAll("\u00e2\u0080\u009c", '"')
    .replaceAll("\u00e2\u0080\u009d", '"')
    .replaceAll("\u00e2\u0080\u0093", "-")
    .replaceAll("\u00e2\u0080\u0094", "-");

const stripLlmPreamble = (text: string): string =>
  text
    .replace(
      /^here (?:are|is) (?:two|2|some|a few) (?:concise )?sentences?[^:]*:\s*/i,
      "",
    )
    .replace(/^sure[,!]?\s+here (?:are|is)[^:]*:\s*/i, "")
    .trim();

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
  const [holdings, setHoldings] = useState<ImportedHolding[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkQuote[]>([]);
  const [isLoadingBenchmarks, setIsLoadingBenchmarks] = useState(true);
  const [marketComparison, setMarketComparison] =
    useState<MarketComparisonResponse | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [isLoadingAiSummary, setIsLoadingAiSummary] = useState(true);
  const [rebalanceSummary, setRebalanceSummary] = useState<string | null>(null);
  const [trimSymbols, setTrimSymbols] = useState<string[]>([]);
  const [addSymbols, setAddSymbols] = useState<string[]>([]);
  const [isLoadingRebalanceSummary, setIsLoadingRebalanceSummary] =
    useState(true);
  const [sectorBreakdown, setSectorBreakdown] = useState<
    SectorBreakdownEntry[]
  >([]);
  const [isLoadingSectorBreakdown, setIsLoadingSectorBreakdown] =
    useState(true);
  const [totalBuyCad, setTotalBuyCad] = useState<number | null>(null);
  const [totalSellCad, setTotalSellCad] = useState<number | null>(null);
  const [topTrades, setTopTrades] = useState<
    Array<{ symbol: string; action: "buy" | "sell" | "hold"; tradeCad: number }>
  >([]);
  const [tradeCount, setTradeCount] = useState(0);
  const [riskSummary, setRiskSummary] = useState<string | null>(null);
  const [riskConcerns, setRiskConcerns] = useState<RiskConcernItem[]>([]);
  const [riskConcernTotal, setRiskConcernTotal] = useState(0);
  const [riskSeverityCounts, setRiskSeverityCounts] = useState({
    high: 0,
    medium: 0,
    low: 0,
  });
  const [isLoadingRiskSummary, setIsLoadingRiskSummary] = useState(true);
  const [hoveredChipSymbol, setHoveredChipSymbol] = useState<string | null>(
    null,
  );

  useEffect(() => {
    const loadHoldings = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/holdings`);
        if (!response.ok) {
          throw new Error("Failed to load holdings from backend.");
        }

        const data = (await response.json()) as HoldingsResponse;
        setHoldings(data.holdings ?? []);
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
  }, []);

  useEffect(() => {
    const loadBenchmarks = async () => {
      setIsLoadingBenchmarks(true);
      const controller = new AbortController();
      const abortTimeoutId = window.setTimeout(() => {
        controller.abort();
      }, 8000);
      const loadingWatchdogId = window.setTimeout(() => {
        setIsLoadingBenchmarks(false);
      }, 10000);

      try {
        const response = (await Promise.race([
          fetch(`${API_BASE_URL}/market/portfolio-vs-market`, {
            signal: controller.signal,
          }),
          new Promise<Response>((_, reject) => {
            window.setTimeout(() => {
              reject(new Error("Benchmark request timed out."));
            }, 8500);
          }),
        ])) as Response;

        if (!response.ok) {
          throw new Error("Failed to load market comparison.");
        }

        const data = (await response.json()) as MarketComparisonResponse;
        setBenchmarks(data.benchmarks ?? []);
        setMarketComparison(data);
      } catch {
        setBenchmarks([]);
        setMarketComparison(null);
      } finally {
        window.clearTimeout(abortTimeoutId);
        window.clearTimeout(loadingWatchdogId);
        setIsLoadingBenchmarks(false);
      }
    };

    const refreshMarketComparison = () => {
      void loadBenchmarks();
    };

    void loadBenchmarks();
    window.addEventListener("holdings-changed", refreshMarketComparison);

    return () => {
      window.removeEventListener("holdings-changed", refreshMarketComparison);
    };
  }, []);

  useEffect(() => {
    const loadAiSummary = async () => {
      setIsLoadingAiSummary(true);
      try {
        const res = await fetch(`${API_BASE_URL}/market/ai-summary`);
        if (!res.ok) throw new Error("ai-summary fetch failed");
        const data = (await res.json()) as AiSummaryResponse;
        setAiSummary(data.summary ? repairTextEncoding(data.summary) : null);
      } catch {
        setAiSummary(null);
      } finally {
        setIsLoadingAiSummary(false);
      }
    };
    void loadAiSummary();
  }, []);

  useEffect(() => {
    const loadRebalanceSummary = async () => {
      setIsLoadingRebalanceSummary(true);
      try {
        const res = await fetch(`${API_BASE_URL}/reweight/ai-summary`);
        if (!res.ok) throw new Error("rebalance ai-summary fetch failed");
        const data = (await res.json()) as RebalanceAiSummaryResponse;
        setRebalanceSummary(
          data.summary ? repairTextEncoding(data.summary) : null,
        );
        setTrimSymbols(
          data.trimSymbols ??
            (data.overweights ?? []).map((o) => o.symbol).slice(0, 3),
        );
        setAddSymbols(
          data.addSymbols ??
            (data.underweights ?? []).map((u) => u.symbol).slice(0, 3),
        );
        setTotalBuyCad(data.totalBuyCad ?? null);
        setTotalSellCad(data.totalSellCad ?? null);
        setTopTrades(data.topTrades ?? []);
        setTradeCount(data.tradeCount ?? 0);
      } catch {
        setTopTrades([]);
        setTradeCount(0);
        try {
          const holdingsRes = await fetch(`${API_BASE_URL}/holdings`);
          if (!holdingsRes.ok) {
            throw new Error("holdings fetch failed");
          }
          const holdingsData = (await holdingsRes.json()) as HoldingsResponse;
          setRebalanceSummary(
            getFallbackRebalanceSummary(holdingsData.holdings ?? []),
          );
        } catch {
          setRebalanceSummary(null);
        }
      } finally {
        setIsLoadingRebalanceSummary(false);
      }
    };

    const refreshRebalanceSummary = () => {
      void loadRebalanceSummary();
    };

    void loadRebalanceSummary();
    window.addEventListener("holdings-changed", refreshRebalanceSummary);

    return () => {
      window.removeEventListener("holdings-changed", refreshRebalanceSummary);
    };
  }, []);

  useEffect(() => {
    const loadSectorBreakdown = async () => {
      setIsLoadingSectorBreakdown(true);
      try {
        const res = await fetch(`${API_BASE_URL}/portfolio/sector-breakdown`);
        if (!res.ok) throw new Error("sector-breakdown fetch failed");
        const data = (await res.json()) as SectorBreakdownResponse;
        if ((data.sectors ?? []).length > 0) {
          setSectorBreakdown(data.sectors ?? []);
          return;
        }

        throw new Error("sector-breakdown returned empty sectors");
      } catch {
        try {
          const holdingsRes = await fetch(`${API_BASE_URL}/holdings`);
          if (!holdingsRes.ok) {
            throw new Error("holdings fetch failed");
          }

          const holdingsData = (await holdingsRes.json()) as HoldingsResponse;
          const holdingsList = holdingsData.holdings ?? [];
          const fallbackBreakdown =
            buildSectorBreakdownFromHoldings(holdingsList);
          setSectorBreakdown(fallbackBreakdown);
        } catch {
          setSectorBreakdown([]);
        }
      } finally {
        setIsLoadingSectorBreakdown(false);
      }
    };

    const refreshSectorBreakdown = () => {
      void loadSectorBreakdown();
    };

    void loadSectorBreakdown();
    window.addEventListener("holdings-changed", refreshSectorBreakdown);

    return () => {
      window.removeEventListener("holdings-changed", refreshSectorBreakdown);
    };
  }, []);

  useEffect(() => {
    const loadRiskSummary = async () => {
      setIsLoadingRiskSummary(true);
      try {
        const res = await fetch(`${API_BASE_URL}/risk/analysis`);
        if (!res.ok) throw new Error("risk analysis fetch failed");
        const data = (await res.json()) as RiskAnalysisResponse;
        setRiskSummary(
          data.dashboardSummary
            ? stripLlmPreamble(repairTextEncoding(data.dashboardSummary))
            : null,
        );
        const allConcerns = data.concerns ?? [];
        setRiskConcerns(allConcerns.slice(0, 5));
        setRiskConcernTotal(allConcerns.length);
        setRiskSeverityCounts({
          high: allConcerns.filter((c) => c.severity === "high").length,
          medium: allConcerns.filter((c) => c.severity === "medium").length,
          low: allConcerns.filter((c) => c.severity === "low").length,
        });
      } catch {
        try {
          const holdingsRes = await fetch(`${API_BASE_URL}/holdings`);
          if (!holdingsRes.ok) {
            throw new Error("holdings fetch failed");
          }
          const holdingsData = (await holdingsRes.json()) as HoldingsResponse;
          const fallback = getFallbackRiskAnalysis(holdingsData.holdings ?? []);
          setRiskSummary(fallback.summary);
          setRiskConcernTotal(0);
          setRiskSeverityCounts(fallback.severityCounts);
        } catch {
          setRiskSummary(null);
          setRiskConcernTotal(0);
          setRiskSeverityCounts({ high: 0, medium: 0, low: 0 });
        }
      } finally {
        setIsLoadingRiskSummary(false);
      }
    };

    const refreshRiskSummary = () => {
      void loadRiskSummary();
    };

    void loadRiskSummary();
    window.addEventListener("holdings-changed", refreshRiskSummary);

    return () => {
      window.removeEventListener("holdings-changed", refreshRiskSummary);
    };
  }, []);

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

  const donutStrokeSegments = useMemo(() => {
    const radius = 35;
    const circumference = 2 * Math.PI * radius;
    const gap = donutSegments.length > 1 ? 1.8 : 0;
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

  const portfolioDailyPercent = marketComparison?.portfolioDailyPercent ?? null;
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
    const arrow = spread >= 0 ? "▲" : "▼";
    return `${arrow} ${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`;
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

  const welcomeName = settings.displayName.trim() || "Investor";

  const suggestionCards = useMemo(() => {
    const fallbackSummary =
      "Import holdings to get a rebalance suggestion based on your current weights.";
    const text = (rebalanceSummary ?? fallbackSummary).trim();
    return { summary: text, trim: trimSymbols, add: addSymbols };
  }, [rebalanceSummary, trimSymbols, addSymbols]);

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
                    {(isLoadingAiSummary || aiSummary) && (
                      <div className="dashboard-ai-summary">
                        {isLoadingAiSummary ? (
                          <div className="dashboard-ai-summary-loading">
                            <span className="dashboard-ai-summary-dot" />
                            <span className="dashboard-ai-summary-dot" />
                            <span className="dashboard-ai-summary-dot" />
                          </div>
                        ) : (
                          <div>
                            <p className="dashboard-ai-summary-title">
                              Welcome back {welcomeName}
                            </p>
                            {(() => {
                              const parts = (aiSummary ?? "").split(
                                "Portfolio drivers:",
                              );
                              const market = parts[0].trim();
                              const drivers = parts[1]?.trim() ?? null;
                              return (
                                <>
                                  {market && (
                                    <p className="dashboard-ai-summary-text">
                                      {market}
                                    </p>
                                  )}
                                  {drivers && (
                                    <div className="dashboard-ai-drivers">
                                      <span className="dashboard-ai-drivers-label">
                                        Portfolio drivers
                                      </span>
                                      <p className="dashboard-ai-summary-text">
                                        {drivers}
                                      </p>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="dashboard-comparison-table">
                      <div className="dashboard-comparison-head">
                        <span>Asset</span>
                        <span>Daily</span>
                        <span>Vs portfolio</span>
                      </div>

                      <div className="dashboard-comparison-row dashboard-comparison-row-portfolio">
                        <span>Portfolio</span>
                        <span
                          className={
                            portfolioDailyPercent === null
                              ? "dashboard-comparison-muted"
                              : "dashboard-positive"
                          }
                        >
                          {formatPercent(portfolioDailyPercent)}
                        </span>
                        <span className="dashboard-comparison-muted">Base</span>
                      </div>

                      <div className="dashboard-comparison-row">
                        <span>Benchmark average</span>
                        <span
                          className={
                            marketDailyPercent === null
                              ? "dashboard-comparison-muted"
                              : marketDailyPercent >= 0
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

                      {isLoadingBenchmarks ? (
                        <div className="dashboard-comparison-row dashboard-comparison-row-loading">
                          <span>Loading benchmark daily changes...</span>
                        </div>
                      ) : benchmarks.length === 0 ? (
                        <div className="dashboard-comparison-row dashboard-comparison-row-loading">
                          <span>Benchmark data unavailable right now.</span>
                        </div>
                      ) : (
                        benchmarks.map((item) => {
                          const spread =
                            item.changePercent === null ||
                            portfolioDailyPercent === null
                              ? null
                              : item.changePercent - portfolioDailyPercent;

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
                                  : `${spread >= 0 ? "▲" : "▼"} ${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                <div className="dashboard-card dashboard-structured-card">
                  <div className="dashboard-card-header-row dashboard-structured-card-header">
                    <div className="dashboard-card-title-row">
                      <HiOutlineLightBulb size={31} />
                      <span>Suggested Rebalance</span>
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
                          <p className="dashboard-suggestion-text">
                            {suggestionCards.summary}
                          </p>
                        </div>

                        <div
                          className="dashboard-card-middle-block"
                          aria-hidden="true"
                        />

                        <div className="dashboard-card-table-section dashboard-action-list">
                          {topTrades.length > 0 ? (
                            <>
                              <span className="dashboard-action-label">
                                Top Actions
                              </span>
                              {topTrades
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
                                View all {tradeCount} suggested trades →
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
                                {maskDollar(formatCompactCad(totalBuyCad ?? 0))}
                              </span>
                              <span className="dashboard-plan-snapshot-key">
                                Buys
                              </span>
                            </div>
                            <div className="dashboard-plan-snapshot-item">
                              <span className="dashboard-plan-snapshot-value dashboard-negative">
                                {maskDollar(
                                  formatCompactCad(totalSellCad ?? 0),
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
                                      (totalBuyCad ?? 0) - (totalSellCad ?? 0),
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
                            {riskSummary ??
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
                          {riskConcerns.length > 0 ? (
                            <>
                              <span className="dashboard-action-label">
                                Top Alerts
                              </span>
                              {riskConcerns.map((concern, i) => (
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
                              {riskConcernTotal > riskConcerns.length && (
                                <Link
                                  className="dashboard-inline-link"
                                  to="/risk-manager"
                                >
                                  View all {riskConcernTotal} items →
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
              <div className="dashboard-donut-wrap">
                <div className="dashboard-donut-stage">
                  <div className="dashboard-donut-panel">
                    <div className="dashboard-donut-chart">
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
                            key={`${segment.symbol}-${segment.weight.toString()}`}
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
                        return (
                          <button
                            className={`dashboard-donut-chip dashboard-donut-chip-${segment.labelSide}`}
                            key={`${segment.symbol}-${segment.weight.toString()}-chip`}
                            style={segment.labelStyle}
                            type="button"
                            onMouseEnter={() =>
                              setHoveredChipSymbol(segment.symbol)
                            }
                            onMouseLeave={() => setHoveredChipSymbol(null)}
                          >
                            <span
                              className="dashboard-donut-chip-icon"
                              style={{ backgroundColor: segment.color }}
                            >
                              {segment.symbol}
                            </span>
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
        </main>
      </div>
    </div>
  );
}

export default Dashboard;
