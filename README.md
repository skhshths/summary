# Daily

**https://daily.oliverbar.net**

A one-page daily summary: Mamaroneck's weather (temperatures, wind speed, gusts
and direction), what's on today, your reminders, and a streak that grows each
day you click **Seen**.

- **Days off:** open "Days off", pick an activity and tap dates. "Etc." is
  covered by adding your own activities, and each one has its usual weekdays.
- **Reminders:** one day, every day or certain weekdays, with an optional time.
  Repeating ones can be limited to days an activity is on. One-day reminders
  stay on the list until they're checked off.
- **Notifications:** turn them on per device under "Reminders". They arrive
  within 5 minutes of the set time, or at 7 AM with no time set. On an iPhone,
  add the page to the Home Screen first.
- **Streak:** one click per day, counted in New York time. It lasts until a
  whole day is missed.

## How it runs

A Cloudflare Worker serves `public/` as static files and `worker/index.js` for
`/api/*`. Everything personal lives in one SQLite-backed Durable Object, created
on the first deploy. A cron trigger checks for due reminders every 5 minutes and
sends them with Web Push. The push keys are generated and stored automatically.
The browser gets the forecast directly from
[Open-Meteo](https://open-meteo.com/), which needs no key.

## Passcode

The first visit asks you to create a passcode, so open the site yourself right
after the first deploy. Your schedule, streak and reminders need it; the weather
doesn't.

If you forget it, add a Worker secret named `RECOVERY_CODE` (Cloudflare
dashboard: the Worker's Settings, Variables and Secrets, type Secret) and enter
that value instead.

## Development

```bash
npx wrangler dev --test-scheduled
```

```bash
node --test "worker/*.test.js"
```

```bash
npx wrangler deploy
```
