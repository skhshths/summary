"use strict";

const FORECAST_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=40.9487&longitude=-73.7326" +
  "&timezone=America%2FNew_York&temperature_unit=fahrenheit&wind_speed_unit=mph" +
  "&precipitation_unit=inch&forecast_days=1" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max," +
  "apparent_temperature_min,wind_speed_10m_max,wind_gusts_10m_max," +
  "wind_direction_10m_dominant,precipitation_probability_max,sunrise,sunset" +
  "&hourly=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m," +
  "wind_direction_10m";

const TABLE_HOURS = [6, 9, 12, 15, 18, 21];
const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STALE_AFTER_MS = 15 * 60 * 1000;

const CONDITIONS = [
  [[0], "Clear"],
  [[1], "Mostly clear"],
  [[2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55], "Drizzle"],
  [[56, 57], "Freezing drizzle"],
  [[61], "Light rain"],
  [[63], "Rain"],
  [[65], "Heavy rain"],
  [[66, 67], "Freezing rain"],
  [[71], "Light snow"],
  [[73], "Snow"],
  [[75], "Heavy snow"],
  [[77], "Snow grains"],
  [[80, 81], "Rain showers"],
  [[82], "Heavy rain showers"],
  [[85, 86], "Snow showers"],
  [[95], "Thunderstorms"],
  [[96, 99], "Thunderstorms with hail"],
];

const $ = (id) => document.getElementById(id);

let state = null;
let selectedId = null;
let month = null; // { year, month } shown in the calendar, month is 0-based
let loadedAt = 0;
let needsSetup = false;
let reminderDays = [1, 2, 3, 4, 5];
let code = "";
try {
  code = localStorage.getItem("daily-code") || "";
} catch {
  // storage blocked: the code is asked for on each visit
}

// Builds an element: h("td", { className: "x" }, "text", childNode)
function h(tag, props, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

function arrowIcon(fromDegrees) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "arrow");
  svg.setAttribute("aria-hidden", "true");
  // Points the way the wind is blowing, opposite where it comes from.
  svg.style.transform = `rotate(${fromDegrees + 180}deg)`;
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M8 14V2M8 2 3.5 6.5M8 2l4.5 4.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

const compass = (degrees) => COMPASS[Math.round(degrees / 22.5) % 16];
const round = (n) => Math.round(n);
const condition = (weatherCode) =>
  CONDITIONS.find(([codes]) => codes.includes(weatherCode))?.[1] ?? "Mixed";

function formatHour(hour, minute = 0) {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 || 12;
  return minute ? `${h12}:${String(minute).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

// Open-Meteo gives local times like "2026-11-04T16:52".
function formatClock(iso) {
  const [hour, minute] = iso.slice(11, 16).split(":").map(Number);
  return formatHour(hour, minute);
}

function parseDate(date) {
  return new Date(`${date}T12:00:00Z`);
}

function dateKey(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

/* Weather */

function fact(label, value, detail, icon) {
  const dd = h("dd", {});
  if (icon) dd.append(icon);
  dd.append(value);
  if (detail) dd.append(h("small", {}, detail));
  return h("div", {}, h("dt", {}, label), dd);
}

function renderWeather(forecast) {
  const d = forecast.daily;
  const direction = d.wind_direction_10m_dominant[0];
  const rain = d.precipitation_probability_max[0];

  const temps = h(
    "div",
    { className: "temps" },
    h("div", { className: "temp" }, h("b", {}, `${round(d.temperature_2m_max[0])}°`), h("span", {}, "high")),
    h("div", { className: "temp low" }, h("b", {}, `${round(d.temperature_2m_min[0])}°`), h("span", {}, "low")),
  );

  const facts = h(
    "dl",
    { className: "facts" },
    fact(
      "Wind",
      `${compass(direction)} ${round(d.wind_speed_10m_max[0])} mph`,
      `gusts to ${round(d.wind_gusts_10m_max[0])} mph`,
      arrowIcon(direction),
    ),
    fact("Rain or snow", rain == null ? "–" : `${rain}%`, "chance today"),
    fact("Daylight", formatClock(d.sunrise[0]), `until ${formatClock(d.sunset[0])}`),
  );

  const rows = TABLE_HOURS.map((hour) => {
    const i = forecast.hourly.time.findIndex((t) => Number(t.slice(11, 13)) === hour);
    const from = forecast.hourly.wind_direction_10m[i];
    return h(
      "tr",
      {},
      h("td", {}, formatHour(hour)),
      h("td", {}, `${round(forecast.hourly.temperature_2m[i])}°`),
      h("td", { className: "feels" }, `${round(forecast.hourly.apparent_temperature[i])}°`),
      h("td", {}, `${round(forecast.hourly.wind_speed_10m[i])} mph`),
      h("td", {}, `${round(forecast.hourly.wind_gusts_10m[i])} mph`),
      h("td", {}, arrowIcon(from), compass(from)),
    );
  });

  const table = h(
    "table",
    {},
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        ...["Time", "Temp", "Feels", "Wind", "Gusts", "From"].map((t) => h("th", { scope: "col" }, t)),
      ),
    ),
    h("tbody", {}, ...rows),
  );

  $("weather").replaceChildren(
    h("p", { className: "condition" }, condition(d.weather_code[0])),
    temps,
    h(
      "p",
      { className: "note" },
      `Feels like ${round(d.apparent_temperature_min[0])}° to ${round(d.apparent_temperature_max[0])}°`,
    ),
    facts,
    table,
  );
}

async function loadWeather() {
  try {
    const res = await fetch(FORECAST_URL);
    if (!res.ok) throw new Error(`Forecast returned ${res.status}`);
    renderWeather(await res.json());
  } catch (err) {
    console.error(err);
    const retry = h("button", { className: "link-button", type: "button" }, "Try again");
    retry.addEventListener("click", loadWeather);
    $("weather").replaceChildren(h("p", { className: "note" }, "Couldn't load the forecast. "), retry);
  }
}

/* Server state */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(code ? { "x-code": code } : {}),
    },
  });
  const body = await res.json();
  if (res.status === 401) {
    showCodeForm(body.setup);
    throw Object.assign(new Error("Code required"), { needsCode: true });
  }
  if (!res.ok) throw new Error(body.error || "Request failed");
  return body;
}

function showCodeForm(setup) {
  needsSetup = setup;
  $("personal").hidden = true;
  $("code-form").hidden = false;
  $("code-label").textContent = setup
    ? "Create a passcode to keep your schedule and reminders private"
    : "Enter your passcode";
  $("code-submit").textContent = setup ? "Create" : "Unlock";
  $("code-note").textContent = setup ? "At least 6 characters. Each device asks for it once." : "";
  $("code").minLength = setup ? 6 : 0;
  $("code").autocomplete = setup ? "new-password" : "current-password";
}

// Runs a change on the server; the response is the new state.
async function change(path, options) {
  try {
    applyState(await api(path, options));
    showError("");
  } catch (err) {
    if (err.needsCode) showError("Your passcode is needed again.");
    else showError(`Couldn't save that: ${err.message}`);
    if (state) render();
  }
}

function applyState(next) {
  state = next;
  $("code-form").hidden = true;
  $("personal").hidden = false;
  if (!state.activities.some((a) => a.id === selectedId)) {
    selectedId = state.activities[0]?.id ?? null;
  }
  if (!month) {
    const today = parseDate(state.today);
    month = { year: today.getUTCFullYear(), month: today.getUTCMonth() };
  }
  render();
}

function isOff(date, activityId) {
  return (state.off[date] || []).includes(activityId);
}

function saveActivities(activities) {
  return change("/api/activities", { method: "PUT", body: JSON.stringify({ activities }) });
}

function toggleOff(date, activityId) {
  return change("/api/off", {
    method: "POST",
    body: JSON.stringify({ date, activity: activityId, off: !isOff(date, activityId) }),
  });
}

/* Rendering */

function render() {
  const today = parseDate(state.today);
  $("date").textContent = today.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  document.title = `${state.seenToday ? "" : "• "}Daily`;
  renderSchedule(today.getUTCDay());
  renderTodo();
  renderStreak();
  renderReminders();
  renderDaysOff();
}

function formatTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  return formatHour(hour, minute);
}

function formatShortDate(date) {
  return parseDate(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function renderTodo() {
  const items = state.todo.map((item) => {
    const box = h("input", { type: "checkbox", checked: item.done });
    box.addEventListener("change", () =>
      change("/api/reminders/done", {
        method: "POST",
        body: JSON.stringify({ id: item.id, done: box.checked }),
      }),
    );
    const label = h("label", {}, box, h("span", { className: "todo-title" }, item.title));
    if (item.overdue) {
      label.append(h("span", { className: "todo-when overdue" }, `From ${formatShortDate(item.date)}`));
    } else if (item.time) {
      label.append(h("span", { className: "todo-when" }, formatTime(item.time)));
    }
    return h("li", { className: item.done ? "done" : "" }, label);
  });
  $("todo").replaceChildren(...items);
  $("todo-empty").hidden = items.length > 0;
}

function describeReminder(reminder) {
  const parts = [];
  if (reminder.repeat === "once") parts.push(formatShortDate(reminder.date));
  else if (reminder.repeat === "daily") parts.push("Every day");
  else parts.push(reminder.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(", "));
  if (reminder.time) parts.push(formatTime(reminder.time));
  const activity = state.activities.find((a) => a.id === reminder.activity);
  if (activity) parts.push(`when ${activity.name.toLowerCase()} is on`);
  return parts.join(" · ");
}

function renderReminders() {
  const sorted = [...state.reminders].sort((a, b) => a.title.localeCompare(b.title));
  $("reminder-list").replaceChildren(
    ...sorted.map((reminder) => {
      const remove = h("button", { className: "link-button", type: "button" }, "Delete");
      remove.setAttribute("aria-label", `Delete ${reminder.title}`);
      remove.addEventListener("click", () =>
        change("/api/reminders/delete", { method: "POST", body: JSON.stringify({ id: reminder.id }) }),
      );
      return h(
        "li",
        {},
        h("span", { className: "text" }, reminder.title, h("small", {}, describeReminder(reminder))),
        remove,
      );
    }),
  );
  $("reminder-list-empty").hidden = sorted.length > 0;

  const select = $("reminder-activity");
  const previous = select.value;
  select.replaceChildren(
    h("option", { value: "" }, "Any day"),
    ...state.activities.map((a) => h("option", { value: a.id }, a.name)),
  );
  select.value = state.activities.some((a) => a.id === previous) ? previous : "";
  if (!$("reminder-date").value) $("reminder-date").value = state.today;
  renderReminderForm();
}

function renderReminderForm() {
  const repeat = $("reminder-repeat").value;
  $("reminder-date-field").hidden = repeat !== "once";
  $("reminder-days-field").hidden = repeat !== "weekly";
  $("reminder-activity-field").hidden = repeat === "once";
  $("reminder-days").replaceChildren(
    ...DAY_LETTERS.map((letter, day) => {
      const button = h("button", { type: "button" }, letter);
      button.setAttribute("aria-label", DAY_NAMES[day]);
      button.setAttribute("aria-pressed", String(reminderDays.includes(day)));
      button.addEventListener("click", () => {
        reminderDays = reminderDays.includes(day)
          ? reminderDays.filter((d) => d !== day)
          : [...reminderDays, day];
        renderReminderForm();
      });
      return button;
    }),
  );
}

/* Notifications */

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyToBytes(key) {
  const binary = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function pushRegistration() {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

async function renderPush() {
  const toggle = $("push-toggle");
  const test = $("push-test");
  if (!pushSupported()) {
    $("push-status").textContent =
      "This browser can't show notifications from here. On an iPhone, use Share, then Add to Home Screen, and open it from there.";
    toggle.hidden = true;
    test.hidden = true;
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  const blocked = Notification.permission === "denied";
  toggle.hidden = false;
  toggle.disabled = blocked;
  toggle.textContent = subscription ? "Turn off" : "Turn on notifications";
  test.hidden = !subscription;
  $("push-status").textContent = blocked
    ? "Notifications are blocked. Allow them for this site in your browser's settings."
    : subscription
      ? "On. Reminders can arrive up to 5 minutes after their time."
      : "Off. Reminders only show on this page until you turn these on.";
}

async function togglePush() {
  const toggle = $("push-toggle");
  toggle.disabled = true;
  try {
    const registration = await pushRegistration();
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await api("/api/push/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint: existing.endpoint }),
      });
      await existing.unsubscribe();
    } else {
      if ((await Notification.requestPermission()) === "granted") {
        const { key } = await api("/api/push/key");
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(key),
        });
        await api("/api/push/subscribe", {
          method: "POST",
          body: JSON.stringify(subscription.toJSON()),
        });
      }
    }
    showError("");
  } catch (err) {
    console.error(err);
    showError(`Couldn't change notifications: ${err.message}`);
  }
  await renderPush();
}

async function testPush() {
  try {
    const { sent, devices } = await api("/api/push/test", { method: "POST" });
    showError(sent > 0 ? "" : `The test didn't send (0 of ${devices} devices). Try turning notifications off and on.`);
  } catch (err) {
    showError(`The test didn't send: ${err.message}`);
  }
}

function renderSchedule(weekday) {
  const items = state.activities.map((activity) => {
    const scheduled = activity.days.includes(weekday);
    const off = isOff(state.today, activity.id);
    const status = h(
      "span",
      { className: `status${scheduled && !off ? " on" : ""}` },
      !scheduled ? "Not on " + DAY_NAMES[weekday] + "s" : off ? `No ${activity.name.toLowerCase()} today` : "On",
    );
    const left = h("span", {}, activity.name);
    const li = h("li", {}, left);
    if (scheduled) {
      const toggle = h(
        "button",
        { className: "link-button", type: "button" },
        off ? "Undo" : "Mark off",
      );
      toggle.setAttribute("aria-label", `${off ? "Undo" : "Mark off"} ${activity.name} today`);
      toggle.addEventListener("click", () => toggleOff(state.today, activity.id));
      li.append(h("span", { className: "schedule-right" }, status, toggle));
    } else {
      li.append(status);
    }
    return li;
  });
  $("schedule").replaceChildren(...items);
}

function renderStreak() {
  $("streak-count").textContent = state.current;
  let note;
  if (state.seenToday) note = `Back tomorrow. Best: ${state.best}`;
  else if (state.current > 0) note = `Tap Seen to keep it going. Best: ${state.best}`;
  else if (state.best > 0) note = `Tap Seen to start again. Best: ${state.best}`;
  else note = "Tap Seen to start your streak";
  $("streak-note").textContent = note;

  const button = $("seen");
  button.disabled = state.seenToday;
  button.textContent = state.seenToday ? "Seen ✓" : "Seen";
}

function renderDaysOff() {
  const selected = state.activities.find((a) => a.id === selectedId);

  $("activity-tabs").replaceChildren(
    ...state.activities.map((activity) => {
      const button = h("button", { type: "button" }, `No ${activity.name.toLowerCase()}`);
      button.setAttribute("aria-pressed", String(activity.id === selectedId));
      button.addEventListener("click", () => {
        selectedId = activity.id;
        renderDaysOff();
      });
      return button;
    }),
  );

  const hasSelection = Boolean(selected);
  for (const id of ["weekdays-label", "weekdays", "remove-activity", "calendar-hint"]) {
    $(id).hidden = !hasSelection;
  }
  renderCalendar(selected);
  if (!selected) return;

  const lower = selected.name.toLowerCase();
  $("calendar-hint").textContent = `Tap a day to mark it as no ${lower}. Tap again to undo.`;
  $("weekdays-label").textContent = `${selected.name} normally happens on`;
  $("remove-activity").textContent = `Stop tracking ${lower}`;
  $("weekdays").replaceChildren(
    ...DAY_LETTERS.map((letter, day) => {
      const button = h("button", { type: "button" }, letter);
      button.setAttribute("aria-label", DAY_NAMES[day]);
      button.setAttribute("aria-pressed", String(selected.days.includes(day)));
      button.addEventListener("click", () => {
        const days = selected.days.includes(day)
          ? selected.days.filter((d) => d !== day)
          : [...selected.days, day];
        saveActivities(state.activities.map((a) => (a.id === selected.id ? { ...a, days } : a)));
      });
      return button;
    }),
  );
}

function renderCalendar(selected) {
  const first = new Date(Date.UTC(month.year, month.month, 1));
  $("month-label").textContent = first.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const cells = DAY_LETTERS.map((letter) => h("div", { className: "head" }, letter));
  for (let i = 0; i < first.getUTCDay(); i++) cells.push(h("div", {}));

  const dayCount = new Date(Date.UTC(month.year, month.month + 1, 0)).getUTCDate();
  for (let day = 1; day <= dayCount; day++) {
    const date = dateKey(month.year, month.month, day);
    const weekday = new Date(Date.UTC(month.year, month.month, day)).getUTCDay();
    const button = h("button", { type: "button" }, String(day));
    button.disabled = !selected || !selected.days.includes(weekday);
    button.setAttribute("aria-pressed", String(Boolean(selected) && !button.disabled && isOff(date, selected.id)));
    button.setAttribute("aria-label", parseDate(date).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
    }));
    if (date === state.today) button.classList.add("is-today");
    if (selected) button.addEventListener("click", () => toggleOff(date, selected.id));
    cells.push(button);
  }
  $("calendar").replaceChildren(...cells);
}

function moveMonth(delta) {
  const next = new Date(Date.UTC(month.year, month.month + delta, 1));
  month = { year: next.getUTCFullYear(), month: next.getUTCMonth() };
  if (state) renderDaysOff();
}

/* Events */

$("seen").addEventListener("click", async () => {
  $("seen").disabled = true;
  await change("/api/seen", { method: "POST" });
  if (state) renderStreak();
});

$("prev-month").addEventListener("click", () => moveMonth(-1));
$("next-month").addEventListener("click", () => moveMonth(1));

$("remove-activity").addEventListener("click", () => {
  const selected = state.activities.find((a) => a.id === selectedId);
  if (!selected) return;
  if (!confirm(`Stop tracking ${selected.name}? Its days off will be removed.`)) return;
  saveActivities(state.activities.filter((a) => a.id !== selectedId));
});

$("add-activity").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("activity-name").value.trim();
  if (!name) return;
  const before = new Set(state.activities.map((a) => a.id));
  await saveActivities([...state.activities, { name, days: [1, 2, 3, 4, 5] }]);
  const added = state.activities.find((a) => !before.has(a.id));
  if (added) {
    selectedId = added.id;
    $("activity-name").value = "";
    renderDaysOff();
  }
});

$("code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  code = $("code").value;
  try {
    localStorage.setItem("daily-code", code);
  } catch {
    // storage blocked: the code lasts until the page closes
  }
  if (needsSetup) {
    const res = await fetch("/api/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      showError("Couldn't save that passcode. Reload and try again.");
      return;
    }
  }
  $("code").value = "";
  await loadState();
});

$("reminder-repeat").addEventListener("change", renderReminderForm);
$("push-toggle").addEventListener("click", togglePush);
$("push-test").addEventListener("click", testPush);

$("reminder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const repeat = $("reminder-repeat").value;
  if (repeat === "weekly" && reminderDays.length === 0) {
    showError("Pick at least one day for that reminder.");
    return;
  }
  const before = state.reminders.length;
  await change("/api/reminders", {
    method: "POST",
    body: JSON.stringify({
      title: $("reminder-title").value,
      repeat,
      date: $("reminder-date").value,
      days: reminderDays,
      time: $("reminder-time").value,
      activity: $("reminder-activity").value,
    }),
  });
  if (state.reminders.length > before) {
    $("reminder-title").value = "";
    $("reminder-time").value = "";
  }
});

async function loadState() {
  try {
    applyState(await api("/api/state"));
    showError("");
    await renderPush();
  } catch (err) {
    if (err.needsCode) {
      showError(code && !needsSetup ? "That passcode didn't work." : "");
    } else {
      console.error(err);
      showError("Couldn't load your schedule and streak. Check your connection and reload.");
    }
  }
}

function load() {
  loadedAt = Date.now();
  // The locked page has no server state, so the heading doesn't wait for it.
  $("date").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
  return Promise.all([loadWeather(), loadState()]);
}

// A tab left open overnight catches up when you come back to it.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - loadedAt > STALE_AFTER_MS) load();
});

load();
