from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from pathlib import Path
from datetime import datetime, timezone
import json
import logging
import requests
import yfinance as yf

logger = logging.getLogger("rebalanceai")

_ai_summary_cache: Dict[str, str] = {}

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
        closes = raw["Close"].dropna().tolist()
        return {
            "status": "ok",
            "symbol": "SPY",
            "rows_fetched": len(raw),
            "last_3_closes": closes[-3:],
            "daily_change_pct": round((closes[-1] - closes[-2]) / closes[-2] * 100, 4) if len(closes) >= 2 else None,
        }
    except Exception as err:
        return {"status": "error", "detail": str(err)}


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

def _fetch_market_headlines(symbols: List[str], max_total: int = 8) -> List[str]:
    seen: set = set()
    headlines: List[str] = []
    cutoff = datetime.now(timezone.utc).timestamp() - 86400  # last 24 h
    for symbol in symbols:
        try:
            news = yf.Ticker(symbol).news or []
            for item in news:
                title = (item.get("title") or "").strip()
                ts = item.get("providerPublishTime", 0)
                if title and title not in seen and ts >= cutoff:
                    seen.add(title)
                    headlines.append(title)
                    if len(headlines) >= max_total:
                        return headlines
        except Exception:
            pass
    return headlines


@app.get("/market/ai-summary")
def get_ai_summary():
    today = datetime.now(timezone.utc).date().isoformat()

    if today in _ai_summary_cache:
        return {"summary": _ai_summary_cache[today], "cached": True, "date": today}

    benchmarks = _fetch_benchmark_quotes()
    benchmark_lines = []
    for b in benchmarks:
        pct = b.get("changePercent")
        pct_str = f"{pct:+.2f}%" if pct is not None else "N/A"
        benchmark_lines.append(f"- {b['name']} ({b['symbol']}): {pct_str}")

    benchmark_symbols = [b["symbol"] for b in benchmarks]
    headlines = _fetch_market_headlines(benchmark_symbols)
    news_section = ""
    if headlines:
        news_section = "\n\nRecent market headlines:\n" + "\n".join(f"- {h}" for h in headlines)

    prompt = (
        f"Today's benchmark moves ({today}):\n"
        + "\n".join(benchmark_lines)
        + news_section
        + "\n\nWrite exactly 2 sentences of market commentary for a portfolio dashboard, "
        "referencing relevant headlines where they explain the moves. "
        "Be factual, neutral, and concise. No headers or bullet points."
    )

    try:
        resp = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": "llama3.2", "prompt": prompt, "stream": False},
            timeout=30,
        )
        resp.raise_for_status()
        summary = resp.json().get("response", "").strip()
        _ai_summary_cache[today] = summary
        return {"summary": summary, "cached": False, "date": today}
    except Exception as err:
        logger.error("AI summary failed: %s", err)
        return {"summary": None, "error": str(err), "date": today}


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