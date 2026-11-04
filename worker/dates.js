// Date and streak logic. Dates are "YYYY-MM-DD" strings in Mamaroneck's time
// zone, so a day rolls over at midnight there wherever the Worker runs.

export const TIME_ZONE = "America/New_York";

export function todayIn(timeZone = TIME_ZONE, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// seenDates: every date "Seen" was clicked, oldest first, without duplicates.
// The current streak survives until a whole day is missed, so it still counts
// this morning, before today's click.
export function computeStreaks(seenDates, today) {
  let best = 0;
  let run = 0;
  let previous = null;
  for (const date of seenDates) {
    run = previous && addDays(previous, 1) === date ? run + 1 : 1;
    if (run > best) best = run;
    previous = date;
  }
  const alive = previous === today || previous === addDays(today, -1);
  return { current: alive ? run : 0, best };
}
