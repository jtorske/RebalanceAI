import { BrowserRouter, Route, Routes } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import AuthCallback from "./pages/AuthCallback";
import Dashboard from "./pages/Dashboard";
import Reweight from "./pages/Reweight";
import HoldingsPage from "./pages/Holdings";
import KeyInsights from "./pages/KeyInsights";
import RiskManager from "./pages/RiskManager";
import GoalPlanner from "./pages/GoalPlanner";
import { UserSettingsProvider } from "./lib/userSettings";
import { DemoModeProvider } from "./lib/demoMode";
import { AuthProvider, useAuth } from "./context/AuthContext";

function HomeRoute() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Dashboard /> : <LandingPage />;
}

function App() {
  return (
    <AuthProvider>
      <UserSettingsProvider>
        <DemoModeProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<HomeRoute />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/re-weight" element={<Reweight />} />
              <Route path="/risk-manager" element={<RiskManager />} />
              <Route path="/key-insights" element={<KeyInsights />} />
              <Route path="/holdings" element={<HoldingsPage />} />
              <Route path="/goal-planner" element={<GoalPlanner />} />
            </Routes>
          </BrowserRouter>
        </DemoModeProvider>
      </UserSettingsProvider>
    </AuthProvider>
  );
}

export default App;
