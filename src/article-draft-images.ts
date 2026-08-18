import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { BrowserFileResolver } from "./browser";
import type { FileInputValue } from "./model";
import type { WebSessionOperationDeadline } from "./web-session-execution";

export type ArticleDraftImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export type BoundArticleDraftImage = {
  readonly bytes: Uint8Array;
  readonly mediaType: ArticleDraftImageMediaType;
  readonly filename: string;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileInput(value: unknown, label: string): FileInputValue {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "kind,reference"
    || value.kind !== "file"
    || typeof value.reference !== "string"
    || value.reference.length < 1
  ) throw new Error(`${label} must be one exact plan-bound file`);
  return Object.freeze({ kind: "file", reference: value.reference });
}

export function articleDraftImageFileInputs(
  value: unknown,
  maximumImages: number,
): readonly FileInputValue[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumImages) {
    throw new Error(`input.inline_images must contain 1-${maximumImages} ordered plan-bound files`);
  }
  return Object.freeze(value.map((item, index) =>
    fileInput(item, `input.inline_images[${index}]`)));
}

function sniffImage(bytes: Uint8Array): ArticleDraftImageMediaType {
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) return "image/jpeg";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  throw new Error("Article inline images must be exact JPEG, PNG, or WebP bytes");
}

function filename(index: number, mediaType: ArticleDraftImageMediaType): string {
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "webp";
  return `inline-image-${index + 1}.${extension}`;
}

async function readImage(
  path: string,
  index: number,
  maximumBytes: number,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<BoundArticleDraftImage> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = operationDeadline === undefined
    ? await open(path, constants.O_RDONLY | noFollow)
    : await operationDeadline.run(
        () => open(path, constants.O_RDONLY | noFollow),
        "authenticated web operation deadline",
      );
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw new Error(
        `Article inline images must be regular files no larger than ${maximumBytes} bytes`,
      );
    }
    const raw = operationDeadline === undefined
      ? await handle.readFile()
      : await operationDeadline.run(
          () => handle.readFile(),
          "authenticated web operation deadline",
        );
    const after = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || raw.byteLength !== before.size
    ) throw new Error("Article inline image changed while it was materialized");
    const bytes = new Uint8Array(raw);
    const mediaType = sniffImage(bytes);
    return Object.freeze({ bytes, mediaType, filename: filename(index, mediaType) });
  } finally {
    await handle.close();
  }
}

export async function materializeArticleDraftImages(
  value: unknown,
  fileResolver: BrowserFileResolver | undefined,
  options: {
    readonly maximumBytes: number;
    readonly maximumImages: number;
    readonly operationDeadline?: WebSessionOperationDeadline;
  },
): Promise<readonly BoundArticleDraftImage[]> {
  const files = articleDraftImageFileInputs(value, options.maximumImages);
  if (fileResolver === undefined) {
    throw new Error("Article inline images require the plan-bound file resolver");
  }
  const paths = options.operationDeadline === undefined
    ? await fileResolver(files)
    : await options.operationDeadline.run(
        () => fileResolver(files),
        "authenticated web operation deadline",
      );
  options.operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (
    paths.length !== files.length
    || paths.some((path) => typeof path !== "string" || path.length < 1)
  ) throw new Error("Article inline image resolver did not return every exact plan-bound path");
  const images: BoundArticleDraftImage[] = [];
  for (const [index, path] of paths.entries()) {
    images.push(await readImage(
      path as string,
      index,
      options.maximumBytes,
      options.operationDeadline,
    ));
  }
  return Object.freeze(images);
}
