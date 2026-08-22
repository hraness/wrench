import { expect, test } from "bun:test";

import { assertProperty, fc } from "../test-support";
import {
  parseRedditMediaLeaseResponse,
  parseRedditVideoSubmitResponse,
  parseRedditVideoWebSocketMessage,
} from "./reddit-web";

function boundedParserResult(work: () => unknown): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(Buffer.byteLength((error as Error).message, "utf8"))
      .toBeLessThanOrEqual(256);
  }
}

test("arbitrary JSON cannot escape Reddit media response parsing", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    boundedParserResult(() => parseRedditMediaLeaseResponse(value, {
      mediaType: "video/mp4",
      filename: "wrench-video.mp4",
    }));
    boundedParserResult(() => parseRedditVideoSubmitResponse(value));
    boundedParserResult(() => parseRedditVideoWebSocketMessage(
      value,
      "testingground4bots",
    ));
  }));
});

test("Reddit media leases accept every permutation of one exact field set", () => {
  const names = [
    "x-amz-algorithm",
    "x-amz-security-token",
    "x-amz-storage-class",
    "success_action_status",
    "bucket",
    "acl",
    "key",
    "x-amz-signature",
    "x-amz-date",
    "x-amz-meta-ext",
    "policy",
    "x-amz-credential",
    "Content-Type",
  ] as const;
  assertProperty(fc.property(
    fc.boolean(),
    fc.uniqueArray(fc.integer({ min: 0, max: names.length - 1 }), {
      minLength: names.length,
      maxLength: names.length,
    }),
    (video, order) => {
      const mediaType = video ? "video/mp4" : "image/png";
      const extension = video ? "mp4" : "png";
      const bucket = video ? "reddit-uploaded-video" : "reddit-uploaded-media";
      const host = `${bucket}.s3-accelerate.amazonaws.com`;
      const values: Readonly<Record<string, string>> = {
        "x-amz-algorithm": "AWS4-HMAC-SHA256",
        "x-amz-security-token": "security-token",
        "x-amz-storage-class": "STANDARD",
        success_action_status: "201",
        bucket,
        acl: "private",
        key: `rte_images/fixture.${extension}`,
        "x-amz-signature": "signature",
        "x-amz-date": "20260822T000000Z",
        "x-amz-meta-ext": extension,
        policy: "policy",
        "x-amz-credential": "credential",
        "Content-Type": mediaType,
      };
      const lease = parseRedditMediaLeaseResponse({
        action: `//${host}`,
        fields: order.map((index) => {
          const name = names[index] as string;
          return { name, value: values[name] };
        }),
      }, {
        mediaType,
        filename: video ? "wrench-video.mp4" : "wrench-poster.png",
      });
      expect(lease.fields.map((field) => field.name)).toEqual(
        order.map((index) => names[index] as string),
      );
    },
  ));
});

test("Reddit video websocket parsing rejects every unknown top-level field", () => {
  const valid = {
    payload: {
      redirect: "https://www.reddit.com/r/testingground4bots/comments/abc123/fixture/",
    },
  };
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 64 }),
    fc.jsonValue(),
    (key, value) => {
      fc.pre(!Object.hasOwn(valid, key));
      expect(() => parseRedditVideoWebSocketMessage(
        { ...valid, [key]: value },
        "testingground4bots",
      )).toThrow("reviewed fields");
    },
  ));
});
