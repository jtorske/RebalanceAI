import { FiAlertCircle, FiBarChart2 } from "react-icons/fi";
import { HiOutlineLightBulb } from "react-icons/hi";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./Dashboard.css";

type ImportedHolding = {
  symbol: string;
  name: string;
  security_type: string;
  market_value: number;
  market_value_currency: string;
  market_unrealized_returns: number;
  market_unrealized_returns_currency: string;
  book_value_cad: number;
};

type HoldingsResponse = {
  holdings: ImportedHolding[];
};

type BenchmarkQuote = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
};

type MarketComparisonResponse = {
  portfolioDailyPercent: number | null;
  marketDailyPercent: number | null;
  deltaPercent: number | null;
  benchmarks: BenchmarkQuote[];
};

type WeightedHolding = ImportedHolding & {
  marketValueCad: number;
  weight: number;
};

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const USD_TO_CAD_RATE = Number.parseFloat(
  import.meta.env.VITE_USD_TO_CAD_RATE ?? "1.37",
);

const DONUT_COLORS = ["#8a6ef0", "#f2c154", "#98e76f"];

function convertToCad(amount: number, currency: string): number {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (normalizedCurrency === "CAD") {
    return amount;
  }
  if (normalizedCurrency === "USD") {
    return amount * USD_TO_CAD_RATE;
  }

  return amount;
}

function Dashboard() {
  const [holdings, setHoldings] = useState<ImportedHolding[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkQuote[]>([]);
  const [isLoadingBenchmarks, setIsLoadingBenchmarks] = useState(true);
  const [marketComparison, setMarketComparison] =
    useState<MarketComparisonResponse | null>(null);

  useEffect(() => {
    const loadHoldings = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`${API_BASE_URL}/holdings`);
        if (!response.ok) {
          throw new Error("Failed to load holdings from backend.");
        }

        const data = (await response.json()) as HoldingsResponse;
        setHoldings(data.holdings ?? []);
      } catch (loadError) {
        const details =
          loadError instanceof Error
            ? loadError.message
            : "Unknown dashboard loading error.";
        setError(details);
        setHoldings([]);
      } finally {
        setIsLoading(false);
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
      try {
        const response = await fetch(
          `${API_BASE_URL}/market/portfolio-vs-market`,
        );
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

  const totalUnrealizedCad = useMemo(
    () =>
      holdings.reduce(
        (sum, holding) =>
          sum +
          convertToCad(
            holding.market_unrealized_returns,
            holding.market_unrealized_returns_currency,
          ),
        0,
      ),
    [holdings],
  );

  const totalBookValueCad = useMemo(
    () => holdings.reduce((sum, holding) => sum + holding.book_value_cad, 0),
    [holdings],
  );

  const performancePct = useMemo(() => {
    if (totalBookValueCad <= 0) {
      return 0;
    }
    return (totalUnrealizedCad / totalBookValueCad) * 100;
  }, [totalBookValueCad, totalUnrealizedCad]);

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

  const chartRows = useMemo(
    () => weightedHoldings.slice(0, 8),
    [weightedHoldings],
  );
  const donutHoldings = useMemo(
    () => weightedHoldings.slice(0, 3),
    [weightedHoldings],
  );

  const donutGradient = useMemo(() => {
    if (donutHoldings.length === 0) {
      return "conic-gradient(#e7e7ef 0deg 360deg)";
    }

    let currentDegree = 0;
    const slices: string[] = [];

    donutHoldings.forEach((holding, index) => {
      const slice = Math.max(holding.weight, 3);
      const nextDegree = Math.min(currentDegree + (slice / 100) * 360, 360);
      slices.push(
        `${DONUT_COLORS[index % DONUT_COLORS.length]} ${currentDegree}deg ${nextDegree}deg`,
      );
      currentDegree = nextDegree;
    });

    if (currentDegree < 360) {
      slices.push(`#ececf2 ${currentDegree}deg 360deg`);
    }

    return `conic-gradient(${slices.join(", ")})`;
  }, [donutHoldings]);

  const allocationBySecurityType = useMemo(() => {
    const byType = new Map<string, number>();

    weightedHoldings.forEach((holding) => {
      const key = holding.security_type || "UNKNOWN";
      byType.set(key, (byType.get(key) ?? 0) + holding.marketValueCad);
    });

    return [...byType.entries()]
      .map(([type, value]) => ({
        type,
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
  const portfolioVsMarketDelta = marketComparison?.deltaPercent ?? null;

  return (
    <div className="dashboard-shell">
      <div className="dashboard-page">
        <DashboardNavbar />

        <main className="dashboard-main">
          <section className="dashboard-top-section">
            <div className="dashboard-left-column">
              <div className="dashboard-balance">
                CA${totalMarketValueCad.toFixed(2)}
              </div>
              <div
                className={
                  performancePct >= 0
                    ? "dashboard-change"
                    : "dashboard-change dashboard-change-negative"
                }
              >
                {holdings.length === 0
                  ? "No holdings imported yet"
                  : `${performancePct >= 0 ? "+" : ""}${performancePct.toFixed(2)}% overall | ${holdings.length} positions`}
              </div>

              <div className="dashboard-chart-card">
                {isLoading ? (
                  <div className="dashboard-chart-placeholder dashboard-empty-state">
                    <div className="dashboard-empty-state-heading">
                      Loading portfolio data...
                    </div>
                  </div>
                ) : null}

                {!isLoading && error ? (
                  <div className="dashboard-chart-placeholder dashboard-empty-state">
                    <div className="dashboard-empty-state-heading">
                      Unable to load holdings
                    </div>
                    <div className="dashboard-empty-state-copy">{error}</div>
                  </div>
                ) : null}

                {!isLoading && !error && holdings.length === 0 ? (
                  <div className="dashboard-chart-placeholder dashboard-empty-state">
                    <div className="dashboard-empty-state-heading">
                      Upload your holdings to unlock the portfolio chart.
                    </div>

                    <div className="dashboard-empty-state-copy">
                      Once positions are uploaded, this area shows top holdings
                      by weight and concentration signals.
                    </div>
                  </div>
                ) : null}

                {!isLoading && !error && holdings.length > 0 ? (
                  <div className="dashboard-chart-live">
                    {chartRows.map((holding) => (
                      <div
                        className="dashboard-chart-row"
                        key={`${holding.symbol}-${holding.marketValueCad.toString()}`}
                      >
                        <div className="dashboard-chart-row-head">
                          <span className="dashboard-chart-symbol">
                            {holding.symbol}
                          </span>
                          <span className="dashboard-chart-value">
                            {holding.weight.toFixed(2)}%
                          </span>
                        </div>
                        <div className="dashboard-chart-track">
                          <div
                            className="dashboard-chart-fill"
                            style={{ width: `${Math.max(holding.weight, 2)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="dashboard-right-column">
              <div className="dashboard-donut-wrap">
                <div
                  className="dashboard-donut-ring"
                  style={{ background: donutGradient }}
                >
                  <div className="dashboard-donut-core">
                    <div className="dashboard-donut-legend">
                      {donutHoldings.length === 0 ? (
                        <div className="dashboard-donut-empty">
                          No allocation yet
                        </div>
                      ) : (
                        donutHoldings.map((holding, index) => (
                          <div
                            className={`dashboard-donut-item${
                              index === donutHoldings.length - 1
                                ? " no-margin"
                                : ""
                            }`}
                            key={`${holding.symbol}-${holding.weight.toString()}`}
                          >
                            <div
                              className="dashboard-donut-bar"
                              style={{
                                background:
                                  DONUT_COLORS[index % DONUT_COLORS.length],
                              }}
                            />
                            <span className="dashboard-donut-label">
                              {holding.symbol}
                            </span>
                            <span className="dashboard-positive">
                              {holding.weight.toFixed(1)}%
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="dashboard-allocation-card">
                <h4 className="dashboard-allocation-title">
                  Allocation Breakdown
                </h4>
                {allocationBySecurityType.length === 0 ? (
                  <div className="dashboard-allocation-empty">
                    Upload holdings to see sector, asset class, and cash
                    allocation.
                  </div>
                ) : (
                  <div className="dashboard-allocation-list">
                    {allocationBySecurityType.map((entry) => (
                      <div
                        className="dashboard-allocation-row"
                        key={entry.type}
                      >
                        <span>{entry.type}</span>
                        <span>{entry.weight.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="dashboard-cards-grid">
            <div className="dashboard-card">
              <div className="dashboard-card-header-row">
                <div className="dashboard-card-title-row">
                  <FiBarChart2 size={30} />
                  <span>Portfolio vs Market</span>
                </div>
              </div>

              <div className="dashboard-card-content dashboard-market-content">
                <div className="dashboard-market-row">
                  <div className="dashboard-market-track">
                    <div
                      className="dashboard-market-fill"
                      style={{
                        width: `${Math.min(Math.max(Math.abs(portfolioDailyPercent ?? 0) * 4, 14), 100)}%`,
                      }}
                    />
                  </div>
                  <div
                    className={
                      (portfolioDailyPercent ?? 0) >= 0
                        ? "dashboard-positive"
                        : "dashboard-negative"
                    }
                  >
                    {portfolioDailyPercent === null
                      ? "--"
                      : `${portfolioDailyPercent >= 0 ? "+" : ""}${portfolioDailyPercent.toFixed(2)}%`}
                  </div>
                </div>

                <div className="dashboard-market-row">
                  <div className="dashboard-market-track">
                    <div
                      className="dashboard-market-fill dashboard-market-fill-alt"
                      style={{
                        width: `${Math.min(Math.max(Math.abs(marketDailyPercent ?? 0) * 5, 14), 100)}%`,
                      }}
                    />
                  </div>
                  <div
                    className={
                      (marketDailyPercent ?? 0) >= 0
                        ? "dashboard-positive"
                        : "dashboard-negative"
                    }
                  >
                    {marketDailyPercent === null
                      ? "--"
                      : `${marketDailyPercent >= 0 ? "+" : ""}${marketDailyPercent.toFixed(2)}%`}
                  </div>
                </div>

                <div className="dashboard-market-row no-margin">
                  <div className="dashboard-market-track">
                    <div
                      className="dashboard-market-fill dashboard-market-fill-muted"
                      style={{
                        width: `${Math.min(Math.max(Math.abs(portfolioVsMarketDelta ?? 0) * 8, 14), 100)}%`,
                      }}
                    />
                  </div>
                  <div
                    className={
                      (portfolioVsMarketDelta ?? 0) >= 0
                        ? "dashboard-positive"
                        : "dashboard-negative"
                    }
                  >
                    {portfolioVsMarketDelta === null
                      ? "--"
                      : `${portfolioVsMarketDelta >= 0 ? "+" : ""}${portfolioVsMarketDelta.toFixed(2)}%`}
                  </div>
                </div>

                <div className="dashboard-benchmark-list">
                  {isLoadingBenchmarks ? (
                    <div className="dashboard-benchmark-item">
                      Loading benchmark prices...
                    </div>
                  ) : (
                    benchmarks.map((item) => (
                      <div
                        className="dashboard-benchmark-item"
                        key={item.symbol}
                      >
                        <span>{item.symbol}</span>
                        <span>
                          {item.price === null
                            ? "--"
                            : `$${item.price.toFixed(2)}`}
                        </span>
                      </div>
                    ))
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
        </main>
      </div>
    </div>
  );
}

export default Dashboard;
