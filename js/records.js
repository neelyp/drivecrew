// Personal records and history roll-ups. Pure - tests/records.test.js.

const DAY_MS = 86_400_000;

export function summarize(trips) {
  const out = { trips: 0, distanceM: 0, durationS: 0, movingS: 0, elevationGainM: 0 };
  for (const t of trips) {
    out.trips++;
    out.distanceM += t.distanceM || 0;
    out.durationS += t.durationS || 0;
    out.movingS += t.movingS || 0;
    out.elevationGainM += t.elevationGainM || 0;
  }
  return out;
}

/** Start of the containing week (Monday) or month, in local time. */
export function periodStart(ms, period) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  if (period === 'month') {
    d.setDate(1);
  } else {
    const mondayOffset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - mondayOffset);
  }
  return d.getTime();
}

export function groupByPeriod(trips, period = 'week') {
  const buckets = new Map();
  for (const t of trips) {
    const key = periodStart(t.startedAt, period);
    const bucket = buckets.get(key) || { start: key, trips: 0, distanceM: 0, durationS: 0 };
    bucket.trips++;
    bucket.distanceM += t.distanceM || 0;
    bucket.durationS += t.durationS || 0;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.start - b.start);
}

/**
 * The best rolling window of `days`, anchored on each trip rather than on
 * calendar weeks - "most distance in any 7 days" is the interesting number.
 */
export function mostDistanceInWindow(trips, days = 7) {
  if (!trips.length) return null;
  const sorted = [...trips].sort((a, b) => a.startedAt - b.startedAt);
  const span = days * DAY_MS;
  let best = null;
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i].startedAt;
    let distanceM = 0;
    let tripCount = 0;
    for (let j = i; j < sorted.length && sorted[j].startedAt < from + span; j++) {
      distanceM += sorted[j].distanceM || 0;
      tripCount++;
    }
    if (!best || distanceM > best.distanceM) best = { from, to: from + span, distanceM, tripCount };
  }
  return best;
}

function bestBy(trips, pick, compare) {
  let best = null;
  for (const t of trips) {
    const value = pick(t);
    if (!Number.isFinite(value)) continue;
    if (!best || compare(value, best.value)) best = { value, tripId: t.id, at: t.startedAt };
  }
  return best;
}

const higher = (a, b) => a > b;
const lower = (a, b) => a < b;

/** Best-of across every trip, including the closed-course timing records. */
export function computeRecords(trips) {
  const accel = new Map();
  const rollon = new Map();
  const drag = new Map();
  const braking = new Map();

  for (const t of trips) {
    const p = t.performance;
    if (!p) continue;
    for (const a of p.accel || []) {
      const key = `${a.fromMs.toFixed(3)}>${a.toMs.toFixed(3)}`;
      const cur = accel.get(key);
      if (!cur || a.timeS < cur.timeS) accel.set(key, { ...a, tripId: t.id, at: t.startedAt });
    }
    for (const a of p.rollon || []) {
      const key = `${a.fromMs.toFixed(3)}>${a.toMs.toFixed(3)}`;
      const cur = rollon.get(key);
      if (!cur || a.timeS < cur.timeS) rollon.set(key, { ...a, tripId: t.id, at: t.startedAt });
    }
    for (const d of p.drag || []) {
      const key = d.distanceM.toFixed(3);
      const cur = drag.get(key);
      if (!cur || d.timeS < cur.timeS) drag.set(key, { ...d, tripId: t.id, at: t.startedAt });
    }
    for (const b of p.braking || []) {
      // Stopping distance is the meaningful record here, not elapsed time.
      const key = b.fromMs.toFixed(3);
      const cur = braking.get(key);
      if (!cur || b.distanceM < cur.distanceM) braking.set(key, { ...b, tripId: t.id, at: t.startedAt });
    }
  }

  return {
    topSpeed: bestBy(trips, (t) => t.topSpeedMs, higher),
    longestDistance: bestBy(trips, (t) => t.distanceM, higher),
    longestDuration: bestBy(trips, (t) => t.durationS, higher),
    highestClimb: bestBy(trips, (t) => t.elevationGainM, higher),
    peakG: bestBy(trips, (t) => t.peakG, higher),
    bestScore: bestBy(trips, (t) => t.score, higher),
    peakPowerHp: bestBy(trips, (t) => (t.performance ? t.performance.peakPowerHp : null), higher),
    shortestBraking: bestBy(
      trips,
      (t) => {
        const b = (t.performance && t.performance.braking) || [];
        return b.length ? Math.min(...b.map((x) => x.distanceM)) : null;
      },
      lower
    ),
    accel: [...accel.values()].sort((a, b) => a.toMs - b.toMs),
    rollon: [...rollon.values()].sort((a, b) => a.fromMs - b.fromMs),
    drag: [...drag.values()].sort((a, b) => a.distanceM - b.distanceM),
    braking: [...braking.values()].sort((a, b) => a.fromMs - b.fromMs),
    bestWeek: mostDistanceInWindow(trips, 7),
    totals: summarize(trips),
  };
}
