import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./RoutePage.css";

function Home() {
  return (
    <div className="route-page">
      <DashboardNavbar />
      <main className="route-page-main">
        <section className="route-page-card">
          <h1 className="route-page-title">Home</h1>
          <p className="route-page-copy">
            Welcome to RebalanceAI. Choose a section from the navigation to
            continue.
          </p>
        </section>
      </main>
    </div>
  );
}

export default Home;
