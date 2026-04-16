import { BrowserRouter, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Reweight from "./pages/Reweight";
import HoldingsPage from "./pages/Holdings";
import KeyInsights from "./pages/KeyInsights";
import RiskManager from "./pages/RiskManager";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/re-weight" element={<Reweight />} />
        <Route path="/risk-manager" element={<RiskManager />} />
        <Route path="/key-insights" element={<KeyInsights />} />
        <Route path="/holdings" element={<HoldingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
