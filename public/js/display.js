/* display.js — drives the kiosk screen. Talks to the local server over /api/*,
   listens on /events (SSE) for instant updates, plays the adhan at each waqt,
   keeps the screen awake, and applies theme/dimming/font-scale from config. */

const $ = (id) => document.getElementById(id);
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const KEY = { Fajr: 'fajr', Dhuhr: 'dhuhr', Asr: 'asr', Maghrib: 'maghrib', Isha: 'isha' };

let cfg = null;
let deviceLoc = null;   // the display device's own geolocation, when available (primary)
let prayer = null;      // response of /api/prayer-times
let fired = new Set();  // guards against double-firing adhan within a minute
let soundArmed = false;
let wakeLock = null;

// ---------- boot ----------
init();
async function init() {
  window.Sky?.init($('sky'));   // animated weather/day-night background
  await refreshConfig();
  await Promise.all([refreshPrayer(), refreshWeather(), refreshHadith(), loadNetInfo()]);
  initDeviceLocation();   // async: switches to device location once permitted
  tick();
  setInterval(tick, 1000);
  setInterval(refreshWeather, 10 * 60 * 1000);   // matches the server's 10-min cache
  setInterval(refreshPrayer, 60 * 60 * 1000);
  setupSSE();
  requestWake();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestWake(); });
  setupFitToScreen();
  // Arm audio on any user tap (covers the autoplay-blocked fallback overlay).
  $('sound-arm').addEventListener('click', armSound);
  document.body.addEventListener('click', () => { if (!soundArmed) armSound(); }, { once: true });
}

// ---------- fit to screen ----------
// Keep the dock full-width but size the root font so its height fills one screen
// without scrolling — everything is in rem, so this resizes every widget in step.
// Runs on load, on resize, and whenever content changes height (prayer list,
// weather, banner showing/hiding, font-scale changes).
let _fitting = false;
function fitToScreen() {
  const app = document.querySelector('.app');
  if (!app) return;
  const root = document.documentElement;
  const base = 16 * (cfg?.fontScale || 1);    // the user's chosen "across the room" size
  _fitting = true;
  let size = base;
  root.style.fontSize = size + 'px';
  // Two passes converge even though a few elements are fixed-px (SVG icons etc.)
  // and don't scale perfectly linearly with the font.
  for (let i = 0; i < 2; i++) {
    const h = app.offsetHeight;
    if (!h) break;
    size = size * ((window.innerHeight - 2) / h);     // -2px guards against rounding overflow
    size = Math.max(6, Math.min(size, base * 4));      // never absurdly small or large
    root.style.fontSize = size + 'px';
  }
  requestAnimationFrame(() => { _fitting = false; });
}

function setupFitToScreen() {
  fitToScreen();
  window.addEventListener('resize', fitToScreen);
  const app = document.querySelector('.app');
  if (app && 'ResizeObserver' in window) {
    // Re-fit when real content changes size. The _fitting guard stops our own
    // font-size writes from retriggering this into a loop.
    new ResizeObserver(() => { if (!_fitting) fitToScreen(); }).observe(app);
  }
}

// ---------- device location (primary) ----------
// Ask the display device where it is and use that for prayer times + weather.
// Needs a secure context — works when the display is kiosked on http://localhost.
// If denied or unavailable we simply keep the configured location.
async function initDeviceLocation() {
  if (!('geolocation' in navigator)) return;
  const pos = await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30 * 60 * 1000 });
  });
  if (!pos) return;
  const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  const rg = await fetchJSON(`/api/reverse-geocode?lat=${loc.lat}&lon=${loc.lon}`);
  loc.name = (rg && rg.name) || `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`;
  deviceLoc = loc;
  $('loc').textContent = loc.name;
  await persistDeviceLoc(loc);   // so Settings shows the location actually in use
  await Promise.all([refreshPrayer(), refreshWeather()]);   // recompute for the real location
}

// Save the auto-detected location into config so the settings page (which reads
// config, not the display's live GPS) reflects what the display is really using.
// GPS is the primary source, so it's authoritative over a stale/default value.
// Skips the write — and its config-changed broadcast — when nothing changed.
async function persistDeviceLoc(loc) {
  const cur = cfg?.location || {};
  const same = cur.name === loc.name
    && Math.abs((cur.lat ?? 0) - loc.lat) < 0.005      // ~500m: ignore GPS jitter
    && Math.abs((cur.lon ?? 0) - loc.lon) < 0.005;
  if (same) return;
  const location = { name: loc.name, lat: loc.lat, lon: loc.lon };
  try {
    await fetch('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location })
    });
    if (cfg) cfg.location = location;
  } catch {}
}

// Query string that pins server calls to the device location, when we have it.
function locQS() {
  return deviceLoc
    ? `?lat=${deviceLoc.lat}&lon=${deviceLoc.lon}&name=${encodeURIComponent(deviceLoc.name || '')}`
    : '';
}

// ---------- config / theme / dimming ----------
async function refreshConfig() {
  cfg = await fetchJSON('/api/config');
  document.documentElement.dataset.theme = cfg.theme || 'midnight';
  document.documentElement.dataset.clockStyle = cfg.clockStyle || 'standard';
  document.documentElement.style.fontSize = (16 * (cfg.fontScale || 1)) + 'px';
  $('loc').textContent = deviceLoc?.name || cfg.location?.name || '';
  $('hadith-card').style.display = cfg.hadith?.show === false ? 'none' : '';
  applyDimming();
  renderCalendar();
}

function applyDimming() {
  const d = cfg.dimming || {};
  let level = d.level || 0;
  const an = d.autoNight;
  if (an?.enabled && inWindow(an.start, an.end)) level = Math.max(level, an.level || 0.5);
  $('dim-overlay').style.opacity = String(level);
}

// ---------- master 1s tick ----------
function tick() {
  const now = new Date();
  drawClock(now);
  updateNextPrayer(now);
  checkAdhan(now);
  updateBanner(now);
  if (now.getSeconds() === 0) applyDimming(); // re-evaluate night dim each minute
}

// Split the current time into the digits string ("12:45") and meridiem ("PM"/"").
function clockParts(now) {
  const m = String(now.getMinutes()).padStart(2, '0');
  let h = now.getHours();
  if ((cfg?.units?.clock || '12') === '24') return { main: `${String(h).padStart(2, '0')}:${m}`, ap: '' };
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return { main: `${h}:${m}`, ap };
}

function drawClock(now) {
  const { main, ap } = clockParts(now);
  const style = cfg?.clockStyle || 'standard';
  const el = $('clock');
  if (el.dataset.style !== style) {   // switching styles: wipe any prior markup/state
    el.dataset.style = style;
    el.innerHTML = '';
    el._flip = null;
  }
  if (style === 'flip') renderFlipClock(el, main, ap);
  else renderPlainClock(el, main, ap, style);

  $('greg').textContent = now.toLocaleDateString(undefined,
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// standard / minimal / lcd — plain text, LCD adds a faint "all-segments" ghost.
function renderPlainClock(el, main, ap, style) {
  const apHtml = ap ? `<span class="ampm">${ap}</span>` : '';
  const html = style === 'lcd'
    ? `<span class="lcd"><span class="lcd-ghost" aria-hidden="true">${main.replace(/\d/g, '8')}</span><span class="lcd-live">${main}</span></span>${apHtml}`
    : `${main}${apHtml}`;
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// Split-flap "paper" clock: one card per digit, each folds when its value changes.
function renderFlipClock(el, main, ap) {
  const chars = main.split('');
  const shape = chars.map((c) => (c === ':' ? ':' : 'd')).join('') + (ap ? '+' : '');
  if (el._flip !== shape) {   // (re)build only when the digit layout changes
    el._flip = shape;
    el.innerHTML = chars.map((c) => c === ':'
      ? '<span class="flip-colon">:</span>'
      : '<span class="flip-digit"><span class="fd fd-top"></span><span class="fd fd-bottom"></span>'
        + '<span class="fd flap flap-top"></span><span class="fd flap flap-bottom"></span></span>'
    ).join('') + (ap ? `<span class="flip-ampm">${ap}</span>` : '');
  }
  const cells = el.querySelectorAll('.flip-digit');
  let i = 0;
  for (const c of chars) { if (c !== ':') setFlipDigit(cells[i++], c); }
  if (ap) el.querySelector('.flip-ampm').textContent = ap;
}

function setFlipDigit(cell, val) {
  if (!cell || cell.dataset.v === val) return;
  const cur = cell.dataset.v;
  cell.dataset.v = val;
  const top = cell.querySelector('.fd-top'), bottom = cell.querySelector('.fd-bottom');
  const flapTop = cell.querySelector('.flap-top'), flapBottom = cell.querySelector('.flap-bottom');
  if (cur == null) { top.textContent = bottom.textContent = val; return; }   // first paint, no flip
  top.textContent = val;          // new upper half, revealed as the old flap folds away
  bottom.textContent = cur;       // old lower half, until the new flap unfolds over it
  flapTop.textContent = cur;      // folds down (old top)
  flapBottom.textContent = val;   // unfolds down (new bottom)
  cell.classList.remove('flip-anim');
  void cell.offsetWidth;          // restart the animation
  cell.classList.add('flip-anim');
  clearTimeout(cell._t);
  cell._t = setTimeout(() => { cell.classList.remove('flip-anim'); bottom.textContent = val; }, 520);
}

// ---------- prayer times ----------
async function refreshPrayer() {
  prayer = await fetchJSON('/api/prayer-times' + locQS());
  const h = prayer.hijri;
  $('hijri').textContent = `${h.day} ${h.month} ${h.year} AH`;
  renderPrayerList();
}

// Split "5:12 AM" into ["5:12", "AM"]; 24h ("17:00") yields ["17:00", ""].
function splitTime(hhmm) {
  const [t, ap = ''] = fmt12(hhmm).split(' ');
  return [t, ap];
}

function renderPrayerList() {
  if (!prayer) return;
  const order = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  $('prayers').innerHTML = order.map((name) => {
    const label = name === 'Dhuhr' ? prayer.dhuhrLabel : name;
    const [at, aap] = splitTime(prayer.timings[name]);
    const iqRaw = (name === 'Sunrise') ? '' : prayer.iqamah[name];
    const iq = iqRaw
      ? `<span class="iqtime tnum"><span class="iqlab">iqamah</span> ${fmt12(iqRaw)}</span>`
      : `<span class="iqtime iq-none">—</span>`;
    return `<div class="ptile" data-name="${name}">
      <span class="pname">${label}</span>
      <span class="ptime tnum">${at}${aap ? `<span class="ampm">${aap}</span>` : ''}</span>
      ${iq}</div>`;
  }).join('');
}

function updateNextPrayer(now) {
  if (!prayer) return;
  const t = prayer.timings;
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const times = PRAYERS.map((n) => ({ name: n, min: toMin(t[n]) }));
  let next = times.find((p) => p.min > nowMin), prevMin;
  if (!next) { next = { name: times[0].name, min: times[0].min + 1440 }; prevMin = times[times.length - 1].min; }
  else { const i = times.findIndex((p) => p.name === next.name); prevMin = i === 0 ? times[times.length - 1].min - 1440 : times[i - 1].min; }

  const remain = next.min - nowMin, hrs = Math.floor(remain / 60), mins = Math.floor(remain % 60);
  $('np-name').textContent = next.name === 'Dhuhr' ? prayer.dhuhrLabel : next.name;
  $('np-in').textContent = hrs > 0 ? `in ${hrs}h ${mins}m` : `in ${mins}m`;

  const span = next.min - prevMin, pct = Math.max(0, Math.min(1, (nowMin - prevMin) / span));
  $('arc').style.strokeDashoffset = String(188.5 * (1 - pct));
  $('arc-pct').textContent = Math.round(pct * 100) + '%';
  document.querySelectorAll('#prayers .ptile').forEach((el) =>
    el.classList.toggle('active', el.dataset.name === next.name));
}

// ---------- adhan scheduler ----------
function checkAdhan(now) {
  if (!prayer || !cfg.adhan?.enabled) return;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dayTag = now.toISOString().slice(0, 10);
  if (now.getHours() === 0 && now.getMinutes() === 0) fired.clear();

  for (const name of PRAYERS) {
    // adhan at prayer time
    if (prayer.timings[name] === hhmm) {
      const fkey = `${dayTag}:${name}:adhan`;
      if (!fired.has(fkey) && cfg.adhan.perPrayer?.[KEY[name]] !== false && !inQuiet(now)) {
        fired.add(fkey);
        playAdhan(name === 'Fajr');
      }
    }
    // iqamah chime
    if (cfg.adhan.iqamah?.chimeEnabled && prayer.iqamah[name] === hhmm) {
      const fkey = `${dayTag}:${name}:iqamah`;
      if (!fired.has(fkey) && cfg.adhan.perPrayer?.[KEY[name]] !== false && !inQuiet(now)) {
        fired.add(fkey);
        playIqamah();
      }
    }
  }
}

function playAdhan(isFajr) {
  const muezzin = cfg.adhan?.muezzin || 'mishary';
  const el = $('audio-adhan');
  const src = isFajr ? `/audio/${muezzin}-fajr.mp3` : `/audio/${muezzin}.mp3`;
  el.src = src;
  el.volume = cfg.adhan?.volume ?? 0.85;
  play(el, () => { // if fajr file 404s, fall back to the regular adhan
    if (isFajr) { el.src = `/audio/${muezzin}.mp3`; play(el); }
  });
}
function playIqamah() {
  const el = $('audio-iqamah');
  el.src = '/audio/iqamah.mp3';
  el.volume = cfg.adhan?.volume ?? 0.85;
  play(el);
}
function play(el, onError) {
  const p = el.play();
  if (p?.catch) p.catch(() => { if (!soundArmed) $('sound-arm').classList.add('show'); if (onError) onError(); });
}
function armSound() {
  soundArmed = true;
  $('sound-arm').classList.remove('show');
  // unlock the audio elements with a silent play/pause
  for (const id of ['audio-adhan', 'audio-iqamah']) {
    const el = $(id); el.muted = true;
    el.play().then(() => { el.pause(); el.currentTime = 0; el.muted = false; }).catch(() => { el.muted = false; });
  }
}

// ---------- weather ----------
async function refreshWeather() {
  const w = await fetchJSON('/api/weather' + locQS());
  if (!w || w.unavailable) { $('wx-cond').textContent = 'Unavailable'; window.Sky?.set({ code: 0 }); return; }
  $('stale').hidden = !w.stale;
  // drive the animated background from the live condition + sunrise/sunset
  window.Sky?.set({ code: w.code, isDay: w.isDay, sunrise: w.sunrise, sunset: w.sunset });
  const f = (cfg.units?.temp || 'c') === 'f';
  const conv = (c) => Math.round(f ? c * 9 / 5 + 32 : c);
  const unit = f ? '°F' : '°C';
  const meta = wmo(w.code, w.isDay);
  $('wx-icon').textContent = meta.icon;
  $('wx-temp').textContent = conv(w.tempC) + '°';
  $('wx-cond').textContent = meta.text;
  $('wx-place').textContent = w.place || '';
  const stats = [];
  if (w.feelsC != null) stats.push(`Feels <b>${conv(w.feelsC)}${unit}</b>`);
  if (w.highC != null) stats.push(`H <b>${conv(w.highC)}°</b> · L <b>${conv(w.lowC)}°</b>`);
  if (w.humidity != null) stats.push(`Humidity <b>${w.humidity}%</b>`);
  if (w.sunrise) stats.push(`↑ <b>${clockOf(w.sunrise)}</b>`);
  if (w.sunset) stats.push(`↓ <b>${clockOf(w.sunset)}</b>`);
  $('wx-stats').innerHTML = stats.map((s) => `<span class="wx-stat">${s}</span>`).join('');
  renderForecast(w.daily || [], conv);
}

// 7-day strip: weekday + condition icon + high/low. Uses daytime icons.
function renderForecast(days, conv) {
  const el = $('wx-forecast');
  if (!el) return;
  const todayISO = iso(new Date());
  el.innerHTML = days.slice(0, 7).map((d) => {
    const dt = new Date(d.date + 'T12:00:00');
    const label = d.date === todayISO ? 'Today'
      : dt.toLocaleDateString(undefined, { weekday: 'short' });
    const meta = wmo(d.code, true);   // daytime look for a daily summary
    const hi = d.maxC != null ? conv(d.maxC) + '°' : '—';
    const lo = d.minC != null ? conv(d.minC) + '°' : '—';
    return `<div class="wx-day${d.date === todayISO ? ' today' : ''}">
      <div class="wx-day-name">${label}</div>
      <div class="wx-day-icon" title="${meta.text}">${meta.icon}</div>
      <div class="wx-day-temp"><b class="tnum">${hi}</b><span class="tnum">${lo}</span></div>
    </div>`;
  }).join('');
}

// ---------- calendar ----------
function renderCalendar() {
  const events = cfg.events || [];
  const today = new Date();
  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  let html = '';
  for (let i = -today.getDay(); i < 7 - today.getDay(); i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    const ds = iso(d);
    const has = events.some((ev) => occursOn(ev, ds));
    html += `<div class="day-chip ${ds === iso(today) ? 'today' : ''}">
      <div class="dow">${dow[d.getDay()]}</div><div class="dnum">${d.getDate()}</div>
      <div class="dmark ${has ? '' : 'hide'}"></div></div>`;
  }
  $('week').innerHTML = html;

  const base = new Date(); base.setHours(0, 0, 0, 0);
  const up = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i); const ds = iso(d);
    events.filter((ev) => occursOn(ev, ds)).forEach((ev) => up.push({ ...ev, when: d }));
  }
  up.sort((a, b) => a.when - b.when);
  const top = up.slice(0, 6);
  $('agenda').innerHTML = top.length ? top.map((ev) => {
    const isToday = ev.when.toDateString() === base.toDateString();
    const tmr = new Date(base); tmr.setDate(base.getDate() + 1);
    const label = isToday ? 'Today' : ev.when.toDateString() === tmr.toDateString() ? 'Tomorrow'
      : ev.when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<div class="agenda-item">
      <div class="dot" style="background:${memberColor(ev.memberName)}"></div>
      <div class="agenda-when">${label}${ev.time ? ' · ' + fmt12(ev.time) : ''}</div>
      <div><div class="agenda-title">${esc(ev.title)}</div>
      <div class="agenda-who">${esc(ev.memberName || 'Everyone')}</div></div></div>`;
  }).join('') : '<div class="empty">No upcoming events. Add one from settings.</div>';
}

// ---------- hadith ----------
async function refreshHadith() {
  const h = await fetchJSON('/api/hadith/today');
  if (!h || h.empty) { $('hadith-text').textContent = 'No hadith loaded yet — add data/hadith.json.'; $('hadith-src').textContent = ''; return; }
  $('hadith-chapter').textContent = h.chapter || '';
  $('hadith-text').textContent = h.bn || '';
  const parts = [h.collection, h.ref, h.grading].filter(Boolean).join(' · ');
  $('hadith-src').textContent = parts;
}

// ---------- ramadan / special-day banner ----------
function updateBanner(now) {
  if (!prayer) return;
  const b = $('banner');
  const month = (prayer.hijri.month || '').toLowerCase();
  const day = parseInt(prayer.hijri.day, 10);

  if (month.includes('ramad')) {
    // Suhoor (Fajr) / Iftar (Maghrib) countdown
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const fajr = toMin(prayer.timings.Fajr), maghrib = toMin(prayer.timings.Maghrib);
    let kicker, title, target;
    if (nowMin < fajr) { kicker = 'Ramadan · Suhoor'; title = 'Suhoor ends at ' + fmt12(prayer.timings.Fajr); target = fajr; }
    else if (nowMin < maghrib) { kicker = 'Ramadan · Iftar'; title = 'Iftar at ' + fmt12(prayer.timings.Maghrib); target = maghrib; }
    else { kicker = 'Ramadan'; title = 'Iftar complete — Ramadan Mubarak'; target = null; }
    if (day >= 21) kicker += ' · Last 10 nights';
    $('banner-kicker').textContent = kicker;
    $('banner-title').textContent = title;
    $('banner-count').textContent = target != null ? countdown(target - nowMin - now.getSeconds() / 60) : '';
    b.classList.add('show');
    return;
  }

  const special = specialDay(month, day);
  if (special) {
    $('banner-kicker').textContent = 'Today';
    $('banner-title').textContent = special;
    $('banner-count').textContent = '';
    b.classList.add('show');
  } else b.classList.remove('show');
}

function specialDay(month, day) {
  if (month.includes('shawwal') && day === 1) return 'Eid al-Fitr Mubarak';
  if (month.includes('hijjah') && day === 10) return 'Eid al-Adha Mubarak';
  if (month.includes('hijjah') && day === 9) return 'Day of Arafah';
  if (month.includes('muharram') && day === 10) return 'Day of Ashura';
  return null;
}

// ---------- net info / QR ----------
async function loadNetInfo() {
  const n = await fetchJSON('/api/net-info');
  if (!n) return;
  $('settings-url').textContent = n.settingsUrl;
  if (window.qrcode) { // optional drop-in QR lib (public/js/qrcode.min.js)
    try {
      const qr = window.qrcode(0, 'M'); qr.addData(n.settingsUrl); qr.make();
      $('qr').innerHTML = qr.createImgTag(3, 4); $('qr').hidden = false;
    } catch {}
  }
}

// ---------- SSE ----------
function setupSSE() {
  const es = new EventSource('/events');
  es.addEventListener('config-changed', async () => {
    await refreshConfig(); await Promise.all([refreshPrayer(), refreshWeather(), refreshHadith()]);
  });
  es.addEventListener('test-adhan', (e) => {
    try { const d = JSON.parse(e.data || '{}'); playAdhan(d.which === 'fajr'); } catch { playAdhan(false); }
  });
  es.onerror = () => {}; // EventSource auto-reconnects (retry hint sent by server)
}

// ---------- wake lock ----------
async function requestWake() {
  if (!cfg?.keepAwake || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

// ---------- helpers ----------
async function fetchJSON(url) { try { const r = await fetch(url); return await r.json(); } catch { return null; } }
function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function fmt12(hhmm) {
  if (!hhmm) return '';
  if ((cfg?.units?.clock || '12') === '24') return hhmm;
  let [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
function clockOf(iso) { const d = new Date(iso); return fmt12(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`); }
function countdown(mins) { if (mins < 0) return ''; const h = Math.floor(mins / 60), m = Math.floor(mins % 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function occursOn(ev, ds) {
  if (ev.date === ds) return true;
  if (ev.repeatYearly) { const [, m, d] = ev.date.split('-'); const [ty] = ds.split('-'); return `${ty}-${m}-${d}` === ds; }
  return false;
}
function memberColor(name) { const m = (cfg.members || []).find((x) => x.name === name); return m ? m.color : 'var(--accent)'; }
function inWindow(start, end) {
  const now = new Date(); const n = now.getHours() * 60 + now.getMinutes();
  const s = toMin(start), e = toMin(end);
  return s <= e ? (n >= s && n < e) : (n >= s || n < e); // handles overnight windows
}
function inQuiet(now) {
  const q = cfg.adhan?.quietHours; if (!q?.enabled) return false;
  return inWindow(q.start, q.end);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

const WMO = {
  0: ['Clear', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'],
  3: ['Overcast', '☁️'], 45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Drizzle', '🌦️'],
  61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️']
};
function wmo(code, isDay) { const e = WMO[code] || ['Weather', '🌡️']; return { text: e[0], icon: (!isDay && e[2]) ? e[2] : e[1] }; }
