import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { ensureProfile, fetchProfile, type Profile } from "../lib/profiles";
import {
  getOrCreateMainPortfolio,
  type Portfolio,
} from "../services/portfolioService";
import { getHoldings } from "../services/holdingsService";
import { clearDashboardCache } from "../lib/dashboardCache";
import { DAILY_CHANGE_CACHE_KEY } from "../lib/constants";

type AuthContextType = {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  portfolio: Portfolio | null;
  loading: boolean;
  profileLoading: boolean;
  portfolioLoading: boolean;
  savedHoldingsCount: number;
  hasHoldings: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshPortfolio: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [savedHoldingsCount, setSavedHoldingsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  // Loads profile; for OAuth (Google) users with no profile yet, auto-creates one
  // from the name Google provides so they never need a manual name step.
  const syncPortfolio = useCallback(async (u: User, p: Profile | null) => {
    setPortfolioLoading(true);
    try {
      const mainPortfolio = await getOrCreateMainPortfolio(
        u.id,
        p?.default_currency ?? "CAD",
      );
      setPortfolio(mainPortfolio);
      const savedHoldings = await getHoldings(mainPortfolio.id);
      setSavedHoldingsCount(savedHoldings.length);
      window.dispatchEvent(new Event("holdings-changed"));
    } finally {
      setPortfolioLoading(false);
    }
  }, []);

  const syncProfile = useCallback(async (u: User) => {
    setProfileLoading(true);
    try {
      const p = await ensureProfile(u);
      setProfile(p);
      void syncPortfolio(u, p);
    } finally {
      setProfileLoading(false);
    }
  }, [syncPortfolio]);

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

  const refreshPortfolio = useCallback(async () => {
    if (!user) return;
    await syncPortfolio(user, profile);
  }, [profile, syncPortfolio, user]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
      if (data.session?.user) void syncProfile(data.session.user);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED fires on every tab-focus JWT renewal — only update the
      // access token; skip user/profile/portfolio sync to prevent cascading
      // Supabase queries on focus. User data does not change on token refresh.
      if (event === "TOKEN_REFRESHED") {
        setSession(session);
        return;
      }
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (session?.user) {
        void syncProfile(session.user);
      } else {
        setProfile(null);
        setPortfolio(null);
        setSavedHoldingsCount(0);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [syncProfile]);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function signOut() {
    const userId = user?.id ?? null;
    clearDashboardCache(userId);
    try { localStorage.removeItem(DAILY_CHANGE_CACHE_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem("rebalancex:market-summary-v2"); } catch { /* ignore */ }
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        portfolio,
        loading,
        profileLoading,
        portfolioLoading,
        savedHoldingsCount,
        hasHoldings: savedHoldingsCount > 0,
        signIn,
        signOut,
        refreshProfile,
        refreshPortfolio,
      }}
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
