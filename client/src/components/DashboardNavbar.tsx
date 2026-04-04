import { FiUser } from "react-icons/fi";
import { Link, NavLink } from "react-router-dom";
import "./DashboardNavbar.css";

function DashboardNavbar() {
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
          to="/import-holdings"
        >
          <span className="dashboard-navbar-badge">START HERE</span>
          Import Holdings
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
