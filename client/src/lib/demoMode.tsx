import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { API_BASE_URL } from "./constants";

const DEMO_KEY = "rebalanceai:demo-mode";

type DemoModeContextValue = {
  isDemoMode: boolean;
  enableDemoMode: () => Promise<void>;
  disableDemoMode: () => Promise<void>;
};

const DemoModeContext = createContext<DemoModeContextValue | null>(null);

function readDemoFlag(): boolean {
  try {
    return localStorage.getItem(DEMO_KEY) === "true";
  } catch {
    return false;
  }
}

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [isDemoMode, setIsDemoMode] = useState(readDemoFlag);

  // Sync backend demo state on mount (backend resets on restart)
  useEffect(() => {
    if (isDemoMode) {
      void fetch(`${API_BASE_URL}/demo/enable`, { method: "POST" }).catch(() => {});
    }
  }, []);

  const enableDemoMode = async () => {
    await fetch(`${API_BASE_URL}/demo/enable`, { method: "POST" });
    localStorage.setItem(DEMO_KEY, "true");
    setIsDemoMode(true);
    window.dispatchEvent(new Event("holdings-changed"));
  };

  const disableDemoMode = async () => {
    await fetch(`${API_BASE_URL}/demo/disable`, { method: "POST" });
    localStorage.removeItem(DEMO_KEY);
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
