// Icon generator. Draws a rounded square with a 2x2 grid where one cell has a
// different colour — a readable shorthand for "one of several sessions is live".
// The PNG encoder is homemade so the project pulls in no image dependency.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BLUE = [26, 115, 232, 255];
const WHITE = [255, 255, 255, 255];
const ORANGE = [250, 144, 62, 255];
const CLEAR = [0, 0, 0, 0];

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const pad = size * 0.22;
  const gap = Math.max(1, size * 0.09);
  const cell = (size - pad * 2 - gap) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Rounding: only the corners are cut, the edges stay straight.
      const cx = Math.min(Math.max(x, radius), size - 1 - radius);
      const cy = Math.min(Math.max(y, radius), size - 1 - radius);
      let color = Math.hypot(x - cx, y - cy) <= radius ? BLUE : CLEAR;

      if (color === BLUE) {
        for (let row = 0; row < 2; row += 1) {
          for (let col = 0; col < 2; col += 1) {
            const x0 = pad + col * (cell + gap);
            const y0 = pad + row * (cell + gap);
            if (x >= x0 && x < x0 + cell && y >= y0 && y < y0 + cell) {
              color = row === 0 && col === 0 ? ORANGE : WHITE;
            }
          }
        }
      }

      const offset = (y * size + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
  return pixels;
}

mkdirSync("public/icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`public/icons/icon${size}.png`, encodePng(size, draw(size)));
  console.log(`public/icons/icon${size}.png`);
}
