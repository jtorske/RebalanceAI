type RiskConcernInput = {
  symbol: string;
  category: string;
  severity: "high" | "medium" | "low";
  weight: number | null;
  metrics?: {
    beta?: number;
    earningsInDays?: number;
    earningsDate?: string;
  };
};

export function buildRiskAction(concern: RiskConcernInput): string {
  const { category, symbol, weight, metrics } = concern;

  switch (category) {
    case "Concentration": {
      if (weight !== null && weight >= 35) {
        return `Consider trimming ${symbol} toward 20–25% or lower to reduce single-position risk. Use the Re-weight page to model a reduction scenario.`;
      }
      return `Monitor ${symbol}'s position size. Setting a max single-stock limit in Re-weight rules can prevent further concentration drift.`;
    }

    case "Sector concentration": {
      return `Consider diversifying into other sectors to bring exposure below 30%. Review the Re-weight page to model a more balanced sector allocation.`;
    }

    case "Volatility": {
      if (metrics?.beta !== undefined) {
        return `${symbol}'s beta of ${metrics.beta.toFixed(2)} amplifies both gains and losses relative to the market. Consider keeping its allocation within your max single-stock % unless you intentionally want higher-volatility exposure.`;
      }
      return `Review ${symbol}'s allocation relative to your risk tolerance. A smaller position size reduces the impact of sharp price moves on the overall portfolio.`;
    }

    case "Earnings": {
      const daysAway = metrics?.earningsInDays;
      if (daysAway !== undefined && daysAway <= 3) {
        return `Earnings are imminent. Avoid adding to ${symbol} before the announcement. Consider whether your current position size matches your tolerance for a binary event outcome.`;
      }
      return `Review your position size in ${symbol} ahead of earnings. Consider whether you want to reduce exposure before the announcement given the potential for large price swings.`;
    }

    case "Market cap": {
      return `Refresh market data or enter a market cap manually on the Re-weight page before relying on market-cap weighting for ${symbol}. Missing data may skew target allocations.`;
    }

    case "Liquidity": {
      return `Limit the size of any trade in ${symbol} and use limit orders rather than market orders to reduce slippage risk.`;
    }

    case "Catalyst": {
      return `Review the upcoming event for ${symbol} and assess whether your current exposure is appropriate. Consider reducing position size if the event outcome is uncertain.`;
    }

    case "Data quality": {
      return `Verify the data for ${symbol} before acting on any rebalance or risk signals that depend on it. Missing or stale data may affect accuracy.`;
    }

    default: {
      if (weight !== null && weight >= 20) {
        return `Review your allocation in ${symbol} (${weight.toFixed(1)}% of portfolio) and consider whether this exposure is intentional given the identified risk.`;
      }
      return `Monitor this signal for ${symbol} and revisit your allocation if conditions change.`;
    }
  }
}
