import { createPortal } from "react-dom";
import { FiX, FiLock, FiDatabase, FiTrendingUp, FiShield } from "react-icons/fi";
import "./AuthModal.css";
import "./AuthGateModal.css";

type Props = {
  onClose: () => void;
  onLogin: () => void;
  onSignup: () => void;
};

const BENEFITS = [
  { Icon: FiDatabase, text: "Save and sync your portfolio across devices" },
  { Icon: FiTrendingUp, text: "Generate personalized rebalance plans" },
  { Icon: FiShield, text: "Track goals and monitor risk over time" },
];

export default function AuthGateModal({ onClose, onLogin, onSignup }: Props) {
  return createPortal(
    <div className="auth-backdrop" onClick={onClose}>
      <div
        className="auth-modal auth-gate-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-gate-title"
      >
        <div className="auth-topbar">
          <span className="auth-wordmark">
            Rebalance<span>AI</span>
          </span>
          <button
            className="auth-icon-btn"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <FiX size={16} />
          </button>
        </div>

        <div className="auth-view auth-gate-view">
          <div className="auth-gate-lock-icon">
            <FiLock size={20} />
          </div>

          <h2 id="auth-gate-title" className="auth-title">
            Sign in to continue
          </h2>
          <p className="auth-subtitle">
            Create a free account to save your work and unlock the full
            RebalanceAI experience.
          </p>

          <ul className="auth-gate-benefits">
            {BENEFITS.map(({ Icon, text }) => (
              <li key={text}>
                <Icon size={14} />
                <span>{text}</span>
              </li>
            ))}
          </ul>

          <button className="auth-primary-btn" type="button" onClick={onLogin}>
            Log in
          </button>
          <button
            className="auth-outline-btn auth-gate-signup-btn"
            type="button"
            onClick={onSignup}
          >
            Create free account
          </button>
          <button className="auth-gate-skip-btn" type="button" onClick={onClose}>
            Continue exploring
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
