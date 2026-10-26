// Export formats. Pure string builders - tests/exporters.test.js.
// GPX and GeoJSON are route exports (they do contain locations, which is fine:
// the user is handing them to themselves). CSV is a summary export.

import { APP_NAME } from './config.js';
import { speedIn, distanceIn, speedUnitLabel, distanceUnitLabel } from './units.js';

const xmlEscape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const iso = (ms) => new Date(ms).toISOString();

export function toGPX(trip, { name } = {}) {
  const title = name || `${APP_NAME} drive ${new Date(trip.startedAt).toLocaleString()}`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${APP_NAME}" xmlns="http://www.topografix.com/GPX/1/1">`,
    '  <metadata>',
    `    <name>${xmlEscape(title)}</name>`,
    `    <time>${iso(trip.startedAt)}</time>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${xmlEscape(title)}</name>`,
  ];
  if (trip.note) lines.push(`    <desc>${xmlEscape(trip.note)}</desc>`);

  for (const segment of trip.segments || []) {
    lines.push('    <trkseg>');
    for (const p of segment) {
      lines.push(`      <trkpt lat="${p.lat}" lon="${p.lon}">`);
      if (Number.isFinite(p.alt)) lines.push(`        <ele>${p.alt}</ele>`);
      lines.push(`        <time>${iso(p.t)}</time>`);
      lines.push('      </trkpt>');
    }
    lines.push('    </trkseg>');
  }
  lines.push('  </trk>', '</gpx>', '');
  return lines.join('\n');
}

export function toGeoJSON(trip) {
  const features = (trip.segments || []).map((segment, i) => ({
    type: 'Feature',
    properties: {
      segment: i,
      // Per-point speeds, so a viewer can colour the line.
      speedsMs: segment.map((p) => Number(p.speed.toFixed(2))),
      timestamps: segment.map((p) => p.t),
    },
    geometry: {
      type: 'LineString',
      coordinates: segment.map((p) =>
        Number.isFinite(p.alt) ? [p.lon, p.lat, p.alt] : [p.lon, p.lat]
      ),
    },
  }));
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      properties: {
        app: APP_NAME,
        id: trip.id,
        startedAt: iso(trip.startedAt),
        endedAt: iso(trip.endedAt),
        distanceM: trip.distanceM,
        durationS: trip.durationS,
        topSpeedMs: trip.topSpeedMs,
        note: trip.note || '',
      },
      features,
    },
    null,
    2
  );
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (cells) => cells.map(csvCell).join(',');

export function tripsToCSV(trips, system = 'imperial') {
  const d = distanceUnitLabel(system);
  const s = speedUnitLabel(system);
  const header = [
    'id', 'started', 'ended', `distance_${d}`, 'duration_s', `top_speed_${s}`,
    `avg_speed_${s}`, 'moving_s', 'stopped_s', 'elevation_gain_m', 'peak_g',
    'score', 'vehicle', 'favorite', 'note',
  ];
  const rows = trips.map((t) =>
    csvRow([
      t.id,
      iso(t.startedAt),
      iso(t.endedAt),
      distanceIn(t.distanceM, system).toFixed(2),
      Math.round(t.durationS),
      speedIn(t.topSpeedMs, system).toFixed(1),
      speedIn(t.avgSpeedMs || 0, system).toFixed(1),
      Math.round(t.movingS || 0),
      Math.round(t.stoppedS || 0),
      Math.round(t.elevationGainM || 0),
      (t.peakG || 0).toFixed(2),
      t.score ?? '',
      t.vehicleName || t.vehicleId || '',
      t.favorite ? 'yes' : 'no',
      t.note || '',
    ])
  );
  return [csvRow(header), ...rows].join('\n') + '\n';
}

export function tripPointsToCSV(trip) {
  const header = ['segment', 'time', 'lat', 'lon', 'speed_ms', 'altitude_m', 'accuracy_m'];
  const rows = [];
  (trip.segments || []).forEach((segment, i) => {
    for (const p of segment) {
      rows.push(csvRow([i, iso(p.t), p.lat, p.lon, p.speed, p.alt ?? '', p.acc ?? '']));
    }
  });
  return [csvRow(header), ...rows].join('\n') + '\n';
}
