import { FiTrendingUp, FiRefreshCw, FiShield, FiChevronDown } from "react-icons/fi";
import "./Hero.css";

interface HeroProps {
  onSignIn: () => void;
}

const VALUE_PROPS = [
  { Icon: FiTrendingUp, label: "Real-time portfolio insights" },
  { Icon: FiRefreshCw, label: "AI-driven rebalancing suggestions" },
  { Icon: FiShield, label: "Risk analysis across sectors" },
] as const;

function Hero({ onSignIn }: HeroProps) {
  const handleViewDemo = () => {
    const root = document.getElementById("landing-root");
    const target = document.getElementById("dashboard-section");
    if (root && target) {
      root.scrollTo({ top: target.offsetTop, behavior: "smooth" });
    }
  };

  return (
    <section className="hero-section">
      <header className="hero-nav">
        <span className="hero-nav-brand">
          Rebalance<span className="hero-nav-brand-accent">X</span>
        </span>
        <button className="hero-nav-signin" type="button" onClick={onSignIn}>
          Sign In
        </button>
      </header>

      <div className="hero-content">
        <div className="hero-glow" aria-hidden="true" />

        <h1 className="hero-title">RebalanceX</h1>

        <p className="hero-subtitle">
          AI-powered portfolio analytics and rebalancing
        </p>

        <p className="hero-description">
          Track risk, optimize allocations, and make smarter investment decisions.
        </p>

        <div className="hero-actions">
          <button
            className="hero-btn-primary"
            type="button"
            onClick={handleViewDemo}
          >
            View Demo
          </button>
          <button
            className="hero-btn-secondary"
            type="button"
            onClick={onSignIn}
          >
            Sign In
          </button>
        </div>

        <div className="hero-value-props">
          {VALUE_PROPS.map(({ Icon, label }) => (
            <div className="hero-value-prop" key={label}>
              <span className="hero-value-icon">
                <Icon size={17} />
              </span>
              <span className="hero-value-label">{label}</span>
            </div>
          ))}
        </div>
      </div>

      <button
        className="hero-scroll-hint"
        type="button"
        aria-label="Scroll to dashboard demo"
        onClick={handleViewDemo}
      >
        <FiChevronDown size={20} />
      </button>
    </section>
  );
}

export default Hero;
