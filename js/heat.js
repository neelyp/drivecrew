// The speed-as-heat ramp, shared by the map, the charts and the share card so
// that a colour means the same speed everywhere in the app.

export const RAMP = ['#4A3418', '#8A5A12', '#D08A1A', '#FFB020', '#FFF0C8'];

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${bl})`;
}

/** fraction 0 (slowest) to 1 (fastest) -> colour. */
export function heatColor(fraction) {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const x = f * (RAMP.length - 1);
  const i = Math.floor(x);
  if (i >= RAMP.length - 1) return RAMP[RAMP.length - 1];
  return mix(RAMP[i], RAMP[i + 1], x - i);
}

/** Speed colour relative to a trip's own range, so every route uses the full ramp. */
export function speedColor(speedMs, maxMs) {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return RAMP[0];
  return heatColor(speedMs / maxMs);
}
