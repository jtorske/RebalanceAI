import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import "../components/AuthModal.css";

export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const finishAuthRedirect = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const callbackError =
          params.get("error_description") ?? params.get("error");
        if (callbackError) {
          throw new Error(callbackError);
        }

        const code = params.get("code");
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          const { error } = await supabase.auth.getSession();
          if (error) throw error;
        }

        if (active) {
          navigate("/", { replace: true });
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : "We could not verify your account. Please try signing in.",
          );
        }
      }
    };

    void finishAuthRedirect();

    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <main className="auth-callback-page">
      <section className="auth-modal auth-callback-card" aria-live="polite">
        <div className="auth-view">
          <span className="auth-wordmark">
            Rebalance<span>X</span>
          </span>
          <h1 className="auth-title">
            {error ? "Confirmation failed" : "Confirming your account"}
          </h1>
          <p className="auth-subtitle">
            {error
              ? error
              : "Just a moment while we finish your sign-in and take you back to the dashboard."}
          </p>
          {error && (
            <button
              className="auth-primary-btn"
              type="button"
              onClick={() => navigate("/", { replace: true })}
            >
              Return to sign in
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
