import { convertToCad } from "../lib/holdingsUtils";
import type { ImportedHolding, MarketComparisonTicker } from "../lib/types";

export type AggregatedHolding = {
  symbol: string;
  totalMarketValue: number;
  totalWeight: number;
  weightedDailyReturn: number;
  contribution: number;
  dollarContribution: number;
  positions: ImportedHolding[];
};

type AttributionWarning = {
  code: string;
  message: string;
  symbol?: string;
};

const normalizeSymbol = (symbol: string) =>
  symbol.trim().toUpperCase().replace(/\s+/g, "");

const warnAttribution = (warnings: AttributionWarning[]) => {
  if (warnings.length === 0 || !import.meta.env.DEV) return;
  console.warn("[portfolio-attribution] validation warnings", warnings);
};

export const calculateContribution = (
  weightPercent: number,
  dailyReturnPercent: number,
) => (weightPercent / 100) * dailyReturnPercent;

export const calculateDollarContribution = (
  marketValue: number,
  dailyReturnPercent: number,
) => {
  const dailyRate = dailyReturnPercent / 100;
  if (!Number.isFinite(dailyRate) || dailyRate <= -0.999999) return 0;
  const priorCloseValue = marketValue / (1 + dailyRate);
  return marketValue - priorCloseValue;
};

export function aggregateHoldingsBySymbol(
  holdings: ImportedHolding[],
  perTicker: MarketComparisonTicker[] | undefined,
): AggregatedHolding[] {
  const warnings: AttributionWarning[] = [];
  const valueBySymbol = new Map<
    string,
    { symbol: string; totalMarketValue: number; positions: ImportedHolding[] }
  >();

  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding.symbol);
    if (!symbol) {
      warnings.push({
        code: "missing-symbol",
        message: "Skipped holding with no symbol.",
      });
      continue;
    }

    const marketValue = convertToCad(
      holding.market_value,
      holding.market_value_currency,
    );
    if (!Number.isFinite(marketValue) || marketValue <= 0) {
      warnings.push({
        code: "invalid-market-value",
        message: "Skipped holding with missing or non-positive market value.",
        symbol,
      });
      continue;
    }

    const existing = valueBySymbol.get(symbol);
    if (existing) {
      existing.totalMarketValue += marketValue;
      existing.positions.push(holding);
    } else {
      valueBySymbol.set(symbol, {
        symbol,
        totalMarketValue: marketValue,
        positions: [holding],
      });
    }
  }

  const totalMarketValue = [...valueBySymbol.values()].reduce(
    (sum, item) => sum + item.totalMarketValue,
    0,
  );
  if (totalMarketValue <= 0) {
    warnAttribution(warnings);
    return [];
  }

  const dailyBySymbol = new Map<string, number[]>();
  for (const item of perTicker ?? []) {
    const symbol = normalizeSymbol(item.symbol);
    if (!symbol || typeof item.dailyPercent !== "number") continue;
    if (!Number.isFinite(item.dailyPercent)) {
      warnings.push({
        code: "invalid-daily-return",
        message: "Skipped ticker with non-finite daily return.",
        symbol,
      });
      continue;
    }
    dailyBySymbol.set(symbol, [
      ...(dailyBySymbol.get(symbol) ?? []),
      item.dailyPercent,
    ]);
  }

  const aggregated: AggregatedHolding[] = [];
  for (const item of valueBySymbol.values()) {
    const dailyValues = dailyBySymbol.get(item.symbol);
    if (!dailyValues || dailyValues.length === 0) {
      warnings.push({
        code: "missing-daily-return",
        message: "Skipped symbol with no daily return data.",
        symbol: item.symbol,
      });
      continue;
    }

    const weightedDailyReturn =
      dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length;
    const totalWeight = (item.totalMarketValue / totalMarketValue) * 100;
    const contribution = calculateContribution(
      totalWeight,
      weightedDailyReturn,
    );
    const dollarContribution = calculateDollarContribution(
      item.totalMarketValue,
      weightedDailyReturn,
    );

    if (
      !Number.isFinite(weightedDailyReturn) ||
      !Number.isFinite(contribution) ||
      !Number.isFinite(dollarContribution)
    ) {
      warnings.push({
        code: "invalid-contribution",
        message: "Skipped symbol with invalid attribution output.",
        symbol: item.symbol,
      });
      continue;
    }

    aggregated.push({
      symbol: item.symbol,
      totalMarketValue: item.totalMarketValue,
      totalWeight,
      weightedDailyReturn,
      contribution,
      dollarContribution,
      positions: item.positions,
    });
  }

  const totalWeight = aggregated.reduce((sum, item) => sum + item.totalWeight, 0);
  if (totalWeight > 100.5) {
    warnings.push({
      code: "weight-over-100",
      message: `Aggregated attribution weights total ${totalWeight.toFixed(2)}%.`,
    });
  }

  warnAttribution(warnings);
  return aggregated;
}

export const sortContributors = (
  holdings: AggregatedHolding[],
  maxItems = 3,
) =>
  holdings
    .filter((item) => item.dollarContribution > 0)
    .sort((a, b) => b.dollarContribution - a.dollarContribution)
    .slice(0, maxItems);

export const sortDetractors = (holdings: AggregatedHolding[], maxItems = 3) =>
  holdings
    .filter((item) => item.dollarContribution < 0)
    .sort((a, b) => a.dollarContribution - b.dollarContribution)
    .slice(0, maxItems);

export const formatContribution = (contribution: number) =>
  `${contribution >= 0 ? "+" : ""}${contribution.toFixed(2)}pp`;
