import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDemoMode } from "../lib/demoMode";
import "./DashboardOnboardingBanner.css";

const STORAGE_KEY = "rebalancex:dashboard-onboarding-dismissed";

export default function DashboardOnboardingBanner() {
  const { isDemoMode } = useDemoMode();
  const [isDismissed, setIsDismissed] = useState(true);

  useEffect(() => {
    setIsDismissed(localStorage.getItem(STORAGE_KEY) === "true");
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setIsDismissed(true);
  };

  if (!isDemoMode || isDismissed) {
    return null;
  }

  return (
    <section className="dashboard-onboarding-banner" aria-label="Demo onboarding">
      <p>
        You are exploring a demo portfolio. Sign up to import your own holdings
        and generate personalized insights.
      </p>
      <div className="dashboard-onboarding-actions">
        <Link className="dashboard-onboarding-primary" to="/holdings">
          Import holdings
        </Link>
        <button
          className="dashboard-onboarding-dismiss"
          type="button"
          onClick={dismiss}
        >
          Continue demo
        </button>
      </div>
    </section>
  );
}
