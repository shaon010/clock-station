// hijri.js — the Hijri date, refreshed once a day from the server side (so it
// keeps advancing even with every display powered off), with a fallback chain:
//   1. api.waktusolat.app  (Malaysia JAKIM zone data, community API)
//   2. e-solat.gov.my      (JAKIM's own official API)
//   3. ICU's islamic-umalqura calendar, built into Node — always available,
//      no network, used if both live sources are down.
// Both live sources report Malaysia's officially-announced (moon-sighted)
// date, so a fixed zone is used regardless of the app's configured location —
// this is a single shared Hijri source of truth, not a location lookup.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const CACHE_PATH = join(DATA_DIR, 'hijri-cache.json');
const ZONE = 'WLY01';               // Kuala Lumpur — fixed Hijri source, unrelated to the app's own location
const FETCH_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 1000;
const REFRESH_HOUR = 21, REFRESH_MINUTE = 45, REFRESH_TZ = 'Asia/Tokyo'; // 9:45 PM JST daily
const OUTAGE_RETRY_MS = 15 * 60 * 1000;                 // re-poll cadence while both live sources are down
const OUTAGE_CUTOFF_HOUR = 23, OUTAGE_CUTOFF_MINUTE = 45; // stop retrying for the day at 11:45 PM JST
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; ClockDock/1.0; +family desk display)' };

// Same month names Node's Intl islamic-umalqura calendar produces, so the
// front end's month-name matching (Ramadan/Shawwal/etc.) works regardless of
// which source supplied today's date.
const HIJRI_MONTHS = [
  'Muharram', 'Safar', 'Rabiʻ I', 'Rabiʻ II', 'Jumada I', 'Jumada II',
  'Rajab', 'Shaʻban', 'Ramadan', 'Shawwal', 'Dhuʻl-Qiʻdah', 'Dhuʻl-Hijjah'
];

// Hijri date via ICU, with a manual ± day offset for local moon-sighting.
export function hijriFor(date, offsetDays = 0, tz = 'UTC') {
  const shifted = new Date(date.getTime() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: tz
  }).formatToParts(shifted);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return { day: get('day'), month: get('month'), year: get('year') };
}

// "1448-02-08" -> {day, month, year}
function parseHijriString(s) {
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s || '');
  if (!m) return null;
  const [, year, month, day] = m;
  const name = HIJRI_MONTHS[Number(month) - 1];
  if (!name) return null;
  return { day: String(Number(day)), month: name, year };
}

// Both live sources publish one Hijri date per Gregorian calendar day: the
// Hijri day that STARTED at that day's Maghrib and runs to the next. So the
// Hijri day already underway *tonight* is filed under tomorrow's Gregorian
// date, not today's. The daily refresh always runs at 9:45 PM JST (~8:45 PM
// in Malaysia), which is safely after Malaysia's Maghrib year-round (it
// never falls after ~7:35 PM there), so requesting tomorrow's date is what
// actually gets today's already-started Hijri day.
function malaysiaTarget() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const y = get('year'), m = get('month'), d = get('day');
  const todayYmd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    todayYmd,
    year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate()
  };
}
function ymdOf(t) { return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One call + one retry, then give up (the caller moves on to the next source).
async function fetchJSONWithRetry(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
      return await res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function fromWaktuSolat(target) {
  const data = await fetchJSONWithRetry(
    `https://api.waktusolat.app/v2/solat/${ZONE}?year=${target.year}&month=${target.month}`);
  const hijri = parseHijriString(data.prayers?.find((p) => p.day === target.day)?.hijri);
  if (!hijri) throw new Error('no hijri entry for target date');
  return hijri;
}

async function fromJakim(target) {
  const data = await fetchJSONWithRetry(
    `https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat&period=date&date=${ymdOf(target)}&zone=${ZONE}`);
  const hijri = parseHijriString(data.prayerTime?.[0]?.hijri);
  if (!hijri) throw new Error('no hijri entry for target date');
  return hijri;
}

let mem = null;

async function readCache() {
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); } catch { return null; }
}
async function writeCache(obj) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(obj), 'utf8');
}

async function refresh() {
  const target = malaysiaTarget();
  let hijri, source;
  try {
    hijri = await fromWaktuSolat(target); source = 'waktusolat';
  } catch (err) {
    console.error('hijri: api.waktusolat.app failed:', err?.message || err);
    try {
      hijri = await fromJakim(target); source = 'jakim';
    } catch (err2) {
      console.error('hijri: e-solat.gov.my failed:', err2?.message || err2);
      const cfg = await getConfig();
      hijri = hijriFor(new Date(), cfg.prayer?.hijriOffset || 0);
      source = 'umalqura';
    }
  }
  mem = { targetYmd: ymdOf(target), hijri, source, fetchedAt: Date.now() };
  writeCache(mem).catch(() => {});
  console.log(`hijri: refreshed from ${source} -> ${hijri.day} ${hijri.month} ${hijri.year} AH`);
  return mem;
}

// Today's Hijri date, from the daily-refreshed cache. `targetYmd` is the
// Gregorian date the cached value was fetched for (tomorrow's date at fetch
// time) — it stays valid through the whole of that Gregorian day, so this
// only refreshes on demand if the cache is missing or has fallen behind
// (e.g. a missed scheduled run); otherwise it's just a memory read, no
// network call.
export async function getHijriToday() {
  if (!mem) mem = await readCache();
  const { todayYmd } = malaysiaTarget();
  const m = (mem && mem.targetYmd >= todayYmd) ? mem : await refresh();
  return { ...m.hijri, source: m.source };
}

function msUntilNextRefresh() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REFRESH_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const nowInTz = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
  const target = new Date(nowInTz);
  target.setUTCHours(REFRESH_HOUR, REFRESH_MINUTE, 0, 0);
  if (target <= nowInTz) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - nowInTz.getTime();
}

function pastOutageCutoff() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REFRESH_TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get('hour'), minute = get('minute');
  return hour > OUTAGE_CUTOFF_HOUR || (hour === OUTAGE_CUTOFF_HOUR && minute >= OUTAGE_CUTOFF_MINUTE);
}

// If both live sources were down at 9:45 PM (refresh() fell back to the
// offline umalqura calendar), keep polling every 15 min so a transient outage
// self-heals the same day, but give up at 11:45 PM JST rather than retrying
// all night — the next day's 9:45 PM run picks it back up regardless.
function scheduleOutageRetry() {
  if (pastOutageCutoff()) return;
  setTimeout(async () => {
    const r = await refresh();
    if (r.source === 'umalqura') scheduleOutageRetry();
  }, OUTAGE_RETRY_MS);
}

// Kick off the daily 9:45 PM JST refresh. Japan doesn't observe DST, so a
// plain 24h re-arm after each run never drifts.
export function scheduleHijriRefresh() {
  const run = () => {
    refresh()
      .then((r) => { if (r.source === 'umalqura') scheduleOutageRetry(); })
      .catch((err) => console.error('hijri: scheduled refresh failed', err));
    setTimeout(run, 24 * 60 * 60 * 1000);
  };
  setTimeout(run, msUntilNextRefresh());
}
