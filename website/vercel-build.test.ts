import { describe, expect, test } from "bun:test";

import {
  parseVercelDeploymentEnvironment,
  runVercelWebsiteBuild,
  VERCEL_PRODUCTION_BRANCH,
  WRENCH_VERCEL_BUILD_MARKER,
} from "./vercel-build";
import {
  serializeProductionReleaseMarker,
  type ProductionReleaseMarker,
} from "./production-release-marker.mjs";

const releaseBoundEnvironment = Object.freeze({
  VERCEL: "1",
  WRENCH_VERCEL_BUILD: WRENCH_VERCEL_BUILD_MARKER,
});
const sourceSha = "2".repeat(40);
const productionEnvironment = Object.freeze({
  ...releaseBoundEnvironment,
  VERCEL_ENV: "production",
  VERCEL_GIT_COMMIT_REF: VERCEL_PRODUCTION_BRANCH,
  VERCEL_GIT_COMMIT_SHA: sourceSha,
  VERCEL_URL: "wrench-release123-hraness.vercel.app",
});
const verifiedIdentity = Object.freeze({
  name: "@hraness/wrench" as const,
  sourceSha,
  tag: "v0.16.5" as const,
  version: "0.16.5",
});

describe("Vercel website build admission", () => {
  test("verifies the release before a production build", async () => {
    const calls: string[] = [];
    let marker: ProductionReleaseMarker | undefined;
    await runVercelWebsiteBuild(
      productionEnvironment,
      {
        build: async () => { calls.push("build"); },
        publishProductionMarker: async (value) => {
          calls.push("marker");
          marker = value;
        },
        verifyProduction: async () => {
          calls.push("verify");
          return verifiedIdentity;
        },
      },
    );
    expect(calls).toEqual(["verify", "build", "marker"]);
    expect(serializeProductionReleaseMarker(marker)).toBe(
      `{"schemaVersion":"wrench-production-release-v1","name":"@hraness/wrench","repository":"hraness/wrench","tag":"v0.16.5","version":"0.16.5","sourceSha":"${sourceSha}","deploymentUrl":"https://wrench-release123-hraness.vercel.app"}\n`,
    );
    expect(new TextEncoder().encode(serializeProductionReleaseMarker(marker)).byteLength)
      .toBeLessThanOrEqual(1_024);
  });

  test("keeps previews and local builds independent of external release state", async () => {
    for (const environment of [
      {},
      {
        ...releaseBoundEnvironment,
        VERCEL_ENV: "development",
        VERCEL_GIT_COMMIT_REF: "local-preview",
      },
      {
        ...releaseBoundEnvironment,
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "main",
      },
    ] as const) {
      const calls: string[] = [];
      await runVercelWebsiteBuild(
        environment,
        {
          build: async () => { calls.push("build"); },
          publishProductionMarker: async () => { calls.push("marker"); },
          verifyProduction: async () => {
            calls.push("verify");
            return verifiedIdentity;
          },
        },
      );
      expect(calls).toEqual(["build"]);
    }
    expect(parseVercelDeploymentEnvironment({})).toBe("local");
  });

  test("fails closed for missing, malformed, and inconsistent Vercel state", async () => {
    const cases = [
      [{ WRENCH_VERCEL_BUILD: WRENCH_VERCEL_BUILD_MARKER }, "VERCEL must equal 1"],
      [{ WRENCH_VERCEL_BUILD: undefined }, "WRENCH_VERCEL_BUILD must equal release-bound-v1"],
      [{ VERCEL: "1" }, "WRENCH_VERCEL_BUILD must equal release-bound-v1"],
      [{ VERCEL: undefined }, "WRENCH_VERCEL_BUILD must equal release-bound-v1"],
      [{ VERCEL_URL: "wrench.example" }, "WRENCH_VERCEL_BUILD must equal release-bound-v1"],
      [{ ...releaseBoundEnvironment }, "Unsupported VERCEL_ENV: missing"],
      [
        { ...releaseBoundEnvironment, VERCEL_ENV: "preview" },
        "VERCEL_GIT_COMMIT_REF must be an exact nonempty Git ref",
      ],
      [
        {
          VERCEL: "1",
          VERCEL_ENV: "preview",
          VERCEL_GIT_COMMIT_REF: "main",
          WRENCH_VERCEL_BUILD: "release-bound-v2",
        },
        "WRENCH_VERCEL_BUILD must equal release-bound-v1",
      ],
      [
        {
          VERCEL: "true",
          VERCEL_ENV: "preview",
          VERCEL_GIT_COMMIT_REF: "main",
          WRENCH_VERCEL_BUILD: WRENCH_VERCEL_BUILD_MARKER,
        },
        "VERCEL must equal 1",
      ],
      [
        {
          ...releaseBoundEnvironment,
          VERCEL_ENV: "prodution",
          VERCEL_GIT_COMMIT_REF: VERCEL_PRODUCTION_BRANCH,
        },
        "Unsupported VERCEL_ENV: prodution",
      ],
      [
        {
          ...releaseBoundEnvironment,
          VERCEL_ENV: "production",
          VERCEL_GIT_COMMIT_REF: "main",
        },
        "Vercel production must build website-production",
      ],
      [
        {
          ...releaseBoundEnvironment,
          VERCEL_ENV: "preview",
          VERCEL_GIT_COMMIT_REF: VERCEL_PRODUCTION_BRANCH,
        },
        "website-production must be classified as a production deployment",
      ],
      [
        {
          ...releaseBoundEnvironment,
          VERCEL_ENV: "preview",
          VERCEL_GIT_COMMIT_REF: " main",
        },
        "VERCEL_GIT_COMMIT_REF must be an exact nonempty Git ref",
      ],
    ] as const;
    for (const [environment, expected] of cases) {
      const calls: string[] = [];
      await expect(runVercelWebsiteBuild(environment, {
        build: async () => { calls.push("build"); },
        publishProductionMarker: async () => { calls.push("marker"); },
        verifyProduction: async () => {
          calls.push("verify");
          return verifiedIdentity;
        },
      })).rejects.toThrow(expected);
      expect(calls).toEqual([]);
    }
  });

  test("fails closed for a production build from main", async () => {
    for (const environment of [
      {
        ...releaseBoundEnvironment,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_COMMIT_SHA: sourceSha,
        VERCEL_URL: "wrench-release123-hraness.vercel.app",
      },
    ] as const) {
      const calls: string[] = [];
      await expect(runVercelWebsiteBuild(environment, {
        build: async () => { calls.push("build"); },
        publishProductionMarker: async () => { calls.push("marker"); },
        verifyProduction: async () => {
          calls.push("verify");
          return verifiedIdentity;
        },
      })).rejects.toThrow("Vercel production must build website-production");
      expect(calls).toEqual([]);
    }
  });

  test("does not build when production verification fails", async () => {
    let built = false;
    await expect(runVercelWebsiteBuild(
      productionEnvironment,
      {
        build: async () => { built = true; },
        publishProductionMarker: async () => { built = true; },
        verifyProduction: async () => { throw new Error("release mismatch"); },
      },
    )).rejects.toThrow("release mismatch");
    expect(built).toBe(false);
  });

  test("fails before building for missing, malformed, or contradictory production identity", async () => {
    for (const [environment, identity, expected] of [
      [
        { ...productionEnvironment, VERCEL_GIT_COMMIT_SHA: undefined },
        verifiedIdentity,
        "VERCEL_GIT_COMMIT_SHA must be one lowercase 40-hex commit",
      ],
      [
        { ...productionEnvironment, VERCEL_GIT_COMMIT_SHA: "A".repeat(40) },
        verifiedIdentity,
        "VERCEL_GIT_COMMIT_SHA must be one lowercase 40-hex commit",
      ],
      [
        { ...productionEnvironment, VERCEL_URL: "wrench.rip" },
        verifiedIdentity,
        "VERCEL_URL must be one exact Wrench production deployment host",
      ],
      [
        productionEnvironment,
        { ...verifiedIdentity, sourceSha: "3".repeat(40) },
        "does not equal the verifier-proven production HEAD",
      ],
    ] as const) {
      const calls: string[] = [];
      await expect(runVercelWebsiteBuild(environment, {
        build: async () => { calls.push("build"); },
        publishProductionMarker: async () => { calls.push("marker"); },
        verifyProduction: async () => {
          calls.push("verify");
          return identity;
        },
      })).rejects.toThrow(expected);
      expect(calls).not.toContain("build");
      expect(calls).not.toContain("marker");
    }
  });

  test("does not publish a marker when the production build fails", async () => {
    const calls: string[] = [];
    await expect(runVercelWebsiteBuild(productionEnvironment, {
      build: async () => {
        calls.push("build");
        throw new Error("build failed");
      },
      publishProductionMarker: async () => { calls.push("marker"); },
      verifyProduction: async () => {
        calls.push("verify");
        return verifiedIdentity;
      },
    })).rejects.toThrow("build failed");
    expect(calls).toEqual(["verify", "build"]);
  });
});
