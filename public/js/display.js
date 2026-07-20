/* display.js — drives the kiosk screen. Talks to the local server over /api/*,
   listens on /events (SSE) for instant updates, plays the adhan at each waqt,
   keeps the screen awake, and applies theme/dimming/font-scale from config. */

const $ = (id) => document.getElementById(id);
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const KEY = { Fajr: 'fajr', Dhuhr: 'dhuhr', Asr: 'asr', Maghrib: 'maghrib', Isha: 'isha' };

let cfg = null;
let deviceLoc = null;   // the display device's own geolocation, when available (primary)
let prayer = null;      // response of /api/prayer-times
let fired = new Set();    // guards against double-firing adhan within a minute
let pending = new Set();  // in-flight play() attempts, so a slow-loading file doesn't get its src reset every tick
let soundArmed = false;
let wakeLock = null;

// ---------- boot ----------
init();
async function init() {
  window.Sky?.init($('sky'));   // animated weather/day-night background
  await refreshConfig();
  preloadAdhanAudio();
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
  // "Now playing" overlay closes itself when the adhan finishes, or on tap.
  $('audio-adhan').addEventListener('ended', hideAdhanOverlay);
  $('adhan-stop').addEventListener('click', stopAdhan);
  setupFullscreenToggle();
}

// ---------- fullscreen toggle ----------
function setupFullscreenToggle() {
  const btn = $('fullscreen-btn');
  const icon = $('fullscreen-icon');
  if (!btn) return;
  if (!document.documentElement.requestFullscreen) { btn.hidden = true; return; }
  btn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = !!document.fullscreenElement;
    btn.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    if (icon) icon.textContent = isFullscreen ? '✕' : '⛶';
  });
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
  // Each pass shrinks size by whichever of height or width is more over
  // budget (non-wrapping content, e.g. the flip clock's fixed-width digit
  // cards, can force .app wider than its own box, not just taller than the
  // window) and stops as soon as a pass changes nothing. fitHeroClock runs on
  // every pass, before measuring .app — not just once at the end — because
  // .app's own height/width depend on the clock's size, so measuring .app
  // against a stale (pre-fitHeroClock) clock box and only reconciling them
  // afterwards left the two calls perpetually invalidating each other's
  // measurement, oscillating between two font-sizes forever instead of
  // settling on one.
  for (let i = 0; i < 6; i++) {
    fitHeroClock();
    const h = app.offsetHeight;
    if (!h) break;
    const ratio = Math.min((window.innerHeight - 2) / h, app.clientWidth / app.scrollWidth);
    const next = Math.max(6, Math.min(size * ratio, base * 4));
    if (Math.abs(next - size) < 0.1) { size = next; break; }
    size = next;
    root.style.fontSize = size + 'px';
  }
  fitHeroClock();
  requestAnimationFrame(() => { _fitting = false; });
}

function setupFitToScreen() {
  fitToScreen();
  window.addEventListener('resize', fitToScreen);
  // The very first fitToScreen() above can run before a custom clock webfont
  // (e.g. a neon clockFont) has finished loading — canvas measureText() falls
  // back to a generic font for width until the real one is ready, so the
  // clock's real (wider) glyphs weren't accounted for. That undersized
  // measurement lets the root font-size come out too large, and once the
  // font swaps in, only the hero card resizes (see the ResizeObserver
  // below), which re-fits the clock alone, not the root font-size — so the
  // rest of the dock, including the right column, is left oversized and
  // clipped by the screen edge. Re-running the full fit once every font is
  // confirmed loaded recomputes the root size against real metrics.
  if (document.fonts) document.fonts.ready.then(() => { if (!_fitting) fitToScreen(); });
  const app = document.querySelector('.app');
  if (app && 'ResizeObserver' in window) {
    // Re-fit when real content changes size. The _fitting guard stops our own
    // font-size writes from retriggering this into a loop.
    new ResizeObserver(() => { if (!_fitting) fitToScreen(); }).observe(app);
  }
  const hero = document.querySelector('.hero');
  if (hero && 'ResizeObserver' in window) {
    // Re-fit the clock whenever the hero card itself changes size for some
    // reason other than fitToScreen/fitHeroClock's own writes (which already
    // fit the clock inline — see above) — e.g. font files finishing load.
    new ResizeObserver(() => { if (!_fitting && !_fittingClock) fitHeroClock(); }).observe(hero);
  }
}

// ---------- device location (primary) ----------
// Ask the display device where it is and use that for prayer times + weather.
// Needs a secure context — works when the display is kiosked on http://localhost.
// If denied or unavailable we simply keep the configured location.
// Skipped when location.auto is off — e.g. the user picked a specific place in
// Settings, which should stick instead of being overwritten by GPS on next load.
async function initDeviceLocation() {
  if (!('geolocation' in navigator)) return;
  if (cfg?.location?.auto === false) return;
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
  document.documentElement.dataset.clockColor = cfg.clockColor || 'default';
  document.documentElement.dataset.clockFont = cfg.clockFont || 'monoton';
  document.documentElement.style.fontSize = (16 * (cfg.fontScale || 1)) + 'px';
  if (cfg.location?.auto === false) deviceLoc = null;   // manual location wins over any stale GPS fix
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

// Split the current time into the digits string ("12:45:09") and meridiem ("PM"/"").
function clockParts(now) {
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = cfg?.units?.showSeconds ? `:${String(now.getSeconds()).padStart(2, '0')}` : '';
  let h = now.getHours();
  if ((cfg?.units?.clock || '12') === '24') return { main: `${String(h).padStart(2, '0')}:${m}${s}`, ap: '' };
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return { main: `${h}:${m}${s}`, ap };
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
  el.classList.toggle('has-seconds', !!cfg?.units?.showSeconds);
  if (style === 'flip' || style === 'flip-white') renderFlipClock(el, main);
  else if (style === 'lcd') renderSevenSegClock(el, main);
  else renderPlainClock(el, main);
  $('ampm-badge').textContent = ap;

  $('greg').textContent = now.toLocaleDateString(undefined,
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Only re-measure when the digit layout actually changed (hour gains/loses a
  // digit, seconds toggle, style switch) — not on every second's tick.
  const shapeKey = `${style}|${main.replace(/\d/g, '0')}`;
  if (shapeKey !== _lastClockShape) {
    _lastClockShape = shapeKey;
    fitHeroClock();
  }
}

// standard / minimal / neon / aurora — plain text.
function renderPlainClock(el, main) {
  if (el._html !== main) { el.innerHTML = main; el._html = main; }
}

// LCD: real 7-segment digits (segments a–g) + lit colon dots, same physical
// layout as an actual 7-segment display module — every segment is always
// present in the DOM, "off" ones just render dim, so the display always shows
// the classic all-segments ghost behind the live digits for free.
const SEG_ON = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg'
};
const SEG_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

function renderSevenSegClock(el, main) {
  const chars = main.split('');
  const shape = chars.map((c) => (c === ':' ? ':' : 'd')).join('');
  if (el._seg !== shape) {
    el._seg = shape;
    el.innerHTML = chars.map((c) => c === ':'
      ? '<span class="seg-colon"><i class="seg-dot"></i><i class="seg-dot"></i></span>'
      : '<span class="seg-digit">' + SEG_LETTERS.map((s) => `<i class="seg seg-${s}"></i>`).join('') + '</span>'
    ).join('');
  }
  const digits = el.querySelectorAll('.seg-digit');
  let i = 0;
  for (const c of chars) {
    if (c === ':') continue;
    const on = SEG_ON[c] || '';
    const cell = digits[i++];
    for (const s of SEG_LETTERS) cell.querySelector('.seg-' + s).classList.toggle('on', on.includes(s));
  }
}

// Split-flap "paper" clock: one card per digit, each folds when its value changes.
function renderFlipClock(el, main) {
  const chars = main.split('');
  const shape = chars.map((c) => (c === ':' ? ':' : 'd')).join('');
  if (el._flip !== shape) {   // (re)build only when the digit layout changes
    el._flip = shape;
    el.innerHTML = chars.map((c) => c === ':'
      ? '<span class="flip-colon">:</span>'
      : '<span class="flip-digit"><span class="fd fd-top"></span><span class="fd fd-bottom"></span>'
        + '<span class="fd flap flap-top"></span><span class="fd flap flap-bottom"></span></span>'
    ).join('');
  }
  const cells = el.querySelectorAll('.flip-digit');
  let i = 0;
  for (const c of chars) { if (c !== ':') setFlipDigit(cells[i++], c); }
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

// ---------- hero clock: dynamic fit ----------
// The clock used to be sized by a fixed CSS formula (min(Ncqh, Mcqw)) tuned for
// a worst-case digit count ("88:88:88"). But the hour isn't zero-padded in
// 12-hour mode, so most times render one digit narrower than that formula
// assumed, leaving unused margin on every side. Instead, measure the clock's
// real rendered box at a reference font-size (tabular-nums means digit *value*
// never affects width, only digit *count* does, so this scales exactly) and
// set a font-size that fills the hero card exactly, whatever's on screen.
let _fittingClock = false;
let _lastClockShape = null;
const CLOCK_FIT_REF = 200; // px reference; text scales linearly from here

function fitHeroClock() {
  const hero = document.querySelector('.hero');
  const clock = $('clock');
  const datebar = document.querySelector('.datebar');
  if (!hero || !clock || !clock.children.length && !clock.textContent.trim()) return;
  _fittingClock = true;
  clock.style.transform = '';   // never let a stale transform skew this measurement pass
  clock.style.fontSize = CLOCK_FIT_REF + 'px';
  const heroStyle = getComputedStyle(hero);
  const padX = parseFloat(heroStyle.paddingLeft) + parseFloat(heroStyle.paddingRight);
  const padY = parseFloat(heroStyle.paddingTop) + parseFloat(heroStyle.paddingBottom);
  const gap = parseFloat(heroStyle.rowGap || heroStyle.gap) || 0;
  const availW = hero.clientWidth - padX;
  const dateH = datebar ? datebar.getBoundingClientRect().height : 0;
  const availH = hero.clientHeight - padY - gap - dateH;

  // For plain-text styles (standard/minimal/neon/aurora), .clock is a plain
  // block element, so it always fills its container's width regardless of
  // what the text inside actually needs — clock.scrollWidth just reports
  // that container width back (masking the real need whenever the text
  // happens to fit inside it), not the text's true natural width. That blinds
  // this box-fit step to width entirely for most fonts, sizing purely by
  // height — harmless for a font whose glyphs are roughly as wide as they
  // are tall, but for a font that's simply wider per character at a given
  // height (neon's Wallpoet/Faster One, vs. the default Monoton), the
  // height-only size then overflows the card horizontally once rendered.
  // Measure the actual worst-case text width with canvas instead — flip/lcd
  // build fixed-width per-digit DOM rather than plain text, so their
  // scrollWidth is already accurate and doesn't need this.
  let cw;
  if (clock.children.length) {
    cw = clock.scrollWidth;
  } else {
    const csRef = getComputedStyle(clock);
    const canvas = fitHeroClock._canvas || (fitHeroClock._canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = `${csRef.fontWeight} ${CLOCK_FIT_REF}px ${csRef.fontFamily}`;
    const wd = widestClockDigit(ctx);
    cw = measureClockTextWidth(ctx, csRef, clock.textContent.replace(/\d/g, wd));
  }
  const ch = clock.scrollHeight;
  let scale = 1;
  if (cw > 0 && ch > 0 && availW > 0 && availH > 0) scale = Math.min(availW / cw, availH / ch);
  const fontPx = Math.max(8, CLOCK_FIT_REF * scale * 0.99);
  clock.style.fontSize = fontPx + 'px';

  // Box-fit (above) sizes the clock's *line box* to the card — correct, and
  // what keeps this whole thing stable (the hero card's own height comes from
  // that box, so it must always converge to the same value on every pass).
  // But a line box is mostly invisible padding above/below the actual glyph
  // ink (numerals only reach ~73% of their line height), so flip/lcd — which
  // are literal filled shapes with no such padding — end up looking far
  // bigger at the "same" size. Recover that gap with a transform: it repaints
  // the ink larger without changing the box transform doesn't touch layout,
  // so it can never feed back into the ResizeObservers that sized the box.
  //
  // Wallpoet and Faster One (the neon clockFont picker's other two faces)
  // don't fit this safely: they're proportional fonts with a much wider
  // ink-to-height ratio than Monoton, so the enlargement this computes for
  // one moment's hero size can still overflow the card once the outer
  // fitToScreen loop — which this transform is deliberately built to never
  // feed back into — settles to a slightly different size a moment later.
  // Rather than chase that per-font, just skip the enlargement for them, same
  // as flip/lcd: a slightly smaller clock, never one clipped by the card.
  const font = document.documentElement.dataset.clockFont;
  const skipInkFill = ['flip', 'flip-white', 'lcd'].includes(clock.dataset.style)
    || (clock.dataset.style === 'neon' && (font === 'wallpoet' || font === 'fasterone'));
  clock.style.transform = skipInkFill ? '' : `scale(${inkFillScale(clock, fontPx, availW, availH)})`;
  requestAnimationFrame(() => { _fittingClock = false; });
}

// Which digit (0-9) actually needs the most horizontal room in a given,
// already-sized canvas font — the stand-in used for "worst case" width
// instead of assuming '8' is always the widest. That assumption holds for
// most numeral sets but not all of the neon faces (Wallpoet's "5" and "2",
// e.g., are both wider than its "8"), and substituting the wrong stand-in
// silently under-measures the worst case, so a real second later a
// genuinely wider digit rotates in and overflows the card.
function widestClockDigit(ctx) {
  let best = '8', bestW = -1;
  for (const d of '0123456789') {
    const w = ctx.measureText(d).width;
    if (w > bestW) { bestW = w; best = d; }
  }
  return best;
}

// True on-screen text width for the clock's plain-text styles: canvas
// measureText() only measures glyph advances, not the CSS letter-spacing
// the neon style adds between every character. Leaving that out
// under-measures the real rendered width by a few dozen px at clock sizes —
// enough on its own to tip a proportional neon font (Wallpoet, Faster One)
// into overflowing the card once it compounds with uneven digit widths.
function measureClockTextWidth(ctx, cs, text) {
  const m = ctx.measureText(text);
  const inkW = (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight ?? m.width);
  const letterSpacing = parseFloat(cs.letterSpacing) || 0;
  return inkW + Math.max(0, text.length - 1) * letterSpacing;
}

// How much bigger the clock's actual glyph ink can be drawn (via transform,
// centered on the already-correctly-sized box) before it would spill past
// the hero card's available width/height. 1 = no room, i.e. no-op.
function inkFillScale(clock, fontPx, availW, availH) {
  const text = clock.textContent || '';
  if (!text.trim()) return 1;
  const cs = getComputedStyle(clock);
  const canvas = inkFillScale._canvas || (inkFillScale._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `${cs.fontWeight} ${fontPx}px ${cs.fontFamily}`;
  // Canvas measureText doesn't honor font-variant-numeric: tabular-nums, so a
  // proportional font (most neon/display faces) can measure some digits
  // narrower/shorter than others even though every digit occupies the same
  // rendered box on screen. Measuring the literal current text would then
  // upscale based on today's digits and clip later when a wider one rotates
  // in — worst case "xx:xx:xx" using whichever digit is this font's widest.
  const wd = widestClockDigit(ctx);
  const sub = text.replace(/\d/g, wd);
  const inkW = measureClockTextWidth(ctx, cs, sub);
  const m = ctx.measureText(sub);
  const inkH = (m.actualBoundingBoxAscent || 0) + (m.actualBoundingBoxDescent || 0);
  if (!(inkW > 0) || !(inkH > 0)) return 1;
  // 0.94 safety margin: the ink isn't perfectly centered in its box (digits
  // sit slightly high, minimal descent), so leave a little breathing room
  // rather than fitting to the exact theoretical edge.
  const raw = Math.min(availW / inkW, availH / inkH) * 0.94;
  return Math.max(1, Math.min(raw, 1.6));
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
    return `<div class="ptile" data-name="${name}">
      <span class="pname">${label}</span>
      <span class="ptime tnum">${at}${aap ? `<span class="ampm">${aap}</span>` : ''}</span>
      </div>`;
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
  $('np-time').textContent = fmt12(t[next.name]);
  $('np-in').textContent = hrs > 0 ? `in ${hrs}h ${mins}m` : `in ${mins}m`;

  const span = next.min - prevMin, pct = Math.max(0, Math.min(1, (nowMin - prevMin) / span));
  $('arc').style.strokeDashoffset = String(188.5 * (1 - pct));
  $('arc-pct').textContent = Math.round(pct * 100) + '%';
  document.querySelectorAll('#prayers .ptile').forEach((el) =>
    el.classList.toggle('active', el.dataset.name === next.name));
}

// ---------- adhan scheduler ----------
// Warm the browser's cache for today's adhan/iqamah files ahead of time, so
// the actual play() at prayer time hits a cached file instead of racing a
// fresh network fetch (which is when a slow/flaky connection can make play()
// resolve — "not blocked by autoplay" — before any audio has really loaded,
// producing the overlay with no sound). Only 2-3 distinct files matter for a
// whole day, so this is cheap to redo whenever the muezzin/config changes.
function preloadAdhanAudio() {
  const muezzin = cfg.adhan?.muezzin || 'mishary';
  const srcs = [`/audio/${muezzin}.mp3`, `/audio/${muezzin}-fajr.mp3`];
  if (cfg.adhan?.iqamah?.chimeEnabled) srcs.push('/audio/iqamah.mp3');
  for (const src of srcs) {
    const a = new Audio();
    a.preload = 'auto';
    a.src = src;
    a.load();
  }
}

function checkAdhan(now) {
  if (!prayer || !cfg.adhan?.enabled) return;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dayTag = now.toISOString().slice(0, 10);
  if (now.getHours() === 0 && now.getMinutes() === 0) { fired.clear(); pending.clear(); }

  for (const name of PRAYERS) {
    // adhan at prayer time
    if (prayer.timings[name] === hhmm) {
      const fkey = `${dayTag}:${name}:adhan`;
      if (!fired.has(fkey) && !pending.has(fkey) && cfg.adhan.perPrayer?.[KEY[name]] !== false && !inQuiet(now)) {
        // Only mark as fired once playback actually starts — if the browser
        // blocks it (autoplay policy, no user gesture yet), leave it unmarked
        // so we keep retrying every tick until the user taps the sound-arm
        // overlay, instead of silently losing this adhan for the whole day.
        // `pending` guards the gap in between: without it, a slow-loading
        // file would get re-triggered (and its src reset, aborting playback)
        // on every 1s tick until it happened to finish loading in time.
        pending.add(fkey);
        const label = name === 'Dhuhr' ? prayer.dhuhrLabel : name;
        playAdhan(name === 'Fajr', () => { fired.add(fkey); pending.delete(fkey); }, label, () => pending.delete(fkey));
      }
    }
    // iqamah chime
    if (cfg.adhan.iqamah?.chimeEnabled && prayer.iqamah[name] === hhmm) {
      const fkey = `${dayTag}:${name}:iqamah`;
      if (!fired.has(fkey) && !pending.has(fkey) && cfg.adhan.perPrayer?.[KEY[name]] !== false && !inQuiet(now)) {
        pending.add(fkey);
        playIqamah(() => { fired.add(fkey); pending.delete(fkey); }, () => pending.delete(fkey));
      }
    }
  }
}

function playAdhan(isFajr, onPlaying, label, onSettled) {
  const name = label || (isFajr ? 'Fajr' : '');
  const muezzin = cfg.adhan?.muezzin || 'mishary';
  const el = $('audio-adhan');
  const src = isFajr ? `/audio/${muezzin}-fajr.mp3` : `/audio/${muezzin}.mp3`;
  el.src = src;
  el.volume = cfg.adhan?.volume ?? 0.85;
  const started = () => { showAdhanOverlay(name); if (onPlaying) onPlaying(); };
  play(el, started, () => { // if fajr file 404s, fall back to the regular adhan
    if (isFajr) { el.src = `/audio/${muezzin}.mp3`; play(el, started, onSettled); }
    else if (onSettled) onSettled();
  });
}
function playIqamah(onPlaying, onSettled) {
  const el = $('audio-iqamah');
  el.src = '/audio/iqamah.mp3';
  el.volume = cfg.adhan?.volume ?? 0.85;
  play(el, onPlaying, onSettled);
}
function play(el, onPlaying, onError) {
  const p = el.play();
  if (p?.then) {
    p.then(() => { if (onPlaying) onPlaying(); })
      .catch(() => { if (!soundArmed) $('sound-arm').classList.add('show'); if (onError) onError(); });
  } else if (onPlaying) onPlaying();   // very old browsers: play() returns undefined
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

// ---------- adhan "now playing" overlay ----------
function showAdhanOverlay(name) {
  $('adhan-now').textContent = name ? `Playing Adhan: ${name}` : 'Playing Adhan';
  $('adhan-overlay').classList.add('show');
}
function hideAdhanOverlay() { $('adhan-overlay').classList.remove('show'); }
function stopAdhan() {
  const el = $('audio-adhan');
  el.pause();
  el.currentTime = 0;
  hideAdhanOverlay();
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

// 5-day strip: weekday + condition icon + high/low. Uses daytime icons.
function renderForecast(days, conv) {
  const el = $('wx-forecast');
  if (!el) return;
  const todayISO = iso(new Date());
  el.innerHTML = days.slice(0, 5).map((d) => {
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
    await refreshConfig(); preloadAdhanAudio();
    await Promise.all([refreshPrayer(), refreshWeather(), refreshHadith()]);
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
