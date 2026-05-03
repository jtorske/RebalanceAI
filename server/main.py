from fastapi import FastAPI

from app.core.cors import add_cors
from app.core.logging import log_registered_routes, logger
from app.routes import debug, demo, health, holdings, market, portfolio, rebalance, risk

app = FastAPI()

add_cors(app)

app.include_router(health.router)
app.include_router(debug.router)
app.include_router(market.router)
app.include_router(risk.router)
app.include_router(rebalance.router)
app.include_router(portfolio.router)
app.include_router(demo.router)
app.include_router(holdings.router)


@app.on_event("startup")
async def log_routes() -> None:
    log_registered_routes(app, logger)
