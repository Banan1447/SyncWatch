#!/usr/bin/env node
// Generates PWA PNG icons using only Node.js built-ins (no extra deps).
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── PNG builder ────────────────────────────────────────────────────────────
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([t, data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function makePNG(size, pixelFn) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // bytes 10-12 = 0 (compression, filter, interlace)

  // Build raw scanlines: filter byte (0) + RGBA per pixel
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      row[1 + x * 4]     = r;
      row[1 + x * 4 + 1] = g;
      row[1 + x * 4 + 2] = b;
      row[1 + x * 4 + 3] = a;
    }
    rows.push(row);
  }
  const compressed = deflateSync(Buffer.concat(rows), { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Pixel renderer ─────────────────────────────────────────────────────────
// Design: dark bg (#09090f), purple rounded square, white play triangle
function watchsyncPixel(x, y, size) {
  const cx = size / 2, cy = size / 2;
  const pad = size * 0.1;
  const r = size / 2 - pad;
  const cornerR = size * 0.22;

  // Rounded-rect SDF
  const qx = Math.abs(x - cx) - r + cornerR;
  const qy = Math.abs(y - cy) - r + cornerR;
  const dist = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - cornerR;

  // Background
  const bg = [9, 9, 15];

  if (dist > 1) return [...bg, 255];           // outside rounded rect → dark bg

  // Purple fill with pink tint gradient
  const t = (x + y) / (size * 2);
  const pr = Math.round(124 + (108 - 124) * t); // #7c6ff7 → #6d28d9
  const pg = Math.round(111 + (40 - 111) * t);
  const pb = Math.round(247 + (217 - 247) * t);

  // Anti-alias edge
  const alpha = dist < 0 ? 255 : Math.round(255 * (1 - dist));
  const blendA = alpha / 255;
  const R = Math.round(pr * blendA + bg[0] * (1 - blendA));
  const G = Math.round(pg * blendA + bg[1] * (1 - blendA));
  const B = Math.round(pb * blendA + bg[2] * (1 - blendA));

  // Play triangle (white)
  const tx = x - cx * 1.05, ty = y - cy;
  const triH = r * 0.55, triW = r * 0.48;
  const inTri = tx > -triW * 0.55 && Math.abs(ty) < triH * (1 - (tx + triW * 0.55) / (triW * 1.55 + triW * 0.55));
  if (inTri && dist < 0) return [240, 240, 255, 255];

  return [R, G, B, 255];
}

// ── Generate ───────────────────────────────────────────────────────────────
const outDir = resolve(__dir, '../public/icons');
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = makePNG(size, watchsyncPixel);
  const out = resolve(outDir, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`Generated ${out} (${png.length} bytes)`);
}
