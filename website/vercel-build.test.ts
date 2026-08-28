import { describe, expect, test } from "bun:test";

import {
  parseVercelDeploymentEnvironment,
  runVercelWebsiteBuild,
  VERCEL_PRODUCTION_BRANCH,
  WRENCH_VERCEL_BUILD_MARKER,
} from "./vercel-build";

const releaseBoundEnvironment = Object.freeze({
  VERCEL: "1",
  WRENCH_VERCEL_BUILD: WRENCH_VERCEL_BUILD_MARKER,
});

describe("Vercel website build admission", () => {
  test("verifies the release before a production build", async () => {
    const calls: string[] = [];
    await runVercelWebsiteBuild(
      {
        ...releaseBoundEnvironment,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: VERCEL_PRODUCTION_BRANCH,
      },
      {
        build: async () => { calls.push("build"); },
        verifyProduction: async () => { calls.push("verify"); },
      },
    );
    expect(calls).toEqual(["verify", "build"]);
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
          verifyProduction: async () => { calls.push("verify"); },
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
        verifyProduction: async () => { calls.push("verify"); },
      })).rejects.toThrow(expected);
      expect(calls).toEqual([]);
    }
  });

  test("does not build when production verification fails", async () => {
    let built = false;
    await expect(runVercelWebsiteBuild(
      {
        ...releaseBoundEnvironment,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: VERCEL_PRODUCTION_BRANCH,
      },
      {
        build: async () => { built = true; },
        verifyProduction: async () => { throw new Error("release mismatch"); },
      },
    )).rejects.toThrow("release mismatch");
    expect(built).toBe(false);
  });
});
