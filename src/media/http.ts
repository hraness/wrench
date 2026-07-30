import { createHash } from "node:crypto";
import type {
  MediaDirectHttpContainer,
  MediaDirectHttpValidator,
} from "./manifest";

export const DIRECT_HTTP_MAX_REDIRECTS = 5 as const;
export const DIRECT_HTTP_PROBE_BYTES = 65_536 as const;
export const DIRECT_HTTP_MAX_BODY_BYTES = 64 * 1024 * 1024 * 1024;

const HTTP_TOKEN_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,127}$/iu;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,127}\/[a-z0-9!#$%&'*+.^_`|~-]{1,127}$/u;
const IMF_FIXDATE_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

export interface DirectHttpMedia {
  readonly container: MediaDirectHttpContainer;
  readonly extension: "mp4" | "mkv" | "webm" | "ogg" | "flac" | "wav" | "mp3" | "ts";
  readonly mediaType: string;
}

/** Returns Wrench media-owned media metadata for a recognized container. */
export function directHttpMediaForContainer(
  container: MediaDirectHttpContainer,
): DirectHttpMedia {
  switch (container) {
    case "iso-bmff":
      return { container, extension: "mp4", mediaType: "video/mp4" };
    case "matroska":
      return { container, extension: "mkv", mediaType: "video/x-matroska" };
    case "webm":
      return { container, extension: "webm", mediaType: "video/webm" };
    case "ogg":
      return { container, extension: "ogg", mediaType: "application/ogg" };
    case "flac":
      return { container, extension: "flac", mediaType: "audio/flac" };
    case "wave":
      return { container, extension: "wav", mediaType: "audio/wav" };
    case "mp3":
      return { container, extension: "mp3", mediaType: "audio/mpeg" };
    case "mpeg-ts":
      return { container, extension: "ts", mediaType: "video/mp2t" };
  }
}

export interface DirectHttpContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number | null;
}

export type DirectHttpBoundaryErrorCode =
  | "invalid-url"
  | "credentials-not-allowed"
  | "unsupported-protocol"
  | "https-downgrade"
  | "too-many-redirects"
  | "invalid-redirect";

export class DirectHttpBoundaryError extends Error {
  readonly code: DirectHttpBoundaryErrorCode;

  constructor(code: DirectHttpBoundaryErrorCode, message: string) {
    super(message);
    this.name = "DirectHttpBoundaryError";
    this.code = code;
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseContentLength(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseContentRange(value: string | null): DirectHttpContentRange | null {
  if (value === null) return null;
  const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(\*|0|[1-9]\d*)$/u.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || end < start
    || (total !== null && (!Number.isSafeInteger(total) || total <= end))
  ) return null;
  return { start, end, total };
}

export function normalizeDeclaredMediaType(value: string | null): string | null {
  if (value === null || value.length > 512 || value.includes(",") || hasHttpControl(value, true)) {
    return null;
  }
  const [rawType = "", ...parameters] = value.split(";");
  const candidate = rawType.trim().toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(candidate)) return null;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    const equals = trimmed.indexOf("=");
    if (equals <= 0) return null;
    const name = trimmed.slice(0, equals).trim();
    const parameterValue = trimmed.slice(equals + 1).trim();
    if (
      !HTTP_TOKEN_PATTERN.test(name)
      || (!HTTP_TOKEN_PATTERN.test(parameterValue) && !validQuotedParameter(parameterValue))
    ) return null;
  }
  return candidate;
}

function validQuotedParameter(value: string): boolean {
  if (value.length < 2 || value[0] !== "\"" || value.at(-1) !== "\"") return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length - 1) return false;
      const escaped = value.charCodeAt(index);
      if (!(escaped === 0x09 || (escaped >= 0x20 && escaped <= 0x7e) || (escaped >= 0x80 && escaped <= 0xff))) {
        return false;
      }
      continue;
    }
    if (!(code === 0x09 || code === 0x20 || code === 0x21 || (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) {
      return false;
    }
  }
  return true;
}

export function conflictsWithDirectMedia(value: string | null): boolean {
  const mediaType = normalizeDeclaredMediaType(value);
  if (mediaType === null) return false;
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.endsWith("+json")
    || mediaType === "application/xml"
    || mediaType.endsWith("+xml")
    || mediaType === "application/xhtml+xml";
}

export function normalizeLastModified(value: string | null): string | null {
  if (value === null || !IMF_FIXDATE_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toUTCString();
  return normalized === value ? normalized : null;
}

export function validatorFromEtag(value: string | null): MediaDirectHttpValidator {
  const parsed = parseEntityTag(value);
  if (parsed === null) {
    return { strength: "absent" };
  }
  return {
    strength: parsed.strength,
    sha256: sha256Hex(parsed.raw),
  };
}

export function strongEtag(value: string | null): string | null {
  const parsed = parseEntityTag(value);
  return parsed?.strength === "strong" ? parsed.raw : null;
}

function parseEntityTag(
  value: string | null,
): Readonly<{ strength: "weak" | "strong"; raw: string }> | null {
  if (value === null || value.length < 2 || value.length > 8_192) return null;
  const weak = value.startsWith("W/");
  const quoted = weak ? value.slice(2) : value;
  if (quoted.length < 2 || quoted[0] !== "\"" || quoted.at(-1) !== "\"") return null;
  for (let index = 1; index < quoted.length - 1; index += 1) {
    const code = quoted.charCodeAt(index);
    if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) {
      return null;
    }
  }
  return { strength: weak ? "weak" : "strong", raw: value };
}

function asciiEquals(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function hasMpegTransportSync(bytes: Uint8Array): boolean {
  for (let offset = 0; offset < 188 && offset + 567 < bytes.byteLength; offset += 1) {
    let valid = true;
    for (let packet = 0; packet < 4; packet += 1) {
      const start = offset + packet * 188;
      const adaptationControl = ((bytes[start + 3] ?? 0) >> 4) & 0x03;
      if (bytes[start] !== 0x47 || ((bytes[start + 1] ?? 0) & 0x80) !== 0 || adaptationControl === 0) {
        valid = false;
        break;
      }
    }
    if (valid) {
      return true;
    }
  }
  return false;
}

function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  retainMarker: boolean,
): Readonly<{ value: number; length: number }> | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let marker = 0x80;
  while (length <= 8 && (first & marker) === 0) {
    length += 1;
    marker >>= 1;
  }
  if (length > 8 || offset + length > bytes.byteLength) return null;
  let value = retainMarker ? first : first & (marker - 1);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
    if (!Number.isSafeInteger(value)) return null;
  }
  return { value, length };
}

function ebmlDocType(bytes: Uint8Array): string | null {
  const headerSize = readEbmlVint(bytes, 4, false);
  if (headerSize === null) return null;
  const start = 4 + headerSize.length;
  const end = start + headerSize.value;
  if (end > bytes.byteLength || end - start > 4_096) return null;
  let cursor = start;
  while (cursor < end) {
    const id = readEbmlVint(bytes, cursor, true);
    if (id === null) return null;
    const size = readEbmlVint(bytes, cursor + id.length, false);
    if (size === null) return null;
    const valueStart = cursor + id.length + size.length;
    const valueEnd = valueStart + size.value;
    if (valueEnd > end) return null;
    if (id.value === 0x4282) {
      if (size.value < 1 || size.value > 32) return null;
      let value = "";
      for (let index = valueStart; index < valueEnd; index += 1) {
        const byte = bytes[index];
        if (byte === undefined || byte > 0x7f) return null;
        value += String.fromCharCode(byte);
      }
      return value;
    }
    cursor = valueEnd;
  }
  return null;
}

function isValidOggHeader(bytes: Uint8Array): boolean {
  if (!asciiEquals(bytes, 0, "OggS") || bytes.byteLength < 27 || bytes[4] !== 0) return false;
  const segmentCount = bytes[26] ?? 0;
  return bytes.byteLength >= 27 + segmentCount;
}

function isValidId3Header(bytes: Uint8Array): boolean {
  if (!asciiEquals(bytes, 0, "ID3") || bytes.byteLength < 10) return false;
  const version = bytes[3] ?? 0;
  const revision = bytes[4] ?? 0xff;
  const flags = bytes[5] ?? 0xff;
  if (version < 2 || version > 4 || revision === 0xff) return false;
  const invalidFlagMask = version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f;
  if ((flags & invalidFlagMask) !== 0) return false;
  return [6, 7, 8, 9].every((index) => ((bytes[index] ?? 0x80) & 0x80) === 0);
}

/** Recognizes only the conservative container set accepted by direct capture. */
export function detectDirectHttpMedia(bytes: Uint8Array): DirectHttpMedia | null {
  if (bytes.byteLength >= 16 && asciiEquals(bytes, 4, "ftyp")) {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const ordinarySize = boxSize === 0 || boxSize >= 16;
    const largeSize = boxSize === 1
      && bytes.byteLength >= 24
      && new DataView(bytes.buffer, bytes.byteOffset + 8, 8).getBigUint64(0, false) >= 24n;
    if (ordinarySize || largeSize) {
      return directHttpMediaForContainer("iso-bmff");
    }
  }
  if (
    bytes.byteLength >= 4
    && bytes[0] === 0x1a
    && bytes[1] === 0x45
    && bytes[2] === 0xdf
    && bytes[3] === 0xa3
  ) {
    const docType = ebmlDocType(bytes);
    if (docType === "webm") {
      return directHttpMediaForContainer("webm");
    }
    if (docType === "matroska") {
      return directHttpMediaForContainer("matroska");
    }
    return null;
  }
  if (isValidOggHeader(bytes)) {
    return directHttpMediaForContainer("ogg");
  }
  if (asciiEquals(bytes, 0, "fLaC")) {
    return directHttpMediaForContainer("flac");
  }
  if (asciiEquals(bytes, 0, "RIFF") && asciiEquals(bytes, 8, "WAVE")) {
    return directHttpMediaForContainer("wave");
  }
  if (isValidId3Header(bytes)) {
    return directHttpMediaForContainer("mp3");
  }
  if (hasMpegTransportSync(bytes)) {
    return directHttpMediaForContainer("mpeg-ts");
  }
  return null;
}

export function parsePublicHttpUrl(value: string): URL {
  if (value.length === 0 || value.length > 8_192 || hasHttpControl(value)) {
    throw new DirectHttpBoundaryError("invalid-url", "direct HTTP URL is malformed");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DirectHttpBoundaryError("invalid-url", "direct HTTP URL is malformed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new DirectHttpBoundaryError(
      "credentials-not-allowed",
      "direct HTTP does not accept URL credentials",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DirectHttpBoundaryError(
      "unsupported-protocol",
      "direct HTTP accepts only HTTP(S)",
    );
  }
  url.hash = "";
  return url;
}

function hasHttpControl(value: string, allowTab = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined
      && ((!allowTab || code !== 0x09) && (code <= 0x1f || (code >= 0x7f && code <= 0x9f)))
    ) return true;
  }
  return false;
}

export function resolveDirectHttpRedirect(current: URL, location: string): URL {
  if (location.length === 0 || location.length > 8_192 || hasHttpControl(location)) {
    throw new DirectHttpBoundaryError("invalid-redirect", "direct HTTP redirect is malformed");
  }
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new DirectHttpBoundaryError("invalid-redirect", "direct HTTP redirect is malformed");
  }
  const safe = parsePublicHttpUrl(next.href);
  if (current.protocol === "https:" && safe.protocol !== "https:") {
    throw new DirectHttpBoundaryError(
      "https-downgrade",
      "direct HTTP refuses an HTTPS downgrade",
    );
  }
  return safe;
}

export function publicOrigin(url: URL): string {
  return `${url.origin}/`;
}
