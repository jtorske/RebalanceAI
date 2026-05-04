import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
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
import { DemoModeProvider } from "./lib/demoMode";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AppLoadingState } from "./components/common/AppLoadingState";
import { ApiStatusBanner } from "./components/common/ApiStatusBanner";
import { useApiHealth } from "./hooks/useApiHealth";

function HomeRoute() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Dashboard /> : <LandingPage />;
}

// Redirects unauthenticated users to "/" (landing page with auth modal).
// Shows a blank screen during the initial session check to prevent flash.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-auth-loading" />;
  if (!user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const apiHealth = useApiHealth();

  if (
    apiHealth.isHostedApi &&
    (apiHealth.status === "checking" ||
      apiHealth.status === "warming" ||
      apiHealth.status === "error")
  ) {
    return (
      <AppLoadingState
        key={apiHealth.attempt}
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
        <Route path="/re-weight" element={<ProtectedRoute><Reweight /></ProtectedRoute>} />
        <Route path="/risk-manager" element={<ProtectedRoute><RiskManager /></ProtectedRoute>} />
        <Route path="/key-insights" element={<ProtectedRoute><KeyInsights /></ProtectedRoute>} />
        <Route path="/holdings" element={<ProtectedRoute><HoldingsPage /></ProtectedRoute>} />
        <Route path="/goal-planner" element={<ProtectedRoute><GoalPlanner /></ProtectedRoute>} />
        <Route path="/portfolio-report" element={<ProtectedRoute><PortfolioReport /></ProtectedRoute>} />
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
