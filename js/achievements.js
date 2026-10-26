// Achievements. Pure - tests/records.test.js covers them.
//
// Deliberately none of these reward speed. The app is not going to hand out a
// badge for going faster, so every milestone here is about distance, climbing,
// consistency, or driving smoothly.

const KM = 1000;

const DISTANCE_MILESTONES = [100, 500, 1000, 5000, 10_000, 50_000];
const TRIP_MILESTONES = [10, 50, 100, 500, 1000];

function hourOf(ms) {
  return new Date(ms).getHours();
}

export function evaluateAchievements({ trips = [] } = {}) {
  const sorted = [...trips].sort((a, b) => a.startedAt - b.startedAt);
  const list = [];

  // --- cumulative distance -------------------------------------------------
  let running = 0;
  const crossedAt = new Map();
  let count = 0;
  const tripCountAt = new Map();
  for (const t of sorted) {
    running += t.distanceM || 0;
    count++;
    for (const km of DISTANCE_MILESTONES) {
      if (!crossedAt.has(km) && running >= km * KM) crossedAt.set(km, t.startedAt);
    }
    for (const n of TRIP_MILESTONES) {
      if (!tripCountAt.has(n) && count >= n) tripCountAt.set(n, t.startedAt);
    }
  }

  for (const km of DISTANCE_MILESTONES) {
    const earned = crossedAt.has(km);
    list.push({
      id: `distance-${km}km`,
      name: km >= 1000 ? `${(km / 1000).toLocaleString()},000 km club` : `${km} km on the road`,
      description: `Cover ${km.toLocaleString()} km in total.`,
      group: 'Distance',
      earned,
      earnedAt: earned ? crossedAt.get(km) : null,
      progress: Math.min(1, running / (km * KM)),
    });
  }

  for (const n of TRIP_MILESTONES) {
    const earned = tripCountAt.has(n);
    list.push({
      id: `trips-${n}`,
      name: `${n} drives`,
      description: `Record ${n} drives.`,
      group: 'Consistency',
      earned,
      earnedAt: earned ? tripCountAt.get(n) : null,
      progress: Math.min(1, sorted.length / n),
    });
  }

  // --- one-off feats -------------------------------------------------------
  const firstMatch = (fn) => sorted.find(fn) || null;

  const longHaul = firstMatch((t) => (t.distanceM || 0) >= 200 * KM);
  list.push({
    id: 'long-haul',
    name: 'Long hauler',
    description: 'One drive of 200 km or more.',
    group: 'Distance',
    earned: !!longHaul,
    earnedAt: longHaul ? longHaul.startedAt : null,
    progress: Math.min(1, Math.max(0, ...sorted.map((t) => (t.distanceM || 0) / (200 * KM)), 0)),
  });

  const nightOwl = firstMatch((t) => hourOf(t.startedAt) >= 22 || hourOf(t.startedAt) < 4);
  list.push({
    id: 'night-owl',
    name: 'Night owl',
    description: 'Start a drive between 10pm and 4am.',
    group: 'Odd hours',
    earned: !!nightOwl,
    earnedAt: nightOwl ? nightOwl.startedAt : null,
    progress: nightOwl ? 1 : 0,
  });

  const earlyBird = firstMatch((t) => {
    const h = hourOf(t.startedAt);
    return h >= 4 && h < 6;
  });
  list.push({
    id: 'early-bird',
    name: 'Early bird',
    description: 'Start a drive between 4am and 6am.',
    group: 'Odd hours',
    earned: !!earlyBird,
    earnedAt: earlyBird ? earlyBird.startedAt : null,
    progress: earlyBird ? 1 : 0,
  });

  // A smooth drive only counts over a real distance - anyone can be smooth for a mile.
  const smooth = firstMatch((t) => (t.distanceM || 0) >= 25 * KM && (t.score || 0) >= 95);
  list.push({
    id: 'smooth-operator',
    name: 'Smooth operator',
    description: 'Score 95 or better on a drive of at least 25 km.',
    group: 'Craft',
    earned: !!smooth,
    earnedAt: smooth ? smooth.startedAt : null,
    progress: smooth ? 1 : 0,
  });

  const totalClimb = sorted.reduce((sum, t) => sum + (t.elevationGainM || 0), 0);
  list.push({
    id: 'climber',
    name: 'Hill collector',
    description: 'Climb 10,000 m in total.',
    group: 'Craft',
    earned: totalClimb >= 10_000,
    earnedAt: totalClimb >= 10_000 ? sorted[sorted.length - 1].startedAt : null,
    progress: Math.min(1, totalClimb / 10_000),
  });

  // Driving on many separate days, rather than many trips in one day.
  const days = new Set(sorted.map((t) => new Date(t.startedAt).toDateString()));
  list.push({
    id: 'regular',
    name: 'Creature of habit',
    description: 'Drive on 30 separate days.',
    group: 'Consistency',
    earned: days.size >= 30,
    earnedAt: days.size >= 30 ? sorted[sorted.length - 1].startedAt : null,
    progress: Math.min(1, days.size / 30),
  });

  return list;
}
