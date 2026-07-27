import logging

from fastapi import FastAPI
from fastapi.routing import APIRoute


logger = logging.getLogger("rebalanceai")


def log_registered_routes(app: FastAPI, route_logger: logging.Logger = logger) -> None:
    for route in app.routes:
        if isinstance(route, APIRoute):
            methods = ",".join(sorted(route.methods or []))
            route_logger.info("route %s %s", methods, route.path)
        else:
            route_logger.info("router %s", type(route).__name__)