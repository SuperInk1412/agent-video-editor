// 16-bit PNG in, 16-bit PNG out — for the one screen-effect implementation
// (docs/DESIGN-BACKEND-V2.md §5.4, WP3.5 / decision D2).
//
// Blender writes 16-bit PNGs and the export must not throw that depth away, but
// a browser cannot hand a 16-bit image to WebGL: `Image`/`createImageBitmap`
// decode every PNG to 8 bits per channel. So the sandbox page decodes the PNG
// bytes itself (this module), uploads the samples as float, and encodes the
// result back to 16-bit PNG. Zero dependencies: `DecompressionStream` /
// `CompressionStream` are the zlib the platform already ships (Chromium, and
// Node 18+ — which is why `tests/post-shaders.test.mjs` can round-trip this
// module without a GPU).
//
// Scope, deliberately small: non-interlaced, bit depth 8 or 16, colour type
// 0/2/4/6 (grey, RGB, grey+alpha, RGBA). That is what Blender writes and what
// the post pass produces. Anything else throws instead of guessing.
//
// Everything is straight (un-premultiplied) RGBA, top-down: PNG's own
// convention, and the orientation the preview's scene FBO has in memory.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const readU32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

/** Walk the chunk list; returns [{ type, data }] with the data as subarrays. */
function chunks(bytes) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('png16：不是 PNG（签名不对）');
  }
  const out = [];
  let at = SIGNATURE.length;
  while (at + 12 <= bytes.length) {
    const length = readU32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const start = at + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error(`png16：块 ${type} 被截断`);
    out.push({ type, data: bytes.subarray(start, end) });
    at = end + 4; // skip the CRC
    if (type === 'IEND') break;
  }
  return out;
}

/** The bit depth a PNG file carries (8 or 16), or null when it is not a PNG. */
export function pngBitDepth(bytes) {
  try {
    for (const chunk of chunks(bytes)) if (chunk.type === 'IHDR') return chunk.data[8];
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a PNG to straight RGBA, 16 bits per sample, top-down.
 * Returns `{ width, height, depth, data }` where `depth` is the file's own bit
 * depth and `data` is a Uint16Array of `width * height * 4` samples.
 */
export async function decodePng(bytes) {
  let header = null;
  const idat = [];
  for (const chunk of chunks(bytes)) {
    if (chunk.type === 'IHDR') header = chunk.data;
    else if (chunk.type === 'IDAT') idat.push(chunk.data);
  }
  if (!header) throw new Error('png16：缺少 IHDR');
  if (!idat.length) throw new Error('png16：缺少 IDAT');
  const width = readU32(header, 0);
  const height = readU32(header, 4);
  const depth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`png16：不支持的颜色类型 ${colorType}`);
  if (depth !== 8 && depth !== 16) throw new Error(`png16：不支持的位深 ${depth}`);
  if (interlace !== 0) throw new Error('png16：不支持隔行 PNG');
  if (!width || !height) throw new Error('png16：尺寸为 0');

  let size = 0;
  for (const part of idat) size += part.length;
  const compressed = new Uint8Array(size);
  let offset = 0;
  for (const part of idat) { compressed.set(part, offset); offset += part.length; }
  const raw = await inflate(compressed);

  const sampleBytes = depth / 8;
  const bpp = channels * sampleBytes;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new Error(`png16：像素数据不完整（${raw.length} < ${(stride + 1) * height}）`);

  const out = new Uint16Array(width * height * 4);
  let prior = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  const toSample = (value) => (depth === 16 ? value : value * 257);


  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    const filter = raw[rowAt];
    line = raw.subarray(rowAt + 1, rowAt + 1 + stride);
    // Unfilter in place (line is a view into `raw`, which nothing else reads).
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let x = bpp; x < stride; x++) line[x] = (line[x] + line[x - bpp]) & 0xff;
        break;
      case 2:
        for (let x = 0; x < stride; x++) line[x] = (line[x] + prior[x]) & 0xff;
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? line[x - bpp] : 0;
          line[x] = (line[x] + ((left + prior[x]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? line[x - bpp] : 0;
          const up = prior[x];
          const upLeft = x >= bpp ? prior[x - bpp] : 0;
          line[x] = (line[x] + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`png16：未知的行过滤器 ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const base = x * bpp;
      const target = (y * width + x) * 4;
      if (depth === 16) {
        if (channels === 1 || channels === 2) {
          const g = (line[base] << 8) | line[base + 1];
          out[target] = g; out[target + 1] = g; out[target + 2] = g;
          out[target + 3] = channels === 2 ? ((line[base + 2] << 8) | line[base + 3]) : 0xffff;
        } else {
          out[target] = (line[base] << 8) | line[base + 1];
          out[target + 1] = (line[base + 2] << 8) | line[base + 3];
          out[target + 2] = (line[base + 4] << 8) | line[base + 5];
          out[target + 3] = channels === 4 ? ((line[base + 6] << 8) | line[base + 7]) : 0xffff;
        }
      } else if (channels === 1 || channels === 2) {
        const g = toSample(line[base]);
        out[target] = g; out[target + 1] = g; out[target + 2] = g;
        out[target + 3] = channels === 2 ? toSample(line[base + 1]) : 0xffff;
      } else {
        out[target] = toSample(line[base]);
        out[target + 1] = toSample(line[base + 1]);
        out[target + 2] = toSample(line[base + 2]);
        out[target + 3] = channels === 4 ? toSample(line[base + 3]) : 0xffff;
      }
    }
    prior = line;
  }
  return { width, height, depth, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode straight RGBA 16-bit samples as a PNG (colour type 6, bit depth 16,
 * no interlace). `data` is a Uint16Array of `width * height * 4` samples,
 * top-down.
 */
export async function encodePng16({ width, height, data }) {
  if (!width || !height) throw new Error('png16：尺寸为 0');
  if (!data || data.length < width * height * 4) throw new Error('png16：像素数据不完整');
  const stride = width * 8;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    raw[rowAt] = 0; // filter: none
    let at = rowAt + 1;
    const source = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = source + x * 4;
      raw[at++] = data[i] >> 8;
      raw[at++] = data[i] & 0xff;
      raw[at++] = data[i + 1] >> 8;
      raw[at++] = data[i + 1] & 0xff;
      raw[at++] = data[i + 2] >> 8;
      raw[at++] = data[i + 2] & 0xff;
      raw[at++] = data[i + 3] >> 8;
      raw[at++] = data[i + 3] & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 16;  // bit depth
  header[9] = 6;   // colour type: RGBA
  header[10] = 0;  // compression
  header[11] = 0;  // filter
  header[12] = 0;  // interlace
  const body = await deflate(raw);
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', body),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
