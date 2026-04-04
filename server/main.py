from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Holding(BaseModel):
    ticker: str
    shares: float
    price: float

@app.get("/")
def root():
    return {"message": "Portfolio API running"}

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