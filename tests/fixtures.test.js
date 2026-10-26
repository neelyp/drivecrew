// Replays the simulator's own tracks through the real engine. These are the
// closest thing to an end-to-end test that runs without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTripEngine } from '../js/tripEngine.js';
import { findAccel } from '../js/performance.js';
import { DEFAULTS } from '../js/config.js';
import { msToMph } from '../js/units.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

function replay(track) {
  const engine = createTripEngine({ config: DEFAULTS });
  const events = [];
  for (const s of track) events.push(...engine.addSample(s));
  return {
    engine,
    ended: events.filter((e) => e.type === 'tripEnded').map((e) => e.trip),
    discarded: events.filter((e) => e.type === 'tripDiscarded'),
    started: events.filter((e) => e.type === 'tripStarted'),
  };
}

test('the city loop records as one trip despite two red lights', () => {
  const { ended, started } = replay(load('city-loop'));
  assert.equal(started.length, 1);
  assert.equal(ended.length, 1);
  const trip = ended[0];
  assert.ok(trip.distanceM > 2500 && trip.distanceM < 6000, `distance ${trip.distanceM}`);
  assert.ok(msToMph(trip.topSpeedMs) > 28 && msToMph(trip.topSpeedMs) < 40, `top ${msToMph(trip.topSpeedMs)}`);
  assert.ok(trip.stoppedS > 50, `stopped time ${trip.stoppedS}`);
  assert.equal(trip.hadGap, false);
});

test('the city loop keeps a drawable route', () => {
  const trip = replay(load('city-loop')).ended[0];
  const points = trip.segments.flat();
  assert.equal(trip.segments.length, 1);
  assert.ok(points.length > 40, `only ${points.length} points`);
  assert.ok(points.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)));
});

test('the highway run records one long trip at cruising speed', () => {
  const { ended } = replay(load('highway-run'));
  assert.equal(ended.length, 1);
  const trip = ended[0];
  assert.ok(trip.distanceM > 12_000, `distance ${trip.distanceM}`);
  assert.ok(msToMph(trip.topSpeedMs) > 60 && msToMph(trip.topSpeedMs) < 70, `top ${msToMph(trip.topSpeedMs)}`);
  assert.ok(trip.elevationGainM > 10, `climb ${trip.elevationGainM}`);
  assert.ok(trip.avgSpeedMs > 15, `average ${trip.avgSpeedMs}`);
});

test('the closed-course pull produces acceleration timings', () => {
  const { ended } = replay(load('launch-demo'));
  assert.equal(ended.length, 1);
  const perf = ended[0].performance;
  const sixty = findAccel(perf.accel, 0, 26.8224);
  assert.ok(sixty, 'no 0-60 recorded');
  // The track accelerates at 4.2 m/s^2, so 60 mph should arrive near 6.4 s.
  assert.ok(Math.abs(sixty.timeS - 6.39) < 0.4, `0-60 was ${sixty.timeS}`);
  const quarter = perf.drag.find((d) => Math.abs(d.distanceM - 402.336) < 0.01);
  assert.ok(quarter, 'no quarter mile recorded');
  assert.ok(quarter.timeS > 8 && quarter.timeS < 20, `quarter mile ${quarter.timeS}`);
});

test('the closed-course pull records braking and a smoothness penalty', () => {
  const trip = replay(load('launch-demo')).ended[0];
  assert.ok(trip.performance.braking.length > 0, 'no braking run');
  assert.ok(trip.performance.harsh.brake > 0, 'hard stops should be counted');
  assert.ok(trip.score < 100, `score ${trip.score} should reflect the hard driving`);
});

test('every fixture sample has the shape the engine expects', () => {
  for (const name of ['city-loop', 'highway-run', 'launch-demo']) {
    for (const s of load(name)) {
      assert.ok(Number.isFinite(s.t) && Number.isFinite(s.lat) && Number.isFinite(s.lon), name);
      assert.ok(Number.isFinite(s.speed) && s.speed >= 0, name);
      assert.ok(Number.isFinite(s.acc), name);
    }
  }
});
