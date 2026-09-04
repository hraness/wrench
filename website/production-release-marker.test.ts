import { describe, expect, test } from "bun:test";

import {
  createProductionReleaseMarker,
  parseProductionReleaseMarker,
  PRODUCTION_RELEASE_MARKER_MAX_BYTES,
  PRODUCTION_RELEASE_MARKER_PATH,
  PRODUCTION_RELEASE_MARKER_SCHEMA,
  serializeProductionReleaseMarker,
} from "./production-release-marker.mjs";

const sourceSha = "2".repeat(40);
const deploymentUrl = "https://wrench-release123-hraness.vercel.app";
const marker = createProductionReleaseMarker({
  deploymentUrl,
  name: "@hraness/wrench",
  sourceSha,
  tag: "v0.16.5",
  version: "0.16.5",
});
const canonical = `{"schemaVersion":"wrench-production-release-v1","name":"@hraness/wrench","repository":"hraness/wrench","tag":"v0.16.5","version":"0.16.5","sourceSha":"${sourceSha}","deploymentUrl":"${deploymentUrl}"}\n`;

describe("production release marker", () => {
  test("keeps one exact bounded canonical seven-key wire contract", () => {
    expect(PRODUCTION_RELEASE_MARKER_PATH).toBe("/.well-known/wrench-release.json");
    expect(PRODUCTION_RELEASE_MARKER_SCHEMA).toBe("wrench-production-release-v1");
    expect(PRODUCTION_RELEASE_MARKER_MAX_BYTES).toBe(1_024);
    expect(Object.keys(marker)).toEqual([
      "schemaVersion",
      "name",
      "repository",
      "tag",
      "version",
      "sourceSha",
      "deploymentUrl",
    ]);
    expect(serializeProductionReleaseMarker(marker)).toBe(canonical);
    expect(new TextEncoder().encode(canonical).byteLength)
      .toBeLessThanOrEqual(PRODUCTION_RELEASE_MARKER_MAX_BYTES);
    expect(parseProductionReleaseMarker(canonical)).toEqual(marker);
    expect(Object.isFrozen(marker)).toBe(true);
  });

  test("rejects malformed, reordered, expanded, or noncanonical marker bodies", () => {
    const value = JSON.parse(canonical) as Record<string, unknown>;
    const reordered = {
      name: value.name,
      schemaVersion: value.schemaVersion,
      repository: value.repository,
      tag: value.tag,
      version: value.version,
      sourceSha: value.sourceSha,
      deploymentUrl: value.deploymentUrl,
    };
    for (const body of [
      canonical.slice(0, -1),
      `${canonical}\n`,
      `${JSON.stringify(value, null, 2)}\n`,
      `${JSON.stringify(reordered)}\n`,
      `${JSON.stringify({ ...value, extra: true })}\n`,
      "null\n",
      "[]\n",
      "not json\n",
      "x".repeat(PRODUCTION_RELEASE_MARKER_MAX_BYTES + 1),
    ]) {
      expect(() => parseProductionReleaseMarker(body)).toThrow();
    }
    expect(() => parseProductionReleaseMarker(1 as unknown as string)).toThrow(
      "body must be a string",
    );
  });

  test("rejects every release-identity and deployment-identity drift", () => {
    const cases = [
      { schemaVersion: "wrench-production-release-v2" },
      { schemaVersion: 1 },
      { name: "wrench" },
      { repository: "other/wrench" },
      { tag: "0.16.5" },
      { tag: "v0.16.5-beta.1" },
      { version: "0.16.4" },
      { version: "00.16.5" },
      { sourceSha: "A".repeat(40) },
      { sourceSha: "2".repeat(39) },
      { deploymentUrl: "http://wrench-release123-hraness.vercel.app" },
      { deploymentUrl: "https://wrench-release123-hraness.vercel.app/" },
      { deploymentUrl: "https://wrench-release_123-hraness.vercel.app" },
      { deploymentUrl: "https://wrench-five.vercel.app" },
      { deploymentUrl: "https://wrench.rip" },
    ] as const;
    for (const override of cases) {
      expect(() => parseProductionReleaseMarker(
        `${JSON.stringify({ ...marker, ...override })}\n`,
      )).toThrow();
    }
  });
});
