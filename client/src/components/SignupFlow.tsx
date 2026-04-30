import { useState } from "react";
import { FiArrowLeft, FiCheckCircle } from "react-icons/fi";
import { supabase } from "../lib/supabase";

interface Props {
  onBack: () => void;
  onSuccess: () => void;
  onSwitchToLogin: () => void;
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
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

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
      const { error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: {
            full_name: trimmedName,
          },
        },
      });

      if (error) throw error;
      setConfirmedEmail(trimmedEmail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account.");
    } finally {
      setBusy(false);
    }
  };

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
        <button className="auth-primary-btn" type="button" onClick={onSwitchToLogin}>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="auth-view">
      <button className="auth-back" type="button" onClick={onBack}>
        <FiArrowLeft size={14} />
        Back
      </button>

      <h2 className="auth-title">Create account</h2>
      <p className="auth-subtitle">
        Start with an email confirmation link to secure your account.
      </p>

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
          {busy ? "Creating account..." : "Create account"}
        </button>
      </form>

      <p className="auth-switch">
        Already have an account?{" "}
        <button type="button" onClick={onSwitchToLogin}>
          Log in
        </button>
      </p>
    </div>
  );
}
