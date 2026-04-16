import type { ImportedHolding } from "./types";

export const DONUT_COLORS = [
  "#45c8c1",
  "#8e86f5",
  "#f3c55b",
  "#69d97a",
  "#5fa8ff",
  "#ff8d7a",
  "#7ed7d1",
  "#b18df3",
  "#ffd36f",
  "#75c4ff",
  "#8ee07d",
  "#f29ab8",
];

export const SYMBOL_TO_SECTOR: Record<string, string> = {
  AMD: "Information Technology",
  CEG: "Utilities",
  ETN: "Industrials",
  GOOG: "Communication Services",
  MU: "Information Technology",
  ONDS: "Information Technology",
  SLS: "Health Care",
  SNDK: "Information Technology",
  VST: "Utilities",
  WDC: "Information Technology",
};

export function getHoldingSector(holding: ImportedHolding): string {
  const symbol = holding.symbol.trim().toUpperCase();
  const securityType = holding.security_type.trim().toUpperCase();

  if (securityType.includes("OPTION")) {
    return "Derivatives";
  }

  if (securityType.includes("ETF") || symbol === "XEQT") {
    return "ETF / Diversified";
  }

  return SYMBOL_TO_SECTOR[symbol] ?? "Other";
}
