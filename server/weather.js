// weather.js — OpenWeatherMap current + 5-day/3-hour forecast, cached to disk
// so a brief internet drop shows last-good data (with a stale flag) instead
// of a blank card.
// Always stored in Celsius; the display converts to °F if configured.
//
// Switched from Open-Meteo (2026-07): Open-Meteo's free tier rate-limits by
// IP address, and PaaS hosts like Render share egress IPs across many unrelated
// apps, so the daily quota kept getting exhausted by other tenants. OpenWeatherMap's
// free tier rate-limits by API key instead, which isn't affected by that.
//
// Weather condition ids are translated to Open-Meteo's WMO codes (see owmToWmo
// below) so the front end's existing WMO-code icon/scene tables didn't need to change.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './config.js';

const CACHE_PATH = join(ROOT, 'data', 'weather-cache.json');
const FRESH_MS = 10 * 60 * 1000;   // consider a fetch fresh for 10 minutes
const FORECAST_DAYS = 5;           // OpenWeatherMap's free forecast only spans ~5 days
const FETCH_TIMEOUT_MS = 15000;    // hosted PaaS egress can be much slower than local
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; ClockDock/1.0; +family desk display)' };
const BASE = 'https://api.openweathermap.org/data/2.5';

let mem = null;

export async function getWeather(cfg) {
  if (!mem) mem = await readCache();

  const key = `${cfg.location.lat.toFixed(3)},${cfg.location.lon.toFixed(3)}`;
  const fresh = mem && mem.key === key && Date.now() - mem.fetchedAt < FRESH_MS;
  if (fresh) return { ...mem.data, stale: false };

  const API_KEY = process.env.OPENWEATHER_API_KEY;
  if (!API_KEY) {
    console.error('weather fetch failed: OPENWEATHER_API_KEY is not set');
    if (mem?.data) return { ...mem.data, stale: true };
    return { unavailable: true };
  }

  try {
    const { lat, lon } = cfg.location;
    const qs = `lat=${lat}&lon=${lon}&units=metric&appid=${API_KEY}`;
    const [curRes, fcRes] = await Promise.all([
      fetch(`${BASE}/weather?${qs}`, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      fetch(`${BASE}/forecast?${qs}`, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    ]);
    if (!curRes.ok) throw new Error(`weather ${curRes.status} ${await curRes.text().catch(() => '')}`);
    if (!fcRes.ok) throw new Error(`forecast ${fcRes.status} ${await fcRes.text().catch(() => '')}`);
    const cur = await curRes.json();
    const fc = await fcRes.json();

    const daily = aggregateDaily(fc);
    const data = {
      tempC: cur.main.temp,
      feelsC: cur.main.feels_like,
      humidity: cur.main.humidity,
      code: owmToWmo(cur.weather?.[0]?.id),
      isDay: (cur.weather?.[0]?.icon || '').endsWith('d'),
      highC: daily[0]?.maxC,
      lowC: daily[0]?.minC,
      sunrise: cur.sys?.sunrise ? new Date(cur.sys.sunrise * 1000).toISOString() : undefined,
      sunset: cur.sys?.sunset ? new Date(cur.sys.sunset * 1000).toISOString() : undefined,
      daily,                             // next ~5 days for the forecast strip
      place: cfg.location.name
    };
    mem = { key, fetchedAt: Date.now(), data };
    writeCache(mem).catch(() => {});
    return { ...data, stale: false };
  } catch (err) {
    // Without this, a fetch failure on a host (rate limit, DNS, timeout) is
    // completely invisible — the API just silently returns {unavailable}.
    console.error('weather fetch failed:', err?.message || err, err?.cause ? `cause: ${err.cause}` : '');
    if (mem?.data) return { ...mem.data, stale: true };
    return { unavailable: true };
  }
}

// Buckets the 3-hour forecast entries by the location's local calendar date,
// picking the entry closest to local noon as each day's representative condition.
function aggregateDaily(fc) {
  const tzOffsetSec = fc.city?.timezone ?? 0;
  const groups = new Map();
  for (const item of fc.list || []) {
    const local = new Date((item.dt + tzOffsetSec) * 1000);
    const dateStr = local.toISOString().slice(0, 10);
    if (!groups.has(dateStr)) groups.set(dateStr, []);
    groups.get(dateStr).push({ item, hour: local.getUTCHours() });
  }
  return [...groups.entries()].slice(0, FORECAST_DAYS).map(([date, entries]) => {
    const items = entries.map((e) => e.item);
    const noon = entries.reduce((best, e) =>
      Math.abs(e.hour - 12) < Math.abs(best.hour - 12) ? e : best
    ).item;
    return {
      date,
      code: owmToWmo(noon.weather?.[0]?.id),
      maxC: Math.max(...items.map((i) => i.main.temp_max)),
      minC: Math.min(...items.map((i) => i.main.temp_min))
    };
  });
}

// OpenWeatherMap condition ids (https://openweathermap.org/weather-conditions)
// -> Open-Meteo WMO codes, restricted to the codes the front end's icon table knows.
function owmToWmo(id) {
  if (id == null) return 0;
  if (id === 800) return 0;
  if (id === 801) return 1;
  if (id === 802) return 2;
  if (id === 803 || id === 804) return 3;
  if (id >= 200 && id < 300) return id >= 210 && id < 222 ? 96 : 95;
  if (id >= 300 && id < 400) return id <= 301 ? 51 : id <= 311 ? 53 : 55;
  if (id === 500) return 61;
  if (id === 501) return 63;
  if (id === 502 || id === 503 || id === 504 || id === 511) return 65;
  if (id === 520) return 80;
  if (id === 521) return 81;
  if (id === 522 || id === 531) return 82;
  if (id === 600 || id === 620) return 71;
  if ((id >= 611 && id <= 616) || id === 601 || id === 621) return 73;
  if (id === 602 || id === 622) return 75;
  if (id >= 700 && id < 800) return 45;
  return 0;
}

async function readCache() {
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); }
  catch { return null; }
}
async function writeCache(obj) {
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(obj), 'utf8');
}
