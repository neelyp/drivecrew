// Geolocation behind a two-method interface: start({onSample, onError}) and stop().
//
// PHASE 2 SWAP POINT. A Capacitor build replaces this module with one that calls
// @capacitor-community/background-geolocation and emits the same sample shape.
// Nothing downstream - tripEngine included - needs to change.
//
// Sample shape: { t, lat, lon, speed (m/s or null), acc (m), heading, alt }

export function createGeolocationSource() {
  let watchId = null;
  let running = false;

  function start({ onSample, onError }) {
    if (running) return;
    if (!('geolocation' in navigator)) {
      onError?.({ code: 'unsupported', message: 'This browser has no Geolocation API.' });
      return;
    }
    running = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        onSample({
          t: pos.timestamp,
          lat: c.latitude,
          lon: c.longitude,
          // Doppler speed when the receiver offers it; the engine derives it otherwise.
          speed: Number.isFinite(c.speed) ? c.speed : null,
          acc: Number.isFinite(c.accuracy) ? c.accuracy : null,
          heading: Number.isFinite(c.heading) ? c.heading : null,
          alt: Number.isFinite(c.altitude) ? c.altitude : null,
        });
      },
      (err) => {
        const code =
          err.code === 1 ? 'denied' : err.code === 2 ? 'unavailable' : err.code === 3 ? 'timeout' : 'error';
        onError?.({ code, message: err.message });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 }
    );
  }

  function stop() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    running = false;
  }

  return { start, stop, isRunning: () => running, kind: 'geolocation' };
}

/** Has the user already granted location, so we can arm without a tap? */
export async function locationPermissionState() {
  if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state; // 'granted' | 'prompt' | 'denied'
  } catch {
    return 'unknown';
  }
}
