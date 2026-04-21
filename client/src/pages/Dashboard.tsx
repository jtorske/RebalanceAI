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
  totalBuyCad?: number;
  totalSellCad?: number;
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

type RiskAnalysisResponse = {
  dashboardSummary: string | null;
  concerns: Array<{
    severity: "high" | "medium" | "low";
  }>;
};

const repairTextEncoding = (value: string) =>
  value
    .replaceAll("\u00e2\u0080\u0099", "'")
    .replaceAll("\u00e2\u0080\u0098", "'")
    .replaceAll("\u00e2\u0080\u009c", '"')
    .replaceAll("\u00e2\u0080\u009d", '"')
    .replaceAll("\u00e2\u0080\u0093", "-")
    .replaceAll("\u00e2\u0080\u0094", "-");

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
): { summary: string; concerns: number } => {
  if (holdings.length === 0) {
    return {
      summary:
        "Import holdings to scan for concentration, volatility, market-cap, and catalyst risks.",
      concerns: 0,
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
      concerns: 1,
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

  let concerns = 0;
  const notes: string[] = [];

  if (topWeight >= 25) {
    concerns += 1;
    notes.push(
      `${weighted[0]?.symbol ?? "Top holding"} is ${topWeight.toFixed(1)}% of the portfolio`,
    );
  }
  if (topThreeWeight >= 65) {
    concerns += 1;
    notes.push(`top 3 positions are ${topThreeWeight.toFixed(1)}% combined`);
  }
  if (optionWeight >= 10) {
    concerns += 1;
    notes.push(`options represent ${optionWeight.toFixed(1)}% of total value`);
  }

  if (notes.length === 0) {
    return {
      summary:
        "No major concentration risk stands out from the current holdings snapshot, but continue monitoring position sizing and catalysts.",
      concerns: 0,
    };
  }

  return {
    summary: `Risk flags detected: ${notes.join("; ")}.`,
    concerns,
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
  const [isLoadingRebalanceSummary, setIsLoadingRebalanceSummary] =
    useState(true);
  const [sectorBreakdown, setSectorBreakdown] = useState<
    SectorBreakdownEntry[]
  >([]);
  const [isLoadingSectorBreakdown, setIsLoadingSectorBreakdown] =
    useState(true);
  const [riskSummary, setRiskSummary] = useState<string | null>(null);
  const [riskConcernCount, setRiskConcernCount] = useState(0);
  const [isLoadingRiskSummary, setIsLoadingRiskSummary] = useState(true);

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
      } catch {
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
            ? repairTextEncoding(data.dashboardSummary)
            : null,
        );
        setRiskConcernCount(data.concerns?.length ?? 0);
      } catch {
        try {
          const holdingsRes = await fetch(`${API_BASE_URL}/holdings`);
          if (!holdingsRes.ok) {
            throw new Error("holdings fetch failed");
          }
          const holdingsData = (await holdingsRes.json()) as HoldingsResponse;
          const fallback = getFallbackRiskAnalysis(holdingsData.holdings ?? []);
          setRiskSummary(fallback.summary);
          setRiskConcernCount(fallback.concerns);
        } catch {
          setRiskSummary(null);
          setRiskConcernCount(0);
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
      }));

    const remainderWeight = weightedHoldings
      .slice(7)
      .reduce((sum, holding) => sum + holding.weight, 0);

    if (remainderWeight > 0.01) {
      visibleHoldings.push({
        symbol: "OTHER",
        weight: remainderWeight,
        valueCad: weightedHoldings
          .slice(7)
          .reduce((sum, holding) => sum + holding.marketValueCad, 0),
        color: OTHER_DONUT_COLOR,
      });
    }

    return visibleHoldings;
  }, [weightedHoldings]);

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

  const welcomeName = settings.displayName.trim() || "Investor";

  const suggestionCards = useMemo(() => {
    const fallbackSummary =
      "Import holdings to get a rebalance suggestion based on your current weights.";
    const text = (rebalanceSummary ?? fallbackSummary).trim();

    const match = text.match(
      /trimming\s+(.+?)\s+and\s+adding\s+to\s+(.+?)\s+to\s+improve\s+balance\.?/i,
    );

    const parseLeg = (value: string) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

    return {
      summary: text,
      trim: match ? parseLeg(match[1]) : [],
      add: match ? parseLeg(match[2]) : [],
    };
  }, [rebalanceSummary]);

  const riskStatus =
    riskConcernCount >= 3 ? "Elevated" : riskConcernCount > 0 ? "Watch" : "Low";

  return (
    <div className="dashboard-shell">
      <div className="dashboard-page">
        <DashboardNavbar />

        <main className="dashboard-main">
          <section className="dashboard-top-section">
            <div className="dashboard-left-column">
              <div className="dashboard-stats-grid">
                <div className="dashboard-stat-card">
                  <div className="dashboard-stat-label">Market value</div>
                  <div className="dashboard-stat-value">
                    {maskDollar(
                      `CA$${totalMarketValueCad.toLocaleString("en-CA", {
                        maximumFractionDigits: 0,
                      })}`,
                    )}
                  </div>
                  <div className="dashboard-stat-sub">as of today</div>
                </div>

                <div className="dashboard-stat-card">
                  <div className="dashboard-stat-label">Book value</div>
                  <div className="dashboard-stat-value">
                    {maskDollar(
                      `CA$${totalBookValueMarketCad.toLocaleString("en-CA", {
                        maximumFractionDigits: 0,
                      })}`,
                    )}
                  </div>
                  <div className="dashboard-stat-sub">avg cost basis</div>
                </div>

                <div className="dashboard-stat-card">
                  <div className="dashboard-stat-label">Unrealized P&amp;L</div>
                  <div
                    className={`dashboard-stat-value ${totalGainLossCad >= 0 ? "dashboard-positive" : "dashboard-negative"}`}
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

                <div className="dashboard-stat-card">
                  <div className="dashboard-stat-label">Open positions</div>
                  <div className="dashboard-stat-value">{holdings.length}</div>
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
                      <span>Portfolio vs Market</span>
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
                              const parts = (aiSummary ?? "").split("Portfolio drivers:");
                              const market = parts[0].trim();
                              const drivers = parts[1]?.trim() ?? null;
                              return (
                                <>
                                  {market && <p className="dashboard-ai-summary-text">{market}</p>}
                                  {drivers && (
                                    <div className="dashboard-ai-drivers">
                                      <span className="dashboard-ai-drivers-label">Portfolio drivers</span>
                                      <p className="dashboard-ai-summary-text">{drivers}</p>
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
                                  : `${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                <div className="dashboard-card">
                  <div className="dashboard-card-header-row">
                    <div className="dashboard-card-title-row">
                      <HiOutlineLightBulb size={31} />
                      <span>AI Suggestion</span>
                    </div>
                    <Link
                      className="dashboard-button dashboard-button-purple"
                      to="/re-weight"
                    >
                      Rebalance Now
                    </Link>
                  </div>

                  <div className="dashboard-card-content dashboard-suggestion-content">
                    {isLoadingRebalanceSummary ? (
                      <div className="dashboard-ai-summary-loading">
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                      </div>
                    ) : (
                      <div className="dashboard-mini-grid">
                        <article className="dashboard-mini-card dashboard-mini-card-wide">
                          <h4>Plan Snapshot</h4>
                          <p className="dashboard-suggestion-text">
                            {suggestionCards.summary}
                          </p>
                        </article>

                        <article className="dashboard-mini-card">
                          <h4>Trim</h4>
                          <div className="dashboard-pill-list">
                            {suggestionCards.trim.length === 0 ? (
                              <span className="dashboard-pill dashboard-pill-neutral">
                                No trim targets
                              </span>
                            ) : (
                              suggestionCards.trim.map((item) => (
                                <span
                                  className="dashboard-pill"
                                  key={`trim-${item}`}
                                >
                                  {item}
                                </span>
                              ))
                            )}
                          </div>
                        </article>

                        <article className="dashboard-mini-card">
                          <h4>Add</h4>
                          <div className="dashboard-pill-list">
                            {suggestionCards.add.length === 0 ? (
                              <span className="dashboard-pill dashboard-pill-neutral">
                                No add targets
                              </span>
                            ) : (
                              suggestionCards.add.map((item) => (
                                <span
                                  className="dashboard-pill"
                                  key={`add-${item}`}
                                >
                                  {item}
                                </span>
                              ))
                            )}
                          </div>
                        </article>
                      </div>
                    )}
                  </div>
                </div>

                <div className="dashboard-card">
                  <div className="dashboard-card-header-row">
                    <div className="dashboard-card-title-row">
                      <FiAlertCircle size={31} />
                      <span>Risk Alert</span>
                    </div>
                    <Link
                      className="dashboard-button dashboard-button-gold"
                      to="/risk-manager"
                    >
                      View Risks
                    </Link>
                  </div>

                  <div className="dashboard-card-content dashboard-risk-content">
                    {isLoadingRiskSummary ? (
                      <div className="dashboard-ai-summary-loading">
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                        <span className="dashboard-ai-summary-dot" />
                      </div>
                    ) : (
                      <div className="dashboard-mini-grid">
                        <article className="dashboard-mini-card dashboard-mini-card-wide">
                          <h4>Risk Readout</h4>
                          <p className="dashboard-risk-summary">
                            {riskSummary ??
                              "Import holdings to scan for concentration, volatility, market-cap, and catalyst risks."}
                          </p>
                        </article>

                        <article className="dashboard-mini-card">
                          <h4>Possible Concerns</h4>
                          <div className="dashboard-risk-caption dashboard-risk-caption-strong">
                            {riskConcernCount}
                          </div>
                        </article>

                        <article className="dashboard-mini-card">
                          <h4>Status</h4>
                          <div
                            className={`dashboard-risk-caption dashboard-risk-caption-strong ${
                              riskStatus === "Low"
                                ? "dashboard-positive"
                                : riskStatus === "Watch"
                                  ? "dashboard-comparison-muted"
                                  : "dashboard-negative"
                            }`}
                          >
                            {riskStatus}
                          </div>
                        </article>
                      </div>
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
                            title={`${segment.symbol}: ${segment.weight.toFixed(1)}%`}
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
                      >
                        <span>{entry.sector}</span>
                        <span>{entry.weight.toFixed(1)}%</span>
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
