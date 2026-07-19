// prayer.js — fully offline prayer times, Hijri date, and Qibla bearing.
// Times come from the `adhan` library (no network); Hijri comes from the ICU
// islamic-umalqura calendar built into Node's Intl.
import * as adhan from 'adhan';

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

// Local "HH:MM" in the server's timezone (which is the device's timezone).
function hhmm(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Hijri date via ICU, with a manual ± day offset for local moon-sighting.
export function hijriFor(date, offsetDays = 0) {
  const shifted = new Date(date.getTime() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
    day: 'numeric', month: 'long', year: 'numeric'
  }).formatToParts(shifted);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return { day: get('day'), month: get('month'), year: get('year') };
}

export function computePrayerTimes(cfg, date = new Date()) {
  const coords = new adhan.Coordinates(cfg.location.lat, cfg.location.lon);
  const params = buildParams(cfg);
  const pt = new adhan.PrayerTimes(coords, date, params);

  const isFriday = date.getDay() === 5;
  const jumuah = cfg.prayer.jumuah || {};

  const timings = {
    Fajr: hhmm(pt.fajr),
    Sunrise: hhmm(pt.sunrise),
    Dhuhr: (isFriday && jumuah.enabled && jumuah.time) ? jumuah.time : hhmm(pt.dhuhr),
    Asr: hhmm(pt.asr),
    Maghrib: hhmm(pt.maghrib),
    Isha: hhmm(pt.isha)
  };

  // Iqamah times = adhan + per-prayer offset (Sunrise excluded).
  const off = cfg.adhan?.iqamah?.offsets || {};
  const iqamah = {};
  for (const [name, key] of [['Fajr','fajr'],['Dhuhr','dhuhr'],['Asr','asr'],['Maghrib','maghrib'],['Isha','isha']]) {
    iqamah[name] = addMinutes(timings[name], off[key] || 0);
  }

  return {
    date: date.toISOString().slice(0, 10),
    isFriday,
    dhuhrLabel: (isFriday && jumuah.enabled) ? "Jumu'ah" : 'Dhuhr',
    timings,
    iqamah,
    hijri: hijriFor(date, cfg.prayer.hijriOffset || 0),
    qibla: adhan.Qibla(coords)   // degrees clockwise from true north
  };
}

function addMinutes(hhmmStr, mins) {
  const [h, m] = hhmmStr.split(':').map(Number);
  let total = h * 60 + m + mins;
  total = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
