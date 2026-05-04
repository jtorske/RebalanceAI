import DashboardNavbar from "../components/DashboardNavbar";
import AuthGateModal from "../components/AuthGateModal";
import AuthModal from "../components/AuthModal";
import "./RoutePage.css";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useDemoMode } from "../lib/demoMode";
import { useTickerEnrichment } from "../hooks/useTickerEnrichment";
import { useRequireAuth } from "../lib/useRequireAuth";
import { useAuth } from "../context/AuthContext";
import { DEMO_HOLDINGS_RESPONSE } from "../lib/demoHoldings";
import {
  buildHoldingsResponse,
  getHoldings,
  replaceHoldings,
} from "../services/holdingsService";
import { getOrCreateMainPortfolio } from "../services/portfolioService";
import { getSupabaseErrorMessage } from "../services/supabaseError";
import type {
  ImportedHolding,
  HoldingsResponse,
  MarketComparisonResponse,
  SortKey,
  SortDirection,
} from "../lib/types";
import { saveDataStatus } from "../lib/dataStatus";
import { DataStatusPanel } from "../components/common/DataStatusPanel";
import { maskSensitiveAmount } from "../lib/privacyFormat";

function HoldingsPage() {
  const { settings } = useUserSettings();
  const { isDemoMode, enableDemoMode, disableDemoMode } = useDemoMode();
  const { requireAuth, gateOpen, setGateOpen } = useRequireAuth();
  const { user, portfolio, portfolioLoading, refreshPortfolio } = useAuth();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<"login" | "signup">("login");

  function openGateLogin() { setGateOpen(false); setAuthModalMode("login"); setAuthModalOpen(true); }
  function openGateSignup() { setGateOpen(false); setAuthModalMode("signup"); setAuthModalOpen(true); }
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
  const [searchQuery, setSearchQuery] = useState("");
  const [dailyChangeBySymbol, setDailyChangeBySymbol] = useState<
    Record<string, number | null>
  >(() => loadCachedDailyChangeMap());
  const holdingsLoadRequestId = useRef(0);

  useEffect(() => {
    const loadPersistedHoldings = async () => {
      const requestId = holdingsLoadRequestId.current + 1;
      holdingsLoadRequestId.current = requestId;
      setIsLoadingPersisted(true);

      try {
        if (user) {
          if (!portfolio) {
            if (!portfolioLoading) {
              setPersisted(buildHoldingsResponse([], null));
            }
            return;
          }

          const holdings = await getHoldings(portfolio.id);
          if (holdingsLoadRequestId.current === requestId) {
            setPersisted(buildHoldingsResponse(holdings));
          }
          return;
        }

        if (holdingsLoadRequestId.current === requestId) {
          setPersisted(isDemoMode ? DEMO_HOLDINGS_RESPONSE : buildHoldingsResponse([], null));
        }
      } catch (loadError) {
        const details =
          loadError instanceof Error
            ? loadError.message
            : "Unknown error while loading holdings.";
        if (holdingsLoadRequestId.current === requestId) {
          setError(details);
        }
      } finally {
        if (holdingsLoadRequestId.current === requestId) {
          setIsLoadingPersisted(false);
        }
      }
    };

    void loadPersistedHoldings();
    window.addEventListener("holdings-changed", loadPersistedHoldings);
    return () => {
      holdingsLoadRequestId.current += 1;
      window.removeEventListener("holdings-changed", loadPersistedHoldings);
    };
  }, [isDemoMode, portfolio, portfolioLoading, user]);

  useEffect(() => {
    if (persisted) {
      saveDataStatus({
        sourceFileName: persisted.source_file_name,
        importedAt: persisted.imported_at,
        holdingsCount: persisted.holdings.length,
        fxRate: USD_TO_CAD_RATE,
      });
    }
  }, [persisted]);

  useEffect(() => {
    clearLegacyDailyChangeCache();
  }, []);

  useEffect(() => {
    const loadTickerDailyChanges = async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/market/portfolio-vs-market`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ holdings: persisted?.holdings ?? [] }),
          },
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
  }, [persisted?.holdings]);


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
    if (isDemoMode) {
      return persisted?.holdings ?? [];
    }

    if (parsedHoldings.length > 0) {
      return parsedHoldings;
    }

    return persisted?.holdings ?? [];
  }, [isDemoMode, parsedHoldings, persisted]);

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

  const filteredHoldings = useMemo(() => {
    if (!searchQuery.trim()) return sortedPreviewHoldings;
    const q = searchQuery.trim().toLowerCase();
    return sortedPreviewHoldings.filter(
      (h) =>
        h.symbol.toLowerCase().includes(q) ||
        (h.name ?? "").toLowerCase().includes(q) ||
        h.security_type.toLowerCase().includes(q),
    );
  }, [sortedPreviewHoldings, searchQuery]);

  const displayedHoldings = useMemo(() => {
    if (showAllHoldings) return filteredHoldings;
    return filteredHoldings.slice(0, 10);
  }, [showAllHoldings, filteredHoldings]);

  // Enrich all unique symbols — runs once, caches for 7 days, never blocks render
  const allSymbols = useMemo(
    () => previewHoldings.map((h) => h.symbol),
    [previewHoldings],
  );
  const tickerMeta = useTickerEnrichment(allSymbols);

  const maskDollar = (displayValue: string) =>
    maskSensitiveAmount(displayValue, settings.hideDollarAmounts);

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
      if (user && isDemoMode) {
        await disableDemoMode();
      }

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
      if (!user) {
        throw new Error("Sign in before saving holdings.");
      }

      const activePortfolio =
        portfolio ??
        (await getOrCreateMainPortfolio(user.id, settings.defaultCurrency));

      await replaceHoldings(user.id, activePortfolio.id, parsedHoldings);
      await refreshPortfolio();
      setPersisted(buildHoldingsResponse(parsedHoldings, fileName));
      setParsedHoldings([]);
      setFileName(null);
      setAsOf(null);
      window.dispatchEvent(new Event("holdings-changed"));
      setMessage(`Saved ${parsedHoldings.length} holdings.`);
    } catch (saveError) {
      setError(getSupabaseErrorMessage(saveError));
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteHoldings = async () => {
    const hasAnyHoldings = (persisted?.holdings.length ?? 0) > 0;
    if (!hasAnyHoldings) {
      setError("No saved holdings available to delete.");
      return;
    }

    const confirmed = window.confirm(
      "Delete all saved holdings?",
    );
    if (!confirmed) {
      return;
    }

    setIsUploading(true);
    setError(null);
    setMessage(null);

    try {
      if (user && portfolio) {
        await replaceHoldings(user.id, portfolio.id, []);
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
      setMessage("Deleted all saved holdings.");
      window.dispatchEvent(new Event("holdings-changed"));
      await refreshPortfolio();
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

  const handleTryDemoPortfolio = async () => {
    await enableDemoMode();
    window.dispatchEvent(new Event("holdings-changed"));
  };

  const handleUseOwnHoldings = async () => {
    await disableDemoMode();
    setParsedHoldings([]);
    setFileName(null);
    setAsOf(null);
    setMessage("Demo mode is off. Upload your CSV to save a live portfolio.");
    window.dispatchEvent(new Event("holdings-changed"));
  };

  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="route-page-card holdings-card">
          <h1 className="route-page-title">Holdings</h1>
          <p className="route-page-copy">
            Upload your portfolio CSV to unlock dashboard analytics,
            rebalancing, risk scans, and AI-assisted insights.
          </p>
          {user && isDemoMode && (
            <div className="import-demo-active-banner">
              <div>
                <strong>Viewing demo portfolio</strong>
                <span>
                  Demo data is for exploration only. Switch to your own holdings
                  before importing and saving a live portfolio.
                </span>
              </div>
              <button
                type="button"
                className="import-demo-active-button"
                onClick={() => void handleUseOwnHoldings()}
              >
                Use my own holdings
              </button>
            </div>
          )}
          <div className="import-upload-row">
            <div className="import-upload-control">
              <label
                className={`import-file-input-wrap${parsedHoldings.length === 0 && (persisted?.holdings.length ?? 0) === 0 ? " import-guide-pulse" : ""}`}
                htmlFor="holdings-csv-upload"
              >
                Select CSV File
              </label>
              <span className="import-upload-helper">
                Start here to analyze your own portfolio.
              </span>
            </div>
            <input
              id="holdings-csv-upload"
              className="import-file-input"
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
            />

            <button
              className={`import-save-button${parsedHoldings.length > 0 ? " import-guide-pulse" : ""}`}
              type="button"
              onClick={() => requireAuth(handleSaveToBackend)}
              disabled={isUploading || parsedHoldings.length === 0}
            >
              {isUploading ? "Saving..." : "Save Holdings"}
            </button>

            <button
              className="holdings-delete-button"
              type="button"
              onClick={() => requireAuth(handleDeleteHoldings)}
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
              <h3>Import Preview</h3>
              <p>{parsedHoldings.length} rows</p>
              <span>
                {fileName
                  ? `${fileName} ${asOf ? `| ${asOf}` : ""}`
                  : "No file selected"}
              </span>
            </article>

            <article className="import-metric-card">
              <h3>Imported Market Value</h3>
              <p>{maskDollar(`$${parsedMarketValue.toFixed(2)}`)}</p>
              <span>Computed from current file before save</span>
            </article>

            <article className="import-metric-card">
              <h3>Saved Holdings</h3>
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
              <h3>Saved Market Value (CAD)</h3>
              <p>{maskDollar(`CA$${persistedMarketValueCad.toFixed(2)}`)}</p>
              <span>
                Saved from your portfolio data, converted to CAD using 1 USD =
                {` ${USD_TO_CAD_RATE.toFixed(2)} CAD`}
              </span>
            </article>
          </section>

          <DataStatusPanel
            override={{
              sourceFileName: persisted?.source_file_name ?? null,
              importedAt: persisted?.imported_at ?? null,
              holdingsCount: persisted?.holdings.length ?? 0,
              fxRate: USD_TO_CAD_RATE,
            }}
          />

          <section className="import-table-wrap">
            <div className="import-section-title-row">
              <h2 className="import-section-title">
                Holdings Table
                {filteredHoldings.length > 0 && (
                  <span className="import-holdings-count">{filteredHoldings.length}</span>
                )}
              </h2>
              <div className="import-table-controls">
                <input
                  type="search"
                  className="import-search-input"
                  placeholder="Search symbol or name…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {filteredHoldings.length > 10 && (
                  <button
                    type="button"
                    className="import-show-all-button"
                    onClick={() => setShowAllHoldings((current) => !current)}
                  >
                    {showAllHoldings ? "Show Top 10" : `Show All ${filteredHoldings.length}`}
                  </button>
                )}
              </div>
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
                        <td>
                          <div className="import-symbol-cell">
                            <span className="import-symbol-ticker">{holding.symbol}</span>
                            {tickerMeta[holding.symbol.trim().toUpperCase()]?.name && (
                              <span className="import-symbol-name">
                                {tickerMeta[holding.symbol.trim().toUpperCase()]?.name}
                              </span>
                            )}
                          </div>
                        </td>
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
                <div className="import-empty-state">
                  <div className="import-empty-icon">📂</div>
                  <h3>No holdings yet</h3>
                  <p>
                    Export a CSV from your broker and upload it here to start
                    analyzing your portfolio.
                  </p>
                  <div className="import-empty-actions">
                    <label
                      className="import-empty-cta"
                      htmlFor="holdings-csv-upload"
                    >
                      Upload CSV
                    </label>
                    {!isDemoMode && (
                      <button
                        type="button"
                        className="import-empty-demo-btn"
                        onClick={() => void handleTryDemoPortfolio()}
                      >
                        Try Demo Portfolio
                      </button>
                    )}
                  </div>
                </div>
              ) : filteredHoldings.length === 0 ? (
                <div className="import-table-empty">
                  No holdings match &ldquo;{searchQuery}&rdquo;
                </div>
              ) : null}
            </div>
          </section>

        </section>
      </main>

      {gateOpen && (
        <AuthGateModal
          onClose={() => setGateOpen(false)}
          onLogin={openGateLogin}
          onSignup={openGateSignup}
        />
      )}
      {authModalOpen && (
        <AuthModal
          mode={authModalMode}
          onClose={() => setAuthModalOpen(false)}
        />
      )}
    </div>
  );
}

export default HoldingsPage;
