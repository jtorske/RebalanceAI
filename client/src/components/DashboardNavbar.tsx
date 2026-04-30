import { FiUser, FiX, FiLogOut, FiEdit2 } from "react-icons/fi";
import { Link, NavLink } from "react-router-dom";
import { useState } from "react";
import { createPortal } from "react-dom";
import "./DashboardNavbar.css";
import { useUserSettings, type ThemePreference } from "../lib/userSettings";
import { useDemoMode } from "../lib/demoMode";
import { useAuth } from "../context/AuthContext";
import AuthModal from "./AuthModal";

type AuthModalMode = "login" | "signup";

function DashboardNavbar() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<AuthModalMode>("login");
  const [isEditingSettings, setIsEditingSettings] = useState(false);

  const {
    settings,
    resolvedTheme,
    saveSettings,
    isSavingSettings,
    settingsError,
    settingsSaved,
    clearSettingsStatus,
  } = useUserSettings();
  const [draftSettings, setDraftSettings] = useState(settings);
  const { isDemoMode } = useDemoMode();
  const { user, loading, profile, signOut } = useAuth();

  const openAuthModal = (mode: AuthModalMode) => {
    setAuthModalMode(mode);
    setIsAuthModalOpen(true);
  };

  const openSettings = () => {
    setDraftSettings(settings);
    clearSettingsStatus();
    setIsEditingSettings(false);
    setIsSettingsOpen(true);
  };

  const closeSettings = () => {
    setDraftSettings(settings);
    setIsEditingSettings(false);
    clearSettingsStatus();
    setIsSettingsOpen(false);
  };

  const startEditingSettings = () => {
    setDraftSettings(settings);
    clearSettingsStatus();
    setIsEditingSettings(true);
  };

  const cancelSettingsEdit = () => {
    setDraftSettings(settings);
    clearSettingsStatus();
    setIsEditingSettings(false);
  };

  const updateDraftSettings = (updates: Partial<typeof settings>) => {
    setDraftSettings((current) => ({ ...current, ...updates }));
    clearSettingsStatus();
  };

  const hasSettingsChanges =
    draftSettings.displayName !== settings.displayName ||
    draftSettings.defaultCurrency !== settings.defaultCurrency ||
    draftSettings.themePreference !== settings.themePreference ||
    draftSettings.hideDollarAmounts !== settings.hideDollarAmounts;

  const handleSaveSettings = async () => {
    if (!hasSettingsChanges) return;
    await saveSettings(draftSettings);
    setIsEditingSettings(false);
  };

  const handleSignOut = () => {
    closeSettings();
    void signOut();
  };

  // Preference order: saved profile name → local display name → Supabase email
  const displayName = user
    ? (profile?.display_name || profile?.full_name || settings.displayName || user.email || "User")
    : "Demo User";

  const avatarLetter = (
    (user ? (profile?.display_name || profile?.full_name || settings.displayName || user.email) : null) ?? "D"
  )
    .trim()
    .charAt(0)
    .toUpperCase() || "D";

  return (
    <header className="dashboard-navbar">
      <Link className="dashboard-navbar-brand" to="/">
        Rebalance<span className="dashboard-navbar-brand-accent">AI</span>
        {isDemoMode && <span className="demo-mode-badge">Demo</span>}
      </Link>

      <nav className="dashboard-navbar-nav">
        <NavLink className="dashboard-navbar-link" to="/re-weight">
          Re-weight
        </NavLink>
        <NavLink className="dashboard-navbar-link" to="/risk-manager">
          Risk Manager
        </NavLink>
        <NavLink className="dashboard-navbar-link" to="/key-insights">
          Key Insights
        </NavLink>
        <NavLink className="dashboard-navbar-link" to="/goal-planner">
          Goals
        </NavLink>
        <NavLink className="dashboard-navbar-link" to="/holdings">
          Holdings
        </NavLink>
      </nav>

      {/* Auth area — hidden while session is loading to avoid flash */}
      {!loading && (
        user ? (
          <button
            className="dashboard-navbar-user-button"
            type="button"
            aria-label="Open profile settings"
            onClick={openSettings}
          >
            <FiUser size={21} />
          </button>
        ) : (
          <div className="navbar-auth-buttons">
            <button
              className="navbar-auth-login"
              type="button"
              onClick={() => openAuthModal("login")}
            >
              Log in
            </button>
            <button
              className="navbar-auth-signup"
              type="button"
              onClick={() => openAuthModal("signup")}
            >
              Sign up
            </button>
          </div>
        )
      )}

      {/* Settings panel (logged-in only) */}
      {user && isSettingsOpen && createPortal(
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={closeSettings}
        >
          <aside
            className="settings-panel"
            aria-label="Profile settings"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-panel-header">
              <div>
                <p className="settings-eyebrow">Profile</p>
                <h2>Settings</h2>
              </div>
              <button
                className="settings-close-button"
                type="button"
                aria-label="Close settings"
                onClick={closeSettings}
              >
                <FiX size={20} />
              </button>
            </div>

            <section className="settings-section settings-section-profile">
              <div className="settings-section-title-row">
                <h3>Profile</h3>
                {!isEditingSettings && (
                  <button
                    className="settings-edit-button"
                    type="button"
                    onClick={startEditingSettings}
                  >
                    <FiEdit2 size={14} />
                    Edit Profile
                  </button>
                )}
              </div>

              <div className="settings-profile-card">
                <div className="settings-avatar">{avatarLetter}</div>
                <div>
                  <div className="settings-profile-name">{displayName}</div>
                  <div className="settings-profile-email">
                    {user.email ?? "No email"}
                  </div>
                </div>
              </div>

              {isEditingSettings ? (
                <label>
                  Display name
                  <input
                    type="text"
                    value={draftSettings.displayName}
                    onChange={(event) =>
                      updateDraftSettings({ displayName: event.target.value })
                    }
                  />
                  <span className="settings-field-helper">
                    Shown across your dashboard
                  </span>
                </label>
              ) : (
                <div className="settings-readonly-row">
                  <span>Display name</span>
                  <strong>{settings.displayName || profile?.full_name || "Not set"}</strong>
                </div>
              )}

              <div className="settings-readonly-row">
                <span>Email</span>
                <div className="settings-readonly-stack">
                  <strong>{user.email ?? "No email"}</strong>
                  <small>Managed by account provider</small>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-title-row">
                <h3>Preferences</h3>
                <span>Using {resolvedTheme} mode</span>
              </div>

              {isEditingSettings ? (
                <label>
                  Default currency
                  <select
                    value={draftSettings.defaultCurrency}
                    onChange={(event) =>
                      updateDraftSettings({ defaultCurrency: event.target.value })
                    }
                  >
                    <option value="CAD">CAD - Canadian dollar</option>
                    <option value="USD">USD - US dollar</option>
                    <option value="EUR">EUR - Euro</option>
                    <option value="GBP">GBP - British pound</option>
                  </select>
                  <span className="settings-field-helper">
                    Used for portfolio calculations
                  </span>
                </label>
              ) : (
                <div className="settings-readonly-row">
                  <span>Default currency</span>
                  <strong>{settings.defaultCurrency}</strong>
                </div>
              )}

              {isEditingSettings ? (
                <div className="settings-theme-options">
                  {(["light", "dark", "system"] as ThemePreference[]).map(
                    (theme) => (
                      <button
                        className={
                          draftSettings.themePreference === theme
                            ? "settings-theme-option settings-theme-option-active"
                            : "settings-theme-option"
                        }
                        type="button"
                        key={theme}
                        onClick={() => updateDraftSettings({ themePreference: theme })}
                      >
                        <span>{theme}</span>
                      </button>
                    ),
                  )}
                </div>
              ) : (
                <div className="settings-readonly-row">
                  <span>Appearance</span>
                  <strong>{settings.themePreference}</strong>
                </div>
              )}
            </section>

            <section className="settings-section">
              <div className="settings-section-title-row">
                <h3>Privacy</h3>
                <span>Mask sensitive totals</span>
              </div>
              {isEditingSettings ? (
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={draftSettings.hideDollarAmounts}
                    onChange={(event) =>
                      updateDraftSettings({
                        hideDollarAmounts: event.target.checked,
                      })
                    }
                  />
                  Hide dollar amounts
                </label>
              ) : (
                <div className="settings-readonly-row">
                  <span>Hide dollar amounts</span>
                  <strong>{settings.hideDollarAmounts ? "On" : "Off"}</strong>
                </div>
              )}
            </section>

            {(isSavingSettings || settingsSaved || settingsError) && (
              <div
                className={
                  settingsError
                    ? "settings-save-status settings-save-status-error"
                    : "settings-save-status"
                }
              >
                {settingsError ?? (settingsSaved ? "Settings saved." : "Saving settings...")}
              </div>
            )}

            {isEditingSettings && (
              <div className="settings-action-row">
                <button
                  className="settings-cancel-button"
                  type="button"
                  onClick={cancelSettingsEdit}
                  disabled={isSavingSettings}
                >
                  Cancel
                </button>
                <button
                  className="settings-save-button"
                  type="button"
                  onClick={() => void handleSaveSettings()}
                  disabled={!hasSettingsChanges || isSavingSettings}
                >
                  {isSavingSettings ? "Saving..." : "Save Changes"}
                </button>
              </div>
            )}

            <div className="settings-section">
              <button
                type="button"
                className="settings-signout-btn"
                onClick={handleSignOut}
              >
                <FiLogOut size={15} />
                Log out
              </button>
            </div>
          </aside>
        </div>,
        document.body,
      )}

      {/* Auth modal (logged-out only) */}
      {isAuthModalOpen && (
        <AuthModal
          mode={authModalMode}
          onClose={() => setIsAuthModalOpen(false)}
        />
      )}
    </header>
  );
}

export default DashboardNavbar;
