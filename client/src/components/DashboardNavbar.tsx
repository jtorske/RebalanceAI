import { FiUser, FiX } from "react-icons/fi";
import { Link, NavLink } from "react-router-dom";
import { useState } from "react";
import { createPortal } from "react-dom";
import "./DashboardNavbar.css";
import { useUserSettings, type ThemePreference } from "../lib/userSettings";

function DashboardNavbar() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const { settings, resolvedTheme, updateSettings } = useUserSettings();

  return (
    <header className="dashboard-navbar">
      <Link className="dashboard-navbar-brand" to="/">
        Rebalance<span className="dashboard-navbar-brand-accent">AI</span>
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

      <button
        className="dashboard-navbar-user-button"
        type="button"
        aria-label="Open profile settings"
        onClick={() => setIsSettingsOpen(true)}
      >
        <FiUser size={21} />
      </button>

      {isSettingsOpen && createPortal(
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={() => setIsSettingsOpen(false)}
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
                onClick={() => setIsSettingsOpen(false)}
              >
                <FiX size={20} />
              </button>
            </div>

            <div className="settings-profile-card">
              <div className="settings-avatar">
                {settings.displayName.trim().charAt(0).toUpperCase() || "U"}
              </div>
              <div>
                <div className="settings-profile-name">
                  {settings.displayName || "RebalanceAI User"}
                </div>
                <div className="settings-profile-email">
                  {settings.email || "No email added"}
                </div>
              </div>
            </div>

            <div className="settings-section">
              <h3>Basics</h3>
              <label>
                Display name
                <input
                  type="text"
                  value={settings.displayName}
                  onChange={(event) =>
                    updateSettings({ displayName: event.target.value })
                  }
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={settings.email}
                  onChange={(event) =>
                    updateSettings({ email: event.target.value })
                  }
                />
              </label>
              <label>
                Default currency
                <select
                  value={settings.defaultCurrency}
                  onChange={(event) =>
                    updateSettings({ defaultCurrency: event.target.value })
                  }
                >
                  <option value="CAD">CAD - Canadian dollar</option>
                  <option value="USD">USD - US dollar</option>
                  <option value="EUR">EUR - Euro</option>
                  <option value="GBP">GBP - British pound</option>
                </select>
              </label>
            </div>

            <div className="settings-section">
              <div className="settings-section-title-row">
                <h3>Appearance</h3>
                <span>Using {resolvedTheme} mode</span>
              </div>
              <div className="settings-theme-options">
                {(["light", "dark", "system"] as ThemePreference[]).map(
                  (theme) => (
                    <button
                      className={
                        settings.themePreference === theme
                          ? "settings-theme-option settings-theme-option-active"
                          : "settings-theme-option"
                      }
                      type="button"
                      key={theme}
                      onClick={() => updateSettings({ themePreference: theme })}
                    >
                      <span>{theme}</span>
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title-row">
                <h3>Privacy</h3>
                <span>Mask sensitive totals</span>
              </div>
              <label className="settings-toggle-row">
                <input
                  type="checkbox"
                  checked={settings.hideDollarAmounts}
                  onChange={(event) =>
                    updateSettings({
                      hideDollarAmounts: event.target.checked,
                    })
                  }
                />
                Hide dollar amounts
              </label>
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </header>
  );
}

export default DashboardNavbar;
