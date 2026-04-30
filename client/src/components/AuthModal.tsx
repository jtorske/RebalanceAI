import { useState } from "react";
import { FiX } from "react-icons/fi";
import { createPortal } from "react-dom";
import { useAuth } from "../context/AuthContext";
import "./AuthModal.css";

interface AuthModalProps {
  mode: "login" | "signup";
  onClose: () => void;
}

function AuthModal({ mode: initialMode, onClose }: AuthModalProps) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { signIn, signUp } = useAuth();

  const switchMode = (next: "login" | "signup") => {
    setMode(next);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="auth-modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "login" ? "Log in" : "Sign up"}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="auth-modal-header">
          <div>
            <p className="auth-modal-eyebrow">RebalanceAI</p>
            <h2>{mode === "login" ? "Welcome back" : "Create account"}</h2>
          </div>
          <button
            className="auth-modal-close"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <FiX size={20} />
          </button>
        </div>

        <form className="auth-modal-form" onSubmit={(e) => void handleSubmit(e)}>
          <label className="auth-modal-label">
            Email
            <input
              type="email"
              className="auth-modal-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
              autoComplete="email"
            />
          </label>

          <label className="auth-modal-label">
            Password
            <input
              type="password"
              className="auth-modal-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>

          {error && <p className="auth-modal-error">{error}</p>}

          <button
            className="auth-modal-submit"
            type="submit"
            disabled={busy}
          >
            {busy
              ? "Please wait…"
              : mode === "login"
              ? "Log in"
              : "Create account"}
          </button>
        </form>

        <p className="auth-modal-switch">
          {mode === "login" ? (
            <>
              Don&apos;t have an account?{" "}
              <button type="button" onClick={() => switchMode("signup")}>
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button type="button" onClick={() => switchMode("login")}>
                Log in
              </button>
            </>
          )}
        </p>
      </div>
    </div>,
    document.body,
  );
}

export default AuthModal;
