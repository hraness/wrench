import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InputSchema, OperationInput } from "./model";
import {
  cleanupPlanAssets,
  detectMediaType,
  detectOfficeOpenXmlMediaType,
  isPlanBoundFile,
  MAX_PLAN_ASSET_AGGREGATE_BYTES,
  PLAN_ASSET_GC_GRACE_MS,
  planAssetBundlePath,
  purgeOrphanedPlanAssets,
  resolvePlanAssetFiles,
  stagePlanAssets,
} from "./plan-assets";

const digest = "a".repeat(64);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function zipWithEntries(names: readonly string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const name of names) {
    const encoded = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(encoded.byteLength, 26);
    localParts.push(local, encoded);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(encoded.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, encoded);
    localOffset += local.byteLength + encoded.byteLength;
  }
  const locals = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(locals.byteLength, 16);
  return Buffer.concat([locals, central, end]);
}

type Fixture = {
  readonly root: string;
  readonly source: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

function fixture(contents: Uint8Array = png): Fixture {
  const root = mkdtempSync(join(tmpdir(), "wrench-plan-assets-test-"));
  chmodSync(root, 0o700);
  const source = join(root, "private original name.png");
  writeFileSync(source, contents, { mode: 0o600 });
  return {
    root,
    source,
    environment: { WRENCH_STATE_HOME: join(root, "state") },
  };
}

const oneImageSchema = {
  properties: {
    media: {
      type: "file",
      description: "One image",
      maxBytes: 1024,
      mediaTypes: ["image/*"],
    },
  },
  required: ["media"],
} as const satisfies InputSchema;

function stagedFile(input: OperationInput): Extract<OperationInput[string], { readonly kind: "file" }> {
  const value = input.media;
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("kind" in value)
    || value.kind !== "file"
  ) {
    throw new Error("expected one staged file");
  }
  return value;
}

describe("plan-bound attachments", () => {
  test("copies, hashes, anonymizes, commits, reverifies, and cleans one attachment", () => {
    const value = fixture();
    try {
      const staged = stagePlanAssets(
        { media: { kind: "file", reference: value.source } },
        oneImageSchema,
        value.environment,
      );
      const file = stagedFile(staged.input);
      expect(staged).toMatchObject({ count: 1, totalBytes: png.byteLength });
      expect(file.reference).not.toContain(value.source);
      expect(file.reference).not.toContain("private original name");
      expect(isPlanBoundFile(file)).toBeTrue();

      staged.commit(digest);
      const paths = resolvePlanAssetFiles([file], digest, value.environment);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toEndWith("asset-01.png");
      expect(readFileSync(paths[0] as string)).toEqual(png);
      expect(lstatSync(planAssetBundlePath(digest, value.environment)).mode & 0o777).toBe(0o700);
      expect(lstatSync(paths[0] as string).mode & 0o777).toBe(0o600);
      expect(cleanupPlanAssets(digest, value.environment)).toBeTrue();
      expect(cleanupPlanAssets(digest, value.environment)).toBeFalse();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("supports bounded file arrays and aborts an unused bundle", () => {
    const value = fixture();
    const second = join(value.root, "second.png");
    writeFileSync(second, png, { mode: 0o600 });
    const schema = {
      properties: {
        media: {
          type: "array",
          description: "Images",
          items: { type: "file", description: "Image", maxBytes: 1024, mediaTypes: ["image/png"] },
          minItems: 1,
          maxItems: 2,
        },
      },
      required: ["media"],
    } as const satisfies InputSchema;
    try {
      const staged = stagePlanAssets({
        media: [
          { kind: "file", reference: value.source },
          { kind: "file", reference: second },
        ],
      }, schema, value.environment);
      expect(staged).toMatchObject({ count: 2, totalBytes: png.byteLength * 2 });
      staged.abort();
      expect(() => staged.commit(digest)).toThrow();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("detects tampering after preview", () => {
    const value = fixture();
    try {
      const staged = stagePlanAssets({ media: { kind: "file", reference: value.source } }, oneImageSchema, value.environment);
      const file = stagedFile(staged.input);
      staged.commit(digest);
      const [path] = resolvePlanAssetFiles([file], digest, value.environment);
      writeFileSync(path as string, Buffer.concat([png.subarray(0, -1), Buffer.from([0xff])]), { mode: 0o600 });
      expect(() => resolvePlanAssetFiles([file], digest, value.environment)).toThrow("content hash");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("rejects symlinks, directories, oversized files, and mismatched content types", () => {
    const value = fixture(Buffer.alloc(2048, 1));
    const link = join(value.root, "link.png");
    symlinkSync(value.source, link);
    const attempts: readonly OperationInput[] = [
      { media: { kind: "file", reference: link } },
      { media: { kind: "file", reference: value.root } },
      { media: { kind: "file", reference: value.source } },
    ];
    try {
      for (const input of attempts) expect(() => stagePlanAssets(input, oneImageSchema, value.environment)).toThrow();
      writeFileSync(value.source, Buffer.from("plain text"), { mode: 0o600 });
      expect(() => stagePlanAssets({ media: { kind: "file", reference: value.source } }, oneImageSchema, value.environment)).toThrow("not allowed");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("rejects a FIFO without blocking", () => {
    const value = fixture();
    const fifo = join(value.root, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    try {
      expect(() => stagePlanAssets({ media: { kind: "file", reference: fifo } }, oneImageSchema, value.environment)).toThrow("regular file");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("purges only old unreferenced stages and bundles", () => {
    const value = fixture();
    const protectedDigest = "b".repeat(64);
    const orphanDigest = "c".repeat(64);
    const youngDigest = "d".repeat(64);
    const commit = (planDigest: string): string => {
      const staged = stagePlanAssets(
        { media: { kind: "file", reference: value.source } },
        oneImageSchema,
        value.environment,
      );
      staged.commit(planDigest);
      return planAssetBundlePath(planDigest, value.environment);
    };
    try {
      const protectedBundle = commit(protectedDigest);
      const orphanBundle = commit(orphanDigest);
      const youngBundle = commit(youngDigest);
      const assetRoot = join(value.environment.WRENCH_STATE_HOME as string, "plan-assets");
      const abandonedStage = join(assetRoot, ".stage-abandoned");
      mkdirSync(abandonedStage, { mode: 0o700 });
      writeFileSync(join(abandonedStage, "asset-01.tmp"), png, { mode: 0o600 });
      const now = new Date();
      const old = new Date(now.getTime() - PLAN_ASSET_GC_GRACE_MS - 1_000);
      for (const path of [protectedBundle, orphanBundle, abandonedStage]) utimesSync(path, old, old);

      const result = purgeOrphanedPlanAssets(new Set([protectedDigest]), value.environment, now);

      expect(result).toEqual({ scanned: 4, removed: 2, retained: 2, incomplete: false });
      expect(existsSync(protectedBundle)).toBeTrue();
      expect(existsSync(orphanBundle)).toBeFalse();
      expect(existsSync(abandonedStage)).toBeFalse();
      expect(existsSync(youngBundle)).toBeTrue();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("rejects staging that would exceed the serialized aggregate quota", () => {
    const value = fixture();
    try {
      const staged = stagePlanAssets(
        { media: { kind: "file", reference: value.source } },
        oneImageSchema,
        value.environment,
      );
      const file = stagedFile(staged.input);
      staged.commit(digest);
      const [path] = resolvePlanAssetFiles([file], digest, value.environment);
      truncateSync(path as string, MAX_PLAN_ASSET_AGGREGATE_BYTES);

      expect(() => stagePlanAssets(
        { media: { kind: "file", reference: value.source } },
        oneImageSchema,
        value.environment,
      )).toThrow("aggregate quota");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});

describe("media signature detection", () => {
  test("recognizes common post attachment containers without trusting extensions", () => {
    expect(detectMediaType(png)).toBe("image/png");
    expect(detectMediaType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(detectMediaType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(detectMediaType(Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
    expect(detectMediaType(Buffer.from("....ftypqt  "))).toBe("video/quicktime");
    expect(detectMediaType(Buffer.from("plain UTF-8 text"))).toBe("text/plain");
    expect(detectMediaType(Buffer.from([0, 1, 2, 3]))).toBe("application/octet-stream");
  });

  test("distinguishes bounded Office Open XML containers from generic ZIP files", () => {
    const value = fixture();
    const containers = [
      {
        name: "word",
        entry: "word/document.xml",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        name: "ppt",
        entry: "ppt/presentation.xml",
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      {
        name: "xl",
        entry: "xl/workbook.xml",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ] as const;
    try {
      for (const container of containers) {
        const path = join(value.root, `${container.name}.zip`);
        writeFileSync(path, zipWithEntries(["[Content_Types].xml", "_rels/.rels", container.entry]), { mode: 0o600 });
        expect(detectOfficeOpenXmlMediaType(path)).toBe(container.mediaType);
      }
      const plain = join(value.root, "plain.zip");
      writeFileSync(plain, zipWithEntries(["notes.txt"]), { mode: 0o600 });
      expect(detectOfficeOpenXmlMediaType(plain)).toBeNull();

      const ambiguous = join(value.root, "ambiguous.zip");
      writeFileSync(ambiguous, zipWithEntries([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "ppt/presentation.xml",
      ]), { mode: 0o600 });
      expect(detectOfficeOpenXmlMediaType(ambiguous)).toBeNull();

      const traversal = join(value.root, "traversal.zip");
      writeFileSync(traversal, zipWithEntries(["[Content_Types].xml", "_rels/.rels", "word/../evil"]), { mode: 0o600 });
      expect(detectOfficeOpenXmlMediaType(traversal)).toBeNull();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("stages a DOCX by signature with a safe extension", () => {
    const value = fixture(zipWithEntries(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]));
    const schema = {
      properties: {
        media: {
          type: "file",
          description: "Document",
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        },
      },
      required: ["media"],
    } as const satisfies InputSchema;
    try {
      const staged = stagePlanAssets({ media: { kind: "file", reference: value.source } }, schema, value.environment);
      const file = stagedFile(staged.input);
      staged.commit(digest);
      const [path] = resolvePlanAssetFiles([file], digest, value.environment);
      expect(path).toEndWith("asset-01.docx");
      expect(file.reference).toContain(Buffer.from(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ).toString("base64url"));
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
