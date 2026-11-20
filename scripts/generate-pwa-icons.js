#!/usr/bin/env node
// Generates the maskable PWA icons from the taskpapr mark (public/icons/mark.svg).
//
//   node scripts/generate-pwa-icons.js
//
// Writes public/icons/maskable_192.png and maskable_512.png. The outputs are
// committed; re-run this only when the mark changes.
//
// Why a hand-rolled rasteriser: the mark is three circles, a rounded rect and
// one path made of straight lines and two circular arcs, so ~100 lines of
// Node built-ins draw it exactly. That beats adding an image library to the
// dependency tree for a one-off asset step (DESIGN.md tenet 12).
//
// Maskable icons: Android crops them to a circle, squircle or rounded square,
// so the whole mark must sit inside the "safe zone", a centred circle whose
// radius is 40% of the icon size. The background fills the full square.

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// Colours sampled from public/icons/icon_512.png, so the maskable icons match
// the existing app icon.
const BG   = [0xf7, 0xf6, 0xf3];
const TEAL = [0x3f, 0x9d, 0xab];
const INK  = [0x26, 0x2b, 0x31];

// ── The mark, in mark.svg's 64×64 coordinate space ──────────────────────────
const dots = [[12.6, 15.7], [12.6, 31.7], [12.6, 47.7]].map(([cx, cy]) => ({ cx, cy, r: 3.6 }));

// mark.svg wraps the "t" in transform="translate(8.2 4.1) scale(0.9)".
const tx = (x, y) => [8.2 + 0.9 * x, 4.1 + 0.9 * y];

// Path "M28 4h11v33a10 10 0 0 0 10 10h3v11h-5a19 19 0 0 1-19-19z", flattened
// to a polygon. Arcs are circular, so each is drawn around its centre:
//   a10 from (39,37) to (49,47): centre (49,37), sweeping 180°→90°
//   a19 from (47,58) to (28,39): centre (47,39), sweeping 90°→180°
function arc(cx, cy, r, fromDeg, toDeg, steps = 48) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (fromDeg + (toDeg - fromDeg) * i / steps) * Math.PI / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
const stem = [
  [28, 4], [39, 4],
  ...arc(49, 37, 10, 180, 90),     // (39,37) → (49,47)
  [52, 47], [52, 58], [47, 58],
  ...arc(47, 39, 19, 90, 180),     // (47,58) → (28,39)
].map(([x, y]) => tx(x, y));

const [bx, by] = tx(16, 21);
const bar = { x: bx, y: by, w: 27 * 0.9, h: 10 * 0.9, rx: 1 * 0.9 };

// ── Geometry tests ──────────────────────────────────────────────────────────
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inCircle = (x, y, c) => (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r ** 2;
function inRoundRect(x, y, r) {
  if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return false;
  const qx = Math.max(r.x + r.rx - x, 0, x - (r.x + r.w - r.rx));
  const qy = Math.max(r.y + r.rx - y, 0, y - (r.y + r.h - r.rx));
  return qx * qx + qy * qy <= r.rx * r.rx;
}
function colourAt(x, y) {
  if (dots.some(c => inCircle(x, y, c))) return TEAL;
  if (inPolygon(x, y, stem) || inRoundRect(x, y, bar)) return INK;
  return null;
}

// Bounding box of the mark, so it can be centred precisely.
const allPts = [
  ...stem,
  [bar.x, bar.y], [bar.x + bar.w, bar.y + bar.h],
  ...dots.flatMap(c => [[c.cx - c.r, c.cy - c.r], [c.cx + c.r, c.cy + c.r]]),
];
const minX = Math.min(...allPts.map(p => p[0])), maxX = Math.max(...allPts.map(p => p[0]));
const minY = Math.min(...allPts.map(p => p[1])), maxY = Math.max(...allPts.map(p => p[1]));
const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
// Farthest point of the mark from its centre, so all of it (corners
// included) fits inside the safe-zone circle.
const reach = Math.max(...allPts.map(([x, y]) => Math.hypot(x - midX, y - midY)));

// ── Rasterise + encode ──────────────────────────────────────────────────────
function render(size) {
  const SAFE   = 0.40 * size * 0.92;   // safe-zone radius, with a little margin
  const scale  = SAFE / reach;
  const SS     = 4;                    // 4×4 supersampling for anti-aliasing
  const px     = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = midX + ((x + (sx + 0.5) / SS) - size / 2) / scale;
          const v = midY + ((y + (sy + 0.5) / SS) - size / 2) / scale;
          const c = colourAt(u, v) || BG;
          acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
      }
      const i = (y * size + x) * 4;
      px[i]     = Math.round(acc[0] / (SS * SS));
      px[i + 1] = Math.round(acc[1] / (SS * SS));
      px[i + 2] = Math.round(acc[2] / (SS * SS));
      px[i + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td  = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
for (const size of [192, 512]) {
  const file = path.join(outDir, `maskable_${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
