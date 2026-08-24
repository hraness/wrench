import { expect, test } from "bun:test";

import { assertProperty, fc } from "../test-support";
import {
  parseYouTubeVideoTargetIdentifier,
  youtubeVideoTargetIdentifier,
} from "./youtube-web-runtime";

const videoId = fc.array(
  fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
  ),
  { minLength: 11, maxLength: 11 },
).map((characters) => characters.join(""));

function exactTargetVideoId(value: unknown): string | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "schemaVersion,url,videoId"
  ) return null;
  const target = value as Readonly<Record<string, unknown>>;
  if (
    target.schemaVersion !== 1
    || typeof target.videoId !== "string"
    || !/^[A-Za-z0-9_-]{11}$/u.test(target.videoId)
    || target.url !== `https://www.youtube.com/watch?v=${target.videoId}`
  ) return null;
  return target.videoId;
}

test("property: YouTube local video targets round-trip canonically", () => {
  assertProperty(fc.property(videoId, (exactVideoId) => {
    const identifier = youtubeVideoTargetIdentifier(exactVideoId);
    expect(parseYouTubeVideoTargetIdentifier(identifier)).toEqual({
      schemaVersion: 1,
      url: `https://www.youtube.com/watch?v=${exactVideoId}`,
      videoId: exactVideoId,
    });
  }));
});

test("property: YouTube local video targets reject URL and JSON ambiguity", () => {
  assertProperty(fc.property(videoId, (exactVideoId) => {
    const url = `https://www.youtube.com/watch?v=${exactVideoId}`;
    const noncanonicalOrder = JSON.stringify({
      videoId: exactVideoId,
      url,
      schemaVersion: 1,
    });
    const extraField = JSON.stringify({
      extra: false,
      schemaVersion: 1,
      url,
      videoId: exactVideoId,
    });
    const alternateUrl = JSON.stringify({
      schemaVersion: 1,
      url: `https://youtu.be/${exactVideoId}`,
      videoId: exactVideoId,
    });
    for (const identifier of [noncanonicalOrder, extraField, alternateUrl]) {
      expect(() => parseYouTubeVideoTargetIdentifier(identifier)).toThrow();
    }
  }));
});

test("property: arbitrary unknown target inputs fail closed", () => {
  assertProperty(fc.property(fc.anything(), (identifier) => {
    if (typeof identifier !== "string") {
      expect(() => parseYouTubeVideoTargetIdentifier(identifier)).toThrow();
      return;
    }
    try {
      const parsed = parseYouTubeVideoTargetIdentifier(identifier);
      expect(youtubeVideoTargetIdentifier(parsed.videoId)).toBe(identifier);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  }));
});

test("property: arbitrary JSON strings accept only the exact canonical shape", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    const identifier = JSON.stringify(value);
    const expectedVideoId = exactTargetVideoId(value);
    if (
      expectedVideoId === null
      || youtubeVideoTargetIdentifier(expectedVideoId) !== identifier
    ) {
      expect(() => parseYouTubeVideoTargetIdentifier(identifier)).toThrow();
      return;
    }
    expect(parseYouTubeVideoTargetIdentifier(identifier)).toEqual({
      schemaVersion: 1,
      url: `https://www.youtube.com/watch?v=${expectedVideoId}`,
      videoId: expectedVideoId,
    });
  }));
});
