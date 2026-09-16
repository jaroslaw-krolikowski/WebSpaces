// Builds the extension icons from the source logo.
//
// The logo is wider than it is tall, so it is scaled to fit the width and
// centred on a square canvas. The padding is opaque black, which is also the
// background of the logo itself, so the bars read as part of the artwork rather
// than as a frame.
//
// Downscaling uses a box filter: every output pixel averages the source pixels
// it covers. Nearest neighbour would shred the soft glow at 16 pixels.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const SOURCE = "src/logo-webspaces.png";
const SIZES = [16, 32, 48, 128];
const BACKGROUND = [0, 0, 0, 255];

const source = PNG.sync.read(readFileSync(SOURCE));

/** Average of the source pixels covered by one output pixel. */
function sample(x0, y0, x1, y1) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(source.width, Math.ceil(x1));
  const bottom = Math.min(source.height, Math.ceil(y1));

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const i = (y * source.width + x) * 4;
      r += source.data[i];
      g += source.data[i + 1];
      b += source.data[i + 2];
      n += 1;
    }
  }

  if (n === 0) return BACKGROUND;
  return [r / n, g / n, b / n, 255];
}

function render(size) {
  const png = new PNG({ width: size, height: size });
  // Scale to fit the width, then centre what that leaves vertically.
  const drawn = Math.round((size * source.height) / source.width);
  const offset = Math.floor((size - drawn) / 2);
  const step = source.width / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = y >= offset && y < offset + drawn;
      const pixel = inside
        ? sample(x * step, (y - offset) * step, (x + 1) * step, (y - offset + 1) * step)
        : BACKGROUND;

      const i = (y * size + x) * 4;
      png.data[i] = Math.round(pixel[0]);
      png.data[i + 1] = Math.round(pixel[1]);
      png.data[i + 2] = Math.round(pixel[2]);
      // Opaque throughout: the logo carries its own dark background, and a
      // partly transparent icon would look ragged on a dark browser theme.
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

mkdirSync("public/icons", { recursive: true });
for (const size of SIZES) {
  writeFileSync(`public/icons/icon${size}.png`, render(size));
  console.log(`public/icons/icon${size}.png`);
}
