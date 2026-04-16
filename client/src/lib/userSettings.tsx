import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";

type UserSettings = {
  displayName: string;
  email: string;
  defaultCurrency: string;
  themePreference: ThemePreference;
};

type UserSettingsContextValue = {
  settings: UserSettings;
  resolvedTheme: "light" | "dark";
  updateSettings: (updates: Partial<UserSettings>) => void;
};

const STORAGE_KEY = "rebalanceai:user-settings";

const defaultSettings: UserSettings = {
  displayName: "Jordan",
  email: "jordan@example.com",
  defaultCurrency: "CAD",
  themePreference: "system",
};

const UserSettingsContext = createContext<UserSettingsContextValue | null>(
  null,
);

function loadSettings(): UserSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings());
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    getSystemTheme(),
  );

  const resolvedTheme =
    settings.themePreference === "system"
      ? systemTheme
      : settings.themePreference;

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      setSystemTheme(media.matches ? "dark" : "light");
    };

    handleChange();
    media.addEventListener("change", handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = settings.themePreference;
  }, [resolvedTheme, settings.themePreference]);

  const value = useMemo<UserSettingsContextValue>(
    () => ({
      settings,
      resolvedTheme,
      updateSettings: (updates) => {
        setSettings((current) => ({ ...current, ...updates }));
      },
    }),
    [resolvedTheme, settings],
  );

  return (
    <UserSettingsContext.Provider value={value}>
      {children}
    </UserSettingsContext.Provider>
  );
}

export function useUserSettings() {
  const context = useContext(UserSettingsContext);
  if (!context) {
    throw new Error("useUserSettings must be used inside UserSettingsProvider");
  }
  return context;
}
