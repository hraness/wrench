import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

import type { BrowserFileResolver } from "../browser";
import { canonicalJson } from "../canonical-json";
import type { OperationInput } from "../model";
import type { WebSessionOperationDeadline } from "../web-session-execution";
import {
  bindInstagramVideoMediaReadback,
  instagramVideoAcceptedTargetIdentifier,
  INSTAGRAM_VIDEO_CAPTURE_BLOCKERS,
  materializeInstagramVideoPublishInput,
  parseInstagramVideoAcceptedTargetIdentifier,
  prepareInstagramAuthoredPostDeleteInput,
  prepareInstagramVideoPublishInput,
  revalidateInstagramVideoPublishBindingForDispatch,
} from "./meta-web-runtime";

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

function videoFixture(
  majorBrand = "isom",
  options: Readonly<{
    durationUnits?: number;
    includeMediaHeader?: boolean;
    timescale?: number;
  }> = {},
): Buffer {
  const fileType = Buffer.alloc(16);
  fileType.write(majorBrand, 0, 4, "ascii");
  fileType.writeUInt32BE(0x200, 4);
  fileType.write(majorBrand, 8, 4, "ascii");
  fileType.write("avc1", 12, 4, "ascii");
  const track = Buffer.alloc(84);
  for (const [index, value] of IDENTITY_MATRIX.entries()) {
    track.writeUInt32BE(value, 40 + index * 4);
  }
  track.writeUInt32BE(960 * 65_536, 76);
  track.writeUInt32BE(540 * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  const mediaHeader = Buffer.alloc(24);
  mediaHeader.writeUInt32BE(options.timescale ?? 1_000, 12);
  mediaHeader.writeUInt32BE(options.durationUnits ?? 8_000, 16);
  const media = options.includeMediaHeader === false
    ? isoBox("mdia", isoBox("hdlr", handler))
    : isoBox(
        "mdia",
        isoBox("hdlr", handler),
        isoBox("mdhd", mediaHeader),
      );
  return Buffer.concat([
    isoBox("ftyp", fileType),
    isoBox(
      "moov",
      isoBox(
        "trak",
        isoBox("tkhd", track),
        media,
      ),
    ),
    isoBox("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
}

function publishInput(
  overrides: Readonly<Record<string, unknown>> = {},
): OperationInput {
  return {
    audience: "default",
    caption: "Disposable Wrench Instagram video fixture",
    media: { kind: "file", reference: "plan-video-1" },
    thumbnail: { kind: "file", reference: "plan-thumbnail-1" },
    ...overrides,
  } as OperationInput;
}

function normalizedInstagramVideo(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: "900_12345",
    pk: "900",
    code: "VideoABC",
    media_type: 2,
    taken_at: 1_786_923_725,
    caption: "Disposable Wrench Instagram video fixture",
    user: Object.freeze({
      id: "12345",
      username: "viewer",
      full_name: null,
    }),
    has_liked: false,
    has_viewer_saved: false,
    like_count: 0,
    comment_count: 0,
    ...overrides,
  });
}

async function withFixture<T>(
  bytes: Uint8Array,
  run: (path: string, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "wrench-instagram-video-test-"));
  const path = join(directory, "fixture.mp4");
  const thumbnailPath = join(directory, "fixture.jpg");
  await writeFile(path, bytes);
  await writeFile(thumbnailPath, Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x1c, 0x03,
    0xc0, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0xff, 0xd9,
  ]));
  try {
    return await run(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Instagram video capture-neutral foundations", () => {
  test("validates one exact semantic publication plan", () => {
    expect(prepareInstagramVideoPublishInput(publishInput())).toEqual({
      audience: "default",
      caption: "Disposable Wrench Instagram video fixture",
      media: { kind: "file", reference: "plan-video-1" },
      thumbnail: { kind: "file", reference: "plan-thumbnail-1" },
    });
  });

  test("materializes one exact stable plan-bound MP4", async () => {
    const fixture = videoFixture();
    await withFixture(fixture, async (path) => {
      const resolver: BrowserFileResolver = (files) => {
        expect(files).toEqual([
          { kind: "file", reference: "plan-video-1" },
          { kind: "file", reference: "plan-thumbnail-1" },
        ]);
        return Promise.resolve([path, join(dirname(path), "fixture.jpg")]);
      };
      const result = await materializeInstagramVideoPublishInput(
        publishInput(),
        resolver,
      );
      expect({ ...result, bytes: undefined, thumbnailBytes: undefined }).toEqual({
        audience: "default",
        byteLength: fixture.byteLength,
        bytes: undefined,
        caption: "Disposable Wrench Instagram video fixture",
        durationMilliseconds: 8_000,
        height: 540,
        mediaType: "video/mp4",
        mediaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        thumbnailByteLength: 19,
        thumbnailBytes: undefined,
        thumbnailHeight: 540,
        thumbnailMediaType: "image/jpeg",
        thumbnailSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        thumbnailWidth: 960,
        width: 960,
      });
      expect(result.bytes).toEqual(new Uint8Array(fixture));
    });
  });

  test("requires mdhd duration and enforces the exact 1 ms through 24 hour bound", async () => {
    for (const [durationUnits, timescale, expectedMilliseconds] of [
      [1, 1_000, 1],
      [86_400_000, 1_000, 86_400_000],
    ] as const) {
      await withFixture(videoFixture("isom", {
        durationUnits,
        timescale,
      }), async (path) => {
        const binding = await materializeInstagramVideoPublishInput(
          publishInput(),
          () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
        );
        expect(binding.durationMilliseconds).toBe(expectedMilliseconds);
      });
    }

    for (const [fixture, message] of [
      [videoFixture("isom", { includeMediaHeader: false }), "exactly one mdhd box"],
      [videoFixture("isom", { durationUnits: 1, timescale: 2_000 }), "duration is outside the reviewed bound"],
      [videoFixture("isom", { durationUnits: 86_400_001 }), "duration is outside the reviewed bound"],
      [videoFixture("isom", {
        durationUnits: 4_294_944_001,
        timescale: 49_710,
      }), "duration is outside the reviewed bound"],
    ] as const) {
      await withFixture(fixture, async (path) => {
        await expect(materializeInstagramVideoPublishInput(
          publishInput(),
          () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
        )).rejects.toThrow(message);
      });
    }
  });

  test("admits the 128 MiB sparse boundary and rejects the next byte before reading", async () => {
    const maximumBytes = 128 * 1024 * 1024;
    for (const [size, expectedRuns, expectedMessage] of [
      [maximumBytes, 4, "test blocked sparse-file read after admission"],
      [maximumBytes + 1, 3, "reviewed in-memory bound"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), "wrench-instagram-video-cap-test-"));
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
        await expect(materializeInstagramVideoPublishInput(
          publishInput(),
          () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
          deadline,
        )).rejects.toThrow(expectedMessage);
        expect(runs).toBe(expectedRuns);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("revalidates and snapshots the exact bytes immediately before dispatch", async () => {
    const fixture = videoFixture();
    await withFixture(fixture, async (path) => {
      const binding = await materializeInstagramVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
      );
      const dispatchSnapshot = revalidateInstagramVideoPublishBindingForDispatch(binding);
      expect({
        ...dispatchSnapshot,
        body: undefined,
        thumbnailBody: undefined,
      }).toEqual({
        audience: binding.audience,
        body: undefined,
        byteLength: binding.byteLength,
        caption: binding.caption,
        durationMilliseconds: binding.durationMilliseconds,
        height: binding.height,
        mediaSha256: binding.mediaSha256,
        mediaType: binding.mediaType,
        thumbnailBody: undefined,
        thumbnailByteLength: binding.thumbnailByteLength,
        thumbnailHeight: binding.thumbnailHeight,
        thumbnailMediaType: binding.thumbnailMediaType,
        thumbnailSha256: binding.thumbnailSha256,
        thumbnailWidth: binding.thumbnailWidth,
        width: binding.width,
      });
      expect(dispatchSnapshot).not.toHaveProperty("bytes");
      expect(dispatchSnapshot.body).toBeInstanceOf(Blob);
      expect(dispatchSnapshot.body.size).toBe(binding.byteLength);
      expect(dispatchSnapshot.body.type).toBe("video/mp4");
      expect(Object.isFrozen(dispatchSnapshot)).toBe(true);
      const firstBodyRead = new Uint8Array(await dispatchSnapshot.body.arrayBuffer());
      expect(firstBodyRead).toEqual(binding.bytes);
      expect(createHash("sha256").update(firstBodyRead).digest("hex"))
        .toBe(dispatchSnapshot.mediaSha256);

      const lastIndex = binding.bytes.byteLength - 1;
      const original = binding.bytes[lastIndex]!;
      fixture[lastIndex] = original ^ 0x55;
      const bindingAlias = new Uint8Array(
        binding.bytes.buffer,
        binding.bytes.byteOffset,
        binding.bytes.byteLength,
      );
      bindingAlias[lastIndex] = original ^ 0xff;
      firstBodyRead[lastIndex] = original ^ 0xaa;
      expect(Reflect.set(dispatchSnapshot, "mediaSha256", "0".repeat(64))).toBe(false);
      const eventualBodyBytes = new Uint8Array(await dispatchSnapshot.body.arrayBuffer());
      expect(eventualBodyBytes.at(-1)).toBe(original);
      expect(createHash("sha256").update(eventualBodyBytes).digest("hex"))
        .toBe(dispatchSnapshot.mediaSha256);
      expect(() => revalidateInstagramVideoPublishBindingForDispatch(binding))
        .toThrow("changed from its exact bytes");
    });
  });

  test("rejects drifted or ambiguous Instagram dispatch bindings", async () => {
    const fixture = videoFixture();
    await withFixture(fixture, async (path) => {
      const binding = await materializeInstagramVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
      );
      for (const [value, message] of [
        [{ ...binding, byteLength: binding.byteLength + 1 }, "changed from its exact bytes"],
        [{ ...binding, durationMilliseconds: binding.durationMilliseconds + 1 }, "changed from its exact bytes"],
        [{ ...binding, mediaSha256: "0".repeat(64) }, "changed from its exact bytes"],
        [{ ...binding, width: binding.width + 1 }, "changed from its exact bytes"],
        [{ ...binding, audience: "friends" }, "declarations are invalid"],
        [{ ...binding, extra: true }, "unsupported fields"],
        [{ ...binding, [Symbol("extra")]: true }, "unsupported fields"],
        [Object.assign(Object.create({ inherited: true }), binding), "plain prototype"],
      ] as const) {
        expect(() => revalidateInstagramVideoPublishBindingForDispatch(value))
          .toThrow(message);
      }

      let accessorReads = 0;
      const accessorBinding = Object.defineProperty(
        { ...binding },
        "caption",
        {
          enumerable: true,
          get() {
            accessorReads += 1;
            return binding.caption;
          },
        },
      );
      expect(() => revalidateInstagramVideoPublishBindingForDispatch(
        accessorBinding,
      )).toThrow("only enumerable data properties");
      expect(accessorReads).toBe(0);

      let trapCalls = 0;
      const trappedBinding = new Proxy(binding, {
        get() {
          trapCalls += 1;
          throw new Error("proxy trap ran");
        },
        getOwnPropertyDescriptor() {
          trapCalls += 1;
          throw new Error("proxy trap ran");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("proxy trap ran");
        },
        ownKeys() {
          trapCalls += 1;
          throw new Error("proxy trap ran");
        },
      });
      expect(() => revalidateInstagramVideoPublishBindingForDispatch(
        trappedBinding,
      )).toThrow("must not be a proxy");
      expect(trapCalls).toBe(0);

      const proxiedBytes = new Proxy(binding.bytes, {
        get(target, key, receiver) {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf(target) {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
      });
      expect(() => revalidateInstagramVideoPublishBindingForDispatch({
        ...binding,
        bytes: proxiedBytes,
      })).toThrow("one bounded MP4");
      expect(trapCalls).toBe(0);

      let nestedAccessorReads = 0;
      const decoratedBytes = new Uint8Array(binding.bytes);
      Object.defineProperties(decoratedBytes, {
        buffer: {
          configurable: true,
          get() {
            nestedAccessorReads += 1;
            throw new Error("caller-defined buffer getter ran");
          },
        },
        byteLength: {
          configurable: true,
          get() {
            nestedAccessorReads += 1;
            return 24;
          },
        },
      });
      Object.defineProperty(decoratedBytes, Symbol.iterator, {
        configurable: true,
        get() {
          nestedAccessorReads += 1;
          throw new Error("caller-defined iterator getter ran");
        },
      });
      const safeSnapshot = revalidateInstagramVideoPublishBindingForDispatch({
        ...binding,
        bytes: decoratedBytes,
      });
      expect(nestedAccessorReads).toBe(0);
      expect(new Uint8Array(await safeSnapshot.body.arrayBuffer()))
        .toEqual(binding.bytes);
    });
  });

  test("rejects shared Instagram bytes despite prototype and realm spoofing", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    await withFixture(videoFixture(), async (path) => {
      const binding = await materializeInstagramVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
      );

      const disguisedBacking = new SharedArrayBuffer(binding.byteLength);
      const disguisedBytes = new Uint8Array(disguisedBacking);
      disguisedBytes.set(binding.bytes);
      Object.setPrototypeOf(disguisedBacking, ArrayBuffer.prototype);
      expect(disguisedBacking).not.toBeInstanceOf(SharedArrayBuffer);
      expect(() => revalidateInstagramVideoPublishBindingForDispatch({
        ...binding,
        bytes: disguisedBytes,
      })).toThrow("one bounded MP4");

      const crossRealmBytes = runInNewContext(
        `new Uint8Array(new SharedArrayBuffer(${binding.byteLength}))`,
      ) as Uint8Array;
      Uint8Array.prototype.set.call(crossRealmBytes, binding.bytes);
      Object.setPrototypeOf(crossRealmBytes, Uint8Array.prototype);
      expect(crossRealmBytes).toBeInstanceOf(Uint8Array);
      expect(crossRealmBytes.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      expect(() => revalidateInstagramVideoPublishBindingForDispatch({
        ...binding,
        bytes: crossRealmBytes,
      })).toThrow("one bounded MP4");
    });
  });

  test("rejects ambiguous semantic inputs before resolving a file", async () => {
    const base = publishInput();
    const { caption: _caption, ...withoutCaption } = base;
    const cases: readonly [OperationInput, string][] = [
      [{ ...base, extra: true } as OperationInput, "unsupported input field"],
      [withoutCaption, "omitted a required input field"],
      [publishInput({ audience: "friends" }), "exact default Instagram audience"],
      [publishInput({ caption: "bad\rcaption" }), "bounded UTF-16"],
      [publishInput({ caption: "" }), "bounded UTF-16"],
      [publishInput({ media: { kind: "file", reference: "x", extra: true } }), "plan-bound file"],
      [publishInput({ media: { kind: "file", reference: "bad\nreference" } }), "plan-bound file"],
    ];
    for (const [input, message] of cases) {
      let resolutions = 0;
      await expect(materializeInstagramVideoPublishInput(input, () => {
        resolutions += 1;
        return Promise.resolve([]);
      })).rejects.toThrow(message);
      expect(resolutions).toBe(0);
    }
  });

  test("rejects non-MP4 branding, malformed structure, and final symlinks", async () => {
    await withFixture(videoFixture("qt  "), async (path) => {
      await expect(materializeInstagramVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
      )).rejects.toThrow("not MP4-compatible");
    });
    await withFixture(Buffer.alloc(32), async (path) => {
      await expect(materializeInstagramVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
      )).rejects.toThrow("MP4 file-type box");
    });
    await withFixture(videoFixture(), async (path, directory) => {
      const link = join(directory, "fixture-link.mp4");
      await symlink(path, link);
      await expect(materializeInstagramVideoPublishInput(
        publishInput(),
        () => Promise.resolve([link]),
      )).rejects.toThrow();
    });
  });

  test("rejects a file whose stable identity changes during materialization", async () => {
    await withFixture(videoFixture(), async (path) => {
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
      await expect(materializeInstagramVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path, join(dirname(path), "fixture.jpg")]),
        deadline,
      )).rejects.toThrow("changed while it was materialized");
    });
  });

  test("requires an exact authored-video deletion confirmation", () => {
    expect(prepareInstagramAuthoredPostDeleteInput({
      expected_caption: "Disposable Wrench Instagram video fixture",
      expected_media_kind: "video",
      media_id: "900_12345",
    })).toEqual({
      expectedCaption: "Disposable Wrench Instagram video fixture",
      expectedMediaKind: "video",
      mediaId: "900_12345",
    });
    for (const [input, message] of [
      [{
        expected_caption: "Disposable Wrench Instagram video fixture",
        expected_media_kind: "video",
        media_id: "0900_12345",
      }, "full Instagram media ID"],
      [{
        expected_caption: "Disposable Wrench Instagram video fixture",
        expected_media_kind: "image",
        media_id: "900_12345",
      }, "must be video"],
      [{
        expected_caption: "bad\rcaption",
        expected_media_kind: "video",
        media_id: "900_12345",
      }, "bounded UTF-16"],
      [{
        expected_caption: "Disposable Wrench Instagram video fixture",
        expected_media_kind: "video",
        extra: true,
        media_id: "900_12345",
      }, "unsupported input field"],
    ] as const) {
      expect(() => prepareInstagramAuthoredPostDeleteInput(input as OperationInput))
        .toThrow(message);
    }
  });

  test("binds one exact authenticated video readback into a canonical accepted target", () => {
    const target = bindInstagramVideoMediaReadback(
      normalizedInstagramVideo(),
      {
        expectedCaption: "Disposable Wrench Instagram video fixture",
        mediaId: "900_12345",
        viewerId: "12345",
      },
    );
    expect(target).toEqual({
      code: "VideoABC",
      mediaId: "900_12345",
      url: "https://www.instagram.com/p/VideoABC/",
    });
    const identifier = instagramVideoAcceptedTargetIdentifier(target);
    expect(identifier).toBe(canonicalJson(target));
    expect(parseInstagramVideoAcceptedTargetIdentifier(identifier)).toEqual(target);
    expect(INSTAGRAM_VIDEO_CAPTURE_BLOCKERS).toEqual({
      "media.publish": expect.stringContaining("202"),
    });
  });

  test("rejects drifted video readbacks and noncanonical accepted targets", () => {
    const expectation = {
      expectedCaption: "Disposable Wrench Instagram video fixture",
      expectedCode: "VideoABC",
      mediaId: "900_12345",
      viewerId: "12345",
    } as const;
    for (const value of [
      normalizedInstagramVideo({ caption: "changed" }),
      normalizedInstagramVideo({ code: "OtherCode" }),
      normalizedInstagramVideo({ id: "901_12345" }),
      normalizedInstagramVideo({ media_type: 1 }),
      normalizedInstagramVideo({ user: { id: "99999", username: "viewer", full_name: null } }),
      normalizedInstagramVideo({ extra: true }),
    ]) {
      expect(() => bindInstagramVideoMediaReadback(value, expectation)).toThrow();
    }

    const target = {
      code: "VideoABC",
      mediaId: "900_12345",
      url: "https://www.instagram.com/p/VideoABC/",
    } as const;
    expect(() => instagramVideoAcceptedTargetIdentifier({
      ...target,
      url: "https://example.com/p/VideoABC/",
    })).toThrow("invalid permalink");
    expect(() => parseInstagramVideoAcceptedTargetIdentifier(JSON.stringify({
      mediaId: target.mediaId,
      code: target.code,
      url: target.url,
    }))).toThrow("not canonical");
    expect(() => parseInstagramVideoAcceptedTargetIdentifier(canonicalJson({
      ...target,
      extra: true,
    }))).toThrow("normalized shape");
  });
});
