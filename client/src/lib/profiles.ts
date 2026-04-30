export {
  ensureProfile,
  getProfile as fetchProfile,
  updateProfile,
  type Profile,
  type ProfileUpdates,
} from "../services/profileService";

import type { ProfileUpdates } from "../services/profileService";
import { supabase } from "./supabase";

export async function upsertProfile(
  id: string,
  fields: ProfileUpdates,
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .upsert({ id, ...fields, updated_at: new Date().toISOString() });
  if (error) throw error;
}
