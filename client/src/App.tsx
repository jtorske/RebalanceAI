import { BrowserRouter, Route, Routes } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import AuthCallback from "./pages/AuthCallback";
import Dashboard from "./pages/Dashboard";
import Reweight from "./pages/Reweight";
import HoldingsPage from "./pages/Holdings";
import KeyInsights from "./pages/KeyInsights";
import RiskManager from "./pages/RiskManager";
import GoalPlanner from "./pages/GoalPlanner";
import PortfolioReport from "./pages/PortfolioReport";
import { UserSettingsProvider } from "./lib/userSettings";
import { DemoModeProvider, useDemoMode } from "./lib/demoMode";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AppLoadingState } from "./components/common/AppLoadingState";
import { ApiStatusBanner } from "./components/common/ApiStatusBanner";
import { useApiHealth } from "./hooks/useApiHealth";

function HomeRoute() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Dashboard /> : <LandingPage />;
}

function AppRoutes() {
  const apiHealth = useApiHealth();
  const { user, loading } = useAuth();
  const { isDemoMode } = useDemoMode();
  const shouldBlockForApi =
    apiHealth.isHostedApi &&
    !loading &&
    !!user &&
    !isDemoMode &&
    (apiHealth.status === "checking" ||
      apiHealth.status === "warming" ||
      apiHealth.status === "error");

  if (shouldBlockForApi) {
    return (
      <AppLoadingState
        status={apiHealth.status}
        onRetry={apiHealth.retryNow}
      />
    );
  }

  return (
    <>
      <ApiStatusBanner
        status={apiHealth.status}
        onRetry={apiHealth.retryNow}
      />
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/re-weight" element={<Reweight />} />
        <Route path="/risk-manager" element={<RiskManager />} />
        <Route path="/key-insights" element={<KeyInsights />} />
        <Route path="/holdings" element={<HoldingsPage />} />
        <Route path="/goal-planner" element={<GoalPlanner />} />
        <Route path="/portfolio-report" element={<PortfolioReport />} />
      </Routes>
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <UserSettingsProvider>
        <DemoModeProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </DemoModeProvider>
      </UserSettingsProvider>
    </AuthProvider>
  );
}

export default App;
