from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import CORS_ORIGINS, CORS_ORIGINS_RAW


def add_cors(app: FastAPI) -> None:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=CORS_ORIGINS_RAW.strip() != "*",
        allow_methods=["*"],
        allow_headers=["*"],
    )
