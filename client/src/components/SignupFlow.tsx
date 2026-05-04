import { useState } from "react";
import { FiArrowLeft, FiCheckCircle } from "react-icons/fi";
import { FaGoogle } from "react-icons/fa";
import { supabase } from "../lib/supabase";
import { getAuthErrorMessage, isEmailExistsError } from "../lib/authErrors";

interface Props {
  onBack: () => void;
  onSuccess: () => void;
  onSwitchToLogin: (prefillEmail?: string) => void;
}

export default function SignupFlow({
  onBack,
  onSwitchToLogin,
}: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailExists, setEmailExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const handleGoogle = async () => {
    setError(null);
    setGoogleBusy(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (oauthError) {
      setError(getAuthErrorMessage(oauthError));
      setGoogleBusy(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setEmailExists(false);

    const trimmedEmail = email.trim();
    const trimmedName = fullName.trim();

    if (!trimmedName) {
      setError("Please enter your full name.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setBusy(true);
    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: { full_name: trimmedName },
        },
      });

      if (signUpError) {
        if (isEmailExistsError(signUpError)) {
          setEmailExists(true);
        } else {
          setError(getAuthErrorMessage(signUpError));
        }
        return;
      }

      // Supabase signals "email already exists" with empty identities when
      // email confirmation is enabled — no error is returned.
      if (data.user && (data.user.identities ?? []).length === 0) {
        setEmailExists(true);
        return;
      }

      setConfirmedEmail(trimmedEmail);
    } finally {
      setBusy(false);
    }
  };

  // ── Email already exists ──────────────────────────────────────
  if (emailExists) {
    return (
      <div className="auth-view">
        <h2 className="auth-title">Account already exists</h2>
        <p className="auth-subtitle">
          An account with <strong>{email.trim()}</strong> already exists.
          Log in to access your account.
        </p>
        <button
          className="auth-primary-btn"
          type="button"
          onClick={() => onSwitchToLogin(email.trim())}
        >
          Log in
        </button>
        <p className="auth-switch">
          <button type="button" onClick={() => setEmailExists(false)}>
            Use a different email
          </button>
        </p>
      </div>
    );
  }

  // ── Confirmation sent ─────────────────────────────────────────
  if (confirmedEmail) {
    return (
      <div className="auth-view">
        <div className="auth-success-icon" aria-hidden="true">
          <FiCheckCircle size={24} />
        </div>
        <h2 className="auth-title">Check your email</h2>
        <p className="auth-subtitle">
          We sent a confirmation link to <strong>{confirmedEmail}</strong>.
          Click the link to verify your account, then return to sign in.
        </p>
        <button className="auth-primary-btn" type="button" onClick={() => onSwitchToLogin()}>
          Sign in
        </button>
      </div>
    );
  }

  // ── Signup form ───────────────────────────────────────────────
  return (
    <div className="auth-view">
      <button className="auth-back" type="button" onClick={onBack}>
        <FiArrowLeft size={14} />
        Back
      </button>

      <h2 className="auth-title">Create account</h2>

      <button
        className="auth-google-btn"
        type="button"
        disabled={googleBusy}
        onClick={() => void handleGoogle()}
      >
        <FaGoogle size={14} />
        {googleBusy ? "Redirecting…" : "Sign up with Google"}
      </button>

      <div className="auth-or"><span>or</span></div>

      <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
        <label className="auth-label">
          Full name
          <input
            className="auth-input"
            type="text"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Alex Smith"
            required
            autoFocus
            autoComplete="name"
          />
        </label>

        <label className="auth-label">
          Email
          <input
            className="auth-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
          />
        </label>

        <label className="auth-label">
          Password
          <input
            className="auth-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Min. 8 characters"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>

        <label className="auth-label">
          Confirm password
          <input
            className="auth-input"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Repeat password"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>

        {error && <p className="auth-error">{error}</p>}

        <button
          className="auth-primary-btn"
          type="submit"
          disabled={busy || !email.trim() || !password || !confirmPassword || !fullName.trim()}
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="auth-switch">
        Already have an account?{" "}
        <button type="button" onClick={() => onSwitchToLogin()}>
          Log in
        </button>
      </p>
    </div>
  );
}
