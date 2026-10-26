// Pure geographic helpers. No DOM, no browser APIs - unit tested under tests/geo.test.js.

// WGS84 mean radius. Using the mean radius keeps haversine within ~0.3% anywhere,
// which is far better than consumer GPS accuracy.
const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance between two {lat, lon} points, in metres. */
export function haversineM(a, b) {
  if (!a || !b) return 0;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north, 0-360. */
export function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest angle from one heading to another, in (-180, 180]. */
export function headingDeltaDeg(fromDeg, toDeg_) {
  const d = toDeg_ - fromDeg;
  return (((d + 180) % 360) + 360) % 360 - 180;
}

/** Total path length in metres. */
export function cumulativeDistanceM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

/**
 * Thin a track for storage and drawing. A point survives when it is at least
 * `minMs` AND `minM` away from the last point we kept - "whichever is sparser",
 * since at highway speed the time rule bites first and in traffic the distance
 * rule does. First, last, and anything flagged `keep` always survive.
 */
export function decimate(points, { minMs = 1000, minM = 5 } = {}) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  let anchor = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const dt = p.t - anchor.t;
    const dist = haversineM(anchor, p);
    if (p.keep === true || (dt >= minMs && dist >= minM)) {
      out.push(p);
      anchor = p;
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Enclosing lat/lon box, or null when there is nothing to enclose. */
export function boundsOf(points) {
  if (!points || points.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Equirectangular projection into a canvas box, aspect ratio preserved and
 * centred. Good enough for a route drawn inside a few tens of kilometres.
 */
export function projectPoints(points, { width, height, pad = 0 } = {}) {
  const b = boundsOf(points);
  if (!b) return [];
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const midLat = (b.minLat + b.maxLat) / 2;
  const lonScale = Math.cos(toRad(midLat)) || 1e-9;

  // Work in "degree-ish" units where longitude is squeezed by latitude.
  const spanX = (b.maxLon - b.minLon) * lonScale;
  const spanY = b.maxLat - b.minLat;
  const scale = spanX <= 0 && spanY <= 0
    ? 0
    : Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity);

  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = pad + (innerW - drawnW) / 2;
  const offsetY = pad + (innerH - drawnH) / 2;

  return points.map((p) => ({
    x: offsetX + (scale === 0 ? 0 : (p.lon - b.minLon) * lonScale * scale),
    // Flip: screen y grows downward while latitude grows north.
    y: offsetY + (scale === 0 ? 0 : (b.maxLat - p.lat) * scale),
    src: p,
  }));
}
