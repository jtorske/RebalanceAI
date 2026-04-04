import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";

function Reweight() {
  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="route-page-card">
          <h1 className="route-page-title">Reweight</h1>
          <p className="route-page-copy">
            Adjust your portfolio weights based on AI recommendations.
          </p>
        </section>
      </main>
    </div>
  );
}

export default Reweight;
