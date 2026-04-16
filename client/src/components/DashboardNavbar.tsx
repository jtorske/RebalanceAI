import { FiUser } from "react-icons/fi";
import { Link, NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import "./DashboardNavbar.css";

type HoldingsResponse = {
  holdings?: Array<unknown>;
};

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

function DashboardNavbar() {
  const [hasPersistedHoldings, setHasPersistedHoldings] = useState(false);

  useEffect(() => {
    const loadHoldingsState = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/holdings`);
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as HoldingsResponse;
        setHasPersistedHoldings((data.holdings?.length ?? 0) > 0);
      } catch {
        setHasPersistedHoldings(false);
      }
    };

    const refreshHoldingsState = () => {
      void loadHoldingsState();
    };

    void loadHoldingsState();
    window.addEventListener("holdings-changed", refreshHoldingsState);

    return () => {
      window.removeEventListener("holdings-changed", refreshHoldingsState);
    };
  }, []);

  return (
    <header className="dashboard-navbar">
      <Link className="dashboard-navbar-brand" to="/">
        Rebalance<span className="dashboard-navbar-brand-accent">AI</span>
      </Link>

      <nav className="dashboard-navbar-nav">
        <NavLink className="dashboard-navbar-link" to="/re-weight">
          Re-weight
        </NavLink>
        <NavLink className="dashboard-navbar-link" to="/risk-manager">
          Risk Manager
        </NavLink>
        <NavLink className="dashboard-navbar-link" to="/key-insights">
          Key Insights
        </NavLink>
        <NavLink
          className="dashboard-navbar-link dashboard-navbar-link-primary"
          to="/holdings"
        >
          {hasPersistedHoldings ? (
            "Holdings"
          ) : (
            <>
              <span className="dashboard-navbar-badge">START HERE</span>
              Holdings
            </>
          )}
        </NavLink>
      </nav>

      <FiUser
        className="dashboard-navbar-user-icon"
        size={34}
        color="#232323"
      />
    </header>
  );
}

export default DashboardNavbar;
