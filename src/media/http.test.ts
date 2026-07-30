import { describe, expect, test } from "bun:test";
import {
  conflictsWithDirectMedia,
  detectDirectHttpMedia,
  normalizeDeclaredMediaType,
  normalizeLastModified,
  parseContentLength,
  parseContentRange,
  parsePublicHttpUrl,
  resolveDirectHttpRedirect,
  strongEtag,
  validatorFromEtag,
} from "./http";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("direct HTTP media recognition", () => {
  test("recognizes the fixed container allowlist from bytes", () => {
    const iso = new Uint8Array(16);
    new DataView(iso.buffer).setUint32(0, 16, false);
    iso.set(ascii("ftyp"), 4);
    const webm = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...ascii("webm"));
    const matroska = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x88, ...ascii("matroska"));
    const wave = new Uint8Array(12);
    wave.set(ascii("RIFF"), 0);
    wave.set(ascii("WAVE"), 8);
    const transport = new Uint8Array(568);
    for (const offset of [0, 188, 376, 564]) {
      transport[offset] = 0x47;
      transport[offset + 3] = 0x10;
    }
    const ogg = new Uint8Array(27);
    ogg.set(ascii("OggS"));
    const id3 = new Uint8Array(10);
    id3.set(ascii("ID3"));
    id3[3] = 4;
    expect(detectDirectHttpMedia(iso)?.container).toBe("iso-bmff");
    expect(detectDirectHttpMedia(webm)?.container).toBe("webm");
    expect(detectDirectHttpMedia(matroska)?.container).toBe("matroska");
    expect(detectDirectHttpMedia(ogg)?.container).toBe("ogg");
    expect(detectDirectHttpMedia(ascii("fLaCfixture"))?.container).toBe("flac");
    expect(detectDirectHttpMedia(wave)?.container).toBe("wave");
    expect(detectDirectHttpMedia(id3)?.container).toBe("mp3");
    expect(detectDirectHttpMedia(transport)?.container).toBe("mpeg-ts");
    expect(detectDirectHttpMedia(ascii("<html>not media</html>"))).toBeNull();
    expect(detectDirectHttpMedia(ascii("OggS"))).toBeNull();
    expect(detectDirectHttpMedia(ascii("ID3"))).toBeNull();
  });

  test("normalizes declared types but rejects text conflicts separately", () => {
    expect(normalizeDeclaredMediaType(" Video/MP4 ; charset=binary ")).toBe("video/mp4");
    expect(normalizeDeclaredMediaType("video/mp4; codecs=\"avc1.4d401f\"")).toBe("video/mp4");
    expect(normalizeDeclaredMediaType("not a type")).toBeNull();
    expect(normalizeDeclaredMediaType("video/mp4; charset=binary, text/html")).toBeNull();
    expect(normalizeDeclaredMediaType("video/mp4;")).toBeNull();
    expect(conflictsWithDirectMedia("text/html; charset=utf-8")).toBeTrue();
    expect(conflictsWithDirectMedia("application/problem+json")).toBeTrue();
    expect(conflictsWithDirectMedia("application/octet-stream")).toBeFalse();
  });
});

describe("direct HTTP header parsing", () => {
  test("parses only exact bounded lengths and byte ranges", () => {
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength("42")).toBe(42);
    expect(parseContentLength("042")).toBeNull();
    expect(parseContentLength("-1")).toBeNull();
    expect(parseContentRange("bytes 0-65535/90000")).toEqual({ start: 0, end: 65_535, total: 90_000 });
    expect(parseContentRange("bytes 5-9/*")).toEqual({ start: 5, end: 9, total: null });
    expect(parseContentRange("bytes 5-9/9")).toBeNull();
    expect(parseContentRange("items 0-1/2")).toBeNull();
  });

  test("normalizes only exact IMF-fixdate values and hashes validators", () => {
    expect(normalizeLastModified("Mon, 21 Jul 2025 12:34:56 GMT")).toBe("Mon, 21 Jul 2025 12:34:56 GMT");
    expect(normalizeLastModified("Tue, 21 Jul 2025 12:34:56 GMT")).toBeNull();
    expect(validatorFromEtag(null)).toEqual({ strength: "absent" });
    expect(validatorFromEtag("W/\"weak\"")).toMatchObject({ strength: "weak" });
    expect(validatorFromEtag("\"strong\"")).toMatchObject({ strength: "strong" });
    expect(validatorFromEtag("garbage")).toEqual({ strength: "absent" });
    expect(validatorFromEtag("w/\"wrong-case\"")).toEqual({ strength: "absent" });
    expect(validatorFromEtag("\"bad\u0001tag\"")).toEqual({ strength: "absent" });
    expect(validatorFromEtag("\"\"")).toMatchObject({ strength: "strong" });
    expect(strongEtag("W/\"weak\"")).toBeNull();
    expect(strongEtag("\"strong\"")).toBe("\"strong\"");
  });
});

describe("direct HTTP URL policy", () => {
  test("strips fragments and rejects credentials, schemes, and downgrade redirects", () => {
    expect(parsePublicHttpUrl("https://example.com/file#fragment").href).toBe("https://example.com/file");
    expect(() => parsePublicHttpUrl("https://user:pass@example.com/file")).toThrow("credentials");
    expect(() => parsePublicHttpUrl("file:///tmp/file")).toThrow("HTTP(S)");
    const current = new URL("https://example.com/file");
    expect(resolveDirectHttpRedirect(current, "/next").href).toBe("https://example.com/next");
    expect(() => resolveDirectHttpRedirect(current, "http://example.com/next")).toThrow("downgrade");
    expect(() => resolveDirectHttpRedirect(current, "https://user:pass@example.com/next")).toThrow("credentials");
    expect(() => resolveDirectHttpRedirect(current, "")).toThrow("malformed");
    expect(() => resolveDirectHttpRedirect(current, `/${"a".repeat(8_192)}`)).toThrow("malformed");
    expect(() => resolveDirectHttpRedirect(current, "/next\u0001hidden")).toThrow("malformed");
  });
});
