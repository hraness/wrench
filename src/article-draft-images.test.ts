import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  articleDraftImageFileInput,
  articleDraftImageFileInputs,
  materializeArticleDraftImage,
  materializeArticleDraftImages,
} from "./article-draft-images";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wrench-article-images-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Article draft image files", () => {
  test("parses exact ordered plan-bound file references", () => {
    expect(articleDraftImageFileInputs([
      { kind: "file", reference: "sha256:first" },
      { kind: "file", reference: "sha256:second" },
    ], 2)).toEqual([
      { kind: "file", reference: "sha256:first" },
      { kind: "file", reference: "sha256:second" },
    ]);
    expect(() => articleDraftImageFileInputs([], 2)).toThrow("1-2 ordered");
    expect(() => articleDraftImageFileInputs([
      { kind: "file", reference: "one", path: "/tmp/escape" },
    ], 2)).toThrow("exact plan-bound file");
    expect(articleDraftImageFileInput(
      { kind: "file", reference: "sha256:cover" },
      "input.cover_image",
    )).toEqual({ kind: "file", reference: "sha256:cover" });
  });

  test("materializes one cover under a cover-only safe filename", async () => {
    const root = await temporaryRoot();
    const path = join(root, "cover.bin");
    await writeFile(path, Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));
    const image = await materializeArticleDraftImage(
      { kind: "file", reference: "cover" },
      async (files) => {
        expect(files).toEqual([{ kind: "file", reference: "cover" }]);
        return [path];
      },
      {
        maximumBytes: 100,
        inputLabel: "input.cover_image",
        filenamePrefix: "cover-image",
      },
    );
    expect(image).toMatchObject({
      filename: "cover-image-1.jpg",
      mediaType: "image/jpeg",
    });
  });

  test("materializes sniffed JPEG, PNG, and WebP bytes with safe names", async () => {
    const root = await temporaryRoot();
    const paths = [
      join(root, "first.bin"),
      join(root, "second.bin"),
      join(root, "third.bin"),
    ];
    await writeFile(paths[0]!, Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));
    await writeFile(paths[1]!, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(paths[2]!, new TextEncoder().encode("RIFFxxxxWEBP"));
    const files = paths.map((_, index) => ({ kind: "file" as const, reference: `asset-${index}` }));
    const images = await materializeArticleDraftImages(
      files,
      async (received) => {
        expect(received).toEqual(files);
        return paths;
      },
      { maximumBytes: 100, maximumImages: 3 },
    );
    expect(images.map(({ mediaType, filename, bytes }) => ({
      mediaType,
      filename,
      size: bytes.byteLength,
    }))).toEqual([
      { mediaType: "image/jpeg", filename: "inline-image-1.jpg", size: 4 },
      { mediaType: "image/png", filename: "inline-image-2.png", size: 8 },
      { mediaType: "image/webp", filename: "inline-image-3.webp", size: 12 },
    ]);
  });

  test("rejects missing resolvers, unsupported bytes, oversized files, and symlinks", async () => {
    const root = await temporaryRoot();
    const raw = join(root, "raw.bin");
    const large = join(root, "large.png");
    const png = join(root, "image.png");
    const link = join(root, "linked.png");
    await writeFile(raw, "not an image");
    await writeFile(large, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    await writeFile(png, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await symlink(png, link);
    const file = [{ kind: "file" as const, reference: "asset" }];
    await expect(materializeArticleDraftImages(file, undefined, {
      maximumBytes: 100,
      maximumImages: 1,
    })).rejects.toThrow("plan-bound file resolver");
    await expect(materializeArticleDraftImages(file, async () => [raw], {
      maximumBytes: 100,
      maximumImages: 1,
    })).rejects.toThrow("exact JPEG, PNG, or WebP bytes");
    await expect(materializeArticleDraftImages(file, async () => [large], {
      maximumBytes: 8,
      maximumImages: 1,
    })).rejects.toThrow("regular file no larger than 8 bytes");
    await expect(materializeArticleDraftImages(file, async () => [link], {
      maximumBytes: 100,
      maximumImages: 1,
    })).rejects.toThrow();
  });
});
