// Rebuild the PWA PNG icons with Node.js built-ins only: node scripts/generate-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve('public/icons');
const colors = { mint: [166, 227, 176, 255], ink: [20, 32, 24, 255] };

function canvas(size) { return new Uint8Array(size * size * 4); }
function pixel(data, size, x, y, color) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const at = (y * size + x) * 4;
  data[at] = color[0]; data[at + 1] = color[1]; data[at + 2] = color[2]; data[at + 3] = color[3];
}
function roundedRect(data, size, x, y, width, height, radius, color) {
  const scale = size / 512;
  x *= scale; y *= scale; width *= scale; height *= scale; radius *= scale;
  for (let py = Math.floor(y); py < Math.ceil(y + height); py++) for (let px = Math.floor(x); px < Math.ceil(x + width); px++) {
    const cx = Math.max(x + radius, Math.min(px + .5, x + width - radius));
    const cy = Math.max(y + radius, Math.min(py + .5, y + height - radius));
    if ((px + .5 - cx) ** 2 + (py + .5 - cy) ** 2 <= radius ** 2) pixel(data, size, px, py, color);
  }
}
function line(data, size, x1, y1, x2, y2, strokeWidth, color) {
  const scale = size / 512; x1 *= scale; y1 *= scale; x2 *= scale; y2 *= scale; strokeWidth *= scale;
  const distance = Math.hypot(x2 - x1, y2 - y1); const steps = Math.max(1, Math.ceil(distance * 1.5)); const radius = strokeWidth / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; const x = x1 + (x2 - x1) * t; const y = y1 + (y2 - y1) * t;
    for (let py = Math.floor(y - radius); py <= Math.ceil(y + radius); py++) for (let px = Math.floor(x - radius); px <= Math.ceil(x + radius); px++) {
      if ((px + .5 - x) ** 2 + (py + .5 - y) ** 2 <= radius ** 2) pixel(data, size, px, py, color);
    }
  }
}
function polygon(data, size, points, color) {
  const scale = size / 512; points = points.map(([x, y]) => [x * scale, y * scale]);
  const minY = Math.floor(Math.min(...points.map((point) => point[1]))); const maxY = Math.ceil(Math.max(...points.map((point) => point[1])));
  const minX = Math.floor(Math.min(...points.map((point) => point[0]))); const maxX = Math.ceil(Math.max(...points.map((point) => point[0])));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]; const [xj, yj] = points[j];
      if (((yi > y + .5) !== (yj > y + .5)) && (x + .5 < (xj - xi) * (y + .5 - yi) / (yj - yi) + xi)) inside = !inside;
    }
    if (inside) pixel(data, size, x, y, color);
  }
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) scanlines.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
function draw(size) {
  const data = canvas(size); roundedRect(data, size, 0, 0, 512, 512, 128, colors.mint);
  roundedRect(data, size, 99, 142, 314, 267, 42, colors.ink);
  roundedRect(data, size, 122, 164, 268, 222, 24, colors.mint);
  line(data, size, 123, 211, 389, 211, 24, colors.ink);
  line(data, size, 162, 118, 162, 172, 25, colors.ink); line(data, size, 350, 118, 350, 172, 25, colors.ink);
  polygon(data, size, [[256, 372], [231, 354], [207, 335], [184, 312], [165, 289], [157, 270], [158, 252], [166, 239], [179, 231], [196, 228], [211, 231], [225, 240], [238, 254], [256, 274], [274, 254], [287, 240], [301, 231], [316, 228], [333, 231], [346, 239], [354, 252], [355, 270], [347, 289], [328, 312], [305, 335], [281, 354]], colors.ink);
  return data;
}
fs.mkdirSync(root, { recursive: true });
for (const size of [192, 512]) fs.writeFileSync(path.join(root, `icon-${size}.png`), png(size, draw(size)));
