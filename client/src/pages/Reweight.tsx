import { useEffect, useState } from "react";
import DashboardNavbar from "../components/DashboardNavbar";
import "./RoutePage.css";
import "./Reweight.css";
import { API_BASE_URL } from "../lib/constants";

type ReweightItem = {
  symbol: string;
  name: string;
  security_type: string;
  currentValueCad: number;
  currentWeight: number;
  marketCap: number | null;
  targetWeight: number | null;
  targetValueCad: number | null;
  adjustCad: number | null;
};

type ReweightResponse = {
  items: ReweightItem[];
  totalValueCad: number;
  generatedAt: string;
};

function formatCad(value: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatMarketCap(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toLocaleString()}`;
}

function formatPct(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(2)}%`;
}

function Reweight() {
  const [data, setData] = useState<ReweightResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReweight = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/reweight/market-cap`);
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
    fetchReweight();
  }, []);

  const hasNoHoldings = data && data.items.length === 0;
  const itemsWithCap = data?.items.filter((i) => i.marketCap !== null) ?? [];
  const itemsWithoutCap = data?.items.filter((i) => i.marketCap === null) ?? [];

  const totalBuy = itemsWithCap
    .filter((i) => (i.adjustCad ?? 0) > 0)
    .reduce((sum, i) => sum + (i.adjustCad ?? 0), 0);
  const totalSell = itemsWithCap
    .filter((i) => (i.adjustCad ?? 0) < 0)
    .reduce((sum, i) => sum + (i.adjustCad ?? 0), 0);

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <div className="rw-layout">

          {/* Header */}
          <div className="rw-header-row">
            <div>
              <h1 className="rw-title">Reweight</h1>
              <p className="rw-subtitle">
                Market-cap weighting — each holding sized proportionally to its
                company's market capitalisation.
              </p>
            </div>
            <button
              className="rw-refresh-btn"
              onClick={fetchReweight}
              disabled={isLoading}
            >
              {isLoading ? "Loading…" : "Refresh"}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="rw-error">
              {error}
            </div>
          )}

          {/* Empty state */}
          {hasNoHoldings && !isLoading && (
            <div className="rw-empty">
              No holdings found. Import your portfolio on the Holdings page first.
            </div>
          )}

          {/* Summary cards */}
          {data && !hasNoHoldings && (
            <div className="rw-summary-grid">
              <div className="rw-summary-card">
                <span className="rw-summary-label">Portfolio Value</span>
                <span className="rw-summary-value">{formatCad(data.totalValueCad)}</span>
              </div>
              <div className="rw-summary-card">
                <span className="rw-summary-label">Positions Analysed</span>
                <span className="rw-summary-value">{itemsWithCap.length}</span>
                {itemsWithoutCap.length > 0 && (
                  <span className="rw-summary-note">{itemsWithoutCap.length} without market cap</span>
                )}
              </div>
              <div className="rw-summary-card rw-summary-buy">
                <span className="rw-summary-label">Total to Buy</span>
                <span className="rw-summary-value rw-positive">{formatCad(totalBuy)}</span>
              </div>
              <div className="rw-summary-card rw-summary-sell">
                <span className="rw-summary-label">Total to Sell</span>
                <span className="rw-summary-value rw-negative">{formatCad(Math.abs(totalSell))}</span>
              </div>
            </div>
          )}

          {/* Main table */}
          {data && !hasNoHoldings && (
            <div className="rw-table-wrap">
              <div className="rw-table-header-row">
                <h2 className="rw-table-title">Market Cap Reweight</h2>
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
                    <col className="rw-col-mktcap" />
                    <col className="rw-col-target-wt" />
                    <col className="rw-col-target-val" />
                    <col className="rw-col-adjust" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Symbol / Name</th>
                      <th>Type</th>
                      <th>Current Value</th>
                      <th>Current %</th>
                      <th>Market Cap</th>
                      <th>Target %</th>
                      <th>Target Value</th>
                      <th>Adjust By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => {
                      const adjust = item.adjustCad;
                      const hasData = item.marketCap !== null;
                      return (
                        <tr key={item.symbol} className={hasData ? "" : "rw-row-dimmed"}>
                          <td>
                            <span className="rw-symbol">{item.symbol}</span>
                            <span className="rw-name">{item.name}</span>
                          </td>
                          <td>
                            <span className="rw-type-badge">{item.security_type}</span>
                          </td>
                          <td>{formatCad(item.currentValueCad)}</td>
                          <td>{formatPct(item.currentWeight)}</td>
                          <td>{formatMarketCap(item.marketCap)}</td>
                          <td>{formatPct(item.targetWeight)}</td>
                          <td>{item.targetValueCad !== null ? formatCad(item.targetValueCad) : "—"}</td>
                          <td>
                            {adjust === null ? (
                              <span className="rw-no-data">No market cap data</span>
                            ) : adjust > 0.005 ? (
                              <span className="rw-buy">+{formatCad(adjust)}</span>
                            ) : adjust < -0.005 ? (
                              <span className="rw-sell">{formatCad(adjust)}</span>
                            ) : (
                              <span className="rw-neutral">Balanced</span>
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

          {/* Loading skeleton */}
          {isLoading && !data && (
            <div className="rw-loading">Fetching market cap data from Yahoo Finance…</div>
          )}

        </div>
      </main>
    </div>
  );
}

export default Reweight;
