import { useEffect, useMemo, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar";
import "./RoutePage.css";
import "./Reweight.css";
import { API_BASE_URL } from "../lib/constants";

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
  settings: {
    maxSingleStockPct: number;
  };
  notes: string[];
  generatedAt: string;
};

function formatCad(value: number | null): string {
  if (value === null) return "-";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
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

function getSortValue(
  item: ReweightItem,
  key: ReweightSortKey,
): string | number | null {
  if (key === "symbol") return item.symbol;
  if (key === "assetClass") return item.assetClass;
  return item[key];
}

function Reweight() {
  const [data, setData] = useState<ReweightResponse | null>(null);
  const [targetMode, setTargetMode] =
    useState<TargetMode>("capped_market_cap");
  const [cashCad, setCashCad] = useState(0);
  const [driftThresholdPct, setDriftThresholdPct] = useState(2);
  const [minTradeCad, setMinTradeCad] = useState(50);
  const [maxSingleStockPct, setMaxSingleStockPct] = useState(20);
  const [fractionalShares, setFractionalShares] = useState(true);
  const [cashFirst, setCashFirst] = useState(true);
  const [noSell, setNoSell] = useState(false);
  const [manualTargets, setManualTargets] = useState<Record<string, number>>(
    {},
  );
  const [sortKey, setSortKey] = useState<ReweightSortKey | null>(null);
  const [sortDirection, setSortDirection] =
    useState<SortDirection | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manualTargetList = useMemo(
    () =>
      Object.entries(manualTargets)
        .filter(
          ([, targetWeight]) =>
            Number.isFinite(targetWeight) && targetWeight >= 0,
        )
        .map(([symbol, targetWeight]) => ({ symbol, targetWeight })),
    [manualTargets],
  );

  const fetchReweight = async () => {
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
        }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const json = (await res.json()) as ReweightResponse;
      setData(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load reweight data",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchReweight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasNoHoldings = data && data.items.length === 0;
  const buyItems = data?.items.filter((item) => item.action === "buy") ?? [];
  const sellItems = data?.items.filter((item) => item.action === "sell") ?? [];
  const atomicItems =
    data?.items.filter(
      (item) =>
        item.includedInRebalance &&
        !item.targetEligible &&
        ["etf", "mutual_fund", "bond"].includes(item.assetClass),
    ) ?? [];
  const sortedItems = useMemo(() => {
    const items = data?.items ?? [];
    if (sortKey === null || sortDirection === null) {
      return items;
    }

    const direction = sortDirection === "asc" ? 1 : -1;

    return [...items].sort((a, b) => {
      const aValue = getSortValue(a, sortKey);
      const bValue = getSortValue(b, sortKey);

      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;

      if (typeof aValue === "number" && typeof bValue === "number") {
        return (aValue - bValue) * direction;
      }

      return String(aValue).localeCompare(String(bValue)) * direction;
    });
  }, [data, sortDirection, sortKey]);

  const handleSort = (key: ReweightSortKey) => {
    if (sortKey !== key || sortDirection === null) {
      setSortKey(key);
      setSortDirection("desc");
      return;
    }

    if (sortDirection === "desc") {
      setSortDirection("asc");
      return;
    }

    setSortKey(null);
    setSortDirection(null);
  };

  const getSortLabel = (key: ReweightSortKey) => {
    if (sortKey !== key || sortDirection === null) return "";
    return sortDirection === "asc" ? " ^" : " v";
  };

  const getSortTitle = (key: ReweightSortKey) => {
    if (sortKey !== key || sortDirection === null) {
      return "Sort descending";
    }

    if (sortDirection === "desc") {
      return "Sort ascending";
    }

    return "Turn sorting off";
  };

  const modeNote = (() => {
    if (targetMode === "capped_market_cap") {
      return (
        <>
          Capped Market Cap limits any single stock to{" "}
          {maxSingleStockPct.toFixed(0)}% and redistributes the excess across
          the rest of the direct-stock basket. ETFs and funds stay atomic, so
          broad index funds like VFV, XEQT, VTI, and SPY are not decomposed.
        </>
      );
    }

    if (targetMode === "market_cap") {
      return (
        <>
          Market Cap weights direct stocks by company size without a
          single-stock cap. ETFs and funds stay atomic and are not decomposed
          into underlying holdings.
        </>
      );
    }

    if (targetMode === "sqrt_market_cap") {
      return (
        <>
          Square Root Market Cap keeps larger companies heavier, but compresses
          mega-cap dominance so smaller holdings still get meaningful targets.
          ETFs and funds stay atomic.
        </>
      );
    }

    if (targetMode === "equal") {
      return (
        <>
          Equal weight gives each included holding the same target allocation,
          regardless of market cap or current portfolio size.
        </>
      );
    }

    return (
      <>
        Custom Targets lets you enter target percentages directly in the table.
        The plan normalizes entered targets before calculating drift and trades.
      </>
    );
  })();

  const setManualTarget = (symbol: string, value: string) => {
    const parsed = Number.parseFloat(value);
    setManualTargets((current) => ({
      ...current,
      [symbol]: Number.isFinite(parsed) ? parsed : 0,
    }));
  };

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <div className="rw-layout">
          <div className="rw-header-row">
            <div>
              <h1 className="rw-title">Reweight</h1>
              <p className="rw-subtitle">
                Capped market cap is the default for small baskets, keeping size
                awareness without letting one mega-cap dominate the plan.
              </p>
            </div>
            <button
              className="rw-refresh-btn"
              onClick={fetchReweight}
              disabled={isLoading}
            >
              {isLoading ? "Generating..." : "Generate plan"}
            </button>
          </div>

          <section className="rw-controls">
            <label>
              Target method
              <select
                value={targetMode}
                onChange={(event) =>
                  setTargetMode(event.target.value as TargetMode)
                }
              >
                <option value="capped_market_cap">Capped Market Cap</option>
                <option value="market_cap">Market Cap</option>
                <option value="equal">Equal weight</option>
                <option value="sqrt_market_cap">Square Root Market Cap</option>
                <option value="manual">Custom Targets</option>
              </select>
            </label>
            <label>
              Cash available
              <input
                type="number"
                min="0"
                value={cashCad}
                onChange={(event) => setCashCad(Number(event.target.value))}
              />
            </label>
            <label>
              Drift threshold %
              <input
                type="number"
                min="0"
                step="0.25"
                value={driftThresholdPct}
                onChange={(event) =>
                  setDriftThresholdPct(Number(event.target.value))
                }
              />
            </label>
            <label>
              Min trade CAD
              <input
                type="number"
                min="0"
                step="5"
                value={minTradeCad}
                onChange={(event) => setMinTradeCad(Number(event.target.value))}
              />
            </label>
            {targetMode === "capped_market_cap" && (
              <label>
                Max stock %
                <input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={maxSingleStockPct}
                  onChange={(event) =>
                    setMaxSingleStockPct(Number(event.target.value))
                  }
                />
              </label>
            )}
            <label className="rw-checkbox">
              <input
                type="checkbox"
                checked={fractionalShares}
                onChange={(event) => setFractionalShares(event.target.checked)}
              />
              Fractional shares
            </label>
            <label className="rw-checkbox">
              <input
                type="checkbox"
                checked={cashFirst}
                onChange={(event) => setCashFirst(event.target.checked)}
              />
              Cash-first
            </label>
            <label className="rw-checkbox">
              <input
                type="checkbox"
                checked={noSell}
                onChange={(event) => setNoSell(event.target.checked)}
              />
              No-sell mode
            </label>
          </section>

          <div className="rw-mode-note">{modeNote}</div>

          {error && <div className="rw-error">{error}</div>}

          {hasNoHoldings && !isLoading && (
            <div className="rw-empty">
              No holdings found. Import your portfolio on the Holdings page
              first.
            </div>
          )}

          {data && !hasNoHoldings && (
            <div className="rw-summary-grid">
              <div className="rw-summary-card">
                <span className="rw-summary-label">Portfolio Value</span>
                <span className="rw-summary-value">
                  {formatCad(data.totalValueCad)}
                </span>
              </div>
              <div className="rw-summary-card">
                <span className="rw-summary-label">Cash Applied</span>
                <span className="rw-summary-value">
                  {formatCad(data.cashCad)}
                </span>
              </div>
              <div className="rw-summary-card rw-summary-buy">
                <span className="rw-summary-label">Buy Orders</span>
                <span className="rw-summary-value rw-positive">
                  {formatCad(data.totalBuyCad)}
                </span>
                <span className="rw-summary-note">
                  {buyItems.length} trades
                </span>
              </div>
              <div className="rw-summary-card rw-summary-sell">
                <span className="rw-summary-label">Sell Orders</span>
                <span className="rw-summary-value rw-negative">
                  {formatCad(Math.abs(data.totalSellCad))}
                </span>
                <span className="rw-summary-note">
                  {sellItems.length} trades
                </span>
              </div>
            </div>
          )}

          {data && data.notes.length > 0 && (
            <div className="rw-notes">
              {data.notes.map((note) => (
                <span key={note}>{note}</span>
              ))}
            </div>
          )}

          {atomicItems.length > 0 && (
            <div className="rw-notes">
              <span>
                Atomic holdings preserved:{" "}
                {atomicItems.map((item) => item.symbol).join(", ")}
              </span>
            </div>
          )}

          {data && !hasNoHoldings && (
            <div className="rw-table-wrap">
              <div className="rw-table-header-row">
                <h2 className="rw-table-title">Rebalance Plan</h2>
                {data.generatedAt && (
                  <span className="rw-table-timestamp">
                    Data as of {new Date(data.generatedAt).toLocaleTimeString()}
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
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("symbol")}
                          onClick={() => handleSort("symbol")}
                        >
                          Asset{getSortLabel("symbol")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("assetClass")}
                          onClick={() => handleSort("assetClass")}
                        >
                          Class{getSortLabel("assetClass")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("currentValueCad")}
                          onClick={() => handleSort("currentValueCad")}
                        >
                          Current Value{getSortLabel("currentValueCad")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("currentWeight")}
                          onClick={() => handleSort("currentWeight")}
                        >
                          Current %{getSortLabel("currentWeight")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("targetWeight")}
                          onClick={() => handleSort("targetWeight")}
                        >
                          Target %{getSortLabel("targetWeight")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("driftPct")}
                          onClick={() => handleSort("driftPct")}
                        >
                          Drift{getSortLabel("driftPct")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("tradeCad")}
                          onClick={() => handleSort("tradeCad")}
                        >
                          Trade{getSortLabel("tradeCad")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("tradeShares")}
                          onClick={() => handleSort("tradeShares")}
                        >
                          Shares{getSortLabel("tradeShares")}
                        </button>
                      </th>
                      <th>
                        <button
                          className="rw-sort-btn"
                          type="button"
                          title={getSortTitle("marketCap")}
                          onClick={() => handleSort("marketCap")}
                        >
                          Market Cap{getSortLabel("marketCap")}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((item) => {
                      const trade = item.tradeCad;
                      return (
                        <tr
                          key={item.symbol}
                          className={
                            !item.includedInRebalance ? "rw-row-dimmed" : ""
                          }
                        >
                          <td title={item.name}>
                            <span className="rw-symbol">{item.symbol}</span>
                            <span className="rw-name">{item.name}</span>
                            {item.reason && (
                              <span className="rw-reason">{item.reason}</span>
                            )}
                          </td>
                          <td>
                            <span className="rw-type-badge">
                              {item.assetClass}
                            </span>
                          </td>
                          <td>{formatCad(item.currentValueCad)}</td>
                          <td>{formatPct(item.currentWeight)}</td>
                          <td>
                            {targetMode === "manual" &&
                            item.includedInRebalance ? (
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
                                onChange={(event) =>
                                  setManualTarget(
                                    item.symbol,
                                    event.target.value,
                                  )
                                }
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
                              <span className="rw-buy">
                                Buy {formatCad(trade)}
                              </span>
                            ) : item.action === "sell" ? (
                              <span className="rw-sell">
                                Sell {formatCad(Math.abs(trade))}
                              </span>
                            ) : (
                              <span className="rw-neutral">Hold</span>
                            )}
                          </td>
                          <td>{formatShares(item.tradeShares)}</td>
                          <td>{formatMarketCap(item.marketCap)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {isLoading && !data && (
            <div className="rw-loading">Generating rebalance plan...</div>
          )}
        </div>
      </main>
    </div>
  );
}

export default Reweight;
