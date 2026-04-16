import { USD_TO_CAD_RATE } from "./constants";
import type { ImportedHolding } from "./types";

export function convertToCad(amount: number, currency: string): number {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (normalizedCurrency === "CAD") {
    return amount;
  }
  if (normalizedCurrency === "USD") {
    return amount * USD_TO_CAD_RATE;
  }
  return amount;
}

export function getTotalChangePercent(holding: ImportedHolding): number | null {
  if (holding.book_value_market <= 0) {
    return null;
  }
  return (holding.market_unrealized_returns / holding.book_value_market) * 100;
}

export function getTotalChangeAmount(holding: ImportedHolding): number {
  return holding.market_value - holding.book_value_market;
}

export function isOptionHolding(holding: ImportedHolding): boolean {
  return holding.security_type.trim().toUpperCase().includes("OPTION");
}
