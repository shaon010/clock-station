// config.js — load/save the single source of truth (data/config.json).
// Deep-merges saved config over defaults so new fields appear after upgrades
// without wiping a user's existing settings.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  location: { name: 'Dhaka, Bangladesh', lat: 23.8103, lon: 90.4125, auto: true },
  theme: 'midnight',                       // midnight | daylight | focus | warm | nord | forest | sunset | mono | paper
  clockStyle: 'standard',                  // standard | flip | flip-white | lcd | minimal | neon | aurora (clock face look)
  units: { temp: 'c', clock: '12', showSeconds: false }, // temp: c|f   clock: 12|24
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
    const raw = await readFile(CONFIG_PATH, 'utf8');
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
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}
