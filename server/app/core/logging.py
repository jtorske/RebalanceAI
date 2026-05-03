import logging

from fastapi import FastAPI


logger = logging.getLogger("rebalanceai")


def log_registered_routes(app: FastAPI, route_logger: logging.Logger = logger) -> None:
    for route in app.routes:
        methods = getattr(route, "methods", None)
        route_logger.info("route %s %s", ",".join(sorted(methods or [])), route.path)
