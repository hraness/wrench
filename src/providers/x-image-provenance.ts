import { deflateSync, inflateSync } from "node:zlib";

/**
 * Pixel-only X upload bytes. Re-encode PNG/JPEG so C2PA, XMP, Exif, IPTC, and
 * Adobe provenance cannot ride along in ancillary chunks or APP segments.
 */

export const IMAGE_PROVENANCE_MARKER = /c2pa|cabx|trainedalgorithmic|digitalsourcetype/iu;

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const MAX_PNG_DIMENSION = 16_384;
const MAX_PNG_PIXELS = 16_384 * 16_384;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24)
    | ((bytes[offset + 1] ?? 0) << 16)
    | ((bytes[offset + 2] ?? 0) << 8)
    | (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function asciiBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    output[index] = value.charCodeAt(index) & 0xff;
  }
  return output;
}

type PngChunk = {
  readonly type: string;
  readonly data: Uint8Array;
};

function parsePngChunks(bytes: Uint8Array): readonly PngChunk[] {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength + 12) {
    throw new Error("X PNG attachment is not a complete PNG");
  }
  for (const [index, expected] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== expected) throw new Error("X PNG attachment is not a complete PNG");
  }
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.byteLength;
  let sawIend = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32(bytes, offset);
    if (length > bytes.byteLength - offset - 12) {
      throw new Error("X PNG attachment contained a truncated chunk");
    }
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error("X PNG attachment contained an invalid chunk type");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = readUint32(bytes, offset + 8 + length);
    if (pngCrc(concatBytes([typeBytes, data])) !== expectedCrc) {
      throw new Error("X PNG attachment failed its chunk checksum");
    }
    chunks.push({ type, data: new Uint8Array(data) });
    offset += 12 + length;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend) throw new Error("X PNG attachment omitted IEND");
  if (chunks[0]?.type !== "IHDR") throw new Error("X PNG attachment omitted IHDR");
  return Object.freeze(chunks);
}

function writePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiBytes(type);
  const output = new Uint8Array(12 + data.byteLength);
  writeUint32(output, 0, data.byteLength);
  output.set(typeBytes, 4);
  output.set(data, 8);
  writeUint32(output, 8 + data.byteLength, pngCrc(concatBytes([typeBytes, data])));
  return output;
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

function bytesPerPixel(bitDepth: number, colorType: number): number {
  const samples = colorType === 0 || colorType === 3
    ? 1
    : colorType === 2
      ? 3
      : colorType === 4
        ? 2
        : 4;
  return Math.max(1, Math.ceil((samples * bitDepth) / 8));
}

function scanlineWidth(width: number, bitDepth: number, colorType: number): number {
  const samples = colorType === 0 || colorType === 3
    ? 1
    : colorType === 2
      ? 3
      : colorType === 4
        ? 2
        : 4;
  return Math.ceil((width * samples * bitDepth) / 8);
}

function unfilter(
  filtered: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
): Uint8Array {
  const bpp = bytesPerPixel(bitDepth, colorType);
  const stride = scanlineWidth(width, bitDepth, colorType);
  const expected = height * (stride + 1);
  if (filtered.byteLength !== expected) {
    throw new Error("X PNG attachment scanlines did not match IHDR");
  }
  const raw = new Uint8Array(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[row * (stride + 1)] ?? 0;
    const source = filtered.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const destination = raw.subarray(row * stride, row * stride + stride);
    const prior = row === 0 ? null : raw.subarray((row - 1) * stride, row * stride);
    for (let column = 0; column < stride; column += 1) {
      const sample = source[column] ?? 0;
      const left = column >= bpp ? destination[column - bpp] ?? 0 : 0;
      const up = prior?.[column] ?? 0;
      const upLeft = prior !== null && column >= bpp ? prior[column - bpp] ?? 0 : 0;
      const reconstructed = filter === 0
        ? sample
        : filter === 1
          ? (sample + left) & 0xff
          : filter === 2
            ? (sample + up) & 0xff
            : filter === 3
              ? (sample + Math.floor((left + up) / 2)) & 0xff
              : filter === 4
                ? (sample + paethPredictor(left, up, upLeft)) & 0xff
                : null;
      if (reconstructed === null) throw new Error("X PNG attachment used an unsupported filter");
      destination[column] = reconstructed;
    }
  }
  return raw;
}

function sampleChannel(
  packed: Uint8Array,
  pixelIndex: number,
  channel: number,
  channels: number,
  bitDepth: number,
): number {
  if (bitDepth === 8) return packed[pixelIndex * channels + channel] ?? 0;
  if (bitDepth === 16) {
    const offset = (pixelIndex * channels + channel) * 2;
    return packed[offset] ?? 0;
  }
  const bitsPerPixel = channels * bitDepth;
  const bitOffset = pixelIndex * bitsPerPixel + channel * bitDepth;
  const byteIndex = Math.floor(bitOffset / 8);
  const shift = 8 - bitDepth - (bitOffset % 8);
  const mask = (1 << bitDepth) - 1;
  const value = ((packed[byteIndex] ?? 0) >> shift) & mask;
  return bitDepth === 1 ? value * 255 : Math.round((value * 255) / mask);
}

function expandToRgba(
  packed: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const channels = colorType === 0
    ? 1
    : colorType === 2
      ? 3
      : colorType === 3
        ? 1
        : colorType === 4
          ? 2
          : 4;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const dest = pixel * 4;
    if (colorType === 3) {
      const index = sampleChannel(packed, pixel, 0, 1, bitDepth);
      rgba[dest] = palette?.[index * 3] ?? 0;
      rgba[dest + 1] = palette?.[index * 3 + 1] ?? 0;
      rgba[dest + 2] = palette?.[index * 3 + 2] ?? 0;
      rgba[dest + 3] = transparency?.[index] ?? 255;
      continue;
    }
    const red = sampleChannel(packed, pixel, 0, channels, bitDepth);
    const green = colorType === 0 || colorType === 4
      ? red
      : sampleChannel(packed, pixel, 1, channels, bitDepth);
    const blue = colorType === 0 || colorType === 4
      ? red
      : sampleChannel(packed, pixel, 2, channels, bitDepth);
    const alpha = colorType === 4
      ? sampleChannel(packed, pixel, 1, channels, bitDepth)
      : colorType === 6
        ? sampleChannel(packed, pixel, 3, channels, bitDepth)
        : transparency === null
          ? 255
          : colorType === 0
            ? (red === (transparency[0] ?? -1) ? 0 : 255)
            : (
              red === (transparency[1] ?? -1)
              && green === (transparency[3] ?? -1)
              && blue === (transparency[5] ?? -1)
            ) ? 0 : 255;
    rgba[dest] = red;
    rgba[dest + 1] = green;
    rgba[dest + 2] = blue;
    rgba[dest + 3] = alpha;
  }
  return rgba;
}

const ADAM7 = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
] as const;

function passSize(width: number, height: number, pass: (typeof ADAM7)[number]): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: pass.x >= width ? 0 : Math.floor((width - pass.x - 1) / pass.dx) + 1,
    height: pass.y >= height ? 0 : Math.floor((height - pass.y - 1) / pass.dy) + 1,
  };
}

function decodePngToRgba(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
} {
  const chunks = parsePngChunks(bytes);
  const ihdr = chunks[0]!.data;
  if (ihdr.byteLength !== 13) throw new Error("X PNG attachment IHDR was invalid");
  const width = readUint32(ihdr, 0);
  const height = readUint32(ihdr, 4);
  const bitDepth = ihdr[8] ?? 0;
  const colorType = ihdr[9] ?? 0;
  const compression = ihdr[10] ?? 1;
  const filter = ihdr[11] ?? 1;
  const interlace = ihdr[12] ?? 1;
  if (
    width < 1
    || height < 1
    || width > MAX_PNG_DIMENSION
    || height > MAX_PNG_DIMENSION
    || width * height > MAX_PNG_PIXELS
  ) {
    throw new Error("X PNG attachment dimensions escaped the reviewed bound");
  }
  if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
    throw new Error("X PNG attachment used an unsupported IHDR method");
  }
  if (![0, 2, 3, 4, 6].includes(colorType)) {
    throw new Error("X PNG attachment used an unsupported color type");
  }
  if (
    (colorType === 3 && ![1, 2, 4, 8].includes(bitDepth))
    || (colorType !== 3 && ![8, 16].includes(bitDepth) && !(colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)))
  ) {
    throw new Error("X PNG attachment used an unsupported bit depth");
  }
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (const chunk of chunks.slice(1)) {
    if (chunk.type === "PLTE") palette = chunk.data;
    else if (chunk.type === "tRNS") transparency = chunk.data;
    else if (chunk.type === "IDAT") idat.push(chunk.data);
  }
  if (colorType === 3 && palette === null) throw new Error("X PNG attachment omitted PLTE");
  if (idat.length === 0) throw new Error("X PNG attachment omitted IDAT");
  let inflated: Uint8Array;
  try {
    inflated = new Uint8Array(inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part)))));
  } catch {
    throw new Error("X PNG attachment IDAT could not be inflated");
  }
  if (interlace === 0) {
    const raw = unfilter(inflated, width, height, bitDepth, colorType);
    return {
      width,
      height,
      rgba: expandToRgba(raw, width, height, bitDepth, colorType, palette, transparency),
    };
  }
  const rgba = new Uint8Array(width * height * 4);
  let offset = 0;
  for (const pass of ADAM7) {
    const size = passSize(width, height, pass);
    if (size.width === 0 || size.height === 0) continue;
    const expected = size.height * (scanlineWidth(size.width, bitDepth, colorType) + 1);
    const passBytes = inflated.subarray(offset, offset + expected);
    if (passBytes.byteLength !== expected) {
      throw new Error("X PNG attachment interlacing did not match IHDR");
    }
    const raw = unfilter(passBytes, size.width, size.height, bitDepth, colorType);
    const passRgba = expandToRgba(raw, size.width, size.height, bitDepth, colorType, palette, transparency);
    for (let row = 0; row < size.height; row += 1) {
      for (let column = 0; column < size.width; column += 1) {
        const source = (row * size.width + column) * 4;
        const destX = pass.x + column * pass.dx;
        const destY = pass.y + row * pass.dy;
        rgba.set(passRgba.subarray(source, source + 4), (destY * width + destX) * 4);
      }
    }
    offset += expected;
  }
  if (offset !== inflated.byteLength) {
    throw new Error("X PNG attachment interlacing left unread IDAT");
  }
  return { width, height, rgba };
}

export function encodePixelsOnlyPng(input: {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}): Uint8Array {
  if (
    input.width < 1
    || input.height < 1
    || input.width > MAX_PNG_DIMENSION
    || input.height > MAX_PNG_DIMENSION
    || input.rgba.byteLength !== input.width * input.height * 4
  ) {
    throw new Error("X PNG encoder received an invalid pixel buffer");
  }
  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, input.width);
  writeUint32(ihdr, 4, input.height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = input.width * 4;
  const filtered = new Uint8Array(input.height * (stride + 1));
  for (let row = 0; row < input.height; row += 1) {
    filtered[row * (stride + 1)] = 0;
    filtered.set(
      input.rgba.subarray(row * stride, row * stride + stride),
      row * (stride + 1) + 1,
    );
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(filtered), { level: 9 }));
  return concatBytes([
    PNG_SIGNATURE,
    writePngChunk("IHDR", ihdr),
    writePngChunk("IDAT", idat),
    writePngChunk("IEND", new Uint8Array()),
  ]);
}

export function embedPngChunk(
  bytes: Uint8Array,
  type: string,
  data: Uint8Array,
): Uint8Array {
  if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error("PNG test chunk type must be four letters");
  const chunks = [...parsePngChunks(bytes)];
  const iend = chunks.findIndex((chunk) => chunk.type === "IEND");
  if (iend < 0) throw new Error("PNG fixture omitted IEND");
  chunks.splice(iend, 0, { type, data: new Uint8Array(data) });
  return concatBytes([
    PNG_SIGNATURE,
    ...chunks.map((chunk) => writePngChunk(chunk.type, chunk.data)),
  ]);
}

function pngChunkTypes(bytes: Uint8Array): readonly string[] {
  return parsePngChunks(bytes).map((chunk) => chunk.type);
}

export function reencodePixelsOnlyPng(bytes: Uint8Array): Uint8Array {
  const decoded = decodePngToRgba(bytes);
  return encodePixelsOnlyPng(decoded);
}

function stripJpegProvenance(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("X JPEG attachment is not a complete JPEG");
  }
  const kept: number[] = [0xff, 0xd8];
  let offset = 2;
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      throw new Error("X JPEG attachment left its marker structure");
    }
    let marker = bytes[offset + 1] ?? 0;
    while (marker === 0xff && offset + 2 < bytes.byteLength) {
      offset += 1;
      marker = bytes[offset + 1] ?? 0;
    }
    if (marker === 0xd9) {
      kept.push(0xff, 0xd9);
      break;
    }
    if (marker === 0xda) {
      kept.push(0xff, 0xda);
      offset += 2;
      const remaining = bytes.subarray(offset);
      const eoi = remaining.findIndex((value, index) =>
        value === 0xff && remaining[index + 1] === 0xd9 && remaining[index - 1] !== 0x00);
      if (eoi < 0) throw new Error("X JPEG attachment omitted EOI");
      kept.push(...remaining.subarray(0, eoi), 0xff, 0xd9);
      break;
    }
    if (offset + 4 > bytes.byteLength) throw new Error("X JPEG attachment contained a truncated marker");
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2 || offset + 2 + length > bytes.byteLength) {
      throw new Error("X JPEG attachment contained a truncated marker");
    }
    const drop = marker >= 0xe0 && marker <= 0xef || marker === 0xfe;
    if (!drop) kept.push(...bytes.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  if (kept.length < 4 || kept[kept.length - 2] !== 0xff || kept[kept.length - 1] !== 0xd9) {
    throw new Error("X JPEG attachment omitted EOI");
  }
  return Uint8Array.from(kept);
}

export function imageBytesContainProvenance(bytes: Uint8Array): boolean {
  return IMAGE_PROVENANCE_MARKER.test(Buffer.from(bytes).toString("latin1"));
}

export function rejectImageProvenanceMarkers(bytes: Uint8Array, label: string): void {
  if (imageBytesContainProvenance(bytes)) {
    throw new Error(`${label} still contained provenance after pixel-only re-encoding`);
  }
}

export function scrubXUploadImage(
  bytes: Uint8Array,
  mediaType: "image/png" | "image/jpeg",
): Uint8Array {
  const scrubbed = mediaType === "image/png"
    ? reencodePixelsOnlyPng(bytes)
    : stripJpegProvenance(bytes);
  rejectImageProvenanceMarkers(scrubbed, "X upload image");
  if (mediaType === "image/png") {
    const types = pngChunkTypes(scrubbed);
    if (types.some((type) => type !== "IHDR" && type !== "IDAT" && type !== "IEND")) {
      throw new Error("X upload image retained ancillary PNG chunks");
    }
  }
  return scrubbed;
}

export function rejectGifProvenanceMarkers(bytes: Uint8Array): void {
  if (imageBytesContainProvenance(bytes)) {
    throw new Error("X GIF attachment contained provenance markers");
  }
}

export function minimalPngBytes(): Uint8Array {
  return encodePixelsOnlyPng({
    width: 1,
    height: 1,
    rgba: Uint8Array.of(200, 40, 40, 255),
  });
}
