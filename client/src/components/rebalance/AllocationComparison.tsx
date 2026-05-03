import { useState } from "react";
import "./AllocationComparison.css";

export type AllocationRow = {
  symbol: string;
  name: string;
  currentPct: number;
  targetPct: number | null;
  afterPct: number | null;
  driftAfter: number | null;
  action: "buy" | "sell" | "hold";
};

type Props = {
  rows: AllocationRow[];
};

const DEFAULT_VISIBLE = 8;

function fmt(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)}%`;
}

function fmtDrift(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function AllocationComparison({ rows }: Props) {
  const [showAll, setShowAll] = useState(false);

  const sorted = [...rows].sort((a, b) => b.currentPct - a.currentPct);
  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_VISIBLE);
  const hasMore = sorted.length > DEFAULT_VISIBLE;

  const maxPct = sorted.slice(0, DEFAULT_VISIBLE).reduce((m, r) => {
    return Math.max(m, r.currentPct, r.targetPct ?? 0, r.afterPct ?? 0);
  }, 0);

  const barWidth = (pct: number | null) =>
    maxPct > 0 && pct !== null ? `${Math.min((pct / maxPct) * 100, 100)}%` : "0%";

  return (
    <div className="ac-wrap">
      <div className="ac-header-row">
        <h2 className="ac-title">Allocation Comparison</h2>
        {hasMore && (
          <button
            type="button"
            className="ac-toggle-btn"
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? "Show Top 8" : `Show All ${sorted.length}`}
          </button>
        )}
      </div>

      <div className="ac-table-scroll">
        <table className="ac-table">
          <thead>
            <tr>
              <th className="ac-col-symbol">Asset</th>
              <th className="ac-col-pct">Current %</th>
              <th className="ac-col-pct">Target %</th>
              <th className="ac-col-pct">After %</th>
              <th className="ac-col-drift">Drift After</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const driftClass =
                row.driftAfter === null
                  ? ""
                  : Math.abs(row.driftAfter) < 0.5
                  ? "ac-drift-neutral"
                  : row.driftAfter > 0
                  ? "ac-drift-over"
                  : "ac-drift-under";

              return (
                <tr key={row.symbol}>
                  <td className="ac-cell-symbol">
                    <span className="ac-symbol">{row.symbol}</span>
                    <span className="ac-name">{row.name}</span>
                  </td>

                  <td className="ac-cell-pct">
                    <span className="ac-pct-value">
                      {fmt(row.currentPct)}
                    </span>
                    <div className="ac-bar-track">
                      <div
                        className="ac-bar-fill ac-bar-current"
                        style={{ width: barWidth(row.currentPct) }}
                      />
                    </div>
                  </td>

                  <td className="ac-cell-pct">
                    <span className="ac-pct-value">
                      {fmt(row.targetPct)}
                    </span>
                    <div className="ac-bar-track">
                      <div
                        className="ac-bar-fill ac-bar-target"
                        style={{ width: barWidth(row.targetPct) }}
                      />
                    </div>
                  </td>

                  <td className="ac-cell-pct">
                    <span className="ac-pct-value">
                      {fmt(row.afterPct)}
                    </span>
                    <div className="ac-bar-track">
                      <div
                        className={`ac-bar-fill ${
                          row.action === "buy"
                            ? "ac-bar-after-buy"
                            : row.action === "sell"
                            ? "ac-bar-after-sell"
                            : "ac-bar-after-hold"
                        }`}
                        style={{ width: barWidth(row.afterPct) }}
                      />
                    </div>
                  </td>

                  <td className={`ac-cell-drift ${driftClass}`}>
                    {fmtDrift(row.driftAfter)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="ac-legend">
        <span className="ac-legend-item ac-legend-current">Current</span>
        <span className="ac-legend-item ac-legend-target">Target</span>
        <span className="ac-legend-item ac-legend-after-buy">After (buy)</span>
        <span className="ac-legend-item ac-legend-after-sell">After (sell)</span>
        <span className="ac-legend-item ac-legend-after-hold">After (hold)</span>
      </div>
    </div>
  );
}
