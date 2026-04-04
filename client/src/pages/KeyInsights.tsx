import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";

function KeyInsights() {
  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="route-page-card">
          <h1 className="route-page-title">Key Insights</h1>
          <p className="route-page-copy">
            Review AI-generated highlights for your portfolio performance.
          </p>
        </section>
      </main>
    </div>
  );
}

export default KeyInsights;
