import { describe, expect, test } from "bun:test";

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
  test("loads only the owned runtime and prints its exact receipt envelope", async () => {
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
          return Promise.resolve(expected as never);
        },
        encodeApplePhotosContactEvidenceExportResult: (value) =>
          `${JSON.stringify(value)}\n`,
      }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual(expected);
    expect(io.stderr()).toBe("");
    expect(observed).toMatchObject({
      library: "/private/fixture.photoslibrary",
      environment,
    });
  });
});
