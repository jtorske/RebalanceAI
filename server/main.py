from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime, timedelta, timezone
import json
import logging
import os
import re
import time
import requests
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor, TimeoutError, as_completed

logger = logging.getLogger("rebalanceai")

_ai_summary_cache: Dict[str, Dict[str, Any]] = {}
_quote_cache: Dict[str, Dict[str, Any]] = {}
_market_cap_cache: Dict[str, Any] = {}  # keyed by date → {symbol: market_cap}
_sector_cache: Dict[str, Dict[str, Any]] = {}
_risk_profile_cache: Dict[str, Dict[str, Any]] = {}
_ticker_metadata_cache: Dict[str, Dict[str, Any]] = {}  # symbol → {data, fetched_at}
TICKER_METADATA_TTL = 7 * 24 * 3600  # 7 days
QUOTE_CACHE_TTL = 15 * 60
YFINANCE_TIMEOUT_SECONDS = 5
YFINANCE_BATCH_TIMEOUT_SECONDS = 8
AI_SUMMARY_PROMPT_VERSION = "summary-v6"
OLLAMA_GENERATE_URL = "http://localhost:11434/api/generate"
_yfinance_executor = ThreadPoolExecutor(max_workers=8)

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    return {"status": "ready", "api": "ok"}


_CORS_ORIGINS_RAW = os.getenv("CORS_ORIGINS", "*")
_cors_origins: List[str] = (
    ["*"]
    if _CORS_ORIGINS_RAW.strip() == "*"
    else [o.strip() for o in _CORS_ORIGINS_RAW.split(",") if o.strip()]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_CORS_ORIGINS_RAW.strip() != "*",
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


class HoldingsSummaryRequest(BaseModel):
    holdings: List[ImportedHolding] = []


class ManualTarget(BaseModel):
    symbol: str
    targetWeight: float


class EnrichRequest(BaseModel):
    symbols: List[str]


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
    manualMarketCaps: Dict[str, float] = {}


class RebalancePlanWithHoldingsRequest(RebalancePlanRequest):
    holdings: List[ImportedHolding] = []


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
KNOWN_SECTOR_BY_SYMBOL = {
    "AMD": "Technology",
    "ANET": "Technology",
    "AAPL": "Technology",
    "AMZN": "Consumer Discretionary",
    "CEG": "Utilities",
    "CNR": "Industrials",
    "CN": "Industrials",
    "ENB": "Energy",
    "ETN": "Industrials",
    "GDX": "Materials",
    "GEV": "Industrials",
    "GOOG": "Communication Services",
    "HG": "Materials",
    "INTC": "Technology",
    "META": "Communication Services",
    "MSFT": "Technology",
    "MU": "Technology",
    "NVDA": "Technology",
    "ONDS": "Technology",
    "SLS": "Healthcare",
    "SNDK": "Technology",
    "SU": "Energy",
    "TD": "Financials",
    "TSM": "Technology",
    "VFV": "ETF / Diversified",
    "VRT": "Industrials",
    "VST": "Utilities",
    "WDC": "Technology",
    "XEQT": "ETF / Diversified",
}
NON_SECTOR_BUCKETS = {
    "Unknown",
    "Other",
    "ETF / Diversified",
    "Fund / Diversified",
    "Derivatives",
    "Fixed Income",
    "Cash",
    "Crypto",
}


def _to_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _run_yfinance_with_timeout(
    fn: Any,
    timeout: int = YFINANCE_TIMEOUT_SECONDS,
    fallback: Any = None,
) -> Any:
    future = _yfinance_executor.submit(fn)
    try:
        return future.result(timeout=timeout)
    except TimeoutError:
        logger.warning("risk_debug yfinance timeout after %ss", timeout)
        future.cancel()
        return fallback
    except Exception as err:
        logger.warning("risk_debug yfinance failure: %s", err)
        return fallback


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

    now_ts = time.time()
    result: Dict[str, Dict[str, Any]] = {}
    to_fetch: List[str] = []
    for symbol in deduped:
        cached = _quote_cache.get(symbol)
        if cached and now_ts - cached.get("fetched_at", 0) < QUOTE_CACHE_TTL:
            result[symbol] = cached["data"]
        else:
            to_fetch.append(symbol)

    if not to_fetch:
        return result

    # OCC option symbols contain digits; regular equity/ETF symbols do not
    stock_syms = [s for s in to_fetch if not any(c.isdigit() for c in s)]
    option_syms = [s for s in to_fetch if any(c.isdigit() for c in s)]

    # ── Batch download for stocks/ETFs ──────────────────────────────────────
    if stock_syms:
        def download_stock_quotes():
            ticker_arg = stock_syms[0] if len(stock_syms) == 1 else stock_syms
            return yf.download(
                ticker_arg,
                period="5d",
                interval="1d",
                auto_adjust=True,
                progress=False,
                timeout=YFINANCE_TIMEOUT_SECONDS,
            )

        raw = _run_yfinance_with_timeout(
            download_stock_quotes,
            timeout=YFINANCE_BATCH_TIMEOUT_SECONDS,
        )
        try:
            if raw is not None and not raw.empty:
                close_col = raw["Close"]
                is_multi = hasattr(close_col, "columns")
                for sym in stock_syms:
                    try:
                        series = close_col[sym] if is_multi else close_col
                        q = _quote_from_series(sym, series)
                        if q:
                            result[sym] = q
                            _quote_cache[sym] = {"data": q, "fetched_at": now_ts}
                    except Exception as err:
                        logger.debug("Stock quote skipped for %s: %s", sym, err)
            elif raw is not None:
                logger.warning("yfinance returned empty data for stocks: %s", stock_syms)
        except Exception as err:
            logger.error("Stock batch parse failed: %s", err, exc_info=True)

    # ── Individual history fetch for option contracts ────────────────────────
    def fetch_option_quote(sym: str) -> Optional[Dict[str, Any]]:
        try:
            hist = yf.Ticker(sym).history(
                period="5d",
                interval="1d",
                timeout=YFINANCE_TIMEOUT_SECONDS,
            )
            if hist is None or hist.empty or "Close" not in hist.columns:
                return None
            return _quote_from_series(sym, hist["Close"])
        except Exception as err:
            logger.debug("Option quote skipped for %s: %s", sym, err)
            return None

    if option_syms:
        max_workers = min(4, len(option_syms))
        pool = ThreadPoolExecutor(max_workers=max_workers)
        try:
            futures = {
                pool.submit(fetch_option_quote, sym): sym
                for sym in option_syms
            }
            try:
                for future in as_completed(futures, timeout=YFINANCE_BATCH_TIMEOUT_SECONDS):
                    sym = futures[future]
                    try:
                        q = future.result(timeout=1)
                    except Exception:
                        q = None
                    if q:
                        result[sym] = q
                        _quote_cache[sym] = {"data": q, "fetched_at": now_ts}
            except TimeoutError:
                logger.warning("Option quote batch timed out for %s", option_syms)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

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


def _serialize_holdings(holdings: List[Any]) -> List[Dict[str, Any]]:
    return [
        holding.model_dump() if isinstance(holding, BaseModel) else dict(holding)
        for holding in holdings
    ]


def _compute_portfolio_vs_market(
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    holdings = holdings_override or []
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
    return snapshot


def _fallback_portfolio_vs_market(
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    holdings = holdings_override or []
    total_current_cad = 0.0
    total_previous_cad = 0.0
    per_ticker: List[Dict[str, Any]] = []

    for holding in holdings:
        symbol = str(holding.get("symbol", "")).strip().upper()
        quantity = _to_float(holding.get("quantity"))
        current_price = _to_float(holding.get("market_price"))
        market_value = _to_float(holding.get("market_value"))
        total_change = _to_float(holding.get("market_unrealized_returns"))
        currency = str(
            holding.get("market_value_currency")
            or holding.get("market_price_currency")
            or ""
        )
        if not symbol:
            continue

        if market_value is not None and market_value > 0:
            total_current_cad += _convert_to_cad(market_value, currency)
            if total_change is not None:
                total_previous_cad += _convert_to_cad(
                    max(market_value - total_change, 0),
                    currency,
                )
        elif quantity and current_price:
            total_current_cad += _convert_to_cad(quantity * current_price, currency)

        per_ticker.append(
            {
                "symbol": symbol,
                "quoteSymbol": _normalize_symbol_for_quote(holding) or symbol,
                "dailyPercent": None,
                "price": current_price,
                "previousClose": None,
            }
        )

    portfolio_daily_percent: Optional[float] = None
    if total_previous_cad > 0:
        portfolio_daily_percent = (
            (total_current_cad - total_previous_cad) / total_previous_cad
        ) * 100

    now = datetime.now(timezone.utc)
    return {
        "date": now.date().isoformat(),
        "capturedAt": now.isoformat(),
        "portfolioDailyPercent": portfolio_daily_percent,
        "marketDailyPercent": 0.0,
        "deltaPercent": portfolio_daily_percent,
        "comparisonSource": "fallback-imported-values",
        "marketSource": "fallback-zero",
        "quotesMatched": 0,
        "benchmarks": [
            {"symbol": item["symbol"], "name": item["name"], "price": None, "changePercent": None}
            for item in BENCHMARKS
        ],
        "perTicker": per_ticker,
    }

@app.on_event("startup")
async def log_routes():
    print("=== RebalanceX API routes ===", flush=True)
    for route in app.routes:
        methods = ",".join(sorted(getattr(route, "methods", None) or []))
        print(f"  {methods or '?':8s}  {getattr(route, 'path', route)}", flush=True)
    print("=============================", flush=True)


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
    raise HTTPException(
        status_code=410,
        detail="Backend JSON holdings storage has been removed. Load holdings from Supabase in the frontend and POST them to calculation endpoints.",
    )


@app.get("/market/benchmarks")
def get_market_benchmarks():
    return {"quotes": _fetch_benchmark_quotes()}


@app.get("/market/portfolio-vs-market")
def get_portfolio_vs_market():
    raise HTTPException(
        status_code=410,
        detail="Use POST /market/portfolio-vs-market with holdings in the request body.",
    )


@app.post("/market/portfolio-vs-market")
def create_portfolio_vs_market(payload: HoldingsSummaryRequest):
    holdings = _serialize_holdings(payload.holdings)
    try:
        return _compute_portfolio_vs_market(holdings)
    except Exception as exc:
        logger.error("Error in POST /market/portfolio-vs-market: %s", exc, exc_info=True)
        return _fallback_portfolio_vs_market(holdings)


@app.get("/market/portfolio-performance-history")
def get_portfolio_performance_history():
    raise HTTPException(
        status_code=410,
        detail="Backend file-based performance history has been removed.",
    )


@app.post("/holdings/import")
def import_holdings(payload: HoldingsImportRequest):
    raise HTTPException(
        status_code=410,
        detail="Backend JSON holdings imports have been removed. Save holdings to Supabase from the frontend.",
    )


@app.delete("/holdings")
def clear_holdings():
    raise HTTPException(
        status_code=410,
        detail="Backend JSON holdings storage has been removed. Delete holdings through Supabase from the frontend.",
    )

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


_PREAMBLE_PATTERNS = [
    r"^here (?:are|is) (?:two|2|a couple of|some) (?:concise )?sentences?[^:]*:\s*",
    r"^here (?:are|is) (?:two|2|a couple of|some) (?:concise )?sentences?\s+",
    r"^sure[,!]?\s+here (?:are|is)[^:]*:\s*",
    r"^certainly[,!]?\s+",
]

def _strip_llm_preamble(text: str) -> str:
    import re
    for pattern in _PREAMBLE_PATTERNS:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)
    return text.strip()


def _is_market_summary_usable(text: Optional[str]) -> bool:
    if not text:
        return False
    import re

    cleaned = text.strip()
    artifact_patterns = [
        r"\bhere(?:'s| is)\s+(?:the\s+)?(?:polished\s+)?summary\b",
        r"\balternatively\b",
        r"\ba more concise version\b",
        r"\boption\s+\d+\b",
        r"\bversion\s+\d+\b",
        r"\bsummary to polish\b",
        r"\bbenchmark context\b",
    ]
    if any(re.search(pattern, cleaned, flags=re.IGNORECASE) for pattern in artifact_patterns):
        return False
    if cleaned.count("\n") >= 2 and re.search(
        r"\b(summary|version|option|alternatively)\b",
        cleaned,
        flags=re.IGNORECASE,
    ):
        return False
    return True


def _is_local_ollama_enabled() -> bool:
    env_name = (
        os.getenv("APP_ENV")
        or os.getenv("ENV")
        or os.getenv("FASTAPI_ENV")
        or ""
    ).strip().lower()
    if os.getenv("RENDER") or os.getenv("RENDER_SERVICE_ID"):
        return False
    if env_name in {"production", "prod"}:
        return False
    if os.getenv("DISABLE_OLLAMA", "").strip().lower() in {"1", "true", "yes"}:
        return False
    return True


def _try_ollama_polish(prompt: str, timeout: int = 12) -> Optional[str]:
    if not _is_local_ollama_enabled():
        return None

    try:
        resp = requests.post(
            OLLAMA_GENERATE_URL,
            json={"model": "llama3.2", "prompt": prompt, "stream": False},
            timeout=timeout,
        )
        resp.raise_for_status()
        text = _strip_llm_preamble(
            _repair_text_encoding(resp.json().get("response", "").strip())
        )
        return text or None
    except Exception as err:
        logger.debug("Local Ollama polish skipped: %s", err)
        return None


def _format_percent(value: Optional[float]) -> str:
    if value is None:
        return "N/A"
    return f"{value:+.2f}%"


def _format_percentage_points(value: Optional[float]) -> str:
    if value is None:
        return "N/A"
    return f"{value:+.2f} pp"


def _get_portfolio_movers(
    snapshot: Dict[str, Any],
    max_items: int = 3,
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    holdings = holdings_override or []

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


def _build_portfolio_driver_sentence(
    snapshot: Dict[str, Any],
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> str:
    portfolio_daily = _to_float(snapshot.get("portfolioDailyPercent"))
    market_daily = _to_float(snapshot.get("marketDailyPercent"))
    movers = _get_portfolio_movers(snapshot, holdings_override=holdings_override)
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
    # Strip leading numbered-list / bullet markers so "1. Foo bar." → "Foo bar."
    cleaned = re.sub(r'^\d+[\.\)]\s+', '', cleaned)
    cleaned = re.sub(r'^[-*•]\s+', '', cleaned).strip()

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


def _format_directional_percent(value: Optional[float]) -> str:
    if value is None:
        return "unavailable"
    if value > 0:
        return f"up {abs(value):.2f}%"
    if value < 0:
        return f"down {abs(value):.2f}%"
    return "flat at 0.00%"


def _build_fallback_ai_summary(
    snapshot: Dict[str, Any],
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Optional[str]:
    portfolio_daily = _to_float(snapshot.get("portfolioDailyPercent"))
    market_daily = _to_float(snapshot.get("marketDailyPercent"))
    movers = _get_portfolio_movers(snapshot, holdings_override=holdings_override)
    driver_symbols = [
        item["symbol"]
        for item in sorted(
            movers["leaders"] + movers["laggards"],
            key=lambda item: abs(item.get("contributionPercent", 0)),
            reverse=True,
        )
    ][:3]

    if portfolio_daily is None and market_daily is None:
        benchmark_parts = [
            f"{item.get('symbol')} {_format_percent(_to_float(item.get('changePercent')))}"
            for item in snapshot.get("benchmarks", [])
            if _to_float(item.get("changePercent")) is not None
        ][:3]
        if not benchmark_parts:
            return None
        return (
            "Benchmark data is available, but portfolio driver data is not available yet. "
            f"Current benchmark moves include {', '.join(benchmark_parts)}."
        )

    if portfolio_daily is None:
        return (
            f"The benchmark average is {_format_directional_percent(market_daily)} today. "
            "Portfolio driver data is not available yet."
        )

    if market_daily is None:
        market_sentence = "benchmark data is not available yet"
    else:
        market_sentence = (
            f"a benchmark average that is {_format_directional_percent(market_daily)}"
        )

    if driver_symbols:
        driver_sentence = (
            f"Main drivers include {', '.join(driver_symbols)} based on current holdings "
            "and daily quote data."
        )
    else:
        driver_sentence = "Ticker-level drivers are not available from current quote data."

    return (
        f"The portfolio is {_format_directional_percent(portfolio_daily)} today, "
        f"compared with {market_sentence}. {driver_sentence}"
    )


def _get_ai_summary_response(
    force: bool = False,
    holdings_override: Optional[List[Dict[str, Any]]] = None,
):
    today = datetime.now(timezone.utc).date().isoformat()

    portfolio_snapshot = _compute_portfolio_vs_market(holdings_override)
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
        "holdingsSource": "request" if holdings_override is not None else "store",
        "holdings": [
            {
                "symbol": item.get("symbol"),
                "marketValue": item.get("market_value"),
                "quantity": item.get("quantity"),
            }
            for item in (holdings_override or [])
        ],
    }
    cache_key = f"{today}:{AI_SUMMARY_PROMPT_VERSION}:{json.dumps(cache_payload, sort_keys=True)}"

    if not force and cache_key in _ai_summary_cache:
        cached = _ai_summary_cache[cache_key]
        return {
            "summary": cached.get("summary"),
            "cached": True,
            "source": cached.get("source", "fallback"),
            "date": today,
            "portfolioDrivers": cached.get("portfolioDrivers", {"leaders": [], "laggards": []}),
        }

    fallback_summary = _build_fallback_ai_summary(
        portfolio_snapshot,
        holdings_override=holdings_override,
    ) or (
        "No portfolio or benchmark quote data is available yet, so a market summary "
        "cannot be calculated from current holdings."
    )
    portfolio_drivers = _get_portfolio_movers(
        portfolio_snapshot,
        holdings_override=holdings_override,
    )

    prompt = (
        "Polish this portfolio dashboard market summary without changing any facts, "
        "numbers, or ticker symbols. Return one or two concise professional sentences. "
        "Do not add news, causes, recommendations, or extra context.\n\n"
        f"Benchmark context for verification:\n{chr(10).join(benchmark_lines)}\n\n"
        f"Summary to polish:\n{fallback_summary}"
    )
    polished = _try_ollama_polish(prompt, timeout=12)
    if not _is_market_summary_usable(polished):
        polished = None
    summary = polished or fallback_summary
    source = "ollama" if polished else "fallback"

    _ai_summary_cache[cache_key] = {
        "summary": summary,
        "source": source,
        "portfolioDrivers": portfolio_drivers,
    }
    return {
        "summary": summary,
        "cached": False,
        "source": source,
        "date": today,
        "portfolioDrivers": portfolio_drivers,
    }


@app.get("/market/ai-summary")
def get_ai_summary(force: bool = False):
    raise HTTPException(
        status_code=410,
        detail="Use POST /market/ai-summary with holdings in the request body.",
    )


@app.post("/market/ai-summary")
def create_ai_summary(payload: HoldingsSummaryRequest, force: bool = False):
    try:
        return _get_ai_summary_response(
            force=force,
            holdings_override=_serialize_holdings(payload.holdings),
        )
    except Exception as exc:
        logger.error("Error in POST /market/ai-summary: %s", exc, exc_info=True)
        return {
            "summary": "Market summary is temporarily unavailable.",
            "cached": False,
            "source": "fallback",
            "date": datetime.now(timezone.utc).date().isoformat(),
            "portfolioDrivers": {"leaders": [], "laggards": []},
        }


def _fetch_market_cap_single(symbol: str) -> Optional[float]:
    """Try fast_info then full .info to get market cap. Returns None only if both fail."""
    try:
        fast = _run_yfinance_with_timeout(
            lambda: yf.Ticker(symbol).fast_info,
            timeout=YFINANCE_TIMEOUT_SECONDS,
            fallback=None,
        )
        if fast is None:
            raise ValueError("fast_info unavailable")
        mc = getattr(fast, "market_cap", None)
        if mc and float(mc) > 0:
            return float(mc)
        shares = getattr(fast, "shares", None)
        price = getattr(fast, "last_price", None)
        if shares and price and float(shares) > 0 and float(price) > 0:
            return float(shares) * float(price)
    except Exception:
        pass

    try:
        info = _run_yfinance_with_timeout(
            lambda: yf.Ticker(symbol).info,
            timeout=YFINANCE_TIMEOUT_SECONDS,
            fallback={},
        )
        mc = info.get("marketCap") or info.get("totalAssets")
        if mc and float(mc) > 0:
            return float(mc)
        shares = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding")
        price = info.get("currentPrice") or info.get("regularMarketPrice")
        if shares and price and float(shares) > 0 and float(price) > 0:
            return float(shares) * float(price)
    except Exception:
        pass

    return None


def _fetch_market_caps(symbols: List[str]) -> Dict[str, Optional[float]]:
    today = datetime.now(timezone.utc).date().isoformat()
    # Evict stale date entries without touching today's successful cache
    for stale in [d for d in list(_market_cap_cache.keys()) if d != today]:
        del _market_cap_cache[stale]
    cached = _market_cap_cache.setdefault(today, {})

    # Only fetch symbols not yet successfully resolved; failed symbols (absent from cache)
    # are retried on every request so transient yfinance errors self-heal.
    to_fetch = sorted({s for s in symbols if s not in cached})
    if to_fetch:
        max_workers = min(6, len(to_fetch))
        pool = ThreadPoolExecutor(max_workers=max_workers)
        try:
            futures = {
                pool.submit(_fetch_market_cap_single, symbol): symbol
                for symbol in to_fetch
            }
            try:
                for future in as_completed(futures, timeout=12):
                    symbol = futures[future]
                    try:
                        mc = future.result(timeout=1)
                    except Exception:
                        mc = None
                    if mc is not None:
                        cached[symbol] = mc
            except TimeoutError:
                logger.warning("Market cap batch timed out for %s", to_fetch)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        # Do NOT cache None — absent entry means "retry next call"

    return {symbol: cached.get(symbol) for symbol in symbols}


# ── Ticker enrichment ─────────────────────────────────────────────────────────

def _enrich_ticker_single(symbol: str) -> Dict[str, Any]:
    """Fetch metadata for one ticker via yfinance. Never raises."""
    now_iso = datetime.now(timezone.utc).isoformat()
    base: Dict[str, Any] = {
        "symbol": symbol,
        "status": "unresolved",
        "source": "yfinance",
        "updatedAt": now_iso,
    }
    try:
        ticker = yf.Ticker(symbol)

        # fast_info: lightweight, gets market cap + currency reliably
        mc: Optional[float] = None
        currency: Optional[str] = None
        try:
            fast = ticker.fast_info
            raw_mc = getattr(fast, "market_cap", None)
            mc = float(raw_mc) if raw_mc and float(raw_mc) > 0 else None
            currency = getattr(fast, "currency", None)
        except Exception:
            pass

        # .info: heavier, gets name / sector / exchange / asset type
        name: Optional[str] = None
        exchange: Optional[str] = None
        sector: Optional[str] = None
        asset_type: Optional[str] = None
        try:
            info = ticker.info
            name = info.get("longName") or info.get("shortName")
            exchange = info.get("exchange") or info.get("fullExchangeName")
            sector = info.get("sector") or None
            asset_type = info.get("quoteType") or None
            if not mc:
                raw_mc2 = info.get("marketCap") or info.get("totalAssets")
                mc = float(raw_mc2) if raw_mc2 and float(raw_mc2) > 0 else None
            if not currency:
                currency = info.get("currency")
        except Exception:
            pass

        result: Dict[str, Any] = {
            **base,
            "name": name,
            "exchange": exchange,
            "sector": sector,
            "assetType": asset_type,
            "marketCap": mc,
            "currency": currency,
        }

        if name and exchange:
            result["status"] = "resolved"
        elif name or exchange or mc:
            result["status"] = "partial"

        return result
    except Exception:
        return base


def _enrich_tickers_batch(symbols: List[str]) -> Dict[str, Any]:
    """Enrich a list of symbols, returning cached results where available."""
    now_ts = time.time()
    result: Dict[str, Any] = {}
    to_fetch: List[str] = []

    for sym in symbols:
        cached = _ticker_metadata_cache.get(sym)
        if cached and now_ts - cached.get("fetched_at", 0) < TICKER_METADATA_TTL:
            result[sym] = cached["data"]
        else:
            to_fetch.append(sym)

    if not to_fetch:
        return result

    max_workers = min(10, len(to_fetch))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_enrich_ticker_single, sym): sym for sym in to_fetch}
        for future in as_completed(futures, timeout=20):
            sym = futures[future]
            try:
                data = future.result(timeout=15)
            except Exception:
                data = {
                    "symbol": sym,
                    "status": "unresolved",
                    "source": "yfinance",
                    "updatedAt": datetime.now(timezone.utc).isoformat(),
                }
            _ticker_metadata_cache[sym] = {"data": data, "fetched_at": now_ts}
            result[sym] = data

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

    base_symbol = normalized.split(".", 1)[0]
    if base_symbol in KNOWN_SECTOR_BY_SYMBOL:
        sector = KNOWN_SECTOR_BY_SYMBOL[base_symbol]
        _sector_cache[normalized] = {"sector": sector}
        return sector

    cached = _sector_cache.get(normalized)
    if cached is not None:
        return cached.get("sector")

    info = _run_yfinance_with_timeout(
        lambda: yf.Ticker(normalized).info,
        timeout=YFINANCE_TIMEOUT_SECONDS,
        fallback={},
    )
    try:
        sector = str(info.get("sector") or "").strip()
        _sector_cache[normalized] = {"sector": sector or None}
        return sector or None
    except Exception as err:
        logger.debug("Sector lookup skipped for %s: %s", normalized, err)
        _sector_cache[normalized] = {"sector": None}
        return None


def _infer_sector_from_name(name: str) -> Optional[str]:
    normalized = name.strip().upper()
    if not normalized:
        return None
    if "TECH" in normalized or "SEMICONDUCTOR" in normalized:
        return "Technology"
    if "HEALTH" in normalized or "PHARMA" in normalized or "BIO" in normalized:
        return "Healthcare"
    if "ENERGY" in normalized or "POWER" in normalized or "OIL" in normalized:
        return "Energy"
    if "BANK" in normalized or "FINANC" in normalized or "INSURANCE" in normalized:
        return "Financials"
    if "MINING" in normalized or "GOLD" in normalized or "METAL" in normalized:
        return "Materials"
    if "REIT" in normalized or "REAL ESTATE" in normalized:
        return "Real Estate"
    if "COMM" in normalized or "MEDIA" in normalized:
        return "Communication Services"
    return None


def _sector_for_holding(holding: Dict[str, Any]) -> Dict[str, Any]:
    normalized_symbol = _normalize_symbol_for_quote(holding)
    raw_symbol = str(holding.get("symbol", "")).strip().upper()
    name = str(holding.get("name", "")).strip()
    asset_class = _classify_asset(holding, normalized_symbol or raw_symbol)

    if asset_class == "stock" and normalized_symbol:
        base_symbol = normalized_symbol.split(".", 1)[0]
        sector = (
            KNOWN_SECTOR_BY_SYMBOL.get(base_symbol)
            or _infer_sector_from_name(name)
            or "Unknown"
        )
        _sector_cache.setdefault(normalized_symbol, {"sector": sector})
        source = "known" if sector != "Unknown" else "unavailable"
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
        sector = "Unknown"
        source = "fallback"

    return {
        "symbol": raw_symbol,
        "quoteSymbol": normalized_symbol,
        "sector": sector,
        "assetClass": asset_class,
        "source": source,
    }


def _build_sector_breakdown(
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    holdings = holdings_override or []
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


def _risk_debug_symbol_snapshot(holdings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    snapshot: List[Dict[str, Any]] = []
    for holding in holdings:
        raw_symbol = str(holding.get("symbol", "")).strip().upper()
        normalized = _normalize_symbol_for_quote(holding)
        asset_class = _classify_asset(holding, normalized or raw_symbol)
        sector_info = _sector_for_holding(holding)
        snapshot.append(
            {
                "symbol": raw_symbol,
                "quoteSymbol": normalized,
                "assetClass": asset_class,
                "sector": sector_info.get("sector"),
                "sectorSource": sector_info.get("source"),
                "securityType": str(holding.get("security_type", "")).strip(),
            }
        )
    return snapshot


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
        "sector": KNOWN_SECTOR_BY_SYMBOL.get(normalized.split(".", 1)[0]),
        "earningsDate": None,
        "newsTitles": [],
    }

    try:
        ticker = yf.Ticker(normalized)
        info = _run_yfinance_with_timeout(
            lambda: ticker.info or {},
            timeout=YFINANCE_TIMEOUT_SECONDS,
            fallback={},
        )
        news_titles = _run_yfinance_with_timeout(
            lambda: _extract_news_titles(ticker),
            timeout=YFINANCE_TIMEOUT_SECONDS,
            fallback=[],
        )
        profile = {
            "marketCap": _to_float(info.get("marketCap") or info.get("totalAssets")),
            "beta": _to_float(info.get("beta")),
            "sector": str(info.get("sector") or "").strip()
            or profile.get("sector"),
            "earningsDate": _extract_earnings_date(info),
            "newsTitles": news_titles,
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
    metrics: Optional[Dict[str, Any]] = None,
) -> None:
    concerns.append(
        {
            "symbol": symbol,
            "title": title,
            "detail": detail,
            "severity": severity,
            "category": category,
            "weight": round(weight, 2) if weight is not None else None,
            "metrics": metrics or {},
        }
    )


def _confirmed_risk_concerns(concerns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        item
        for item in concerns
        if str(item.get("category", "")).strip().lower() != "data quality"
        and not (item.get("metrics") or {}).get("dataQuality")
    ]


def _fallback_risk_summary(concerns: List[Dict[str, Any]]) -> str:
    confirmed = _confirmed_risk_concerns(concerns)
    if not confirmed:
        return "No major portfolio risks stand out from the current holdings data, but keep monitoring concentration, earnings dates, and liquidity."

    top = confirmed[:3]
    readable = ", ".join(
        f"{item['symbol']} ({item['category'].lower()})" for item in top
    )
    return f"The main risks to review are {readable}. Check whether these positions are intentional, especially if they combine high weight, small market cap, volatility, or near-term catalysts."


def _is_risk_summary_usable(text: Optional[str]) -> bool:
    """Return True only when the text is a real prose sentence, not a list fragment."""
    if not text:
        return False
    stripped = text.strip()
    if stripped in {"1", "1."}:
        return False
    if re.match(r"^\d+\.?$", stripped):
        return False
    if len(stripped) < 20:
        return False
    # Reject if the text opens with a numbered or bulleted list marker
    if re.match(r'^\d+[\.\)]\s', stripped) or re.match(r'^[-*•]\s', stripped):
        return False
    # Reject if the first clause (before the first ". ") is too short to be a sentence
    first_clause = stripped.split(". ", 1)[0].strip() if ". " in stripped else stripped
    if len(first_clause) < 12:
        return False
    return True


def _ai_risk_summary(
    concerns: List[Dict[str, Any]],
    holdings_count: int,
) -> Tuple[str, str]:
    fallback = _fallback_risk_summary(concerns)
    confirmed = _confirmed_risk_concerns(concerns)
    if not confirmed:
        return fallback, "fallback"

    concern_lines = [
        f"- {item['symbol']}: {item['title']} | {item['detail']} | severity={item['severity']}"
        for item in confirmed[:8]
    ]
    prompt = (
        "Write exactly 2 concise prose sentences for a portfolio risk dashboard. "
        "Do NOT use numbered lists, bullet points, or markdown. "
        "Do not give financial advice, do not say buy or sell, and only use the facts below. "
        f"The portfolio has {holdings_count} holdings.\n"
        + "\n".join(concern_lines)
    )

    polished = _try_ollama_polish(prompt, timeout=12)
    if _is_risk_summary_usable(polished):
        return polished, "ollama"
    return fallback, "fallback"


def _build_risk_analysis(
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    holdings = holdings_override or []
    positions = _prepare_rebalance_positions(holdings)
    total_value = sum(item["currentValueCad"] for item in positions)
    concerns: List[Dict[str, Any]] = []
    missing_market_cap_candidates: List[Dict[str, Any]] = []

    logger.info(
        "risk_debug holdings_count=%s raw_symbols=%s",
        len(holdings),
        [str(item.get("symbol", "")).strip().upper() for item in holdings],
    )
    logger.info("risk_debug symbol_snapshot=%s", _risk_debug_symbol_snapshot(holdings))

    sector_data = _build_sector_breakdown(holdings)
    logger.info("risk_debug sector_breakdown=%s", sector_data.get("perTicker", []))
    for sector in sector_data.get("sectors", []):
        sector_name = str(sector.get("sector") or "").strip()
        if sector_name in NON_SECTOR_BUCKETS:
            continue

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

    risk_symbols = sorted(
        {
            str(item.get("quoteSymbol") or item.get("symbol") or "").strip().upper()
            for item in positions
            if item.get("assetClass") == "stock"
        }
    )
    risk_profiles: Dict[str, Dict[str, Any]] = {}
    if risk_symbols:
        max_workers = min(6, len(risk_symbols))
        pool = ThreadPoolExecutor(max_workers=max_workers)
        try:
            futures = {
                pool.submit(_fetch_risk_profile, symbol): symbol
                for symbol in risk_symbols
            }
            try:
                for future in as_completed(futures, timeout=18):
                    symbol = futures[future]
                    try:
                        risk_profiles[symbol] = future.result(timeout=1)
                    except Exception:
                        risk_profiles[symbol] = {}
            except TimeoutError:
                logger.warning("Risk profile batch timed out for %s", risk_symbols)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    logger.info(
        "risk_debug market_caps=%s",
        {
            symbol: risk_profiles.get(symbol, {}).get("marketCap")
            for symbol in risk_symbols
        },
    )

    for item in positions:
        if total_value <= 0 or item["currentValueCad"] <= 0:
            continue

        symbol = item["symbol"]
        quote_symbol = item.get("quoteSymbol") or symbol
        weight = item["currentValueCad"] / total_value * 100
        asset_class = item.get("assetClass")

        if _is_broad_diversified_fund(item):
            pass
        elif weight >= 30:
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

        profile = risk_profiles.get(str(quote_symbol).strip().upper(), {})
        market_cap = _to_float(profile.get("marketCap"))
        beta = _to_float(profile.get("beta"))
        earnings_date = profile.get("earningsDate")
        earnings_days = _days_until(earnings_date)

        if market_cap is None:
            missing_market_cap_candidates.append(
                {
                    "symbol": symbol,
                    "weight": weight,
                    "detail": "Market-cap metadata is temporarily unavailable for this ticker.",
                }
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
                {"marketCap": market_cap, "marketCapLabel": f"${market_cap / 1e6:.0f}M"},
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
                {"marketCap": market_cap, "marketCapLabel": f"${market_cap / 1e9:.2f}B"},
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
                {"beta": round(beta, 2)},
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
                {"earningsDate": earnings_date, "earningsInDays": earnings_days},
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

    for item in sorted(
        missing_market_cap_candidates,
        key=lambda value: value.get("weight") or 0,
        reverse=True,
    )[:3]:
        _add_risk(
            concerns,
            item["symbol"],
            "Ticker metadata temporarily unavailable",
            item["detail"],
            "low",
            "Data quality",
            item["weight"],
            {"dataQuality": True},
        )

    concerns.sort(
        key=lambda item: (
            str(item.get("category")) == "Data quality",
            _risk_severity_rank(str(item.get("severity"))),
            -(item.get("weight") or 0),
        )
    )
    concerns = concerns[:12]
    summary, summary_source = _ai_risk_summary(concerns, len(positions))
    dashboard_summary = _first_sentence(summary) or _fallback_risk_summary(concerns)
    if not _is_risk_summary_usable(dashboard_summary):
        dashboard_summary = _fallback_risk_summary(concerns)

    data_quality = {
        "metadataIncomplete": any(
            str(item.get("category")) == "Data quality" for item in concerns
        ),
        "message": (
            "Some ticker metadata is temporarily unavailable, so risk analysis is based on available holdings data."
            if any(str(item.get("category")) == "Data quality" for item in concerns)
            else None
        ),
    }
    if data_quality["metadataIncomplete"] and not _confirmed_risk_concerns(concerns):
        summary = data_quality["message"] or _fallback_risk_summary(concerns)
        dashboard_summary = summary
        summary_source = "fallback"

    logger.info(
        "risk_debug final_concerns=%s",
        [
            {
                "symbol": item.get("symbol"),
                "title": item.get("title"),
                "severity": item.get("severity"),
                "category": item.get("category"),
                "weight": item.get("weight"),
            }
            for item in concerns
        ],
    )

    return {
        "summary": summary,
        "dashboardSummary": dashboard_summary,
        "source": summary_source,
        "concerns": concerns,
        "dataQuality": data_quality,
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


def _is_broad_diversified_fund(position: Dict[str, Any]) -> bool:
    symbol = str(position.get("symbol", "")).strip().upper()
    quote_symbol = str(position.get("quoteSymbol", "")).strip().upper()
    asset_class = str(position.get("assetClass", "")).strip().lower()
    name = str(position.get("name", "")).strip().upper()

    if asset_class not in {"etf", "mutual_fund"}:
        return False

    if symbol in {"XEQT", "VEQT", "ZEQT", "XGRO", "VGRO", "ZGRO", "XBAL", "VBAL", "VT", "VTI", "SPY", "VOO"}:
        return True

    if quote_symbol in {"XEQT.TO", "VEQT.TO", "ZEQT.TO", "XGRO.TO", "VGRO.TO", "ZGRO.TO", "XBAL.TO", "VBAL.TO"}:
        return True

    diversified_terms = [
        "ALL EQUITY",
        "CORE EQUITY ETF PORTFOLIO",
        "ASSET ALLOCATION",
        "BALANCED ETF",
        "GROWTH ETF PORTFOLIO",
        "TOTAL MARKET",
        "TOTAL WORLD",
    ]
    return any(term in name for term in diversified_terms)


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


def _ai_key_insights_summary(insights: List[Dict[str, Any]]) -> Tuple[str, str]:
    fallback = _fallback_key_insights_summary(insights)
    if not insights:
        return fallback, "fallback"

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

    polished = _try_ollama_polish(prompt, timeout=12)
    return (polished, "ollama") if polished else (fallback, "fallback")


def _build_key_insights(
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    holdings = holdings_override or []
    positions = _prepare_rebalance_positions(holdings)
    total_value = sum(item["currentValueCad"] for item in positions)
    sector_data = _build_sector_breakdown(holdings)
    insights: List[Dict[str, Any]] = []

    if not holdings or total_value <= 0:
        return {
            "summary": _fallback_key_insights_summary([]),
            "source": "fallback",
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
        if top_weight >= 25 and _is_broad_diversified_fund(top_position):
            _add_insight(
                insights,
                f"{top_position['symbol']} is a diversified core sleeve",
                f"{top_position['symbol']} is {top_weight:.1f}% of the portfolio, but it is a broad diversified fund rather than a single-company bet.",
                "Concentration",
                "positive",
                [top_position["symbol"]],
            )
        elif top_weight >= 25:
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

    summary, summary_source = _ai_key_insights_summary(insights)

    return {
        "summary": summary,
        "source": summary_source,
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
    manual_market_caps: Optional[Dict[str, float]] = None,
) -> Dict[str, float]:
    weights: Dict[str, float] = {}
    manual_market_caps = manual_market_caps or {}
    stock_positions = [
        item
        for item in positions
        if item["includedInRebalance"] and item["assetClass"] == "stock"
    ]
    market_caps = _fetch_market_caps([item["quoteSymbol"] for item in stock_positions])
    manual_cap_symbols: List[str] = []
    for item in stock_positions:
        symbol = item["symbol"].upper()
        quote_symbol = item["quoteSymbol"].upper()
        manual_cap = manual_market_caps.get(symbol) or manual_market_caps.get(quote_symbol)
        if manual_cap is not None:
            item["marketCap"] = manual_cap
            manual_cap_symbols.append(item["symbol"])
        else:
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

    if manual_cap_symbols:
        notes.append(
            "Manual market caps were applied for "
            + ", ".join(sorted(set(manual_cap_symbols)))
            + "."
        )

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
    manual_market_caps: Optional[Dict[str, float]] = None,
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
            manual_market_caps=manual_market_caps,
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


def _build_rebalance_plan(
    request: RebalancePlanRequest,
    holdings_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    holdings = holdings_override or []

    if not holdings:
        return {
            "items": [],
            "totalValueCad": 0.0,
            "cashCad": request.cashCad,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "settings": request.model_dump(exclude={"holdings"}),
            "notes": [],
        }

    positions = _prepare_rebalance_positions(holdings)
    total_value_cad = sum(item["currentValueCad"] for item in positions)
    normalized_manual_caps = {k.upper(): v for k, v in request.manualMarketCaps.items() if v and v > 0}
    target_plan = _assign_targets(
        positions,
        request.targetMode,
        request.manualTargets,
        request.maxSingleStockPct,
        manual_market_caps=normalized_manual_caps or None,
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
        "settings": request.model_dump(exclude={"holdings"}),
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
    max_top_actions = 5
    items = plan.get("items", [])
    if not items:
        return {
            "summary": "Import your holdings first, then the dashboard can suggest a rebalance plan based on your actual portfolio weights.",
            "source": "fallback",
            "mode": "capped_market_cap",
            "overweights": [],
            "underweights": [],
            "topTrades": [],
            "tradeCount": 0,
        }

    notes = [str(note) for note in plan.get("notes", [])]
    if any("could not fetch usable market caps" in note for note in notes):
        return {
            "summary": "Market-cap data is not available right now, so the app is preserving current weights instead of suggesting trades. Try generating the plan again later, or use Equal Weight or Custom Targets on the Reweight page.",
            "source": "fallback",
            "mode": plan.get("targetMode", "capped_market_cap"),
            "overweights": [],
            "underweights": [],
            "totalBuyCad": 0.0,
            "totalSellCad": 0.0,
            "generatedAt": plan.get("generatedAt"),
            "topTrades": [],
            "tradeCount": 0,
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
    actionable_trades = [*sells, *buys]
    actionable_trades = sorted(
        actionable_trades,
        key=lambda item: abs(item.get("tradeCad") or 0),
        reverse=True,
    )

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
        "source": "fallback",
        "mode": plan.get("targetMode", "capped_market_cap"),
        "trimSymbols": [item.get("symbol", "") for item in sells[:max_top_actions]],
        "addSymbols": [item.get("symbol", "") for item in buys[:max_top_actions]],
        "overweights": overweights[:max_top_actions],
        "underweights": underweights[:max_top_actions],
        "totalBuyCad": round(total_buy, 2),
        "totalSellCad": round(total_sell, 2),
        "generatedAt": plan.get("generatedAt"),
        "topTrades": [
            {
                "symbol": item.get("symbol", ""),
                "action": item.get("action", "hold"),
                "tradeCad": round(abs(item.get("tradeCad") or 0.0), 2),
            }
            for item in actionable_trades[:max_top_actions]
        ],
        "tradeCount": len(actionable_trades),
    }


@app.post("/reweight/plan")
def create_rebalance_plan(payload: RebalancePlanWithHoldingsRequest):
    return _build_rebalance_plan(
        payload,
        holdings_override=_serialize_holdings(payload.holdings),
    )


@app.get("/reweight/ai-summary")
def get_rebalance_ai_summary():
    raise HTTPException(
        status_code=410,
        detail="Use POST /reweight/ai-summary with holdings in the request body.",
    )


@app.post("/reweight/ai-summary")
def create_rebalance_ai_summary(payload: HoldingsSummaryRequest):
    try:
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
            ),
            holdings_override=_serialize_holdings(payload.holdings),
        )
        return _build_rebalance_summary(plan)
    except Exception as exc:
        logger.error("Error in POST /reweight/ai-summary: %s", exc, exc_info=True)
        return {
            "summary": "Rebalance summary is temporarily unavailable.",
            "source": "fallback",
            "mode": "capped_market_cap",
            "overweights": [],
            "underweights": [],
            "topTrades": [],
            "tradeCount": 0,
        }


@app.get("/portfolio/sector-breakdown")
def get_sector_breakdown():
    raise HTTPException(
        status_code=410,
        detail="Use POST /portfolio/sector-breakdown with holdings in the request body.",
    )


@app.post("/portfolio/sector-breakdown")
def create_sector_breakdown(payload: HoldingsSummaryRequest):
    try:
        return _build_sector_breakdown(_serialize_holdings(payload.holdings))
    except Exception as exc:
        logger.error("Error in POST /portfolio/sector-breakdown: %s", exc, exc_info=True)
        now = datetime.now(timezone.utc)
        return {
            "sectors": [],
            "perTicker": [],
            "totalValueCad": 0,
            "generatedAt": now.isoformat(),
            "source": "fallback",
        }


@app.get("/risk/analysis")
def get_risk_analysis():
    raise HTTPException(
        status_code=410,
        detail="Use POST /risk/analysis with holdings in the request body.",
    )


@app.post("/risk/analysis")
def create_risk_analysis(payload: HoldingsSummaryRequest):
    try:
        return _build_risk_analysis(_serialize_holdings(payload.holdings))
    except Exception as exc:
        logger.error("Error in POST /risk/analysis: %s", exc, exc_info=True)
        return {
            "summary": "Risk analysis is temporarily unavailable.",
            "dashboardSummary": "Risk analysis is temporarily unavailable.",
            "source": "fallback",
            "concerns": [],
            "dataQuality": {
                "metadataIncomplete": True,
                "message": "Some ticker metadata is temporarily unavailable, so risk analysis is based on available holdings data.",
            },
            "holdingsAnalyzed": 0,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }


@app.post("/tickers/enrich")
def enrich_tickers_endpoint(request: EnrichRequest):
    symbols = list({s.strip().upper() for s in request.symbols if s.strip()})
    if not symbols:
        return {}
    return _enrich_tickers_batch(symbols)


@app.get("/portfolio/earnings-calendar")
def get_earnings_calendar():
    raise HTTPException(
        status_code=410,
        detail="Use POST /portfolio/earnings-calendar with holdings in the request body.",
    )


@app.post("/portfolio/earnings-calendar")
def create_earnings_calendar(payload: HoldingsSummaryRequest):
    holdings = _serialize_holdings(payload.holdings)
    positions = _prepare_rebalance_positions(holdings)

    today = datetime.now(timezone.utc).date()
    cutoff = today + timedelta(days=90)
    events: Dict[str, List[str]] = {}

    for item in positions:
        if item.get("assetClass") != "stock":
            continue
        symbol = item["symbol"]
        quote_symbol = item.get("quoteSymbol") or symbol
        profile = _fetch_risk_profile(quote_symbol)
        earnings_date = profile.get("earningsDate")
        if not earnings_date:
            continue
        try:
            date = datetime.fromisoformat(str(earnings_date)).date()
        except (ValueError, TypeError):
            continue
        if today <= date <= cutoff:
            date_str = date.isoformat()
            if date_str not in events:
                events[date_str] = []
            if symbol not in events[date_str]:
                events[date_str].append(symbol)

    sorted_events = [{"date": d, "symbols": s} for d, s in sorted(events.items())]
    return {"events": sorted_events, "generatedAt": datetime.now(timezone.utc).isoformat()}


@app.get("/portfolio/key-insights")
def get_key_insights():
    raise HTTPException(
        status_code=410,
        detail="Use POST /portfolio/key-insights with holdings in the request body.",
    )


@app.post("/portfolio/key-insights")
def create_key_insights(payload: HoldingsSummaryRequest):
    return _build_key_insights(_serialize_holdings(payload.holdings))


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
    raise HTTPException(
        status_code=410,
        detail="Use POST /reweight/plan with holdings in the request body.",
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
