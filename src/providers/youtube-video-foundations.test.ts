import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import type { BrowserFileResolver } from "../browser";
import type { OperationInput } from "../model";
import type { WebSessionOperationDeadline } from "../web-session-execution";
import {
  materializeYouTubeVideoPublishInput,
  parseYouTubeVideoTargetIdentifier,
  prepareYouTubeVideoDeleteInput,
  revalidateYouTubeVideoPublishBindingForDispatch,
  youtubeVideoTargetIdentifier,
} from "./youtube-web-runtime";

const IDENTITY_MATRIX = Object.freeze([
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

function isoBox(type: string, ...payloads: readonly Uint8Array[]): Buffer {
  const payloadBytes = payloads.reduce(
    (total, payload) => total + payload.byteLength,
    0,
  );
  const bytes = Buffer.alloc(8 + payloadBytes);
  bytes.writeUInt32BE(bytes.byteLength, 0);
  bytes.write(type, 4, 4, "ascii");
  let offset = 8;
  for (const payload of payloads) {
    Buffer.from(payload).copy(bytes, offset);
    offset += payload.byteLength;
  }
  return bytes;
}

function mp4Fixture(
  options: Readonly<{
    compatibleBrands?: string;
    durationUnits?: bigint;
    durationVersion?: 0 | 1;
    majorBrand?: string;
  }> = {},
): Buffer {
  const majorBrand = options.majorBrand ?? "isom";
  const compatibleBrands = options.compatibleBrands ?? "isomiso2";
  const durationUnits = options.durationUnits ?? 8_000n;
  const durationVersion = options.durationVersion ?? 0;
  const ftyp = Buffer.alloc(16);
  ftyp.write(majorBrand, 0, 4, "ascii");
  ftyp.writeUInt32BE(0x200, 4);
  ftyp.write(compatibleBrands, 8, 8, "ascii");
  const track = Buffer.alloc(84);
  const matrixOffset = 40;
  for (const [index, value] of IDENTITY_MATRIX.entries()) {
    track.writeUInt32BE(value, matrixOffset + index * 4);
  }
  track.writeUInt32BE(640 * 65_536, 76);
  track.writeUInt32BE(360 * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  const mediaHeader = Buffer.alloc(durationVersion === 0 ? 24 : 36);
  mediaHeader[0] = durationVersion;
  const timescaleOffset = durationVersion === 0 ? 12 : 20;
  const durationOffset = durationVersion === 0 ? 16 : 24;
  mediaHeader.writeUInt32BE(1_000, timescaleOffset);
  if (durationVersion === 0) {
    mediaHeader.writeUInt32BE(Number(durationUnits), durationOffset);
  } else {
    mediaHeader.writeBigUInt64BE(durationUnits, durationOffset);
  }
  return Buffer.concat([
    isoBox("ftyp", ftyp),
    isoBox(
      "moov",
      isoBox(
        "trak",
        isoBox("tkhd", track),
        isoBox(
          "mdia",
          isoBox("hdlr", handler),
          isoBox("mdhd", mediaHeader),
        ),
      ),
    ),
    isoBox("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
}

function publishInput(
  overrides: Readonly<Record<string, unknown>> = {},
): OperationInput {
  return {
    age_restricted: false,
    caption: "Exact fixture description",
    category_id: "22",
    contains_synthetic_media: false,
    made_for_kids: false,
    media: { kind: "file", reference: "plan-video-1" },
    notify_subscribers: false,
    title: "Exact private fixture",
    visibility: "private",
    ...overrides,
  } as OperationInput;
}

async function withFixture<T>(
  bytes: Uint8Array,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "wrench-youtube-video-test-"));
  const path = join(directory, "fixture.mp4");
  await writeFile(path, bytes);
  try {
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("YouTube video capture-neutral foundations", () => {
  test("materializes one exact stable plan-bound ISO BMFF MP4", async () => {
    const fixture = mp4Fixture();
    await withFixture(fixture, async (path) => {
      const resolver: BrowserFileResolver = (files) => {
        expect(files).toEqual([{ kind: "file", reference: "plan-video-1" }]);
        return Promise.resolve([path]);
      };
      const result = await materializeYouTubeVideoPublishInput(
        publishInput(),
        resolver,
      );
      expect({ ...result, bytes: undefined }).toEqual({
        ageRestricted: false,
        bytes: undefined,
        byteLength: fixture.byteLength,
        caption: "Exact fixture description",
        categoryId: "22",
        containsSyntheticMedia: false,
        durationSeconds: 8,
        height: 360,
        madeForKids: false,
        mediaType: "video/mp4",
        mediaSha256: createHash("sha256").update(fixture).digest("hex"),
        notifySubscribers: false,
        title: "Exact private fixture",
        visibility: "private",
        width: 640,
      });
      expect(result.bytes).toEqual(new Uint8Array(fixture));
    });
  });

  test("admits the 128 MiB sparse boundary and rejects the next byte before reading", async () => {
    const maximumBytes = 128 * 1024 * 1024;
    for (const [size, expectedRuns, expectedMessage] of [
      [maximumBytes, 4, "test blocked sparse-file read after admission"],
      [maximumBytes + 1, 3, "128 MiB in-memory publish limit"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), "wrench-youtube-video-cap-test-"));
      const path = join(directory, "sparse.mp4");
      await writeFile(path, "");
      await truncate(path, size);
      const controller = new AbortController();
      let runs = 0;
      const deadline: WebSessionOperationDeadline = {
        signal: controller.signal,
        remainingTimeMs: () => 60_000,
        run: async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
          runs += 1;
          if (runs === 4) {
            throw new Error("test blocked sparse-file read after admission");
          }
          return work(controller.signal);
        },
        throwIfUnavailable: () => {},
      };
      try {
        await expect(materializeYouTubeVideoPublishInput(
          publishInput(),
          () => Promise.resolve([path]),
          deadline,
        )).rejects.toThrow(expectedMessage);
        expect(runs).toBe(expectedRuns);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("rejects ambiguous declarations before resolving any file", async () => {
    const base = publishInput();
    const { title: _title, ...withoutTitle } = base;
    const cases: readonly [OperationInput, string][] = [
      [{ ...base, unsupported: true } as OperationInput, "unsupported input field"],
      [withoutTitle, "omitted a required input field"],
      [publishInput({ media: { kind: "file", reference: "x", extra: true } }), "plan-bound file"],
      [publishInput({ title: "two\nlines" }), "one exact YouTube title"],
      [publishInput({ caption: "bad\rdescription" }), "bounded string"],
      [publishInput({ visibility: "friends" }), "private, unlisted, or public"],
      [publishInput({ category_id: "0" }), "positive YouTube category ID"],
      [publishInput({ made_for_kids: "false" }), "must be boolean"],
      [publishInput({ made_for_kids: true, age_restricted: true }), "cannot be both"],
    ];
    for (const [input, message] of cases) {
      let resolutions = 0;
      await expect(materializeYouTubeVideoPublishInput(input, () => {
        resolutions += 1;
        return Promise.resolve([]);
      })).rejects.toThrow(message);
      expect(resolutions).toBe(0);
    }
  });

  test("rejects non-MP4 claims, missing duration, and unstable file identity", async () => {
    await withFixture(Buffer.alloc(32), async (path) => {
      await expect(materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      )).rejects.toThrow("MP4");
    });
    await withFixture(mp4Fixture({ majorBrand: "qt  " }), async (path) => {
      await expect(materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      )).rejects.toThrow("not MP4-compatible");
    });
    await withFixture(mp4Fixture({
      compatibleBrands: "yyyyyyyy",
      majorBrand: "zzzz",
    }), async (path) => {
      await expect(materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      )).rejects.toThrow("not MP4-compatible");
    });
    await withFixture(mp4Fixture({ durationUnits: 0n }), async (path) => {
      await expect(materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      )).rejects.toThrow("duration is outside the reviewed bound");
    });
    for (const [durationVersion, durationUnits] of [
      [0, 0xffff_ffffn],
      [1, 0xffff_ffff_ffff_ffffn],
    ] as const) {
      await withFixture(mp4Fixture({ durationUnits, durationVersion }), async (path) => {
        await expect(materializeYouTubeVideoPublishInput(
          publishInput(),
          () => Promise.resolve([path]),
        )).rejects.toThrow("unknown-duration sentinel");
      });
    }
    const missingDuration = mp4Fixture();
    missingDuration.write(
      "free",
      missingDuration.indexOf(Buffer.from("mdhd", "ascii")),
      4,
      "ascii",
    );
    await withFixture(missingDuration, async (path) => {
      await expect(materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      )).rejects.toThrow("must contain exactly one mdhd box");
    });
    await withFixture(mp4Fixture(), async (path) => {
      const controller = new AbortController();
      let runs = 0;
      const deadline: WebSessionOperationDeadline = {
        signal: controller.signal,
        remainingTimeMs: () => 60_000,
        run: async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
          runs += 1;
          const result = await work(controller.signal);
          if (runs === 4) await appendFile(path, Buffer.from([0]));
          return result;
        },
        throwIfUnavailable: () => {},
      };
      await expect(materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
        deadline,
      )).rejects.toThrow("changed while it was materialized");
    });
  });

  test("revalidates one immutable body for a future dispatch boundary", async () => {
    const fixture = mp4Fixture();
    await withFixture(fixture, async (path) => {
      const binding = await materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      );
      const revalidated = revalidateYouTubeVideoPublishBindingForDispatch(binding);
      expect({ ...revalidated, body: undefined }).toEqual({
        ageRestricted: binding.ageRestricted,
        body: undefined,
        byteLength: binding.byteLength,
        caption: binding.caption,
        categoryId: binding.categoryId,
        containsSyntheticMedia: binding.containsSyntheticMedia,
        durationSeconds: binding.durationSeconds,
        height: binding.height,
        madeForKids: binding.madeForKids,
        mediaSha256: binding.mediaSha256,
        mediaType: binding.mediaType,
        notifySubscribers: binding.notifySubscribers,
        title: binding.title,
        visibility: binding.visibility,
        width: binding.width,
      });
      expect(revalidated).not.toHaveProperty("bytes");
      expect(revalidated.body).toBeInstanceOf(Blob);
      expect(revalidated.body.size).toBe(binding.byteLength);
      expect(revalidated.body.type).toBe("video/mp4");
      expect(Object.isFrozen(revalidated)).toBe(true);
      const firstBodyRead = new Uint8Array(await revalidated.body.arrayBuffer());
      expect(firstBodyRead).toEqual(binding.bytes);
      expect(createHash("sha256").update(firstBodyRead).digest("hex"))
        .toBe(revalidated.mediaSha256);
      for (const forged of [
        { ...binding, byteLength: binding.byteLength + 1 },
        { ...binding, durationSeconds: binding.durationSeconds + 1 },
        { ...binding, height: binding.height + 1 },
        { ...binding, mediaSha256: "0".repeat(64) },
        { ...binding, width: binding.width + 1 },
        { ...binding, extra: true },
      ]) {
        expect(() => revalidateYouTubeVideoPublishBindingForDispatch(forged))
          .toThrow();
      }
      const finalByte = binding.bytes.byteLength - 1;
      const snapshottedByte = binding.bytes[finalByte]!;
      fixture[finalByte] = (snapshottedByte ^ 0x55) & 0xff;
      const bindingAlias = new Uint8Array(
        binding.bytes.buffer,
        binding.bytes.byteOffset,
        binding.bytes.byteLength,
      );
      bindingAlias[finalByte] = (snapshottedByte ^ 0xff) & 0xff;
      firstBodyRead[finalByte] = (snapshottedByte ^ 0xaa) & 0xff;
      expect(Reflect.set(revalidated, "mediaSha256", "0".repeat(64))).toBe(false);
      const eventualBodyBytes = new Uint8Array(await revalidated.body.arrayBuffer());
      expect(eventualBodyBytes[finalByte]).toBe(snapshottedByte);
      expect(createHash("sha256").update(eventualBodyBytes).digest("hex"))
        .toBe(revalidated.mediaSha256);
      expect(() => revalidateYouTubeVideoPublishBindingForDispatch(binding))
        .toThrow("changed from its exact bytes");
    });
  });

  test("rejects volatile accessors and proxies before an invalid snapshot can escape", async () => {
    await withFixture(mp4Fixture(), async (path) => {
      const binding = await materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      );

      let accessorCalls = 0;
      const volatileVisibility = { ...binding } as Record<string, unknown>;
      Object.defineProperty(volatileVisibility, "visibility", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return accessorCalls === 1 ? "private" : 42;
        },
      });
      expect(() => revalidateYouTubeVideoPublishBindingForDispatch(
        volatileVisibility,
      )).toThrow("only enumerable data properties");
      expect(accessorCalls).toBe(0);

      let proxyTrapCalls = 0;
      const trapHandler: ProxyHandler<Record<string, unknown>> = {
        get(target, key, receiver) {
          proxyTrapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          proxyTrapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) {
          proxyTrapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          proxyTrapCalls += 1;
          return Reflect.ownKeys(target);
        },
      };
      const proxiedBinding = new Proxy(
        { ...binding } as Record<string, unknown>,
        trapHandler,
      );
      expect(() => revalidateYouTubeVideoPublishBindingForDispatch(
        proxiedBinding,
      )).toThrow("must not be a proxy");
      expect(proxyTrapCalls).toBe(0);

      const proxiedBytes = new Proxy(binding.bytes, {
        get(target, key, receiver) {
          proxyTrapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf(target) {
          proxyTrapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
      });
      expect(() => revalidateYouTubeVideoPublishBindingForDispatch({
        ...binding,
        bytes: proxiedBytes,
      })).toThrow("one bounded MP4");
      expect(proxyTrapCalls).toBe(0);

      let byteAccessorCalls = 0;
      const decoratedBytes = new Uint8Array(binding.bytes);
      Object.defineProperties(decoratedBytes, {
        buffer: {
          get() {
            byteAccessorCalls += 1;
            throw new Error("must not read a caller-defined buffer accessor");
          },
        },
        byteLength: {
          get() {
            byteAccessorCalls += 1;
            return 24;
          },
        },
      });
      const safeSnapshot = revalidateYouTubeVideoPublishBindingForDispatch({
        ...binding,
        bytes: decoratedBytes,
      });
      expect(byteAccessorCalls).toBe(0);
      expect(new Uint8Array(await safeSnapshot.body.arrayBuffer()))
        .toEqual(binding.bytes);
    });
  });

  test("rejects shared video bytes despite prototype and realm spoofing", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    await withFixture(mp4Fixture(), async (path) => {
      const binding = await materializeYouTubeVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      );

      const disguisedBacking = new SharedArrayBuffer(binding.byteLength);
      const disguisedBytes = new Uint8Array(disguisedBacking);
      disguisedBytes.set(binding.bytes);
      Object.setPrototypeOf(disguisedBacking, ArrayBuffer.prototype);
      expect(disguisedBacking).not.toBeInstanceOf(SharedArrayBuffer);
      expect(() => revalidateYouTubeVideoPublishBindingForDispatch({
        ...binding,
        bytes: disguisedBytes,
      })).toThrow("one bounded MP4");

      const crossRealmBytes = runInNewContext(
        `new Uint8Array(new SharedArrayBuffer(${binding.byteLength}))`,
      ) as Uint8Array;
      Uint8Array.prototype.set.call(crossRealmBytes, binding.bytes);
      Object.setPrototypeOf(crossRealmBytes, Uint8Array.prototype);
      expect(crossRealmBytes).toBeInstanceOf(Uint8Array);
      expect(Object.getPrototypeOf(crossRealmBytes)).toBe(Uint8Array.prototype);
      expect(crossRealmBytes.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      expect(() => revalidateYouTubeVideoPublishBindingForDispatch({
        ...binding,
        bytes: crossRealmBytes,
      })).toThrow("one bounded MP4");
    });
  });

  test("requires exact authored-video delete confirmation inputs", () => {
    expect(prepareYouTubeVideoDeleteInput({
      expected_title: "Exact private fixture",
      video_id: "dQw4w9WgXcQ",
    })).toEqual({
      expectedTitle: "Exact private fixture",
      videoId: "dQw4w9WgXcQ",
    });
    expect(() => prepareYouTubeVideoDeleteInput({
      expected_title: "Exact private fixture",
      video_id: "short",
    })).toThrow("exact YouTube video ID");
    expect(() => prepareYouTubeVideoDeleteInput({
      expected_title: "two\nlines",
      video_id: "dQw4w9WgXcQ",
    })).toThrow("one exact YouTube title");
    expect(() => prepareYouTubeVideoDeleteInput({
      expected_title: "Exact private fixture",
      extra: true,
      video_id: "dQw4w9WgXcQ",
    })).toThrow("unsupported input field");
  });

  test("round-trips only one canonical local video target", () => {
    const identifier = youtubeVideoTargetIdentifier("dQw4w9WgXcQ");
    expect(identifier).toBe(
      '{"schemaVersion":1,"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","videoId":"dQw4w9WgXcQ"}',
    );
    expect(parseYouTubeVideoTargetIdentifier(identifier)).toEqual({
      schemaVersion: 1,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      videoId: "dQw4w9WgXcQ",
    });
    expect(() => youtubeVideoTargetIdentifier("short"))
      .toThrow("exact YouTube video ID");
    for (const value of [
      "not-json",
      JSON.stringify({
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        schemaVersion: 1,
      }),
      '{"schemaVersion":2,"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","videoId":"dQw4w9WgXcQ"}',
      '{"schemaVersion":1,"url":"https://youtu.be/dQw4w9WgXcQ","videoId":"dQw4w9WgXcQ"}',
      '{"extra":true,"schemaVersion":1,"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","videoId":"dQw4w9WgXcQ"}',
    ]) {
      expect(() => parseYouTubeVideoTargetIdentifier(value)).toThrow();
    }
  });
});
