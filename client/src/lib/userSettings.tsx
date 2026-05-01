import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "../context/AuthContext";
import { updateProfile } from "../services/profileService";

export type ThemePreference = "light" | "dark" | "system";

type UserSettings = {
  displayName: string;
  email: string;
  defaultCurrency: string;
  themePreference: ThemePreference;
  hideDollarAmounts: boolean;
};

type UserSettingsContextValue = {
  settings: UserSettings;
  resolvedTheme: "light" | "dark";
  updateSettings: (updates: Partial<UserSettings>) => void;
  saveSettings: (updates: Partial<UserSettings>) => Promise<void>;
  isSavingSettings: boolean;
  settingsError: string | null;
  settingsSaved: boolean;
  clearSettingsStatus: () => void;
};

const STORAGE_KEY = "rebalancex:user-settings";

const defaultSettings: UserSettings = {
  displayName: "",
  email: "",
  defaultCurrency: "CAD",
  themePreference: "system",
  hideDollarAmounts: false,
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Unable to save settings.";
}

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const { user, profile, refreshProfile } = useAuth();
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings());
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    getSystemTheme(),
  );
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const resolvedTheme =
    settings.themePreference === "system"
      ? systemTheme
      : settings.themePreference;

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!profile) return;
    setSettings((current) => ({
      ...current,
      displayName: profile.display_name ?? profile.full_name ?? current.displayName,
      email: profile.email ?? current.email,
      defaultCurrency: profile.default_currency ?? current.defaultCurrency,
      themePreference:
        (profile.appearance as ThemePreference | null) ?? current.themePreference,
      hideDollarAmounts:
        profile.hide_dollar_amounts ?? current.hideDollarAmounts,
    }));
  }, [profile]);

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
      saveSettings: async (updates) => {
        const nextSettings = { ...settings, ...updates };
        setSettingsError(null);
        setSettingsSaved(false);

        if (!user) {
          setSettingsError("Sign in to save profile settings across devices.");
          throw new Error("Sign in to save profile settings across devices.");
        }

        const profileUpdates = Object.fromEntries(
          Object.entries({
            display_name: nextSettings.displayName,
            default_currency: nextSettings.defaultCurrency,
            appearance: nextSettings.themePreference,
            hide_dollar_amounts: nextSettings.hideDollarAmounts,
          }).filter(([, value]) => value !== undefined),
        );

        setIsSavingSettings(true);
        try {
          await updateProfile(user.id, profileUpdates);
          setSettings(nextSettings);
          await refreshProfile();
          setSettingsSaved(true);
          window.setTimeout(() => setSettingsSaved(false), 1600);
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          setSettingsError(message);
          throw new Error(message);
        } finally {
          setIsSavingSettings(false);
        }
      },
      isSavingSettings,
      settingsError,
      settingsSaved,
      clearSettingsStatus: () => {
        setSettingsError(null);
        setSettingsSaved(false);
      },
    }),
    [
      isSavingSettings,
      refreshProfile,
      resolvedTheme,
      settings,
      settingsError,
      settingsSaved,
      user,
    ],
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
