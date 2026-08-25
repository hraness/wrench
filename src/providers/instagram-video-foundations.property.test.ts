import { expect, test } from "bun:test";

import { canonicalJson } from "../canonical-json";
import type { OperationInput } from "../model";
import { assertProperty, fc } from "../test-support";
import {
  instagramVideoAcceptedTargetIdentifier,
  parseInstagramVideoAcceptedTargetIdentifier,
  prepareInstagramAuthoredPostDeleteInput,
  prepareInstagramVideoPublishInput,
} from "./instagram-video-foundations";

const digit = fc.constantFrom(..."0123456789");
const nonzeroDigit = fc.constantFrom(..."123456789");
const canonicalDecimal = fc.tuple(
  nonzeroDigit,
  fc.array(digit, { minLength: 0, maxLength: 31 }),
).map(([first, rest]) => `${first}${rest.join("")}`);
const mediaId = fc.oneof(
  canonicalDecimal,
  fc.tuple(canonicalDecimal, canonicalDecimal)
    .map(([postId, viewerId]) => `${postId}_${viewerId}`),
);
const shortcode = fc.array(
  fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
  ),
  { minLength: 1, maxLength: 64 },
).map((characters) => characters.join(""));

function publishInput(): OperationInput {
  return {
    audience: "default",
    caption: "Disposable Wrench Instagram video fixture",
    media: { kind: "file", reference: "plan-video-1" },
  };
}

function deletionInput(): OperationInput {
  return {
    expected_caption: "Disposable Wrench Instagram video fixture",
    expected_media_kind: "video",
    media_id: "900_12345",
  };
}

test("property: Instagram response-bound video targets round-trip canonically", () => {
  assertProperty(fc.property(mediaId, shortcode, (boundMediaId, code) => {
    const target = {
      code,
      mediaId: boundMediaId,
      url: `https://www.instagram.com/p/${code}/`,
    } as const;
    const identifier = instagramVideoAcceptedTargetIdentifier(target);
    expect(identifier).toBe(canonicalJson(target));
    expect(parseInstagramVideoAcceptedTargetIdentifier(identifier)).toEqual(target);
    expect(instagramVideoAcceptedTargetIdentifier(
      parseInstagramVideoAcceptedTargetIdentifier(identifier),
    )).toBe(identifier);
  }));
});

test("property: arbitrary JSON cannot escape Instagram target parsing", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    const identifier = JSON.stringify(value);
    try {
      const parsed = parseInstagramVideoAcceptedTargetIdentifier(identifier);
      expect(instagramVideoAcceptedTargetIdentifier(parsed)).toBe(identifier);
      expect(parsed.url).toBe(`https://www.instagram.com/p/${parsed.code}/`);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(Buffer.byteLength((error as Error).message, "utf8"))
        .toBeLessThanOrEqual(256);
    }
  }));
});

test("property: Instagram target parsing rejects every unknown top-level field", () => {
  const target = {
    code: "VideoABC",
    mediaId: "900_12345",
    url: "https://www.instagram.com/p/VideoABC/",
  } as const;
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 64 }),
    fc.jsonValue(),
    (key, value) => {
      fc.pre(!Object.hasOwn(target, key));
      expect(() => parseInstagramVideoAcceptedTargetIdentifier(canonicalJson({
        ...target,
        [key]: value,
      }))).toThrow("bounded normalized shape");
    },
  ));
});

test("property: Instagram video mutation inputs reject every unknown field", () => {
  const publication = publishInput();
  const deletion = deletionInput();
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 64 }),
    fc.jsonValue(),
    (key, value) => {
      if (!Object.hasOwn(publication, key)) {
        expect(() => prepareInstagramVideoPublishInput({
          ...publication,
          [key]: value,
        } as OperationInput)).toThrow("unsupported input field");
      }
      if (!Object.hasOwn(deletion, key)) {
        expect(() => prepareInstagramAuthoredPostDeleteInput({
          ...deletion,
          [key]: value,
        } as OperationInput)).toThrow("unsupported input field");
      }
    },
  ));
});
