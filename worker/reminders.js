// Decides which reminders apply on a date. A reminder looks like:
//   { id, title, repeat: "once" | "daily" | "weekly", date, days, time, activity }
// For "once", date is the day it's due. For repeats, date is the day it was
// created, and activity optionally limits it to days that activity is on.

function weekdayOf(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isActivityOn(activity, date, off) {
  return activity.days.includes(weekdayOf(date)) && !(off[date] || []).includes(activity.id);
}

export function isDue(reminder, date, activities, off) {
  if (reminder.repeat === "once") return reminder.date === date;
  if (date < reminder.date) return false;
  if (reminder.repeat === "weekly" && !reminder.days.includes(weekdayOf(date))) return false;
  const activity = activities.find((a) => a.id === reminder.activity);
  return !activity || isActivityOn(activity, date, off);
}

// What shows in today's list. doneDates[id] lists the days it was checked off.
// One-day reminders stay until they're done, marked overdue; repeating ones
// only show on the days they're due.
export function todoFor(today, reminders, doneDates, activities, off) {
  const items = [];
  for (const reminder of reminders) {
    const done = doneDates[reminder.id] || [];
    if (reminder.repeat === "once") {
      if (done.length ? done.includes(today) : reminder.date <= today) {
        items.push({
          ...reminder,
          done: done.length > 0,
          overdue: done.length === 0 && reminder.date < today,
        });
      }
    } else if (isDue(reminder, today, activities, off)) {
      items.push({ ...reminder, done: done.includes(today), overdue: false });
    }
  }
  return items.sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      Number(b.overdue) - Number(a.overdue) ||
      (a.time || "99:99").localeCompare(b.time || "99:99"),
  );
}
