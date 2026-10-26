// Generates the app icons with no image dependencies at all: a tiny PNG encoder
// plus a hand-rolled rasteriser. Run once with: node tools/make-icons.js
//
// The mark is the app's own idea in miniature - a speed-as-heat arc sweeping
// across a dark instrument face.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// --- PNG encoding ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10-12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the mark -------------------------------------------------------------

const BG = [0x0b, 0x0e, 0x13];
const RAMP = ['#4A3418', '#8A5A12', '#D08A1A', '#FFB020', '#FFF0C8'].map((h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]);

function heat(f) {
  const x = Math.max(0, Math.min(1, f)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const t = x - i;
  return [0, 1, 2].map((k) => Math.round(RAMP[i][k] + (RAMP[i + 1][k] - RAMP[i][k]) * t));
}

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRectSdf(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - (halfW - radius);
  const qy = Math.abs(py) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Colour one point of the icon. Coordinates are centred and normalised to
 * roughly -1..1, so the same code works at any size.
 * `inset` shrinks the mark for maskable icons, where the platform may crop.
 */
function sample(x, y, { masked, inset }) {
  // Background plate: a rounded square, or edge to edge when masked.
  let bg = null;
  if (masked) {
    bg = BG;
  } else {
    const d = roundedRectSdf(x, y, 1, 1, 0.42);
    if (d > 0) return null; // transparent outside the plate
    bg = BG;
  }

  const r = Math.hypot(x, y) / inset;
  // Angle measured clockwise from the lower left, so the arc sweeps up to the right.
  let angle = Math.atan2(-y, x); // -pi..pi, y flipped so up is positive
  if (angle < 0) angle += Math.PI * 2;

  const START = Math.PI * 1.08; // just past "9 o'clock", below the axis
  const SWEEP = Math.PI * 1.34; // sweeps round through the top to the right
  const R_IN = 0.52;
  const R_OUT = 0.78;

  let within = angle - START;
  if (within < 0) within += Math.PI * 2;

  if (r >= R_IN && r <= R_OUT && within <= SWEEP) {
    const f = within / SWEEP;
    // Fade in at the cold end so the arc looks drawn rather than clipped.
    const fade = Math.min(1, f * 7);
    const c = heat(f);
    return [0, 1, 2].map((k) => Math.round(bg[k] + (c[k] - bg[k]) * fade));
  }

  // The needle: a short bar from the centre toward the hot end of the arc.
  const tipAngle = START + SWEEP;
  const tx = Math.cos(tipAngle);
  const ty = -Math.sin(tipAngle);
  const along = x * tx + y * ty;
  const across = Math.abs(x * -ty + y * tx);
  if (along > 0 && along < R_IN * inset * 0.86 && across < 0.055 * inset) {
    return heat(1);
  }

  // The hub.
  if (r < 0.1) return heat(0.9);

  return bg;
}

function render(size, { masked = false } = {}) {
  const inset = masked ? 0.72 : 1; // keep a maskable mark inside the safe circle
  const SS = 3;                    // supersampling for smooth edges
  const rgba = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const ny = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          const c = sample(nx, ny, { masked, inset });
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      // Un-premultiply against coverage so edges stay the right colour.
      const cover = a / n;
      rgba[i] = cover > 0 ? Math.round(r / (a / 255)) : 0;
      rgba[i + 1] = cover > 0 ? Math.round(g / (a / 255)) : 0;
      rgba[i + 2] = cover > 0 ? Math.round(b / (a / 255)) : 0;
      rgba[i + 3] = Math.round(cover);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync('icons', { recursive: true });

const outputs = [
  ['icons/icon-192.png', render(192)],
  ['icons/icon-512.png', render(512)],
  ['icons/maskable-512.png', render(512, { masked: true })],
  ['icons/apple-touch-icon.png', render(180, { masked: true })],
  ['icons/favicon-32.png', render(32)],
];

for (const [path, buffer] of outputs) {
  writeFileSync(path, buffer);
  console.log(`${path}  ${(buffer.length / 1024).toFixed(1)} kB`);
}
