import { useEffect, useMemo, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar";
import "./RoutePage.css";
import "./Reweight.css";
import { API_BASE_URL } from "../lib/constants";
import { useUserSettings } from "../lib/userSettings";
import { buildTradeExplanation } from "../lib/rebalanceExplanations";

type TargetMode =
  | "capped_market_cap"
  | "market_cap"
  | "equal"
  | "sqrt_market_cap"
  | "manual";
type SortDirection = "asc" | "desc";
type ReweightSortKey =
  | "symbol"
  | "assetClass"
  | "currentValueCad"
  | "currentWeight"
  | "targetWeight"
  | "driftPct"
  | "tradeCad"
  | "tradeShares"
  | "marketCap";

type ReweightItem = {
  symbol: string;
  name: string;
  securityType: string;
  assetClass: string;
  quantity: number;
  priceCad: number | null;
  currentValueCad: number;
  currentWeight: number;
  targetWeight: number | null;
  targetValueCad: number | null;
  driftPct: number | null;
  tradeCad: number | null;
  tradeShares: number | null;
  action: "buy" | "sell" | "hold";
  marketCap: number | null;
  includedInRebalance: boolean;
  targetEligible: boolean;
  reason: string;
};

type ReweightResponse = {
  items: ReweightItem[];
  totalValueCad: number;
  cashCad: number;
  targetMode: TargetMode;
  totalBuyCad: number;
  totalSellCad: number;
  excludedCount: number;
  settings: { maxSingleStockPct: number };
  notes: string[];
  generatedAt: string;
};

function formatCad(value: number | null): string {
  if (value === null) return "-";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMarketCap(value: number | null): string {
  if (value === null) return "-";
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toLocaleString()}`;
}

function formatPct(value: number | null): string {
  if (value === null) return "-";
  return `${value.toFixed(2)}%`;
}

function formatShares(value: number | null): string {
  if (value === null) return "-";
  return Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(4);
}

function parseMarketCapBillions(value: string): number | null {
  const parsed = Number.parseFloat(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed * 1e9;
}

function getSortValue(item: ReweightItem, key: ReweightSortKey): string | number | null {
  if (key === "symbol") return item.symbol;
  if (key === "assetClass") return item.assetClass;
  return item[key];
}

const MODE_LABELS: Record<TargetMode, string> = {
  capped_market_cap: "Capped Market Cap",
  market_cap: "Market Cap",
  equal: "Equal Weight",
  sqrt_market_cap: "Sqrt Market Cap",
  manual: "Custom Targets",
};

function Reweight() {
  const { settings } = useUserSettings();
  const [data, setData] = useState<ReweightResponse | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>("capped_market_cap");
  const [cashCad, setCashCad] = useState(0);
  const [driftThresholdPct, setDriftThresholdPct] = useState(2);
  const [minTradeCad, setMinTradeCad] = useState(50);
  const [maxSingleStockPct, setMaxSingleStockPct] = useState(20);
  const [fractionalShares, setFractionalShares] = useState(true);
  const [cashFirst, setCashFirst] = useState(true);
  const [noSell, setNoSell] = useState(false);
  const [manualTargets, setManualTargets] = useState<Record<string, number>>({});
  const [manualMarketCaps, setManualMarketCaps] = useState<Record<string, string>>({});
  const [sortKey, setSortKey] = useState<ReweightSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explainItem, setExplainItem] = useState<ReweightItem | null>(null);

  const manualTargetList = useMemo(
    () =>
      Object.entries(manualTargets)
        .filter(([, w]) => Number.isFinite(w) && w >= 0)
        .map(([symbol, targetWeight]) => ({ symbol, targetWeight })),
    [manualTargets],
  );

  const buildManualMarketCapPayload = (caps: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(caps)
        .map(([k, v]) => [k, parseMarketCapBillions(v)])
        .filter(([, v]) => v !== null),
    );

  const fetchReweight = async (marketCapOverrides: Record<string, string> = {}) => {
    const marketCapsToSend = { ...manualMarketCaps, ...marketCapOverrides };
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/reweight/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetMode,
          cashCad,
          driftThresholdPct,
          minTradeCad,
          maxSingleStockPct,
          fractionalShares,
          cashFirst,
          noSell,
          manualTargets: targetMode === "manual" ? manualTargetList : [],
          manualMarketCaps: buildManualMarketCapPayload(marketCapsToSend),
        }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const json = (await res.json()) as ReweightResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reweight data");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchReweight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasNoHoldings = data && data.items.length === 0;
  const missingCapItems = data?.items.filter((i) => i.reason === "Missing market cap") ?? [];
  const enteredManualCapCount = Object.values(manualMarketCaps).filter(
    (value) => parseMarketCapBillions(value) !== null,
  ).length;
  const buyItems = data?.items.filter((i) => i.action === "buy") ?? [];
  const sellItems = data?.items.filter((i) => i.action === "sell") ?? [];
  const atomicItems =
    data?.items.filter(
      (i) =>
        i.includedInRebalance &&
        !i.targetEligible &&
        ["etf", "mutual_fund", "bond"].includes(i.assetClass),
    ) ?? [];

  const sortedItems = useMemo(() => {
    const items = data?.items ?? [];
    if (!sortKey || !sortDirection) return items;
    const dir = sortDirection === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const av = getSortValue(a, sortKey);
      const bv = getSortValue(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [data, sortDirection, sortKey]);

  const topHoldingAfter = useMemo(() => {
    if (!data) return null;
    return (
      data.items
        .filter((i) => i.targetWeight !== null && i.includedInRebalance)
        .sort((a, b) => (b.targetWeight ?? 0) - (a.targetWeight ?? 0))[0] ?? null
    );
  }, [data]);

  const handleSort = (key: ReweightSortKey) => {
    if (sortKey !== key || !sortDirection) { setSortKey(key); setSortDirection("desc"); return; }
    if (sortDirection === "desc") { setSortDirection("asc"); return; }
    setSortKey(null); setSortDirection(null);
  };

  const getSortLabel = (key: ReweightSortKey) => {
    if (sortKey !== key || !sortDirection) return "";
    return sortDirection === "asc" ? " ↑" : " ↓";
  };

  const setManualTarget = (symbol: string, value: string) => {
    const parsed = Number.parseFloat(value);
    setManualTargets((cur) => ({ ...cur, [symbol]: Number.isFinite(parsed) ? parsed : 0 }));
  };

  const maskDollar = (v: string) => (settings.hideDollarAmounts ? "..." : v);

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <div className="rw-layout">

          {/* ── Header ── */}
          <div className="rw-header-row">
            <div>
              <h1 className="rw-title">Reweight</h1>
              <p className="rw-subtitle">
                Build a rebalance plan from your live holdings using market-cap
                targets, equal weight, or custom allocations.
              </p>
            </div>
            <button
              className="rw-generate-btn"
              onClick={() => void fetchReweight()}
              disabled={isLoading}
            >
              {isLoading ? "Generating…" : "Generate Plan"}
            </button>
          </div>

          {/* ── Controls ── */}
          <section className="rw-controls-wrap">
            <div className="rw-controls-group">
              <span className="rw-controls-group-label">Strategy</span>
              <label className="rw-field">
                Target method
                <select
                  value={targetMode}
                  onChange={(e) => setTargetMode(e.target.value as TargetMode)}
                >
                  <option value="capped_market_cap">Capped Market Cap</option>
                  <option value="market_cap">Market Cap</option>
                  <option value="equal">Equal weight</option>
                  <option value="sqrt_market_cap">Square Root Market Cap</option>
                  <option value="manual">Custom Targets</option>
                </select>
              </label>
            </div>

            <div className="rw-controls-group">
              <span className="rw-controls-group-label">Parameters</span>
              <div className="rw-controls-params">
                <label className="rw-field">
                  Cash (CA$)
                  <input type="number" min="0" value={cashCad}
                    onChange={(e) => setCashCad(Number(e.target.value))} />
                </label>
                <label className="rw-field">
                  Drift %
                  <input type="number" min="0" step="0.25" value={driftThresholdPct}
                    onChange={(e) => setDriftThresholdPct(Number(e.target.value))} />
                </label>
                <label className="rw-field">
                  Min trade
                  <input type="number" min="0" step="5" value={minTradeCad}
                    onChange={(e) => setMinTradeCad(Number(e.target.value))} />
                </label>
                {targetMode === "capped_market_cap" && (
                  <label className="rw-field">
                    Max stock %
                    <input type="number" min="1" max="100" step="1" value={maxSingleStockPct}
                      onChange={(e) => setMaxSingleStockPct(Number(e.target.value))} />
                  </label>
                )}
              </div>
            </div>

            <div className="rw-controls-group">
              <span className="rw-controls-group-label">Rules</span>
              <div className="rw-controls-toggles">
                <label className="rw-toggle">
                  <input type="checkbox" checked={fractionalShares}
                    onChange={(e) => setFractionalShares(e.target.checked)} />
                  Fractional shares
                </label>
                <label className="rw-toggle">
                  <input type="checkbox" checked={cashFirst}
                    onChange={(e) => setCashFirst(e.target.checked)} />
                  Cash-first
                </label>
                <label className="rw-toggle">
                  <input type="checkbox" checked={noSell}
                    onChange={(e) => setNoSell(e.target.checked)} />
                  No-sell mode
                </label>
              </div>
            </div>
          </section>

          {/* ── Rules Applied badges ── */}
          <div className="rw-rules-applied">
            <span className="rw-rules-label">Rules Applied</span>
            <div className="rw-rules-badges">
              <span className="rw-rule-badge">✓ {MODE_LABELS[targetMode]}</span>
              {targetMode === "capped_market_cap" && (
                <span className="rw-rule-badge">✓ Max stock {maxSingleStockPct}%</span>
              )}
              {atomicItems.length > 0 && (
                <span className="rw-rule-badge">✓ ETFs preserved</span>
              )}
              {fractionalShares && (
                <span className="rw-rule-badge">✓ Fractional shares</span>
              )}
              {cashFirst && <span className="rw-rule-badge">✓ Cash-first</span>}
              {noSell && (
                <span className="rw-rule-badge rw-rule-badge-warn">⚠ No-sell mode</span>
              )}
              <span className="rw-rule-badge">✓ Drift ≥ {driftThresholdPct}%</span>
              <span className="rw-rule-badge">✓ Min trade CA${minTradeCad}</span>
              {data?.notes.map((note) => (
                <span className="rw-rule-badge rw-rule-badge-info" key={note}>
                  ↳ {note}
                </span>
              ))}
            </div>
          </div>

          {error && <div className="rw-error">{error}</div>}

          {hasNoHoldings && !isLoading && (
            <div className="rw-empty">
              No holdings found. Import your portfolio on the Holdings page first.
            </div>
          )}

          {/* ── KPI Summary ── */}
          {data && !hasNoHoldings && (
            <div className="rw-summary-grid">
              <div className="rw-summary-card rw-summary-card--blue">
                <span className="rw-summary-label">Portfolio Value</span>
                <span className="rw-summary-value">
                  {maskDollar(formatCad(data.totalValueCad))}
                </span>
                <span className="rw-summary-note">{data.items.length} positions</span>
              </div>
              <div className="rw-summary-card rw-summary-card--neutral">
                <span className="rw-summary-label">Cash Applied</span>
                <span className="rw-summary-value">
                  {maskDollar(formatCad(data.cashCad))}
                </span>
                <span className="rw-summary-note">available capital</span>
              </div>
              <div className="rw-summary-card rw-summary-card--green">
                <span className="rw-summary-label">Buy Orders</span>
                <span className="rw-summary-value rw-positive">
                  {maskDollar(formatCad(data.totalBuyCad))}
                </span>
                <span className="rw-summary-note">{buyItems.length} trades</span>
              </div>
              <div className="rw-summary-card rw-summary-card--red">
                <span className="rw-summary-label">Sell Orders</span>
                <span className="rw-summary-value rw-negative">
                  {maskDollar(formatCad(Math.abs(data.totalSellCad)))}
                </span>
                <span className="rw-summary-note">{sellItems.length} trades</span>
              </div>
            </div>
          )}

          {/* ── Post-Rebalance Snapshot ── */}
          {data && !hasNoHoldings && topHoldingAfter && (
            <div className="rw-snapshot-card">
              <span className="rw-snapshot-eyebrow">Post-Rebalance Snapshot</span>
              <div className="rw-snapshot-grid">
                <div className="rw-snapshot-item">
                  <strong>{topHoldingAfter.symbol}</strong>
                  <span>
                    {topHoldingAfter.targetWeight?.toFixed(1)}% top position
                  </span>
                </div>
                <div className="rw-snapshot-item">
                  <strong>{buyItems.length + sellItems.length}</strong>
                  <span>total trades</span>
                </div>
                <div className="rw-snapshot-item">
                  <strong>{data.excludedCount}</strong>
                  <span>excluded holdings</span>
                </div>
                <div className="rw-snapshot-item">
                  <strong>
                    {maskDollar(
                      formatCad(Math.abs(data.totalBuyCad - Math.abs(data.totalSellCad))),
                    )}
                  </strong>
                  <span>net cash drift</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Missing market cap warning ── */}
          {missingCapItems.length > 0 && (
            <div className="rw-missing-cap-banner">
              <strong>⚠ Market cap unavailable for {missingCapItems.map((i) => i.symbol).join(", ")}</strong>
              <span>
                These positions were excluded from market-cap weighting. Enter their market caps below (in billions) and re-run the plan.
              </span>
              {enteredManualCapCount > 0 && (
                <button
                  className="rw-inline-action"
                  type="button"
                  onClick={() => void fetchReweight()}
                  disabled={isLoading}
                >
                  {isLoading ? "Applying..." : "Apply manual cap"}
                </button>
              )}
            </div>
          )}

          {/* ── Table ── */}
          {data && !hasNoHoldings && (
            <div className="rw-table-wrap">
              <div className="rw-table-header-row">
                <h2 className="rw-table-title">Rebalance Plan</h2>
                {data.generatedAt && (
                  <span className="rw-table-timestamp">
                    as of {new Date(data.generatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <div className="rw-table-scroll">
                <table className="rw-table">
                  <colgroup>
                    <col className="rw-col-symbol" />
                    <col className="rw-col-type" />
                    <col className="rw-col-current-val" />
                    <col className="rw-col-current-wt" />
                    <col className="rw-col-target-wt" />
                    <col className="rw-col-drift" />
                    <col className="rw-col-trade" />
                    <col className="rw-col-shares" />
                    <col className="rw-col-mktcap" />
                  </colgroup>
                  <thead>
                    <tr>
                      {(
                        [
                          ["symbol", "Asset"],
                          ["assetClass", "Class"],
                          ["currentValueCad", "Current Value"],
                          ["currentWeight", "Current %"],
                          ["targetWeight", "Target %"],
                          ["driftPct", "Drift"],
                          ["tradeCad", "Trade"],
                          ["tradeShares", "Shares"],
                          ["marketCap", "Market Cap"],
                        ] as [ReweightSortKey, string][]
                      ).map(([key, label]) => (
                        <th key={key}>
                          <button
                            className="rw-sort-btn"
                            type="button"
                            title="Toggle sort"
                            onClick={() => handleSort(key)}
                          >
                            {label}{getSortLabel(key)}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((item) => {
                      const trade = item.tradeCad;
                      return (
                        <tr
                          key={item.symbol}
                          className={`rw-row-clickable${!item.includedInRebalance ? " rw-row-dimmed" : ""}`}
                          onClick={() => setExplainItem(item)}
                          title="Click for trade explanation"
                        >
                          <td title={item.name}>
                            <span className="rw-symbol">{item.symbol}</span>
                            <span className="rw-name">{item.name}</span>
                            {item.reason && (
                              <span className="rw-reason">{item.reason}</span>
                            )}
                          </td>
                          <td>
                            <span className="rw-type-badge">{item.assetClass}</span>
                          </td>
                          <td>{maskDollar(formatCad(item.currentValueCad))}</td>
                          <td>{formatPct(item.currentWeight)}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {targetMode === "manual" && item.includedInRebalance ? (
                              <input
                                className="rw-target-input"
                                type="number"
                                min="0"
                                step="0.1"
                                value={
                                  manualTargets[item.symbol] ??
                                  item.targetWeight ??
                                  item.currentWeight
                                }
                                onChange={(e) => setManualTarget(item.symbol, e.target.value)}
                              />
                            ) : (
                              formatPct(item.targetWeight)
                            )}
                          </td>
                          <td
                            className={
                              (item.driftPct ?? 0) > 0
                                ? "rw-negative"
                                : (item.driftPct ?? 0) < 0
                                  ? "rw-positive"
                                  : ""
                            }
                          >
                            {formatPct(item.driftPct)}
                          </td>
                          <td>
                            {trade === null ? (
                              <span className="rw-no-data">No target</span>
                            ) : item.action === "buy" ? (
                              <span className="rw-action-pill rw-action-pill-buy">
                                Buy {maskDollar(formatCad(trade))}
                              </span>
                            ) : item.action === "sell" ? (
                              <span className="rw-action-pill rw-action-pill-sell">
                                Sell {maskDollar(formatCad(Math.abs(trade)))}
                              </span>
                            ) : (
                              <span className="rw-action-pill rw-action-pill-hold">
                                Hold
                              </span>
                            )}
                          </td>
                          <td>{formatShares(item.tradeShares)}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {item.reason === "Missing market cap" ? (
                              <div className="rw-cap-input-wrap">
                                <input
                                  className="rw-marketcap-input"
                                  type="number"
                                  min="0"
                                  step="0.1"
                                  placeholder="$ B"
                                  title="Market cap in billions (e.g. 45.2 for $45.2B)"
                                  value={manualMarketCaps[item.symbol] ?? ""}
                                  onChange={(e) =>
                                    setManualMarketCaps((prev) => ({
                                      ...prev,
                                      [item.symbol]: e.target.value,
                                    }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      const value = e.currentTarget.value;
                                      setManualMarketCaps((prev) => ({
                                        ...prev,
                                        [item.symbol]: value,
                                      }));
                                      void fetchReweight({ [item.symbol]: value });
                                    }
                                  }}
                                />
                                <span className="rw-cap-unit">B</span>
                                {parseMarketCapBillions(manualMarketCaps[item.symbol] ?? "") !== null && (
                                  <button
                                    className="rw-cap-apply-btn"
                                    type="button"
                                    onClick={() =>
                                      void fetchReweight({
                                        [item.symbol]: manualMarketCaps[item.symbol] ?? "",
                                      })
                                    }
                                    disabled={isLoading}
                                  >
                                    Apply
                                  </button>
                                )}
                              </div>
                            ) : (
                              maskDollar(formatMarketCap(item.marketCap))
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {isLoading && !data && (
            <div className="rw-loading">Generating rebalance plan…</div>
          )}
        </div>
      </main>

      {explainItem && data && (
        <div
          className="rw-explain-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Trade explanation for ${explainItem.symbol}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setExplainItem(null);
          }}
        >
          <div className="rw-explain-modal">
            <div className="rw-explain-header">
              <span className="rw-explain-symbol">{explainItem.symbol}</span>
              <span className="rw-explain-name">{explainItem.name}</span>
              <button
                className="rw-explain-close"
                type="button"
                aria-label="Close"
                onClick={() => setExplainItem(null)}
              >
                ✕
              </button>
            </div>
            <ul className="rw-explain-lines">
              {buildTradeExplanation(explainItem, {
                totalValueCad: data.totalValueCad,
                settings: data.settings,
                targetMode: data.targetMode,
              }).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            {explainItem.reason && explainItem.action !== "hold" && (
              <p className="rw-explain-note">{explainItem.reason}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default Reweight;
