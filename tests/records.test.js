import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRecords, summarize, mostDistanceInWindow, groupByPeriod, periodStart } from '../js/records.js';
import { evaluateAchievements } from '../js/achievements.js';
import { makeTrip } from './helpers.js';

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 15, 12, 0, 0); // a Thursday noon

test('summarize totals up trips, distance, duration and climb', () => {
  const s = summarize([
    makeTrip({ distanceM: 1000, durationS: 100, elevationGainM: 10 }),
    makeTrip({ id: 'b', distanceM: 2000, durationS: 200, elevationGainM: 20 }),
  ]);
  assert.equal(s.trips, 2);
  assert.equal(s.distanceM, 3000);
  assert.equal(s.durationS, 300);
  assert.equal(s.elevationGainM, 30);
});

test('summarize of nothing is all zeroes', () => {
  const s = summarize([]);
  assert.equal(s.trips, 0);
  assert.equal(s.distanceM, 0);
});

test('computeRecords finds the fastest trip', () => {
  const r = computeRecords([
    makeTrip({ id: 'slow', topSpeedMs: 20 }),
    makeTrip({ id: 'fast', topSpeedMs: 38 }),
    makeTrip({ id: 'mid', topSpeedMs: 30 }),
  ]);
  assert.equal(r.topSpeed.value, 38);
  assert.equal(r.topSpeed.tripId, 'fast');
});

test('computeRecords finds the longest trip by distance and by time', () => {
  const r = computeRecords([
    makeTrip({ id: 'a', distanceM: 5000, durationS: 1800 }),
    makeTrip({ id: 'b', distanceM: 90_000, durationS: 600 }),
  ]);
  assert.equal(r.longestDistance.tripId, 'b');
  assert.equal(r.longestDuration.tripId, 'a');
});

test('computeRecords keeps the quickest acceleration run across trips', () => {
  const mk = (id, timeS) =>
    makeTrip({
      id,
      performance: {
        ...makeTrip().performance,
        accel: [{ fromMs: 0, toMs: 26.8224, timeS, atT: 1 }],
      },
    });
  const r = computeRecords([mk('a', 7.2), mk('b', 6.1), mk('c', 8.0)]);
  const best = r.accel.find((x) => Math.abs(x.toMs - 26.8224) < 0.01);
  assert.equal(best.timeS, 6.1);
  assert.equal(best.tripId, 'b');
});

test('computeRecords keeps the best quarter mile and braking distance', () => {
  const r = computeRecords([
    makeTrip({
      id: 'a',
      performance: {
        ...makeTrip().performance,
        drag: [{ distanceM: 402.336, timeS: 15.2, trapSpeedMs: 40 }],
        braking: [{ fromMs: 26.8224, toMs: 0, timeS: 3.4, distanceM: 48 }],
      },
    }),
    makeTrip({
      id: 'b',
      performance: {
        ...makeTrip().performance,
        drag: [{ distanceM: 402.336, timeS: 14.1, trapSpeedMs: 44 }],
        braking: [{ fromMs: 26.8224, toMs: 0, timeS: 3.1, distanceM: 41 }],
      },
    }),
  ]);
  assert.equal(r.drag.find((d) => Math.abs(d.distanceM - 402.336) < 0.01).tripId, 'b');
  // Shortest stopping distance wins, not the shortest time.
  assert.equal(r.braking[0].distanceM, 41);
});

test('computeRecords of an empty history has no records', () => {
  const r = computeRecords([]);
  assert.equal(r.topSpeed, null);
  assert.equal(r.accel.length, 0);
});

test('periodStart snaps to Monday for weeks and the 1st for months', () => {
  const weekStart = new Date(periodStart(BASE, 'week'));
  assert.equal(weekStart.getDay(), 1, 'weeks start on Monday');
  const monthStart = new Date(periodStart(BASE, 'month'));
  assert.equal(monthStart.getDate(), 1);
  assert.equal(monthStart.getHours(), 0);
});

test('mostDistanceInWindow finds the busiest seven days', () => {
  const trips = [
    makeTrip({ id: 'a', startedAt: BASE, distanceM: 10_000 }),
    makeTrip({ id: 'b', startedAt: BASE + DAY, distanceM: 20_000 }),
    makeTrip({ id: 'c', startedAt: BASE + 2 * DAY, distanceM: 30_000 }),
    // Three weeks later, a single bigger outing but on its own.
    makeTrip({ id: 'd', startedAt: BASE + 21 * DAY, distanceM: 55_000 }),
  ];
  const best = mostDistanceInWindow(trips, 7);
  assert.equal(best.distanceM, 60_000, 'the clustered week should win');
  assert.equal(best.tripCount, 3);
});

test('mostDistanceInWindow handles a single trip', () => {
  const best = mostDistanceInWindow([makeTrip({ distanceM: 4000 })], 7);
  assert.equal(best.distanceM, 4000);
});

test('mostDistanceInWindow handles no trips', () => {
  assert.equal(mostDistanceInWindow([], 7), null);
});

test('groupByPeriod buckets trips by week', () => {
  const groups = groupByPeriod(
    [
      makeTrip({ id: 'a', startedAt: BASE, distanceM: 1000 }),
      makeTrip({ id: 'b', startedAt: BASE + 3600_000, distanceM: 2000 }),
      makeTrip({ id: 'c', startedAt: BASE + 14 * DAY, distanceM: 4000 }),
    ],
    'week'
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].distanceM, 3000);
  assert.equal(groups[0].trips, 2);
});

test('achievements start unearned with an empty history', () => {
  const list = evaluateAchievements({ trips: [], records: computeRecords([]) });
  assert.ok(list.length > 5, 'expected a set of achievements');
  assert.ok(list.every((a) => a.earned === false));
});

test('a distance milestone unlocks once the total is passed', () => {
  const trips = Array.from({ length: 20 }, (_, i) =>
    makeTrip({ id: `t${i}`, startedAt: BASE + i * DAY, distanceM: 10_000 })
  );
  const list = evaluateAchievements({ trips, records: computeRecords(trips) });
  const hundred = list.find((a) => a.id === 'distance-100km');
  assert.equal(hundred.earned, true);
  assert.ok(hundred.earnedAt > 0);
});

test('achievement progress is reported for ones not yet earned', () => {
  const trips = [makeTrip({ distanceM: 50_000 })];
  const list = evaluateAchievements({ trips, records: computeRecords(trips) });
  const thousand = list.find((a) => a.id === 'distance-1000km');
  assert.equal(thousand.earned, false);
  assert.ok(thousand.progress > 0 && thousand.progress < 1, `got ${thousand.progress}`);
});

test('no achievement rewards speed', () => {
  const trips = [makeTrip({ topSpeedMs: 70 })];
  const list = evaluateAchievements({ trips, records: computeRecords(trips) });
  const text = list.map((a) => `${a.id} ${a.name} ${a.description}`).join(' ').toLowerCase();
  for (const word of ['top speed', 'fastest', 'mph', 'km/h', 'quick', 'speeding']) {
    assert.ok(!text.includes(word), `achievements should not mention "${word}"`);
  }
});

test('the smooth-driver achievement needs a long clean trip', () => {
  const short = [makeTrip({ distanceM: 2000, score: 100 })];
  const long = [makeTrip({ distanceM: 40_000, score: 100 })];
  const a = evaluateAchievements({ trips: short, records: computeRecords(short) });
  const b = evaluateAchievements({ trips: long, records: computeRecords(long) });
  assert.equal(a.find((x) => x.id === 'smooth-operator').earned, false);
  assert.equal(b.find((x) => x.id === 'smooth-operator').earned, true);
});
