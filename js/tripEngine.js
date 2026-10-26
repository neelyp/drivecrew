// The trip state machine: turns a stream of GPS samples into trips.
//
// PURE MODULE. No DOM, no browser APIs, no storage, no clock of its own - every
// time it needs comes from the samples or from an explicit tick(). That is what
// makes it unit testable (tests/tripEngine.test.js) and what lets a future
// Capacitor build feed it background samples without changing a line in here.
//
// States: idle -> candidate -> recording -> (ended | discarded) -> idle

import { DEFAULTS } from './config.js';
import { haversineM, decimate } from './geo.js';
import { createPerformanceDetector } from './performance.js';
import { smoothnessScore } from './score.js';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function createTripEngine({ config = DEFAULTS, vehicle = {} } = {}) {
  let state = 'idle';
  let lastSeenT = null;   // every sample, accepted or not - keeps time monotonic
  let lastAcc = null;     // last accepted sample
  let candidate = null;   // { startT, samples[] } while confirming a start
  let trip = null;        // in-progress trip accumulator
  let stopStartT = null;  // when the current stop began
  let stopAccumS = 0;     // seconds genuinely spent below STOP_SPEED_MS
  let rawWindow = [];     // recent raw speeds, for the display median
  let ema = null;         // smoothed display speed
  let currentSpeed = 0;   // latest raw (unsmoothed) speed
  let peakG = 0;
  let absDistM = 0;       // distance since the engine started, for perf runs
  let perf = createPerformanceDetector(config, vehicle);

  function freshTrip(startSamples) {
    const t = {
      startedAt: startSamples[0].t,
      segments: [[]],
      distanceM: 0,
      topSpeedMs: 0,
      movingS: 0,
      stoppedS: 0,
      elevationGainM: 0,
      elevationLossM: 0,
      gapCount: 0,
      hadGap: false,
      rejected: 0,
      samples: 0,
    };
    // Replay the confirmation window so the trip really begins where it began.
    let prev = null;
    for (const s of startSamples) {
      absorb(t, s, prev ? haversineM(prev, s) : 0, false, prev);
      prev = s;
    }
    return t;
  }

  /** Fold one accepted sample into a trip accumulator. */
  function absorb(t, sample, legM, broke, prev) {
    if (broke) {
      t.segments.push([]);
      t.gapCount++;
      t.hadGap = true;
    } else {
      t.distanceM += legM;
    }
    t.segments[t.segments.length - 1].push(sample);
    t.samples++;

    if (!prev) return;
    const dt = (sample.t - prev.t) / 1000;
    if (!broke && dt > 0) {
      if (sample.speed > config.STOP_SPEED_MS) t.movingS += dt;
      else t.stoppedS += dt;
    }

    // Top speed is taken from unsmoothed readings, but only when two consecutive
    // samples agree closely - one freak sample must never set a record.
    const hi = Math.max(sample.speed, prev.speed);
    const lo = Math.min(sample.speed, prev.speed);
    if (hi > 0 && (hi - lo) / hi <= config.TOP_SPEED_CONFIRM_RATIO && hi > t.topSpeedMs) {
      t.topSpeedMs = hi;
      sample.keep = true; // survive route decimation so the map shows the peak
    }

    if (Number.isFinite(sample.alt) && Number.isFinite(prev.alt)) {
      const dAlt = sample.alt - prev.alt;
      if (dAlt > 0) t.elevationGainM += dAlt;
      else t.elevationLossM += -dAlt;
    }
  }

  function countRejected() {
    if (trip) trip.rejected++;
    else if (candidate) candidate.rejected = (candidate.rejected || 0) + 1;
  }

  function resetAll() {
    state = 'idle';
    trip = null;
    candidate = null;
    stopStartT = null;
    stopAccumS = 0;
    peakG = 0;
    lastAcc = null;
    rawWindow = [];
    ema = null;
    currentSpeed = 0;
    perf = createPerformanceDetector(config, vehicle);
  }

  function finish(endedAt, reason, { force = false } = {}) {
    if (state !== 'recording' || !trip) {
      resetAll();
      return [];
    }
    const t = trip;
    const durationS = Math.max(0, (endedAt - t.startedAt) / 1000);

    // Trim anything after the end time. A trip that auto-stopped is dated to
    // the moment the car stopped, so the minutes it then sat parked are not
    // part of it - they must not land in the route or in the time totals.
    const trimmed = t.segments
      .map((seg) => seg.filter((p) => p.t <= endedAt))
      .filter((seg) => seg.length > 0);

    // Recomputed from the trimmed route rather than carried in a counter, so
    // moving + stopped can never add up to more than the trip lasted. Time lost
    // to a signal gap belongs to neither, which is why this sums within
    // segments only.
    let movingS = 0;
    let stoppedS = 0;
    for (const seg of trimmed) {
      for (let i = 1; i < seg.length; i++) {
        const dt = (seg[i].t - seg[i - 1].t) / 1000;
        if (seg[i].speed > config.STOP_SPEED_MS) movingS += dt;
        else stoppedS += dt;
      }
    }

    const segments = trimmed.map((seg) =>
      decimate(seg, { minMs: config.POINT_MIN_MS, minM: config.POINT_MIN_M })
    );
    const performance = perf.getResults();

    const finished = {
      id: `trip-${t.startedAt}`,
      startedAt: t.startedAt,
      endedAt,
      durationS,
      distanceM: t.distanceM,
      topSpeedMs: t.topSpeedMs,
      movingS,
      stoppedS,
      // Average over time actually moving, which is what a driver means by it.
      avgSpeedMs: movingS > 0 ? t.distanceM / movingS : 0,
      overallAvgSpeedMs: durationS > 0 ? t.distanceM / durationS : 0,
      elevationGainM: t.elevationGainM,
      elevationLossM: t.elevationLossM,
      peakG,
      gapCount: t.gapCount,
      hadGap: t.hadGap,
      sampleCount: t.samples,
      rejectedCount: t.rejected,
      segments,
      performance,
      score: smoothnessScore({ harsh: performance.harsh, distanceM: t.distanceM }),
      vehicleId: vehicle.id ?? null,
      endReason: reason,
      favorite: false,
      note: '',
    };

    const events = [];
    if (!force && finished.distanceM < config.MIN_TRIP_DIST_M) {
      events.push({ type: 'tripDiscarded', reason: 'distance', trip: finished });
    } else if (!force && finished.durationS < config.MIN_TRIP_S) {
      events.push({ type: 'tripDiscarded', reason: 'duration', trip: finished });
    } else {
      events.push({ type: 'tripEnded', trip: finished });
    }
    resetAll();
    return events;
  }

  function addSample(raw) {
    const out = [];
    if (!raw || !Number.isFinite(raw.t)) return out;
    if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) {
      countRejected();
      return out;
    }
    // Timestamps must move forward; a replayed or stale fix is useless.
    if (lastSeenT !== null && raw.t <= lastSeenT) {
      countRejected();
      return out;
    }
    lastSeenT = raw.t;

    if (raw.acc != null && Number.isFinite(raw.acc) && raw.acc > config.MAX_ACC_M) {
      countRejected();
      return out;
    }

    // Prefer the receiver's own Doppler speed; fall back to position delta.
    let v;
    if (Number.isFinite(raw.speed) && raw.speed >= 0) {
      v = raw.speed;
    } else if (lastAcc) {
      const dt = (raw.t - lastAcc.t) / 1000;
      v = dt > 0 ? haversineM(lastAcc, raw) / dt : 0;
    } else {
      v = 0;
    }

    if (v > config.MAX_SPEED_MS) {
      countRejected();
      return out;
    }
    if (lastAcc) {
      const dt = (raw.t - lastAcc.t) / 1000;
      if (dt > 0 && Math.abs(v - lastAcc.speed) / dt > config.MAX_ACCEL_MS2) {
        countRejected();
        return out;
      }
    }

    // A blackout longer than the auto-stop timeout is the end of the trip,
    // dated to the last fix we trusted. The current sample then starts over.
    const gapS = lastAcc ? (raw.t - lastAcc.t) / 1000 : 0;
    let broke = false;
    if (lastAcc && gapS > config.GAP_S) {
      if (gapS > config.END_STOP_S) {
        out.push(...finish(lastAcc.t, 'gap'));
      } else {
        broke = true;
        perf.reset();
      }
    }

    const sample = {
      t: raw.t,
      lat: raw.lat,
      lon: raw.lon,
      speed: v,
      acc: Number.isFinite(raw.acc) ? raw.acc : null,
      alt: Number.isFinite(raw.alt) ? raw.alt : null,
      heading: Number.isFinite(raw.heading) ? raw.heading : null,
    };

    currentSpeed = v;
    rawWindow.push(v);
    if (rawWindow.length > config.SMOOTH_MEDIAN_WINDOW) rawWindow.shift();
    const med = median(rawWindow);
    ema = ema === null ? med : ema + config.SMOOTH_EMA_ALPHA * (med - ema);

    const legM = lastAcc && !broke ? haversineM(lastAcc, sample) : 0;
    absDistM += legM;
    perf.addSample({ t: sample.t, speedMs: v, distM: absDistM, headingDeg: sample.heading });

    const prev = lastAcc;
    lastAcc = sample;

    if (state === 'idle') {
      if (v >= config.START_SPEED_MS) {
        state = 'candidate';
        candidate = { startT: sample.t, samples: [sample] };
      }
      return out;
    }

    if (state === 'candidate') {
      if (v < config.START_SPEED_MS) {
        state = 'idle';
        candidate = null;
        return out;
      }
      candidate.samples.push(sample);
      if ((sample.t - candidate.startT) / 1000 >= config.START_CONFIRM_S) {
        trip = freshTrip(candidate.samples);
        if (candidate.rejected) trip.rejected += candidate.rejected;
        candidate = null;
        state = 'recording';
        out.push({ type: 'tripStarted', stats: getStats() });
      }
      return out;
    }

    // --- recording ---------------------------------------------------------
    absorb(trip, sample, legM, broke, broke ? null : prev);

    const dt = prev ? (sample.t - prev.t) / 1000 : 0;
    if (v < config.STOP_SPEED_MS) {
      if (stopStartT === null) stopStartT = sample.t;
      else if (prev && prev.speed < config.STOP_SPEED_MS && !broke) stopAccumS += dt;
    } else if (v >= config.START_SPEED_MS) {
      // Only genuinely driving again clears the timer. Crawling in traffic sits
      // between the two thresholds and holds it, so a slow queue is not an end.
      stopStartT = null;
      stopAccumS = 0;
    }

    if (stopStartT !== null && stopAccumS >= config.END_STOP_S) {
      out.push(...finish(stopStartT, 'auto'));
      return out;
    }

    out.push({ type: 'tripUpdated', stats: getStats() });
    return out;
  }

  /** Called on a timer by the UI: ends a trip when samples stop arriving. */
  function tick(now) {
    if (state !== 'recording' || !lastAcc) return [];
    const sinceLastS = (now - lastAcc.t) / 1000;
    if (stopStartT !== null && stopAccumS + sinceLastS >= config.END_STOP_S) {
      return finish(stopStartT, 'auto');
    }
    if (sinceLastS > config.END_STOP_S) return finish(lastAcc.t, 'gap');
    return [];
  }

  function endNow(t, opts = {}) {
    if (state !== 'recording' || !trip) return [];
    return finish(t ?? lastAcc.t, 'manual', opts);
  }

  function addMotion({ t, totalG }) {
    if (state !== 'recording' && state !== 'candidate') return;
    if (Number.isFinite(totalG) && totalG > peakG) peakG = totalG;
  }

  function getStats() {
    const durationS = trip && lastAcc ? Math.max(0, (lastAcc.t - trip.startedAt) / 1000) : 0;
    return {
      state,
      startedAt: trip ? trip.startedAt : null,
      durationS,
      distanceM: trip ? trip.distanceM : 0,
      topSpeedMs: trip ? trip.topSpeedMs : 0,
      movingS: trip ? trip.movingS : 0,
      stoppedS: trip ? trip.stoppedS : 0,
      avgSpeedMs: trip && trip.movingS > 0 ? trip.distanceM / trip.movingS : 0,
      currentSpeedMs: currentSpeed,
      displaySpeedMs: ema === null ? 0 : Math.max(0, ema),
      peakG,
      gapCount: trip ? trip.gapCount : 0,
      hadGap: trip ? trip.hadGap : false,
      sampleCount: trip ? trip.samples : 0,
      rejectedCount: trip ? trip.rejected : 0,
      elevationGainM: trip ? trip.elevationGainM : 0,
      elevationLossM: trip ? trip.elevationLossM : 0,
      performance: perf.getResults(),
      // Seconds until the auto-stop fires, for the UI countdown.
      stopInS: stopStartT === null ? null : Math.max(0, config.END_STOP_S - stopAccumS),
      lastFixAt: lastAcc ? lastAcc.t : null,
      lastAccuracyM: lastAcc ? lastAcc.acc : null,
      position: lastAcc ? { lat: lastAcc.lat, lon: lastAcc.lon } : null,
    };
  }

  /** A snapshot good enough to resurrect an interrupted trip from storage. */
  function getDraft() {
    if (state !== 'recording' || !trip) return null;
    const performance = perf.getResults();
    return {
      id: `trip-${trip.startedAt}`,
      draft: true,
      startedAt: trip.startedAt,
      endedAt: lastAcc ? lastAcc.t : trip.startedAt,
      durationS: lastAcc ? (lastAcc.t - trip.startedAt) / 1000 : 0,
      distanceM: trip.distanceM,
      topSpeedMs: trip.topSpeedMs,
      movingS: trip.movingS,
      stoppedS: trip.stoppedS,
      avgSpeedMs: trip.movingS > 0 ? trip.distanceM / trip.movingS : 0,
      elevationGainM: trip.elevationGainM,
      elevationLossM: trip.elevationLossM,
      peakG,
      gapCount: trip.gapCount,
      hadGap: trip.hadGap,
      sampleCount: trip.samples,
      rejectedCount: trip.rejected,
      segments: trip.segments
        .filter((seg) => seg.length > 0)
        .map((seg) => decimate(seg, { minMs: config.POINT_MIN_MS, minM: config.POINT_MIN_M })),
      performance,
      score: smoothnessScore({ harsh: performance.harsh, distanceM: trip.distanceM }),
      vehicleId: vehicle.id ?? null,
      endReason: 'draft',
      favorite: false,
      note: '',
    };
  }

  return {
    addSample,
    addMotion,
    tick,
    endNow,
    getState: () => state,
    getStats,
    getDraft,
  };
}
