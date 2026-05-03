import { useState, useEffect } from "react";
import "./AppLoadingState.css";
import type { ApiHealthStatus } from "../../hooks/useApiHealth";

type AppLoadingStateProps = {
  status: ApiHealthStatus;
  onRetry?: () => void;
};

const steps = [
  "Connecting to analytics API",
  "Loading portfolio data",
  "Preparing dashboard insights",
];

export function AppLoadingState({ status, onRetry }: AppLoadingStateProps) {
  const [hasTimedOut, setHasTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasTimedOut(true), 60000);
    return () => clearTimeout(timer);
  }, []);
  const isError = status === "error" && hasTimedOut;

  return (
    <main className="app-loading-shell">
      <section className="app-loading-panel" aria-live="polite">
        <div className="app-loading-brand">
          <div className="app-loading-mark">RX</div>
          <span>RebalanceX</span>
        </div>

        <div className="app-loading-copy">
          <h1>
            {isError
              ? "We couldn't connect to the analytics API"
              : "Starting portfolio analytics engine"}
          </h1>
          <p>
            {isError
              ? "Please refresh or try again shortly."
              : "Check back in a minute or so while the analytics engine starts up."}
          </p>
        </div>

        {!isError && (
          <div className="app-loading-steps">
            {steps.map((step, index) => (
              <div className="app-loading-step" key={step}>
                <span className="app-loading-step-dot" />
                <span>{step}</span>
                {index === 0 && <strong>Connecting</strong>}
              </div>
            ))}
          </div>
        )}

        {isError ? (
          <button className="app-loading-retry" type="button" onClick={onRetry}>
            Try again
          </button>
        ) : (
          <div className="app-loading-spinner" aria-hidden="true" />
        )}
      </section>
    </main>
  );
}
