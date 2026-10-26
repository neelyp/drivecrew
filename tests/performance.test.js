import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerformanceDetector, estimatePowerHp, findAccel } from '../js/performance.js';
import { DEFAULTS } from '../js/config.js';
import { launchSamples, brakeSamples } from './helpers.js';

const MPH60 = 26.8224;
const MPH30 = 13.4112;

function run(samples) {
  const det = createPerformanceDetector(DEFAULTS);
  for (const s of samples) det.addSample(s);
  return det.getResults();
}

test('a clean standing-start run times 0-60 mph', () => {
  // Constant 4 m/s^2 reaches 26.8224 m/s at 6.7056 s.
  const r = run(launchSamples(4, 10));
  const a60 = findAccel(r.accel, 0, MPH60);
  assert.ok(a60, '0-60 not detected');
  assert.ok(Math.abs(a60.timeS - 6.7056) < 0.05, `got ${a60.timeS}`);
});

test('the same run also times the 0-30 mph split, and it is quicker', () => {
  const r = run(launchSamples(4, 10));
  const a30 = findAccel(r.accel, 0, MPH30);
  const a60 = findAccel(r.accel, 0, MPH60);
  assert.ok(Math.abs(a30.timeS - 3.3528) < 0.05, `got ${a30.timeS}`);
  assert.ok(a30.timeS < a60.timeS);
});

test('a run that never reaches the target reports nothing for it', () => {
  // 2 m/s^2 for 5 s tops out at 10 m/s, well short of 60 mph.
  const r = run(launchSamples(2, 5));
  assert.equal(findAccel(r.accel, 0, MPH60), null);
});

test('a rolling pass through 60 mph with no standing start is not timed', () => {
  // Starts already at 20 m/s, so no launch is ever armed.
  const samples = launchSamples(4, 10).map((s) => ({
    ...s,
    speedMs: s.speedMs + 20,
    distM: s.distM + 20 * (s.t / 1000),
  }));
  const r = run(samples);
  assert.equal(findAccel(r.accel, 0, MPH60), null);
});

test('the quarter mile is timed with a trap speed', () => {
  // 4 m/s^2 covers 402.336 m in 14.183 s at 56.73 m/s.
  const r = run(launchSamples(4, 20));
  const q = r.drag.find((d) => Math.abs(d.distanceM - 402.336) < 0.01);
  assert.ok(q, 'quarter mile not detected');
  assert.ok(Math.abs(q.timeS - 14.1834) < 0.08, `time ${q.timeS}`);
  assert.ok(Math.abs(q.trapSpeedMs - 56.7336) < 0.3, `trap ${q.trapSpeedMs}`);
});

test('the eighth mile is timed and is quicker than the quarter', () => {
  const r = run(launchSamples(4, 20));
  const e = r.drag.find((d) => Math.abs(d.distanceM - 201.168) < 0.01);
  const q = r.drag.find((d) => Math.abs(d.distanceM - 402.336) < 0.01);
  assert.ok(e && q);
  assert.ok(e.timeS < q.timeS);
});

test('the best of two runs is kept', () => {
  const det = createPerformanceDetector(DEFAULTS);
  // Slow run first, then a stop, then a quick one.
  for (const s of launchSamples(3, 12)) det.addSample(s);
  const slow = det.getResults();
  const slowTime = findAccel(slow.accel, 0, MPH60).timeS;

  let t = 20_000;
  let d = 300;
  for (let i = 0; i < 5; i++) det.addSample({ t: (t += 1000), speedMs: 0, distM: d });
  for (const s of launchSamples(6, 10)) {
    det.addSample({ t: t + s.t + 1000, speedMs: s.speedMs, distM: d + s.distM });
  }
  const best = findAccel(det.getResults().accel, 0, MPH60).timeS;
  assert.ok(best < slowTime, `best ${best} should beat ${slowTime}`);
  assert.ok(Math.abs(best - 26.8224 / 6) < 0.05, `got ${best}`);
});

test('braking from 60 mph to a stop is timed and measured', () => {
  // 30 m/s decelerating at 8 m/s^2: 3.3528 s and 44.97 m from 60 mph to rest.
  const r = run(brakeSamples(30, 8));
  const b = r.braking.find((x) => Math.abs(x.fromMs - MPH60) < 0.01);
  assert.ok(b, 'braking run not detected');
  assert.ok(Math.abs(b.timeS - 3.3528) < 0.1, `time ${b.timeS}`);
  assert.ok(Math.abs(b.distanceM - 44.965) < 2, `distance ${b.distanceM}`);
});

test('a braking run interrupted by acceleration is thrown away', () => {
  const det = createPerformanceDetector(DEFAULTS);
  const samples = [
    { t: 0, speedMs: 30, distM: 0 },
    { t: 1000, speedMs: 22, distM: 26 },
    { t: 2000, speedMs: 14, distM: 44 },
    { t: 3000, speedMs: 20, distM: 61 }, // back on the throttle
    { t: 4000, speedMs: 10, distM: 76 },
    { t: 5000, speedMs: 0, distM: 81 },
  ];
  for (const s of samples) det.addSample(s);
  const r = det.getResults();
  assert.equal(r.braking.find((x) => Math.abs(x.fromMs - MPH60) < 0.01), undefined);
});

test('peak acceleration and deceleration are tracked', () => {
  const r = run([...launchSamples(4, 5), ...brakeSamples(20, 6).map((s) => ({
    t: s.t + 6000, speedMs: s.speedMs, distM: s.distM + 50,
  }))]);
  assert.ok(Math.abs(r.peakAccelMs2 - 4) < 0.3, `accel ${r.peakAccelMs2}`);
  assert.ok(Math.abs(r.peakDecelMs2 - 6) < 0.6, `decel ${r.peakDecelMs2}`);
});

test('one long hard pull counts as a single harsh acceleration event', () => {
  const r = run(launchSamples(4, 10));
  assert.equal(r.harsh.accel, 1);
});

test('gentle driving logs no harsh events', () => {
  const r = run(launchSamples(1.2, 15));
  assert.equal(r.harsh.accel, 0);
  assert.equal(r.harsh.brake, 0);
});

test('hard cornering is counted from speed and heading change', () => {
  const det = createPerformanceDetector(DEFAULTS);
  // 25 m/s through a 30 deg/s turn is about 1.33 g lateral.
  for (let i = 0; i <= 4; i++) {
    det.addSample({ t: i * 1000, speedMs: 25, distM: 25 * i, headingDeg: (i * 30) % 360 });
  }
  const r = det.getResults();
  assert.ok(r.harsh.corner >= 1, `corner events ${r.harsh.corner}`);
  assert.ok(r.peakLateralG > 1, `peak lateral ${r.peakLateralG}`);
});

test('estimatePowerHp matches a hand-computed road-load case', () => {
  const hp = estimatePowerHp({
    massKg: 1500, speedMs: 20, accelMs2: 4,
    cdA: 0.65, crr: 0.012, config: DEFAULTS,
  });
  assert.ok(Math.abs(hp - 199.92) < 1, `got ${hp}`);
});

test('estimatePowerHp is zero when coasting at a standstill', () => {
  const hp = estimatePowerHp({ massKg: 1500, speedMs: 0, accelMs2: 0, config: DEFAULTS });
  assert.equal(hp, 0);
});

test('peak estimated power is reported for a run once a mass is known', () => {
  const det = createPerformanceDetector(DEFAULTS, { massKg: 1500, cdA: 0.65, crr: 0.012 });
  for (const s of launchSamples(4, 12)) det.addSample(s);
  const r = det.getResults();
  assert.ok(r.peakPowerHp > 200, `peak hp ${r.peakPowerHp}`);
});

test('no estimated power without a vehicle mass', () => {
  const r = run(launchSamples(4, 12));
  assert.equal(r.peakPowerHp, null);
});

test('a roll-on from 60 to 130 mph is timed without a standing start', () => {
  const det = createPerformanceDetector(DEFAULTS);
  // 20 m/s climbing at 3 m/s^2 passes 26.8224 then 58.1184 m/s.
  for (let i = 0; i <= 15; i++) {
    det.addSample({ t: i * 1000, speedMs: 20 + 3 * i, distM: 20 * i + 1.5 * i * i });
  }
  const r = det.getResults();
  const ro = r.rollon.find((x) => Math.abs(x.fromMs - 26.8224) < 0.01);
  assert.ok(ro, 'roll-on not detected');
  // (58.1184 - 26.8224) / 3 = 10.432 s
  assert.ok(Math.abs(ro.timeS - 10.432) < 0.05, `got ${ro.timeS}`);
});

test('a roll-on that drops out of the window is abandoned, not completed', () => {
  const det = createPerformanceDetector(DEFAULTS);
  // Enters at 27, backs off to 25, then goes again and finishes.
  const speeds = [20, 27, 34, 25, 40, 50, 59];
  speeds.forEach((v, i) => det.addSample({ t: i * 1000, speedMs: v, distM: i * 30 }));
  const ro = det.getResults().rollon.find((x) => Math.abs(x.fromMs - 26.8224) < 0.01);
  assert.ok(ro, 'the second attempt should still be timed');
  // Timed from the second entry (~3.12 s), not the abandoned first one (~0.97 s).
  assert.ok(ro.timeS < 3, `should be timed from the latest entry, got ${ro.timeS}`);
});

test('a roll-on that never reaches the top of the window is not recorded', () => {
  const det = createPerformanceDetector(DEFAULTS);
  const speeds = [20, 27, 34, 25, 20, 24, 26];
  speeds.forEach((v, i) => det.addSample({ t: i * 1000, speedMs: v, distM: i * 30 }));
  assert.equal(det.getResults().rollon.length, 0);
});

test('reset forgets an in-flight run but keeps the records already set', () => {
  const det = createPerformanceDetector(DEFAULTS);
  for (const s of launchSamples(4, 10)) det.addSample(s);
  const before = findAccel(det.getResults().accel, 0, MPH60).timeS;

  det.reset();
  // A fresh stream that jumps straight to speed must not be timed from zero.
  for (let i = 0; i <= 5; i++) det.addSample({ t: 60_000 + i * 1000, speedMs: 30, distM: 1000 + i * 30 });
  const after = findAccel(det.getResults().accel, 0, MPH60).timeS;
  assert.equal(after, before, 'existing record should survive a reset');
});
