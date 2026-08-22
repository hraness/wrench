import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertDerivationFixtureFile,
  MAX_DERIVATION_FIXTURES,
  parseDerivationFixtures,
  stageDerivationFixtures,
} from "./derive-fixtures";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("bounded fixture bytes", "utf8"),
]);

const mp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.from("bounded fixture bytes", "utf8"),
]);

describe("derivation fixtures", () => {
  test("copies, fingerprints, and re-verifies an image without retaining its source path", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-derive-fixture-test-"));
    chmodSync(root, 0o700);
    const source = join(root, "source-private-name.png");
    writeFileSync(source, png, { mode: 0o600 });
    try {
      const [fixture] = stageDerivationFixtures([source], root);
      expect(fixture).toMatchObject({
        reference: "fixture:1",
        fileName: "fixture-01.png",
        bytes: png.byteLength,
        mediaType: "image/png",
      });
      expect(fixture?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(fixture)).not.toContain("source-private-name");
      expect(assertDerivationFixtureFile(root, fixture!)).toBe("./fixture-01.png");
      expect(readFileSync(join(root, "fixture-01.png"))).toEqual(png);
      expect(lstatSync(join(root, "fixture-01.png")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("copies, fingerprints, and re-verifies an MP4 without retaining its source path", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-derive-video-fixture-test-"));
    chmodSync(root, 0o700);
    const source = join(root, "source-private-name.mp4");
    writeFileSync(source, mp4, { mode: 0o600 });
    try {
      const [fixture] = stageDerivationFixtures([source], root);
      expect(fixture).toMatchObject({
        reference: "fixture:1",
        fileName: "fixture-01.mp4",
        bytes: mp4.byteLength,
        mediaType: "video/mp4",
      });
      expect(fixture?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(fixture)).not.toContain("source-private-name");
      expect(assertDerivationFixtureFile(root, fixture!)).toBe("./fixture-01.mp4");
      expect(readFileSync(join(root, "fixture-01.mp4"))).toEqual(mp4);
      expect(lstatSync(join(root, "fixture-01.mp4")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects substitution after staging", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-derive-fixture-tamper-test-"));
    chmodSync(root, 0o700);
    const source = join(root, "source.png");
    writeFileSync(source, png, { mode: 0o600 });
    try {
      const [fixture] = stageDerivationFixtures([source], root);
      writeFileSync(join(root, "fixture-01.png"), Buffer.from("changed", "utf8"));
      expect(() => assertDerivationFixtureFile(root, fixture!)).toThrow("changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects symlink sources and unsupported content", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-derive-fixture-kind-test-"));
    chmodSync(root, 0o700);
    const image = join(root, "image.png");
    const link = join(root, "linked.png");
    const text = join(root, "notes.txt");
    writeFileSync(image, png, { mode: 0o600 });
    writeFileSync(text, "not an image", { mode: 0o600 });
    symlinkSync(image, link);
    try {
      expect(() => stageDerivationFixtures([link], root)).toThrow("opened safely");
      expect(() => stageDerivationFixtures([text], root)).toThrow("content type");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strictly parses sequential bounded metadata and rejects drift", () => {
    const fixture = {
      reference: "fixture:1",
      fileName: "fixture-01.png",
      bytes: 8,
      mediaType: "image/png",
      sha256: "b".repeat(64),
      device: "1",
      inode: "2",
    } as const;
    expect(parseDerivationFixtures([fixture])).toEqual([fixture]);
    expect(() => parseDerivationFixtures([{ ...fixture, extra: true }])).toThrow("malformed");
    expect(() => parseDerivationFixtures([{ ...fixture, reference: "fixture:2" }])).toThrow("malformed");
    expect(() => stageDerivationFixtures(
      Array.from({ length: MAX_DERIVATION_FIXTURES + 1 }, () => "image.png"),
      "/private/not-used",
    )).toThrow("count exceeds");
  });
});
