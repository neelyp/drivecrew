// Share cards: a PNG rendered entirely on canvas. Nothing is loaded from the
// network, so the canvas is never tainted and export always works - and the
// "map" is the route itself on a dark gradient, not map tiles.

import { APP_NAME } from './config.js';
import { speedColor, RAMP } from './heat.js';
import { projectPoints } from './geo.js';
import { speedIn, distanceIn, speedUnitLabel, distanceUnitLabel, formatDuration, formatDistance } from './units.js';

export const CARD_SIZES = {
  post: { w: 1080, h: 1350, name: 'post' },
  story: { w: 1080, h: 1920, name: 'story' },
};

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function renderShareCard(trip, { size = 'post', system = 'imperial', vehicleName = '' } = {}) {
  const spec = CARD_SIZES[size] || CARD_SIZES.post;
  const canvas = document.createElement('canvas');
  canvas.width = spec.w;
  canvas.height = spec.h;
  const ctx = canvas.getContext('2d');
  const W = spec.w;
  const H = spec.h;
  const M = 84; // margin

  // Background: a cockpit-dark wash with a faint warm glow behind the route.
  const bg = ctx.createLinearGradient(0, 0, W * 0.4, H);
  bg.addColorStop(0, '#0E131B');
  bg.addColorStop(0.55, '#0A0D12');
  bg.addColorStop(1, '#07090D');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.72, H * 0.33, 0, W * 0.72, H * 0.33, W * 0.78);
  glow.addColorStop(0, 'rgba(255,176,32,0.11)');
  glow.addColorStop(1, 'rgba(255,176,32,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // --- route ---------------------------------------------------------------
  const segments = trip.segments || [];
  const all = segments.flat();
  const routeTop = size === 'story' ? 300 : 250;
  const routeH = size === 'story' ? 820 : 600;

  if (all.length > 1) {
    const peak = Math.max(0.1, ...all.map((p) => p.speed || 0));
    const projected = projectPoints(all, { width: W - M * 2, height: routeH, pad: 10 });
    const index = new Map(all.map((p, i) => [p, projected[i]]));
    ctx.save();
    ctx.translate(M, routeTop);
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(255,176,32,0.33)';
    ctx.shadowBlur = 26;
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
    ctx.restore();
  }

  // --- headline figure -----------------------------------------------------
  const topSpeed = Math.round(speedIn(trip.topSpeedMs || 0, system));
  const headY = routeTop + routeH + (size === 'story' ? 200 : 150);

  ctx.fillStyle = '#8A94A3';
  ctx.font = `500 34px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('Top speed', M, headY - 118);

  ctx.fillStyle = '#FFB020';
  ctx.font = `700 210px ${FONT}`;
  ctx.fillText(String(topSpeed), M - 6, headY + 42);
  const numWidth = ctx.measureText(String(topSpeed)).width;

  ctx.fillStyle = '#8A94A3';
  ctx.font = `500 44px ${FONT}`;
  ctx.fillText(speedUnitLabel(system), M + numWidth + 10, headY + 42);

  // --- supporting figures --------------------------------------------------
  const cells = [
    ['Distance', `${formatDistance(trip.distanceM || 0, system)} ${distanceUnitLabel(system)}`],
    ['Moving time', formatDuration(trip.movingS || trip.durationS || 0)],
    ['Average', `${Math.round(speedIn(trip.avgSpeedMs || 0, system))} ${speedUnitLabel(system)}`],
  ];
  if (trip.peakG) cells.push(['Peak g', `${(trip.peakG || 0).toFixed(2)}g`]);

  const gridY = headY + (size === 'story' ? 190 : 150);
  const perRow = cells.length > 3 ? 2 : cells.length;
  const colW = (W - M * 2) / perRow;
  const rowH = 148;

  ctx.strokeStyle = 'rgba(232,228,219,0.12)';
  ctx.lineWidth = 2;
  cells.forEach(([label, value], i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const cx = M + col * colW;
    const cy = gridY + row * rowH;

    ctx.beginPath();
    ctx.moveTo(M, cy - 40);
    ctx.lineTo(W - M, cy - 40);
    ctx.stroke();

    ctx.fillStyle = '#8A94A3';
    ctx.font = `500 30px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(label, cx, cy + 2);

    ctx.fillStyle = '#E8E4DB';
    ctx.font = `620 58px ${FONT}`;
    ctx.fillText(value, cx, cy + 66);
  });

  // --- footer --------------------------------------------------------------
  const footY = H - M - 20;
  ctx.strokeStyle = 'rgba(232,228,219,0.12)';
  ctx.beginPath();
  ctx.moveTo(M, footY - 68);
  ctx.lineTo(W - M, footY - 68);
  ctx.stroke();

  const when = new Date(trip.startedAt).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  ctx.fillStyle = '#8A94A3';
  ctx.font = `500 32px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(vehicleName ? `${vehicleName} · ${when}` : when, M, footY);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#5B646F';
  ctx.fillText(APP_NAME, W - M, footY);

  // The heat ramp doubles as a signature: slow at one end, fast at the other.
  const rampW = 220;
  const ramp = ctx.createLinearGradient(W - M - rampW, 0, W - M, 0);
  RAMP.forEach((c, i) => ramp.addColorStop(i / (RAMP.length - 1), c));
  ctx.fillStyle = ramp;
  roundRect(ctx, W - M - rampW, footY - 54, rampW, 8, 4);
  ctx.fill();

  return canvas;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Share where the platform allows it, otherwise save the file. */
export async function shareCard(trip, options = {}) {
  const canvas = renderShareCard(trip, options);
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error('Could not render the card');

  const filename = `drivecrew-${new Date(trip.startedAt).toISOString().slice(0, 10)}.png`;
  const file = new File([blob], filename, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // Fall through to a download.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}
