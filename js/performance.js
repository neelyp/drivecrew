// Closed-course performance timing: acceleration splits, roll-ons, drag-strip
// distances, braking distance, estimated power, and harsh-driving counts.
// Pure - no DOM, no browser APIs. Unit tested under tests/performance.test.js.
//
// Everything is derived from the same filtered GPS stream the trip engine uses,
// so accuracy is bounded by GPS: expect about +/- 0.2 s on a 0-60 and +/- 2 m on
// a braking distance. Good enough to compare runs against each other, not a dragstrip.

import { mphToMs, kmhToMs } from './units.js';
import { headingDeltaDeg } from './geo.js';

const WATTS_PER_HP = 745.699872;
const STOPPED_MS = 0.1;

/** Linear interpolation of the moment a value crosses `target` between two samples. */
function crossTime(t0, v0, t1, v1, target) {
  if (v1 === v0) return t1;
  const frac = (target - v0) / (v1 - v0);
  return t0 + frac * (t1 - t0);
}

function lerp(a, b, frac) {
  return a + (b - a) * frac;
}

/** Look up one acceleration result by its speed window. */
export function findAccel(list, fromMs, toMs, tol = 0.01) {
  if (!list) return null;
  return (
    list.find((x) => Math.abs(x.fromMs - fromMs) < tol && Math.abs(x.toMs - toMs) < tol) || null
  );
}

/**
 * Road-load power estimate at an instant, in crank horsepower.
 * P = inertia + aerodynamic drag + rolling resistance, divided by drivetrain loss.
 * A rough figure: it has no idea about gradient, wind, or payload.
 */
export function estimatePowerHp({ massKg, speedMs, accelMs2, cdA, crr, config }) {
  if (!massKg || !Number.isFinite(speedMs) || speedMs <= 0) return 0;
  const rho = config.AIR_DENSITY;
  const area = cdA ?? config.DEFAULT_CDA;
  const roll = crr ?? config.DEFAULT_CRR;
  const inertia = massKg * accelMs2 * speedMs;
  const drag = 0.5 * rho * area * speedMs ** 3;
  const rolling = roll * massKg * config.GRAVITY * speedMs;
  const watts = (inertia + drag + rolling) / config.DRIVETRAIN_EFFICIENCY;
  return Math.max(0, watts / WATTS_PER_HP);
}

export function createPerformanceDetector(config, vehicle = {}) {
  // Target windows are built for both unit systems so records survive a unit toggle.
  const accelTargets = [
    ...config.ACCEL_TARGETS_MPH.map((mph) => ({ fromMs: 0, toMs: mphToMs(mph) })),
    ...config.ACCEL_TARGETS_KMH.map((kmh) => ({ fromMs: 0, toMs: kmhToMs(kmh) })),
  ];
  const rollonTargets = [
    ...config.ROLLON_MPH.map(([a, b]) => ({ fromMs: mphToMs(a), toMs: mphToMs(b) })),
    ...config.ROLLON_KMH.map(([a, b]) => ({ fromMs: kmhToMs(a), toMs: kmhToMs(b) })),
  ];
  const brakeTargets = [
    { fromMs: mphToMs(config.BRAKE_FROM_MPH), toMs: 0 },
    { fromMs: kmhToMs(config.BRAKE_FROM_KMH), toMs: 0 },
  ];

  const best = { accel: new Map(), rollon: new Map(), drag: new Map(), braking: new Map() };
  const keyOf = (a, b) => `${a.toFixed(4)}>${b.toFixed(4)}`;

  let prev = null;
  let armed = false;          // a standing start has been seen
  let stopped = null;         // last sample at or below launch speed
  let launch = null;          // { t, distM } of the current standing-start run
  let runCrossed = new Set(); // targets already taken in this run
  const rollRuns = new Map();  // in-flight roll-on attempts
  const brakeRuns = new Map(); // in-flight braking attempts, one per entry speed

  let peakAccelMs2 = 0;
  let peakDecelMs2 = 0;
  let peakLateralG = 0;
  let peakPowerHp = vehicle.massKg ? 0 : null;
  const harsh = { accel: 0, brake: 0, corner: 0 };
  const inEvent = { accel: false, brake: false, corner: false };

  function keepBest(bucket, key, record) {
    const existing = bucket.get(key);
    if (!existing || record.timeS < existing.timeS) bucket.set(key, record);
  }

  function addSample({ t, speedMs, distM, headingDeg }) {
    if (!Number.isFinite(t) || !Number.isFinite(speedMs)) return;
    const v = Math.max(0, speedMs);
    const d = Number.isFinite(distM) ? distM : prev ? prev.distM : 0;

    if (prev) {
      const dt = (t - prev.t) / 1000;
      if (dt > 0) {
        const a = (v - prev.speedMs) / dt;
        if (a > peakAccelMs2) peakAccelMs2 = a;
        if (-a > peakDecelMs2) peakDecelMs2 = -a;

        // Harsh events are counted once per episode, not once per sample.
        if (a >= config.HARSH_ACCEL_MS2 && !inEvent.accel) { harsh.accel++; inEvent.accel = true; }
        if (a < config.HARSH_ACCEL_MS2 * 0.6) inEvent.accel = false;
        if (-a >= config.HARSH_BRAKE_MS2 && !inEvent.brake) { harsh.brake++; inEvent.brake = true; }
        if (-a < config.HARSH_BRAKE_MS2 * 0.6) inEvent.brake = false;

        // Lateral load from yaw rate: a_lat = v * omega.
        if (Number.isFinite(headingDeg) && Number.isFinite(prev.headingDeg) && v > 2) {
          const yawRate = Math.abs(headingDeltaDeg(prev.headingDeg, headingDeg)) * (Math.PI / 180) / dt;
          const latG = (v * yawRate) / config.GRAVITY;
          if (latG > peakLateralG) peakLateralG = latG;
          if (latG >= config.HARSH_CORNER_G && !inEvent.corner) { harsh.corner++; inEvent.corner = true; }
          if (latG < config.HARSH_CORNER_G * 0.6) inEvent.corner = false;
        }

        if (vehicle.massKg && a > 0) {
          const hp = estimatePowerHp({
            massKg: vehicle.massKg, speedMs: v, accelMs2: a,
            cdA: vehicle.cdA, crr: vehicle.crr, config,
          });
          if (hp > peakPowerHp) peakPowerHp = hp;
        }
      }
    }

    // --- standing start ---------------------------------------------------
    if (v <= config.LAUNCH_SPEED_MS) {
      armed = true;
      stopped = { t, speedMs: v, distM: d };
      launch = null;
      runCrossed = new Set();
    } else if (armed && stopped && !launch) {
      // Extrapolate back to a true standstill so the clock starts at zero speed,
      // rather than at whatever the first moving sample happened to read.
      const launchT = stopped.speedMs > 0
        ? crossTime(stopped.t, stopped.speedMs, t, v, 0)
        : stopped.t;
      launch = { t: launchT, distM: lerp(stopped.distM, d, 0) };
      armed = false;
    }

    if (prev && launch) {
      for (const target of accelTargets) {
        const key = keyOf(target.fromMs, target.toMs);
        if (runCrossed.has(key)) continue;
        if (prev.speedMs < target.toMs && v >= target.toMs) {
          const tc = crossTime(prev.t, prev.speedMs, t, v, target.toMs);
          runCrossed.add(key);
          keepBest(best.accel, key, {
            fromMs: target.fromMs, toMs: target.toMs,
            timeS: (tc - launch.t) / 1000, atT: Math.round(tc),
          });
        }
      }
      for (const dist of config.DRAG_DISTANCES_M) {
        const key = `d${dist.toFixed(3)}`;
        if (runCrossed.has(key)) continue;
        const covered = d - launch.distM;
        const coveredPrev = prev.distM - launch.distM;
        if (coveredPrev < dist && covered >= dist) {
          const frac = (dist - coveredPrev) / (covered - coveredPrev);
          const tc = lerp(prev.t, t, frac);
          runCrossed.add(key);
          keepBest(best.drag, key, {
            distanceM: dist,
            timeS: (tc - launch.t) / 1000,
            trapSpeedMs: lerp(prev.speedMs, v, frac),
            atT: Math.round(tc),
          });
        }
      }
    }

    // --- roll-ons ---------------------------------------------------------
    if (prev) {
      for (const target of rollonTargets) {
        const key = keyOf(target.fromMs, target.toMs);
        const open = rollRuns.get(key);
        if (!open) {
          if (prev.speedMs < target.fromMs && v >= target.fromMs) {
            rollRuns.set(key, { t: crossTime(prev.t, prev.speedMs, t, v, target.fromMs) });
          }
        } else if (v < target.fromMs - 0.01) {
          rollRuns.delete(key); // dropped out of the window: void
        } else if (prev.speedMs < target.toMs && v >= target.toMs) {
          const tc = crossTime(prev.t, prev.speedMs, t, v, target.toMs);
          keepBest(best.rollon, key, {
            fromMs: target.fromMs, toMs: target.toMs,
            timeS: (tc - open.t) / 1000, atT: Math.round(tc),
          });
          rollRuns.delete(key);
        }
      }

      // --- braking ---------------------------------------------------------
      for (const target of brakeTargets) {
        const key = keyOf(target.fromMs, target.toMs);
        const open = brakeRuns.get(key);
        if (!open) {
          if (prev.speedMs > target.fromMs && v <= target.fromMs) {
            const tc = crossTime(prev.t, prev.speedMs, t, v, target.fromMs);
            const frac = (tc - prev.t) / (t - prev.t || 1);
            brakeRuns.set(key, { t: tc, distM: lerp(prev.distM, d, frac), minSpeed: v });
          }
        } else {
          if (v > open.minSpeed + config.PERF_ABORT_RISE_MS) {
            brakeRuns.delete(key); // got back on the throttle: void
          } else {
            open.minSpeed = Math.min(open.minSpeed, v);
            if (v <= STOPPED_MS) {
              keepBest(best.braking, key, {
                fromMs: target.fromMs, toMs: 0,
                timeS: (t - open.t) / 1000,
                distanceM: Math.max(0, d - open.distM),
                atT: t,
              });
              brakeRuns.delete(key);
            }
          }
        }
      }
    }

    prev = { t, speedMs: v, distM: d, headingDeg };
  }

  function getResults() {
    return {
      accel: [...best.accel.values()].sort((a, b) => a.toMs - b.toMs),
      rollon: [...best.rollon.values()].sort((a, b) => a.fromMs - b.fromMs),
      drag: [...best.drag.values()].sort((a, b) => a.distanceM - b.distanceM),
      braking: [...best.braking.values()].sort((a, b) => a.fromMs - b.fromMs),
      peakAccelMs2, peakDecelMs2, peakLateralG,
      peakPowerHp: peakPowerHp === null ? null : peakPowerHp,
      harsh: { ...harsh },
    };
  }

  /**
   * Forget in-flight attempts but keep the records already set. Used when the
   * GPS signal breaks: a run we were half-way through can no longer be trusted.
   */
  function reset() {
    prev = null;
    armed = false;
    stopped = null;
    launch = null;
    runCrossed = new Set();
    rollRuns.clear();
    brakeRuns.clear();
    inEvent.accel = false;
    inEvent.brake = false;
    inEvent.corner = false;
  }

  return { addSample, getResults, reset };
}
