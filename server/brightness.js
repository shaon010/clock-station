// brightness.js — best-effort hardware backlight control, so dimming actually
// saves power instead of just painting a black overlay over a full-brightness
// panel. Windows (the tablet's OS per scripts/WINDOWS-SETUP.md) exposes this
// via the WmiMonitorBrightnessMethods WMI class, which covers built-in
// laptop/tablet panels; Linux (if the server is ever moved to a Pi, see the
// README) exposes it via /sys/class/backlight. Neither is guaranteed to exist
// on every device, so failures are logged (once per distinct level, so it's
// never spammy) and swallowed — the CSS overlay in display.js already
// handles the visual side regardless. Logging every attempt (success and
// failure) is deliberate: it's the easiest way to confirm on first run
// whether a given tablet's panel actually supports this.
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { readdir, readFile, writeFile } from 'node:fs/promises';

let lastPercent = null;

export function setBrightness(percent) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  if (pct === lastPercent) return;
  lastPercent = pct;

  const plat = platform();
  if (plat !== 'win32' && plat !== 'linux') return; // no hardware path on this OS; overlay-only

  const task = plat === 'win32' ? setWindowsBrightness(pct) : setLinuxBrightness(pct);

  task.then(
    () => console.log(`[brightness] hardware backlight set to ${pct}%`),
    (err) => console.warn(`[brightness] failed to set hardware backlight to ${pct}% (falling back to overlay-only dim):`, err.message)
  );
}

function setWindowsBrightness(pct) {
  return new Promise((resolve, reject) => {
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1,${pct})`
    ], (err) => err ? reject(err) : resolve());
  });
}

async function setLinuxBrightness(pct) {
  const base = '/sys/class/backlight';
  const devices = await readdir(base).catch(() => []);
  if (!devices.length) throw new Error('no /sys/class/backlight device found');
  const dev = `${base}/${devices[0]}`;
  const max = Number((await readFile(`${dev}/max_brightness`, 'utf8')).trim());
  const value = Math.round((pct / 100) * max);
  await writeFile(`${dev}/brightness`, String(value));
}
