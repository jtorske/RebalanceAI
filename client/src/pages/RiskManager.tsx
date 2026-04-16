import { useEffect, useState } from "react";
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

  if (symbolSectorMap[symbol]) {
    return symbolSectorMap[symbol];
  }

  if (name.includes("TECH") || name.includes("SEMICONDUCTOR")) {
    return "Technology";
  }
  if (
    name.includes("HEALTH") ||
    name.includes("PHARMA") ||
    name.includes("BIO")
  ) {
    return "Healthcare";
  }
  if (
    name.includes("ENERGY") ||
    name.includes("POWER") ||
    name.includes("OIL")
  ) {
    return "Energy";
  }
  if (
    name.includes("BANK") ||
    name.includes("FINANC") ||
    name.includes("INSURANCE")
  ) {
    return "Financials";
  }
  if (
    name.includes("MINING") ||
    name.includes("GOLD") ||
    name.includes("METAL")
  ) {
    return "Materials";
  }
  if (name.includes("REIT") || name.includes("REAL ESTATE")) {
    return "Real Estate";
  }
  if (name.includes("COMM") || name.includes("MEDIA")) {
    return "Communication Services";
  }

  return "Other";
};

const buildSectorBreakdownFromHoldings = (
  holdings: ImportedHolding[],
): SectorBreakdownEntry[] => {
  const bySector = new Map<string, number>();
  let totalValueCad = 0;

  for (const holding of holdings) {
    const valueCad = convertToCad(
      holding.market_value,
      holding.market_value_currency,
    );
    if (valueCad <= 0) {
      continue;
    }

    const sector = inferSectorFromHolding(holding);
    totalValueCad += valueCad;
    bySector.set(sector, (bySector.get(sector) ?? 0) + valueCad);
  }

  if (totalValueCad <= 0) {
    return [];
  }

  return [...bySector.entries()]
    .map(([sector, valueCad]) => ({
      sector,
      valueCad,
      weight: (valueCad / totalValueCad) * 100,
    }))
    .sort((a, b) => b.valueCad - a.valueCad);
};

const buildSectorConcentrationConcerns = (
  sectors: SectorBreakdownEntry[],
): RiskConcern[] => {
  return sectors
    .filter((sector) => sector.weight >= 30)
    .map((sector) => ({
      symbol: "Portfolio",
      title: `${sector.sector} concentration`,
      detail: `${sector.sector} represents ${sector.weight.toFixed(1)}% of the portfolio.`,
      severity: sector.weight >= 45 ? "high" : "medium",
      category: "Sector concentration",
      weight: sector.weight,
    }));
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
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    merged.push(concern);
  }

  return merged;
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

    let holdingsCount = 0;
    let sectorBreakdown: SectorBreakdownEntry[] = [];

    try {
      const holdingsRes = await fetch(`${API_BASE_URL}/holdings`);
      if (holdingsRes.ok) {
        const holdingsData = (await holdingsRes.json()) as HoldingsResponse;
        holdingsCount = holdingsData.holdings.length;

        const sectorRes = await fetch(
          `${API_BASE_URL}/portfolio/sector-breakdown`,
        );
        if (sectorRes.ok) {
          const sectorData =
            (await sectorRes.json()) as SectorBreakdownResponse;
          if ((sectorData.sectors ?? []).length > 0) {
            sectorBreakdown = sectorData.sectors;
          }
        }

        if (sectorBreakdown.length === 0) {
          sectorBreakdown = buildSectorBreakdownFromHoldings(
            holdingsData.holdings,
          );
        }
      }
    } catch {
      // Best-effort preload only; risk endpoint fetch below still proceeds.
    }

    try {
      const response = await fetch(`${API_BASE_URL}/risk/analysis`);
      if (!response.ok) {
        throw new Error("Failed to load risk analysis.");
      }
      const data = (await response.json()) as RiskAnalysisResponse;
      const sectorConcerns = buildSectorConcentrationConcerns(sectorBreakdown);
      const mergedConcerns = mergeUniqueConcerns(data.concerns, sectorConcerns);

      setAnalysis({
        ...data,
        concerns: mergedConcerns,
        holdingsAnalyzed: data.holdingsAnalyzed || holdingsCount,
      });
    } catch (err) {
      const sectorConcerns = buildSectorConcentrationConcerns(sectorBreakdown);
      if (holdingsCount > 0) {
        setAnalysis({
          summary:
            sectorConcerns.length > 0
              ? `Sector concentration flags: ${sectorConcerns
                  .map(
                    (item) =>
                      `${item.title.replace(" concentration", "")} (${item.weight?.toFixed(1)}%)`,
                  )
                  .join(", ")}.`
              : "No major sector overweight was detected from the current holdings.",
          dashboardSummary:
            sectorConcerns.length > 0
              ? `Sector concentration flags: ${sectorConcerns
                  .map(
                    (item) =>
                      `${item.title.replace(" concentration", "")} (${item.weight?.toFixed(1)}%)`,
                  )
                  .join(", ")}.`
              : "No major sector overweight was detected from the current holdings.",
          concerns: sectorConcerns,
          holdingsAnalyzed: holdingsCount,
          generatedAt: new Date().toISOString(),
        });
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to load risk analysis.",
        );
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
    high:
      analysis?.concerns.filter((item) => item.severity === "high").length ?? 0,
    medium:
      analysis?.concerns.filter((item) => item.severity === "medium").length ??
      0,
    low:
      analysis?.concerns.filter((item) => item.severity === "low").length ?? 0,
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
