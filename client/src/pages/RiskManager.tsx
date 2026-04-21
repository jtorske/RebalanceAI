import { useEffect, useMemo, useState } from "react";

const stripPreamble = (text: string): string =>
  text
    .replace(/^here (?:are|is) (?:two|2|some|a few) (?:concise )?sentences?[^:]*:\s*/i, "")
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

type SectorBreakdownEntry = { sector: string; valueCad: number; weight: number };
type SectorBreakdownResponse = { sectors: SectorBreakdownEntry[]; totalValueCad: number; generatedAt: string };

type FilterKey = "all" | "concentration" | "earnings" | "volatility" | "catalyst" | "other";

const SEVERITY_ORDER: Record<RiskConcern["severity"], number> = { high: 0, medium: 1, low: 2 };

const severityLabel: Record<RiskConcern["severity"], string> = {
  high: "High",
  medium: "Medium",
  low: "Watch",
};

const getCategoryIcon = (category: string): string => {
  const c = category.toLowerCase();
  if (c.includes("concentration") || c.includes("sector")) return "🎯";
  if (c.includes("volatil") || c.includes("beta")) return "⚡";
  if (c.includes("earnings") || c.includes("catalyst")) return "📅";
  if (c.includes("news") || c.includes("headline")) return "📰";
  if (c.includes("sector")) return "🏦";
  return "⚠️";
};

const matchesFilter = (concern: RiskConcern, filter: FilterKey): boolean => {
  if (filter === "all") return true;
  const c = concern.category.toLowerCase();
  if (filter === "concentration") return c.includes("concentration") || c.includes("sector");
  if (filter === "earnings") return c.includes("earnings");
  if (filter === "volatility") return c.includes("volatil") || c.includes("beta");
  if (filter === "catalyst") return c.includes("catalyst");
  return !["concentration", "earnings", "volatility", "catalyst"].some((k) =>
    c.includes(k),
  );
};

const normalizeTickerForSector = (symbol: string) =>
  symbol.trim().toUpperCase().replace(/\s+/g, "");

const inferSectorFromHolding = (holding: ImportedHolding): string => {
  const securityType = holding.security_type.trim().toUpperCase();
  const symbol = normalizeTickerForSector(holding.symbol);
  const name = (holding.name ?? "").trim().toUpperCase();
  if (securityType.includes("OPTION")) return "Derivatives";
  if (securityType.includes("BOND")) return "Fixed Income";
  if (securityType.includes("FUND") || securityType.includes("ETF")) return "ETF / Diversified";
  const map: Record<string, string> = {
    AMD: "Technology", GOOG: "Communication Services", MU: "Technology",
    WDC: "Technology", SNDK: "Technology", CEG: "Utilities", ETN: "Industrials",
    VST: "Utilities", SLS: "Healthcare", ONDS: "Technology", HG: "Materials",
    GDX: "Materials", XEQT: "ETF / Diversified",
  };
  if (map[symbol]) return map[symbol];
  if (name.includes("TECH") || name.includes("SEMICONDUCTOR")) return "Technology";
  if (name.includes("HEALTH") || name.includes("PHARMA") || name.includes("BIO")) return "Healthcare";
  if (name.includes("ENERGY") || name.includes("POWER") || name.includes("OIL")) return "Energy";
  if (name.includes("BANK") || name.includes("FINANC") || name.includes("INSURANCE")) return "Financials";
  if (name.includes("MINING") || name.includes("GOLD") || name.includes("METAL")) return "Materials";
  if (name.includes("REIT") || name.includes("REAL ESTATE")) return "Real Estate";
  if (name.includes("COMM") || name.includes("MEDIA")) return "Communication Services";
  return "Other";
};

const buildSectorBreakdownFromHoldings = (holdings: ImportedHolding[]): SectorBreakdownEntry[] => {
  const bySector = new Map<string, number>();
  let total = 0;
  for (const h of holdings) {
    const v = convertToCad(h.market_value, h.market_value_currency);
    if (v <= 0) continue;
    const s = inferSectorFromHolding(h);
    total += v;
    bySector.set(s, (bySector.get(s) ?? 0) + v);
  }
  if (total <= 0) return [];
  return [...bySector.entries()]
    .map(([sector, valueCad]) => ({ sector, valueCad, weight: (valueCad / total) * 100 }))
    .sort((a, b) => b.valueCad - a.valueCad);
};

const buildSectorConcerns = (sectors: SectorBreakdownEntry[]): RiskConcern[] =>
  sectors.filter((s) => s.weight >= 30).map((s) => ({
    symbol: "Portfolio",
    title: `${s.sector} concentration`,
    detail: `${s.sector} represents ${s.weight.toFixed(1)}% of the portfolio.`,
    severity: s.weight >= 45 ? "high" : "medium",
    category: "Sector concentration",
    weight: s.weight,
  }));

const mergeUniqueConcerns = (a: RiskConcern[], b: RiskConcern[]): RiskConcern[] => {
  const seen = new Set(a.map((c) => `${c.title}|${c.category}|${c.severity}`));
  const merged = [...a];
  for (const c of b) {
    const key = `${c.title}|${c.category}|${c.severity}`;
    if (!seen.has(key)) { seen.add(key); merged.push(c); }
  }
  return merged;
};

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "concentration", label: "Concentration" },
  { key: "earnings", label: "Earnings" },
  { key: "volatility", label: "Volatility" },
  { key: "catalyst", label: "Catalyst" },
  { key: "other", label: "Other" },
];

function RiskManager() {
  const [analysis, setAnalysis] = useState<RiskAnalysisResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  const loadRiskAnalysis = async () => {
    setIsLoading(true);
    setError(null);
    let holdingsCount = 0;
    let sectorBreakdown: SectorBreakdownEntry[] = [];

    try {
      const holdingsRes = await fetch(`${API_BASE_URL}/holdings`);
      if (holdingsRes.ok) {
        const holdingsData = (await holdingsRes.json()) as HoldingsResponse;
        holdingsCount = holdingsData.holdings.length;
        const sectorRes = await fetch(`${API_BASE_URL}/portfolio/sector-breakdown`);
        if (sectorRes.ok) {
          const sd = (await sectorRes.json()) as SectorBreakdownResponse;
          if ((sd.sectors ?? []).length > 0) sectorBreakdown = sd.sectors;
        }
        if (sectorBreakdown.length === 0) {
          sectorBreakdown = buildSectorBreakdownFromHoldings(holdingsData.holdings);
        }
      }
    } catch { /* best-effort */ }

    try {
      const res = await fetch(`${API_BASE_URL}/risk/analysis`);
      if (!res.ok) throw new Error("Failed to load risk analysis.");
      const data = (await res.json()) as RiskAnalysisResponse;
      const merged = mergeUniqueConcerns(data.concerns, buildSectorConcerns(sectorBreakdown));
      setAnalysis({
        ...data,
        summary: stripPreamble(data.summary ?? ""),
        dashboardSummary: stripPreamble(data.dashboardSummary ?? ""),
        concerns: merged,
        holdingsAnalyzed: data.holdingsAnalyzed || holdingsCount,
      });
    } catch (err) {
      const sectorConcerns = buildSectorConcerns(sectorBreakdown);
      if (holdingsCount > 0) {
        const msg = sectorConcerns.length > 0
          ? `Sector concentration flags: ${sectorConcerns.map((c) => `${c.title.replace(" concentration", "")} (${c.weight?.toFixed(1)}%)`).join(", ")}.`
          : "No major sector overweight detected.";
        setAnalysis({
          summary: msg, dashboardSummary: msg,
          concerns: sectorConcerns,
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

  useEffect(() => { void loadRiskAnalysis(); }, []);

  const sortedConcerns = useMemo(
    () => [...(analysis?.concerns ?? [])].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    ),
    [analysis],
  );

  const filteredConcerns = useMemo(
    () => sortedConcerns.filter((c) => matchesFilter(c, activeFilter)),
    [sortedConcerns, activeFilter],
  );

  const concernCounts = useMemo(() => ({
    high: sortedConcerns.filter((c) => c.severity === "high").length,
    medium: sortedConcerns.filter((c) => c.severity === "medium").length,
    low: sortedConcerns.filter((c) => c.severity === "low").length,
  }), [sortedConcerns]);

  const topChips = sortedConcerns.slice(0, 5);

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="risk-layout">

          {/* ── Header ── */}
          <div className="risk-header">
            <div>
              <h1 className="route-page-title">Risk Manager</h1>
              <p className="route-page-copy">
                Concentration, volatility, earnings, and catalyst risks across your current holdings.
              </p>
            </div>
            <button
              className="risk-refresh-button"
              type="button"
              onClick={loadRiskAnalysis}
              disabled={isLoading}
            >
              {isLoading ? "Scanning…" : "Refresh scan"}
            </button>
          </div>

          {error && <div className="risk-error">{error}</div>}

          {/* ── Top summary chips ── */}
          <div className="risk-summary-chips-card">
            <span className="risk-chips-eyebrow">Top Risks Today</span>
            {isLoading ? (
              <p className="risk-chips-loading">Scanning holdings for risk signals…</p>
            ) : topChips.length === 0 ? (
              <p className="risk-chips-loading">
                {analysis
                  ? "No major concerns detected."
                  : "Import holdings to generate a risk scan."}
              </p>
            ) : (
              <div className="risk-chips-list">
                {topChips.map((c, i) => (
                  <div
                    className={`risk-chip risk-chip-${c.severity}`}
                    key={`chip-${c.symbol}-${i}`}
                  >
                    <span className="risk-chip-icon">{getCategoryIcon(c.category)}</span>
                    {c.symbol && c.symbol !== "Portfolio" && (
                      <strong className="risk-chip-symbol">{c.symbol}</strong>
                    )}
                    <span className="risk-chip-text">{c.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Stats row ── */}
          <div className="risk-stats-row">
            <div className="risk-stat">
              <span className="risk-stat-value">{analysis?.holdingsAnalyzed ?? 0}</span>
              <span className="risk-stat-label">Holdings scanned</span>
            </div>
            <div className="risk-stat">
              <span className="risk-stat-value" style={{ color: concernCounts.high > 0 ? "#ef4444" : undefined }}>
                {concernCounts.high}
              </span>
              <span className="risk-stat-label">High priority</span>
            </div>
            <div className="risk-stat">
              <span className="risk-stat-value" style={{ color: concernCounts.medium > 0 ? "#f59e0b" : undefined }}>
                {concernCounts.medium}
              </span>
              <span className="risk-stat-label">Medium</span>
            </div>
            <div className="risk-stat">
              <span className="risk-stat-value">{concernCounts.low}</span>
              <span className="risk-stat-label">Watch</span>
            </div>
            <div className="risk-stat risk-stat-status">
              <span
                className="risk-stat-value"
                style={{
                  color: concernCounts.high >= 2
                    ? "#ef4444"
                    : concernCounts.high > 0 || concernCounts.medium > 3
                      ? "#f59e0b"
                      : "#22c55e",
                }}
              >
                {concernCounts.high >= 2 ? "Elevated" : concernCounts.high > 0 || concernCounts.medium > 3 ? "Watch" : "Low"}
              </span>
              <span className="risk-stat-label">Portfolio status</span>
            </div>
          </div>

          {/* ── Concern panel ── */}
          <div className="risk-concern-panel">
            <div className="risk-panel-header">
              <h2>Possible Concerns</h2>
              <div className="risk-filter-chips">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={`risk-filter-chip ${activeFilter === f.key ? "risk-filter-chip-active" : ""}`}
                    onClick={() => setActiveFilter(f.key)}
                  >
                    {f.label}
                    {f.key !== "all" && (
                      <span className="risk-filter-count">
                        {sortedConcerns.filter((c) => matchesFilter(c, f.key)).length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {analysis?.generatedAt && (
                <span className="risk-panel-timestamp">
                  {new Date(analysis.generatedAt).toLocaleTimeString()}
                </span>
              )}
            </div>

            {isLoading ? (
              <div className="risk-empty">Loading risk signals…</div>
            ) : filteredConcerns.length === 0 ? (
              <div className="risk-empty">
                {activeFilter === "all"
                  ? "No major concerns found. Keep checking before earnings and after large portfolio moves."
                  : `No ${activeFilter} risks detected.`}
              </div>
            ) : (
              <div className="risk-concern-list">
                {filteredConcerns.map((concern, index) => (
                  <article
                    className={`risk-concern-card risk-concern-card-${concern.severity}`}
                    key={`${concern.symbol}-${concern.title}-${index}`}
                  >
                    <div className="risk-concern-topline">
                      <div className="risk-concern-left">
                        <span className="risk-category-icon">{getCategoryIcon(concern.category)}</span>
                        <span className="risk-symbol">{concern.symbol}</span>
                      </div>
                      <span className={`risk-severity risk-severity-${concern.severity}`}>
                        {severityLabel[concern.severity]}
                      </span>
                    </div>
                    <h3>{concern.title}</h3>
                    <p>{concern.detail}</p>
                    <div className="risk-meta-row">
                      <span className="risk-category-label">{concern.category}</span>
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
