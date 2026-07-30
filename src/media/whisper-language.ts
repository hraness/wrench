// Frozen to whisper.cpp's 100-language map for the v1 adapter profile. A map
// change is a provenance-affecting adapter change, not an ambient upgrade.
const WHISPER_CPP_LANGUAGE_CODES: ReadonlySet<string> = new Set([
  "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo",
  "br", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es",
  "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw",
  "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja",
  "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo",
  "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
  "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt",
  "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn", "so", "sq",
  "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl",
  "tr", "tt", "uk", "ur", "uz", "vi", "yi", "yo", "yue", "zh",
]);

const WHISPER_CPP_LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["fil", "tl"],
  ["in", "id"],
  ["iw", "he"],
  ["jv", "jw"],
  ["nb", "no"],
]);

const RESERVED_LANGUAGE_TOKENS = new Set(["all", "live_chat"]);

/** Normalizes one supported requested language while preserving regional identity. */
export function normalizeWhisperCppLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC");
  if (normalized === "auto") return "auto";
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(normalized)) return null;
  const canonical = normalized.toLowerCase();
  if (RESERVED_LANGUAGE_TOKENS.has(canonical)) return null;
  const primary = canonical.split("-", 1)[0];
  if (primary === undefined) return null;
  const toolLanguage = WHISPER_CPP_LANGUAGE_ALIASES.get(primary) ?? primary;
  return WHISPER_CPP_LANGUAGE_CODES.has(toolLanguage) ? canonical : null;
}

/**
 * whisper.cpp accepts its own short language identifiers, not regional BCP-47
 * tags. Wrench media keeps the complete requested tag in provenance and cache identity,
 * while the native CLI receives only its normalized primary language subtag.
 */
export function whisperCppLanguageArgument(value: unknown): string | null {
  const normalized = normalizeWhisperCppLanguage(value);
  if (normalized === null || normalized === "auto") return normalized;
  const primary = normalized.split("-", 1)[0];
  return primary === undefined
    ? null
    : WHISPER_CPP_LANGUAGE_ALIASES.get(primary) ?? primary;
}

/** Exact concrete language accepted in current-schema local transcript output. */
export function isConcreteWhisperCppLanguage(value: unknown): value is string {
  if (typeof value !== "string" || value === "auto") return false;
  return normalizeWhisperCppLanguage(value) === value;
}
