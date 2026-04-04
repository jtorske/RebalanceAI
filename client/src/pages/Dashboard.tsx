import { FiAlertCircle, FiActivity } from "react-icons/fi";
import { HiOutlineLightBulb } from "react-icons/hi";
import DashboardNavbar from "../components/DashboardNavbar.tsx";
import "./Dashboard.css";

function Dashboard() {
  return (
    <div className="dashboard-shell">
      <div className="dashboard-page">
        <DashboardNavbar />

        <main className="dashboard-main">
          <section className="dashboard-top-section">
            <div className="dashboard-left-column">
              <div className="dashboard-balance">$-</div>
              <div className="dashboard-change">No holdings imported yet</div>

              <div className="dashboard-chart-card">
                <div className="dashboard-chart-placeholder dashboard-empty-state">
                  <div className="dashboard-empty-state-heading">
                    Import your holdings to unlock the portfolio chart.
                  </div>

                  <div className="dashboard-empty-state-copy">
                    Once your positions are uploaded, this area will show
                    performance over time, drawdowns, and rebalancing signals.
                  </div>
                </div>
              </div>
            </div>

            <div className="dashboard-right-column">
              <div className="dashboard-donut-wrap">
                <div className="dashboard-donut-ring">
                  <div className="dashboard-donut-core">
                    <div className="dashboard-donut-legend">
                      <div className="dashboard-donut-item">
                        <div className="dashboard-donut-bar dashboard-donut-bar-purple" />
                        <span className="dashboard-positive">+15%</span>
                      </div>

                      <div className="dashboard-donut-item">
                        <div className="dashboard-donut-bar dashboard-donut-bar-gold" />
                        <span className="dashboard-positive">+7%</span>
                      </div>

                      <div className="dashboard-donut-item no-margin">
                        <div className="dashboard-donut-bar dashboard-donut-bar-green" />
                        <span className="dashboard-negative">-6%</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="dashboard-allocation-card">
                <h4 className="dashboard-allocation-title">
                  Allocation Breakdown
                </h4>
                <div className="dashboard-allocation-empty">
                  Upload holdings to see sector, asset class, and cash
                  allocation.
                </div>
              </div>
            </div>
          </section>

          <section className="dashboard-cards-grid">
            <div className="dashboard-card">
              <div className="dashboard-card-title-row">
                <FiActivity size={30} />
                <span>Import checklist</span>
              </div>

              <div className="dashboard-card-content dashboard-info-list">
                <div className="dashboard-info-item">
                  Prepare CSV, XLSX, or broker export file.
                </div>
                <div className="dashboard-info-item">
                  Review imported tickers and share counts.
                </div>
                <div className="dashboard-info-item">
                  Confirm cost basis before rebalancing.
                </div>
              </div>
            </div>

            <div className="dashboard-card">
              <div className="dashboard-card-header-row">
                <div className="dashboard-card-title-row">
                  <HiOutlineLightBulb size={31} />
                  <span>What happens next</span>
                </div>
              </div>

              <div className="dashboard-card-content dashboard-info-list">
                <div className="dashboard-info-item">
                  We’ll calculate your allocation automatically.
                </div>
                <div className="dashboard-info-item">
                  Risk alerts will appear once positions are loaded.
                </div>
                <div className="dashboard-info-item">
                  Suggested rebalancing can be reviewed after import.
                </div>
              </div>
            </div>

            <div className="dashboard-card">
              <div className="dashboard-card-header-row">
                <div className="dashboard-card-title-row">
                  <FiAlertCircle size={31} color="#18151f" />
                  <span>Supported inputs</span>
                </div>
              </div>

              <div className="dashboard-card-content dashboard-info-list">
                <div className="dashboard-info-item">
                  CSV and spreadsheet imports.
                </div>
                <div className="dashboard-info-item">
                  Manual holding entry for small portfolios.
                </div>
                <div className="dashboard-info-item">
                  Broker export files for faster setup.
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

export default Dashboard;
