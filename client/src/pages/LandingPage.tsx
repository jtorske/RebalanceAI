import { useState } from "react";
import Hero from "../components/Hero";
import Dashboard from "./Dashboard";
import AuthModal from "../components/AuthModal";
import "./LandingPage.css";

function LandingPage() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  return (
    <div className="landing-root" id="landing-root">
      <Hero onSignIn={() => setIsAuthModalOpen(true)} />
      <div id="dashboard-section">
        <Dashboard />
      </div>
      {isAuthModalOpen && (
        <AuthModal
          mode="login"
          onClose={() => setIsAuthModalOpen(false)}
        />
      )}
    </div>
  );
}

export default LandingPage;
