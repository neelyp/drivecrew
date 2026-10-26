// Hand-drawn canvas charts. No chart library: these are simple enough that one
// would be more code than this file.

import { fitCanvas, cssVar } from './ui.js';
import { speedColor } from './heat.js';

/**
 * Speed over time, filled with the heat ramp so the chart and the map agree
 * about what a colour means.
 */
export function speedChart(canvas, points, { height = 130, convert = (v) => v } = {}) {
  const { ctx, w, h } = fitCanvas(canvas, height);
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) return;

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const peak = Math.max(0.1, ...points.map((p) => p.speed || 0));
  const padB = 16;
  const plotH = h - padB - 6;

  const x = (t) => ((t - t0) / span) * w;
  const y = (speed) => 6 + plotH - (speed / peak) * plotH;

  // Fill below the line, one thin column per pixel so the gradient follows speed.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const mid = ((a.speed || 0) + (b.speed || 0)) / 2;
    ctx.fillStyle = speedColor(mid, peak);
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(x(a.t), y(a.speed || 0));
    ctx.lineTo(x(b.t), y(b.speed || 0));
    ctx.lineTo(x(b.t), 6 + plotH);
    ctx.lineTo(x(a.t), 6 + plotH);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = speedColor(mid, peak);
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x(a.t), y(a.speed || 0));
    ctx.lineTo(x(b.t), y(b.speed || 0));
    ctx.stroke();
  }

  // Baseline and a peak marker.
  ctx.strokeStyle = cssVar('--line', '#1C222C');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 6 + plotH + 0.5);
  ctx.lineTo(w, 6 + plotH + 0.5);
  ctx.stroke();

  const peakPoint = points.reduce((best, p) => ((p.speed || 0) > (best.speed || 0) ? p : best), points[0]);
  ctx.fillStyle = cssVar('--slate', '#8A94A3');
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textAlign = x(peakPoint.t) > w - 44 ? 'right' : 'left';
  ctx.fillText(
    `peak ${Math.round(convert(peakPoint.speed || 0))}`,
    Math.min(Math.max(x(peakPoint.t) + 5, 2), w - 2),
    Math.max(y(peakPoint.speed || 0) - 5, 11)
  );
}

/** A plain line, used for the altitude profile. */
export function lineChart(canvas, values, { height = 110, color } = {}) {
  const { ctx, w, h } = fitCanvas(canvas, height);
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const padB = 14;
  const plotH = h - padB - 6;
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => 6 + plotH - ((v - min) / span) * plotH;

  const stroke = color || cssVar('--amber-soft', '#D08A1A');
  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(w, 6 + plotH);
  ctx.lineTo(0, 6 + plotH);
  ctx.closePath();
  ctx.fillStyle = stroke;
  ctx.globalAlpha = 0.14;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Weekly or monthly distance bars. */
export function barChart(canvas, bars, { height = 130, label = (b) => b.label } = {}) {
  const { ctx, w, h } = fitCanvas(canvas, height);
  ctx.clearRect(0, 0, w, h);
  if (!bars.length) return;

  const max = Math.max(...bars.map((b) => b.value)) || 1;
  const padB = 18;
  const plotH = h - padB - 4;
  const gap = bars.length > 14 ? 2 : 6;
  const barW = Math.max(3, (w - gap * (bars.length - 1)) / bars.length);

  ctx.font = '10px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';

  bars.forEach((b, i) => {
    const bh = (b.value / max) * plotH;
    const bx = i * (barW + gap);
    ctx.fillStyle = b.highlight ? cssVar('--amber', '#FFB020') : cssVar('--amber-dim', '#6B4A1F');
    ctx.beginPath();
    ctx.roundRect(bx, 4 + plotH - bh, barW, Math.max(bh, 1.5), 2);
    ctx.fill();

    if (bars.length <= 14) {
      ctx.fillStyle = cssVar('--faint', '#5B646F');
      ctx.fillText(label(b), bx + barW / 2, h - 5);
    }
  });
}

/**
 * The live trace on the Drive screen: the last minute of speed, so you can see
 * the shape of what you just drove without looking at the map.
 */
export function liveTrace(canvas, samples, { height = 46 } = {}) {
  const { ctx, w, h } = fitCanvas(canvas, height);
  ctx.clearRect(0, 0, w, h);
  if (samples.length < 2) return;

  const peak = Math.max(1, ...samples.map((s) => s.speed || 0));
  const t0 = samples[0].t;
  const span = Math.max(1000, samples[samples.length - 1].t - t0);
  const x = (t) => ((t - t0) / span) * w;
  const y = (v) => h - 2 - (v / peak) * (h - 6);

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const mid = ((a.speed || 0) + (b.speed || 0)) / 2;
    ctx.strokeStyle = speedColor(mid, peak);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x(a.t), y(a.speed || 0));
    ctx.lineTo(x(b.t), y(b.speed || 0));
    ctx.stroke();
  }
}
