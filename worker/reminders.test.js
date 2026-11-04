import assert from "node:assert/strict";
import { test } from "node:test";
import { isDue, todoFor } from "./reminders.js";

// 2026-11-04 is a Wednesday
const practice = { id: "practice", name: "Practice", days: [1, 2, 3, 4, 5] };
const base = { id: "r", title: "x", days: [], time: null, activity: null };

test("one-day reminder is due only on its date", () => {
  const r = { ...base, repeat: "once", date: "2026-11-04" };
  assert.equal(isDue(r, "2026-11-04", [], {}), true);
  assert.equal(isDue(r, "2026-11-05", [], {}), false);
});

test("repeats don't start before they were created", () => {
  const r = { ...base, repeat: "daily", date: "2026-11-04" };
  assert.equal(isDue(r, "2026-11-03", [], {}), false);
  assert.equal(isDue(r, "2026-11-20", [], {}), true);
});

test("weekly reminder follows its weekdays", () => {
  const r = { ...base, repeat: "weekly", date: "2026-11-01", days: [3] };
  assert.equal(isDue(r, "2026-11-04", [], {}), true);
  assert.equal(isDue(r, "2026-11-05", [], {}), false);
});

test("activity-linked reminder skips days off and unscheduled days", () => {
  const r = { ...base, repeat: "daily", date: "2026-11-01", activity: "practice" };
  assert.equal(isDue(r, "2026-11-04", [practice], {}), true);
  assert.equal(isDue(r, "2026-11-04", [practice], { "2026-11-04": ["practice"] }), false);
  assert.equal(isDue(r, "2026-11-07", [practice], {}), false, "Saturday");
});

test("a removed activity stops limiting the reminder", () => {
  const r = { ...base, repeat: "daily", date: "2026-11-01", activity: "gone" };
  assert.equal(isDue(r, "2026-11-07", [practice], {}), true);
});

test("one-day reminder stays overdue until done, then disappears tomorrow", () => {
  const r = { ...base, repeat: "once", date: "2026-11-02" };
  const today = "2026-11-04";
  assert.equal(todoFor("2026-11-01", [r], {}, [], {}).length, 0, "not yet");
  assert.equal(todoFor(today, [r], {}, [], {})[0].overdue, true);

  const doneToday = todoFor(today, [r], { r: [today] }, [], {});
  assert.equal(doneToday[0].done, true);
  assert.equal(doneToday[0].overdue, false);
  assert.equal(todoFor("2026-11-05", [r], { r: [today] }, [], {}).length, 0);
});

test("repeating reminder resets each day", () => {
  const r = { ...base, repeat: "daily", date: "2026-11-01" };
  assert.equal(todoFor("2026-11-04", [r], { r: ["2026-11-04"] }, [], {})[0].done, true);
  assert.equal(todoFor("2026-11-05", [r], { r: ["2026-11-04"] }, [], {})[0].done, false);
});

test("list order: open before done, overdue first, then by time", () => {
  const today = "2026-11-04";
  const reminders = [
    { ...base, id: "done", repeat: "daily", date: today },
    { ...base, id: "untimed", repeat: "daily", date: today },
    { ...base, id: "late", repeat: "daily", date: today, time: "15:00" },
    { ...base, id: "early", repeat: "daily", date: today, time: "08:00" },
    { ...base, id: "overdue", repeat: "once", date: "2026-11-01" },
  ];
  const order = todoFor(today, reminders, { done: [today] }, [], {}).map((r) => r.id);
  assert.deepEqual(order, ["overdue", "early", "late", "untimed", "done"]);
});
