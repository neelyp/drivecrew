// Screen Wake Lock, re-acquired when the page comes back to the foreground.
// Without this the screen sleeps and a PWA stops receiving GPS entirely.
// PHASE 2 SWAP POINT: a native build would not need it at all.

export function createWakeLock() {
  let sentinel = null;
  let wanted = false;
  let listening = false;

  const supported = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  async function acquire() {
    if (!supported() || !wanted || sentinel) return false;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
      return true;
    } catch {
      // Denied, low battery, or unsupported surface. Not fatal.
      sentinel = null;
      return false;
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') acquire();
  }

  async function request() {
    wanted = true;
    if (!listening && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
      listening = true;
    }
    return acquire();
  }

  async function release() {
    wanted = false;
    if (listening && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
      listening = false;
    }
    if (sentinel) {
      try {
        await sentinel.release();
      } catch {
        /* already gone */
      }
      sentinel = null;
    }
  }

  return { request, release, isHeld: () => sentinel !== null, isSupported: supported };
}
