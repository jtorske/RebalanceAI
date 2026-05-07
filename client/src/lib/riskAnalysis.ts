import { convertToCad } from "./holdingsUtils";
import type { ImportedHolding } from "./types";

export type RiskSeverity = "high" | "medium" | "low";

export type RiskConcern = {
  symbol: string;
  title: string;
  detail: string;
  severity: RiskSeverity;
  category: string;
  weight: number | null;
  metrics?: {
    beta?: number;
    marketCap?: number;
    marketCapLabel?: string;
    earningsDate?: string;
    earningsInDays?: number;
    dataQuality?: boolean;
  };
};

export type RiskAnalysisApiResponse = {
  summary?: string | null;
  dashboardSummary?: string | null;
  source?: "groq" | "fallback";
  model?: string | null;
  concerns?: RiskConcern[];
  dataQuality?: {
    metadataIncomplete?: boolean;
    message?: string | null;
  };
  holdingsAnalyzed?: number;
  generatedAt?: string;
};

export type NormalizedRiskAnalysis = {
  summary: string;
  dashboardSummary: string;
  concerns: RiskConcern[];
  mainConcerns: RiskConcern[];
  dataQualityConcerns: RiskConcern[];
  concernTotal: number;
  severityCounts: { high: number; medium: number; low: number };
  score: number;
  dataQualityMessage: string | null;
  holdingsAnalyzed: number;
  generatedAt: string;
};

const DATA_QUALITY_MESSAGE =
  "Some ticker metadata is temporarily unavailable, so risk analysis is based on available holdings data.";
const BROAD_DIVERSIFIED_FUNDS = new Set([
  "XEQT",
  "VEQT",
  "ZEQT",
  "XGRO",
  "VGRO",
  "ZGRO",
  "XBAL",
  "VBAL",
  "VT",
  "VTI",
  "SPY",
  "VOO",
]);

const stripPreamble = (text: string) =>
  text
    .replace(/^here (?:are|is) (?:two|2|some|a few) (?:concise )?sentences?[^:]*:\s*/i, "")
    .replace(/^sure[,!]?\s+here (?:are|is)[^:]*:\s*/i, "")
    .trim();

const repairText = (value: string) =>
  value
    .replaceAll("Ã¢Â€Â™", "'")
    .replaceAll("Ã¢Â€Â˜", "'")
    .replaceAll("Ã¢Â€Âœ", '"')
    .replaceAll("Ã¢Â€Â", '"')
    .replaceAll("Ã¢Â€Â“", "-")
    .replaceAll("Ã¢Â€Â”", "-");

function isBadSummary(value?: string | null) {
  const text = value?.trim();
  if (!text) return true;
  if (text === "1." || text === "1") return true;
  if (/^\d+\.?$/.test(text)) return true;
  if (text.length < 12) return true;
  return false;
}

function isDataQualityConcern(concern: RiskConcern) {
  return (
    concern.category.toLowerCase() === "data quality" ||
    concern.metrics?.dataQuality === true
  );
}

function deriveRiskSummary(concerns: RiskConcern[]) {
  if (concerns.length === 0) {
    return "No major portfolio risks stand out from current holdings.";
  }

  const symbols = [
    ...new Set(
      concerns
        .slice(0, 4)
        .map((c) => c.symbol)
        .filter(Boolean),
    ),
  ];

  if (symbols.length > 0) {
    return `Key risks to review include ${symbols.join(", ")}, driven by concentration, volatility, headline, or catalyst signals.`;
  }

  return `${concerns.length} risk signal${concerns.length > 1 ? "s" : ""} detected across the portfolio.`;
}

function isBroadDiversifiedHolding(holding: ImportedHolding) {
  const symbol = holding.symbol.trim().toUpperCase().replace(/\s+/g, "");
  const securityType = holding.security_type.trim().toUpperCase();
  return (
    BROAD_DIVERSIFIED_FUNDS.has(symbol) &&
    (securityType.includes("ETF") ||
      securityType.includes("FUND") ||
      securityType.includes("EXCHANGE_TRADED"))
  );
}

export function buildFallbackRiskAnalysis(
  holdings: ImportedHolding[],
): NormalizedRiskAnalysis {
  const concerns: RiskConcern[] = [];
  const valueBySymbol = new Map<string, number>();
  let totalValueCad = 0;
  let optionValueCad = 0;

  for (const holding of holdings) {
    const symbol = holding.symbol.trim().toUpperCase();
    const valueCad = convertToCad(
      holding.market_value,
      holding.market_value_currency,
    );
    if (!symbol || valueCad <= 0) continue;

    totalValueCad += valueCad;
    if (!isBroadDiversifiedHolding(holding)) {
      valueBySymbol.set(symbol, (valueBySymbol.get(symbol) ?? 0) + valueCad);
    }
    if (holding.security_type.toUpperCase().includes("OPTION")) {
      optionValueCad += valueCad;
    }
  }

  const weighted = [...valueBySymbol.entries()]
    .map(([symbol, valueCad]) => ({
      symbol,
      weight: totalValueCad > 0 ? (valueCad / totalValueCad) * 100 : 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  const top = weighted[0];
  if (top?.weight >= 30) {
    concerns.push({
      severity: "high",
      symbol: top.symbol,
      title: "Large single-position weight",
      detail: `${top.symbol} is ${top.weight.toFixed(1)}% of the portfolio, so one ticker can dominate outcomes.`,
      category: "Concentration",
      weight: top.weight,
    });
  } else if (top?.weight >= 18) {
    concerns.push({
      severity: "medium",
      symbol: top.symbol,
      title: "Meaningful single-position weight",
      detail: `${top.symbol} is ${top.weight.toFixed(1)}% of the portfolio.`,
      category: "Concentration",
      weight: top.weight,
    });
  }

  const topThreeWeight = weighted
    .slice(0, 3)
    .reduce((sum, item) => sum + item.weight, 0);
  if (topThreeWeight >= 60) {
    concerns.push({
      severity: "medium",
      symbol: "Portfolio",
      title: "Top holdings concentration",
      detail: `The top three holdings are ${topThreeWeight.toFixed(1)}% of the portfolio.`,
      category: "Concentration",
      weight: topThreeWeight,
    });
  }

  const optionWeight =
    totalValueCad > 0 ? (optionValueCad / totalValueCad) * 100 : 0;
  if (optionWeight >= 10) {
    concerns.push({
      severity: "high",
      symbol: "Options",
      title: "Options exposure",
      detail: `Options represent ${optionWeight.toFixed(1)}% of total value.`,
      category: "Derivatives",
      weight: optionWeight,
    });
  } else if (optionWeight >= 2) {
    concerns.push({
      severity: "low",
      symbol: "Options",
      title: "Options exposure",
      detail: `Options represent ${optionWeight.toFixed(1)}% of total value.`,
      category: "Derivatives",
      weight: optionWeight,
    });
  }

  const severityCounts = {
    high: concerns.filter((c) => c.severity === "high").length,
    medium: concerns.filter((c) => c.severity === "medium").length,
    low: concerns.filter((c) => c.severity === "low").length,
  };
  const summary = deriveRiskSummary(concerns);
  const score = Math.min(
    100,
    severityCounts.high * 15 +
      severityCounts.medium * 5 +
      severityCounts.low * 2,
  );

  return {
    summary,
    dashboardSummary: summary,
    concerns,
    mainConcerns: concerns,
    dataQualityConcerns: [],
    concernTotal: concerns.length,
    severityCounts,
    score,
    dataQualityMessage: null,
    holdingsAnalyzed: holdings.length,
    generatedAt: new Date().toISOString(),
  };
}

export function normalizeRiskAnalysis(
  data: RiskAnalysisApiResponse | null | undefined,
  holdings: ImportedHolding[] = [],
): NormalizedRiskAnalysis {
  const rawConcerns = data?.concerns ?? [];
  const filteredConcerns = rawConcerns.filter((concern) => {
    const title = concern.title.toLowerCase();
    const category = concern.category.toLowerCase();
    return !(
      concern.symbol === "Portfolio" &&
      category === "sector concentration" &&
      (title.includes("other concentration") ||
        title.includes("unknown concentration"))
    );
  });

  const mainConcerns = filteredConcerns.filter(
    (concern) => !isDataQualityConcern(concern),
  );
  const dataQualityConcerns = filteredConcerns.filter(isDataQualityConcern);
  const fallback =
    holdings.length > 0 && mainConcerns.length === 0
      ? buildFallbackRiskAnalysis(holdings)
      : null;

  if (fallback && fallback.mainConcerns.length > 0) {
    return fallback;
  }

  const rawSummary = data?.dashboardSummary || data?.summary || null;
  const cleanedSummary = rawSummary
    ? stripPreamble(repairText(rawSummary))
    : null;
  const summary: string = isBadSummary(cleanedSummary)
    ? deriveRiskSummary(mainConcerns)
    : cleanedSummary ?? deriveRiskSummary(mainConcerns);

  const severityCounts = {
    high: mainConcerns.filter((c) => c.severity === "high").length,
    medium: mainConcerns.filter((c) => c.severity === "medium").length,
    low: mainConcerns.filter((c) => c.severity === "low").length,
  };
  const score = Math.min(
    100,
    severityCounts.high * 15 +
      severityCounts.medium * 5 +
      severityCounts.low * 2,
  );
  const metadataIncomplete =
    data?.dataQuality?.metadataIncomplete || dataQualityConcerns.length > 0;
  const dataQualityMessage = metadataIncomplete
    ? data?.dataQuality?.message || DATA_QUALITY_MESSAGE
    : null;

  return {
    summary:
      mainConcerns.length === 0 && dataQualityMessage
        ? dataQualityMessage
        : summary,
    dashboardSummary:
      mainConcerns.length === 0 && dataQualityMessage
        ? dataQualityMessage
        : summary,
    concerns: filteredConcerns,
    mainConcerns,
    dataQualityConcerns,
    concernTotal: mainConcerns.length,
    severityCounts,
    score,
    dataQualityMessage,
    holdingsAnalyzed: data?.holdingsAnalyzed ?? holdings.length,
    generatedAt: data?.generatedAt ?? new Date().toISOString(),
  };
}
