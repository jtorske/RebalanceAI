import { supabase } from "../lib/supabase";
import type { HoldingsResponse, ImportedHolding } from "../lib/types";
import {
  getSupabaseErrorMessage,
  isRowLevelSecurityError,
} from "./supabaseError";

type SupabaseHolding = {
  id: string;
  portfolio_id: string;
  user_id: string;
  account: string | null;
  symbol: string | null;
  security_type: string | null;
  quantity: number | string | null;
  market_price: number | string | null;
  market_value: number | string | null;
  currency: string | null;
  daily_percent: number | string | null;
  unrealized_percent: number | string | null;
  unrealized_amount: number | string | null;
};

const asNumber = (value: number | string | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function dbHoldingToImportedHolding(row: SupabaseHolding): ImportedHolding {
  const currency = row.currency || "CAD";
  const marketValue = asNumber(row.market_value);
  const unrealizedAmount = asNumber(row.unrealized_amount);
  const bookValue = marketValue - unrealizedAmount;

  return {
    account_name: row.account ?? "",
    account_type: "",
    account_classification: "",
    account_number: "",
    symbol: row.symbol ?? "",
    exchange: "",
    mic: "",
    name: row.symbol ?? "",
    security_type: row.security_type ?? "",
    quantity: asNumber(row.quantity),
    position_direction: "",
    market_price: asNumber(row.market_price),
    market_price_currency: currency,
    book_value_cad: currency === "CAD" ? bookValue : 0,
    book_value_currency_cad: "CAD",
    book_value_market: bookValue,
    book_value_currency_market: currency,
    market_value: marketValue,
    market_value_currency: currency,
    market_unrealized_returns: unrealizedAmount,
    market_unrealized_returns_currency: currency,
  };
}

export function importedHoldingToDbRow(
  userId: string,
  portfolioId: string,
  holding: ImportedHolding,
) {
  const unrealizedAmount = holding.market_unrealized_returns;
  const unrealizedPercent =
    holding.book_value_market > 0
      ? (unrealizedAmount / holding.book_value_market) * 100
      : null;

  return {
    user_id: userId,
    portfolio_id: portfolioId,
    account: holding.account_name ?? "",
    symbol: holding.symbol ?? "",
    security_type: holding.security_type ?? "",
    quantity: holding.quantity ?? 0,
    market_price: holding.market_price ?? 0,
    market_value: holding.market_value ?? 0,
    currency: holding.market_value_currency || holding.market_price_currency || "CAD",
    daily_percent: null,
    unrealized_percent: unrealizedPercent,
    unrealized_amount: unrealizedAmount,
    updated_at: new Date().toISOString(),
  };
}

export async function getHoldings(portfolioId: string): Promise<ImportedHolding[]> {
  const { data, error } = await supabase
    .from("holdings")
    .select("*")
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map(dbHoldingToImportedHolding);
}

export async function replaceHoldings(
  userId: string,
  portfolioId: string,
  rows: ImportedHolding[],
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("holdings")
    .delete()
    .eq("portfolio_id", portfolioId)
    .eq("user_id", userId);

  if (deleteError) {
    if (isRowLevelSecurityError(deleteError)) {
      throw new Error(
        "Supabase blocked replacing holdings. Add DELETE and INSERT policies on holdings for authenticated users.",
      );
    }
    throw new Error(getSupabaseErrorMessage(deleteError));
  }

  if (rows.length === 0) return;

  const { error: insertError } = await supabase
    .from("holdings")
    .insert(rows.map((row) => importedHoldingToDbRow(userId, portfolioId, row)));

  if (insertError) {
    if (isRowLevelSecurityError(insertError)) {
      throw new Error(
        "Supabase blocked saving holdings. Add an INSERT policy on holdings for authenticated users.",
      );
    }
    throw new Error(getSupabaseErrorMessage(insertError));
  }
}

export function buildHoldingsResponse(
  holdings: ImportedHolding[],
  sourceFileName: string | null = "Supabase",
): HoldingsResponse {
  return {
    source_file_name: sourceFileName,
    as_of: null,
    imported_at: new Date().toISOString(),
    holdings,
  };
}
