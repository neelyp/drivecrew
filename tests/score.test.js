import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothnessScore, scoreGrade } from '../js/score.js';

test('a clean drive scores 100', () => {
  assert.equal(smoothnessScore({ harsh: { accel: 0, brake: 0, corner: 0 }, distanceM: 20000 }), 100);
});

test('harsh events pull the score down', () => {
  const s = smoothnessScore({ harsh: { accel: 4, brake: 4, corner: 2 }, distanceM: 20000 });
  assert.ok(s < 100 && s > 0, `got ${s}`);
});

test('the same events over a longer drive score better', () => {
  const harsh = { accel: 5, brake: 5, corner: 5 };
  const short = smoothnessScore({ harsh, distanceM: 5000 });
  const long = smoothnessScore({ harsh, distanceM: 50000 });
  assert.ok(long > short, `${long} should beat ${short}`);
});

test('the score is clamped to 0 and 100', () => {
  const awful = smoothnessScore({ harsh: { accel: 500, brake: 500, corner: 500 }, distanceM: 1000 });
  assert.equal(awful, 0);
});

test('a zero-distance trip does not divide by zero', () => {
  const s = smoothnessScore({ harsh: { accel: 1, brake: 0, corner: 0 }, distanceM: 0 });
  assert.ok(Number.isFinite(s) && s >= 0 && s <= 100, `got ${s}`);
});

test('missing harsh counts are treated as none', () => {
  assert.equal(smoothnessScore({ distanceM: 10000 }), 100);
});

test('scoreGrade labels the bands', () => {
  assert.equal(scoreGrade(100), 'Smooth');
  assert.equal(scoreGrade(50), 'Mixed');
  assert.equal(scoreGrade(10), 'Rough');
});
