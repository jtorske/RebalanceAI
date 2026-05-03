import os
from typing import List


CORS_ORIGINS_RAW = os.getenv("CORS_ORIGINS", "*")
CORS_ORIGINS: List[str] = (
    ["*"]
    if CORS_ORIGINS_RAW.strip() == "*"
    else [origin.strip() for origin in CORS_ORIGINS_RAW.split(",") if origin.strip()]
)
