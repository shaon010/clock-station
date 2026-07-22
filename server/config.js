// config.js — load/save the single source of truth (data/config.json).
// Deep-merges saved config over defaults so new fields appear after upgrades
// without wiping a user's existing settings.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

// Render's free web service disk is ephemeral (wiped on every redeploy) and
// persistent disks require a paid plan, so config.json can't just live on
// local disk there. If Upstash Redis REST credentials are set (free tier,
// no card, no expiry — upstash.com), store/load the config through those
// instead; otherwise fall back to the local file, which is all local/self-
// hosted use needs.
// Strip accidental wrapping quotes — a common paste error when copying an
// env var written as NAME="value" straight into a dashboard's value field,
// which otherwise makes the URL/token literally include the quote chars.
function cleanEnv(v) {
  if (!v) return v;
  const trimmed = v.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) || /^'(.*)'$/.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}

const UPSTASH_URL = cleanEnv(process.env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
const REMOTE = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const CONFIG_KEY = 'clockdock:config';

async function upstash(command) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`Upstash ${command[0]} failed: ${res.status}`);
  const { result } = await res.json();
  return result;
}

export const DEFAULT_CONFIG = {
  location: { name: 'Dhaka, Bangladesh', lat: 23.8103, lon: 90.4125, auto: true },
  theme: 'midnight',                       // midnight | daylight | focus | warm | nord | forest | sunset | mono | paper
  clockStyle: 'standard',                  // standard | flip | flip-white | lcd | minimal | neon | aurora (clock face look)
  clockColor: 'default',                   // default | accent | red | green | blue | amber | white | cyan | purple | pink
                                            // (applies to flip/neon/lcd only — "default" leaves each style's own look untouched)
  clockFont: 'monoton',                    // monoton | neonderthaw | wallpoet | fasterone (neon style only)
  units: { temp: 'c', clock: '12', showSeconds: true }, // temp: c|f   clock: 12|24
  fontScale: 1,                            // global size multiplier (0.8–1.4)

  prayer: {
    method: 'Karachi',                     // adhan CalculationMethod key
    madhab: 'shafi',                       // shafi | hanafi (Asr)
    adjustments: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 }, // ± minutes
    hijriOffset: 0,                        // ± days for local moon-sighting
    jumuah: { enabled: true, time: '13:15' }
  },

  adhan: {
    enabled: true,
    perPrayer: { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true },
    muezzin: 'mishary',                    // basename of file in public/audio
    volume: 0.85,
    quietHours: { enabled: false, start: '23:00', end: '05:00' },
    iqamah: {
      chimeEnabled: false,
      offsets: { fajr: 20, dhuhr: 10, asr: 10, maghrib: 5, isha: 10 } // minutes after adhan
    }
  },

  dimming: {
    level: 0,                              // 0 (bright) – 0.8 (dark) manual overlay
    autoNight: { enabled: true, start: '23:00', end: '07:00', level: 1 } // 1 = screen goes fully black
  },

  keepAwake: true,

  members: [{ name: 'Everyone', color: '#4CA6A6' }],
  events: [],

  hadith: { show: true }
};

// Recursive merge: objects merge deep, everything else (incl. arrays) is replaced.
function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (typeof base !== 'object' || base === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

let cache = null;

export async function getConfig() {
  if (cache) return cache;
  try {
    const raw = REMOTE ? await upstash(['GET', CONFIG_KEY]) : await readFile(CONFIG_PATH, 'utf8');
    if (!raw) throw new Error('no saved config');
    cache = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    cache = structuredClone(DEFAULT_CONFIG);
    await persist();
  }
  return cache;
}

// Merge a partial patch over the current config and persist.
export async function updateConfig(patch) {
  const current = await getConfig();
  cache = deepMerge(current, patch);
  await persist();
  return cache;
}

// Replace the whole config (used by backup/restore import). Still merged over
// defaults so a partial/old backup can't drop required fields.
export async function replaceConfig(next) {
  cache = deepMerge(DEFAULT_CONFIG, next || {});
  await persist();
  return cache;
}

async function persist() {
  const json = JSON.stringify(cache, null, 2);
  if (REMOTE) {
    await upstash(['SET', CONFIG_KEY, json]);
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, json, 'utf8');
}
