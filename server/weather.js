// weather.js — Open-Meteo current + today's forecast, cached to disk so a brief
// internet drop shows last-good data (with a stale flag) instead of a blank card.
// Always stored in Celsius; the display converts to °F if configured.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './config.js';

const CACHE_PATH = join(ROOT, 'data', 'weather-cache.json');
const FRESH_MS = 10 * 60 * 1000; // consider a fetch fresh for 10 minutes
const FORECAST_DAYS = 7;         // how many days the "next 7 days" strip shows

let mem = null;

export async function getWeather(cfg) {
  if (!mem) mem = await readCache();

  const key = `${cfg.location.lat.toFixed(3)},${cfg.location.lon.toFixed(3)}`;
  const fresh = mem && mem.key === key && Date.now() - mem.fetchedAt < FRESH_MS;
  if (fresh) return { ...mem.data, stale: false };

  try {
    const { lat, lon } = cfg.location;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset` +
      `&timezone=auto&forecast_days=${FORECAST_DAYS}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`weather ${r.status}`);
    const j = await r.json();

    const d = j.daily || {};
    const daily = (d.time || []).map((date, i) => ({
      date,                              // "2026-07-20"
      code: d.weather_code?.[i],
      maxC: d.temperature_2m_max?.[i],
      minC: d.temperature_2m_min?.[i]
    }));
    const data = {
      tempC: j.current.temperature_2m,
      feelsC: j.current.apparent_temperature,
      humidity: j.current.relative_humidity_2m,
      code: j.current.weather_code,
      isDay: j.current.is_day === 1,
      highC: d.temperature_2m_max?.[0],
      lowC: d.temperature_2m_min?.[0],
      sunrise: d.sunrise?.[0],
      sunset: d.sunset?.[0],
      daily,                             // next 7 days for the forecast strip
      place: cfg.location.name
    };
    mem = { key, fetchedAt: Date.now(), data };
    writeCache(mem).catch(() => {});
    return { ...data, stale: false };
  } catch {
    if (mem?.data) return { ...mem.data, stale: true };
    return { unavailable: true };
  }
}

async function readCache() {
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); }
  catch { return null; }
}
async function writeCache(obj) {
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(obj), 'utf8');
}
