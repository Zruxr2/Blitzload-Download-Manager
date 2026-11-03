'use strict';
// Draws the app icon (blue tile, white download arrow) and writes it as a PNG.
// Run with: npm run icon
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 512;
const SS = 3; // supersampling per axis

function crc32(buf) {
  let c;
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), N - r);
  const cy = Math.min(Math.max(y, r), N - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inArrow = (x, y) => {
  const shaft = x >= 224 && x <= 288 && y >= 112 && y <= 288;
  const head = y >= 240 && y <= 360 && Math.abs(x - 256) <= (360 - y) * 1.1;
  const tray = x >= 128 && x <= 384 && y >= 380 && y <= 412;
  return shaft || head || tray;
};

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let tile = 0;
    let arrow = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (inRoundRect(px, py, 112)) {
          tile++;
          if (inArrow(px, py)) arrow++;
        }
      }
    }
    const total = SS * SS;
    const t = (x + y) / (2 * N);
    const bg = [47 + (23 - 47) * t, 107 + (162 - 107) * t, 255 + (196 - 255) * t]; // blue -> cyan
    const a = tile / total;
    const w = tile ? arrow / tile : 0;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(bg[0] * (1 - w) + 255 * w);
    raw[o + 1] = Math.round(bg[1] * (1 - w) + 255 * w);
    raw[o + 2] = Math.round(bg[2] * (1 - w) + 255 * w);
    raw[o + 3] = Math.round(a * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

for (const out of [path.join(__dirname, '..', 'assets', 'icon.png'), path.join(__dirname, '..', 'renderer', 'icon.png')]) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log('wrote', out);
}
