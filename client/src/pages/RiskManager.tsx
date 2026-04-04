import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";

function RiskManager() {
  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="route-page-card">
          <h1 className="route-page-title">Risk Manager</h1>
          <p className="route-page-copy">
            Monitor portfolio exposure and rebalance risk efficiently.
          </p>
        </section>
      </main>
    </div>
  );
}

export default RiskManager;
