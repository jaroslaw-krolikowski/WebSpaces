// Builds the extension icons from the source logo.
//
// The logo is glowing shapes on a black field. A toolbar icon has to be
// transparent instead, so the black is not drawn: alpha comes from how bright a
// pixel is, and the colour is divided back out of it. Composited over black that
// reproduces the original exactly, and over a light theme it shows the shapes
// rather than a black tile.
//
// The artwork is then cropped to the pixels that actually carry light before
// being scaled, otherwise the empty margins of the source would shrink the
// shapes to half the canvas.
//
// Downscaling uses a box filter: every output pixel averages the source pixels
// it covers. Nearest neighbour would shred the soft glow at 16 pixels.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const SOURCE = "src/logo-webspaces.png";
const SIZES = [16, 32, 48, 128];

/**
 * Below this the glow is indistinguishable from the background. The source
 * fades almost to the frame, so a low threshold crops nothing at all and a high
 * one starts eating visible light; this keeps the glow and drops the dead margin.
 */
const EDGE = 64;

const source = PNG.sync.read(readFileSync(SOURCE));

/** Brightness of the brightest channel, which becomes the alpha value. */
function light(index) {
  return Math.max(source.data[index], source.data[index + 1], source.data[index + 2]);
}

/** The region of the source that carries any light worth keeping. */
function contentBox() {
  let left = source.width;
  let top = source.height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (light((y * source.width + x) * 4) <= EDGE) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (left > right) return { left: 0, top: 0, width: source.width, height: source.height };
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

const box = contentBox();

/**
 * Averages the source pixels under one output pixel and converts the result from
 * light-on-black into straight colour plus alpha.
 */
function sample(x0, y0, x1, y1) {
  const left = Math.max(box.left, Math.floor(x0));
  const top = Math.max(box.top, Math.floor(y0));
  const right = Math.min(box.left + box.width, Math.ceil(x1));
  const bottom = Math.min(box.top + box.height, Math.ceil(y1));

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

  if (n === 0) return [0, 0, 0, 0];
  r /= n;
  g /= n;
  b /= n;

  const alpha = Math.max(r, g, b);
  if (alpha <= 0) return [0, 0, 0, 0];

  // Dividing the colour back out of its own brightness turns additive light into
  // a straight colour that alpha can carry.
  const scale = 255 / alpha;
  return [r * scale, g * scale, b * scale, alpha];
}

function render(size) {
  const png = new PNG({ width: size, height: size });
  png.data.fill(0);

  // Fit the content box into the square, keeping its proportions.
  const fit = Math.min(size / box.width, size / box.height);
  const drawnWidth = Math.max(1, Math.round(box.width * fit));
  const drawnHeight = Math.max(1, Math.round(box.height * fit));
  const offsetX = Math.floor((size - drawnWidth) / 2);
  const offsetY = Math.floor((size - drawnHeight) / 2);
  const stepX = box.width / drawnWidth;
  const stepY = box.height / drawnHeight;

  for (let y = 0; y < drawnHeight; y += 1) {
    for (let x = 0; x < drawnWidth; x += 1) {
      const pixel = sample(
        box.left + x * stepX,
        box.top + y * stepY,
        box.left + (x + 1) * stepX,
        box.top + (y + 1) * stepY,
      );

      const i = ((y + offsetY) * size + (x + offsetX)) * 4;
      png.data[i] = Math.round(pixel[0]);
      png.data[i + 1] = Math.round(pixel[1]);
      png.data[i + 2] = Math.round(pixel[2]);
      png.data[i + 3] = Math.round(pixel[3]);
    }
  }
  return PNG.sync.write(png);
}

mkdirSync("public/icons", { recursive: true });
console.log(`Content box: ${box.width}x${box.height} at ${box.left},${box.top}`);
for (const size of SIZES) {
  writeFileSync(`public/icons/icon${size}.png`, render(size));
  console.log(`public/icons/icon${size}.png`);
}
