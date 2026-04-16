import { useEffect, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";
import "./RiskManager.css";
import { API_BASE_URL } from "../lib/constants";

type RiskConcern = {
  symbol: string;
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  category: string;
  weight: number | null;
};

type RiskAnalysisResponse = {
  summary: string;
  dashboardSummary: string;
  concerns: RiskConcern[];
  holdingsAnalyzed: number;
  generatedAt: string;
};

const severityLabel: Record<RiskConcern["severity"], string> = {
  high: "High",
  medium: "Medium",
  low: "Watch",
};

function RiskManager() {
  const [analysis, setAnalysis] = useState<RiskAnalysisResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRiskAnalysis = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/risk/analysis`);
      if (!response.ok) {
        throw new Error("Failed to load risk analysis.");
      }
      const data = (await response.json()) as RiskAnalysisResponse;
      setAnalysis(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load risk analysis.",
      );
      setAnalysis(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadRiskAnalysis();
  }, []);

  const concernCounts = {
    high: analysis?.concerns.filter((item) => item.severity === "high").length ?? 0,
    medium:
      analysis?.concerns.filter((item) => item.severity === "medium").length ??
      0,
    low: analysis?.concerns.filter((item) => item.severity === "low").length ?? 0,
  };

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="risk-layout">
          <div className="risk-header">
            <div>
              <h1 className="route-page-title">Risk Manager</h1>
              <p className="route-page-copy">
                Review concentration, market-cap, volatility, earnings, and
                catalyst risks across your current holdings.
              </p>
            </div>
            <button
              className="risk-refresh-button"
              type="button"
              onClick={loadRiskAnalysis}
              disabled={isLoading}
            >
              {isLoading ? "Scanning..." : "Refresh scan"}
            </button>
          </div>

          {error && <div className="risk-error">{error}</div>}

          <div className="risk-summary-grid">
            <div className="risk-summary-card risk-summary-card-wide">
              <span className="risk-card-label">AI Risk Readout</span>
              {isLoading ? (
                <p>Scanning holdings for possible risk signals...</p>
              ) : (
                <p>
                  {analysis?.summary ??
                    "Import holdings to generate a portfolio risk scan."}
                </p>
              )}
            </div>
            <div className="risk-summary-card">
              <span className="risk-card-label">Holdings scanned</span>
              <strong>{analysis?.holdingsAnalyzed ?? 0}</strong>
            </div>
            <div className="risk-summary-card">
              <span className="risk-card-label">High priority</span>
              <strong>{concernCounts.high}</strong>
            </div>
            <div className="risk-summary-card">
              <span className="risk-card-label">Watch list</span>
              <strong>{concernCounts.medium + concernCounts.low}</strong>
            </div>
          </div>

          <div className="risk-concern-panel">
            <div className="risk-panel-header">
              <h2>Possible Concerns</h2>
              {analysis?.generatedAt && (
                <span>
                  Updated {new Date(analysis.generatedAt).toLocaleTimeString()}
                </span>
              )}
            </div>

            {isLoading ? (
              <div className="risk-empty">Loading risk signals...</div>
            ) : !analysis || analysis.concerns.length === 0 ? (
              <div className="risk-empty">
                No major concerns found from the current data. Keep checking
                before earnings and after large portfolio moves.
              </div>
            ) : (
              <div className="risk-concern-list">
                {analysis.concerns.map((concern, index) => (
                  <article
                    className="risk-concern-card"
                    key={`${concern.symbol}-${concern.title}-${index}`}
                  >
                    <div className="risk-concern-topline">
                      <span className="risk-symbol">{concern.symbol}</span>
                      <span
                        className={`risk-severity risk-severity-${concern.severity}`}
                      >
                        {severityLabel[concern.severity]}
                      </span>
                    </div>
                    <h3>{concern.title}</h3>
                    <p>{concern.detail}</p>
                    <div className="risk-meta-row">
                      <span>{concern.category}</span>
                      {concern.weight !== null && (
                        <span>{concern.weight.toFixed(1)}% weight</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default RiskManager;
