// G-force from DeviceMotion, behind start/stop like gps.js.
// PHASE 2 SWAP POINT: a native build can feed the same {t, totalG} readings.
//
// Honest about what this is: a phone loose in a cupholder measures its own
// rattling as much as the car's. Readings are approximate and the UI says so.

const GRAVITY = 9.80665;
// Low-pass factor for the gravity estimate. High alpha = slow, stable estimate.
const ALPHA = 0.9;

export function needsMotionPermission() {
  return (
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function'
  );
}

/** iOS only, and only from inside a user gesture. */
export async function requestMotionPermission() {
  if (!needsMotionPermission()) return 'granted';
  try {
    return await DeviceMotionEvent.requestPermission();
  } catch {
    return 'denied';
  }
}

export function createMotionSource() {
  let handler = null;
  let gravity = null;
  let peakThisSecond = 0;
  let secondStart = 0;

  function start({ onReading, onError } = {}) {
    if (typeof DeviceMotionEvent === 'undefined' || typeof window === 'undefined') {
      onError?.({ code: 'unsupported' });
      return;
    }
    handler = (e) => {
      const t = Date.now();
      let g = null;

      if (e.acceleration && Number.isFinite(e.acceleration.x)) {
        // Gravity already removed by the platform: use it straight.
        const a = e.acceleration;
        g = Math.hypot(a.x, a.y, a.z) / GRAVITY;
      } else if (e.accelerationIncludingGravity && Number.isFinite(e.accelerationIncludingGravity.x)) {
        // Estimate the gravity vector with a low-pass filter and subtract it, so
        // the reading does not depend on how the phone is sitting in the mount.
        const a = e.accelerationIncludingGravity;
        gravity = gravity
          ? {
              x: ALPHA * gravity.x + (1 - ALPHA) * a.x,
              y: ALPHA * gravity.y + (1 - ALPHA) * a.y,
              z: ALPHA * gravity.z + (1 - ALPHA) * a.z,
            }
          : { x: a.x, y: a.y, z: a.z };
        g = Math.hypot(a.x - gravity.x, a.y - gravity.y, a.z - gravity.z) / GRAVITY;
      }
      if (g === null || !Number.isFinite(g)) return;

      // Sensors fire far faster than anything useful; report the peak each second.
      if (secondStart === 0) secondStart = t;
      peakThisSecond = Math.max(peakThisSecond, g);
      if (t - secondStart >= 1000) {
        onReading?.({ t, totalG: peakThisSecond });
        peakThisSecond = 0;
        secondStart = t;
      }
    };
    window.addEventListener('devicemotion', handler);
  }

  function stop() {
    if (handler && typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', handler);
    }
    handler = null;
    gravity = null;
    peakThisSecond = 0;
    secondStart = 0;
  }

  return { start, stop, isRunning: () => handler !== null };
}
