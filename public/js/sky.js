/* sky.js — the animated background. A single full-screen canvas behind the dock
   that paints a living sky driven by weather + time of day: a day/dusk/night/dawn
   gradient, sun or moon arcing across, drifting clouds, stars, rain, snow, fog,
   and lightning during storms. Content sits on top; the cards' backdrop-blur
   turns this into a soft frosted background.

   Kiosk-friendly: capped particle counts, framerate-independent motion, pauses
   when the tab is hidden, and falls back to a single static frame when the user
   prefers reduced motion. Exposes window.Sky.{init, set}. */

(function () {
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cv, ctx, W = 0, H = 0, dpr = 1;
  let running = false, lastT = 0;
  let cloudSprite = null, glowSprite = null;

  // ---- scene state (target = what weather wants; cur = eased-toward values) ----
  const state = { code: 0, isDay: true, sunrise: null, sunset: null };
  let scene = sceneFor(0);                 // {kind, cloudiness, rain, snow}
  const cur = { top: [10, 14, 34], bot: [22, 28, 56], celest: 0 };
  let target = { top: [10, 14, 34], bot: [22, 28, 56], celest: 0 };

  // particle pools
  let stars = [], clouds = [], drops = [], flakes = [], motes = [];
  let flash = 0, boltTimer = 3, bolt = null;
  let primed = false;              // snap to the right palette on first paint
  let lastPhase = null, phaseTimer = 0;   // tracks day/dawn/dusk/night so the sky
                                          // keeps drifting with the clock between
                                          // weather refreshes, not just when set() runs

  // ---------- public API ----------
  function init(canvas) {
    cv = canvas;
    ctx = cv.getContext('2d');
    resize();
    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) running = false;
      else if (!REDUCED) start();
    });
    set({});                                // default scene until weather loads
    if (REDUCED) drawStatic(); else start();
  }

  // Feed the current weather. Pass {code, isDay, sunrise, sunset}; any missing
  // field keeps its previous value. Sun/moon position is derived live from the
  // clock, so this only needs calling when the weather actually changes.
  function set(w) {
    if (w.code != null) state.code = w.code;
    if (w.isDay != null) state.isDay = !!w.isDay;
    if (w.sunrise !== undefined) state.sunrise = w.sunrise;
    if (w.sunset !== undefined) state.sunset = w.sunset;
    scene = sceneFor(state.code);
    rebuild();
    if (REDUCED) drawStatic();
  }

  // ---------- scene definition from a WMO weather code ----------
  function sceneFor(code) {
    const c = Number(code) || 0;
    if ([71, 73, 75, 77, 85, 86].includes(c))
      return { kind: 'snow', cloudiness: 0.7, snow: c >= 75 ? 1 : 0.6 };
    if ([95, 96, 99].includes(c))
      return { kind: 'storm', cloudiness: 0.95, rain: 1 };
    if ([51, 53, 55, 56, 57].includes(c))
      return { kind: 'rain', cloudiness: 0.75, rain: 0.4 };
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(c))
      return { kind: 'rain', cloudiness: 0.85, rain: c >= 65 || c === 82 ? 1 : 0.7 };
    if ([45, 48].includes(c))
      return { kind: 'fog', cloudiness: 0.8 };
    if (c === 3) return { kind: 'cloud', cloudiness: 0.9 };
    if (c === 2) return { kind: 'cloud', cloudiness: 0.45 };
    if (c === 1) return { kind: 'clear', cloudiness: 0.2 };
    return { kind: 'clear', cloudiness: 0.05 };            // 0 = clear
  }

  // ---------- time of day → phase, sun/moon position ----------
  function toMin(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return d.getHours() * 60 + d.getMinutes();
  }
  function sky() {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const sr = toMin(state.sunrise) ?? 6 * 60;
    const ss = toMin(state.sunset) ?? 18 * 60;
    const dawnA = sr - 35, dawnB = sr + 35, duskA = ss - 40, duskB = ss + 40;

    let phase, cx, cy, celestial;
    const dayP = clamp((nowMin - sr) / Math.max(1, ss - sr), -0.15, 1.15);
    // arc across the sky: x left→right, y dips low near the horizon at the ends
    const arc = (p) => ({ x: W * (0.12 + 0.76 * clamp(p, 0, 1)),
                          y: H * (0.66 - 0.5 * Math.sin(Math.PI * clamp(p, 0, 1))) });

    if (nowMin < dawnA || nowMin > duskB) {
      phase = 'night'; celestial = 'moon';
      const span = (sr + 1440) - ss;
      const p = nowMin > ss ? (nowMin - ss) / span : (nowMin + 1440 - ss) / span;
      ({ x: cx, y: cy } = arc(p));
    } else if (nowMin <= dawnB) {
      phase = 'dawn'; celestial = 'sun'; ({ x: cx, y: cy } = arc(dayP));
    } else if (nowMin < duskA) {
      phase = 'day'; celestial = 'sun'; ({ x: cx, y: cy } = arc(dayP));
    } else {
      phase = 'dusk'; celestial = 'sun'; ({ x: cx, y: cy } = arc(dayP));
    }
    return { phase, celestial, cx, cy };
  }

  // ---------- palettes ----------
  // Dark palette (most themes) and a light, airy variant for light-background
  // themes (Daylight/Paper) so their dark text stays legible over the sky.
  const PAL = {
    night: [[9, 13, 33], [24, 30, 58]],
    dawn:  [[42, 34, 78], [232, 146, 116]],
    day:   [[44, 112, 190], [150, 200, 240]],
    dusk:  [[46, 30, 66], [230, 122, 84]],
  };
  const PAL_LIGHT = {
    night: [[92, 106, 140], [176, 190, 214]],
    dawn:  [[168, 166, 200], [246, 200, 176]],
    day:   [[126, 178, 226], [206, 228, 246]],
    dusk:  [[172, 150, 176], [246, 190, 160]],
  };
  const light = () => ['daylight', 'paper'].includes(document.documentElement.dataset.theme);

  function palette(phase) {
    const p = (light() ? PAL_LIGHT : PAL)[phase];
    let top = p[0].slice(), bot = p[1].slice();
    // weather desaturates / darkens the base sky
    const gray = light() ? [182, 191, 206] : [84, 94, 116];
    const slate = light() ? [150, 160, 176] : [58, 68, 86];
    if (scene.kind === 'fog') {
      top = blend(top, gray, scene.cloudiness * 0.6); bot = blend(bot, gray, scene.cloudiness * 0.6);
    } else if (scene.kind === 'cloud') {
      // keep more of the underlying sky so the clouds have something to read against
      top = blend(top, gray, scene.cloudiness * 0.42); bot = blend(bot, gray, scene.cloudiness * 0.5);
    } else if (scene.kind === 'rain') {
      top = blend(top, slate, 0.55); bot = blend(bot, slate, 0.45);
    } else if (scene.kind === 'storm') {
      top = blend(top, slate, 0.72); bot = blend(bot, slate, 0.6);
    } else if (scene.kind === 'snow') {
      const pale = light() ? [212, 220, 232] : [150, 162, 182];
      top = blend(top, pale, 0.35); bot = blend(bot, pale, 0.3);
    }
    return { top, bot };
  }

  // ---------- (re)build particle pools when the scene changes ----------
  function rebuild() {
    const area = W * H;
    const s = sky();
    lastPhase = s.phase;
    const p = palette(s.phase);
    target.top = p.top; target.bot = p.bot;
    // celestial visibility fades out under thick cloud / precip
    const vis = { clear: 1, cloud: 0.2, fog: 0.1, rain: 0.2, storm: 0.12, snow: 0.4 }[scene.kind] ?? 1;
    target.celest = vis * (scene.cloudiness < 0.5 ? 1 : 0.6);
    if (!primed) {                        // first update: no wrong-palette fade-in
      cur.top = target.top.slice(); cur.bot = target.bot.slice(); cur.celest = target.celest;
      primed = true;
    }

    // clouds
    const nClouds = Math.round(scene.cloudiness * 6);
    clouds = Array.from({ length: nClouds }, () => spawnCloud(true));

    // stars — only when it's dark and the sky is fairly clear
    const dark = s.phase === 'night' ? 1 : (s.phase === 'dawn' || s.phase === 'dusk') ? 0.35 : 0;
    const starA = dark * (1 - scene.cloudiness) * (light() ? 0.4 : 1);
    const nStars = starA > 0.02 ? Math.min(180, Math.round(area / 9000)) : 0;
    stars = Array.from({ length: nStars }, () => ({
      x: Math.random() * W, y: Math.random() * H * 0.7, r: Math.random() * 1.3 + 0.3,
      base: starA * (0.5 + Math.random() * 0.5), tw: Math.random() * Math.PI * 2,
    }));

    // rain
    const nRain = scene.rain ? Math.min(420, Math.round(scene.rain * area / 5200)) : 0;
    drops = Array.from({ length: nRain }, () => spawnDrop(true));

    // snow
    const nSnow = scene.snow ? Math.min(260, Math.round(scene.snow * area / 7000)) : 0;
    flakes = Array.from({ length: nSnow }, () => spawnFlake(true));

    // dust motes — a touch of life on clear days
    const nMotes = (scene.kind === 'clear' && s.phase !== 'night') ? Math.min(50, Math.round(area / 34000)) : 0;
    motes = Array.from({ length: nMotes }, () => ({
      x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.6 + 0.6,
      vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6, tw: Math.random() * Math.PI * 2,
    }));
  }

  function spawnCloud(anywhere) {
    return {
      x: anywhere ? Math.random() * W : -0.28 * W,
      y: H * (0.04 + Math.random() * 0.42),
      s: 0.75 + Math.random() * 0.85,
      v: (8 + Math.random() * 16) * (scene.kind === 'storm' ? 1.8 : 1),
      a: 0.74 + Math.random() * 0.21,
    };
  }
  function spawnDrop(anywhere) {
    const speed = 700 + Math.random() * 450 + (scene.kind === 'storm' ? 350 : 0);
    return {
      x: Math.random() * (W + 200) - 100, y: anywhere ? Math.random() * H : -20,
      len: 8 + Math.random() * 12 + scene.rain * 6, v: speed,
    };
  }
  function spawnFlake(anywhere) {
    return {
      x: Math.random() * W, y: anywhere ? Math.random() * H : -10,
      r: 1 + Math.random() * 2.4, v: 22 + Math.random() * 40,
      sway: 12 + Math.random() * 26, ph: Math.random() * Math.PI * 2,
    };
  }

  // ---------- sprites (drawn once, blitted each frame) ----------
  function buildSprites() {
    // soft round glow for the sun / moon
    const g = document.createElement('canvas'); g.width = g.height = 256;
    const gc = g.getContext('2d');
    const rg = gc.createRadialGradient(128, 128, 0, 128, 128, 128);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.18, 'rgba(255,255,255,0.9)');
    rg.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    gc.fillStyle = rg; gc.fillRect(0, 0, 256, 256);
    glowSprite = g;

    // fluffy, defined cloud: an underside shadow for volume + a dense white body
    // with a crisp-ish edge, so it reads as a cloud rather than a hazy smear.
    const c = document.createElement('canvas'); c.width = 300; c.height = 180;
    const cc = c.getContext('2d');
    const blobs = [[86, 84, 48], [150, 66, 60], [214, 84, 48], [120, 96, 44], [182, 98, 44], [150, 100, 54]];
    for (const [x, y, r] of blobs) {          // soft shadow along the flat bottom
      const sh = cc.createRadialGradient(x, y + r * 0.5, 0, x, y + r * 0.5, r);
      sh.addColorStop(0, 'rgba(66,76,98,0.3)');
      sh.addColorStop(1, 'rgba(66,76,98,0)');
      cc.fillStyle = sh; cc.beginPath(); cc.arc(x, y + r * 0.35, r, 0, 7); cc.fill();
    }
    for (const [x, y, r] of blobs) {          // opaque body, defined falloff
      const bg = cc.createRadialGradient(x, y, 0, x, y, r);
      bg.addColorStop(0, 'rgba(255,255,255,1)');
      bg.addColorStop(0.62, 'rgba(255,255,255,0.96)');
      bg.addColorStop(0.88, 'rgba(255,255,255,0.35)');
      bg.addColorStop(1, 'rgba(255,255,255,0)');
      cc.fillStyle = bg; cc.beginPath(); cc.arc(x, y, r, 0, 7); cc.fill();
    }
    cloudSprite = c;
  }

  // ---------- loop ----------
  function start() {
    if (running) return;
    running = true; lastT = performance.now();
    requestAnimationFrame(frame);
  }
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - lastT) / 1000);   // clamp after a stall
    lastT = t;
    step(dt); draw();
    requestAnimationFrame(frame);
  }

  function step(dt) {
    // Re-check the time-of-day phase (day/dawn/dusk/night) every few seconds so
    // the sky keeps drifting through sunrise/sunset on its own — rebuild() only
    // otherwise runs when weather refreshes (every 10min) or config changes.
    phaseTimer += dt;
    if (phaseTimer > 5) {
      phaseTimer = 0;
      if (sky().phase !== lastPhase) rebuild();
    }

    // ease palette + celestial toward the target scene
    for (let i = 0; i < 3; i++) {
      cur.top[i] += (target.top[i] - cur.top[i]) * Math.min(1, dt * 1.2);
      cur.bot[i] += (target.bot[i] - cur.bot[i]) * Math.min(1, dt * 1.2);
    }
    cur.celest += (target.celest - cur.celest) * Math.min(1, dt * 1.2);

    for (const c of clouds) { c.x += c.v * dt; if (c.x - 150 * c.s > W) { Object.assign(c, spawnCloud(false)); } }
    const wind = scene.kind === 'storm' ? 260 : 90;
    for (const d of drops) { d.y += d.v * dt; d.x += wind * dt; if (d.y > H + 20) Object.assign(d, spawnDrop(false)); }
    for (const f of flakes) { f.ph += dt; f.y += f.v * dt; f.x += Math.sin(f.ph) * f.sway * dt; if (f.y > H + 10) Object.assign(f, spawnFlake(false)); }
    for (const m of motes) { m.x += m.vx * dt; m.y += m.vy * dt; m.tw += dt * 2; if (m.x < 0) m.x += W; if (m.x > W) m.x -= W; if (m.y < 0) m.y += H; if (m.y > H) m.y -= H; }

    // lightning during storms
    if (scene.kind === 'storm') {
      boltTimer -= dt;
      if (boltTimer <= 0) { strike(); boltTimer = 2.5 + Math.random() * 6; }
    }
    if (flash > 0) flash = Math.max(0, flash - dt * 3.2);
    if (bolt && (bolt.life -= dt) <= 0) bolt = null;
  }

  function strike() {
    flash = 0.9;
    const x = W * (0.2 + Math.random() * 0.6);
    const pts = [[x, 0]];
    let y = 0;
    while (y < H * 0.6) { y += H * (0.05 + Math.random() * 0.08); pts.push([x + (Math.random() - 0.5) * 90, y]); }
    bolt = { pts, life: 0.18 };
  }

  // ---------- draw ----------
  function draw() {
    const s = sky();
    // sky gradient
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgb(cur.top));
    g.addColorStop(1, rgb(cur.bot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // stars (twinkle)
    if (stars.length) {
      for (const st of stars) {
        st.tw += 0.02;
        const a = st.base * (0.55 + 0.45 * Math.sin(st.tw));
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // sun / moon
    if (cur.celest > 0.02 && s.cy < H * 0.9) {
      const warm = s.celestial === 'sun';
      const isDayGlow = warm && s.phase === 'day';
      const R = warm ? (isDayGlow ? 120 : 230) : 150;
      // daytime sun sits on an already-bright sky, so skip the additive "lighter"
      // blend there (it was washing the whole screen toward white/hazy) and keep
      // it for dawn/dusk/night where the darker backdrop needs the extra glow.
      ctx.globalAlpha = isDayGlow ? cur.celest * 0.55 : cur.celest;
      ctx.globalCompositeOperation = isDayGlow ? 'source-over' : 'lighter';
      drawTinted(glowSprite, s.cx - R, s.cy - R, R * 2, R * 2,
        warm ? (s.phase === 'day' ? [255, 236, 180] : [255, 180, 120]) : [200, 214, 245]);
      // crisp disc
      ctx.globalAlpha = cur.celest;
      ctx.fillStyle = warm ? (s.phase === 'day' ? '#fff6de' : '#ffd9a8') : '#e9eefb';
      ctx.beginPath(); ctx.arc(s.cx, s.cy, warm ? 26 : 20, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // clouds
    if (clouds.length && cloudSprite) {
      for (const c of clouds) {
        ctx.globalAlpha = c.a * (scene.kind === 'storm' ? 0.92 : 0.85);
        const w = 300 * c.s, h = 180 * c.s;
        ctx.drawImage(cloudSprite, c.x - w / 2, c.y - h / 2, w, h);
      }
      ctx.globalAlpha = 1;
    }

    // rain
    if (drops.length) {
      ctx.strokeStyle = light() ? 'rgba(90,110,140,0.5)' : 'rgba(190,210,235,0.5)';
      ctx.lineWidth = 1.1; ctx.lineCap = 'round';
      const wind = scene.kind === 'storm' ? 0.32 : 0.12;
      ctx.beginPath();
      for (const d of drops) { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.len * wind, d.y - d.len); }
      ctx.stroke();
    }

    // snow
    if (flakes.length) {
      ctx.fillStyle = light() ? 'rgba(235,242,250,0.9)' : 'rgba(255,255,255,0.9)';
      for (const f of flakes) { ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
    }

    // motes
    if (motes.length) {
      ctx.fillStyle = light() ? 'rgba(255,240,200,0.7)' : 'rgba(255,244,214,0.6)';
      for (const m of motes) {
        ctx.globalAlpha = 0.3 + 0.35 * Math.sin(m.tw);
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // fog — soft drifting scrim near the ground
    if (scene.kind === 'fog') {
      const fg = ctx.createLinearGradient(0, H * 0.4, 0, H);
      const base = light() ? '210,214,222' : '150,158,172';
      fg.addColorStop(0, `rgba(${base},0)`);
      fg.addColorStop(1, `rgba(${base},0.5)`);
      ctx.fillStyle = fg; ctx.fillRect(0, H * 0.4, W, H * 0.6);
    }

    // lightning
    if (flash > 0) {
      ctx.fillStyle = `rgba(210,225,255,${flash * 0.45})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (bolt) {
      ctx.strokeStyle = 'rgba(235,242,255,0.95)'; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(bolt.pts[0][0], bolt.pts[0][1]);
      for (const [x, y] of bolt.pts) ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  function drawStatic() { if (ctx) draw(); }   // reduced-motion: one frame

  // draw a white sprite tinted to `col` using an offscreen buffer
  let tintBuf = null;
  function drawTinted(sprite, x, y, w, h, col) {
    if (!tintBuf) { tintBuf = document.createElement('canvas'); }
    tintBuf.width = sprite.width; tintBuf.height = sprite.height;
    const tc = tintBuf.getContext('2d');
    tc.clearRect(0, 0, sprite.width, sprite.height);
    tc.drawImage(sprite, 0, 0);
    tc.globalCompositeOperation = 'source-in';
    tc.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    tc.fillRect(0, 0, sprite.width, sprite.height);
    ctx.drawImage(tintBuf, x, y, w, h);
  }

  // ---------- resize ----------
  function resize() {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!cloudSprite) buildSprites();
    rebuild();
    if (REDUCED) drawStatic();
  }

  // ---------- tiny helpers ----------
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function blend(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgb(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }

  window.Sky = { init, set };
})();
