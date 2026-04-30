import { supabase } from "../lib/supabase";
import {
  getSupabaseErrorMessage,
  isRowLevelSecurityError,
} from "./supabaseError";

export interface Portfolio {
  id: string;
  user_id: string;
  name: string;
  base_currency: string;
  created_at: string | null;
  updated_at: string | null;
}

export async function getMainPortfolio(userId: string): Promise<Portfolio | null> {
  const { data, error } = await supabase
    .from("portfolios")
    .select("*")
    .eq("user_id", userId)
    .eq("name", "Main Portfolio")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function getOrCreateMainPortfolio(
  userId: string,
  baseCurrency: string,
): Promise<Portfolio> {
  const existing = await getMainPortfolio(userId);
  if (existing) return existing;

  const { data, error } = await supabase
    .from("portfolios")
    .insert({
      user_id: userId,
      name: "Main Portfolio",
      base_currency: baseCurrency || "CAD",
    })
    .select("*")
    .single();

  if (error) {
    if (isRowLevelSecurityError(error)) {
      throw new Error(
        "Supabase blocked creating your portfolio. Add an INSERT policy on portfolios for authenticated users.",
      );
    }
    throw new Error(getSupabaseErrorMessage(error));
  }
  return data;
}
