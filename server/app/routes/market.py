from app.routes._legacy import router_from_legacy


router = router_from_legacy(
    [
        "/market/benchmarks",
        "/market/portfolio-vs-market",
        "/market/portfolio-performance-history",
        "/market/ai-summary",
        "/tickers/enrich",
    ]
)
