# Clock Dock

An always-on desk display for an old tablet: **clock, weather, prayer times with
adhan, a family calendar, and a daily hadith** — all editable from any phone on
the same Wi‑Fi. Self-hosted, no cloud, no build step, one small Node server.

```
node server/server.js   →   http://localhost:8080/        (the display / kiosk)
                            http://<lan-ip>:8080/settings  (edit from your phone)
```

## Features

- **Clock** (12/24h) with Gregorian + Hijri date (Hijri offset for local sighting).
- **Prayer times, fully offline** (adhan library) — method, madhab, per-prayer ±min
  adjustment, iqamah offsets, Jumu'ah handling, Qibla direction.
- **Adhan audio** auto-plays at each waqt (separate Fajr), per-prayer toggles,
  volume, quiet hours, optional iqamah chime. Drop MP3s in `public/audio/`.
- **Weather** (OpenWeatherMap) proxied + cached so a network blip won't blank it.
  Needs a free API key — see Quick start.
- **Family calendar** — members, events, yearly repeats, week strip + agenda.
- **Daily hadith** (Bangla + cited source) from `data/hadith.json`.
- **Ramadan mode** (Suhoor/Iftar countdown) + special-day banners (Eid, Ashura…).
- **Animated sky background** that tracks the weather + time of day — sun/moon
  arcing overhead, stars, drifting clouds, rain, snow, and storm lightning
  (canvas; respects reduced-motion and pauses when hidden).
- **4 themes** (Midnight/Daylight/Focus/Warm), font scaling, dimming + auto
  night-dim, keep-awake, instant sync (SSE), backup/restore, on-screen LAN URL.

## Quick start

Weather needs a free [OpenWeatherMap](https://openweathermap.org/api) API key
(sign-up, no credit card, 1,000,000 calls/month) set as `OPENWEATHER_API_KEY`:

```
export OPENWEATHER_API_KEY=your-key-here
npm install
npm start
```

Open the two URLs it prints. To run it on the tablet at boot and keep the screen
on, see `scripts/WINDOWS-SETUP.md`.

On Render (or any host), set `OPENWEATHER_API_KEY` in the service's environment
variables — without it the weather card falls back to "unavailable".

### Persisting settings across Render redeploys

Render's web service filesystem is **ephemeral** — every redeploy starts from a
clean container, so `data/config.json` (your saved settings) would otherwise
reset to defaults each time. Persistent disks fix that but require a paid
plan, so on the free plan Clock Dock instead stores the config in a free
[Upstash Redis](https://upstash.com) database (no card, no expiry, generous
free tier) when configured:

1. Create a free database at upstash.com → open its **REST API** tab.
2. In your Render service's environment variables, set:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Redeploy. Settings now persist through every future redeploy.

Without those two env vars set, Clock Dock just uses the local `data/config.json`
file, which is all local/self-hosted (non-Render) use needs.

## Layout

```
server/   config.js · prayer.js · weather.js · server.js
public/   display.html · settings.html · css/ · js/ · audio/
data/     config.json (auto) · hadith.json (+ how-to README)
scripts/  start.bat · WINDOWS-SETUP.md
```

## Before you rely on the hadith

The shipped `data/hadith.json` is a **small starter set marked `verified: false`**.
Read `data/hadith-README.md` and verify/expand to your 100 (with scholar review)
before daily use — the references are real, the Bangla wording needs checking.
