import { useEffect, useMemo, useState } from "react";
import { FiTarget } from "react-icons/fi";
import DashboardNavbar from "../components/DashboardNavbar";
import { API_BASE_URL } from "../lib/constants";
import { useUserSettings } from "../lib/userSettings";
import "./GoalPlanner.css";

type RiskProfile = "conservative" | "moderate" | "aggressive";
type HoldingsResponse = { holdings?: Array<{ market_value?: number; market_value_currency?: string }> };

const RISK_SPREAD: Record<RiskProfile, number> = { conservative: 1.5, moderate: 3, aggressive: 5 };
const RISK_RETURN_DEFAULT: Record<RiskProfile, number> = { conservative: 5, moderate: 7, aggressive: 10 };
const USD_TO_CAD = 1.37;

function fv(pv: number, r: number, n: number, pmt: number): number {
  if (n <= 0) return pv;
  if (r === 0) return pv + pmt * n;
  const g = Math.pow(1 + r, n);
  return pv * g + (pmt * (g - 1)) / r;
}

function requiredPmt(goal: number, pv: number, r: number, n: number): number {
  if (n <= 0) return 0;
  if (r === 0) return Math.max(0, (goal - pv) / n);
  const g = Math.pow(1 + r, n);
  return ((goal - pv * g) * r) / (g - 1);
}

function fmtCad(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `CA$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `CA$${Math.round(v / 1_000)}k`;
  return `CA$${Math.round(v).toLocaleString()}`;
}

function fmtAxis(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

const SVG_W = 700;
const SVG_H = 280;
const ML = 72;
const MR = 20;
const MT = 20;
const MB = 44;
const PW = SVG_W - ML - MR;
const PH = SVG_H - MT - MB;

export default function GoalPlanner() {
  const { settings } = useUserSettings();

  const [currentPortfolio, setCurrentPortfolio] = useState(0);
  const [goalAmount, setGoalAmount] = useState(500_000);
  const [currentAge, setCurrentAge] = useState(30);
  const [targetAge, setTargetAge] = useState(35);
  const [monthlyContrib, setMonthlyContrib] = useState(1_000);
  const [annualReturn, setAnnualReturn] = useState(7);
  const [inflation, setInflation] = useState(2);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>("moderate");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/holdings`);
        if (!res.ok) return;
        const data = (await res.json()) as HoldingsResponse;
        const total = (data.holdings ?? []).reduce((sum, h) => {
          const val = h.market_value ?? 0;
          const cur = (h.market_value_currency ?? "CAD").toUpperCase();
          return sum + (cur === "CAD" ? val : val * USD_TO_CAD);
        }, 0);
        if (total > 0) setCurrentPortfolio(Math.round(total));
      } catch {
        // leave default
      }
    };
    void load();
  }, []);

  const handleRiskChange = (p: RiskProfile) => {
    setRiskProfile(p);
    setAnnualReturn(RISK_RETURN_DEFAULT[p]);
  };

  const years = Math.max(1, targetAge - currentAge);
  const months = years * 12;
  const r = annualReturn / 100 / 12;
  const spreadRate = RISK_SPREAD[riskProfile] / 100 / 12;
  const rOpt = r + spreadRate;
  const rPess = Math.max(0, r - spreadRate);

  const { base, optimistic, pessimistic } = useMemo(() => {
    const base: number[] = [];
    const optimistic: number[] = [];
    const pessimistic: number[] = [];
    for (let t = 0; t <= years; t++) {
      const n = t * 12;
      base.push(fv(currentPortfolio, r, n, monthlyContrib));
      optimistic.push(fv(currentPortfolio, rOpt, n, monthlyContrib));
      pessimistic.push(fv(currentPortfolio, rPess, n, monthlyContrib));
    }
    return { base, optimistic, pessimistic };
  }, [currentPortfolio, monthlyContrib, r, rOpt, rPess, years]);

  const baseEnd = base[years];
  const optEnd = optimistic[years];
  const pessEnd = pessimistic[years];
  const inflationAdjGoal = goalAmount / Math.pow(1 + inflation / 100, years);
  const isOnTrack = baseEnd >= goalAmount;
  const reqMonthly = requiredPmt(goalAmount, currentPortfolio, r, months);
  const extraNeeded = Math.max(0, reqMonthly - monthlyContrib);

  const confidence =
    pessEnd >= goalAmount ? "High" :
    baseEnd >= goalAmount ? "Moderate" :
    optEnd >= goalAmount ? "Low" : "Below";

  const confColor =
    confidence === "High" ? "#4ade80" :
    confidence === "Moderate" ? "#FCC860" :
    confidence === "Low" ? "#fb923c" : "#ef4444";

  // SVG helpers
  const yMax = Math.max(optEnd * 1.08, goalAmount * 1.12, 1);
  const sx = (t: number) => ML + (t / years) * PW;
  const sy = (v: number) => MT + PH - Math.min(1, Math.max(0, v / yMax)) * PH;
  const toPath = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");

  const bandPath = (() => {
    const fwd = optimistic.map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`);
    const bwd = [...pessimistic].reverse().map((v, i) => {
      const t = years - i;
      return `L${sx(t).toFixed(1)},${sy(v).toFixed(1)}`;
    });
    return fwd.join(" ") + " " + bwd.join(" ") + " Z";
  })();

  const goalY = sy(goalAmount);
  const goalInRange = goalY >= MT && goalY <= MT + PH;

  const xLabels: number[] = [];
  const step = years <= 5 ? 1 : years <= 10 ? 2 : Math.ceil(years / 5);
  for (let t = 0; t <= years; t += step) xLabels.push(t);
  if (!xLabels.includes(years)) xLabels.push(years);
  const yLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const mask = (s: string) => (settings.hideDollarAmounts ? "···" : s);

  return (
    <div className="goal-shell">
      <DashboardNavbar />
      <div className="goal-body">
        <div className="goal-header">
          <div>
            <h1 className="goal-title-row">
              <FiTarget size={22} />
              Goal Planner
            </h1>
            <p className="goal-subtitle">
              Project whether your portfolio can reach a target by a specific age.
            </p>
          </div>
          {currentPortfolio > 0 && (
            <div className="goal-portfolio-badge">
              Current portfolio&nbsp;
              <strong>{mask(`CA$${currentPortfolio.toLocaleString()}`)}</strong>
            </div>
          )}
        </div>

        <div className="goal-layout">
          {/* ── Inputs ── */}
          <aside className="goal-sidebar">
            <div className="goal-card">
              <h3 className="goal-section-title">Your Goal</h3>

              <div className="goal-field">
                <label>Target amount (CA$)</label>
                <input
                  type="number" min={0} value={goalAmount}
                  onChange={(e) => setGoalAmount(Number(e.target.value))}
                />
              </div>

              <div className="goal-field-row">
                <div className="goal-field">
                  <label>Current age</label>
                  <input type="number" min={1} max={99} value={currentAge}
                    onChange={(e) => setCurrentAge(Number(e.target.value))} />
                </div>
                <div className="goal-field">
                  <label>Target age</label>
                  <input type="number" min={currentAge + 1} max={100} value={targetAge}
                    onChange={(e) => setTargetAge(Number(e.target.value))} />
                </div>
              </div>

              <div className="goal-field">
                <label>Starting portfolio (CA$)</label>
                <input type="number" min={0} value={currentPortfolio}
                  onChange={(e) => setCurrentPortfolio(Number(e.target.value))} />
                <span className="goal-field-hint">Auto-filled from your holdings</span>
              </div>

              <div className="goal-field">
                <label>Monthly contribution (CA$)</label>
                <input type="number" min={0} value={monthlyContrib}
                  onChange={(e) => setMonthlyContrib(Number(e.target.value))} />
              </div>
            </div>

            <div className="goal-card">
              <h3 className="goal-section-title">Return Assumptions</h3>

              <div className="goal-risk-row">
                {(["conservative", "moderate", "aggressive"] as RiskProfile[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`goal-risk-btn${riskProfile === p ? " goal-risk-btn-active" : ""}`}
                    onClick={() => handleRiskChange(p)}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>

              <div className="goal-field">
                <label>Expected annual return (%)</label>
                <input type="number" min={0} max={30} step={0.5} value={annualReturn}
                  onChange={(e) => setAnnualReturn(Number(e.target.value))} />
                <span className="goal-field-hint">
                  ±{RISK_SPREAD[riskProfile]}% confidence band applied
                </span>
              </div>

              <div className="goal-field">
                <label>Inflation rate (%)</label>
                <input type="number" min={0} max={20} step={0.1} value={inflation}
                  onChange={(e) => setInflation(Number(e.target.value))} />
              </div>
            </div>
          </aside>

          {/* ── Chart + outcomes ── */}
          <div className="goal-content">
            <div className="goal-card goal-chart-card">
              <div className="goal-chart-header">
                <span className="goal-chart-title">Portfolio Projection · {years} year{years !== 1 ? "s" : ""}</span>
                <div className="goal-legend">
                  <span className="goal-legend-item">
                    <span className="goal-legend-line" style={{ background: "#A7F782" }} />Bull
                  </span>
                  <span className="goal-legend-item">
                    <span className="goal-legend-line" style={{ background: "#9074FF" }} />Base
                  </span>
                  <span className="goal-legend-item">
                    <span className="goal-legend-line" style={{ background: "#FF8FA3" }} />Bear
                  </span>
                  <span className="goal-legend-item">
                    <span className="goal-legend-dash" />Goal
                  </span>
                </div>
              </div>

              <div className="goal-svg-wrap">
              <svg
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="goal-svg"
                preserveAspectRatio="none"
                aria-label="Portfolio projection chart"
              >
                {/* Y-axis grid + labels */}
                {yLabels.map((v, i) => (
                  <g key={i}>
                    <line x1={ML} y1={sy(v)} x2={ML + PW} y2={sy(v)}
                      stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                    <text x={ML - 6} y={sy(v)} textAnchor="end" dominantBaseline="middle"
                      fontSize="10" fill="#666">
                      {fmtAxis(v)}
                    </text>
                  </g>
                ))}

                {/* X-axis labels */}
                {xLabels.map((t) => (
                  <text key={t} x={sx(t)} y={SVG_H - MB + 14}
                    textAnchor="middle" fontSize="10" fill="#666">
                    {t === 0 ? "Now" : `Yr ${t}`}
                  </text>
                ))}

                {/* X-axis baseline */}
                <line x1={ML} y1={MT + PH} x2={ML + PW} y2={MT + PH}
                  stroke="rgba(255,255,255,0.12)" strokeWidth="1" />

                {/* Goal line */}
                {goalInRange && (
                  <g>
                    <line x1={ML} y1={goalY} x2={ML + PW} y2={goalY}
                      stroke="#FCC860" strokeWidth="1.5" strokeDasharray="7 4" />
                    <rect x={ML + PW - 68} y={goalY - 14} width={66} height={16}
                      rx={4} fill="rgba(252,200,96,0.15)" />
                    <text x={ML + PW - 4} y={goalY - 4} textAnchor="end"
                      fontSize="10" fontWeight="600" fill="#FCC860">
                      Goal {fmtAxis(goalAmount)}
                    </text>
                  </g>
                )}

                {/* Confidence band */}
                <path d={bandPath} fill="rgba(144,116,255,0.1)" />

                {/* Bear line */}
                <path d={toPath(pessimistic)} fill="none"
                  stroke="#FF8FA3" strokeWidth="1.5" strokeDasharray="5 3" />

                {/* Bull line */}
                <path d={toPath(optimistic)} fill="none"
                  stroke="#A7F782" strokeWidth="1.5" strokeDasharray="5 3" />

                {/* Base line */}
                <path d={toPath(base)} fill="none" stroke="#9074FF" strokeWidth="2.5" />

                {/* End-point dot */}
                <circle cx={sx(years)} cy={sy(baseEnd)} r="5"
                  fill="#9074FF" stroke="#1a1a2e" strokeWidth="2" />

                {/* On-track marker where base crosses goal */}
                {isOnTrack && (() => {
                  const crossIdx = base.findIndex((v) => v >= goalAmount);
                  if (crossIdx > 0) {
                    return (
                      <circle cx={sx(crossIdx)} cy={sy(goalAmount)} r="4"
                        fill="#FCC860" stroke="#1a1a2e" strokeWidth="1.5" />
                    );
                  }
                  return null;
                })()}
              </svg>
              </div>
            </div>

            {/* Outcome cards */}
            <div className="goal-outcomes">
              <div className={`goal-outcome-card${isOnTrack ? " goal-outcome-card--green" : " goal-outcome-card--red"}`}>
                <div className="goal-outcome-label">Projected at age {targetAge}</div>
                <div className="goal-outcome-value">{mask(fmtCad(baseEnd))}</div>
                <div className="goal-outcome-sub">
                  {isOnTrack
                    ? `${mask(fmtCad(baseEnd - goalAmount))} above goal`
                    : `${mask(fmtCad(goalAmount - baseEnd))} short of goal`}
                </div>
              </div>

              <div className="goal-outcome-card" style={{ borderLeftColor: confColor }}>
                <div className="goal-outcome-label">Confidence</div>
                <div className="goal-outcome-value" style={{ color: confColor }}>{confidence}</div>
                <div className="goal-outcome-sub">
                  Bear {mask(fmtCad(pessEnd))} · Bull {mask(fmtCad(optEnd))}
                </div>
              </div>

              <div className={`goal-outcome-card${extraNeeded > 0 ? " goal-outcome-card--amber" : " goal-outcome-card--green"}`}>
                <div className="goal-outcome-label">
                  {extraNeeded > 0 ? "Suggested monthly increase" : "Monthly contributions"}
                </div>
                <div className="goal-outcome-value">
                  {extraNeeded > 0
                    ? mask(`+CA$${Math.ceil(extraNeeded).toLocaleString()}/mo`)
                    : "On track"}
                </div>
                <div className="goal-outcome-sub">
                  {extraNeeded > 0
                    ? `Total needed: CA$${Math.ceil(reqMonthly).toLocaleString()}/mo`
                    : `CA$${monthlyContrib.toLocaleString()}/mo is sufficient`}
                </div>
              </div>

              <div className="goal-outcome-card">
                <div className="goal-outcome-label">Inflation-adjusted goal</div>
                <div className="goal-outcome-value">{mask(fmtCad(inflationAdjGoal))}</div>
                <div className="goal-outcome-sub">
                  Today's purchasing power of {mask(fmtCad(goalAmount))} in {years}yr at {inflation}% inflation
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
