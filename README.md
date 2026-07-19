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
- **Weather** (Open-Meteo) proxied + cached so a network blip won't blank it.
- **Family calendar** — members, events, yearly repeats, week strip + agenda.
- **Daily hadith** (Bangla + cited source) from `data/hadith.json`.
- **Ramadan mode** (Suhoor/Iftar countdown) + special-day banners (Eid, Ashura…).
- **Animated sky background** that tracks the weather + time of day — sun/moon
  arcing overhead, stars, drifting clouds, rain, snow, and storm lightning
  (canvas; respects reduced-motion and pauses when hidden).
- **4 themes** (Midnight/Daylight/Focus/Warm), font scaling, dimming + auto
  night-dim, keep-awake, instant sync (SSE), backup/restore, on-screen LAN URL.

## Quick start

```
npm install
npm start
```

Open the two URLs it prints. To run it on the tablet at boot and keep the screen
on, see `scripts/WINDOWS-SETUP.md`.

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
