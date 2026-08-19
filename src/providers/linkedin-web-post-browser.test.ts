import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { BrowserSession } from "../browser";
import {
  createLinkedInPostBrowserTransport,
  LinkedInPostImagePreparationError,
} from "./linkedin-web-post-browser";

const auth = {
  schemaVersion: 1,
  id: "linkedin-post-browser-test",
  kind: "browser-profile",
  profile: "Disposable LinkedIn",
  browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  trustUnfilteredEgress: true,
  subject: "urn:li:fsd_profile:123456789",
} as const satisfies WrenchAuth;

const FIRST_PAGE_INSTANCE =
  "urn:li:page:d_flagship3_feed_first;fixture==";
const NEWEST_PAGE_INSTANCE =
  "urn:li:page:d_flagship3_feed_newest;fixture==";
const firstTrack = JSON.stringify({ mpName: "voyager-web", request: "first" });
const newestTrack = JSON.stringify({ mpName: "voyager-web", request: "newest" });

function browserRecord(
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: { origin: "https://www.linkedin.com/feed/", result },
  };
}

function sourceInput(source: string): Readonly<Record<string, unknown>> {
  const match = /const input=(\{.*?\});if\(location\.origin/u.exec(source);
  if (match?.[1] === undefined) throw new Error("missing LinkedIn evaluation input");
  return JSON.parse(match[1]) as Readonly<Record<string, unknown>>;
}

function pageBindingRecord(): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: {
      requests: [
        {
          method: "GET",
          status: 200,
          url: "https://www.linkedin.com/voyager/api/graphql?fixture=first",
          headers: {
            "x-li-page-instance": FIRST_PAGE_INSTANCE,
            "x-li-track": firstTrack,
          },
        },
        {
          method: "GET",
          status: 200,
          url: "https://www.linkedin.com/voyager/api/graphql?fixture=newest",
          headers: {
            "x-li-page-instance": NEWEST_PAGE_INSTANCE,
            "x-li-track": newestTrack,
          },
        },
      ],
    },
  };
}

describe("LinkedIn native post contained-browser transport", () => {
  test("stages a real-size image in bounded ordered batches, cleans it up, and runs one upload and create", async () => {
    const image = new Uint8Array(1_255_642);
    for (let index = 0; index < image.length; index += 1) image[index] = index % 251;
    const expectedBase64 = Buffer.from(image).toString("base64");
    const stagedChunks: string[] = [];
    const stagingBatchSizes: number[] = [];
    const stagingSourceLengths: number[] = [];
    const cleanupKeys: string[] = [];
    let initializedKey = "";
    let uploadInput: Readonly<Record<string, unknown>> | null = null;
    let uploads = 0;
    let uploadSource = "";
    let creates = 0;
    let readbacks = 0;
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          expect(commands).toEqual([
            ["open", "https://www.linkedin.com/feed/"],
            ["wait", "5000"],
          ]);
          return Promise.resolve([{ success: true, result: { opened: true } }]);
        }
        if (command?.[0] === "network") return Promise.resolve([pageBindingRecord()]);
        if (commands.some((candidate) => candidate[0] !== "eval" || candidate[1] === undefined)) {
          throw new Error("unexpected LinkedIn post browser command");
        }
        const sources = commands.map((candidate) => candidate[1]!);
        if (sources[0]?.includes("return{ready:true}")) {
          expect(sources).toHaveLength(1);
          initializedKey = String(sourceInput(sources[0]).stagingKey);
          return Promise.resolve([browserRecord({ ready: true })]);
        }
        if (sources[0]?.includes("return{staged:chunks.length}")) {
          stagingBatchSizes.push(sources.length);
          return Promise.resolve(sources.map((source) => {
            const input = sourceInput(source);
            expect(input.stagingKey).toBe(initializedKey);
            expect(input.index).toBe(stagedChunks.length);
            expect(input.expectedChunkCount).toBe(35);
            stagingSourceLengths.push(source.length);
            stagedChunks.push(String(input.chunk));
            return browserRecord({ staged: stagedChunks.length });
          }));
        }
        if (sources[0]?.includes("const registrationBody=")) {
          expect(sources).toHaveLength(1);
          uploads += 1;
          uploadSource = sources[0];
          uploadInput = sourceInput(sources[0]);
          return Promise.resolve([browserRecord({
            mediaUrn: "urn:li:digitalmediaAsset:C4D22AQExactImage",
          })]);
        }
        if (sources[0]?.includes("return{removed}")) {
          expect(sources).toHaveLength(1);
          cleanupKeys.push(String(sourceInput(sources[0]).stagingKey));
          return Promise.resolve([browserRecord({ removed: false })]);
        }
        if (sources[0]?.includes("const createPath=")) {
          expect(sources).toHaveLength(1);
          creates += 1;
          return Promise.resolve([browserRecord({
            entityUrn: "urn:li:fsd_share:7000000000000000000",
          })]);
        }
        if (sources[0]?.includes("const readbackPath=")) {
          expect(sources).toHaveLength(1);
          readbacks += 1;
          return Promise.resolve([browserRecord({ read: true })]);
        }
        throw new Error("unexpected LinkedIn evaluation source");
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    };

    const transport = await createLinkedInPostBrowserTransport(auth, {
      timeoutMs: 10_000,
      dependencies: {
        createBrowserSession: () => Promise.resolve(session),
      },
    });
    const mediaUrn = await transport.uploadImage(auth.subject, image);
    expect(mediaUrn).toBe("urn:li:digitalmediaAsset:C4D22AQExactImage");
    const entityUrn = await transport.createPost(
      auth.subject,
      "urn:li:fsd_profile:ACoAAExactCurrentProfile",
      { post: { commentary: { text: "how your email finds me" } } },
      mediaUrn,
    );
    expect(entityUrn).toBe("urn:li:fsd_share:7000000000000000000");
    expect(await transport.readPost(
      auth.subject,
      "urn:li:fsd_profile:ACoAAExactCurrentProfile",
      { post: { commentary: { text: "how your email finds me" } } },
      mediaUrn,
      entityUrn,
    )).toEqual({ read: true });
    await transport.close();

    expect(stagingBatchSizes).toEqual([32, 3]);
    expect(stagingSourceLengths).toHaveLength(35);
    expect(stagingSourceLengths.every((length) => length <= 64 * 1024)).toBeTrue();
    expect(stagedChunks.join("")).toBe(expectedBase64);
    expect(uploadInput).toMatchObject({
      expectedBase64Length: expectedBase64.length,
      expectedByteLength: image.byteLength,
      expectedChunkCount: 35,
      pageInstance: NEWEST_PAGE_INSTANCE,
      stagingKey: initializedKey,
      track: newestTrack,
    });
    expect(uploadInput).not.toHaveProperty("imageBase64");
    expect(cleanupKeys).toEqual([initializedKey]);
    expect(uploads).toBe(1);
    expect(uploadSource).toContain('registration.type==="VECTOR"');
    expect(uploadSource).toContain('registration.$type!=="com.linkedin.mediauploader.MediaUploadMetadata"');
    expect(uploadSource).toContain('registration.singleUploadHeaders["media-type-family"]!=="STILLIMAGE"');
    expect(creates).toBe(1);
    expect(readbacks).toBe(1);
    expect(closed).toBeTrue();
    expect(cleaned).toBeTrue();
  });

  test("attempts exact staged-byte cleanup when a bounded chunk batch fails", async () => {
    const image = new Uint8Array(1_255_642);
    let stagingBatches = 0;
    let stagingKey = "";
    let cleanupKey = "";
    let uploads = 0;
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          return Promise.resolve([{ success: true, result: { opened: true } }]);
        }
        if (command?.[0] === "network") return Promise.resolve([pageBindingRecord()]);
        const source = command?.[1] ?? "";
        if (source.includes("return{ready:true}")) {
          stagingKey = String(sourceInput(source).stagingKey);
          return Promise.resolve([browserRecord({ ready: true })]);
        }
        if (source.includes("return{staged:chunks.length}")) {
          stagingBatches += 1;
          if (stagingBatches === 2) return Promise.reject(new Error("bounded staging failure"));
          return Promise.resolve(commands.map((candidate, index) => {
            const staged = Number(sourceInput(candidate[1] ?? "").index) + 1;
            expect(staged).toBe(index + 1);
            return browserRecord({ staged });
          }));
        }
        if (source.includes("return{removed}")) {
          cleanupKey = String(sourceInput(source).stagingKey);
          return Promise.resolve([browserRecord({ removed: true })]);
        }
        if (source.includes("const registrationBody=")) uploads += 1;
        throw new Error("unexpected LinkedIn evaluation source");
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createLinkedInPostBrowserTransport(auth, {
      timeoutMs: 10_000,
      dependencies: {
        createBrowserSession: () => Promise.resolve(session),
      },
    });

    try {
      await transport.uploadImage(auth.subject, image);
      throw new Error("expected LinkedIn staging failure");
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInPostImagePreparationError);
      expect(error).toMatchObject({ stage: "page image staging" });
      expect((error as Error).message).not.toContain("bounded staging failure");
    }
    await transport.close();
    expect(stagingBatches).toBe(2);
    expect(cleanupKey).toBe(stagingKey);
    expect(uploads).toBe(0);
  });

  test("categorizes a registration failure without exposing browser detail", async () => {
    const image = new Uint8Array(24);
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          return Promise.resolve([{ success: true, result: { opened: true } }]);
        }
        if (command?.[0] === "network") return Promise.resolve([pageBindingRecord()]);
        const source = command?.[1] ?? "";
        if (source.includes("return{ready:true}")) {
          return Promise.resolve([browserRecord({ ready: true })]);
        }
        if (source.includes("return{staged:chunks.length}")) {
          return Promise.resolve([browserRecord({ staged: 1 })]);
        }
        if (source.includes("const registrationBody=")) {
          return Promise.reject(new Error(
            "LinkedIn image registration returned an unreviewed field: private-detail",
          ));
        }
        if (source.includes("return{removed}")) {
          return Promise.resolve([browserRecord({ removed: true })]);
        }
        throw new Error("unexpected LinkedIn evaluation source");
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createLinkedInPostBrowserTransport(auth, {
      timeoutMs: 10_000,
      dependencies: {
        createBrowserSession: () => Promise.resolve(session),
      },
    });

    try {
      await transport.uploadImage(auth.subject, image);
      throw new Error("expected LinkedIn registration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInPostImagePreparationError);
      expect(error).toMatchObject({
        stage: "image registration response",
      });
      expect((error as Error).message).not.toContain(
        "private-detail",
      );
    }
    await transport.close();
  });
});
