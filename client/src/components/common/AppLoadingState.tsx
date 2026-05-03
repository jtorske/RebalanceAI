import { useState, useEffect } from "react";
import "./AppLoadingState.css";
import type { ApiHealthStatus } from "../../hooks/useApiHealth";

type AppLoadingStateProps = {
  status: ApiHealthStatus;
  onRetry?: () => void;
};

const steps: { label: string; tag: string; activeOn: ApiHealthStatus }[] = [
  { label: "Reaching analytics API", tag: "Connecting", activeOn: "checking" },
  { label: "Waking up backend services", tag: "Warming up", activeOn: "warming" },
  { label: "Preparing portfolio data", tag: "Loading", activeOn: "ready" },
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
            {steps.map((step) => (
              <div className="app-loading-step" key={step.label}>
                <span className="app-loading-step-dot" />
                <span>{step.label}</span>
                {step.activeOn === status && <strong>{step.tag}</strong>}
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
