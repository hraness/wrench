import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPrivateJsonIfAbsent,
  ensurePrivateDirectory,
  readRegularFile,
  writePrivateJson,
} from "./storage";

function symlinkAncestorFixture(): {
  readonly external: string;
  readonly linkedNested: string;
  readonly outer: string;
} {
  const outer = mkdtempSync(join(tmpdir(), "wrench-nonstate-path-test-"));
  const external = mkdtempSync(join(tmpdir(), "wrench-nonstate-external-test-"));
  mkdirSync(join(external, "nested"), { mode: 0o700 });
  symlinkSync(external, join(outer, "linked"));
  return { external, linkedNested: join(outer, "linked", "nested"), outer };
}

function removeFixture(fixture: ReturnType<typeof symlinkAncestorFixture>): void {
  rmSync(fixture.outer, { recursive: true, force: true });
  rmSync(fixture.external, { recursive: true, force: true });
}

describe("non-state private storage", () => {
  test("rejects a symlink in an existing directory ancestor without changing the target mode", () => {
    const fixture = symlinkAncestorFixture();
    try {
      const externalTarget = join(fixture.external, "nested");
      chmodSync(externalTarget, 0o777);

      expect(() => ensurePrivateDirectory(fixture.linkedNested)).toThrow();
      expect(lstatSync(externalTarget).mode & 0o777).toBe(0o777);
    } finally {
      removeFixture(fixture);
    }
  });

  test("rejects a permissive preexisting target directory without changing its mode", () => {
    const outer = mkdtempSync(join(tmpdir(), "wrench-nonstate-mode-test-"));
    const target = join(outer, "existing");
    try {
      mkdirSync(target);
      chmodSync(target, 0o777);

      expect(() => ensurePrivateDirectory(target)).toThrow();
      expect(lstatSync(target).mode & 0o777).toBe(0o777);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("rejects a read through a symlinked directory ancestor", () => {
    const fixture = symlinkAncestorFixture();
    try {
      writeFileSync(join(fixture.external, "nested", "value.json"), "{\"outside\":true}\n", { mode: 0o600 });

      expect(() => readRegularFile(join(fixture.linkedNested, "value.json"), 1_024)).toThrow();
    } finally {
      removeFixture(fixture);
    }
  });

  test("rejects replacement and create-if-absent writes through a symlinked directory ancestor", () => {
    const fixture = symlinkAncestorFixture();
    try {
      const replacement = join(fixture.linkedNested, "replace.json");
      const createOnly = join(fixture.linkedNested, "create.json");

      expect(() => writePrivateJson(replacement, { outside: false })).toThrow();
      expect(() => createPrivateJsonIfAbsent(createOnly, { outside: false })).toThrow();
      expect(existsSync(join(fixture.external, "nested", "replace.json"))).toBeFalse();
      expect(existsSync(join(fixture.external, "nested", "create.json"))).toBeFalse();
    } finally {
      removeFixture(fixture);
    }
  });
});
