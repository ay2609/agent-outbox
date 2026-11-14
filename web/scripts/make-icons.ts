// Generates the PNG icons (apple-touch-icon needs a PNG; iOS ignores SVG there) with no dependencies:
//   bun web/scripts/make-icons.ts
// Draws the same mark as public/icon.svg (a speech bubble with a check on a green tile), supersampled 4x for smooth edges.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Uint8Array): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const GREEN: [number, number, number] = [0x2f, 0x5d, 0x50], PAPER: [number, number, number] = [0xf6, 0xf5, 0xf2];
// Shapes in the 512-unit design space.
const inRoundRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inTri = (x: number, y: number, a: number[], b: number[], c: number[]): boolean => {
  const d = (p: number[], q: number[]) => (x - q[0]!) * (p[1]! - q[1]!) - (p[0]! - q[0]!) * (y - q[1]!);
  const d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const distSeg = (x: number, y: number, a: number[], b: number[]): number => {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!;
  const t = Math.max(0, Math.min(1, ((x - a[0]!) * dx + (y - a[1]!) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0]! + t * dx), y - (a[1]! + t * dy));
};
function color(x: number, y: number, maskable: boolean): [number, number, number, number] {
  // maskable: full-bleed tile and a mark scaled to the 80% safe zone
  const s = maskable ? 0.72 : 1;
  const u = (x - 256) / s + 256, v = (y - 256) / s + 256;
  const tile = maskable ? true : inRoundRect(x, y, 0, 0, 512, 512, 112);
  if (!tile) return [0, 0, 0, 0];
  const bubble = inRoundRect(u, v, 108, 150, 404, 326, 34) || inTri(u, v, [180, 320], [250, 320], [180, 378]);
  if (bubble) {
    const d = Math.min(distSeg(u, v, [196, 238], [240, 282]), distSeg(u, v, [240, 282], [320, 198]));
    if (d <= 15) return [...GREEN, 255];
    return [...PAPER, 255];
  }
  return [...GREEN, 255];
}
function render(size: number, maskable = false): Buffer {
  const ss = 4, px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const c = color(((x + (i + 0.5) / ss) / size) * 512, ((y + (j + 0.5) / ss) / size) * 512, maskable);
      r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
    }
    const o = (y * size + x) * 4, n = ss * ss;
    px[o] = a ? r / a : 0; px[o + 1] = a ? g / a : 0; px[o + 2] = a ? b / a : 0; px[o + 3] = a / n;
  }
  return png(size, size, px);
}
const out = join(import.meta.dir, "..", "public");
// apple-touch-icon must be opaque: iOS fills transparency with black, so render it full-bleed.
writeFileSync(join(out, "apple-touch-icon.png"), render(180, true));
writeFileSync(join(out, "icon-192.png"), render(192));
writeFileSync(join(out, "icon-512.png"), render(512));
writeFileSync(join(out, "icon-maskable-512.png"), render(512, true));
console.log("icons written to", out);
