import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DashboardNavbar from "../components/DashboardNavbar";
import { loadActiveHoldings } from "../services/activeHoldings";
import { useAuth } from "../context/AuthContext";
import { useDemoMode } from "../lib/demoMode";
import { useUserSettings } from "../lib/userSettings";
import { convertToCad } from "../lib/holdingsUtils";
import { readDataStatus } from "../lib/dataStatus";
import { useDashboardSummary } from "../hooks/useDashboardSummary";
import { formatMoney } from "../lib/privacyFormat";
import type { ImportedHolding } from "../lib/types";
import "./PortfolioReport.css";

const DEFAULT_GOAL_AMOUNT = 500_000;
const DEFAULT_TARGET_AGE = 35;
const DEFAULT_CURRENT_AGE = 30;
const DEFAULT_MONTHLY_CONTRIB = 1_000;
const DEFAULT_RETURN = 0.07;
const DEFAULT_INFLATION = 0.02;

function fv(pv: number, r: number, n: number, pmt: number): number {
  if (n <= 0) return pv;
  if (r === 0) return pv + pmt * n;
  const g = Math.pow(1 + r, n);
  return pv * g + (pmt * (g - 1)) / r;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Unknown";
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function buildSecurityTypeLabel(value: string) {
  const normalized = value.trim();
  return normalized || "Other";
}

export default function PortfolioReport() {
  const { settings } = useUserSettings();
  const { user, portfolio, portfolioLoading } = useAuth();
  const { isDemoMode } = useDemoMode();
  const [holdings, setHoldings] = useState<ImportedHolding[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const dataStatus = readDataStatus();

  useEffect(() => {
    const load = async () => {
      if (user && !portfolio && portfolioLoading) return;
      setIsLoading(true);
      try {
        setHoldings(
          await loadActiveHoldings({
            portfolioId: portfolio?.id,
            isDemoMode,
          }),
        );
      } catch {
        setHoldings([]);
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [isDemoMode, portfolio, portfolioLoading, user]);

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

  const topHoldings = useMemo(
    () =>
      holdings
        .map((holding) => {
          const valueCad = convertToCad(
            holding.market_value,
            holding.market_value_currency,
          );
          return {
            symbol: holding.symbol,
            name: holding.name,
            valueCad,
            weight:
              totalMarketValueCad > 0 ? (valueCad / totalMarketValueCad) * 100 : 0,
          };
        })
        .filter((holding) => holding.valueCad > 0)
        .sort((a, b) => b.valueCad - a.valueCad)
        .slice(0, 10),
    [holdings, totalMarketValueCad],
  );

  const allocationRows = useMemo(() => {
    const byType = new Map<string, number>();
    for (const holding of holdings) {
      const label = buildSecurityTypeLabel(holding.security_type);
      const valueCad = convertToCad(
        holding.market_value,
        holding.market_value_currency,
      );
      byType.set(label, (byType.get(label) ?? 0) + valueCad);
    }
    return [...byType.entries()]
      .map(([label, valueCad]) => ({
        label,
        valueCad,
        weight:
          totalMarketValueCad > 0 ? (valueCad / totalMarketValueCad) * 100 : 0,
      }))
      .sort((a, b) => b.valueCad - a.valueCad);
  }, [holdings, totalMarketValueCad]);

  const {
    rebalance,
    risk,
    isLoadingRebalance,
    isLoadingRisk,
  } = useDashboardSummary(holdings, user?.id);

  const executiveSummary = useMemo(() => {
    if (!topHoldings.length) return null;

    const topHolding = topHoldings[0];
    const concentration = topHolding.weight;

    let concentrationLevel: string;
    if (concentration >= 30) concentrationLevel = "highly concentrated";
    else if (concentration >= 20) concentrationLevel = "moderately concentrated";
    else concentrationLevel = "well-diversified";

    const equityPct = allocationRows.find(
      (r) => r.label.toUpperCase().includes("EQUITY"),
    )?.weight ?? 0;

    const observations: string[] = [];
    if (concentration >= 20) {
      observations.push(
        `High concentration in top holding (${topHolding.symbol} at ${formatPercent(concentration)})`,
      );
    }
    if (equityPct >= 60) {
      observations.push(`Equity-heavy allocation (${formatPercent(equityPct)})`);
    }
    const riskCount = risk?.concernTotal ?? 0;
    if (riskCount > 0) {
      observations.push(`${riskCount} active risk signal${riskCount !== 1 ? "s" : ""}`);
    }
    if (observations.length === 0) {
      observations.push("Portfolio is broadly balanced across asset types");
      observations.push("No major concentration risk detected");
    }

    let suggestedAction: string;
    if (concentration >= 20 && rebalance?.trimSymbols?.length) {
      const toTrim = rebalance.trimSymbols.slice(0, 2).join(" and ");
      suggestedAction = `Reduce concentration in ${toTrim} and rebalance into underweighted assets.`;
    } else if (riskCount > 0) {
      suggestedAction = "Review high-volatility and high-risk positions before next rebalance.";
    } else {
      suggestedAction = "Portfolio is close to target allocation. Monitor for drift.";
    }

    return {
      summary: `Your portfolio is ${concentrationLevel}, with ${topHolding.symbol} representing ${formatPercent(topHolding.weight)} of holdings.`,
      observations,
      suggestedAction,
    };
  }, [topHoldings, allocationRows, risk, rebalance]);

  const riskSuggestedAction = useMemo(() => {
    if (!risk?.concerns?.length) return null;
    const hasEarnings = risk.concerns.some(
      (c) =>
        c.category?.toLowerCase().includes("earnings") ||
        c.title?.toLowerCase().includes("earnings"),
    );
    const hasVolatility = risk.concerns.some(
      (c) =>
        c.category?.toLowerCase().includes("volatil") ||
        c.title?.toLowerCase().includes("volatil"),
    );
    if (hasEarnings && hasVolatility) {
      return "Review high-volatility and catalyst-driven positions.";
    }
    if (hasEarnings) return "Monitor upcoming earnings catalysts closely.";
    if (hasVolatility) return "Consider reducing exposure to high-volatility positions.";
    return "Review and monitor flagged positions.";
  }, [risk]);

  const rebalanceOutcome = useMemo(() => {
    if (!rebalance) return [];
    const outcomes: string[] = [];
    if (rebalance.trimSymbols?.length) {
      outcomes.push(`Reduced concentration in ${rebalance.trimSymbols.slice(0, 2).join(" and ")}`);
    }
    if (rebalance.addSymbols?.length) {
      outcomes.push(`Increased exposure to ${rebalance.addSymbols.slice(0, 2).join(" and ")}`);
    }
    if (rebalance.tradeCount > 0) {
      outcomes.push("Improved diversification across holdings");
    }
    return outcomes;
  }, [rebalance]);

  const riskBySymbol = useMemo(() => {
    const map = new Map<string, string>();
    for (const concern of risk?.concerns ?? []) {
      if (concern.symbol && !map.has(concern.symbol)) {
        map.set(concern.symbol, concern.severity);
      }
    }
    return map;
  }, [risk]);

  const years = DEFAULT_TARGET_AGE - DEFAULT_CURRENT_AGE;
  const months = years * 12;
  const projectedGoalValue = fv(
    totalMarketValueCad,
    DEFAULT_RETURN / 12,
    months,
    DEFAULT_MONTHLY_CONTRIB,
  );
  const inflationAdjustedGoal =
    DEFAULT_GOAL_AMOUNT / Math.pow(1 + DEFAULT_INFLATION, years);

  const maskMoney = (value: number) =>
    formatMoney(value, { hideDollarAmounts: settings.hideDollarAmounts });

  const generatedAt = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="report-shell">
      <div className="report-screen-nav">
        <DashboardNavbar />
      </div>
      <main className="report-page">
        <header className="report-header">
          <div>
            <span className="report-eyebrow">Portfolio Report</span>
            <h1>RebalanceX Portfolio Report</h1>
            <p>Generated {generatedAt}</p>
          </div>
          <div className="report-actions">
            <Link to="/" className="report-secondary">
              Back to dashboard
            </Link>
            <button
              className="report-primary"
              type="button"
              onClick={() => window.print()}
            >
              Print / Save PDF
            </button>
          </div>
        </header>

        {isLoading ? (
          <section className="report-card">
            <p className="report-empty">Preparing portfolio report...</p>
          </section>
        ) : (
          <>
            {executiveSummary && (
              <section className="report-card report-exec-summary">
                <span className="report-label">Portfolio Summary</span>
                <p className="report-exec-lead">{executiveSummary.summary}</p>
                <div className="report-exec-body">
                  <div className="report-exec-col">
                    <p className="report-exec-section-label">Key observations</p>
                    <ul className="report-exec-list">
                      {executiveSummary.observations.map((obs) => (
                        <li key={obs}>{obs}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="report-exec-col report-exec-action-col">
                    <p className="report-exec-section-label">Suggested action</p>
                    <p className="report-exec-action">{executiveSummary.suggestedAction}</p>
                  </div>
                </div>
              </section>
            )}

            <section className="report-grid report-grid-four">
              <article className="report-card">
                <span className="report-label">Portfolio value</span>
                <strong>{maskMoney(totalMarketValueCad)}</strong>
                <p>{holdings.length} holdings</p>
              </article>
              <article className="report-card">
                <span className="report-label">Top holding</span>
                <strong>{topHoldings[0]?.symbol ?? "None"}</strong>
                <p>
                  {topHoldings[0]
                    ? `${formatPercent(topHoldings[0].weight)} of portfolio`
                    : "No holdings available"}
                </p>
              </article>
              <article className="report-card">
                <span className="report-label">Rebalance actions</span>
                <strong>{rebalance?.tradeCount ?? 0}</strong>
                <p>{isLoadingRebalance ? "Calculating..." : "Suggested trades"}</p>
              </article>
              <article className="report-card">
                <span className="report-label">Risk findings</span>
                <strong>{risk?.concernTotal ?? 0}</strong>
                <p>{isLoadingRisk ? "Scanning..." : "Current alerts"}</p>
              </article>
            </section>

            <section className="report-grid report-grid-two">
              <article className="report-card">
                <h2>Allocation Breakdown</h2>
                <div className="report-table report-alloc-table">
                  {allocationRows.map((row) => (
                    <div className="report-row report-alloc-row" key={row.label}>
                      <span className="report-alloc-label">{row.label}</span>
                      <div className="report-alloc-bar-wrap">
                        <div
                          className="report-alloc-bar"
                          style={{ width: `${Math.min(row.weight, 100)}%` }}
                        />
                      </div>
                      <strong className="report-alloc-pct">{formatPercent(row.weight)}</strong>
                    </div>
                  ))}
                </div>
              </article>

              <article className="report-card">
                <h2>Top Holdings</h2>
                <div className="report-table">
                  {topHoldings.map((holding) => {
                    const riskLevel = riskBySymbol.get(holding.symbol);
                    return (
                      <div className="report-row" key={holding.symbol}>
                        <span>
                          {holding.symbol}
                          <small>{holding.name}</small>
                        </span>
                        <div className="report-holding-right">
                          <strong>{formatPercent(holding.weight)}</strong>
                          <span className={`report-risk-badge report-risk-badge-${riskLevel ?? "none"}`}>
                            {riskLevel ?? "—"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            </section>

            <section className="report-grid report-grid-two">
              <article className="report-card">
                <h2>Rebalance Summary</h2>
                {isLoadingRebalance ? (
                  <p>Calculating rebalance plan...</p>
                ) : (
                  <>
                    <p>{rebalance?.summary ?? "No rebalance summary available yet."}</p>
                    {(rebalance?.totalBuyCad ?? 0) > 0 && (
                      <div className="report-rebalance-totals">
                        <div className="report-rebalance-total-row">
                          <span>Total buys</span>
                          <strong className="report-positive">{maskMoney(rebalance?.totalBuyCad ?? 0)}</strong>
                        </div>
                        <div className="report-rebalance-total-row">
                          <span>Total sells</span>
                          <strong className="report-negative">{maskMoney(rebalance?.totalSellCad ?? 0)}</strong>
                        </div>
                      </div>
                    )}
                    {(rebalance?.topTrades ?? []).length > 0 && (
                      <div className="report-table">
                        {(rebalance?.topTrades ?? []).slice(0, 6).map((trade) => (
                          <div className="report-row" key={`${trade.action}-${trade.symbol}`}>
                            <span>{trade.symbol}</span>
                            <strong>
                              {trade.action.toUpperCase()} {maskMoney(trade.tradeCad)}
                            </strong>
                          </div>
                        ))}
                      </div>
                    )}
                    {rebalanceOutcome.length > 0 && (
                      <div className="report-outcome">
                        <p className="report-exec-section-label">Expected outcome</p>
                        <ul className="report-exec-list">
                          {rebalanceOutcome.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </article>

              <article className="report-card">
                <h2>Risk Findings</h2>
                {isLoadingRisk ? (
                  <p>Scanning for risks...</p>
                ) : (
                  <>
                    <p>{risk?.summary ?? "No risk summary available yet."}</p>
                    {(risk?.concerns ?? []).length > 0 && (
                      <div className="report-table">
                        {(risk?.concerns ?? []).slice(0, 6).map((concern, index) => (
                          <div
                            className="report-row"
                            key={`${concern.symbol ?? "risk"}-${index}`}
                          >
                            <span>{concern.symbol ?? concern.category ?? "Risk"}</span>
                            <strong className={`report-risk-text-${concern.severity}`}>
                              {concern.title ?? concern.severity}
                            </strong>
                          </div>
                        ))}
                      </div>
                    )}
                    {riskSuggestedAction && (
                      <div className="report-outcome">
                        <p className="report-exec-section-label">Suggested action</p>
                        <p className="report-exec-action">{riskSuggestedAction}</p>
                      </div>
                    )}
                  </>
                )}
              </article>
            </section>

            <section className="report-grid report-grid-two">
              <article className="report-card">
                <h2>Goal Projection Summary</h2>
                <p>
                  Using a default {Math.round(DEFAULT_RETURN * 100)}% annual return
                  and {maskMoney(DEFAULT_MONTHLY_CONTRIB)}/month contribution,
                  the portfolio projects to {maskMoney(projectedGoalValue)} by
                  age {DEFAULT_TARGET_AGE}.
                </p>
                <p>
                  The {maskMoney(DEFAULT_GOAL_AMOUNT)} target equals roughly{" "}
                  {maskMoney(inflationAdjustedGoal)} in today's purchasing power
                  at {Math.round(DEFAULT_INFLATION * 100)}% inflation.
                </p>
              </article>

              <article className="report-card">
                <h2>Data Assumptions</h2>
                <div className="report-table">
                  <div className="report-row">
                    <span>Source</span>
                    <strong>{dataStatus?.sourceFileName ?? "Supabase"}</strong>
                  </div>
                  <div className="report-row">
                    <span>Last imported</span>
                    <strong>{formatDate(dataStatus?.importedAt)}</strong>
                  </div>
                  <div className="report-row">
                    <span>FX rate</span>
                    <strong>
                      1 USD = {(dataStatus?.fxRate ?? 1.37).toFixed(2)} CAD
                    </strong>
                  </div>
                  <div className="report-row">
                    <span>Generated</span>
                    <strong>{generatedAt}</strong>
                  </div>
                </div>
              </article>
            </section>

            <p className="report-disclaimer">
              RebalanceX provides educational portfolio analysis based on your
              selected assumptions. It is not financial advice.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
