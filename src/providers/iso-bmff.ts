type IsoBox = Readonly<{
  end: number;
  payloadStart: number;
  type: string;
}>;

type IsoBoxBudget = {
  remaining: number;
};

const MAX_REVIEWED_ISO_BOXES = 4_096;
const IDENTITY_TRACK_MATRIX = Object.freeze([
  0x0001_0000,
  0,
  0,
  0,
  0x0001_0000,
  0,
  0,
  0,
  0x4000_0000,
] as const);

function isoBoxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function isoBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  label: string,
  budget: IsoBoxBudget,
): readonly IsoBox[] {
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end > bytes.byteLength
    || start > end
  ) throw new Error(`${label} has invalid ISO BMFF bounds`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset < end) {
    if (budget.remaining === 0) {
      throw new Error(`${label} exceeds the reviewed ISO BMFF box-count bound`);
    }
    budget.remaining -= 1;
    if (end - offset < 8) {
      throw new Error(`${label} contains a truncated ISO BMFF box`);
    }
    const size32 = view.getUint32(offset);
    const type = isoBoxType(bytes, offset + 4);
    if (!/^[\x20-\x7e]{4}$/u.test(type)) {
      throw new Error(`${label} contains an invalid ISO BMFF box type`);
    }
    let headerBytes = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) {
        throw new Error(`${label} contains a truncated extended-size ISO BMFF box`);
      }
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${label} contains an oversized ISO BMFF box`);
      }
      size = Number(extendedSize);
      headerBytes = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerBytes || size > end - offset) {
      throw new Error(`${label} contains an invalid ISO BMFF box size`);
    }
    boxes.push(Object.freeze({
      end: offset + size,
      payloadStart: offset + headerBytes,
      type,
    }));
    offset += size;
  }
  if (offset !== end) throw new Error(`${label} contains trailing ISO BMFF bytes`);
  return Object.freeze(boxes);
}

function oneIsoBox(
  boxes: readonly IsoBox[],
  type: string,
  label: string,
): IsoBox {
  const matches = boxes.filter((box) => box.type === type);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one ${type} box`);
  }
  return matches[0]!;
}

/**
 * Validate one complete ISO BMFF file and return the dimensions from its one
 * reviewed video track. This is deliberately a structural validator, not a
 * codec or transcoder; the provider remains authoritative for media support.
 */
export function isoBmffVideoDimensions(
  bytes: Uint8Array,
  label: string,
): Readonly<{ height: number; width: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const budget: IsoBoxBudget = { remaining: MAX_REVIEWED_ISO_BOXES };
  const topLevel = isoBoxes(bytes, 0, bytes.byteLength, label, budget);
  if (
    topLevel[0]?.type !== "ftyp"
    || topLevel[0].end - topLevel[0].payloadStart < 8
  ) throw new Error(`${label} must begin with one bounded ISO BMFF file-type box`);
  const moov = oneIsoBox(topLevel, "moov", label);
  const movieBoxes = isoBoxes(
    bytes,
    moov.payloadStart,
    moov.end,
    `${label} movie box`,
    budget,
  );
  const dimensions: { height: number; width: number }[] = [];
  for (const track of movieBoxes.filter((box) => box.type === "trak")) {
    const trackBoxes = isoBoxes(
      bytes,
      track.payloadStart,
      track.end,
      `${label} track`,
      budget,
    );
    const media = oneIsoBox(trackBoxes, "mdia", `${label} track`);
    const mediaBoxes = isoBoxes(
      bytes,
      media.payloadStart,
      media.end,
      `${label} media box`,
      budget,
    );
    const handler = oneIsoBox(mediaBoxes, "hdlr", `${label} media box`);
    if (handler.end - handler.payloadStart < 12) {
      throw new Error(`${label} media handler is truncated`);
    }
    if (isoBoxType(bytes, handler.payloadStart + 8) !== "vide") continue;
    const trackHeader = oneIsoBox(trackBoxes, "tkhd", `${label} track`);
    const payloadBytes = trackHeader.end - trackHeader.payloadStart;
    const version = bytes[trackHeader.payloadStart];
    const dimensionOffset = version === 0 ? 76 : version === 1 ? 88 : -1;
    const expectedPayloadBytes = version === 0 ? 84 : version === 1 ? 96 : -1;
    if (dimensionOffset < 0 || payloadBytes !== expectedPayloadBytes) {
      throw new Error(`${label} track header changed from the reviewed shape`);
    }
    const matrixOffset = trackHeader.payloadStart + dimensionOffset - 36;
    for (const [index, expected] of IDENTITY_TRACK_MATRIX.entries()) {
      if (view.getUint32(matrixOffset + index * 4) !== expected) {
        throw new Error(`${label} track header has an unsupported transform matrix`);
      }
    }
    const widthFixed = view.getUint32(trackHeader.payloadStart + dimensionOffset);
    const heightFixed = view.getUint32(trackHeader.payloadStart + dimensionOffset + 4);
    if ((widthFixed & 0xffff) !== 0 || (heightFixed & 0xffff) !== 0) {
      throw new Error(`${label} dimensions must be whole pixels`);
    }
    const width = widthFixed >>> 16;
    const height = heightFixed >>> 16;
    if (width < 1 || height < 1 || width > 20_000 || height > 20_000) {
      throw new Error(`${label} dimensions are outside the reviewed bound`);
    }
    dimensions.push({ height, width });
  }
  if (dimensions.length !== 1) {
    throw new Error(`${label} must contain exactly one reviewed video track`);
  }
  return Object.freeze(dimensions[0]!);
}
