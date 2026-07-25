/* Rasterises the app mark to PNG (no dependencies).
 * Run: node tools/make-icons.mjs
 * Shapes are signed-distance fields, so edges come out antialiased. */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const GREEN = [0x00, 0xff, 0x41];
const BLACK = [0x00, 0x00, 0x00];

/* geometry in a 512-unit square, matching icons/icon.svg */
const CAPSULES = [
  [168, 236, 400, 296, 15, 1],
  [162, 240, 152, 336, 15, 1],
  [152, 336, 232, 336, 15, 1],
  [400, 296, 424, 392, 15, 1],
  [92, 404, 452, 404, 7, 0.5]
];
const CIRCLES = [[128, 228, 34, 1]];
const FRAME = { x: 26, y: 26, w: 460, h: 486 - 26, r: 26, s: 5, a: 0.35 };

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const roundRectDist = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

function render(size, inset) {
  const px = new Uint8Array(size * size * 4);
  const k = size / 512;                       // unit → pixel scale
  const s = (1 - inset) ;                     // maskable safe-zone shrink
  const map = (v) => (v - 256) * s * k + size / 2;
  const aa = 0.9;                             // edge softness, in pixels

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = x + 0.5, uy = y + 0.5;
      let r = BLACK[0], g = BLACK[1], b = BLACK[2];

      const paint = (cov, alpha) => {
        const a = Math.max(0, Math.min(1, cov)) * alpha;
        if (a <= 0) return;
        r += (GREEN[0] - r) * a; g += (GREEN[1] - g) * a; b += (GREEN[2] - b) * a;
      };

      const fd = Math.abs(roundRectDist(ux, uy, size / 2, size / 2,
        (FRAME.w / 2) * s * k, (FRAME.h / 2) * s * k, FRAME.r * s * k)) - FRAME.s * s * k;
      paint(0.5 - fd / aa, FRAME.a);

      for (const [ax, ay, bx, by, rad, alpha] of CAPSULES) {
        const d = segDist(ux, uy, map(ax), map(ay), map(bx), map(by)) - rad * s * k;
        paint(0.5 - d / aa, alpha);
      }
      for (const [cx, cy, rad, alpha] of CIRCLES) {
        const d = Math.hypot(ux - map(cx), uy - map(cy)) - rad * s * k;
        paint(0.5 - d / aa, alpha);
      }

      const o = (y * size + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  return px;
}

/* ── minimal PNG writer ── */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
const out = (name, size, inset) => {
  const file = new URL('../icons/' + name, import.meta.url);
  writeFileSync(file, png(size, render(size, inset)));
  console.log(name, size + 'px');
};
out('icon-192.png', 192, 0);
out('icon-512.png', 512, 0);
out('icon-maskable-512.png', 512, 0.2);
