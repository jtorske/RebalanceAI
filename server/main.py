from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from pathlib import Path
from datetime import datetime, timedelta, timezone
import json
import logging
import requests
import yfinance as yf

logger = logging.getLogger("rebalanceai")

_ai_summary_cache: Dict[str, Dict[str, Any]] = {}
_market_cap_cache: Dict[str, Any] = {}  # keyed by date → {symbol: market_cap}
_sector_cache: Dict[str, Dict[str, Any]] = {}
_risk_profile_cache: Dict[str, Dict[str, Any]] = {}
AI_SUMMARY_PROMPT_VERSION = "summary-v5"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Holding(BaseModel):
    ticker: str
    shares: float
    price: float


class ImportedHolding(BaseModel):
    account_name: str
    account_type: str
    account_classification: str
    account_number: str
    symbol: str
    exchange: str
    mic: str
    name: str
    security_type: str
    quantity: float
    position_direction: str
    market_price: float
    market_price_currency: str
    book_value_cad: float
    book_value_currency_cad: str
    book_value_market: float
    book_value_currency_market: str
    market_value: float
    market_value_currency: str
    market_unrealized_returns: float
    market_unrealized_returns_currency: str


class HoldingsImportRequest(BaseModel):
    source_file_name: str
    as_of: Optional[str] = None
    holdings: List[ImportedHolding]


class ManualTarget(BaseModel):
    symbol: str
    targetWeight: float


class RebalancePlanRequest(BaseModel):
    targetMode: str = "capped_market_cap"
    cashCad: float = 0.0
    driftThresholdPct: float = 2.0
    minTradeCad: float = 50.0
    maxSingleStockPct: float = 20.0
    fractionalShares: bool = True
    cashFirst: bool = True
    noSell: bool = False
    manualTargets: List[ManualTarget] = []


DATA_DIR = Path(__file__).resolve().parent / "data"
HOLDINGS_STORE_FILE = DATA_DIR / "holdings_store.json"
PORTFOLIO_DAILY_PERF_FILE = DATA_DIR / "portfolio_daily_performance.json"
BENCHMARKS = [
    {"symbol": "VT", "name": "Total World Stock Market"},
    {"symbol": "VTI", "name": "Total US Stock Market"},
    {"symbol": "QQQ", "name": "NASDAQ"},
    {"symbol": "SPY", "name": "S&P 500"},
    {"symbol": "DIA", "name": "Dow Jones"},
]
USD_TO_CAD_RATE = 1.37
ETF_SYMBOLS = {
    "AAXJ",
    "DIA",
    "EFA",
    "EEM",
    "GLD",
    "HYG",
    "IWM",
    "QQQ",
    "SPY",
    "VFV",
    "VT",
    "VTI",
    "XEF",
    "XEQT",
    "XIC",
    "XIU",
    "ZAG",
}


def _default_store() -> Dict[str, Any]:
    return {
        "source_file_name": None,
        "as_of": None,
        "imported_at": None,
        "holdings": [],
    }


def _default_perf_store() -> Dict[str, Any]:
    return {
        "snapshots": [],
    }


def _load_store() -> Dict[str, Any]:
    if not HOLDINGS_STORE_FILE.exists():
        return _default_store()

    try:
        with HOLDINGS_STORE_FILE.open("r", encoding="utf-8") as file_handle:
            return json.load(file_handle)
    except (json.JSONDecodeError, OSError):
        return _default_store()


def _save_store(store: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with HOLDINGS_STORE_FILE.open("w", encoding="utf-8") as file_handle:
        json.dump(store, file_handle, indent=2)


def _load_perf_store() -> Dict[str, Any]:
    if not PORTFOLIO_DAILY_PERF_FILE.exists():
        return _default_perf_store()

    try:
        with PORTFOLIO_DAILY_PERF_FILE.open("r", encoding="utf-8") as file_handle:
            return json.load(file_handle)
    except (json.JSONDecodeError, OSError):
        return _default_perf_store()


def _save_perf_store(store: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with PORTFOLIO_DAILY_PERF_FILE.open("w", encoding="utf-8") as file_handle:
        json.dump(store, file_handle, indent=2)


def _to_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _convert_to_cad(amount: float, currency: str) -> float:
    normalized = (currency or "").strip().upper()
    if normalized == "USD":
        return amount * USD_TO_CAD_RATE
    return amount


def _is_valid_quote_symbol(raw_symbol: str) -> bool:
    symbol = raw_symbol.strip().upper()
    if not symbol:
        return False

    for character in symbol:
        if character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ.-":
            return False

    return 1 <= len(symbol) <= 10


def _normalize_symbol_for_quote(holding: Dict[str, Any]) -> Optional[str]:
    raw_symbol = str(holding.get("symbol", "")).strip().upper()
    exchange = str(holding.get("exchange", "")).strip().upper()
    security_type = str(holding.get("security_type", "")).strip().upper()

    if "OPTION" in security_type:
        # OCC format used by Yahoo Finance: "GDX 260515C00112000" → "GDX260515C00112000"
        occ = raw_symbol.replace(" ", "")
        if len(occ) > 10 and any(c.isdigit() for c in occ):
            return occ
        return None

    if not _is_valid_quote_symbol(raw_symbol):
        return None

    if exchange in {"TSX", "XTSE"} and not raw_symbol.endswith(".TO"):
        return f"{raw_symbol}.TO"

    if exchange in {"CSE", "XCNQ"} and not raw_symbol.endswith(".CN"):
        return f"{raw_symbol}.CN"

    return raw_symbol


def _quote_from_series(symbol: str, series: Any) -> Optional[Dict[str, Any]]:
    try:
        values = series.dropna()
        if len(values) < 1:
            return None
        current_price = float(values.iloc[-1])
        prev_close = float(values.iloc[-2]) if len(values) >= 2 else None
        change_pct = (
            float((current_price - prev_close) / prev_close * 100)
            if prev_close is not None and prev_close > 0
            else None
        )
        return {
            "symbol": symbol,
            "regularMarketPrice": current_price,
            "regularMarketPreviousClose": prev_close,
            "regularMarketChangePercent": change_pct,
        }
    except Exception:
        return None


def _series_to_float_list(series: Any) -> List[float]:
    try:
        values = series.dropna()
        if hasattr(values, "columns"):
            values = values.iloc[:, 0]
        return [float(value) for value in values.tolist()]
    except Exception:
        return []


def _fetch_quotes_for_symbols(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    deduped = sorted({s.strip().upper() for s in symbols if s})
    if not deduped:
        return {}

    # OCC option symbols contain digits; regular equity/ETF symbols do not
    stock_syms = [s for s in deduped if not any(c.isdigit() for c in s)]
    option_syms = [s for s in deduped if any(c.isdigit() for c in s)]

    result: Dict[str, Dict[str, Any]] = {}

    # ── Batch download for stocks/ETFs ──────────────────────────────────────
    if stock_syms:
        try:
            ticker_arg = stock_syms[0] if len(stock_syms) == 1 else stock_syms
            raw = yf.download(
                ticker_arg,
                period="5d",
                interval="1d",
                auto_adjust=True,
                progress=False,
            )
            if not raw.empty:
                close_col = raw["Close"]
                is_multi = hasattr(close_col, "columns")
                for sym in stock_syms:
                    try:
                        series = close_col[sym] if is_multi else close_col
                        q = _quote_from_series(sym, series)
                        if q:
                            result[sym] = q
                    except Exception as e:
                        logger.debug("Stock quote skipped for %s: %s", sym, e)
            else:
                logger.warning("yfinance returned empty data for stocks: %s", stock_syms)
        except Exception as e:
            logger.error("Stock batch download failed: %s", e, exc_info=True)

    # ── Individual history fetch for option contracts ────────────────────────
    for sym in option_syms:
        try:
            hist = yf.Ticker(sym).history(period="5d", interval="1d")
            if hist.empty or "Close" not in hist.columns:
                continue
            q = _quote_from_series(sym, hist["Close"])
            if q:
                result[sym] = q
        except Exception as e:
            logger.debug("Option quote skipped for %s: %s", sym, e)

    return result


def _fetch_benchmark_quotes() -> List[Dict[str, Any]]:
    symbols = [item["symbol"] for item in BENCHMARKS]
    quote_by_symbol = _fetch_quotes_for_symbols(symbols)

    quotes: List[Dict[str, Any]] = []
    for item in BENCHMARKS:
        quote = quote_by_symbol.get(item["symbol"], {})
        quotes.append(
            {
                "symbol": item["symbol"],
                "name": item["name"],
                "price": quote.get("regularMarketPrice"),
                "changePercent": quote.get("regularMarketChangePercent"),
            }
        )

    return quotes


def _upsert_daily_snapshot(snapshot: Dict[str, Any]) -> None:
    store = _load_perf_store()
    snapshots = store.get("snapshots", [])
    day_key = snapshot.get("date")

    filtered = [item for item in snapshots if item.get("date") != day_key]
    filtered.append(snapshot)
    filtered.sort(key=lambda item: item.get("date", ""))
    store["snapshots"] = filtered[-120:]
    _save_perf_store(store)


def _compute_portfolio_vs_market() -> Dict[str, Any]:
    store = _load_store()
    holdings = store.get("holdings", [])
    quote_symbol_to_original: Dict[str, str] = {}

    for holding in holdings:
        normalized_symbol = _normalize_symbol_for_quote(holding)
        if not normalized_symbol:
            continue
        quote_symbol_to_original[normalized_symbol] = str(
            holding.get("symbol", "")
        ).strip().upper()

    quotes = _fetch_quotes_for_symbols(list(quote_symbol_to_original.keys()))

    total_current_cad = 0.0
    total_previous_cad = 0.0
    fallback_current_cad = 0.0
    fallback_previous_cad = 0.0
    per_ticker: List[Dict[str, Any]] = []

    for holding in holdings:
        normalized_symbol = _normalize_symbol_for_quote(holding)
        if not normalized_symbol:
            continue

        quantity = _to_float(holding.get("quantity"))
        currency = str(
            holding.get("market_price_currency")
            or holding.get("market_value_currency")
            or ""
        )

        if quantity is None or quantity <= 0:
            continue

        imported_current_price = _to_float(holding.get("market_price"))
        imported_market_value = _to_float(holding.get("market_value"))

        if imported_market_value is not None and imported_market_value >= 0:
            fallback_current_cad += _convert_to_cad(imported_market_value, currency)
        elif imported_current_price is not None:
            fallback_current_cad += _convert_to_cad(imported_current_price * quantity, currency)

        if imported_current_price is not None and quantity > 0:
            fallback_previous_cad += _convert_to_cad(imported_current_price * quantity, currency)

        quote = quotes.get(normalized_symbol, {})
        current_price = _to_float(quote.get("regularMarketPrice"))
        previous_close = _to_float(quote.get("regularMarketPreviousClose"))

        if current_price is None:
            current_price = _to_float(holding.get("market_price"))

        if previous_close is None or current_price is None or previous_close <= 0:
            daily_percent = _to_float(quote.get("regularMarketChangePercent"))

            per_ticker.append(
                {
                    "symbol": quote_symbol_to_original.get(normalized_symbol, normalized_symbol),
                    "quoteSymbol": normalized_symbol,
                    "dailyPercent": daily_percent,
                    "price": current_price,
                    "previousClose": previous_close,
                }
            )
            continue

        current_value = quantity * current_price
        previous_value = quantity * previous_close
        current_value_cad = _convert_to_cad(current_value, currency)
        previous_value_cad = _convert_to_cad(previous_value, currency)
        total_current_cad += current_value_cad
        total_previous_cad += previous_value_cad

        daily_percent = ((current_price - previous_close) / previous_close) * 100
        per_ticker.append(
            {
                "symbol": quote_symbol_to_original.get(normalized_symbol, normalized_symbol),
                "quoteSymbol": normalized_symbol,
                "dailyPercent": daily_percent,
                "price": current_price,
                "previousClose": previous_close,
            }
        )

    portfolio_daily_percent: Optional[float] = None
    comparisonSource = "live"
    if total_previous_cad > 0:
        portfolio_daily_percent = (
            (total_current_cad - total_previous_cad) / total_previous_cad
        ) * 100
    elif fallback_previous_cad > 0:
        portfolio_daily_percent = (
            (fallback_current_cad - fallback_previous_cad) / fallback_previous_cad
        ) * 100
        comparisonSource = "fallback-imported-prices"
    else:
        comparisonSource = "unavailable"

    benchmarks = _fetch_benchmark_quotes()
    benchmark_changes: List[float] = []
    for item in benchmarks:
        value = _to_float(item.get("changePercent"))
        if value is not None:
            benchmark_changes.append(value)

    market_daily_percent: Optional[float] = None
    marketSource = "live-benchmarks"
    if benchmark_changes:
        market_daily_percent = sum(benchmark_changes) / len(benchmark_changes)
    else:
        market_daily_percent = 0.0
        marketSource = "fallback-zero"

    delta_percent: Optional[float] = None
    if portfolio_daily_percent is not None and market_daily_percent is not None:
        delta_percent = portfolio_daily_percent - market_daily_percent

    snapshot = {
        "date": datetime.now(timezone.utc).date().isoformat(),
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "portfolioDailyPercent": portfolio_daily_percent,
        "marketDailyPercent": market_daily_percent,
        "deltaPercent": delta_percent,
        "comparisonSource": comparisonSource,
        "marketSource": marketSource,
        "quotesMatched": len(quotes),
        "benchmarks": benchmarks,
        "perTicker": per_ticker,
    }
    _upsert_daily_snapshot(snapshot)

    return snapshot

@app.get("/")
def root():
    return {"message": "Portfolio API running"}


@app.get("/debug/quote-test")
def debug_quote_test():
    """Verify yfinance can reach Yahoo Finance. Hit this in your browser to diagnose -- issues."""
    try:
        raw = yf.download("SPY", period="5d", interval="1d", auto_adjust=True, progress=False)
        if raw.empty:
            return {"status": "empty", "detail": "yfinance returned no rows — possible auth or network block"}
        closes = _series_to_float_list(raw["Close"])
        return {
            "status": "ok",
            "symbol": "SPY",
            "rows_fetched": len(raw),
            "last_3_closes": closes[-3:],
            "daily_change_pct": round((closes[-1] - closes[-2]) / closes[-2] * 100, 4) if len(closes) >= 2 else None,
        }
    except Exception as err:
        return {"status": "error", "detail": str(err)}


@app.get("/debug/source-file")
def debug_source_file():
    sample = "When It Doesn" + chr(0x00E2) + chr(0x0080) + chr(0x0099) + "t"
    return {
        "file": __file__,
        "promptVersion": AI_SUMMARY_PROMPT_VERSION,
        "repairSample": _repair_text_encoding(sample),
    }


@app.get("/holdings")
def get_holdings():
    return _load_store()


@app.get("/market/benchmarks")
def get_market_benchmarks():
    return {"quotes": _fetch_benchmark_quotes()}


@app.get("/market/portfolio-vs-market")
def get_portfolio_vs_market():
    return _compute_portfolio_vs_market()


@app.get("/market/portfolio-performance-history")
def get_portfolio_performance_history():
    store = _load_perf_store()
    return {
        "snapshots": store.get("snapshots", []),
    }


@app.post("/holdings/import")
def import_holdings(payload: HoldingsImportRequest):
    store = {
        "source_file_name": payload.source_file_name,
        "as_of": payload.as_of,
        "imported_at": datetime.now(timezone.utc).isoformat(),
        "holdings": [holding.model_dump() for holding in payload.holdings],
    }
    _save_store(store)

    return {
        "message": "Holdings imported and saved.",
        "count": len(payload.holdings),
    }


@app.delete("/holdings")
def clear_holdings():
    _save_store(_default_store())
    return {"message": "Saved holdings cleared."}

def _repair_text_encoding(value: str) -> str:
    value = value.replace(chr(0x00E2) + chr(0x0080) + chr(0x0099), "'")
    value = value.replace(chr(0x00E2) + chr(0x0080) + chr(0x0098), "'")
    value = value.replace(chr(0x00E2) + chr(0x0080) + chr(0x009C), '"')
    value = value.replace(chr(0x00E2) + chr(0x0080) + chr(0x009D), '"')
    value = value.replace(chr(0x00E2) + chr(0x0080) + chr(0x0093), "-")
    value = value.replace(chr(0x00E2) + chr(0x0080) + chr(0x0094), "-")

    replacements = {
        "\u00e2\u0080\u0099": "'",
        "\u00e2\u0080\u0098": "'",
        "\u00e2\u0080\u009c": '"',
        "\u00e2\u0080\u009d": '"',
        "\u00e2\u0080\u0093": "-",
        "\u00e2\u0080\u0094": "-",
    }
    for broken, repaired in replacements.items():
        value = value.replace(broken, repaired)

    if "â" not in value:
        return value

    try:
        return value.encode("latin1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def _format_percent(value: Optional[float]) -> str:
    if value is None:
        return "N/A"
    return f"{value:+.2f}%"


def _format_percentage_points(value: Optional[float]) -> str:
    if value is None:
        return "N/A"
    return f"{value:+.2f} pp"


def _get_portfolio_movers(snapshot: Dict[str, Any], max_items: int = 3) -> Dict[str, Any]:
    store = _load_store()
    holdings = store.get("holdings", [])

    value_by_symbol: Dict[str, float] = {}
    for holding in holdings:
        symbol = str(holding.get("symbol", "")).strip().upper()
        if not symbol:
            continue

        market_value = _to_float(holding.get("market_value"))
        if market_value is None or market_value <= 0:
            continue

        currency = str(holding.get("market_value_currency", "")).strip().upper()
        value_by_symbol[symbol] = value_by_symbol.get(symbol, 0.0) + _convert_to_cad(
            market_value,
            currency,
        )

    total_value = sum(value_by_symbol.values())
    if total_value <= 0:
        return {"leaders": [], "laggards": []}

    daily_by_symbol: Dict[str, List[float]] = {}
    for item in snapshot.get("perTicker", []):
        symbol = str(item.get("symbol", "")).strip().upper()
        daily_percent = _to_float(item.get("dailyPercent"))
        if not symbol or daily_percent is None:
            continue
        daily_by_symbol.setdefault(symbol, []).append(daily_percent)

    movers: List[Dict[str, Any]] = []
    for symbol, values in daily_by_symbol.items():
        market_value = value_by_symbol.get(symbol)
        if market_value is None:
            continue

        daily_percent = sum(values) / len(values)
        weight_percent = market_value / total_value * 100
        contribution_percent = market_value / total_value * daily_percent
        movers.append(
            {
                "symbol": symbol,
                "dailyPercent": daily_percent,
                "weightPercent": weight_percent,
                "contributionPercent": contribution_percent,
            }
        )

    leaders = sorted(
        [item for item in movers if item["contributionPercent"] > 0],
        key=lambda item: item["contributionPercent"],
        reverse=True,
    )[:max_items]
    laggards = sorted(
        [item for item in movers if item["contributionPercent"] < 0],
        key=lambda item: item["contributionPercent"],
    )[:max_items]

    return {"leaders": leaders, "laggards": laggards}


def _format_mover_list(movers: List[Dict[str, Any]]) -> str:
    return ", ".join(
        f"{mover['symbol']} ({_format_percent(mover['dailyPercent'])}, "
        f"{_format_percentage_points(mover['contributionPercent'])})"
        for mover in movers
    )


def _build_portfolio_driver_sentence(snapshot: Dict[str, Any]) -> str:
    portfolio_daily = _to_float(snapshot.get("portfolioDailyPercent"))
    market_daily = _to_float(snapshot.get("marketDailyPercent"))
    movers = _get_portfolio_movers(snapshot)
    leaders = movers["leaders"]
    laggards = movers["laggards"]

    if portfolio_daily is None or market_daily is None:
        return "Portfolio drivers: portfolio or benchmark daily data is not available yet."

    spread = portfolio_daily - market_daily
    standing = "ahead of" if spread >= 0 else "behind"
    leader_text = _format_mover_list(leaders)
    laggard_text = _format_mover_list(laggards)

    if spread >= 0:
        if leader_text and laggard_text:
            driver_text = f"carried by {leader_text}, partly offset by {laggard_text}"
        elif leader_text:
            driver_text = f"carried by {leader_text}"
        elif laggard_text:
            driver_text = f"despite drag from {laggard_text}"
        else:
            driver_text = "with no clear ticker-level movers available"
    else:
        if laggard_text and leader_text:
            driver_text = f"held back by {laggard_text}, partly offset by {leader_text}"
        elif laggard_text:
            driver_text = f"held back by {laggard_text}"
        elif leader_text:
            driver_text = f"despite help from {leader_text}"
        else:
            driver_text = "with no clear ticker-level movers available"

    return (
        f"Portfolio drivers: your portfolio is {standing} the benchmark average by "
        f"{_format_percentage_points(spread)} today, {driver_text}."
    )


def _first_sentence(text: str) -> str:
    cleaned = " ".join(text.split())
    if not cleaned:
        return ""

    for marker in (". ", "! ", "? "):
        if marker in cleaned:
            return cleaned.split(marker, 1)[0].strip() + marker.strip()

    return cleaned


def _build_ai_summary(
    commentary: str,
    portfolio_driver_sentence: str,
) -> str:
    market_sentence = _first_sentence(commentary)
    if not market_sentence:
        market_sentence = "The benchmark moves were mixed across the major market ETFs today."

    return f"{market_sentence} {portfolio_driver_sentence}"


@app.get("/market/ai-summary")
def get_ai_summary(force: bool = False):
    today = datetime.now(timezone.utc).date().isoformat()

    portfolio_snapshot = _compute_portfolio_vs_market()
    benchmarks = portfolio_snapshot.get("benchmarks", [])
    benchmark_lines = []
    for b in benchmarks:
        pct = b.get("changePercent")
        pct_str = f"{pct:+.2f}%" if pct is not None else "N/A"
        benchmark_lines.append(f"- {b['name']} ({b['symbol']}): {pct_str}")

    cache_payload = {
        "portfolioDailyPercent": portfolio_snapshot.get("portfolioDailyPercent"),
        "marketDailyPercent": portfolio_snapshot.get("marketDailyPercent"),
        "perTicker": [
            {
                "symbol": item.get("symbol"),
                "dailyPercent": item.get("dailyPercent"),
            }
            for item in portfolio_snapshot.get("perTicker", [])
        ],
    }
    cache_key = f"{today}:{AI_SUMMARY_PROMPT_VERSION}:{json.dumps(cache_payload, sort_keys=True)}"

    if not force and cache_key in _ai_summary_cache:
        cached = _ai_summary_cache[cache_key]
        return {
            "summary": cached.get("summary"),
            "cached": True,
            "date": today,
            "portfolioDrivers": cached.get("portfolioDrivers", {"leaders": [], "laggards": []}),
        }

    prompt = (
        f"Today's benchmark moves ({today}):\n"
        + "\n".join(benchmark_lines)
        + "\n\nWrite exactly 1 sentence of market commentary for a portfolio dashboard. "
        "Summarize the benchmark moves only. Do not mention headlines, news, or causes. "
        "Be factual, neutral, and concise."
    )

    try:
        resp = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": "llama3.2", "prompt": prompt, "stream": False},
            timeout=30,
        )
        resp.raise_for_status()
        commentary = resp.json().get("response", "").strip()
        summary = _build_ai_summary(
            commentary,
            _build_portfolio_driver_sentence(portfolio_snapshot),
        )
        _ai_summary_cache[cache_key] = {
            "summary": summary,
            "portfolioDrivers": _get_portfolio_movers(portfolio_snapshot),
        }
        return {
            "summary": summary,
            "cached": False,
            "date": today,
            "portfolioDrivers": _get_portfolio_movers(portfolio_snapshot),
        }
    except Exception as err:
        logger.error("AI summary failed: %s", err)
        return {"summary": None, "error": str(err), "date": today}


def _fetch_market_caps(symbols: List[str]) -> Dict[str, Optional[float]]:
    today = datetime.now(timezone.utc).date().isoformat()
    cached = _market_cap_cache.get(today, {})
    result: Dict[str, Optional[float]] = {}

    to_fetch = [s for s in symbols if s not in cached]
    for symbol in to_fetch:
        try:
            info = yf.Ticker(symbol).info
            mc = info.get("marketCap") or info.get("totalAssets")
            cached[symbol] = float(mc) if mc else None
        except Exception:
            cached[symbol] = None

    _market_cap_cache.clear()
    _market_cap_cache[today] = cached

    for symbol in symbols:
        result[symbol] = cached.get(symbol)
    return result


def _classify_asset(holding: Dict[str, Any], normalized_symbol: str) -> str:
    security_type = str(holding.get("security_type", "")).strip().upper()
    raw_symbol = str(holding.get("symbol", "")).strip().upper()
    name = str(holding.get("name", "")).strip().upper()

    if "OPTION" in security_type:
        return "option"
    if "ETF" in security_type or raw_symbol in ETF_SYMBOLS or normalized_symbol in ETF_SYMBOLS:
        return "etf"
    if "FUND" in security_type:
        return "mutual_fund"
    if "BOND" in security_type or "FIXED INCOME" in security_type:
        return "bond"
    if "CASH" in security_type or raw_symbol in {"CASH", "CAD", "USD"} or "CASH" in name:
        return "cash"
    if "CRYPTO" in security_type:
        return "crypto"
    return "stock"


def _prepare_rebalance_positions(holdings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    position_by_symbol: Dict[str, Dict[str, Any]] = {}

    for holding in holdings:
        normalized_symbol = _normalize_symbol_for_quote(holding)
        raw_symbol = str(holding.get("symbol", "")).strip().upper()
        symbol = raw_symbol or (normalized_symbol or "")
        if not symbol or not normalized_symbol:
            continue

        quantity = _to_float(holding.get("quantity")) or 0.0
        market_value = _to_float(holding.get("market_value")) or 0.0
        market_price = _to_float(holding.get("market_price")) or 0.0
        currency = str(holding.get("market_value_currency") or holding.get("market_price_currency") or "").strip().upper()
        market_value_cad = _convert_to_cad(market_value, currency)
        price_cad = _convert_to_cad(market_price, currency) if market_price > 0 else None
        asset_class = _classify_asset(holding, normalized_symbol)

        existing = position_by_symbol.get(symbol)
        if existing:
            existing["quantity"] += quantity
            existing["currentValueCad"] += market_value_cad
            if price_cad:
                existing["priceCad"] = price_cad
            continue

        position_by_symbol[symbol] = {
            "symbol": symbol,
            "quoteSymbol": normalized_symbol,
            "name": holding.get("name", ""),
            "securityType": holding.get("security_type", ""),
            "assetClass": asset_class,
            "quantity": quantity,
            "priceCad": price_cad,
            "currentValueCad": market_value_cad,
            "includedInRebalance": asset_class not in {"option", "cash"},
            "targetEligible": True,
            "marketCap": None,
            "exclusionReason": None,
        }

    return list(position_by_symbol.values())


def _fetch_stock_sector(symbol: str) -> Optional[str]:
    normalized = symbol.strip().upper()
    if not normalized:
        return None

    cached = _sector_cache.get(normalized)
    if cached is not None:
        return cached.get("sector")

    try:
        info = yf.Ticker(normalized).info
        sector = str(info.get("sector") or "").strip()
        _sector_cache[normalized] = {"sector": sector or None}
        return sector or None
    except Exception as err:
        logger.debug("Sector lookup skipped for %s: %s", normalized, err)
        _sector_cache[normalized] = {"sector": None}
        return None


def _sector_for_holding(holding: Dict[str, Any]) -> Dict[str, Any]:
    normalized_symbol = _normalize_symbol_for_quote(holding)
    raw_symbol = str(holding.get("symbol", "")).strip().upper()
    asset_class = _classify_asset(holding, normalized_symbol or raw_symbol)

    if asset_class == "stock" and normalized_symbol:
        sector = _fetch_stock_sector(normalized_symbol) or "Other"
        source = "yfinance"
    elif asset_class == "etf":
        sector = "ETF / Diversified"
        source = "asset_class"
    elif asset_class == "mutual_fund":
        sector = "Fund / Diversified"
        source = "asset_class"
    elif asset_class == "bond":
        sector = "Fixed Income"
        source = "asset_class"
    elif asset_class == "cash":
        sector = "Cash"
        source = "asset_class"
    elif asset_class == "option":
        sector = "Derivatives"
        source = "asset_class"
    elif asset_class == "crypto":
        sector = "Crypto"
        source = "asset_class"
    else:
        sector = "Other"
        source = "fallback"

    return {
        "symbol": raw_symbol,
        "quoteSymbol": normalized_symbol,
        "sector": sector,
        "assetClass": asset_class,
        "source": source,
    }


def _build_sector_breakdown() -> Dict[str, Any]:
    store = _load_store()
    holdings = store.get("holdings", [])
    by_sector: Dict[str, float] = {}
    per_ticker: List[Dict[str, Any]] = []
    total_value_cad = 0.0

    for holding in holdings:
        market_value = _to_float(holding.get("market_value")) or 0.0
        currency = str(holding.get("market_value_currency", "")).strip().upper()
        market_value_cad = _convert_to_cad(market_value, currency)
        if market_value_cad <= 0:
            continue

        sector_info = _sector_for_holding(holding)
        sector = sector_info["sector"]
        total_value_cad += market_value_cad
        by_sector[sector] = by_sector.get(sector, 0.0) + market_value_cad
        per_ticker.append(
            {
                **sector_info,
                "marketValueCad": round(market_value_cad, 2),
            }
        )

    sectors = [
        {
            "sector": sector,
            "valueCad": round(value, 2),
            "weight": round(value / total_value_cad * 100, 4)
            if total_value_cad > 0
            else 0.0,
        }
        for sector, value in by_sector.items()
    ]
    sectors.sort(key=lambda item: item["valueCad"], reverse=True)

    return {
        "sectors": sectors,
        "perTicker": per_ticker,
        "totalValueCad": round(total_value_cad, 2),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _extract_earnings_date(info: Dict[str, Any]) -> Optional[str]:
    timestamp = _to_float(info.get("earningsTimestamp"))
    if timestamp is None:
        timestamp = _to_float(info.get("earningsTimestampStart"))
    if timestamp is None:
        return None

    try:
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).date().isoformat()
    except (OSError, ValueError):
        return None


def _extract_news_titles(ticker: Any, limit: int = 4) -> List[str]:
    try:
        raw_news = ticker.news or []
    except Exception:
        return []

    titles: List[str] = []
    for item in raw_news:
        title = str(item.get("title") or item.get("content", {}).get("title") or "").strip()
        if title:
            titles.append(title)
        if len(titles) >= limit:
            break
    return titles


def _fetch_risk_profile(symbol: str) -> Dict[str, Any]:
    normalized = symbol.strip().upper()
    if not normalized:
        return {}

    cached = _risk_profile_cache.get(normalized)
    if cached is not None:
        return cached

    profile: Dict[str, Any] = {
        "marketCap": None,
        "beta": None,
        "sector": None,
        "earningsDate": None,
        "newsTitles": [],
    }

    try:
        ticker = yf.Ticker(normalized)
        info = ticker.info or {}
        profile = {
            "marketCap": _to_float(info.get("marketCap") or info.get("totalAssets")),
            "beta": _to_float(info.get("beta")),
            "sector": str(info.get("sector") or "").strip() or None,
            "earningsDate": _extract_earnings_date(info),
            "newsTitles": _extract_news_titles(ticker),
        }
    except Exception as err:
        logger.debug("Risk profile lookup skipped for %s: %s", normalized, err)

    _risk_profile_cache[normalized] = profile
    return profile


def _days_until(date_value: Optional[str]) -> Optional[int]:
    if not date_value:
        return None
    try:
        parsed = datetime.fromisoformat(date_value).date()
    except ValueError:
        return None
    return (parsed - datetime.now(timezone.utc).date()).days


def _risk_severity_rank(severity: str) -> int:
    return {"high": 0, "medium": 1, "low": 2}.get(severity, 3)


def _add_risk(
    concerns: List[Dict[str, Any]],
    symbol: str,
    title: str,
    detail: str,
    severity: str,
    category: str,
    weight: Optional[float] = None,
) -> None:
    concerns.append(
        {
            "symbol": symbol,
            "title": title,
            "detail": detail,
            "severity": severity,
            "category": category,
            "weight": round(weight, 2) if weight is not None else None,
        }
    )


def _fallback_risk_summary(concerns: List[Dict[str, Any]]) -> str:
    if not concerns:
        return "No major portfolio risks stand out from the current holdings data, but keep monitoring concentration, earnings dates, and liquidity."

    top = concerns[:3]
    readable = ", ".join(
        f"{item['symbol']} ({item['category'].lower()})" for item in top
    )
    return f"The main risks to review are {readable}. Check whether these positions are intentional, especially if they combine high weight, small market cap, volatility, or near-term catalysts."


def _ai_risk_summary(concerns: List[Dict[str, Any]], holdings_count: int) -> str:
    fallback = _fallback_risk_summary(concerns)
    if not concerns:
        return fallback

    concern_lines = [
        f"- {item['symbol']}: {item['title']} | {item['detail']} | severity={item['severity']}"
        for item in concerns[:8]
    ]
    prompt = (
        "Write exactly 2 concise sentences for a portfolio risk dashboard. "
        "Do not give financial advice, do not say buy or sell, and only use the facts below. "
        f"The portfolio has {holdings_count} holdings.\n"
        + "\n".join(concern_lines)
    )

    try:
        resp = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": "llama3.2", "prompt": prompt, "stream": False},
            timeout=12,
        )
        resp.raise_for_status()
        text = _repair_text_encoding(resp.json().get("response", "").strip())
        return text or fallback
    except Exception as err:
        logger.debug("AI risk summary fallback used: %s", err)
        return fallback


def _build_risk_analysis() -> Dict[str, Any]:
    store = _load_store()
    holdings = store.get("holdings", [])
    positions = _prepare_rebalance_positions(holdings)
    total_value = sum(item["currentValueCad"] for item in positions)
    concerns: List[Dict[str, Any]] = []

    sector_data = _build_sector_breakdown()
    for sector in sector_data.get("sectors", []):
        weight = _to_float(sector.get("weight")) or 0.0
        if weight >= 45:
            _add_risk(
                concerns,
                "Portfolio",
                f"{sector['sector']} concentration",
                f"{sector['sector']} represents {weight:.1f}% of the portfolio.",
                "high",
                "Sector concentration",
                weight,
            )
        elif weight >= 30:
            _add_risk(
                concerns,
                "Portfolio",
                f"{sector['sector']} concentration",
                f"{sector['sector']} represents {weight:.1f}% of the portfolio.",
                "medium",
                "Sector concentration",
                weight,
            )

    for item in positions:
        if total_value <= 0 or item["currentValueCad"] <= 0:
            continue

        symbol = item["symbol"]
        quote_symbol = item.get("quoteSymbol") or symbol
        weight = item["currentValueCad"] / total_value * 100
        asset_class = item.get("assetClass")

        if weight >= 30:
            _add_risk(
                concerns,
                symbol,
                "Large single-position weight",
                f"{symbol} is {weight:.1f}% of the portfolio, so one ticker can dominate outcomes.",
                "high",
                "Concentration",
                weight,
            )
        elif weight >= 18:
            _add_risk(
                concerns,
                symbol,
                "Meaningful single-position weight",
                f"{symbol} is {weight:.1f}% of the portfolio.",
                "medium",
                "Concentration",
                weight,
            )

        if asset_class != "stock":
            continue

        profile = _fetch_risk_profile(quote_symbol)
        market_cap = _to_float(profile.get("marketCap"))
        beta = _to_float(profile.get("beta"))
        earnings_date = profile.get("earningsDate")
        earnings_days = _days_until(earnings_date)

        if market_cap is None:
            _add_risk(
                concerns,
                symbol,
                "Missing market-cap data",
                "The app could not confirm market cap, so liquidity and size risk need manual review.",
                "low",
                "Data quality",
                weight,
            )
        elif market_cap < 300_000_000 and weight >= 2:
            _add_risk(
                concerns,
                symbol,
                "Micro-cap exposure",
                f"{symbol} is {weight:.1f}% of the portfolio with an estimated market cap below CA$300M.",
                "high",
                "Small-cap exposure",
                weight,
            )
        elif market_cap < 2_000_000_000 and weight >= 5:
            _add_risk(
                concerns,
                symbol,
                "Small-cap position size",
                f"{symbol} is {weight:.1f}% of the portfolio with an estimated market cap below CA$2B.",
                "medium",
                "Small-cap exposure",
                weight,
            )

        if beta is not None and beta >= 1.8 and weight >= 5:
            _add_risk(
                concerns,
                symbol,
                "High beta exposure",
                f"{symbol} has beta around {beta:.2f} and is {weight:.1f}% of the portfolio.",
                "medium",
                "Volatility",
                weight,
            )

        if earnings_days is not None and 0 <= earnings_days <= 21:
            _add_risk(
                concerns,
                symbol,
                "Upcoming earnings catalyst",
                f"{symbol} has an earnings date listed for {earnings_date}, about {earnings_days} days away.",
                "medium",
                "Catalyst",
                weight,
            )

        title_keywords = (
            "miss",
            "cuts",
            "cut",
            "downgrade",
            "lawsuit",
            "probe",
            "investigation",
            "warning",
            "falls",
            "plunges",
        )
        catalyst_keywords = ("earnings", "guidance", "approval", "deal", "merger")
        for title in profile.get("newsTitles", [])[:3]:
            lowered = title.lower()
            if any(keyword in lowered for keyword in title_keywords):
                _add_risk(
                    concerns,
                    symbol,
                    "Recent negative headline",
                    title,
                    "medium",
                    "News",
                    weight,
                )
                break
            if any(keyword in lowered for keyword in catalyst_keywords):
                _add_risk(
                    concerns,
                    symbol,
                    "Recent catalyst headline",
                    title,
                    "low",
                    "Catalyst",
                    weight,
                )
                break

    concerns.sort(
        key=lambda item: (
            _risk_severity_rank(str(item.get("severity"))),
            -(item.get("weight") or 0),
        )
    )
    concerns = concerns[:12]
    summary = _ai_risk_summary(concerns, len(positions))
    dashboard_summary = _first_sentence(summary) or _fallback_risk_summary(concerns)

    return {
        "summary": summary,
        "dashboardSummary": dashboard_summary,
        "concerns": concerns,
        "holdingsAnalyzed": len(positions),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _add_insight(
    insights: List[Dict[str, Any]],
    title: str,
    detail: str,
    category: str,
    tone: str = "neutral",
    symbols: Optional[List[str]] = None,
) -> None:
    insights.append(
        {
            "title": title,
            "detail": detail,
            "category": category,
            "tone": tone,
            "symbols": symbols or [],
        }
    )


def _holding_return_percent(holding: Dict[str, Any]) -> Optional[float]:
    book_value = _to_float(holding.get("book_value_market"))
    unrealized = _to_float(holding.get("market_unrealized_returns"))
    if book_value is None or book_value <= 0 or unrealized is None:
        return None
    return unrealized / book_value * 100


def _fallback_key_insights_summary(insights: List[Dict[str, Any]]) -> str:
    if not insights:
        return "Import holdings to generate portfolio insights around sector balance, performance patterns, and possible diversification gaps."

    highlights = ", ".join(item["title"].lower() for item in insights[:3])
    return f"Key patterns to review include {highlights}. Use these as prompts for research rather than automatic trade instructions."


def _ai_key_insights_summary(insights: List[Dict[str, Any]]) -> str:
    fallback = _fallback_key_insights_summary(insights)
    if not insights:
        return fallback

    insight_lines = [
        f"- {item['title']}: {item['detail']} | category={item['category']}"
        for item in insights[:8]
    ]
    prompt = (
        "Write exactly 2 concise sentences for a portfolio insights page. "
        "Do not give direct buy or sell instructions; phrase additions as areas to research. "
        "Only use the facts below.\n"
        + "\n".join(insight_lines)
    )

    try:
        resp = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": "llama3.2", "prompt": prompt, "stream": False},
            timeout=12,
        )
        resp.raise_for_status()
        text = _repair_text_encoding(resp.json().get("response", "").strip())
        return text or fallback
    except Exception as err:
        logger.debug("AI key insights fallback used: %s", err)
        return fallback


def _build_key_insights() -> Dict[str, Any]:
    store = _load_store()
    holdings = store.get("holdings", [])
    positions = _prepare_rebalance_positions(holdings)
    total_value = sum(item["currentValueCad"] for item in positions)
    sector_data = _build_sector_breakdown()
    insights: List[Dict[str, Any]] = []

    if not holdings or total_value <= 0:
        return {
            "summary": _fallback_key_insights_summary([]),
            "insights": [],
            "topPerformers": [],
            "laggards": [],
            "researchIdeas": [],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }

    top_sectors = sector_data.get("sectors", [])[:3]
    if top_sectors:
        top_sector = top_sectors[0]
        weight = _to_float(top_sector.get("weight")) or 0.0
        if weight >= 35:
            _add_insight(
                insights,
                f"{top_sector['sector']} is the dominant sleeve",
                f"{top_sector['sector']} makes up {weight:.1f}% of portfolio value, so portfolio results may lean heavily on that theme.",
                "Sector pattern",
                "warning",
            )
        else:
            _add_insight(
                insights,
                "Sector mix is not dominated by one sleeve",
                f"The largest sector sleeve is {top_sector['sector']} at {weight:.1f}%.",
                "Sector pattern",
                "positive",
            )

    sorted_positions = sorted(
        positions,
        key=lambda item: item["currentValueCad"],
        reverse=True,
    )
    top_position = sorted_positions[0] if sorted_positions else None
    if top_position:
        top_weight = top_position["currentValueCad"] / total_value * 100
        if top_weight >= 25:
            _add_insight(
                insights,
                f"{top_position['symbol']} drives a large share of results",
                f"{top_position['symbol']} is {top_weight:.1f}% of the portfolio.",
                "Concentration",
                "warning",
                [top_position["symbol"]],
            )
        else:
            _add_insight(
                insights,
                "Single-position concentration looks contained",
                f"The largest holding is {top_position['symbol']} at {top_weight:.1f}% of the portfolio.",
                "Concentration",
                "positive",
                [top_position["symbol"]],
            )

    performance_rows: List[Dict[str, Any]] = []
    for holding in holdings:
        symbol = str(holding.get("symbol", "")).strip().upper()
        return_percent = _holding_return_percent(holding)
        market_value = _to_float(holding.get("market_value")) or 0.0
        currency = str(holding.get("market_value_currency", "")).strip().upper()
        market_value_cad = _convert_to_cad(market_value, currency)
        if not symbol or return_percent is None or market_value_cad <= 0:
            continue
        performance_rows.append(
            {
                "symbol": symbol,
                "returnPercent": round(return_percent, 2),
                "marketValueCad": round(market_value_cad, 2),
                "weight": round(market_value_cad / total_value * 100, 2),
            }
        )

    top_performers = sorted(
        [item for item in performance_rows if item["returnPercent"] > 0],
        key=lambda item: item["returnPercent"],
        reverse=True,
    )[:4]
    laggards = sorted(
        [item for item in performance_rows if item["returnPercent"] < 0],
        key=lambda item: item["returnPercent"],
    )[:4]

    if top_performers:
        leader = top_performers[0]
        _add_insight(
            insights,
            f"{leader['symbol']} is the strongest unrealized performer",
            f"{leader['symbol']} is up {leader['returnPercent']:+.1f}% on cost basis and currently weighs {leader['weight']:.1f}%.",
            "Performance pattern",
            "positive",
            [leader["symbol"]],
        )

    if laggards:
        laggard = laggards[0]
        _add_insight(
            insights,
            f"{laggard['symbol']} is the largest unrealized laggard",
            f"{laggard['symbol']} is down {laggard['returnPercent']:.1f}% on cost basis and currently weighs {laggard['weight']:.1f}%.",
            "Performance pattern",
            "warning",
            [laggard["symbol"]],
        )

    present_sectors = {
        str(item.get("sector", "")).strip()
        for item in sector_data.get("sectors", [])
        if _to_float(item.get("weight")) and (_to_float(item.get("weight")) or 0) >= 3
    }
    research_ideas: List[Dict[str, str]] = []
    if "Fixed Income" not in present_sectors:
        research_ideas.append(
            {
                "title": "Fixed income sleeve",
                "detail": "Research whether a bond or cash-like sleeve belongs in the portfolio for volatility control.",
            }
        )
    if "ETF / Diversified" not in present_sectors and len(positions) < 20:
        research_ideas.append(
            {
                "title": "Broad diversified ETF exposure",
                "detail": "Research whether a broad market ETF could reduce single-stock dependence.",
            }
        )

    defensive_candidates = ["Health Care", "Consumer Defensive", "Consumer Staples", "Utilities"]
    if not any(sector in present_sectors for sector in defensive_candidates):
        research_ideas.append(
            {
                "title": "Defensive sector exposure",
                "detail": "Research whether health care, staples, or utilities exposure would balance cyclical and growth-heavy holdings.",
            }
        )

    if research_ideas:
        _add_insight(
            insights,
            "Diversification gaps worth researching",
            "The portfolio may benefit from reviewing fixed income, broad ETF, or defensive-sector exposure depending on your goals.",
            "Research idea",
            "neutral",
        )

    summary = _ai_key_insights_summary(insights)

    return {
        "summary": summary,
        "insights": insights[:10],
        "topPerformers": top_performers,
        "laggards": laggards,
        "researchIdeas": research_ideas[:4],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _apply_weight_cap(raw_weights: Dict[str, float], cap: float) -> Dict[str, float]:
    if cap <= 0 or not raw_weights:
        return raw_weights

    total_weight = sum(raw_weights.values())
    capped: Dict[str, float] = {}
    uncapped = dict(raw_weights)

    while uncapped:
        over_cap = {
            symbol: weight for symbol, weight in uncapped.items() if weight > cap
        }
        if not over_cap:
            remaining_weight = max(0.0, total_weight - sum(capped.values()))
            uncapped_total = sum(uncapped.values())
            if uncapped_total > 0:
                for symbol, weight in uncapped.items():
                    capped[symbol] = weight / uncapped_total * remaining_weight
            break

        for symbol in over_cap:
            capped[symbol] = cap
            uncapped.pop(symbol, None)

        remaining_weight = max(0.0, total_weight - sum(capped.values()))
        uncapped_total = sum(uncapped.values())
        if uncapped_total <= 0:
            break

        uncapped = {
            symbol: weight / uncapped_total * remaining_weight
            for symbol, weight in uncapped.items()
        }

    return capped


def _assign_market_cap_targets(
    positions: List[Dict[str, Any]],
    total_current: float,
    mode: str,
    max_single_stock_pct: float,
    notes: List[str],
) -> Dict[str, float]:
    weights: Dict[str, float] = {}
    stock_positions = [
        item
        for item in positions
        if item["includedInRebalance"] and item["assetClass"] == "stock"
    ]
    market_caps = _fetch_market_caps([item["quoteSymbol"] for item in stock_positions])
    for item in stock_positions:
        item["marketCap"] = market_caps.get(item["quoteSymbol"])

    preserved = [
        item
        for item in positions
        if item["includedInRebalance"] and item["assetClass"] != "stock"
    ]
    preserved_weight = (
        sum(item["currentValueCad"] for item in preserved) / total_current * 100
        if total_current > 0
        else 0
    )
    stock_weight_budget = max(0.0, 100 - preserved_weight)

    for item in preserved:
        weights[item["symbol"]] = (
            item["currentValueCad"] / total_current * 100 if total_current > 0 else 0
        )
        item["targetEligible"] = False
        item["exclusionReason"] = "ETF/fund treated as atomic; current sleeve weight preserved"

    valid_stock_positions = [
        item for item in stock_positions if item["marketCap"] is not None
    ]
    total_market_cap = sum(item["marketCap"] for item in valid_stock_positions)

    for item in stock_positions:
        if item["marketCap"] is None:
            item["targetEligible"] = False
            item["exclusionReason"] = "Missing market cap"

    if total_market_cap <= 0:
        notes.append("Market-cap mode could not fetch usable market caps; current weights were retained.")
        for item in positions:
            if total_current > 0 and item["includedInRebalance"]:
                weights[item["symbol"]] = item["currentValueCad"] / total_current * 100
        return weights

    if len(valid_stock_positions) < 15 and mode == "market_cap":
        notes.append(
            "Small stock basket detected; capped market-cap or equal weight is usually more diversified than raw market cap."
        )

    if mode == "sqrt_market_cap":
        cap_basis = {
            item["symbol"]: (item["marketCap"] or 0) ** 0.5
            for item in valid_stock_positions
        }
        basis_total = sum(cap_basis.values())
        stock_weights = {
            symbol: value / basis_total * stock_weight_budget
            for symbol, value in cap_basis.items()
        }
        notes.append("Square-root market cap compresses mega-cap dominance while keeping size awareness.")
    else:
        stock_weights = {
            item["symbol"]: (item["marketCap"] or 0) / total_market_cap * stock_weight_budget
            for item in valid_stock_positions
        }

    if mode == "capped_market_cap":
        effective_cap = min(max_single_stock_pct, stock_weight_budget) if stock_weight_budget > 0 else max_single_stock_pct
        stock_weights = _apply_weight_cap(stock_weights, effective_cap)
        notes.append(
            f"Single-stock targets were capped at {effective_cap:.1f}% and excess weight was redistributed proportionally."
        )

    weights.update(stock_weights)

    if preserved:
        notes.append("ETFs and funds were kept atomic and were not decomposed into underlying holdings.")

    return weights


def _assign_targets(
    positions: List[Dict[str, Any]],
    target_mode: str,
    manual_targets: List[ManualTarget],
    max_single_stock_pct: float,
) -> Dict[str, Any]:
    mode = target_mode.strip().lower().replace("-", "_")
    total_current = sum(item["currentValueCad"] for item in positions)
    weights: Dict[str, float] = {}
    notes: List[str] = []

    for item in positions:
        if item["includedInRebalance"]:
            item["targetEligible"] = True
            item["exclusionReason"] = None
        else:
            item["targetEligible"] = False
            item["exclusionReason"] = "Excluded from trade generation by default"

    if mode == "manual":
        requested = {
            target.symbol.strip().upper(): max(target.targetWeight, 0.0)
            for target in manual_targets
            if target.symbol.strip()
        }
        requested_total = sum(requested.values())
        if requested_total > 0:
            weights = {symbol: value / requested_total * 100 for symbol, value in requested.items()}
        else:
            notes.append("Manual mode has no entered targets, so current weights were retained.")
            for item in positions:
                if total_current > 0:
                    weights[item["symbol"]] = item["currentValueCad"] / total_current * 100

    elif mode == "equal":
        eligible = [item for item in positions if item["includedInRebalance"]]
        equal_weight = 100 / len(eligible) if eligible else 0
        weights = {item["symbol"]: equal_weight for item in eligible}

    elif mode in {"market_cap", "marketcap", "capped_market_cap", "sqrt_market_cap"}:
        weights = _assign_market_cap_targets(
            positions,
            total_current,
            "market_cap" if mode == "marketcap" else mode,
            max_single_stock_pct,
            notes,
        )
    else:
        notes.append(f"Unknown target mode '{target_mode}', so current weights were retained.")
        for item in positions:
            if total_current > 0 and item["includedInRebalance"]:
                weights[item["symbol"]] = item["currentValueCad"] / total_current * 100

    return {"mode": mode, "weights": weights, "notes": notes}


def _generate_rebalance_trades(
    positions: List[Dict[str, Any]],
    target_weights: Dict[str, float],
    total_current_cad: float,
    request: RebalancePlanRequest,
) -> List[Dict[str, Any]]:
    total_target_value = total_current_cad + max(request.cashCad, 0.0)
    items: List[Dict[str, Any]] = []

    for item in positions:
        symbol = item["symbol"]
        current_value = item["currentValueCad"]
        current_weight = current_value / total_current_cad * 100 if total_current_cad > 0 else 0.0
        target_weight = target_weights.get(symbol)
        target_value = target_weight / 100 * total_target_value if target_weight is not None else None
        drift = current_weight - target_weight if target_weight is not None else None
        trade_value = target_value - current_value if target_value is not None else None
        action = "hold"
        reason = item.get("exclusionReason") or ""

        if not item["includedInRebalance"]:
            trade_value = 0.0
            action = "hold"
        elif target_weight is None:
            action = "hold"
            reason = reason or "No target assigned"
            trade_value = None
        elif abs(drift or 0.0) < request.driftThresholdPct:
            action = "hold"
            trade_value = 0.0
            reason = f"Drift is within the {request.driftThresholdPct:.2f}% threshold"
        elif trade_value is not None and abs(trade_value) < request.minTradeCad:
            action = "hold"
            trade_value = 0.0
            reason = f"Trade is below the CA${request.minTradeCad:.0f} minimum"
        elif trade_value is not None and trade_value < 0 and request.noSell:
            action = "hold"
            trade_value = 0.0
            reason = "No-sell mode is enabled"
        elif trade_value is not None:
            action = "buy" if trade_value > 0 else "sell"

        price_cad = item.get("priceCad")
        trade_shares = None
        if trade_value is not None and price_cad and price_cad > 0:
            raw_shares = trade_value / price_cad
            trade_shares = raw_shares if request.fractionalShares else int(raw_shares)
            if not request.fractionalShares:
                trade_value = trade_shares * price_cad
                if trade_shares == 0:
                    action = "hold"
                    reason = "Rounded to 0 whole shares"

        items.append(
            {
                "symbol": symbol,
                "name": item["name"],
                "securityType": item["securityType"],
                "assetClass": item["assetClass"],
                "quantity": round(item["quantity"], 6),
                "priceCad": round(price_cad, 4) if price_cad is not None else None,
                "currentValueCad": round(current_value, 2),
                "currentWeight": round(current_weight, 4),
                "targetWeight": round(target_weight, 4) if target_weight is not None else None,
                "targetValueCad": round(target_value, 2) if target_value is not None else None,
                "driftPct": round(drift, 4) if drift is not None else None,
                "tradeCad": round(trade_value, 2) if trade_value is not None else None,
                "tradeShares": round(trade_shares, 6) if trade_shares is not None else None,
                "action": action,
                "marketCap": item.get("marketCap"),
                "includedInRebalance": item["includedInRebalance"],
                "targetEligible": item.get("targetEligible", True),
                "reason": reason,
            }
        )

    if request.cashFirst:
        total_buy = sum(
            item["tradeCad"]
            for item in items
            if item["action"] == "buy" and item["tradeCad"] is not None
        )
        sell_proceeds = abs(
            sum(
                item["tradeCad"]
                for item in items
                if item["action"] == "sell" and item["tradeCad"] is not None
            )
        )
        buying_power = max(request.cashCad, 0.0) + sell_proceeds

        if total_buy > buying_power and total_buy > 0:
            scale = buying_power / total_buy
            for item in items:
                if item["action"] != "buy" or item["tradeCad"] is None:
                    continue

                item["tradeCad"] = round(item["tradeCad"] * scale, 2)
                if item["tradeShares"] is not None:
                    item["tradeShares"] = round(item["tradeShares"] * scale, 6)
                item["reason"] = (
                    f"{item['reason']}; " if item["reason"] else ""
                ) + "Scaled to available cash and sell proceeds"

    return sorted(items, key=lambda row: abs(row.get("tradeCad") or 0), reverse=True)


def _build_rebalance_plan(request: RebalancePlanRequest) -> Dict[str, Any]:
    store = _load_store()
    holdings = store.get("holdings", [])

    if not holdings:
        return {
            "items": [],
            "totalValueCad": 0.0,
            "cashCad": request.cashCad,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "settings": request.model_dump(),
            "notes": [],
        }

    positions = _prepare_rebalance_positions(holdings)
    total_value_cad = sum(item["currentValueCad"] for item in positions)
    target_plan = _assign_targets(
        positions,
        request.targetMode,
        request.manualTargets,
        request.maxSingleStockPct,
    )
    result_items = _generate_rebalance_trades(
        positions,
        target_plan["weights"],
        total_value_cad,
        request,
    )
    total_buy = sum(max(item.get("tradeCad") or 0.0, 0.0) for item in result_items)
    total_sell = sum(min(item.get("tradeCad") or 0.0, 0.0) for item in result_items)
    excluded_count = len([item for item in result_items if not item["includedInRebalance"]])

    return {
        "items": result_items,
        "totalValueCad": round(total_value_cad, 2),
        "cashCad": round(request.cashCad, 2),
        "targetMode": target_plan["mode"],
        "totalBuyCad": round(total_buy, 2),
        "totalSellCad": round(total_sell, 2),
        "excludedCount": excluded_count,
        "settings": request.model_dump(),
        "notes": target_plan["notes"],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _format_cad(value: float) -> str:
    return f"CA${abs(value):,.0f}"


def _format_symbol_list(items: List[Dict[str, Any]], limit: int = 3) -> str:
    symbols = [str(item.get("symbol", "")).strip().upper() for item in items[:limit]]
    symbols = [symbol for symbol in symbols if symbol]
    if not symbols:
        return ""
    if len(symbols) == 1:
        return symbols[0]
    if len(symbols) == 2:
        return f"{symbols[0]} and {symbols[1]}"
    return f"{', '.join(symbols[:-1])}, and {symbols[-1]}"


def _build_rebalance_summary(plan: Dict[str, Any]) -> Dict[str, Any]:
    items = plan.get("items", [])
    if not items:
        return {
            "summary": "Import your holdings first, then the dashboard can suggest a rebalance plan based on your actual portfolio weights.",
            "mode": "capped_market_cap",
            "overweights": [],
            "underweights": [],
        }

    notes = [str(note) for note in plan.get("notes", [])]
    if any("could not fetch usable market caps" in note for note in notes):
        return {
            "summary": "Market-cap data is not available right now, so the app is preserving current weights instead of suggesting trades. Try generating the plan again later, or use Equal Weight or Custom Targets on the Reweight page.",
            "mode": plan.get("targetMode", "capped_market_cap"),
            "overweights": [],
            "underweights": [],
            "totalBuyCad": 0.0,
            "totalSellCad": 0.0,
            "generatedAt": plan.get("generatedAt"),
        }

    sells = sorted(
        [item for item in items if item.get("action") == "sell" and (item.get("tradeCad") or 0) < 0],
        key=lambda item: abs(item.get("tradeCad") or 0),
        reverse=True,
    )
    buys = sorted(
        [item for item in items if item.get("action") == "buy" and (item.get("tradeCad") or 0) > 0],
        key=lambda item: abs(item.get("tradeCad") or 0),
        reverse=True,
    )
    overweights = sorted(
        [
            item
            for item in items
            if item.get("targetWeight") is not None and (item.get("driftPct") or 0) > 0
        ],
        key=lambda item: item.get("driftPct") or 0,
        reverse=True,
    )
    underweights = sorted(
        [
            item
            for item in items
            if item.get("targetWeight") is not None and (item.get("driftPct") or 0) < 0
        ],
        key=lambda item: item.get("driftPct") or 0,
    )

    sell_text = _format_symbol_list(sells)
    buy_text = _format_symbol_list(buys)
    overweight_text = _format_symbol_list(overweights)
    underweight_text = _format_symbol_list(underweights)
    total_buy = plan.get("totalBuyCad") or 0.0
    total_sell = plan.get("totalSellCad") or 0.0

    if buys or sells:
        trade_parts = []
        if sells:
            trade_parts.append(f"trim {sell_text}")
        if buys:
            trade_parts.append(f"add to {buy_text}")
        trade_text = " and ".join(trade_parts)
        summary = (
            "Using capped market-cap targets, the portfolio could rebalance by "
            f"{trade_text}. The largest overweight positions are {overweight_text or 'not material'}, "
            f"while the main underweights are {underweight_text or 'not material'}; the current plan shows "
            f"{_format_cad(total_buy)} of buys and {_format_cad(total_sell)} of sells after drift and minimum-trade rules."
        )
    elif overweights or underweights:
        summary = (
            "The portfolio is close to its capped market-cap targets after applying the current drift threshold. "
            f"The biggest positions to watch are {overweight_text or 'no material overweights'} on the overweight side "
            f"and {underweight_text or 'no material underweights'} on the underweight side."
        )
    else:
        summary = (
            "The portfolio is already close to its capped market-cap rebalance targets, so no major trade is needed under the current threshold."
        )

    return {
        "summary": summary,
        "mode": plan.get("targetMode", "capped_market_cap"),
        "overweights": overweights[:3],
        "underweights": underweights[:3],
        "totalBuyCad": round(total_buy, 2),
        "totalSellCad": round(total_sell, 2),
        "generatedAt": plan.get("generatedAt"),
    }


@app.post("/reweight/plan")
def create_rebalance_plan(payload: RebalancePlanRequest):
    return _build_rebalance_plan(payload)


@app.get("/reweight/ai-summary")
def get_rebalance_ai_summary():
    plan = _build_rebalance_plan(
        RebalancePlanRequest(
            targetMode="capped_market_cap",
            cashCad=0.0,
            driftThresholdPct=2.0,
            minTradeCad=50.0,
            maxSingleStockPct=20.0,
            fractionalShares=True,
            cashFirst=True,
            noSell=False,
        )
    )
    return _build_rebalance_summary(plan)


@app.get("/portfolio/sector-breakdown")
def get_sector_breakdown():
    return _build_sector_breakdown()


@app.get("/risk/analysis")
def get_risk_analysis():
    return _build_risk_analysis()


@app.get("/portfolio/key-insights")
def get_key_insights():
    return _build_key_insights()


@app.get("/reweight/market-cap")
def get_market_cap_reweight(
    cashCad: float = 0.0,
    driftThresholdPct: float = 2.0,
    minTradeCad: float = 50.0,
    maxSingleStockPct: float = 20.0,
    fractionalShares: bool = True,
    cashFirst: bool = True,
    noSell: bool = False,
):
    return _build_rebalance_plan(
        RebalancePlanRequest(
            targetMode="capped_market_cap",
            cashCad=cashCad,
            driftThresholdPct=driftThresholdPct,
            minTradeCad=minTradeCad,
            maxSingleStockPct=maxSingleStockPct,
            fractionalShares=fractionalShares,
            cashFirst=cashFirst,
            noSell=noSell,
        )
    )


@app.post("/analyze")
def analyze_portfolio(holdings: List[Holding]):
    total_value = sum(h.shares * h.price for h in holdings)

    results = []
    for h in holdings:
        value = h.shares * h.price
        weight = (value / total_value * 100) if total_value > 0 else 0
        results.append({
            "ticker": h.ticker,
            "shares": h.shares,
            "price": h.price,
            "value": round(value, 2),
            "weight": round(weight, 2),
        })

    recommendations = []
    if any(item["weight"] > 30 for item in results):
        recommendations.append("One holding exceeds 30% of your portfolio. Consider reducing concentration.")
    else:
        recommendations.append("Your concentration risk looks reasonable so far.")

    return {
        "totalValue": round(total_value, 2),
        "holdings": results,
        "recommendations": recommendations,
    }
