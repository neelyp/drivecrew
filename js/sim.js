// GPS simulator. Replays a synthetic track through exactly the same pipeline a
// real drive uses, so the whole app can be exercised without driving anywhere.
//
// Important detail: sample TIMESTAMPS keep their natural one-second spacing
// however fast we replay. The engine reasons about sample time, not wall-clock
// time, so a 10-minute drive at 60x still has to satisfy the real 6-second
// start confirmation and the real 3-minute auto-stop.

const M_PER_DEG_LAT = 111_320;

/**
 * Dead-reckon a track from a list of phases.
 * Each phase: { speed (target m/s), seconds, turn (deg/s), accel, decel, climb }
 */
export function buildTrack(phases, { lat = 37.7749, lon = -122.4194, acc = 6, alt = 24 } = {}) {
  const out = [];
  let t = 0;
  let heading = 0;
  let curLat = lat;
  let curLon = lon;
  let v = 0;
  let altitude = alt;

  for (const phase of phases) {
    for (let i = 0; i < phase.seconds; i++) {
      const up = phase.accel ?? 2.5;
      const down = phase.decel ?? phase.accel ?? 2.5;
      if (v < phase.speed) v = Math.min(phase.speed, v + up);
      else if (v > phase.speed) v = Math.max(phase.speed, v - down);

      heading = (heading + (phase.turn || 0) + 360) % 360;
      const rad = (heading * Math.PI) / 180;
      curLat += (v * Math.cos(rad)) / M_PER_DEG_LAT;
      curLon += (v * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos((curLat * Math.PI) / 180));
      altitude += phase.climb || 0;

      out.push({
        t,
        lat: Number(curLat.toFixed(7)),
        lon: Number(curLon.toFixed(7)),
        speed: Number(v.toFixed(2)),
        acc,
        alt: Math.round(altitude),
        heading: Math.round(heading),
      });
      t += 1000;
    }
  }
  return out;
}

/** Stop-start city driving: two red lights, several turns, about 4 km. */
export const cityLoop = () =>
  buildTrack([
    { speed: 0, seconds: 8 },
    { speed: 13, seconds: 12, accel: 1.6 },
    { speed: 13, seconds: 38 },
    { speed: 13, seconds: 12, turn: 7 },
    { speed: 13, seconds: 34 },
    { speed: 0, seconds: 10, decel: 2 },
    { speed: 0, seconds: 34 },
    { speed: 15, seconds: 12, accel: 1.8 },
    { speed: 15, seconds: 48, turn: -1, climb: 0.4 },
    { speed: 15, seconds: 14, turn: 6 },
    { speed: 15, seconds: 42, climb: -0.3 },
    { speed: 0, seconds: 9, decel: 2 },
    { speed: 0, seconds: 28 },
    { speed: 14, seconds: 11 },
    { speed: 14, seconds: 52, turn: 2 },
    { speed: 0, seconds: 10, decel: 2 },
    { speed: 0, seconds: 195 },
  ]);

/** An on-ramp, a long cruise, some traffic, an exit. About 18 km. */
export const highwayRun = () =>
  buildTrack([
    { speed: 0, seconds: 8 },
    { speed: 12, seconds: 10, accel: 1.5 },
    { speed: 12, seconds: 28, turn: 1 },
    { speed: 29, seconds: 22, accel: 1.4, turn: 3, climb: 0.5 },
    { speed: 29, seconds: 250, climb: 0.1 },
    { speed: 23, seconds: 20, decel: 0.5 },
    { speed: 29, seconds: 24, accel: 0.6 },
    { speed: 29, seconds: 145, climb: -0.2 },
    { speed: 11, seconds: 28, decel: 1.2, turn: -4 },
    { speed: 11, seconds: 24, turn: 1 },
    { speed: 0, seconds: 10, decel: 2 },
    { speed: 0, seconds: 195 },
  ]);

/**
 * A closed-course demo: one standing-start pull and a hard stop, so the
 * performance timing screens have something to show. Not a public-road track.
 */
export const launchDemo = () =>
  buildTrack([
    { speed: 0, seconds: 10 },
    { speed: 45, seconds: 16, accel: 4.2 },
    { speed: 45, seconds: 12 },
    { speed: 0, seconds: 8, decel: 8 },
    { speed: 0, seconds: 12 },
    { speed: 40, seconds: 14, accel: 3.4 },
    { speed: 40, seconds: 20 },
    { speed: 0, seconds: 10, decel: 6 },
    { speed: 0, seconds: 195 },
  ]);

export const TRACKS = {
  city: { name: 'City loop', build: cityLoop, note: 'Stop-start driving with two red lights.' },
  highway: { name: 'Highway run', build: highwayRun, note: 'On-ramp, long cruise, exit.' },
  launch: { name: 'Closed-course pull', build: launchDemo, note: 'Standing starts and hard braking.' },
};

/**
 * A replay source with the same two-method shape as gps.js, so the app cannot
 * tell the difference. `rate` only changes how fast samples are delivered.
 */
export function createSimSource(track, { rate = 1 } = {}) {
  let timer = null;
  let index = 0;
  let running = false;
  let simNow = 0;
  const base = Date.now();

  function start({ onSample, onError, onComplete } = {}) {
    if (running || !track.length) return;
    running = true;
    index = 0;
    const t0 = track[0].t;

    const pump = () => {
      if (!running) return;
      const sample = track[index];
      if (!sample) {
        running = false;
        onComplete?.();
        return;
      }
      simNow = base + (sample.t - t0);
      onSample({ ...sample, t: simNow });
      index++;

      const next = track[index];
      if (!next) {
        running = false;
        onComplete?.();
        return;
      }
      const waitMs = Math.max(0, (next.t - sample.t) / rate);
      timer = setTimeout(pump, waitMs);
    };
    pump();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
  }

  return {
    start,
    stop,
    isRunning: () => running,
    /** The simulated clock, so tick() is not driven by the wall clock. */
    now: () => simNow || base,
    progress: () => (track.length ? index / track.length : 1),
    kind: 'sim',
  };
}
