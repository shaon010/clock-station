// server.js — the whole backend: static files, JSON API, and an SSE hub that
// pushes "changed" to every connected display the instant settings are saved.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { setDefaultResultOrder } from 'node:dns';
import { getConfig, updateConfig, replaceConfig, ROOT } from './config.js';
import { computePrayerTimes, METHOD_KEYS } from './prayer.js';
import { getWeather } from './weather.js';
import { scheduleHijriRefresh } from './hijri.js';

// Load .env (if present) so local runs don't need `export` every time —
// hosts like Render set real env vars directly, so this is a no-op there.
try {
  const envFile = await readFile(join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  }
} catch {}

// Some PaaS hosts (Render included) route IPv6 egress that's flaky while
// IPv4 works fine — undici's fetch can fail outright instead of falling
// back, so prefer IPv4 resolution for outbound requests everywhere.
setDefaultResultOrder('ipv4first');

const PORT = process.env.PORT || 8080;
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon'
};

// ---- SSE hub -------------------------------------------------------------
const clients = new Set();
function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

// ---- helpers -------------------------------------------------------------
function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function lanIP() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}
// If the request carries lat/lon (the display device's own geolocation), use it
// as the primary location; otherwise fall back to the configured location.
function withLocation(cfg, url) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return cfg;
  const name = url.searchParams.get('name') || cfg.location.name;
  return { ...cfg, location: { lat, lon, name } };
}
async function serveStatic(res, urlPath) {
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC, safe);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(filePath);
    const headers = { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' };
    // Audio files are served with no validators (no ETag/Last-Modified), so
    // without an explicit freshness lifetime the browser re-fetches them over
    // the network on every single play() — right when a slow/flaky fetch is
    // most likely to make automatic adhan playback silently fail. They're
    // static assets that rarely change, so let the browser cache them.
    if (extname(filePath) === '.mp3') headers['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// deterministic "hadith of the day": stable per calendar day, cycles all before repeat
async function hadithToday() {
  let list = [];
  try { list = JSON.parse(await readFile(join(ROOT, 'data', 'hadith.json'), 'utf8')); } catch {}
  if (!Array.isArray(list) || list.length === 0) return { empty: true, total: 0 };
  const dayNo = Math.floor(Date.now() / 86400000);
  const item = list[dayNo % list.length];
  return { ...item, total: list.length };
}

// ---- request handler -----------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // Health check for uptime monitors (e.g. UptimeRobot) to keep free hosts awake.
    // Uptime monitors often probe with HEAD instead of GET, so answer both.
    if (path === '/health' && method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (path === '/health' && method === 'GET') return sendJSON(res, { ok: true });

    // Pages
    if (path === '/' && method === 'GET') return serveStatic(res, 'display.html');
    if (path === '/settings' && method === 'GET') return serveStatic(res, 'settings.html');

    // SSE stream
    if (path === '/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    // API
    if (path === '/api/config' && method === 'GET') return sendJSON(res, await getConfig());
    if (path === '/api/config' && method === 'PUT') {
      const cfg = await updateConfig(await readBody(req));
      broadcast('config-changed'); return sendJSON(res, cfg);
    }
    if (path === '/api/backup' && method === 'GET') return sendJSON(res, await getConfig());
    if (path === '/api/backup' && method === 'PUT') {
      const cfg = await replaceConfig(await readBody(req));
      broadcast('config-changed'); return sendJSON(res, cfg);
    }

    if (path === '/api/events' && method === 'POST') {
      const ev = await readBody(req);
      if (!ev.title || !ev.date) return sendJSON(res, { error: 'title and date required' }, 400);
      const cfg = await getConfig();
      const events = [...cfg.events, {
        id: Date.now(), title: String(ev.title), date: ev.date,
        time: ev.time || null, memberName: ev.memberName || '', repeatYearly: !!ev.repeatYearly
      }];
      const next = await updateConfig({ events });
      broadcast('config-changed'); return sendJSON(res, next);
    }
    if (path === '/api/events' && method === 'DELETE') {
      const id = Number(url.searchParams.get('id'));
      const cfg = await getConfig();
      const next = await updateConfig({ events: cfg.events.filter((e) => e.id !== id) });
      broadcast('config-changed'); return sendJSON(res, next);
    }

    if (path === '/api/prayer-times' && method === 'GET') {
      const cfg = await getConfig();
      const dateStr = url.searchParams.get('date');
      const date = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();
      return sendJSON(res, await computePrayerTimes(withLocation(cfg, url), date, !dateStr));
    }

    if (path === '/api/weather' && method === 'GET') {
      return sendJSON(res, await getWeather(withLocation(await getConfig(), url)));
    }

    if (path === '/api/hadith/today' && method === 'GET') {
      return sendJSON(res, await hadithToday());
    }

    // Fire a test adhan on the display(s) — the button lives in settings, but the
    // sound must come out of the display device, so we push it over SSE.
    if (path === '/api/test-adhan' && method === 'POST') {
      const body = await readBody(req);
      broadcast('test-adhan', { which: body.which === 'fajr' ? 'fajr' : 'regular' });
      return sendJSON(res, { ok: true });
    }

    // Force the display(s) to reload — handy after a code update, or if a
    // display is stuck, without walking over to it.
    if (path === '/api/reload' && method === 'POST') {
      broadcast('reload');
      return sendJSON(res, { ok: true });
    }

    if (path === '/api/audio-list' && method === 'GET') {
      let files = [];
      try {
        files = (await readdir(join(PUBLIC, 'audio')))
          .filter((f) => f.toLowerCase().endsWith('.mp3'));
      } catch {}
      return sendJSON(res, { files });
    }

    if (path === '/api/net-info' && method === 'GET') {
      const ip = lanIP();
      return sendJSON(res, {
        ip, port: PORT,
        displayUrl: `http://${ip}:${PORT}/`,
        settingsUrl: `http://${ip}:${PORT}/settings`,
        methods: METHOD_KEYS
      });
    }

    // Geocoding proxy (used by settings location search) — keeps CORS simple.
    if (path === '/api/geocode' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5`);
        return sendJSON(res, await r.json());
      } catch { return sendJSON(res, { results: [] }); }
    }

    // Reverse geocoding proxy — turns the display device's coordinates into a
    // human place name for the location label. Free, no API key.
    if (path === '/api/reverse-geocode' && method === 'GET') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendJSON(res, { name: '' });
      try {
        const r = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
          { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        const city = j.city || j.locality || '';
        const region = j.principalSubdivision || j.countryName || '';
        const name = city || region || '';
        return sendJSON(res, { name: city && region && city !== region ? `${city}, ${region}` : name });
      } catch { return sendJSON(res, { name: '' }); }
    }

    // Static assets (css/js/audio/fonts/img)
    if (method === 'GET') return serveStatic(res, path);

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    console.error('request error', err);
    sendJSON(res, { error: 'server error' }, 500);
  }
});

scheduleHijriRefresh();

server.listen(PORT, () => {
  const ip = lanIP();
  console.log(`\n  Clock Dock running`);
  console.log(`  • Display : http://localhost:${PORT}/   (kiosk this on the tablet)`);
  console.log(`  • Settings: http://${ip}:${PORT}/settings   (open on your phone)\n`);
});
