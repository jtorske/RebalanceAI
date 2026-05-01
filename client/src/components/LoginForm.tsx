import { useState } from "react";
import { FiArrowLeft } from "react-icons/fi";
import { FaGoogle } from "react-icons/fa";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";

interface Props {
  onBack: () => void;
  onSuccess: () => void;
  onSwitchToSignup: () => void;
}

export default function LoginForm({ onBack, onSuccess, onSwitchToSignup }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const { signIn } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid email or password.");
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setGoogleBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setError(error.message);
      setGoogleBusy(false);
    }
    // success → browser redirects, nothing more to do here
  };

  return (
    <div className="auth-view">
      <button className="auth-back" type="button" onClick={onBack}>
        <FiArrowLeft size={14} />
        Back
      </button>

      <h2 className="auth-title">Log in</h2>

      <button
        className="auth-google-btn"
        type="button"
        disabled={googleBusy}
        onClick={() => void handleGoogle()}
      >
        <FaGoogle size={14} />
        {googleBusy ? "Redirecting…" : "Continue with Google"}
      </button>

      <div className="auth-or"><span>or</span></div>

      <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
        <label className="auth-label">
          Email
          <input
            className="auth-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            autoComplete="email"
          />
        </label>

        <label className="auth-label">
          Password
          <input
            className="auth-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            autoComplete="current-password"
          />
        </label>

        {error && <p className="auth-error">{error}</p>}

        <button className="auth-primary-btn" type="submit" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>

      <p className="auth-switch">
        Don&apos;t have an account?{" "}
        <button type="button" onClick={onSwitchToSignup}>Sign up</button>
      </p>
    </div>
  );
}
