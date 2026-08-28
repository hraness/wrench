import { describe, expect, test } from "bun:test";

import {
  parseVercelDeploymentEnvironment,
  runVercelWebsiteBuild,
  VERCEL_PRODUCTION_BRANCH,
} from "./vercel-build";

describe("Vercel website build admission", () => {
  test("verifies the release before a production build", async () => {
    const calls: string[] = [];
    await runVercelWebsiteBuild(
      {
        VERCEL: "1",
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
      { VERCEL_ENV: "development" },
      { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" },
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
    expect(parseVercelDeploymentEnvironment(undefined)).toBe("local");
    expect(() => parseVercelDeploymentEnvironment(undefined, "1"))
      .toThrow("VERCEL_ENV is required");
    expect(() => parseVercelDeploymentEnvironment("preview", "true"))
      .toThrow("Unsupported VERCEL marker");
    expect(() => parseVercelDeploymentEnvironment("prodution"))
      .toThrow("Unsupported VERCEL_ENV");
  });

  test("fails closed for incomplete Vercel state and a production build from main", async () => {
    for (const environment of [
      { VERCEL: "1" },
      { VERCEL: "1", VERCEL_ENV: "production" },
      {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
      },
    ] as const) {
      const calls: string[] = [];
      await expect(runVercelWebsiteBuild(environment, {
        build: async () => { calls.push("build"); },
        verifyProduction: async () => { calls.push("verify"); },
      })).rejects.toThrow(
        environment.VERCEL_ENV === undefined
          ? "VERCEL_ENV is required"
          : "Vercel production must build website-production",
      );
      expect(calls).toEqual([]);
    }
  });

  test("does not build when production verification fails", async () => {
    let built = false;
    await expect(runVercelWebsiteBuild(
      {
        VERCEL: "1",
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
