from typing import Iterable, Set

from fastapi import APIRouter
from fastapi.routing import APIRoute

from app.services import legacy_service


def router_from_legacy(paths: Iterable[str]) -> APIRouter:
    wanted: Set[str] = set(paths)
    router = APIRouter()

    for route in legacy_service.app.routes:
        if not isinstance(route, APIRoute) or route.path not in wanted:
            continue

        router.add_api_route(
            route.path,
            route.endpoint,
            methods=list(route.methods or []),
            name=route.name,
            response_model=route.response_model,
            status_code=route.status_code,
            tags=route.tags,
            dependencies=route.dependencies,
            summary=route.summary,
            description=route.description,
            response_description=route.response_description,
            responses=route.responses,
            deprecated=route.deprecated,
            operation_id=route.operation_id,
            response_class=route.response_class,
            include_in_schema=route.include_in_schema,
        )

    return router
