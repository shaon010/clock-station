// prayer.js — fully offline prayer times, Hijri date, and Qibla bearing.
// Times come from the `adhan` library (no network); Hijri is the daily-
// refreshed live date from hijri.js (falling back to the ICU islamic-umalqura
// calendar when both live sources are unreachable).
import * as adhan from 'adhan';
import tzlookup from 'tz-lookup';
import { hijriFor, getHijriToday } from './hijri.js';

const METHODS = {
  MuslimWorldLeague: adhan.CalculationMethod.MuslimWorldLeague,
  Egyptian: adhan.CalculationMethod.Egyptian,
  Karachi: adhan.CalculationMethod.Karachi,
  UmmAlQura: adhan.CalculationMethod.UmmAlQura,
  Dubai: adhan.CalculationMethod.Dubai,
  MoonsightingCommittee: adhan.CalculationMethod.MoonsightingCommittee,
  NorthAmerica: adhan.CalculationMethod.NorthAmerica,
  Kuwait: adhan.CalculationMethod.Kuwait,
  Qatar: adhan.CalculationMethod.Qatar,
  Singapore: adhan.CalculationMethod.Singapore,
  Tehran: adhan.CalculationMethod.Tehran,
  Turkey: adhan.CalculationMethod.Turkey
};

export const METHOD_KEYS = Object.keys(METHODS);

function buildParams(cfg) {
  const methodFn = METHODS[cfg.prayer.method] || adhan.CalculationMethod.Karachi;
  const params = methodFn();
  params.madhab = cfg.prayer.madhab === 'hanafi' ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;
  const adj = cfg.prayer.adjustments || {};
  params.adjustments = {
    fajr: adj.fajr || 0, sunrise: 0, dhuhr: adj.dhuhr || 0,
    asr: adj.asr || 0, maghrib: adj.maghrib || 0, isha: adj.isha || 0
  };
  return params;
}

// "HH:MM" in the given IANA timezone — must be the *location's* zone, not the
// server's, since the server (e.g. Render) runs in UTC regardless of where
// the configured location actually is.
function hhmm(date, tz) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
}

// The calendar date and weekday as seen in `tz`, not the server's local zone.
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, dow };
}

export async function computePrayerTimes(cfg, date = new Date(), liveHijri = true) {
  const coords = new adhan.Coordinates(cfg.location.lat, cfg.location.lon);
  const tz = tzlookup(cfg.location.lat, cfg.location.lon);
  const params = buildParams(cfg);
  const pt = new adhan.PrayerTimes(coords, date, params);

  const { ymd, dow } = localParts(date, tz);
  const isFriday = dow === 5;
  const jumuah = cfg.prayer.jumuah || {};

  const timings = {
    Fajr: hhmm(pt.fajr, tz),
    Sunrise: hhmm(pt.sunrise, tz),
    Dhuhr: (isFriday && jumuah.enabled && jumuah.time) ? jumuah.time : hhmm(pt.dhuhr, tz),
    Asr: hhmm(pt.asr, tz),
    Maghrib: hhmm(pt.maghrib, tz),
    Isha: hhmm(pt.isha, tz)
  };

  // Iqamah times = adhan + per-prayer offset (Sunrise excluded).
  const off = cfg.adhan?.iqamah?.offsets || {};
  const iqamah = {};
  for (const [name, key] of [['Fajr','fajr'],['Dhuhr','dhuhr'],['Asr','asr'],['Maghrib','maghrib'],['Isha','isha']]) {
    iqamah[name] = addMinutes(timings[name], off[key] || 0);
  }

  return {
    date: ymd,
    isFriday,
    dhuhrLabel: (isFriday && jumuah.enabled) ? "Jumu'ah" : 'Dhuhr',
    timings,
    iqamah,
    hijri: liveHijri ? await getHijriToday() : hijriFor(date, cfg.prayer.hijriOffset || 0, tz),
    qibla: adhan.Qibla(coords)   // degrees clockwise from true north
  };
}

function addMinutes(hhmmStr, mins) {
  const [h, m] = hhmmStr.split(':').map(Number);
  let total = h * 60 + m + mins;
  total = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
