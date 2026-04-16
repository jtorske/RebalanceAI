import { FiAlertCircle, FiBarChart2 } from "react-icons/fi";
import { HiOutlineLightBulb } from "react-icons/hi";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar";
import "./Dashboard.css";
import { API_BASE_URL } from "../lib/constants";
import { DONUT_COLORS, getHoldingSector } from "../lib/dashboardUtils";
import { convertToCad } from "../lib/holdingsUtils";
import type { ImportedHolding, HoldingsResponse, BenchmarkQuote, MarketComparisonResponse, WeightedHolding } from "../lib/types";

function Dashboard() {
  const [holdings, setHoldings] = useState<ImportedHolding[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkQuote[]>([]);
  const [isLoadingBenchmarks, setIsLoadingBenchmarks] = useState(true);
  const [marketComparison, setMarketComparison] =
    useState<MarketComparisonResponse | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [isLoadingAiSummary, setIsLoadingAiSummary] = useState(true);

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
      try {
        const res = await fetch(`${API_BASE_URL}/market/ai-summary`);
        if (!res.ok) throw new Error("ai-summary fetch failed");
        const data = (await res.json()) as { summary: string | null };
        setAiSummary(data.summary ?? null);
      } catch {
        setAiSummary(null);
      } finally {
        setIsLoadingAiSummary(false);
      }
    };
    void loadAiSummary();
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

  const dailyChangeBySymbol = useMemo(() => {
    const grouped = new Map<string, number[]>();

    (marketComparison?.perTicker ?? []).forEach((item) => {
      const symbol = item.symbol?.trim().toUpperCase();
      if (!symbol) {
        return;
      }

      if (typeof item.dailyPercent !== "number" || !Number.isFinite(item.dailyPercent)) {
        return;
      }

      const existing = grouped.get(symbol) ?? [];
      existing.push(item.dailyPercent);
      grouped.set(symbol, existing);
    });

    const normalized: Record<string, number> = {};
    grouped.forEach((values, symbol) => {
      normalized[symbol] =
        values.reduce((sum, value) => sum + value, 0) / values.length;
    });

    return normalized;
  }, [marketComparison]);

  const topThreeHoldings = useMemo(
    () => weightedHoldings.slice(0, 3),
    [weightedHoldings],
  );

  const donutSegments = useMemo(() => {
    const topEight = weightedHoldings.slice(0, 8).map((holding, index) => ({
      symbol: holding.symbol,
      weight: holding.weight,
      color: DONUT_COLORS[index % DONUT_COLORS.length],
    }));

    const remainderWeight = weightedHoldings
      .slice(8)
      .reduce((sum, holding) => sum + holding.weight, 0);

    if (remainderWeight > 0.01) {
      topEight.push({
        symbol: "OTHER",
        weight: remainderWeight,
        color: DONUT_COLORS[(topEight.length + 2) % DONUT_COLORS.length],
      });
    }

    return topEight;
  }, [weightedHoldings]);

  const donutGradient = useMemo(() => {
    if (donutSegments.length === 0) {
      return "conic-gradient(#e7e7ef 0deg 360deg)";
    }

    let currentDegree = 0;
    const slices: string[] = [];

    donutSegments.forEach((segment) => {
      const nextDegree = Math.min(
        currentDegree + (Math.max(segment.weight, 0) / 100) * 360,
        360,
      );
      slices.push(`${segment.color} ${currentDegree}deg ${nextDegree}deg`);
      currentDegree = nextDegree;
    });

    if (currentDegree < 360) {
      slices.push(`#ececf2 ${currentDegree}deg 360deg`);
    }

    return `conic-gradient(${slices.join(", ")})`;
  }, [donutSegments]);

  const donutLabels = useMemo(() => {
    let cumulative = 0;

    return donutSegments.map((segment) => {
      const start = cumulative;
      const end = cumulative + segment.weight;
      cumulative = end;

      const midpoint = (start + end) / 2;
      const radians = (midpoint / 100) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(radians);
      const y = Math.sin(radians);

      return {
        ...segment,
        x,
        y,
      };
    });
  }, [donutSegments]);

  const allocationBySector = useMemo(() => {
    const bySector = new Map<string, number>();

    weightedHoldings.forEach((holding) => {
      const sector = getHoldingSector(holding);
      bySector.set(sector, (bySector.get(sector) ?? 0) + holding.marketValueCad);
    });

    return [...bySector.entries()]
      .map(([sector, value]) => ({
        sector,
        value,
        weight:
          totalMarketValueCad > 0 ? (value / totalMarketValueCad) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 4);
  }, [weightedHoldings, totalMarketValueCad]);

  const concentrationRisk = useMemo(() => {
    const topWeight = weightedHoldings[0]?.weight ?? 0;
    if (topWeight >= 35) {
      return "High concentration risk";
    }
    if (topWeight >= 20) {
      return "Moderate concentration risk";
    }
    return "Diversification looks healthy";
  }, [weightedHoldings]);

  const portfolioDailyPercent = marketComparison?.portfolioDailyPercent ?? null;
  const marketDailyPercent = marketComparison?.marketDailyPercent ?? null;

  const formatPercent = (value: number | null) =>
    value === null ? "--" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

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
                    CA$
                    {totalMarketValueCad.toLocaleString("en-CA", {
                      maximumFractionDigits: 0,
                    })}
                  </div>
                  <div className="dashboard-stat-sub">as of today</div>
                </div>

                <div className="dashboard-stat-card">
                  <div className="dashboard-stat-label">Book value</div>
                  <div className="dashboard-stat-value">
                    CA$
                    {totalBookValueMarketCad.toLocaleString("en-CA", {
                      maximumFractionDigits: 0,
                    })}
                  </div>
                  <div className="dashboard-stat-sub">avg cost basis</div>
                </div>

                <div className="dashboard-stat-card">
                  <div className="dashboard-stat-label">Unrealized P&amp;L</div>
                  <div
                    className={`dashboard-stat-value ${totalGainLossCad >= 0 ? "dashboard-positive" : "dashboard-negative"}`}
                  >
                    {totalGainLossCad >= 0 ? "+" : ""}CA$
                    {Math.abs(totalGainLossCad).toLocaleString("en-CA", {
                      maximumFractionDigits: 0,
                    })}
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
                    {allocationBySector.length} sectors
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
                    <div className="dashboard-empty-state-copy dashboard-comparison-copy">
                      Daily moves use currently open holdings only. “Vs
                      portfolio” means the benchmark’s daily move minus your
                      portfolio’s daily move.
                    </div>

                    {(isLoadingAiSummary || aiSummary) && (
                      <div className="dashboard-ai-summary">
                        {isLoadingAiSummary ? (
                          <div className="dashboard-ai-summary-loading">
                            <span className="dashboard-ai-summary-dot" />
                            <span className="dashboard-ai-summary-dot" />
                            <span className="dashboard-ai-summary-dot" />
                          </div>
                        ) : (
                          <p className="dashboard-ai-summary-text">{aiSummary}</p>
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

                  <div className="dashboard-card-content dashboard-lines-content">
                    <div className="dashboard-line-placeholder" />
                    <div className="dashboard-line-placeholder" />
                    <div className="dashboard-line-placeholder dashboard-line-placeholder-short" />
                  </div>
                </div>

                <div className="dashboard-card">
                  <div className="dashboard-card-header-row">
                    <div className="dashboard-card-title-row">
                      <FiAlertCircle size={31} color="#18151f" />
                      <span>Risk Alert</span>
                    </div>
                    <Link
                      className="dashboard-button dashboard-button-gold"
                      to="/risk-manager"
                    >
                      Risk Manager
                    </Link>
                  </div>

                  <div className="dashboard-card-content dashboard-lines-content">
                    <div className="dashboard-line-placeholder" />
                    <div className="dashboard-line-placeholder" />
                    <div className="dashboard-line-placeholder dashboard-line-placeholder-medium" />
                    <div className="dashboard-risk-caption">
                      {concentrationRisk}
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <div className="dashboard-right-column">
              <div className="dashboard-donut-wrap">
                <div className="dashboard-donut-stage">
                  <div
                    className="dashboard-donut-ring"
                    style={{ background: donutGradient }}
                  >
                    <div className="dashboard-donut-core">
                      {topThreeHoldings.length === 0 ? (
                        <div className="dashboard-donut-empty">No allocation yet</div>
                      ) : (
                        <div className="dashboard-donut-center-list">
                          {topThreeHoldings.map((holding) => {
                            const daily =
                              dailyChangeBySymbol[holding.symbol.trim().toUpperCase()];
                            return (
                              <div
                                className="dashboard-donut-center-item"
                                key={`${holding.symbol}-${holding.marketValueCad.toString()}`}
                              >
                                <span className="dashboard-donut-center-symbol">
                                  {holding.symbol}
                                </span>
                                <span
                                  className={
                                    daily == null
                                      ? "dashboard-comparison-muted"
                                      : daily >= 0
                                        ? "dashboard-positive"
                                        : "dashboard-negative"
                                  }
                                >
                                  {daily == null
                                    ? "--"
                                    : `${daily >= 0 ? "+" : ""}${daily.toFixed(2)}%`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  {donutLabels.map((segment) => (
                    <div
                      className="dashboard-donut-segment-label"
                      key={`${segment.symbol}-${segment.weight.toString()}`}
                      style={{
                        left: `${50 + segment.x * 38}%`,
                        top: `${50 + segment.y * 38}%`,
                      }}
                    >
                      {segment.symbol} {segment.weight.toFixed(1)}%
                    </div>
                  ))}
                </div>
              </div>

              <div className="dashboard-allocation-card">
                <h4 className="dashboard-allocation-title">Sector Breakdown</h4>
                {allocationBySector.length === 0 ? (
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
