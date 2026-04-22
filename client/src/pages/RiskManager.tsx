import { useEffect, useState } from "react";

const stripPreamble = (text: string): string =>
  text
    .replace(
      /^here (?:are|is) (?:two|2|some|a few) (?:concise )?sentences?[^:]*:\s*/i,
      "",
    )
    .replace(/^sure[,!]?\s+here (?:are|is)[^:]*:\s*/i, "")
    .trim();
import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";
import "./RiskManager.css";
import { API_BASE_URL } from "../lib/constants";
import { convertToCad } from "../lib/holdingsUtils";
import type { HoldingsResponse, ImportedHolding } from "../lib/types";

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

// Broad diversified ETFs that should NOT trigger concentration risk
const BROAD_ETF_SYMBOLS = new Set([
  "XEQT", "VEQT", "VGRO", "VBAL", "XGRO", "XCNS",
  "ZAG", "VAB", "XIC", "XIU", "XAW", "VUN",
  "SPY", "QQQ", "VTI", "ITOT", "SCHB", "IVV",
  "VWO", "EFA", "AGG", "BND", "BNDX", "VXUS",
]);

const SEVERITY_ORDER: Record<RiskConcern["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

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

  if (symbolSectorMap[symbol]) return symbolSectorMap[symbol];

  if (name.includes("TECH") || name.includes("SEMICONDUCTOR")) return "Technology";
  if (name.includes("HEALTH") || name.includes("PHARMA") || name.includes("BIO")) return "Healthcare";
  if (name.includes("ENERGY") || name.includes("POWER") || name.includes("OIL")) return "Energy";
  if (name.includes("BANK") || name.includes("FINANC") || name.includes("INSURANCE")) return "Financials";
  if (name.includes("MINING") || name.includes("GOLD") || name.includes("METAL")) return "Materials";
  if (name.includes("REIT") || name.includes("REAL ESTATE")) return "Real Estate";
  if (name.includes("COMM") || name.includes("MEDIA")) return "Communication Services";

  return "Other";
};

const buildSectorBreakdownFromHoldings = (
  holdings: ImportedHolding[],
): SectorBreakdownEntry[] => {
  const bySector = new Map<string, number>();
  let totalValueCad = 0;

  for (const holding of holdings) {
    const valueCad = convertToCad(holding.market_value, holding.market_value_currency);
    if (valueCad <= 0) continue;
    const sector = inferSectorFromHolding(holding);
    totalValueCad += valueCad;
    bySector.set(sector, (bySector.get(sector) ?? 0) + valueCad);
  }

  if (totalValueCad <= 0) return [];

  return [...bySector.entries()]
    .map(([sector, valueCad]) => ({
      sector,
      valueCad,
      weight: (valueCad / totalValueCad) * 100,
    }))
    .sort((a, b) => b.valueCad - a.valueCad);
};

// Excludes "ETF / Diversified" — broad ETFs are not concentration risks
const buildSectorConcentrationConcerns = (
  sectors: SectorBreakdownEntry[],
): RiskConcern[] => {
  return sectors
    .filter((s) => s.weight >= 30 && s.sector !== "ETF / Diversified")
    .map((sector) => ({
      symbol: "Portfolio",
      title: `${sector.sector} concentration`,
      detail: `${sector.sector} represents ${sector.weight.toFixed(1)}% of the portfolio. High sector concentration amplifies drawdown risk during sector-wide corrections.`,
      severity: sector.weight >= 45 ? "high" : "medium",
      category: "Sector concentration",
      weight: sector.weight,
    }));
};

// Flags individual non-diversified holdings above 20% of portfolio
const buildStockConcentrationConcerns = (
  holdings: ImportedHolding[],
): RiskConcern[] => {
  let totalValueCad = 0;
  const items: Array<{ symbol: string; valueCad: number; isBroad: boolean }> = [];

  for (const holding of holdings) {
    const valueCad = convertToCad(holding.market_value, holding.market_value_currency);
    if (valueCad <= 0) continue;
    const sym = normalizeTickerForSector(holding.symbol);
    const secType = holding.security_type.trim().toUpperCase();
    const isBroad =
      BROAD_ETF_SYMBOLS.has(sym) ||
      (secType.includes("ETF") && BROAD_ETF_SYMBOLS.has(sym));
    totalValueCad += valueCad;
    items.push({ symbol: sym, valueCad, isBroad });
  }

  if (totalValueCad <= 0) return [];

  return items
    .filter((h) => !h.isBroad && (h.valueCad / totalValueCad) * 100 >= 20)
    .map((h) => {
      const weight = (h.valueCad / totalValueCad) * 100;
      return {
        symbol: h.symbol,
        title: `${h.symbol} position overweight`,
        detail: `${h.symbol} represents ${weight.toFixed(1)}% of total portfolio value. Single-position concentration above 20% significantly increases idiosyncratic drawdown risk.`,
        severity: (weight >= 35 ? "high" : weight >= 25 ? "medium" : "low") as RiskConcern["severity"],
        category: "Concentration",
        weight,
      };
    });
};

const mergeUniqueConcerns = (
  concerns: RiskConcern[],
  extraConcerns: RiskConcern[],
): RiskConcern[] => {
  const existing = new Set(
    concerns.map((item) => `${item.title}|${item.category}|${item.severity}`),
  );

  const merged = [...concerns];
  for (const concern of extraConcerns) {
    const key = `${concern.title}|${concern.category}|${concern.severity}`;
    if (!existing.has(key)) {
      existing.add(key);
      merged.push(concern);
    }
  }

  return merged.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (b.weight ?? 0) - (a.weight ?? 0),
  );
};

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
          <span className="risk-card-label">Explanation</span>
          <p>{concern.detail}</p>
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

function RiskManager() {
  const [analysis, setAnalysis] = useState<RiskAnalysisResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedConcern, setSelectedConcern] = useState<RiskConcern | null>(null);
  const [activeFilter, setActiveFilter] = useState<"all" | "high" | "medium" | "low">("all");

  const loadRiskAnalysis = async () => {
    setIsLoading(true);
    setError(null);

    let holdingsCount = 0;
    let holdingsList: ImportedHolding[] = [];
    let sectorBreakdown: SectorBreakdownEntry[] = [];

    try {
      const holdingsRes = await fetch(`${API_BASE_URL}/holdings`);
      if (holdingsRes.ok) {
        const holdingsData = (await holdingsRes.json()) as HoldingsResponse;
        holdingsCount = holdingsData.holdings.length;
        holdingsList = holdingsData.holdings;

        const sectorRes = await fetch(`${API_BASE_URL}/portfolio/sector-breakdown`);
        if (sectorRes.ok) {
          const sectorData = (await sectorRes.json()) as SectorBreakdownResponse;
          if ((sectorData.sectors ?? []).length > 0) {
            sectorBreakdown = sectorData.sectors;
          }
        }

        if (sectorBreakdown.length === 0) {
          sectorBreakdown = buildSectorBreakdownFromHoldings(holdingsList);
        }
      }
    } catch {
      // Best-effort preload only
    }

    try {
      const response = await fetch(`${API_BASE_URL}/risk/analysis`);
      if (!response.ok) throw new Error("Failed to load risk analysis.");
      const data = (await response.json()) as RiskAnalysisResponse;

      const sectorConcerns = buildSectorConcentrationConcerns(sectorBreakdown);
      const stockConcerns = buildStockConcentrationConcerns(holdingsList);
      const mergedConcerns = mergeUniqueConcerns(
        mergeUniqueConcerns(data.concerns, sectorConcerns),
        stockConcerns,
      );

      setAnalysis({
        ...data,
        summary: stripPreamble(data.summary ?? ""),
        dashboardSummary: stripPreamble(data.dashboardSummary ?? ""),
        concerns: mergedConcerns,
        holdingsAnalyzed: data.holdingsAnalyzed || holdingsCount,
      });
    } catch (err) {
      const sectorConcerns = buildSectorConcentrationConcerns(sectorBreakdown);
      const stockConcerns = buildStockConcentrationConcerns(holdingsList);
      const allConcerns = mergeUniqueConcerns(sectorConcerns, stockConcerns);

      if (holdingsCount > 0) {
        setAnalysis({
          summary:
            allConcerns.length > 0
              ? `${allConcerns.length} concern${allConcerns.length > 1 ? "s" : ""} detected.`
              : "No major concerns detected from current holdings.",
          dashboardSummary: "",
          concerns: allConcerns,
          holdingsAnalyzed: holdingsCount,
          generatedAt: new Date().toISOString(),
        });
      } else {
        setError(err instanceof Error ? err.message : "Failed to load risk analysis.");
        setAnalysis(null);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadRiskAnalysis();
  }, []);

  const concernCounts = {
    high: analysis?.concerns.filter((c) => c.severity === "high").length ?? 0,
    medium: analysis?.concerns.filter((c) => c.severity === "medium").length ?? 0,
    low: analysis?.concerns.filter((c) => c.severity === "low").length ?? 0,
  };

  const filteredConcerns =
    activeFilter === "all"
      ? (analysis?.concerns ?? [])
      : (analysis?.concerns ?? []).filter((c) => c.severity === activeFilter);

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
              <span className="risk-card-label">Risk Summary</span>
              {isLoading ? (
                <p>Scanning holdings for possible risk signals...</p>
              ) : !analysis || analysis.concerns.length === 0 ? (
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
                  {[...new Set(analysis.concerns.map((c) => c.category))].map((cat) => (
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

          <div className="risk-concern-panel">
            <div className="risk-panel-header">
              <h2>Possible Concerns</h2>
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
                    <p>{concern.detail}</p>
                    <div className="risk-meta-row">
                      <span>{concern.category}</span>
                      {concern.weight !== null && (
                        <span>{concern.weight.toFixed(1)}% weight</span>
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
