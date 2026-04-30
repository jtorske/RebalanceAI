import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { fetchProfile, upsertProfile, type Profile } from "../lib/profiles";

type AuthContextType = {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  // Loads profile; for OAuth (Google) users with no profile yet, auto-creates one
  // from the name Google provides so they never need a manual name step.
  const syncProfile = useCallback(async (u: User) => {
    setProfileLoading(true);
    try {
      let p = await fetchProfile(u.id);
      if (!p) {
        const oauthName =
          (u.user_metadata?.full_name as string | undefined) ||
          (u.user_metadata?.name as string | undefined);
        if (oauthName) {
          await upsertProfile(u.id, { email: u.email ?? null, full_name: oauthName });
          p = {
            id: u.id,
            email: u.email ?? null,
            full_name: oauthName,
            created_at: new Date().toISOString(),
          };
        }
      }
      setProfile(p);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  // Used by SignupFlow after manually saving a name so the context reflects it immediately
  const refreshProfile = useCallback(async () => {
    if (!user) return;
    setProfileLoading(true);
    try {
      setProfile(await fetchProfile(user.id));
    } finally {
      setProfileLoading(false);
    }
  }, [user]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
      if (data.session?.user) void syncProfile(data.session.user);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (session?.user) {
        void syncProfile(session.user);
      } else {
        setProfile(null);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [syncProfile]);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  return (
    <AuthContext.Provider
      value={{ user, session, profile, loading, profileLoading, signIn, signOut, refreshProfile }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
