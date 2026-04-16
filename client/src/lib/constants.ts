export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8001";

export const USD_TO_CAD_RATE = Number.parseFloat(
  import.meta.env.VITE_USD_TO_CAD_RATE ?? "1.37",
);

export const DAILY_CHANGE_CACHE_KEY = "rebalanceai-holdings-daily-change-cache-v2";
export const LEGACY_DAILY_CHANGE_CACHE_KEY = "rebalanceai-holdings-daily-change-cache";

export const EXPECTED_HEADERS = [
  "Account Name",
  "Account Type",
  "Account Classification",
  "Account Number",
  "Symbol",
  "Exchange",
  "MIC",
  "Name",
  "Security Type",
  "Quantity",
  "Position Direction",
  "Market Price",
  "Market Price Currency",
  "Book Value (CAD)",
  "Book Value Currency (CAD)",
  "Book Value (Market)",
  "Book Value Currency (Market)",
  "Market Value",
  "Market Value Currency",
  "Market Unrealized Returns",
  "Market Unrealized Returns Currency",
];
