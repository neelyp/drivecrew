import test from 'node:test';
import assert from 'node:assert/strict';
import {
  msToMph, msToKmh, mphToMs, kmhToMs,
  mToMi, mToKm, mToFt,
  speedIn, distanceIn, speedUnitLabel, distanceUnitLabel,
  formatSpeed, formatDistance, formatDuration, formatDurationLong, formatG, formatHp,
} from '../js/units.js';

test('speed conversions match the standard factors', () => {
  assert.ok(Math.abs(msToMph(1) - 2.2369363) < 1e-6);
  assert.ok(Math.abs(msToKmh(1) - 3.6) < 1e-9);
  assert.ok(Math.abs(mphToMs(60) - 26.8224) < 1e-4);
  assert.ok(Math.abs(kmhToMs(100) - 27.7778) < 1e-4);
});

test('speed conversions round-trip', () => {
  assert.ok(Math.abs(mphToMs(msToMph(13.4)) - 13.4) < 1e-9);
  assert.ok(Math.abs(kmhToMs(msToKmh(13.4)) - 13.4) < 1e-9);
});

test('distance conversions match the standard factors', () => {
  assert.ok(Math.abs(mToMi(1609.344) - 1) < 1e-9);
  assert.ok(Math.abs(mToKm(1500) - 1.5) < 1e-9);
  assert.ok(Math.abs(mToFt(1) - 3.28084) < 1e-5);
});

test('speedIn and distanceIn follow the chosen system', () => {
  assert.ok(Math.abs(speedIn(26.8224, 'imperial') - 60) < 1e-3);
  assert.ok(Math.abs(speedIn(27.7778, 'metric') - 100) < 1e-2);
  assert.ok(Math.abs(distanceIn(1609.344, 'imperial') - 1) < 1e-9);
  assert.ok(Math.abs(distanceIn(1000, 'metric') - 1) < 1e-9);
});

test('unit labels follow the chosen system', () => {
  assert.equal(speedUnitLabel('imperial'), 'mph');
  assert.equal(speedUnitLabel('metric'), 'km/h');
  assert.equal(distanceUnitLabel('imperial'), 'mi');
  assert.equal(distanceUnitLabel('metric'), 'km');
});

test('formatSpeed rounds to a whole number by default', () => {
  assert.equal(formatSpeed(26.8224, 'imperial'), '60');
  assert.equal(formatSpeed(0, 'imperial'), '0');
});

test('formatSpeed never shows a negative speed', () => {
  assert.equal(formatSpeed(-5, 'imperial'), '0');
});

test('formatDistance keeps two decimals under 10 and one above', () => {
  assert.equal(formatDistance(1609.344, 'imperial'), '1.00');
  assert.equal(formatDistance(1609.344 * 42.37, 'imperial'), '42.4');
});

test('formatDuration uses m:ss under an hour and h:mm:ss above', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(45), '0:45');
  assert.equal(formatDuration(245), '4:05');
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(5025), '1:23:45');
});

test('formatDuration treats rubbish input as zero', () => {
  assert.equal(formatDuration(null), '0:00');
  assert.equal(formatDuration(-10), '0:00');
  assert.equal(formatDuration(NaN), '0:00');
});

test('formatDurationLong reads as words', () => {
  assert.equal(formatDurationLong(45), '45s');
  assert.equal(formatDurationLong(245), '4m 5s');
  assert.equal(formatDurationLong(3661), '1h 1m');
});

test('formatG shows two decimals with a g suffix', () => {
  assert.equal(formatG(1.234), '1.23g');
  assert.equal(formatG(0), '0.00g');
});

test('formatHp rounds to a whole number', () => {
  assert.equal(formatHp(241.6), '242');
  assert.equal(formatHp(null), '--');
});
