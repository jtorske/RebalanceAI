import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { ThemePreference } from "../lib/userSettings";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  display_name: string | null;
  default_currency: string | null;
  hide_dollar_amounts: boolean | null;
  appearance: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export type ProfileUpdates = Partial<
  Pick<
    Profile,
    | "email"
    | "full_name"
    | "display_name"
    | "default_currency"
    | "hide_dollar_amounts"
    | "appearance"
  >
>;

export function getUserFullName(user: User): string | null {
  return (
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    null
  );
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function ensureProfile(user: User): Promise<Profile> {
  const existing = await getProfile(user.id);
  const fullName = getUserFullName(user);
  const now = new Date().toISOString();

  if (existing) {
    const { data, error } = await supabase
      .from("profiles")
      .update({
        email: user.email ?? existing.email,
        full_name: existing.full_name ?? fullName,
        updated_at: now,
      })
      .eq("id", user.id)
      .select("*")
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("profiles")
    .insert({
      id: user.id,
      email: user.email ?? null,
      full_name: fullName,
      display_name: fullName,
      default_currency: "CAD",
      hide_dollar_amounts: false,
      appearance: "system" satisfies ThemePreference,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function updateProfile(
  userId: string,
  updates: ProfileUpdates,
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", userId);

  if (error) throw error;
}
