import test from 'node:test';
import assert from 'node:assert/strict';
import { createTripEngine } from '../js/tripEngine.js';
import { DEFAULTS } from '../js/config.js';
import { haversineM } from '../js/geo.js';
import { trackFromSpeeds } from './helpers.js';

/** Feed a whole track through a fresh engine and collect every event. */
function drive(samples, config = DEFAULTS) {
  const engine = createTripEngine({ config });
  const events = [];
  for (const s of samples) events.push(...engine.addSample(s));
  return { engine, events, ended: events.filter((e) => e.type === 'tripEnded') };
}

const speedsAt = (hz = 1) => ({ step: 1000 / hz });

/** Build a {t, speed} profile from [speed, seconds] legs with linear ramps. */
function profile(legs) {
  const out = [];
  let t = 0;
  let last = 0;
  for (const [target, seconds] of legs) {
    for (let i = 1; i <= seconds; i++) {
      out.push({ t, speed: last + ((target - last) * i) / seconds });
      t += 1000;
    }
    last = target;
  }
  return out;
}

// A realistic errand: pull away, cruise, sit at a red light, cruise, park.
const ERRAND = profile([
  [25, 10],   // accelerate to 25 m/s
  [25, 120],  // cruise
  [0, 10],    // slow to a stop
  [0, 60],    // red light, shorter than END_STOP_S
  [25, 10],   // away again
  [25, 120],  // cruise
  [0, 10],    // park
  [0, 200],   // engine off, longer than END_STOP_S
]);

test('a normal drive produces exactly one trip', () => {
  const { ended } = drive(trackFromSpeeds(ERRAND));
  assert.equal(ended.length, 1);
});

test('the red light does not split the drive in two', () => {
  const { events } = drive(trackFromSpeeds(ERRAND));
  assert.equal(events.filter((e) => e.type === 'tripStarted').length, 1);
});

test('trip distance is within 1% of the straight-line track length', () => {
  const samples = trackFromSpeeds(ERRAND);
  const { ended } = drive(samples);
  const expected = haversineM(samples[0], samples[samples.length - 1]);
  const got = ended[0].trip.distanceM;
  assert.ok(expected > 6000, `sanity: track should be long, got ${expected}`);
  assert.ok(Math.abs(got - expected) / expected < 0.01, `got ${got}, expected ~${expected}`);
});

test('top speed matches the cruise speed', () => {
  const { ended } = drive(trackFromSpeeds(ERRAND));
  assert.ok(Math.abs(ended[0].trip.topSpeedMs - 25) < 0.2, `got ${ended[0].trip.topSpeedMs}`);
});

test('the trip ends at the moment the final stop began, not when the timer expired', () => {
  const samples = trackFromSpeeds(ERRAND);
  const { ended } = drive(samples);
  // The last sample under STOP_SPEED_MS that begins the closing stop.
  const parkIdx = samples.findIndex(
    (s, i) => s.speed < DEFAULTS.STOP_SPEED_MS && samples.slice(i).every((x) => x.speed < DEFAULTS.STOP_SPEED_MS)
  );
  assert.equal(ended[0].trip.endedAt, samples[parkIdx].t);
});

test('the start time is backdated to the first sample above start speed', () => {
  const samples = trackFromSpeeds(ERRAND);
  const { ended } = drive(samples);
  const firstFast = samples.find((s) => s.speed >= DEFAULTS.START_SPEED_MS);
  assert.equal(ended[0].trip.startedAt, firstFast.t);
});

test('the backdated samples are kept in the route', () => {
  const samples = trackFromSpeeds(ERRAND);
  const { ended } = drive(samples);
  const firstFast = samples.find((s) => s.speed >= DEFAULTS.START_SPEED_MS);
  const firstPoint = ended[0].trip.segments[0][0];
  assert.equal(firstPoint.t, firstFast.t);
});

test('walking speed never starts a trip', () => {
  const walk = trackFromSpeeds(profile([[1.4, 10], [1.4, 600]]));
  const { events, engine } = drive(walk);
  assert.equal(events.filter((e) => e.type === 'tripStarted').length, 0);
  assert.equal(engine.getState(), 'idle');
});

test('a brief burst above start speed that does not hold is not a trip', () => {
  // Three seconds of 10 m/s, well short of START_CONFIRM_S.
  const blip = trackFromSpeeds(profile([[10, 3], [0, 3], [0, 60]]));
  const { events } = drive(blip);
  assert.equal(events.filter((e) => e.type === 'tripStarted').length, 0);
});

test('a single GPS speed spike does not become the top speed', () => {
  const prof = profile([[25, 10], [25, 120], [0, 10], [0, 200]]);
  const samples = trackFromSpeeds(prof);
  samples[60].speed = 100; // one absurd reading mid-cruise
  const { ended } = drive(samples);
  assert.ok(ended[0].trip.topSpeedMs < 30, `got ${ended[0].trip.topSpeedMs}`);
});

test('a spike small enough to pass the acceleration filter still needs confirming', () => {
  const prof = profile([[25, 10], [25, 120], [0, 10], [0, 200]]);
  const samples = trackFromSpeeds(prof);
  // +11 m/s in one second is under MAX_ACCEL_MS2 but 30% off its neighbours.
  samples[60].speed = 36;
  const { ended } = drive(samples);
  assert.ok(ended[0].trip.topSpeedMs < 30, `got ${ended[0].trip.topSpeedMs}`);
});

test('a genuine sustained acceleration does set a new top speed', () => {
  const prof = profile([[25, 10], [25, 60], [40, 20], [40, 20], [0, 16], [0, 200]]);
  const { ended } = drive(trackFromSpeeds(prof));
  assert.ok(Math.abs(ended[0].trip.topSpeedMs - 40) < 0.5, `got ${ended[0].trip.topSpeedMs}`);
});

test('a low-accuracy burst is ignored', () => {
  const prof = profile([[25, 10], [25, 120], [0, 10], [0, 200]]);
  const clean = trackFromSpeeds(prof);
  const dirty = trackFromSpeeds(prof).map((s, i) =>
    i >= 50 && i < 65 ? { ...s, acc: 200, lat: s.lat + 0.01 } : s
  );
  const a = drive(clean).ended[0].trip;
  const b = drive(dirty).ended[0].trip;
  assert.ok(Math.abs(a.distanceM - b.distanceM) / a.distanceM < 0.02,
    `clean ${a.distanceM} vs dirty ${b.distanceM}`);
  assert.ok(b.rejectedCount >= 15, `expected rejections, got ${b.rejectedCount}`);
});

test('a sample with no accuracy reading is still accepted', () => {
  const samples = trackFromSpeeds(ERRAND).map((s) => ({ ...s, acc: null }));
  const { ended } = drive(samples);
  assert.equal(ended.length, 1);
});

test('a signal gap splits the route into segments', () => {
  const prof = profile([[25, 10], [25, 200], [0, 10], [0, 200]]);
  const all = trackFromSpeeds(prof);
  // Drop 30 s of samples mid-cruise: longer than GAP_S, shorter than END_STOP_S.
  const samples = all.filter((_, i) => i < 60 || i >= 90);
  const { ended } = drive(samples);
  assert.equal(ended.length, 1);
  assert.ok(ended[0].trip.segments.length >= 2, 'expected a second segment');
  assert.equal(ended[0].trip.hadGap, true);
});

test('a signal gap adds no phantom distance', () => {
  const prof = profile([[25, 10], [25, 200], [0, 10], [0, 200]]);
  const all = trackFromSpeeds(prof);
  const samples = all.filter((_, i) => i < 60 || i >= 90);
  const { ended } = drive(samples);
  // The vehicle really covered ~750 m during the blackout; we must not count it.
  const jump = haversineM(all[59], all[90]);
  assert.ok(jump > 700, `sanity: the jump should be large, got ${jump}`);
  const full = drive(all).ended[0].trip.distanceM;
  assert.ok(ended[0].trip.distanceM < full - 700,
    `gap distance ${ended[0].trip.distanceM} should exclude the ${jump} m jump`);
});

test('a gap longer than END_STOP_S ends the trip', () => {
  const prof = profile([[25, 10], [25, 120], [25, 300]]);
  const all = trackFromSpeeds(prof);
  const samples = all.filter((_, i) => i < 100 || i >= 300); // 200 s blackout
  const { ended } = drive(samples);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].trip.endedAt, all[99].t);
});

test('a trip shorter than MIN_TRIP_DIST_M is discarded', () => {
  // 4.6 m/s for 61 s is about 280 m: long enough in time, too short in distance.
  const prof = profile([[4.6, 1], [4.6, 60], [0, 2], [0, 200]]);
  const { events, ended } = drive(trackFromSpeeds(prof));
  assert.equal(ended.length, 0);
  const discarded = events.filter((e) => e.type === 'tripDiscarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].reason, 'distance');
});

test('a trip shorter than MIN_TRIP_S is discarded', () => {
  const prof = profile([[25, 5], [25, 25], [0, 4], [0, 200]]);
  const { events, ended } = drive(trackFromSpeeds(prof));
  assert.equal(ended.length, 0);
  assert.equal(events.filter((e) => e.type === 'tripDiscarded')[0].reason, 'duration');
});

test('a null reported speed falls back to a speed computed from positions', () => {
  const samples = trackFromSpeeds(ERRAND).map((s) => ({ ...s, speed: null }));
  const { ended } = drive(samples);
  assert.equal(ended.length, 1);
  assert.ok(Math.abs(ended[0].trip.topSpeedMs - 25) < 1.5, `got ${ended[0].trip.topSpeedMs}`);
  const expected = haversineM(samples[0], samples[samples.length - 1]);
  assert.ok(Math.abs(ended[0].trip.distanceM - expected) / expected < 0.02);
});

test('a negative reported speed falls back to a computed speed', () => {
  const samples = trackFromSpeeds(ERRAND).map((s) => ({ ...s, speed: -1 }));
  const { ended } = drive(samples);
  assert.equal(ended.length, 1);
  assert.ok(ended[0].trip.topSpeedMs > 20);
});

test('manual end stops the trip immediately', () => {
  const samples = trackFromSpeeds(profile([[25, 10], [25, 120]]));
  const engine = createTripEngine({ config: DEFAULTS });
  for (const s of samples) engine.addSample(s);
  assert.equal(engine.getState(), 'recording');
  const events = engine.endNow(samples[samples.length - 1].t);
  assert.equal(events.filter((e) => e.type === 'tripEnded').length, 1);
  assert.equal(engine.getState(), 'idle');
});

test('manual end keeps a trip that auto-detection would have discarded', () => {
  const samples = trackFromSpeeds(profile([[25, 5], [25, 10]]));
  const engine = createTripEngine({ config: DEFAULTS });
  for (const s of samples) engine.addSample(s);
  const events = engine.endNow(samples[samples.length - 1].t, { force: true });
  assert.equal(events.filter((e) => e.type === 'tripEnded').length, 1);
});

test('crawling in traffic holds the stop timer instead of ending the trip', () => {
  // Five minutes at 2 m/s: above STOP_SPEED_MS, below START_SPEED_MS.
  const prof = profile([[25, 10], [25, 60], [2, 5], [2, 300], [25, 10], [25, 60], [0, 10], [0, 200]]);
  const { ended, events } = drive(trackFromSpeeds(prof));
  assert.equal(events.filter((e) => e.type === 'tripStarted').length, 1);
  assert.equal(ended.length, 1);
});

test('tick ends a trip when samples stop arriving altogether', () => {
  const samples = trackFromSpeeds(profile([[25, 10], [25, 120], [0, 5]]));
  const engine = createTripEngine({ config: DEFAULTS });
  for (const s of samples) engine.addSample(s);
  const last = samples[samples.length - 1].t;
  assert.equal(engine.tick(last + 10_000).length, 0);
  const events = engine.tick(last + DEFAULTS.END_STOP_S * 1000 + 1000);
  assert.equal(events.filter((e) => e.type === 'tripEnded').length, 1);
});

test('stats are live while recording', () => {
  const samples = trackFromSpeeds(profile([[25, 10], [25, 60]]));
  const engine = createTripEngine({ config: DEFAULTS });
  for (const s of samples) engine.addSample(s);
  const stats = engine.getStats();
  assert.equal(stats.state, 'recording');
  assert.ok(stats.distanceM > 1000);
  assert.ok(stats.topSpeedMs > 20);
  assert.ok(stats.durationS > 60);
  assert.ok(stats.movingS > 60);
});

test('peak g-force from the motion sensor lands on the trip', () => {
  const samples = trackFromSpeeds(ERRAND);
  const engine = createTripEngine({ config: DEFAULTS });
  const ended = [];
  for (const s of samples) {
    engine.addMotion({ t: s.t, totalG: 0.3 });
    if (s.t === samples[40].t) engine.addMotion({ t: s.t, totalG: 1.4 });
    ended.push(...engine.addSample(s).filter((e) => e.type === 'tripEnded'));
  }
  assert.ok(Math.abs(ended[0].trip.peakG - 1.4) < 1e-9, `got ${ended[0].trip.peakG}`);
});

test('elevation gain and loss are accumulated', () => {
  const prof = profile([[25, 10], [25, 120], [0, 10], [0, 200]]);
  const samples = trackFromSpeeds(prof).map((s, i) => ({
    ...s,
    alt: 100 + (i < 70 ? i * 2 : 140 - (i - 70)),
  }));
  const { ended } = drive(samples);
  assert.ok(ended[0].trip.elevationGainM > 100, `gain ${ended[0].trip.elevationGainM}`);
  assert.ok(ended[0].trip.elevationLossM > 50, `loss ${ended[0].trip.elevationLossM}`);
});

test('the route is thinned for storage but keeps its endpoints', () => {
  const samples = trackFromSpeeds(ERRAND);
  const { ended } = drive(samples);
  const pts = ended[0].trip.segments.flat();
  assert.ok(pts.length < samples.length, 'route should be decimated');
  assert.ok(pts.length > 50, 'route should still have shape');
  const firstFast = samples.find((s) => s.speed >= DEFAULTS.START_SPEED_MS);
  assert.equal(pts[0].t, firstFast.t);
});

test('out-of-order samples are rejected', () => {
  const samples = trackFromSpeeds(profile([[25, 10], [25, 60]]));
  const engine = createTripEngine({ config: DEFAULTS });
  for (const s of samples) engine.addSample(s);
  const before = engine.getStats().distanceM;
  engine.addSample({ ...samples[10], t: samples[5].t });
  assert.equal(engine.getStats().distanceM, before);
});

test('a draft snapshot is available mid-trip and names the engine state', () => {
  const samples = trackFromSpeeds(profile([[25, 10], [25, 60]]));
  const engine = createTripEngine({ config: DEFAULTS });
  for (const s of samples) engine.addSample(s);
  const draft = engine.getDraft();
  assert.ok(draft);
  assert.ok(draft.startedAt > 0);
  assert.ok(draft.distanceM > 1000);
  assert.ok(Array.isArray(draft.segments));
});

test('there is no draft when idle', () => {
  const engine = createTripEngine({ config: DEFAULTS });
  engine.addSample({ t: 0, lat: 40, lon: -74, speed: 0, acc: 5 });
  assert.equal(engine.getDraft(), null);
});

test('performance results ride along with the trip', () => {
  const prof = profile([[0, 3], [28, 7], [28, 60], [0, 8], [0, 200]]);
  const { ended } = drive(trackFromSpeeds(prof));
  assert.ok(ended[0].trip.performance, 'no performance block');
  assert.ok(Array.isArray(ended[0].trip.performance.accel));
  assert.ok(ended[0].trip.performance.accel.length > 0, 'expected a 0-60 style result');
});

test('a smoothness score between 0 and 100 is attached', () => {
  const { ended } = drive(trackFromSpeeds(ERRAND));
  const score = ended[0].trip.score;
  assert.ok(score >= 0 && score <= 100, `got ${score}`);
});

test('displayed speed is smoothed but top speed is not', () => {
  const prof = profile([[20, 10], [20, 30]]);
  const samples = trackFromSpeeds(prof);
  samples[25].speed = 23; // a small genuine wobble
  samples[26].speed = 23;
  const engine = createTripEngine({ config: DEFAULTS });
  for (const s of samples.slice(0, 27)) engine.addSample(s);
  const stats = engine.getStats();
  assert.ok(stats.displaySpeedMs < stats.currentSpeedMs,
    `smoothed ${stats.displaySpeedMs} should lag raw ${stats.currentSpeedMs}`);
});

test('the engine survives a sample with missing coordinates', () => {
  const engine = createTripEngine({ config: DEFAULTS });
  assert.doesNotThrow(() => {
    engine.addSample({ t: 0, lat: null, lon: null, speed: 10, acc: 5 });
    engine.addSample({ t: 1000, speed: 10, acc: 5 });
  });
  assert.equal(engine.getState(), 'idle');
});

test('moving and stopped time never exceed the trip duration', () => {
  // The auto-stop dates the trip to when the car stopped, so the minutes spent
  // parked afterwards must not be counted into the trip at all.
  const { ended } = drive(trackFromSpeeds(ERRAND));
  const trip = ended[0].trip;
  const accounted = trip.movingS + trip.stoppedS;
  assert.ok(accounted <= trip.durationS + 1,
    `moving ${trip.movingS} + stopped ${trip.stoppedS} exceeds duration ${trip.durationS}`);
});

test('moving and stopped time account for nearly all of the trip', () => {
  const { ended } = drive(trackFromSpeeds(ERRAND));
  const trip = ended[0].trip;
  const accounted = trip.movingS + trip.stoppedS;
  assert.ok(accounted > trip.durationS - 3,
    `only ${accounted} of ${trip.durationS} seconds accounted for`);
});

test('a gap does not get counted as either moving or stopped time', () => {
  const prof = profile([[25, 10], [25, 200], [0, 10], [0, 200]]);
  const all = trackFromSpeeds(prof);
  const samples = all.filter((_, i) => i < 60 || i >= 90);
  const trip = drive(samples).ended[0].trip;
  // 30 seconds of blackout are unaccounted for, so the two must fall short.
  assert.ok(trip.movingS + trip.stoppedS < trip.durationS - 25,
    `gap time was counted: ${trip.movingS + trip.stoppedS} of ${trip.durationS}`);
});
