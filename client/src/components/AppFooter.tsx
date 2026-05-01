import "./AppFooter.css";

export default function AppFooter() {
  return (
    <footer className="app-footer">
      <div className="app-footer-top">
        <span className="app-footer-brand">
          Rebalance<span>X</span>
        </span>
        <nav className="app-footer-links" aria-label="Footer links">
          <a className="app-footer-link" href="/privacy">Privacy Policy</a>
          <a className="app-footer-link" href="/terms">Terms of Use</a>
          <a className="app-footer-link" href="mailto:support@rebalancex.app">Contact</a>
        </nav>
      </div>
      <p className="app-footer-disclaimer">
        RebalanceX provides educational portfolio analysis based on user-selected assumptions
        and is not financial advice. All figures are estimated and for informational purposes only.
        Past performance does not guarantee future results.
      </p>
      <p className="app-footer-copyright">
        © {new Date().getFullYear()} RebalanceX. All rights reserved.
      </p>
    </footer>
  );
}
