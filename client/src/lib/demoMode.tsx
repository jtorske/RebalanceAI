import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "./supabase";

type DemoModeContextValue = {
  isDemoMode: boolean;
  enableDemoMode: () => Promise<void>;
  disableDemoMode: () => Promise<void>;
};

const DemoModeContext = createContext<DemoModeContextValue | null>(null);

export function DemoModeProvider({ children }: { children: ReactNode }) {
  // Default true: unauthenticated visitors always start in demo mode
  const [isDemoMode, setIsDemoMode] = useState(true);

  useEffect(() => {
    // Sync on mount from current session
    supabase.auth.getSession().then(({ data }) => {
      const isLoggedIn = !!data.session?.user;
      if (isLoggedIn) setIsDemoMode(false);
    });

    // Keep in sync whenever auth state changes (sign in / sign out)
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        const isLoggedIn = !!session?.user;
        setIsDemoMode(!isLoggedIn);
        window.dispatchEvent(new Event("holdings-changed"));
      },
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  const enableDemoMode = async () => {
    setIsDemoMode(true);
    window.dispatchEvent(new Event("holdings-changed"));
  };

  const disableDemoMode = async () => {
    setIsDemoMode(false);
    window.dispatchEvent(new Event("holdings-changed"));
  };

  const value = useMemo<DemoModeContextValue>(
    () => ({ isDemoMode, enableDemoMode, disableDemoMode }),
    [isDemoMode],
  );

  return (
    <DemoModeContext.Provider value={value}>
      {children}
    </DemoModeContext.Provider>
  );
}

export function useDemoMode() {
  const context = useContext(DemoModeContext);
  if (!context) throw new Error("useDemoMode must be used inside DemoModeProvider");
  return context;
}
