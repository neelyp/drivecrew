// Smoothness scoring. Pure - unit tested under tests/score.test.js.
//
// This rates how smoothly the car was driven, not how fast or how legally.
// It is deliberately not a "safety score": there is no speed-limit data on the
// device, so nothing here knows or judges whether a speed was appropriate.

const WEIGHTS = { accel: 1, brake: 1.5, corner: 1 };
const PENALTY_PER_EVENT_PER_100KM = 0.8;
// Short hops get a floor so a single event on a 200 m trip is not catastrophic.
const MIN_DISTANCE_M = 2000;

export function smoothnessScore({ harsh = {}, distanceM = 0 } = {}) {
  const events =
    (harsh.accel || 0) * WEIGHTS.accel +
    (harsh.brake || 0) * WEIGHTS.brake +
    (harsh.corner || 0) * WEIGHTS.corner;
  if (events === 0) return 100;
  const per100km = (events / Math.max(distanceM, MIN_DISTANCE_M)) * 100_000;
  const score = 100 - per100km * PENALTY_PER_EVENT_PER_100KM;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreGrade(score) {
  if (score >= 90) return 'Smooth';
  if (score >= 70) return 'Steady';
  if (score >= 40) return 'Mixed';
  return 'Rough';
}
