import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { sessionCacheGet, sessionCacheSet } from "../lib/sessionPageCache";
import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";
import "./RiskManager.css";
import { API_BASE_URL } from "../lib/constants";
import { useAuth } from "../context/AuthContext";
import { useDemoMode } from "../lib/demoMode";
import { computeHoldingsHash } from "../lib/dashboardCache";
import { loadActiveHoldings } from "../services/activeHoldings";
import type { ImportedHolding } from "../lib/types";
import { buildRiskAction } from "../lib/riskActions";
import {
  buildFallbackRiskAnalysis,
  normalizeRiskAnalysis,
  type NormalizedRiskAnalysis,
  type RiskAnalysisApiResponse,
  type RiskConcern,
} from "../lib/riskAnalysis";

type RiskAnalysisResponse = NormalizedRiskAnalysis;

const CATEGORY_ICONS: Record<string, string> = {
  "Concentration": "◎",
  "Sector concentration": "▦",
  "Volatility": "↯",
  "Earnings": "◷",
  "Market cap": "◈",
  "Liquidity": "≋",
  "Catalyst": "⚡",
};
const getCategoryIcon = (category: string) =>
  CATEGORY_ICONS[category] ?? "●";

const severityLabel: Record<RiskConcern["severity"], string> = {
  high: "High",
  medium: "Medium",
  low: "Watch",
};

function RiskDetailDialog({
  concern,
  onClose,
}: {
  concern: RiskConcern;
  onClose: () => void;
}) {
  const isStock = concern.symbol !== "Portfolio";
  const yahooUrl = isStock
    ? `https://finance.yahoo.com/quote/${concern.symbol}`
    : null;

  return (
    <div className="risk-dialog-overlay" onClick={onClose}>
      <div
        className="risk-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="risk-dialog-header">
          <div className="risk-dialog-topline">
            <span className="risk-symbol">{concern.symbol}</span>
            <span className={`risk-severity risk-severity-${concern.severity}`}>
              {severityLabel[concern.severity]}
            </span>
          </div>
          <button className="risk-dialog-close" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <h2 className="risk-dialog-title">{concern.title}</h2>

        <div className="risk-dialog-section">
          <span className="risk-card-label">Why it matters</span>
          <p>{concern.detail}</p>
        </div>

        <div className="risk-dialog-section">
          <span className="risk-card-label">Suggested action</span>
          <p className="risk-dialog-action-text">{buildRiskAction(concern)}</p>
        </div>

        <div className="risk-dialog-metrics">
          <div className="risk-dialog-metric">
            <span className="risk-card-label">Category</span>
            <strong>{concern.category}</strong>
          </div>
          {concern.weight !== null && (
            <div className="risk-dialog-metric">
              <span className="risk-card-label">Portfolio weight</span>
              <strong>{concern.weight.toFixed(1)}%</strong>
            </div>
          )}
          <div className="risk-dialog-metric">
            <span className="risk-card-label">Risk level</span>
            <strong
              className={`risk-dialog-severity-text risk-dialog-severity-${concern.severity}`}
            >
              {severityLabel[concern.severity]}
            </strong>
          </div>
          {concern.metrics?.beta !== undefined && (
            <div className="risk-dialog-metric">
              <span className="risk-card-label">Beta</span>
              <strong>{concern.metrics.beta.toFixed(2)}</strong>
            </div>
          )}
          {concern.metrics?.marketCapLabel && (
            <div className="risk-dialog-metric">
              <span className="risk-card-label">Market cap</span>
              <strong>{concern.metrics.marketCapLabel}</strong>
            </div>
          )}
          {concern.metrics?.earningsInDays !== undefined && (
            <div className="risk-dialog-metric">
              <span className="risk-card-label">Earnings in</span>
              <strong>{concern.metrics.earningsInDays === 0 ? "Today" : `${concern.metrics.earningsInDays}d`}</strong>
            </div>
          )}
          {concern.metrics?.earningsDate && (
            <div className="risk-dialog-metric">
              <span className="risk-card-label">Earnings date</span>
              <strong>{new Date(concern.metrics.earningsDate).toLocaleDateString()}</strong>
            </div>
          )}
        </div>

        {yahooUrl && (
          <div className="risk-dialog-links">
            <span className="risk-card-label">Research</span>
            <div className="risk-dialog-link-row">
              <a
                href={yahooUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="risk-dialog-link"
              >
                Yahoo Finance →
              </a>
              <a
                href={`https://www.tradingview.com/symbols/${concern.symbol}`}
                target="_blank"
                rel="noopener noreferrer"
                className="risk-dialog-link"
              >
                TradingView →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const RISK_CACHE_KEY = "risk-analysis-v4";

function RiskManager() {
  const location = useLocation();
  const navigate = useNavigate();
  const { portfolio } = useAuth();
  const portfolioId = portfolio?.id ?? null;
  const { isDemoMode } = useDemoMode();
  const [analysis, setAnalysis] = useState<RiskAnalysisResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedConcern, setSelectedConcern] = useState<RiskConcern | null>(null);
  const [activeFilter, setActiveFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const pendingConcernKey = useRef<string | null>(
    (location.state as { openConcernKey?: string } | null)?.openConcernKey ?? null,
  );

  const loadRiskAnalysis = useCallback(async (force = false) => {
    setIsLoading(true);
    setError(null);

    let holdingsCount = 0;
    let holdingsList: ImportedHolding[] = [];
    const cacheKeyFromHoldings = (items: ImportedHolding[]) =>
      `${RISK_CACHE_KEY}:${computeHoldingsHash(items)}`;

    try {
      holdingsList = await loadActiveHoldings({
        portfolioId: portfolio?.id,
        isDemoMode,
      });
      holdingsCount = holdingsList.length;
      if (!force) {
        const cached = sessionCacheGet<RiskAnalysisResponse>(
          cacheKeyFromHoldings(holdingsList),
        );
        if (cached) {
          setAnalysis(cached);
        }
      }
    } catch {
      // Best-effort preload only
    }

    try {
      const response = await fetch(`${API_BASE_URL}/risk/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdings: holdingsList }),
      });
      if (!response.ok) throw new Error("Failed to load risk analysis.");
      const data = (await response.json()) as RiskAnalysisApiResponse;
      const result = normalizeRiskAnalysis(data, holdingsList);
      sessionCacheSet(cacheKeyFromHoldings(holdingsList), result);
      setAnalysis(result);
    } catch {
      const fallback = buildFallbackRiskAnalysis(holdingsList);
      if (holdingsCount > 0) {
        sessionCacheSet(cacheKeyFromHoldings(holdingsList), fallback);
      }
      setAnalysis(fallback);
    } finally {
      setIsLoading(false);
    }
  }, [isDemoMode, portfolio]);

  useEffect(() => {
    void loadRiskAnalysis();
  }, [loadRiskAnalysis]);

  useEffect(() => {
    const handler = () => void loadRiskAnalysis(true);
    window.addEventListener("holdings-changed", handler);
    return () => window.removeEventListener("holdings-changed", handler);
  }, [loadRiskAnalysis]);

  useEffect(() => {
    if (!pendingConcernKey.current || !analysis || isLoading) return;
    const [symbol, title] = pendingConcernKey.current.split("|");
    const match = analysis.mainConcerns.find(
      (c) => c.symbol === symbol && (c.title === title || !title),
    );
    if (match) {
      setSelectedConcern(match);
      pendingConcernKey.current = null;
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [analysis, isLoading, navigate, location.pathname]);

  const concernCounts = {
    high: analysis?.severityCounts.high ?? 0,
    medium: analysis?.severityCounts.medium ?? 0,
    low: analysis?.severityCounts.low ?? 0,
  };

  const filteredConcerns =
    activeFilter === "all"
      ? (analysis?.mainConcerns ?? [])
      : (analysis?.mainConcerns ?? []).filter((c) => c.severity === activeFilter);

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
              onClick={() => void loadRiskAnalysis(true)}
              disabled={isLoading}
            >
              {isLoading ? "Scanning..." : "Refresh Risk Scan"}
            </button>
          </div>

          {error && <div className="risk-error">{error}</div>}

          <div className="risk-summary-grid">
            <div className="risk-summary-card risk-summary-card-wide">
              <span className="risk-card-label">Risk Summary</span>
              {isLoading ? (
                <p>Scanning holdings for possible risk signals...</p>
              ) : !analysis || analysis.mainConcerns.length === 0 ? (
                <p>No major concerns found from the current data.</p>
              ) : (
                <div className="risk-chips-row">
                  {concernCounts.high > 0 && (
                    <button
                      type="button"
                      className="risk-chip risk-chip-high"
                      onClick={() => setActiveFilter(activeFilter === "high" ? "all" : "high")}
                    >
                      ● {concernCounts.high} High
                    </button>
                  )}
                  {concernCounts.medium > 0 && (
                    <button
                      type="button"
                      className="risk-chip risk-chip-medium"
                      onClick={() => setActiveFilter(activeFilter === "medium" ? "all" : "medium")}
                    >
                      ● {concernCounts.medium} Medium
                    </button>
                  )}
                  {concernCounts.low > 0 && (
                    <button
                      type="button"
                      className="risk-chip risk-chip-low"
                      onClick={() => setActiveFilter(activeFilter === "low" ? "all" : "low")}
                    >
                      ● {concernCounts.low} Watch
                    </button>
                  )}
                  {[...new Set(analysis.mainConcerns.map((c) => c.category))].map((cat) => (
                    <span key={cat} className="risk-chip risk-chip-category">
                      {getCategoryIcon(cat)} {cat}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="risk-summary-card">
              <span className="risk-card-label">Holdings scanned</span>
              <strong>{analysis?.holdingsAnalyzed ?? 0}</strong>
            </div>
            <div className="risk-summary-card">
              <span className="risk-card-label">High priority</span>
              <strong className={concernCounts.high > 0 ? "risk-count-high" : ""}>
                {concernCounts.high}
              </strong>
            </div>
            <div className="risk-summary-card">
              <span className="risk-card-label">Watch list</span>
              <strong>{concernCounts.medium + concernCounts.low}</strong>
            </div>
          </div>

          {!isLoading && analysis?.dataQualityMessage && (
            <div className="risk-data-quality-note">
              {analysis.dataQualityMessage}
            </div>
          )}

          <div className="risk-concern-panel">
            <div className="risk-panel-header">
              <h2>Risk Findings</h2>
              <div className="risk-filter-bar">
                {(["all", "high", "medium", "low"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`risk-filter-btn ${activeFilter === f ? "risk-filter-btn-active" : ""} ${f !== "all" ? `risk-filter-btn-${f}` : ""}`}
                    onClick={() => setActiveFilter(f)}
                  >
                    {f === "all" ? "All" : f === "low" ? "Watch" : f.charAt(0).toUpperCase() + f.slice(1)}
                    {f !== "all" && concernCounts[f] > 0 && (
                      <span className="risk-filter-count">{concernCounts[f]}</span>
                    )}
                  </button>
                ))}
                {analysis?.generatedAt && (
                  <span className="risk-updated-time">
                    Updated {new Date(analysis.generatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>

            {isLoading ? (
              <div className="risk-empty">Loading risk signals...</div>
            ) : !analysis || filteredConcerns.length === 0 ? (
              <div className="risk-empty">
                {activeFilter !== "all"
                  ? `No ${activeFilter === "low" ? "watch" : activeFilter} concerns found.`
                  : "No major concerns found from the current data. Keep checking before earnings and after large portfolio moves."}
              </div>
            ) : (
              <div className="risk-concern-list">
                {filteredConcerns.map((concern, index) => (
                  <article
                    className="risk-concern-card"
                    key={`${concern.symbol}-${concern.title}-${index}`}
                    onClick={() => setSelectedConcern(concern)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setSelectedConcern(concern)}
                  >
                    <div className="risk-concern-topline">
                      <span className="risk-symbol">
                        <span className="risk-category-icon">{getCategoryIcon(concern.category)}</span>
                        {concern.symbol}
                      </span>
                      <span className={`risk-severity risk-severity-${concern.severity}`}>
                        {severityLabel[concern.severity]}
                      </span>
                    </div>
                    <h3>{concern.title}</h3>

                    <p className="risk-concern-detail">{concern.detail}</p>

                    <div className="risk-meta-row">
                      <span>{concern.category}</span>
                      {concern.weight !== null && (
                        <span className="risk-meta-weight">{concern.weight.toFixed(1)}% of portfolio</span>
                      )}
                    </div>
                    <div className="risk-card-cta">View details →</div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      {selectedConcern && (
        <RiskDetailDialog
          concern={selectedConcern}
          onClose={() => setSelectedConcern(null)}
        />
      )}
    </div>
  );
}

export default RiskManager;
