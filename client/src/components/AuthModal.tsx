import { useState } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import { FaGoogle } from "react-icons/fa";
import { supabase } from "../lib/supabase";
import SignupFlow from "./SignupFlow";
import LoginForm from "./LoginForm";
import "./AuthModal.css";

export type AuthModalMode = "login" | "signup";

type TopView = "landing" | "login" | "signup";

interface Props {
  mode: AuthModalMode;
  onClose: () => void;
}

export default function AuthModal({ mode: initialMode, onClose }: Props) {
  const [view, setView] = useState<TopView>("landing");
  const [tab, setTab] = useState<AuthModalMode>(initialMode);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const handleGoogle = async () => {
    setGoogleError(null);
    setGoogleBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      setGoogleError(error.message);
      setGoogleBusy(false);
    }
    // success → browser redirects to Google; no further handling needed here
  };

  const goToView = (v: TopView, t?: AuthModalMode) => {
    setView(v);
    if (t) setTab(t);
    setGoogleError(null);
  };

  return createPortal(
    <div className="auth-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ── Top bar ─────────────────────────────────────────── */}
        <div className="auth-topbar">
          <span className="auth-wordmark">
            Rebalance<span>AI</span>
          </span>
          <button
            className="auth-icon-btn"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <FiX size={17} />
          </button>
        </div>

        {/* ── Content ─────────────────────────────────────────── */}
        <div className="auth-content">

          {/* Landing view */}
          {view === "landing" && (
            <div className="auth-view">
              <div className="auth-tabs">
                <button
                  className={`auth-tab${tab === "login" ? " auth-tab--active" : ""}`}
                  type="button"
                  onClick={() => setTab("login")}
                >
                  Log in
                </button>
                <button
                  className={`auth-tab${tab === "signup" ? " auth-tab--active" : ""}`}
                  type="button"
                  onClick={() => setTab("signup")}
                >
                  Sign up
                </button>
              </div>

              <h2 className="auth-title">
                {tab === "login" ? "Welcome back" : "Create your account"}
              </h2>

              <button
                className="auth-google-btn"
                type="button"
                disabled={googleBusy}
                onClick={() => void handleGoogle()}
              >
                <FaGoogle size={14} />
                {googleBusy ? "Redirecting…" : "Continue with Google"}
              </button>

              {googleError && <p className="auth-error">{googleError}</p>}

              <div className="auth-or"><span>or</span></div>

              <button
                className="auth-outline-btn"
                type="button"
                onClick={() => goToView(tab === "login" ? "login" : "signup")}
              >
                Continue with email
              </button>

              <p className="auth-switch">
                {tab === "login" ? (
                  <>
                    Don&apos;t have an account?{" "}
                    <button type="button" onClick={() => setTab("signup")}>
                      Sign up
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{" "}
                    <button type="button" onClick={() => setTab("login")}>
                      Log in
                    </button>
                  </>
                )}
              </p>
            </div>
          )}

          {/* Login flow */}
          {view === "login" && (
            <LoginForm
              onBack={() => goToView("landing", "login")}
              onSuccess={onClose}
              onSwitchToSignup={() => goToView("signup", "signup")}
            />
          )}

          {/* Signup flow */}
          {view === "signup" && (
            <SignupFlow
              onBack={() => goToView("landing", "signup")}
              onSuccess={onClose}
              onSwitchToLogin={() => goToView("login", "login")}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
