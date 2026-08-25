type IsoBox = Readonly<{
  end: number;
  payloadStart: number;
  type: string;
}>;

type IsoBoxBudget = {
  remaining: number;
};

const MAX_REVIEWED_ISO_BOXES = 4_096;
const ISO_BMFF_UNKNOWN_DURATION_V0 = 0xffff_ffffn;
const ISO_BMFF_UNKNOWN_DURATION_V1 = 0xffff_ffff_ffff_ffffn;
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

export type IsoBmffMp4CompatibilityPolicy = Readonly<{
  compatibleBrands: readonly string[];
  rejectedMajorBrands: readonly string[];
}>;

function isoBmffBrandSet(
  brands: readonly string[],
  label: string,
  allowEmpty: boolean,
): ReadonlySet<string> {
  if (
    !Array.isArray(brands)
    || (!allowEmpty && brands.length < 1)
    || brands.some((brand) => (
      typeof brand !== "string"
      || !/^[\x20-\x7e]{4}$/u.test(brand)
    ))
    || new Set(brands).size !== brands.length
  ) throw new Error(`${label} MP4 compatibility policy is invalid`);
  return new Set(brands);
}

/**
 * Validate the provider's explicit MP4 brand policy and project the duration
 * and dimensions from one reviewed video track. This remains structural media
 * validation: each provider owns the brands it is prepared to submit.
 */
export function isoBmffMp4VideoMetadata(
  bytes: Uint8Array,
  label: string,
  policy: IsoBmffMp4CompatibilityPolicy,
): Readonly<{
  durationSeconds: number;
  height: number;
  width: number;
}> {
  if (
    !(bytes instanceof Uint8Array)
    || (
      typeof SharedArrayBuffer !== "undefined"
      && bytes.buffer instanceof SharedArrayBuffer
    )
    || bytes.byteLength < 24
  ) throw new Error(`${label} must be one complete MP4 file`);
  const compatibleBrands = isoBmffBrandSet(
    policy.compatibleBrands,
    label,
    false,
  );
  const rejectedMajorBrands = isoBmffBrandSet(
    policy.rejectedMajorBrands,
    label,
    true,
  );
  if ([...compatibleBrands].some((brand) => rejectedMajorBrands.has(brand))) {
    throw new Error(`${label} MP4 compatibility policy is contradictory`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileTypeBytes = view.getUint32(0);
  if (
    fileTypeBytes < 16
    || fileTypeBytes > bytes.byteLength
    || isoBoxType(bytes, 4) !== "ftyp"
    || (fileTypeBytes - 16) % 4 !== 0
  ) throw new Error(`${label} must begin with one bounded MP4 file-type box`);
  const budget: IsoBoxBudget = { remaining: MAX_REVIEWED_ISO_BOXES };
  const topLevel = isoBoxes(bytes, 0, bytes.byteLength, label, budget);
  const fileTypes = topLevel.filter((box) => box.type === "ftyp");
  const fileType = fileTypes[0];
  if (
    topLevel[0] !== fileType
    || fileTypes.length !== 1
    || fileType === undefined
    || fileType.end !== fileTypeBytes
  ) throw new Error(`${label} must begin with one bounded MP4 file-type box`);
  const majorBrand = isoBoxType(bytes, fileType.payloadStart);
  const declaredBrands = [majorBrand];
  for (
    let offset = fileType.payloadStart + 8;
    offset < fileType.end;
    offset += 4
  ) declaredBrands.push(isoBoxType(bytes, offset));
  if (
    rejectedMajorBrands.has(majorBrand)
    || !declaredBrands.some((brand) => compatibleBrands.has(brand))
  ) throw new Error(`${label} file-type box is not MP4-compatible`);

  const dimensions = isoBmffVideoDimensions(bytes, label);
  const movie = oneIsoBox(topLevel, "moov", label);
  const movieBoxes = isoBoxes(
    bytes,
    movie.payloadStart,
    movie.end,
    `${label} movie box`,
    budget,
  );
  const durations: number[] = [];
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
    const mediaHeader = oneIsoBox(mediaBoxes, "mdhd", `${label} media box`);
    const payloadBytes = mediaHeader.end - mediaHeader.payloadStart;
    const version = bytes[mediaHeader.payloadStart];
    const timescaleOffset = version === 0 ? 12 : version === 1 ? 20 : -1;
    const durationOffset = version === 0 ? 16 : version === 1 ? 24 : -1;
    const expectedPayloadBytes = version === 0 ? 24 : version === 1 ? 36 : -1;
    if (
      timescaleOffset < 0
      || durationOffset < 0
      || payloadBytes !== expectedPayloadBytes
    ) throw new Error(`${label} media header changed from the reviewed shape`);
    const timescale = view.getUint32(mediaHeader.payloadStart + timescaleOffset);
    if (timescale < 1) throw new Error(`${label} media timescale must be positive`);
    const durationUnits = version === 0
      ? BigInt(view.getUint32(mediaHeader.payloadStart + durationOffset))
      : view.getBigUint64(mediaHeader.payloadStart + durationOffset);
    const unknownDuration = version === 0
      ? ISO_BMFF_UNKNOWN_DURATION_V0
      : ISO_BMFF_UNKNOWN_DURATION_V1;
    if (durationUnits === unknownDuration) {
      throw new Error(`${label} media duration is the ISO BMFF unknown-duration sentinel`);
    }
    if (durationUnits < 1n || durationUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} media duration is outside the reviewed bound`);
    }
    const durationSeconds = Number(durationUnits) / timescale;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`${label} media duration is invalid`);
    }
    durations.push(durationSeconds);
  }
  if (durations.length !== 1) {
    throw new Error(`${label} must contain exactly one reviewed video duration`);
  }
  return Object.freeze({ durationSeconds: durations[0]!, ...dimensions });
}
