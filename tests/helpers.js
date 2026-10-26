// Synthetic track builders shared by the unit tests.
import { haversineM } from '../js/geo.js';

const ORIGIN = { lat: 40.0, lon: -74.0 };
// Metres per degree of latitude at the origin - we drive due north so only lat moves.
const M_PER_DEG_LAT = haversineM(ORIGIN, { lat: 40.001, lon: -74.0 }) / 0.001;

/** Turn a list of {t, speed} into real lat/lon samples driving due north. */
export function trackFromSpeeds(speeds, { startT = 0, acc = 5, alt = 100 } = {}) {
  let dist = 0;
  const out = [];
  for (let i = 0; i < speeds.length; i++) {
    const { t, speed } = speeds[i];
    if (i > 0) {
      const dt = (t - speeds[i - 1].t) / 1000;
      // Trapezoidal integration so distance matches the speed profile closely.
      dist += ((speed + speeds[i - 1].speed) / 2) * dt;
    }
    out.push({
      t: startT + t,
      lat: ORIGIN.lat + dist / M_PER_DEG_LAT,
      lon: ORIGIN.lon,
      speed,
      acc,
      alt,
      heading: 0,
    });
  }
  return out;
}

/** Constant speed for a number of seconds at 1 Hz. */
export function cruise(speedMs, seconds, startT = 0) {
  return Array.from({ length: seconds }, (_, i) => ({ t: startT + i * 1000, speed: speedMs }));
}

/** Constant acceleration from v0, 1 Hz, `seconds` long. */
export function accelerate(v0, accelMs2, seconds, startT = 0) {
  return Array.from({ length: seconds + 1 }, (_, i) => ({
    t: startT + i * 1000,
    speed: Math.max(0, v0 + accelMs2 * i),
  }));
}

/** Join speed segments end to end, keeping timestamps monotonic. */
export function joinSpeeds(...segments) {
  const out = [];
  let offset = 0;
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const base = seg[0].t;
    for (const s of seg) out.push({ t: offset + (s.t - base), speed: s.speed });
    offset = out[out.length - 1].t + 1000;
  }
  return out;
}

/** Samples for a constant-acceleration launch, with exact distance. */
export function launchSamples(accelMs2, seconds, hz = 1) {
  const step = 1000 / hz;
  const n = Math.floor(seconds * hz) + 1;
  return Array.from({ length: n }, (_, i) => {
    const t = (i * step) / 1000;
    return { t: i * step, speedMs: accelMs2 * t, distM: 0.5 * accelMs2 * t * t };
  });
}

/** Samples for a constant-deceleration stop from v0, ending at exactly zero. */
export function brakeSamples(v0, decelMs2, hz = 1) {
  const stopT = v0 / decelMs2;
  const step = 1000 / hz;
  const out = [];
  for (let t = 0; t < stopT; t += step / 1000) {
    out.push({ t: t * 1000, speedMs: v0 - decelMs2 * t, distM: v0 * t - 0.5 * decelMs2 * t * t });
  }
  const dStop = v0 * stopT - 0.5 * decelMs2 * stopT * stopT;
  out.push({ t: stopT * 1000, speedMs: 0, distM: dStop });
  out.push({ t: (stopT + 1) * 1000, speedMs: 0, distM: dStop });
  return out;
}

/** A minimal finished-trip object for tests that only need the summary fields. */
export function makeTrip(over = {}) {
  return {
    id: over.id || `trip-${over.startedAt || 1000}`,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_900_000,
    durationS: 900,
    distanceM: 12_000,
    topSpeedMs: 30,
    movingS: 800,
    stoppedS: 100,
    avgSpeedMs: 15,
    overallAvgSpeedMs: 13.3,
    elevationGainM: 50,
    elevationLossM: 40,
    peakG: 0.6,
    gapCount: 0,
    hadGap: false,
    sampleCount: 900,
    rejectedCount: 0,
    score: 95,
    vehicleId: null,
    endReason: 'auto',
    favorite: false,
    note: '',
    performance: { accel: [], rollon: [], drag: [], braking: [], peakAccelMs2: 3, peakDecelMs2: 3, peakLateralG: 0.3, peakPowerHp: null, harsh: { accel: 0, brake: 0, corner: 0 } },
    segments: [[
      { t: 1_700_000_000_000, lat: 40.0, lon: -74.0, speed: 0, alt: 10, acc: 5 },
      { t: 1_700_000_060_000, lat: 40.01, lon: -74.0, speed: 20, alt: 20, acc: 5 },
      { t: 1_700_000_120_000, lat: 40.02, lon: -74.0, speed: 30, alt: 15, acc: 5 },
    ]],
    ...over,
  };
}
