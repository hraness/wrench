import { describe, expect, test } from "bun:test";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const installer = join(import.meta.dir, "install-whatsapp-protocol.sh");

describe("official WhatsApp runtime installer", () => {
  test("pins the signed and notarized OpenClaw v0.15.0 release", async () => {
    const source = readFileSync(installer, "utf8");
    expect(source).toContain("version=0.15.0");
    expect(source).toContain(
      "release_commit=a020de724180d31eccfa5241d45443402d62fb06",
    );
    expect(source).toContain(
      "archive_sha256=2b54f33d246e913a5c33525b4fc895a345363c2dcc673c70fa5f19cffb15d17d",
    );
    expect(source).toContain(
      "binary_sha256=a900af4d0dfd10471bcdf74105b9f256d1a08574242a041df3e5985a548826aa",
    );
    expect(source).toContain(
      "signature_authority='Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)'",
    );
    expect(source).toContain("--check-notarization");
    expect(source).toContain("-R=notarized");
    expect(source).toContain("transport_version=official-release");
    expect(source).not.toContain("wrench-private");
    expect(source).not.toContain("whatsmeow_archive");
    expect(source).not.toContain("go_source_url");
    expect(lstatSync(installer).mode & 0o777).toBe(0o755);

    const child = Bun.spawn(["/bin/sh", "-n", installer], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  });
});
