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
  const isError = status === "error";

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
              : "This can take up to a minute on the hosted demo while the API wakes up."}
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
