from app.routes._legacy import router_from_legacy


router = router_from_legacy(
    [
        "/",
        "/api/status",
        "/api/ready",
    ]
)
