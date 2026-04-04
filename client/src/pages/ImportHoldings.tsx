import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";

function ImportHoldings() {
  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="route-page-card">
          <h1 className="route-page-title">Import Holdings</h1>
          <p className="route-page-copy">
            Upload your holdings file to sync and analyze your positions.
          </p>
        </section>
      </main>
    </div>
  );
}

export default ImportHoldings;
