import { useEffect, useState } from "react";

const stripPreamble = (text: string): string =>
  text
    .replace(/^here (?:are|is) (?:two|2|some|a few) (?:concise )?sentences?[^:]*:\s*/i, "")
    .replace(/^sure[,!]?\s+here (?:are|is)[^:]*:\s*/i, "")
    .trim();
import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";
import "./KeyInsights.css";
import { API_BASE_URL } from "../lib/constants";
import { useUserSettings } from "../lib/userSettings";

type Insight = {
  title: string;
  detail: string;
  category: string;
  tone: "positive" | "warning" | "neutral";
  symbols: string[];
};

type PerformanceItem = {
  symbol: string;
  returnPercent: number;
  marketValueCad: number;
  weight: number;
};

type ResearchIdea = {
  title: string;
  detail: string;
};

type KeyInsightsResponse = {
  summary: string;
  insights: Insight[];
  topPerformers: PerformanceItem[];
  laggards: PerformanceItem[];
  researchIdeas: ResearchIdea[];
  generatedAt: string;
};

const formatCad = (value: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(value);

function healthScore(insights: Insight[]): number {
  const pos = insights.filter((i) => i.tone === "positive").length;
  const warn = insights.filter((i) => i.tone === "warning").length;
  return Math.round(Math.min(100, Math.max(0, 50 + pos * 8 - warn * 12)));
}

function scoreColor(score: number): string {
  if (score >= 70) return "#4ade80";
  if (score >= 45) return "#FCC860";
  return "#ef4444";
}

function KeyInsights() {
  const { settings } = useUserSettings();
  const [data, setData] = useState<KeyInsightsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const maskDollar = (displayValue: string) =>
    settings.hideDollarAmounts ? "..." : displayValue;

  const loadInsights = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/portfolio/key-insights`);
      if (!response.ok) {
        throw new Error("Failed to load key insights.");
      }
      const json = (await response.json()) as KeyInsightsResponse;
      setData({ ...json, summary: stripPreamble(json.summary ?? "") });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load key insights.",
      );
      setData(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadInsights();
  }, []);

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="insights-layout">
          <div className="insights-header">
            <div>
              <h1 className="route-page-title">Key Insights</h1>
              <p className="route-page-copy">
                AI-assisted patterns from your holdings, sector mix,
                performance, and diversification gaps.
              </p>
            </div>
            <button
              className="insights-refresh-button"
              type="button"
              onClick={loadInsights}
              disabled={isLoading}
            >
              {isLoading ? "Reading..." : "Refresh insights"}
            </button>
          </div>

          {error && <div className="insights-error">{error}</div>}

          <div className="insights-summary-card">
            {isLoading ? (
              <p className="insights-muted">Looking for portfolio patterns...</p>
            ) : !data ? (
              <p className="insights-muted">Import holdings to generate portfolio insights.</p>
            ) : (() => {
              const score = healthScore(data.insights);
              const color = scoreColor(score);
              const pos = data.insights.filter((i) => i.tone === "positive").length;
              const warn = data.insights.filter((i) => i.tone === "warning").length;
              const neu = data.insights.filter((i) => i.tone === "neutral").length;
              return (
                <div className="insights-health-row">
                  <div className="insights-health-score">
                    <span className="insights-health-num" style={{ color }}>{score}</span>
                    <span className="insights-health-label">Portfolio health</span>
                  </div>
                  <div className="insights-chips-group">
                    {pos > 0 && <span className="insights-chip insights-chip-pos">▲ {pos} Positive</span>}
                    {warn > 0 && <span className="insights-chip insights-chip-warn">▼ {warn} Warning</span>}
                    {neu > 0 && <span className="insights-chip insights-chip-neu">● {neu} Neutral</span>}
                    {[...new Set(data.insights.map((i) => i.category))].map((cat) => (
                      <span key={cat} className="insights-chip insights-chip-cat">{cat}</span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="insights-grid">
            <section className="insights-panel insights-panel-wide">
              <div className="insights-panel-header">
                <h2>Portfolio Patterns</h2>
                {data?.generatedAt && (
                  <span>
                    Updated {new Date(data.generatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>

              {isLoading ? (
                <div className="insights-empty">Loading insights...</div>
              ) : !data || data.insights.length === 0 ? (
                <div className="insights-empty">
                  No patterns yet. Import holdings to start the scan.
                </div>
              ) : (() => {
                const topInsight = data.insights.find((i) => i.tone === "positive");
                const rest = data.insights.filter((i) => i !== topInsight);
                const ordered = topInsight ? [topInsight, ...rest] : rest;
                return (
                  <div className="insights-card-list">
                    {ordered.map((insight) => (
                      <article
                        className={`insight-card insight-card-${insight.tone}${insight === topInsight ? " insight-card-pinned" : ""}`}
                        key={`${insight.category}-${insight.title}`}
                      >
                        <div className="insight-card-topline">
                          <span>
                            {insight === topInsight && (
                              <span className="insight-top-badge">Top Insight</span>
                            )}
                            {insight.category}
                          </span>
                          {insight.symbols.length > 0 && (
                            <strong>{insight.symbols.join(", ")}</strong>
                          )}
                        </div>
                        <h3>{insight.title}</h3>
                        <p>{insight.detail}</p>
                      </article>
                    ))}
                  </div>
                );
              })()}
            </section>

            <section className="insights-panel">
              <div className="insights-panel-header">
                <h2>Performance</h2>
              </div>
              <div className="insights-performance-columns">
                <div>
                  <h3>Strongest</h3>
                  {(data?.topPerformers ?? []).slice(0, 3).map((item) => (
                    <div className="insights-performance-row" key={item.symbol}>
                      <span>{item.symbol}</span>
                      <strong className="insights-positive">
                        +{item.returnPercent.toFixed(1)}%
                      </strong>
                      <small>
                        {item.weight.toFixed(1)}% /{" "}
                        {maskDollar(formatCad(item.marketValueCad))}
                      </small>
                    </div>
                  ))}
                  {!isLoading && (data?.topPerformers.length ?? 0) === 0 && (
                    <p className="insights-muted">
                      No positive performers found.
                    </p>
                  )}
                </div>

                <div>
                  <h3>Laggards</h3>
                  {(data?.laggards ?? []).slice(0, 3).map((item) => (
                    <div className="insights-performance-row" key={item.symbol}>
                      <span>{item.symbol}</span>
                      <strong className="insights-negative">
                        {item.returnPercent.toFixed(1)}%
                      </strong>
                      <small>
                        {item.weight.toFixed(1)}% /{" "}
                        {maskDollar(formatCad(item.marketValueCad))}
                      </small>
                    </div>
                  ))}
                  {!isLoading && (data?.laggards.length ?? 0) === 0 && (
                    <p className="insights-muted">
                      No unrealized laggards found.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="insights-panel">
              <div className="insights-panel-header">
                <h2>Research Ideas</h2>
              </div>
              {(data?.researchIdeas ?? []).length > 0 ? (
                <div className="insights-ideas-list">
                  {data?.researchIdeas.map((idea) => (
                    <article className="insights-idea" key={idea.title}>
                      <h3>{idea.title}</h3>
                      <p>{idea.detail}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="insights-empty">
                  No diversification gaps found from the current scan.
                </div>
              )}
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}

export default KeyInsights;
