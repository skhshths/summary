import { DurableObject } from "cloudflare:workers";
import { computeStreaks, isDate, TIME_ZONE, todayIn } from "./dates.js";
import { generateVapidKeys, isPushEndpoint, sendPush, toBase64Url } from "./push.js";
import { isDue, todoFor } from "./reminders.js";

const WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_ACTIVITIES = [
  { id: "school", name: "School", days: WEEKDAYS },
  { id: "practice", name: "Practice", days: WEEKDAYS },
];
const MAX_ACTIVITIES = 12;
const MAX_NAME_LENGTH = 30;
const MAX_REMINDERS = 100;
const MAX_REMINDER_LENGTH = 120;
const MAX_SUBSCRIPTIONS = 10;
const MIN_CODE_LENGTH = 6;
const DEFAULT_REMINDER_TIME = "07:00"; // when reminders with no time notify
const VAPID_SUBJECT = "https://daily.oliverbar.net";

// Client mistakes start with "Invalid" so the Worker can return them as 400s;
// custom error classes don't survive the trip out of a Durable Object.
function invalid(what) {
  return new Error(`Invalid ${what}`);
}

function slug(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "activity"
  );
}

function cleanDays(days) {
  if (!Array.isArray(days)) throw invalid("days");
  return [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
}

function currentTime(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

async function hashCode(code, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${code}`);
  return toBase64Url(await crypto.subtle.digest("SHA-256", bytes));
}

// Holds the one person's streak, schedule and reminders.
export class DailyStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS seen (date TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS off (
        date TEXT NOT NULL,
        activity TEXT NOT NULL,
        PRIMARY KEY (date, activity)
      );
      CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reminder (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repeat TEXT NOT NULL,
        date TEXT NOT NULL,
        days TEXT NOT NULL,
        time TEXT,
        activity TEXT
      );
      CREATE TABLE IF NOT EXISTS reminder_done (
        reminder TEXT NOT NULL,
        date TEXT NOT NULL,
        PRIMARY KEY (reminder, date)
      );
      CREATE TABLE IF NOT EXISTS reminder_sent (
        reminder TEXT NOT NULL,
        date TEXT NOT NULL,
        PRIMARY KEY (reminder, date)
      );
      CREATE TABLE IF NOT EXISTS subscription (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL
      );
    `);
  }

  getSetting(key) {
    const row = this.sql.exec("SELECT value FROM setting WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  setSetting(key, value) {
    this.sql.exec(
      "INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)",
      key,
      JSON.stringify(value),
    );
  }

  /* Passcode */

  async checkCode(code) {
    const saved = this.getSetting("code");
    if (!saved) return { ok: false, setup: true };
    return { ok: (await hashCode(code, saved.salt)) === saved.hash, setup: false };
  }

  // Only reachable while no code exists; later calls can't replace it.
  async createCode(code) {
    if (this.getSetting("code")) throw invalid("request: a code is already set");
    if (typeof code !== "string" || code.length < MIN_CODE_LENGTH) throw invalid("code");
    const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    this.setSetting("code", { salt, hash: await hashCode(code, salt) });
    return this.getState();
  }

  /* State */

  activities() {
    return this.getSetting("activities") ?? DEFAULT_ACTIVITIES;
  }

  offDays() {
    const off = {};
    for (const { date, activity } of this.sql.exec("SELECT date, activity FROM off")) {
      (off[date] ||= []).push(activity);
    }
    return off;
  }

  reminders() {
    return this.sql
      .exec("SELECT * FROM reminder")
      .toArray()
      .map((row) => ({ ...row, days: JSON.parse(row.days) }));
  }

  doneDates() {
    const done = {};
    for (const { reminder, date } of this.sql.exec("SELECT reminder, date FROM reminder_done")) {
      (done[reminder] ||= []).push(date);
    }
    return done;
  }

  getState() {
    const today = todayIn();
    const seen = this.sql
      .exec("SELECT date FROM seen ORDER BY date")
      .toArray()
      .map((row) => row.date);
    const activities = this.activities();
    const off = this.offDays();
    const reminders = this.reminders();
    const done = this.doneDates();
    return {
      today,
      seenToday: seen.at(-1) === today,
      ...computeStreaks(seen, today),
      activities,
      off,
      todo: todoFor(today, reminders, done, activities, off),
      // finished one-day reminders drop off; repeats and open ones stay listed
      reminders: reminders.filter((r) => r.repeat !== "once" || !done[r.id]),
    };
  }

  /* Streak and schedule */

  markSeen() {
    this.sql.exec("INSERT OR IGNORE INTO seen (date) VALUES (?)", todayIn());
    return this.getState();
  }

  setOff({ date, activity, off }) {
    if (!isDate(date)) throw invalid("date");
    if (!this.activities().some((a) => a.id === activity)) throw invalid("activity");
    if (off) {
      this.sql.exec("INSERT OR IGNORE INTO off (date, activity) VALUES (?, ?)", date, activity);
    } else {
      this.sql.exec("DELETE FROM off WHERE date = ? AND activity = ?", date, activity);
    }
    return this.getState();
  }

  setActivities(list) {
    if (!Array.isArray(list) || list.length > MAX_ACTIVITIES) throw invalid("activities");
    const known = new Set(this.activities().map((a) => a.id));
    const used = new Set();
    const clean = list.map((item) => {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name || name.length > MAX_NAME_LENGTH) throw invalid("name");
      const days = cleanDays(item.days);
      let id = known.has(item.id) && !used.has(item.id) ? item.id : slug(name);
      if (id !== item.id) {
        const base = id;
        for (let n = 2; known.has(id) || used.has(id); n++) id = `${base}-${n}`;
      }
      used.add(id);
      return { id, name, days };
    });
    this.setSetting("activities", clean);
    // days off belonging to a removed activity go with it
    for (const id of known) {
      if (!used.has(id)) this.sql.exec("DELETE FROM off WHERE activity = ?", id);
    }
    return this.getState();
  }

  /* Reminders */

  addReminder(input) {
    const title = typeof input?.title === "string" ? input.title.trim() : "";
    if (!title || title.length > MAX_REMINDER_LENGTH) throw invalid("reminder");
    if (!["once", "daily", "weekly"].includes(input.repeat)) throw invalid("repeat");
    if (this.reminders().length >= MAX_REMINDERS) throw invalid("reminder: too many");

    const today = todayIn();
    const once = input.repeat === "once";
    if (once && !isDate(input.date)) throw invalid("date");
    const days = input.repeat === "weekly" ? cleanDays(input.days) : [];
    if (input.repeat === "weekly" && days.length === 0) throw invalid("days");
    const time = input.time || null;
    if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw invalid("time");
    const activity = !once && input.activity ? input.activity : null;
    if (activity && !this.activities().some((a) => a.id === activity)) throw invalid("activity");

    const id = crypto.randomUUID();
    const date = once ? input.date : today;
    this.sql.exec(
      "INSERT INTO reminder (id, title, repeat, date, days, time, activity) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      title,
      input.repeat,
      date,
      JSON.stringify(days),
      time,
      activity,
    );
    // Adding one after its time has passed shouldn't ping you right away.
    if ((time ?? DEFAULT_REMINDER_TIME) <= currentTime()) {
      this.sql.exec("INSERT INTO reminder_sent (reminder, date) VALUES (?, ?)", id, today);
    }
    return this.getState();
  }

  deleteReminder(id) {
    this.sql.exec("DELETE FROM reminder WHERE id = ?", id);
    this.sql.exec("DELETE FROM reminder_done WHERE reminder = ?", id);
    this.sql.exec("DELETE FROM reminder_sent WHERE reminder = ?", id);
    return this.getState();
  }

  setReminderDone({ id, done }) {
    const reminder = this.reminders().find((r) => r.id === id);
    if (!reminder) throw invalid("reminder");
    const today = todayIn();
    if (done) {
      this.sql.exec("INSERT OR IGNORE INTO reminder_done (reminder, date) VALUES (?, ?)", id, today);
    } else {
      this.sql.exec("DELETE FROM reminder_done WHERE reminder = ? AND date = ?", id, today);
    }
    return this.getState();
  }

  /* Notifications */

  async vapidKeys() {
    let keys = this.getSetting("vapid");
    if (!keys) {
      keys = await generateVapidKeys();
      this.setSetting("vapid", keys);
    }
    return keys;
  }

  async pushKey() {
    return { key: (await this.vapidKeys()).publicKey };
  }

  subscribe(input) {
    const { endpoint, keys } = input ?? {};
    if (!isPushEndpoint(endpoint)) throw invalid("push endpoint");
    if (typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") throw invalid("push keys");
    this.sql.exec("DELETE FROM subscription WHERE endpoint = ?", endpoint);
    const count = this.sql.exec("SELECT COUNT(*) AS n FROM subscription").one().n;
    if (count >= MAX_SUBSCRIPTIONS) throw invalid("request: too many devices");
    this.sql.exec(
      "INSERT INTO subscription (endpoint, p256dh, auth) VALUES (?, ?, ?)",
      endpoint,
      keys.p256dh,
      keys.auth,
    );
    return { ok: true };
  }

  unsubscribe(endpoint) {
    this.sql.exec("DELETE FROM subscription WHERE endpoint = ?", endpoint);
    return { ok: true };
  }

  // Sends to every device, forgetting ones the push service says are gone.
  async notifyAll(message) {
    const keys = await this.vapidKeys();
    const subscriptions = this.sql.exec("SELECT * FROM subscription").toArray();
    let sent = 0;
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          const status = await sendPush(subscription, message, keys, VAPID_SUBJECT);
          if (status >= 200 && status < 300) sent++;
          else if (status === 404 || status === 410) this.unsubscribe(subscription.endpoint);
          else console.error("push rejected", status);
        } catch (err) {
          console.error("push failed", err);
        }
      }),
    );
    return { sent, devices: subscriptions.length };
  }

  sendTest() {
    return this.notifyAll({ title: "Daily", body: "Notifications are working." });
  }

  // Runs on the cron schedule.
  async sendDue() {
    const today = todayIn();
    const now = currentTime();
    const activities = this.activities();
    const off = this.offDays();
    const done = this.doneDates();
    const sent = new Set(
      this.sql
        .exec("SELECT reminder FROM reminder_sent WHERE date = ?", today)
        .toArray()
        .map((row) => row.reminder),
    );
    for (const reminder of this.reminders()) {
      if (sent.has(reminder.id)) continue;
      if ((done[reminder.id] || []).includes(today)) continue;
      if ((reminder.time ?? DEFAULT_REMINDER_TIME) > now) continue;
      if (!isDue(reminder, today, activities, off)) continue;
      // Marked first so a slow or failed push can't repeat every 5 minutes.
      this.sql.exec("INSERT INTO reminder_sent (reminder, date) VALUES (?, ?)", reminder.id, today);
      await this.notifyAll({ title: reminder.title, body: "Reminder from your daily summary" });
    }
    this.sql.exec("DELETE FROM reminder_sent WHERE date < ?", today);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw invalid("JSON");
  }
}

async function route(request, store) {
  const { pathname } = new URL(request.url);
  const key = `${request.method} ${pathname}`;
  switch (key) {
    case "GET /api/state":
      return store.getState();
    case "POST /api/seen":
      return store.markSeen();
    case "GET /api/push/key":
      return store.pushKey();
    case "POST /api/push/test":
      return store.sendTest();
  }

  const handlers = {
    "POST /api/off": (b) =>
      store.setOff({ date: b?.date, activity: b?.activity, off: b?.off === true }),
    "PUT /api/activities": (b) => store.setActivities(b?.activities),
    "POST /api/reminders": (b) => store.addReminder(b),
    "POST /api/reminders/delete": (b) => store.deleteReminder(String(b?.id)),
    "POST /api/reminders/done": (b) =>
      store.setReminderDone({ id: b?.id, done: b?.done === true }),
    "POST /api/push/subscribe": (b) => store.subscribe(b),
    "POST /api/push/unsubscribe": (b) => store.unsubscribe(String(b?.endpoint)),
  };
  return handlers[key] ? handlers[key](await readJson(request)) : null;
}

export default {
  async fetch(request, env) {
    const store = env.STORE.get(env.STORE.idFromName("me"));
    try {
      const code = request.headers.get("x-code") ?? "";
      const auth = await store.checkCode(code);
      const isSetup = auth.setup && new URL(request.url).pathname === "/api/code";
      if (isSetup && request.method === "POST") {
        const body = await readJson(request);
        return json(await store.createCode(body?.code));
      }
      // RECOVERY_CODE is an optional Worker secret for a forgotten passcode.
      const recovered = Boolean(env.RECOVERY_CODE) && code === env.RECOVERY_CODE;
      if (!auth.ok && !recovered) {
        return json({ error: "Code required", setup: auth.setup }, 401);
      }
      const result = await route(request, store);
      return result ? json(result) : json({ error: "Not found" }, 404);
    } catch (err) {
      const message = String(err?.message || "");
      if (message.startsWith("Invalid ")) return json({ error: message }, 400);
      console.error(err);
      return json({ error: "Server error" }, 500);
    }
  },

  async scheduled(_event, env) {
    await env.STORE.get(env.STORE.idFromName("me")).sendDue();
  },
};
