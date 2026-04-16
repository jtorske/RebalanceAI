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
        setRebalanceSummary(null);
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
        setSectorBreakdown(data.sectors ?? []);
      } catch {
        setSectorBreakdown([]);
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
        setRiskSummary(null);
        setRiskConcernCount(0);
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
                            <p className="dashboard-ai-summary-text">
                              {aiSummary}
                            </p>
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
                      <p className="dashboard-suggestion-text">
                        {rebalanceSummary ??
                          "Import holdings to get a rebalance suggestion based on your current weights."}
                      </p>
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
                      Risk Manager
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
                      <>
                        <p className="dashboard-risk-summary">
                          {riskSummary ??
                            "Import holdings to scan for concentration, volatility, market-cap, and catalyst risks."}
                        </p>
                        <div className="dashboard-risk-caption">
                          {riskConcernCount} possible concerns
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
