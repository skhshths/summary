import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, computeStreaks, isDate, todayIn } from "./dates.js";

test("no clicks means no streak", () => {
  assert.deepEqual(computeStreaks([], "2026-11-04"), { current: 0, best: 0 });
});

test("streak counts consecutive days ending today", () => {
  const seen = ["2026-11-02", "2026-11-03", "2026-11-04"];
  assert.deepEqual(computeStreaks(seen, "2026-11-04"), { current: 3, best: 3 });
});

test("streak survives until today's click", () => {
  const seen = ["2026-11-02", "2026-11-03"];
  assert.deepEqual(computeStreaks(seen, "2026-11-04"), { current: 2, best: 2 });
});

test("a missed day ends the streak but keeps the best", () => {
  const seen = ["2026-11-01", "2026-11-02"];
  assert.deepEqual(computeStreaks(seen, "2026-11-04"), { current: 0, best: 2 });
});

test("a gap restarts the count", () => {
  const seen = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-03", "2026-11-04"];
  assert.deepEqual(computeStreaks(seen, "2026-11-04"), { current: 2, best: 3 });
});

test("streak crosses month and year ends", () => {
  const seen = ["2026-12-31", "2027-01-01"];
  assert.deepEqual(computeStreaks(seen, "2027-01-01"), { current: 2, best: 2 });
});

test("streak crosses the daylight saving change", () => {
  const seen = ["2026-10-31", "2026-11-01", "2026-11-02"];
  assert.deepEqual(computeStreaks(seen, "2026-11-02"), { current: 3, best: 3 });
});

test("today rolls over at midnight in New York, not UTC", () => {
  assert.equal(todayIn(undefined, new Date("2026-11-05T03:00:00Z")), "2026-11-04");
  assert.equal(todayIn(undefined, new Date("2026-11-05T05:30:00Z")), "2026-11-05");
});

test("addDays and isDate", () => {
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(isDate("2026-11-04"), true);
  assert.equal(isDate("2026-02-30"), false);
  assert.equal(isDate("today"), false);
});
