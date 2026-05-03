from app.routes._legacy import router_from_legacy


router = router_from_legacy(
    [
        "/reweight/plan",
        "/reweight/ai-summary",
        "/reweight/market-cap",
    ]
)
