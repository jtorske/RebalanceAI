import { useEffect, useState } from "react";
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
      setData(json);
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
            <span className="insights-label">AI Readout</span>
            <p>
              {isLoading
                ? "Looking for portfolio patterns..."
                : (data?.summary ??
                  "Import holdings to generate portfolio insights.")}
            </p>
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
              ) : (
                <div className="insights-card-list">
                  {data.insights.map((insight) => (
                    <article
                      className={`insight-card insight-card-${insight.tone}`}
                      key={`${insight.category}-${insight.title}`}
                    >
                      <div className="insight-card-topline">
                        <span>{insight.category}</span>
                        {insight.symbols.length > 0 && (
                          <strong>{insight.symbols.join(", ")}</strong>
                        )}
                      </div>
                      <h3>{insight.title}</h3>
                      <p>{insight.detail}</p>
                    </article>
                  ))}
                </div>
              )}
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
