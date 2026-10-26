// Leaflet route rendering. Leaflet is vendored under /vendor so the app works
// offline; only the tiles need a network.

import { speedColor } from './heat.js';
import { boundsOf, projectPoints } from './geo.js';

const L = window.L;

// Only keyless tile sources. A dark basemap would normally come from CARTO or
// Mapbox, but both want an API key now, so "Dark" is OpenStreetMap inverted in
// CSS instead - no key, no account, no bill.
export const MAP_STYLES = {
  dark: {
    name: 'Dark',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    darken: true,
  },
  standard: {
    name: 'Standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  terrain: {
    name: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style: OpenTopoMap (CC-BY-SA)',
    subdomains: 'abc',
    maxZoom: 17,
  },
};

export function createMap(container, { style = 'dark', interactive = true } = {}) {
  if (!L) return null;
  const map = L.map(container, {
    zoomControl: interactive,
    attributionControl: true,
    dragging: interactive,
    scrollWheelZoom: interactive,
    doubleClickZoom: interactive,
    touchZoom: interactive,
    keyboard: interactive,
    tap: false,
  });
  map.setView([40, -74], 13);
  setStyle(map, style);
  return map;
}

export function setStyle(map, styleKey) {
  const spec = MAP_STYLES[styleKey] || MAP_STYLES.dark;
  if (map._dcTiles) map.removeLayer(map._dcTiles);
  // No crossOrigin here: tile servers refuse CORS requests, and nothing in the
  // app ever reads tile pixels back out of a canvas.
  map._dcTiles = L.tileLayer(spec.url, {
    attribution: spec.attribution,
    subdomains: spec.subdomains || 'abc',
    maxZoom: spec.maxZoom,
  }).addTo(map);
  map.getContainer().classList.toggle('dark-tiles', !!spec.darken);
}

/**
 * Draw a route with each leg coloured by its speed. Segments are drawn
 * separately so a signal gap leaves a visible break rather than a fake
 * straight line across the map.
 */
export function drawRoute(map, segments, { maxSpeedMs, weight = 4 } = {}) {
  if (!L || !map) return null;
  if (map._dcRoute) map._dcRoute.forEach((layer) => map.removeLayer(layer));
  const layers = [];
  const peak = maxSpeedMs || Math.max(0.1, ...segments.flat().map((p) => p.speed || 0));

  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1];
      const b = segment[i];
      const mid = ((a.speed || 0) + (b.speed || 0)) / 2;
      layers.push(
        L.polyline(
          [
            [a.lat, a.lon],
            [b.lat, b.lon],
          ],
          { color: speedColor(mid, peak), weight, opacity: 0.95, lineCap: 'round' }
        ).addTo(map)
      );
    }
  }
  map._dcRoute = layers;
  return layers;
}

export function fitRoute(map, segments, { padding = 24 } = {}) {
  const points = segments.flat();
  const b = boundsOf(points);
  if (!map || !b) return;
  if (points.length === 1) {
    map.setView([points[0].lat, points[0].lon], 15);
    return;
  }
  map.fitBounds(
    [
      [b.minLat, b.minLon],
      [b.maxLat, b.maxLon],
    ],
    { padding: [padding, padding] }
  );
}

/** A small amber dot that follows the car, instead of Leaflet's pin graphic. */
export function setPosition(map, lat, lon, { follow = true } = {}) {
  if (!L || !map) return;
  if (!map._dcHere) {
    map._dcHere = L.circleMarker([lat, lon], {
      radius: 6,
      color: '#16120A',
      weight: 2,
      fillColor: '#FFB020',
      fillOpacity: 1,
    }).addTo(map);
  } else {
    map._dcHere.setLatLng([lat, lon]);
  }
  if (follow) map.setView([lat, lon], Math.max(map.getZoom() || 15, 15), { animate: false });
}

export function startMarker(map, lat, lon) {
  if (!L || !map) return;
  L.circleMarker([lat, lon], {
    radius: 5,
    color: '#E8E4DB',
    weight: 2,
    fillColor: '#0B0E13',
    fillOpacity: 1,
  })
    .addTo(map)
    .bindTooltip('Start');
}

/**
 * A static route thumbnail drawn straight onto a canvas - no tiles, no network,
 * so the history list stays instant and works offline.
 */
export function drawThumbnail(canvas, segments, { maxSpeedMs } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.width / dpr || 58;
  const h = canvas.height / dpr || 42;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const all = segments.flat();
  if (all.length < 2) return;
  const peak = maxSpeedMs || Math.max(0.1, ...all.map((p) => p.speed || 0));
  const projected = projectPoints(all, { width: w, height: h, pad: 4 });
  const index = new Map(all.map((p, i) => [p, projected[i]]));

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++) {
      const a = index.get(segment[i - 1]);
      const b = index.get(segment[i]);
      if (!a || !b) continue;
      const mid = ((segment[i - 1].speed || 0) + (segment[i].speed || 0)) / 2;
      ctx.strokeStyle = speedColor(mid, peak);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}
