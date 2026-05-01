export type EarningsEvent = { date: string; symbols: string[] };

type Props = {
  events: EarningsEvent[];
  month: Date;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday?: () => void;
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
  onToday,
  title = "Portfolio Events",
  maxVisible = 2,
  yearLock,
}: Props) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const year = month.getFullYear();
  const monthIdx = month.getMonth();
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, monthIdx, 1).getDay();

  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() === monthIdx;

  const eventMap = new Map<string, string[]>();
  for (const ev of events) {
    eventMap.set(ev.date, ev.symbols);
  }

  const monthName = month.toLocaleString("default", { month: "long", year: "numeric" });
  const days: (number | null)[] = [...Array(firstDayOfWeek).fill(null)];
  for (let d = 1; d <= daysInMonth; d++) days.push(d);
  while (days.length < 42) days.push(null);

  const canGoPrev = yearLock == null || year > yearLock || monthIdx > 0;
  const canGoNext = yearLock == null || year < yearLock || monthIdx < 11;

  return (
    <div className="ec-wrap">
      <div className="ec-header">
        <span className="ec-title">{title}</span>
        <div className="ec-controls">
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
          {onToday && !isCurrentMonth && (
            <button
              type="button"
              className="ec-today-btn"
              onClick={onToday}
              aria-label="Go to today"
            >
              Today
            </button>
          )}
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
          const symbols = eventMap.get(dateStr) ?? [];
          const visible = symbols.slice(0, maxVisible);
          const overflow = symbols.length - maxVisible;

          const cls = [
            "ec-cell",
            isToday ? "ec-cell-today" : "",
            symbols.length > 0 ? "ec-cell-active" : "ec-cell-quiet",
          ].filter(Boolean).join(" ");

          return (
            <div key={dateStr} className={cls}>
              <span className="ec-day-num">{day}</span>
              {visible.map((sym) => (
                <span key={sym} className="ec-chip" title={sym}>{sym}</span>
              ))}
              {overflow > 0 && (
                <span className="ec-chip-more">+{overflow}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
