import "./ApiStatusBanner.css";
import type { ApiHealthStatus } from "../../hooks/useApiHealth";

type ApiStatusBannerProps = {
  status: ApiHealthStatus;
  onRetry?: () => void;
};

export function ApiStatusBanner({ status, onRetry }: ApiStatusBannerProps) {
  if (status === "ready" || status === "checking") return null;

  const isError = status === "error";

  return (
    <div className={`api-status-banner ${isError ? "api-status-banner-error" : ""}`}>
      <span className="api-status-dot" />
      <span>
        {isError
          ? "We couldn't connect to the analytics API. Please refresh or try again shortly."
          : "Analytics engine is still warming up — some features may load slowly."}
      </span>
      {isError && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
