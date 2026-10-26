// DriveCrew service worker.
//
// App shell is cache-first so the app opens instantly and works with no
// network. Firebase is never cached. Map tiles get a small capped cache, so a
// route you have already looked at still shows its map offline.

const VERSION = 'v1.0.3';
const SHELL_CACHE = `drivecrew-shell-${VERSION}`;
const TILE_CACHE = `drivecrew-tiles-${VERSION}`;
const TILE_LIMIT = 300;

// Relative paths throughout, so this works when hosted under a subpath.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './firebase-config.js',
  './js/main.js',
  './js/config.js',
  './js/tripEngine.js',
  './js/performance.js',
  './js/score.js',
  './js/geo.js',
  './js/units.js',
  './js/heat.js',
  './js/gps.js',
  './js/motion.js',
  './js/wakelock.js',
  './js/storage.js',
  './js/crew.js',
  './js/records.js',
  './js/achievements.js',
  './js/exporters.js',
  './js/shareCard.js',
  './js/vehicles.js',
  './js/mapView.js',
  './js/charts.js',
  './js/sim.js',
  './js/ui.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // addAll fails the whole install if one file 404s, so add them one by one.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) =>
            console.warn('[sw] could not precache', url, err)
          )
        )
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('drivecrew-') && k !== SHELL_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

const isTile = (url) =>
  /basemaps\.cartocdn\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org/.test(url.hostname);

const isFirebase = (url) =>
  /gstatic\.com|googleapis\.com|firebaseio\.com|firebaseapp\.com/.test(url.hostname);

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  // Oldest-inserted first; good enough for map tiles.
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache Firebase: auth and Firestore must always be live.
  if (isFirebase(url)) return;

  if (isTile(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILE_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const response = await fetch(request);
          if (response.ok || response.type === 'opaque') {
            cache.put(request, response.clone());
            trimCache(TILE_CACHE, TILE_LIMIT);
          }
          return response;
        } catch {
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  // Navigations: serve the shell so hash routes work offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
        }
      })()
    );
    return;
  }

  // Everything else in our own scope: cache first, then fill the cache.
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          return Response.error();
        }
      })()
    );
  }
});
