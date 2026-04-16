export type ImportedHolding = {
  account_name: string;
  account_type: string;
  account_classification: string;
  account_number: string;
  symbol: string;
  exchange: string;
  mic: string;
  name: string;
  security_type: string;
  quantity: number;
  position_direction: string;
  market_price: number;
  market_price_currency: string;
  book_value_cad: number;
  book_value_currency_cad: string;
  book_value_market: number;
  book_value_currency_market: string;
  market_value: number;
  market_value_currency: string;
  market_unrealized_returns: number;
  market_unrealized_returns_currency: string;
};

export type HoldingsResponse = {
  source_file_name: string | null;
  as_of: string | null;
  imported_at: string | null;
  holdings: ImportedHolding[];
};

export type BenchmarkQuote = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
};

export type MarketComparisonTicker = {
  symbol: string;
  dailyPercent: number | null;
};

export type MarketComparisonResponse = {
  portfolioDailyPercent: number | null;
  marketDailyPercent: number | null;
  deltaPercent: number | null;
  benchmarks: BenchmarkQuote[];
  perTicker?: MarketComparisonTicker[];
};

export type WeightedHolding = ImportedHolding & {
  marketValueCad: number;
  weight: number;
};

export type SortKey =
  | "account_name"
  | "symbol"
  | "security_type"
  | "quantity"
  | "market_price"
  | "market_value"
  | "market_value_currency"
  | "daily_change_percent"
  | "total_change_percent"
  | "total_change_amount";

export type SortDirection = "asc" | "desc";
