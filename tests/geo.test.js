import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineM,
  bearingDeg,
  cumulativeDistanceM,
  decimate,
  boundsOf,
  projectPoints,
  headingDeltaDeg,
} from '../js/geo.js';

const LONDON = { lat: 51.5007, lon: -0.1246 };
const PARIS = { lat: 48.8567, lon: 2.3508 };

test('haversineM is zero for the same point', () => {
  assert.equal(haversineM(LONDON, LONDON), 0);
});

test('haversineM gives ~111.19 km for one degree of latitude', () => {
  const d = haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(d - 111195) < 120, `got ${d}`);
});

test('haversineM matches the known London-Paris great-circle distance', () => {
  const d = haversineM(LONDON, PARIS);
  // Published great-circle distance is about 343.5 km.
  assert.ok(Math.abs(d - 343_500) < 2_000, `got ${d}`);
});

test('haversineM is symmetric', () => {
  assert.ok(Math.abs(haversineM(LONDON, PARIS) - haversineM(PARIS, LONDON)) < 1e-6);
});

test('bearingDeg reads 0 due north and 90 due east', () => {
  assert.ok(Math.abs(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 0) < 0.5);
  assert.ok(Math.abs(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 90) < 0.5);
  assert.ok(Math.abs(bearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }) - 180) < 0.5);
  assert.ok(Math.abs(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 }) - 270) < 0.5);
});

test('headingDeltaDeg takes the short way around the compass', () => {
  assert.equal(headingDeltaDeg(10, 350), -20);
  assert.equal(headingDeltaDeg(350, 10), 20);
  assert.equal(headingDeltaDeg(90, 90), 0);
  assert.equal(Math.abs(headingDeltaDeg(0, 180)), 180);
});

test('cumulativeDistanceM sums the legs of a path', () => {
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0.001, lon: 0 },
    { lat: 0.002, lon: 0 },
  ];
  const expected = haversineM(pts[0], pts[1]) + haversineM(pts[1], pts[2]);
  assert.ok(Math.abs(cumulativeDistanceM(pts) - expected) < 1e-6);
});

test('cumulativeDistanceM is zero for fewer than two points', () => {
  assert.equal(cumulativeDistanceM([]), 0);
  assert.equal(cumulativeDistanceM([{ lat: 1, lon: 1 }]), 0);
});

test('decimate always keeps the first and last point', () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({
    t: i * 100,
    lat: 40 + i * 0.000001,
    lon: -74,
  }));
  const out = decimate(pts, { minMs: 1000, minM: 5 });
  assert.equal(out[0], pts[0]);
  assert.equal(out[out.length - 1], pts[pts.length - 1]);
});

test('decimate drops points that are too close in both time and space', () => {
  // 10 Hz samples that barely move: everything between the ends should go.
  const pts = Array.from({ length: 30 }, (_, i) => ({
    t: i * 100,
    lat: 40 + i * 0.0000001,
    lon: -74,
  }));
  const out = decimate(pts, { minMs: 1000, minM: 5 });
  assert.equal(out.length, 2);
});

test('decimate keeps points once both thresholds are exceeded', () => {
  // 1 Hz samples moving ~22 m each: every point clears 1 s and 5 m.
  const pts = Array.from({ length: 10 }, (_, i) => ({
    t: i * 1000,
    lat: 40 + i * 0.0002,
    lon: -74,
  }));
  const out = decimate(pts, { minMs: 1000, minM: 5 });
  assert.equal(out.length, 10);
});

test('decimate keeps a flagged point even when it is close to its neighbour', () => {
  const pts = [
    { t: 0, lat: 40, lon: -74 },
    { t: 100, lat: 40.0000001, lon: -74, keep: true },
    { t: 200, lat: 40.0000002, lon: -74 },
    { t: 300, lat: 40.0000003, lon: -74 },
  ];
  const out = decimate(pts, { minMs: 1000, minM: 5 });
  assert.ok(out.some((p) => p.keep === true));
});

test('boundsOf returns the enclosing box', () => {
  const b = boundsOf([
    { lat: 10, lon: -5 },
    { lat: 12, lon: 3 },
    { lat: 11, lon: -8 },
  ]);
  assert.deepEqual(b, { minLat: 10, maxLat: 12, minLon: -8, maxLon: 3 });
});

test('boundsOf returns null for an empty path', () => {
  assert.equal(boundsOf([]), null);
});

test('projectPoints fits every point inside the padded box', () => {
  const pts = [
    { lat: 40.0, lon: -74.0 },
    { lat: 40.1, lon: -73.9 },
    { lat: 40.05, lon: -74.05 },
  ];
  const out = projectPoints(pts, { width: 200, height: 100, pad: 10 });
  assert.equal(out.length, 3);
  for (const p of out) {
    assert.ok(p.x >= 10 - 1e-9 && p.x <= 190 + 1e-9, `x out of box: ${p.x}`);
    assert.ok(p.y >= 10 - 1e-9 && p.y <= 90 + 1e-9, `y out of box: ${p.y}`);
  }
});

test('projectPoints puts a northern point above a southern one', () => {
  const out = projectPoints(
    [
      { lat: 40.0, lon: -74 },
      { lat: 41.0, lon: -74 },
    ],
    { width: 100, height: 100, pad: 0 }
  );
  // Screen y grows downward, so the higher latitude must have the smaller y.
  assert.ok(out[1].y < out[0].y);
});

test('projectPoints centres a single point', () => {
  const out = projectPoints([{ lat: 40, lon: -74 }], { width: 100, height: 50, pad: 0 });
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].x - 50) < 1e-9);
  assert.ok(Math.abs(out[0].y - 25) < 1e-9);
});
