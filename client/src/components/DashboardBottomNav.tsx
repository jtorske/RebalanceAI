import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { FiAlertCircle, FiDatabase, FiHome, FiRefreshCw } from "react-icons/fi";
import { HiOutlineLightBulb } from "react-icons/hi";
import "./DashboardBottomNav.css";

const NAV_ITEMS = [
  { to: "/",            label: "Home",      icon: <FiHome size={20} />,            end: true  },
  { to: "/holdings",    label: "Holdings",  icon: <FiDatabase size={20} />,        end: false },
  { to: "/re-weight",   label: "Re-weight", icon: <FiRefreshCw size={20} />,       end: false },
  { to: "/key-insights",label: "Insights",  icon: <HiOutlineLightBulb size={21} />,end: false },
  { to: "/risk-manager",label: "Risk",      icon: <FiAlertCircle size={20} />,     end: false },
] as const;

export default function DashboardBottomNav() {
  return createPortal(
    <nav className="mobile-bottom-nav" aria-label="App navigation">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `mobile-bottom-nav-item${isActive ? " mobile-bottom-nav-item--active" : ""}`
          }
        >
          {item.icon}
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>,
    document.body,
  );
}
