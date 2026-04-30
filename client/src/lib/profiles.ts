import { supabase } from "./supabase";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  created_at: string;
}

/*
  Required Supabase SQL (run once in the Supabase SQL editor):

  create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text,
    full_name text,
    created_at timestamp with time zone default now()
  );

  alter table public.profiles enable row level security;

  create policy "Users can read own profile"   on public.profiles for select using (auth.uid() = id);
  create policy "Users can insert own profile" on public.profiles for insert with check (auth.uid() = id);
  create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
*/

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  return data ?? null;
}

export async function upsertProfile(
  id: string,
  fields: { email?: string | null; full_name?: string | null },
): Promise<void> {
  await supabase.from("profiles").upsert({ id, ...fields });
}
