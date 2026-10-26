// Pure parts of the crew module. Anything touching Firebase is covered by the
// rules tests and by driving the live site instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdentity, normaliseCode, summaryFor } from '../js/crew.js';
import { makeTrip } from './helpers.js';

const MEMBERS = [
  { uid: 'u1', name: 'Jordan', car: 'Civic Si', avatar: '\u{1F3CE}️' },
  { uid: 'u2', name: 'Alex', car: '2018 GTI', avatar: '\u{1F697}' },
];

test('a leaderboard row shows the current name, not the one on an old drive', () => {
  // The summary was shared back when they were called Sam.
  const row = resolveIdentity({ uid: 'u1', name: 'Sam', car: 'Old car' }, MEMBERS);
  assert.equal(row.name, 'Jordan');
  assert.equal(row.car, 'Civic Si');
  assert.equal(row.departed, false);
});

test('someone who has left keeps the name on their drives', () => {
  const row = resolveIdentity({ uid: 'gone', name: 'Robin', car: 'Mini' }, MEMBERS);
  assert.equal(row.name, 'Robin');
  assert.equal(row.car, 'Mini');
  assert.equal(row.departed, true);
});

test('a row with no name anywhere still renders', () => {
  const row = resolveIdentity({ uid: 'ghost' }, []);
  assert.equal(row.name, 'Someone');
  assert.equal(row.car, '');
});

test('resolveIdentity keeps the figures untouched', () => {
  const row = resolveIdentity({ uid: 'u2', name: 'x', topSpeedMs: 31.4, distanceM: 1000, trips: 3 }, MEMBERS);
  assert.equal(row.topSpeedMs, 31.4);
  assert.equal(row.distanceM, 1000);
  assert.equal(row.trips, 3);
});

test('invite codes drop characters the alphabet never produces', () => {
  // I, L, O, 0 and 1 are excluded when generating, so they are typos.
  assert.equal(normaliseCode('ej73jp'), 'EJ73JP');
  assert.equal(normaliseCode('EJ-73 JP'), 'EJ73JP');
  assert.equal(normaliseCode('EJ73JPEXTRA'), 'EJ73JP');
});

test('a summary never carries location, whatever the trip held', () => {
  const trip = makeTrip({ note: 'home to work' });
  assert.ok(trip.segments[0][0].lat, 'fixture should have coordinates to begin with');
  const summary = summaryFor(trip, { name: 'Alex', car: 'GTI', mode: 'full' });
  for (const banned of ['lat', 'lon', 'segments', 'points', 'note', 'id']) {
    assert.ok(!(banned in summary), `summary must not contain ${banned}`);
  }
});

test('speed-only sharing drops the figures too', () => {
  const summary = summaryFor(makeTrip(), { name: 'Alex', car: '', mode: 'speed-only' });
  assert.ok('topSpeedMs' in summary);
  for (const banned of ['distanceM', 'durationS', 'peakG', 'score']) {
    assert.ok(!(banned in summary), `speed-only must not contain ${banned}`);
  }
});

test('an impossible top speed is clamped before it is ever sent', () => {
  const summary = summaryFor(makeTrip({ topSpeedMs: 9999 }), { name: 'A', car: '' });
  assert.equal(summary.topSpeedMs, 130);
});
