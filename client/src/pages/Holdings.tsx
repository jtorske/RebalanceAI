import DashboardNavbar from "../components/DashboardNavbar";
import "./RoutePage.css";
import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL, USD_TO_CAD_RATE } from "../lib/constants";
import {
  loadCachedDailyChangeMap,
  clearLegacyDailyChangeCache,
  saveCachedDailyChangeMap,
} from "../lib/dailyChangeCache";
import { parseHoldingsCsv } from "../lib/holdingsParser";
import {
  convertToCad,
  getTotalChangePercent,
  getTotalChangeAmount,
  isOptionHolding,
} from "../lib/holdingsUtils";
import { useUserSettings } from "../lib/userSettings";
import type {
  ImportedHolding,
  HoldingsResponse,
  MarketComparisonResponse,
  SortKey,
  SortDirection,
} from "../lib/types";

function HoldingsPage() {
  const { settings } = useUserSettings();
  const [fileName, setFileName] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [parsedHoldings, setParsedHoldings] = useState<ImportedHolding[]>([]);
  const [persisted, setPersisted] = useState<HoldingsResponse | null>(null);
  const [isLoadingPersisted, setIsLoadingPersisted] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>("market_value");
  const [sortDirection, setSortDirection] = useState<SortDirection | null>(
    "desc",
  );
  const [showAllHoldings, setShowAllHoldings] = useState(false);
  const [dailyChangeBySymbol, setDailyChangeBySymbol] = useState<
    Record<string, number | null>
  >(() => loadCachedDailyChangeMap());

  useEffect(() => {
    const loadPersistedHoldings = async () => {
      setIsLoadingPersisted(true);
      try {
        const response = await fetch(`${API_BASE_URL}/holdings`);
        if (!response.ok) {
          throw new Error("Unable to read saved holdings from the backend.");
        }
        const data = (await response.json()) as HoldingsResponse;
        setPersisted(data);
      } catch (loadError) {
        const details =
          loadError instanceof Error
            ? loadError.message
            : "Unknown error while loading holdings.";
        setError(details);
      } finally {
        setIsLoadingPersisted(false);
      }
    };

    void loadPersistedHoldings();
  }, []);

  useEffect(() => {
    clearLegacyDailyChangeCache();
  }, []);

  useEffect(() => {
    const loadTickerDailyChanges = async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/market/portfolio-vs-market`,
        );
        if (!response.ok) {
          throw new Error("Unable to load per-ticker daily changes.");
        }

        const data = (await response.json()) as MarketComparisonResponse;
        const groupedChanges = new Map<string, number[]>();
        const normalizedMap: Record<string, number | null> = {};

        (data.perTicker ?? []).forEach((item) => {
          const key = item.symbol.trim().toUpperCase();
          if (!key) {
            return;
          }

          if (!(key in normalizedMap)) {
            normalizedMap[key] = null;
          }

          if (
            typeof item.dailyPercent === "number" &&
            Number.isFinite(item.dailyPercent)
          ) {
            const existing = groupedChanges.get(key) ?? [];
            existing.push(item.dailyPercent);
            groupedChanges.set(key, existing);
          }
        });

        groupedChanges.forEach((values, key) => {
          const average =
            values.reduce((sum, value) => sum + value, 0) / values.length;
          normalizedMap[key] = average;
        });

        setDailyChangeBySymbol(normalizedMap);
        saveCachedDailyChangeMap(
          Object.fromEntries(
            Object.entries(normalizedMap).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number",
            ),
          ),
        );
      } catch {
        setDailyChangeBySymbol((current) => {
          if (Object.keys(current).length > 0) {
            return current;
          }

          return loadCachedDailyChangeMap();
        });
      }
    };

    const refreshTickerDailyChanges = () => {
      void loadTickerDailyChanges();
    };

    void loadTickerDailyChanges();
    window.addEventListener("holdings-changed", refreshTickerDailyChanges);

    return () => {
      window.removeEventListener("holdings-changed", refreshTickerDailyChanges);
    };
  }, []);

  const parsedMarketValue = useMemo(
    () =>
      parsedHoldings.reduce((sum, holding) => sum + holding.market_value, 0),
    [parsedHoldings],
  );

  const persistedMarketValueCad = useMemo(
    () =>
      (persisted?.holdings ?? []).reduce(
        (sum, holding) =>
          sum +
          convertToCad(holding.market_value, holding.market_value_currency),
        0,
      ),
    [persisted],
  );

  const previewHoldings = useMemo(() => {
    if (parsedHoldings.length > 0) {
      return parsedHoldings;
    }

    return persisted?.holdings ?? [];
  }, [parsedHoldings, persisted]);

  const sortedPreviewHoldings = useMemo(() => {
    if (!sortKey || !sortDirection) {
      return previewHoldings;
    }

    const holdingsToSort = [...previewHoldings];

    holdingsToSort.sort((a, b) => {
      if (sortKey === "daily_change_percent") {
        const aDaily = dailyChangeBySymbol[a.symbol.trim().toUpperCase()];
        const bDaily = dailyChangeBySymbol[b.symbol.trim().toUpperCase()];

        if (aDaily == null && bDaily == null) {
          return 0;
        }
        if (aDaily == null) {
          return 1;
        }
        if (bDaily == null) {
          return -1;
        }

        return sortDirection === "asc" ? aDaily - bDaily : bDaily - aDaily;
      }

      if (sortKey === "total_change_percent") {
        const aTotal = getTotalChangePercent(a);
        const bTotal = getTotalChangePercent(b);

        if (aTotal == null && bTotal == null) {
          return 0;
        }
        if (aTotal == null) {
          return 1;
        }
        if (bTotal == null) {
          return -1;
        }

        return sortDirection === "asc" ? aTotal - bTotal : bTotal - aTotal;
      }

      if (sortKey === "total_change_amount") {
        const aAmount = getTotalChangeAmount(a);
        const bAmount = getTotalChangeAmount(b);

        return sortDirection === "asc" ? aAmount - bAmount : bAmount - aAmount;
      }

      const aValue = a[sortKey];
      const bValue = b[sortKey];

      if (typeof aValue === "number" && typeof bValue === "number") {
        return sortDirection === "asc" ? aValue - bValue : bValue - aValue;
      }

      const aText = String(aValue ?? "").toLowerCase();
      const bText = String(bValue ?? "").toLowerCase();
      const comparison = aText.localeCompare(bText);

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return holdingsToSort;
  }, [previewHoldings, sortKey, sortDirection, dailyChangeBySymbol]);

  const displayedHoldings = useMemo(() => {
    if (showAllHoldings) {
      return sortedPreviewHoldings;
    }

    return sortedPreviewHoldings.slice(0, 10);
  }, [showAllHoldings, sortedPreviewHoldings]);

  const maskDollar = (displayValue: string) =>
    settings.hideDollarAmounts ? "..." : displayValue;

  const handleSort = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection("asc");
      return;
    }

    if (sortDirection === "asc") {
      setSortDirection("desc");
      return;
    }

    if (sortDirection === "desc") {
      setSortKey(null);
      setSortDirection(null);
      return;
    }

    setSortKey(key);
    setSortDirection("asc");
  };

  const getSortIndicator = (key: SortKey) => {
    if (sortKey !== key || !sortDirection) {
      return "";
    }

    return sortDirection === "asc" ? " ▲" : " ▼";
  };

  const handleCsvUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    setMessage(null);
    setError(null);

    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please upload a CSV file exported in your broker format.");
      return;
    }

    try {
      const fileText = await file.text();
      const { holdings, asOf: csvAsOf } = parseHoldingsCsv(fileText);
      setFileName(file.name);
      setAsOf(csvAsOf);
      setParsedHoldings(holdings);
      setMessage(
        `Validated ${holdings.length} holdings. Click Save to persist them.`,
      );
    } catch (parseError) {
      const details =
        parseError instanceof Error
          ? parseError.message
          : "Failed to parse CSV.";
      setParsedHoldings([]);
      setError(details);
    } finally {
      event.target.value = "";
    }
  };

  const handleSaveToBackend = async () => {
    if (parsedHoldings.length === 0 || !fileName) {
      setError("Upload a valid holdings CSV before saving.");
      return;
    }

    setIsUploading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`${API_BASE_URL}/holdings/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_file_name: fileName,
          as_of: asOf,
          holdings: parsedHoldings,
        }),
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(responseText || "Failed to persist holdings.");
      }

      const latestResponse = await fetch(`${API_BASE_URL}/holdings`);
      if (latestResponse.ok) {
        const latestData = (await latestResponse.json()) as HoldingsResponse;
        setPersisted(latestData);
        window.dispatchEvent(new Event("holdings-changed"));
      }

      setMessage(`Saved ${parsedHoldings.length} holdings to backend storage.`);
    } catch (saveError) {
      const details =
        saveError instanceof Error
          ? saveError.message
          : "Unexpected save error.";
      setError(details);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteHoldings = async () => {
    const hasAnyHoldings = (persisted?.holdings.length ?? 0) > 0;
    if (!hasAnyHoldings) {
      setError("No persisted holdings available to delete.");
      return;
    }

    const confirmed = window.confirm(
      "Delete all persisted holdings from backend storage?",
    );
    if (!confirmed) {
      return;
    }

    setIsUploading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`${API_BASE_URL}/holdings`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(responseText || "Failed to delete holdings.");
      }

      setPersisted({
        source_file_name: null,
        as_of: null,
        imported_at: null,
        holdings: [],
      });
      setParsedHoldings([]);
      setFileName(null);
      setAsOf(null);
      setMessage("Deleted all persisted holdings.");
      window.dispatchEvent(new Event("holdings-changed"));
    } catch (deleteError) {
      const details =
        deleteError instanceof Error
          ? deleteError.message
          : "Unexpected delete error.";
      setError(details);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="route-page-card holdings-card">
          <h1 className="route-page-title">Holdings</h1>
          <div className="import-upload-row">
            <label
              className="import-file-input-wrap"
              htmlFor="holdings-csv-upload"
            >
              Select CSV File
            </label>
            <input
              id="holdings-csv-upload"
              className="import-file-input"
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
            />

            <button
              className="import-save-button"
              type="button"
              onClick={handleSaveToBackend}
              disabled={isUploading || parsedHoldings.length === 0}
            >
              {isUploading ? "Saving..." : "Save To Backend"}
            </button>

            <button
              className="holdings-delete-button"
              type="button"
              onClick={handleDeleteHoldings}
              disabled={isUploading || (persisted?.holdings.length ?? 0) === 0}
            >
              Delete Holdings
            </button>
          </div>

          {message ? (
            <div className="import-status import-status-success">{message}</div>
          ) : null}
          {error ? (
            <div className="import-status import-status-error">{error}</div>
          ) : null}

          <section className="import-metrics-grid">
            <article className="import-metric-card">
              <h3>Uploaded Preview</h3>
              <p>{parsedHoldings.length} rows</p>
              <span>
                {fileName
                  ? `${fileName} ${asOf ? `| ${asOf}` : ""}`
                  : "No file selected"}
              </span>
            </article>

            <article className="import-metric-card">
              <h3>Uploaded Market Value</h3>
              <p>{maskDollar(`$${parsedMarketValue.toFixed(2)}`)}</p>
              <span>Computed from current file before save</span>
            </article>

            <article className="import-metric-card">
              <h3>Persisted Holdings</h3>
              <p>
                {isLoadingPersisted
                  ? "Loading..."
                  : `${persisted?.holdings.length ?? 0} rows`}
              </p>
              <span>
                {persisted?.source_file_name
                  ? `${persisted.source_file_name}${persisted.as_of ? ` | ${persisted.as_of}` : ""}`
                  : "No saved holdings yet"}
              </span>
            </article>

            <article className="import-metric-card">
              <h3>Persisted Market Value (CAD)</h3>
              <p>{maskDollar(`CA$${persistedMarketValueCad.toFixed(2)}`)}</p>
              <span>
                Read from backend storage and converted to CAD using 1 USD =
                {` ${USD_TO_CAD_RATE.toFixed(2)} CAD`}
              </span>
            </article>
          </section>

          <section className="import-table-wrap">
            <div className="import-section-title-row">
              <h2 className="import-section-title">Holdings Table</h2>
              {sortedPreviewHoldings.length > 10 ? (
                <button
                  type="button"
                  className="import-show-all-button"
                  onClick={() => setShowAllHoldings((current) => !current)}
                >
                  {showAllHoldings ? "Show Top 10" : "Show All Holdings"}
                </button>
              ) : null}
            </div>
            <div className="import-table-scroll">
              <table className="import-table">
                <colgroup>
                  <col className="import-col-account" />
                  <col className="import-col-symbol" />
                  <col className="import-col-security" />
                  <col className="import-col-quantity" />
                  <col className="import-col-price" />
                  <col className="import-col-value" />
                  <col className="import-col-currency" />
                  <col className="import-col-daily" />
                  <col className="import-col-total" />
                  <col className="import-col-total-amount" />
                </colgroup>
                <thead>
                  <tr>
                    <th
                      onClick={() => handleSort("account_name")}
                      className="import-sortable-header"
                    >
                      Account{getSortIndicator("account_name")}
                    </th>
                    <th
                      onClick={() => handleSort("symbol")}
                      className="import-sortable-header"
                    >
                      Symbol{getSortIndicator("symbol")}
                    </th>
                    <th
                      onClick={() => handleSort("security_type")}
                      className="import-sortable-header"
                    >
                      Security Type{getSortIndicator("security_type")}
                    </th>
                    <th
                      onClick={() => handleSort("quantity")}
                      className="import-sortable-header"
                    >
                      Quantity{getSortIndicator("quantity")}
                    </th>
                    <th
                      onClick={() => handleSort("market_price")}
                      className="import-sortable-header"
                    >
                      Market Price{getSortIndicator("market_price")}
                    </th>
                    <th
                      onClick={() => handleSort("market_value")}
                      className="import-sortable-header"
                    >
                      Market Value{getSortIndicator("market_value")}
                    </th>
                    <th
                      onClick={() => handleSort("market_value_currency")}
                      className="import-sortable-header"
                    >
                      Currency{getSortIndicator("market_value_currency")}
                    </th>
                    <th
                      onClick={() => handleSort("daily_change_percent")}
                      className="import-sortable-header"
                    >
                      Daily % (Open){getSortIndicator("daily_change_percent")}
                    </th>
                    <th
                      onClick={() => handleSort("total_change_percent")}
                      className="import-sortable-header"
                    >
                      Unrealized %{getSortIndicator("total_change_percent")}
                    </th>
                    <th
                      onClick={() => handleSort("total_change_amount")}
                      className="import-sortable-header"
                    >
                      Unrealized ${getSortIndicator("total_change_amount")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayedHoldings.map((holding, index) => {
                    const dailyPercent =
                      dailyChangeBySymbol[holding.symbol.trim().toUpperCase()];
                    const optionHolding = isOptionHolding(holding);
                    const totalPercent = getTotalChangePercent(holding);
                    const totalAmount = getTotalChangeAmount(holding);

                    return (
                      <tr
                        key={`${holding.account_number}-${holding.symbol}-${index.toString()}`}
                      >
                        <td>{holding.account_name}</td>
                        <td>{holding.symbol}</td>
                        <td>{holding.security_type}</td>
                        <td>{holding.quantity.toFixed(4)}</td>
                        <td>{maskDollar(holding.market_price.toFixed(4))}</td>
                        <td>{maskDollar(holding.market_value.toFixed(2))}</td>
                        <td>{holding.market_value_currency}</td>
                        <td
                          className={
                            dailyPercent == null
                              ? "import-daily-neutral"
                              : dailyPercent >= 0
                                ? "import-daily-positive"
                                : "import-daily-negative"
                          }
                        >
                          {dailyPercent == null
                            ? optionHolding
                              ? "N/A"
                              : "--"
                            : `${dailyPercent >= 0 ? "+" : ""}${dailyPercent.toFixed(2)}%`}
                        </td>
                        <td
                          className={
                            totalPercent == null
                              ? "import-daily-neutral"
                              : totalPercent >= 0
                                ? "import-daily-positive"
                                : "import-daily-negative"
                          }
                        >
                          {totalPercent == null
                            ? "--"
                            : `${totalPercent >= 0 ? "+" : ""}${totalPercent.toFixed(2)}%`}
                        </td>
                        <td
                          className={
                            totalAmount >= 0
                              ? "import-daily-positive"
                              : "import-daily-negative"
                          }
                        >
                          {maskDollar(
                            `${totalAmount >= 0 ? "+" : ""}$${totalAmount.toFixed(2)} ${holding.market_value_currency}`,
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {previewHoldings.length === 0 ? (
                <div className="import-table-empty">
                  Upload a CSV to preview holdings before saving. Persisted
                  holdings will also appear here when available.
                </div>
              ) : null}
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}

export default HoldingsPage;
