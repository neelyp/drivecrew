// Unit conversion and display formatting. Pure - unit tested under tests/units.test.js.
// Internally the app stores SI only: metres, metres per second, seconds.
// `system` is 'imperial' (mph / mi) or 'metric' (km/h / km).

export const MPS_TO_MPH = 2.2369362920544;
export const MPS_TO_KMH = 3.6;
export const M_TO_MI = 1 / 1609.344;
export const M_TO_FT = 3.280839895;

export const msToMph = (ms) => ms * MPS_TO_MPH;
export const msToKmh = (ms) => ms * MPS_TO_KMH;
export const mphToMs = (mph) => mph / MPS_TO_MPH;
export const kmhToMs = (kmh) => kmh / MPS_TO_KMH;

export const mToMi = (m) => m * M_TO_MI;
export const mToKm = (m) => m / 1000;
export const mToFt = (m) => m * M_TO_FT;

export const speedIn = (ms, system) => (system === 'metric' ? msToKmh(ms) : msToMph(ms));
export const distanceIn = (m, system) => (system === 'metric' ? mToKm(m) : mToMi(m));
export const speedUnitLabel = (system) => (system === 'metric' ? 'km/h' : 'mph');
export const distanceUnitLabel = (system) => (system === 'metric' ? 'km' : 'mi');
export const shortDistanceUnitLabel = (system) => (system === 'metric' ? 'm' : 'ft');
export const shortDistanceIn = (m, system) => (system === 'metric' ? m : mToFt(m));

const safe = (n) => (Number.isFinite(n) ? n : 0);

export function formatSpeed(ms, system, decimals = 0) {
  const v = Math.max(0, speedIn(safe(ms), system));
  return v.toFixed(decimals);
}

export function formatDistance(m, system) {
  const v = Math.max(0, distanceIn(safe(m), system));
  return v < 10 ? v.toFixed(2) : v.toFixed(1);
}

/** Clock-style duration: m:ss, or h:mm:ss once it passes an hour. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(safe(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Wordy duration for summaries: 45s, 4m 5s, 1h 1m. */
export function formatDurationLong(seconds) {
  const total = Math.max(0, Math.floor(safe(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const formatG = (g) => `${Math.max(0, safe(g)).toFixed(2)}g`;
export const formatHp = (hp) => (Number.isFinite(hp) && hp > 0 ? String(Math.round(hp)) : '--');

/** "0-60 mph" style label for a speed target, in the user's system. */
export function accelLabel(targetMs, system) {
  return `0-${Math.round(speedIn(targetMs, system))} ${speedUnitLabel(system)}`;
}
