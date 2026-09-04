import { describe, expect, test } from "bun:test";

import {
  encodeApplePhotosContactEvidenceCliOutput,
  formatApplePhotosContactEvidenceProgress,
  type ApplePhotosContactEvidenceProgressEvent,
} from "./apple-photos-cli";
import { createApplePhotosContactEvidenceExportResult } from "./apple-photos-contact-evidence";
import { main } from "./wrench";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

describe("Apple Photos CLI dispatch", () => {
  test("loads only the owned runtime and forwards output mode plus progress", async () => {
    const expected = Object.freeze({
      receipt: Object.freeze({
        format: "wrench.apple-photos-contact-evidence-export-receipt",
        runId: "123e4567-e89b-42d3-a456-426614174000",
      }),
      output: Object.freeze({
        format: "wrench.apple-photos-contact-evidence",
        evidence: Object.freeze([]),
      }),
    });
    let observed: unknown;
    let observedJson: boolean | undefined;
    const io = capture();
    const environment = { HOME: "/private/fixture-home" };
    const code = await main([
      "apple-photos",
      "export-contact-evidence",
      "--library",
      "/private/fixture.photoslibrary",
      "--json",
    ], environment, io.output, {
      loadApplePhotosCliRuntime: () => Promise.resolve({
        exportApplePhotosContactEvidenceForCli: (request) => {
          observed = request;
          request?.progress?.({ phase: "platform-check" });
          return Promise.resolve(expected as never);
        },
        runApplePhotosContactEvidenceWorker: () => Promise.resolve(),
        encodeApplePhotosContactEvidenceExportResult: (value) =>
          `${JSON.stringify(value)}\n`,
        encodeApplePhotosContactEvidenceSummary: () => "summary\n",
        encodeApplePhotosContactEvidenceCliOutput: (value, json) => {
          observedJson = json;
          return `${JSON.stringify(value)}\n`;
        },
        formatApplePhotosContactEvidenceProgress: (event) =>
          `apple-photos: ${event.phase}\n`,
      }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual(expected);
    expect(io.stderr()).toBe("apple-photos: platform-check\n");
    expect(observedJson).toBe(true);
    expect(observed).toMatchObject({
      library: "/private/fixture.photoslibrary",
      environment,
    });
  });

  test("keeps default output aggregate-only and progress path-free", () => {
    const time = "2026-08-28T12:34:56.000Z";
    const result = createApplePhotosContactEvidenceExportResult({
      runId: "123e4567-e89b-42d3-a456-426614174000",
      startedAt: time,
      finishedAt: time,
      observedAt: time,
      contactsDatabases: 1,
      libraryRealmSha256: "d".repeat(64),
      generationSha256: "a".repeat(64),
      photosSchemaSha256: "b".repeat(64),
      contactsSchemaSha256: "c".repeat(64),
      capture: {
        startedAt: time,
        finishedAt: time,
        photos: { startedAt: time, finishedAt: time },
        contacts: [{ ordinal: 0, startedAt: time, finishedAt: time }],
        consistency: "independent-read-transactions",
        crossDatabaseAtomicity: "not-asserted",
      },
      evidence: [{
        photosPersonId: "private-cluster",
        appleContactId: "private-contact",
        linkedFaceCount: 1,
        linkedAssetCount: 1,
        firstAssetAt: "2001-01-01T00:00:00.000Z",
        lastAssetAt: "2001-01-01T00:00:00.000Z",
      }],
    });
    const summary = encodeApplePhotosContactEvidenceCliOutput(result, false);
    const full = encodeApplePhotosContactEvidenceCliOutput(result, true);
    expect(summary).toContain("contact-evidence-summary");
    expect(summary).toContain('"matchedPeople":1');
    for (const privateValue of [
      "private-cluster",
      "private-contact",
      "2001-01-01",
      time,
    ]) expect(summary).not.toContain(privateValue);
    expect(full).toContain("private-cluster");

    const events: readonly ApplePhotosContactEvidenceProgressEvent[] = [
      { phase: "platform-check" },
      { phase: "private-export-admission" },
      { phase: "private-export-recovery" },
      { phase: "source-admission" },
      { phase: "contacts-discovery" },
      { phase: "photos-capture" },
      { phase: "contacts-capture", current: 1, total: 2 },
      { phase: "contacts-capture", current: 2, total: 2 },
      { phase: "evidence-validation" },
      { phase: "generation-hashing" },
      { phase: "cleanup" },
      { phase: "artifact-validation" },
      { phase: "complete" },
    ];
    for (const event of events) {
      const rendered = formatApplePhotosContactEvidenceProgress(event);
      expect(rendered).toBe(event.phase === "contacts-capture"
        ? `apple-photos: contacts-capture ${String(event.current)}-of-${String(event.total)}\n`
        : `apple-photos: ${event.phase}\n`);
      expect(rendered).not.toMatch(/[\\/]/u);
    }
  });
});
