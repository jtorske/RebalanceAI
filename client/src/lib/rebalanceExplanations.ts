type ExplainableItem = {
  symbol: string;
  name: string;
  assetClass: string;
  currentWeight: number;
  targetWeight: number | null;
  driftPct: number | null;
  tradeCad: number | null;
  tradeShares: number | null;
  action: "buy" | "sell" | "hold";
  marketCap: number | null;
  includedInRebalance: boolean;
  reason: string;
};

type ExplainableContext = {
  totalValueCad: number;
  settings: { maxSingleStockPct: number };
  targetMode: string;
};

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)}%`;
}

function fmtCad(v: number | null): string {
  if (v === null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}

function targetModeLabel(mode: string): string {
  switch (mode) {
    case "capped_market_cap": return "market-cap weighted (capped)";
    case "market_cap": return "market-cap weighted";
    case "equal": return "equal-weight";
    case "sqrt_market_cap": return "square-root market-cap weighted";
    case "manual": return "your custom targets";
    default: return mode;
  }
}

export function buildTradeExplanation(
  item: ExplainableItem,
  ctx: ExplainableContext,
): string[] {
  const lines: string[] = [];
  const { targetMode, settings } = ctx;

  if (!item.includedInRebalance) {
    lines.push(`${item.symbol} is excluded from the rebalance plan.`);
    if (item.reason) lines.push(`Reason: ${item.reason}.`);
    return lines;
  }

  if (item.action === "hold") {
    lines.push(`${item.symbol} is already close to its target — no trade needed.`);
    if (item.targetWeight !== null) {
      lines.push(
        `Current allocation is ${fmtPct(item.currentWeight)}, target is ${fmtPct(item.targetWeight)}.`,
      );
    }
    if (item.driftPct !== null && Math.abs(item.driftPct) < 1) {
      lines.push("Drift is under 1%, which is within the rebalance threshold.");
    }
    return lines;
  }

  // Buy case
  if (item.action === "buy") {
    lines.push(
      `${item.symbol} is underweight relative to its ${targetModeLabel(targetMode)} target.`,
    );
    lines.push(
      `Current: ${fmtPct(item.currentWeight)} → Target: ${fmtPct(item.targetWeight)}` +
        (item.driftPct !== null ? ` (gap: ${fmtPct(Math.abs(item.driftPct))})` : "") +
        ".",
    );
    if (item.tradeCad !== null) {
      lines.push(
        `Buying ${fmtCad(item.tradeCad)}` +
          (item.tradeShares !== null ? ` (~${item.tradeShares.toFixed(2)} shares)` : "") +
          " would bring it in line with the target.",
      );
    }
    return lines;
  }

  // Sell case
  if (item.action === "sell") {
    lines.push(
      `${item.symbol} is overweight relative to its ${targetModeLabel(targetMode)} target.`,
    );
    lines.push(
      `Current: ${fmtPct(item.currentWeight)} → Target: ${fmtPct(item.targetWeight)}` +
        (item.driftPct !== null ? ` (excess: ${fmtPct(Math.abs(item.driftPct))})` : "") +
        ".",
    );
    if (item.tradeCad !== null) {
      lines.push(
        `Selling ${fmtCad(Math.abs(item.tradeCad))}` +
          (item.tradeShares !== null
            ? ` (~${Math.abs(item.tradeShares).toFixed(2)} shares)`
            : "") +
          " would bring it in line with the target.",
      );
    }
    // Warn if at the single-stock cap
    if (
      item.targetWeight !== null &&
      Math.abs(item.targetWeight - settings.maxSingleStockPct) < 0.5
    ) {
      lines.push(
        `Note: the target is capped at ${fmtPct(settings.maxSingleStockPct)} (single-stock concentration limit).`,
      );
    }
    return lines;
  }

  return lines;
}
