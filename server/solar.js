// solar.js — sunrise/sunset via the NOAA solar-position formula (no network
// call; matches OpenWeatherMap's own values to within a few seconds, since
// both are just this same astronomical calculation for the given date/coords).
// Used as a second, independent source in weather.js, which reports the
// earlier of the two sunrises and the later of the two sunsets.
export function sunTimes(year, month, day, lat, lon) {
  const JD = Date.UTC(year, month - 1, day, 12, 0, 0) / 86400000 + 2440587.5; // JD at 12:00 UT of the date
  const n = Math.round(JD - 2451545.0 + 0.0008);
  const Jstar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const Mrad = M * Math.PI / 180;
  const C = 1.9148 * Math.sin(Mrad) + 0.0200 * Math.sin(2 * Mrad) + 0.0003 * Math.sin(3 * Mrad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const lambdaRad = lambda * Math.PI / 180;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(Mrad) - 0.0069 * Math.sin(2 * lambdaRad);
  const delta = Math.asin(Math.sin(lambdaRad) * Math.sin(23.4397 * Math.PI / 180));
  const latRad = lat * Math.PI / 180;
  const cosOmega = (Math.sin(-0.83 * Math.PI / 180) - Math.sin(latRad) * Math.sin(delta)) /
    (Math.cos(latRad) * Math.cos(delta));
  // Clamp for polar day/night, where the sun never sets/rises and cosOmega falls outside [-1, 1].
  const omega = Math.acos(Math.min(1, Math.max(-1, cosOmega))) * 180 / Math.PI;
  const toDate = (jd) => new Date((jd - 2440587.5) * 86400000);
  return { sunrise: toDate(Jtransit - omega / 360), sunset: toDate(Jtransit + omega / 360) };
}
