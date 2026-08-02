/** Shared, dependency-free bounds for the Wrench omni runtime and SDK. */
export const OMNI_MAX_REQUEST_BYTES = 1024 * 1024;
export const OMNI_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
export const OMNI_MAX_REASON_BYTES = 8 * 1024;
export const OMNI_MAX_SOURCES = 32;
export const OMNI_MAX_VIEW_ENTITIES = 500;
export const OMNI_MAX_CURSOR_CHARACTERS = 8_192;

/**
 * Truncate UTF-8 without splitting a code point and reserve the suffix inside
 * the declared byte bound.
 */
export function boundedOmniText(
  value: string,
  maximumBytes: number,
  suffix = "…",
): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes > maximumBytes) {
    throw new Error("omni text suffix exceeds its byte bound");
  }
  const limit = maximumBytes - suffixBytes;
  let used = 0;
  let prefix = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > limit) break;
    prefix += character;
    used += size;
  }
  return `${prefix}${suffix}`;
}
