export type EarningsEvent = { date: string; symbols: string[] };

type Props = {
  events: EarningsEvent[];
  month: Date;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  title?: string;
  maxVisible?: number;
  yearLock?: number;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function EarningsCalendar({
  events,
  month,
  onPrevMonth,
  onNextMonth,
  title = "Portfolio Events",
  maxVisible = 2,
  yearLock,
}: Props) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  const year = month.getFullYear();
  const monthIdx = month.getMonth();
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, monthIdx, 1).getDay();

  const eventMap = new Map<string, string[]>();
  for (const ev of events) {
    eventMap.set(ev.date, ev.symbols);
  }

  const monthName = month.toLocaleString("default", { month: "long", year: "numeric" });
  const days: (number | null)[] = [...Array(firstDayOfWeek).fill(null)];
  for (let d = 1; d <= daysInMonth; d++) days.push(d);
  // Pad to 42 cells (6 full weeks) so the grid height never changes between months
  while (days.length < 42) days.push(null);

  const canGoPrev = yearLock == null || year > yearLock || monthIdx > 0;
  const canGoNext = yearLock == null || year < yearLock || monthIdx < 11;

  return (
    <div className="ec-wrap">
      <div className="ec-header">
        <span className="ec-title">{title}</span>
        <div className="ec-nav">
          <button
            type="button"
            className="ec-nav-btn"
            onClick={onPrevMonth}
            disabled={!canGoPrev}
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="ec-month-label">{monthName}</span>
          <button
            type="button"
            className="ec-nav-btn"
            onClick={onNextMonth}
            disabled={!canGoNext}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <div className="ec-grid">
        {DAYS.map((d) => (
          <div key={d} className="ec-weekday">{d}</div>
        ))}

        {days.map((day, i) => {
          if (day === null) {
            return <div key={`empty-${i}`} className="ec-cell ec-cell-empty" />;
          }

          const dateStr = `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const cellDate = new Date(year, monthIdx, day);
          cellDate.setHours(0, 0, 0, 0);
          const isToday = cellDate.getTime() === today.getTime();
          const isThisWeek = cellDate >= weekStart && cellDate <= weekEnd;
          const symbols = eventMap.get(dateStr) ?? [];
          const visible = symbols.slice(0, maxVisible);
          const overflow = symbols.length - maxVisible;

          const cls = [
            "ec-cell",
            isToday ? "ec-cell-today" : "",
            isThisWeek && symbols.length > 0 ? "ec-cell-thisweek" : "",
            symbols.length > 0 ? "ec-cell-active" : "",
          ].filter(Boolean).join(" ");

          return (
            <div key={dateStr} className={cls}>
              <span className="ec-day-num">{day}</span>
              {visible.map((sym) => (
                <span key={sym} className="ec-chip">{sym}</span>
              ))}
              {overflow > 0 && (
                <span className="ec-chip ec-chip-overflow">+{overflow}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
