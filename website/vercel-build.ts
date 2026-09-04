import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createProductionReleaseMarker,
  PRODUCTION_RELEASE_MARKER_PATH,
  serializeProductionReleaseMarker,
  type ProductionReleaseMarker,
} from "./production-release-marker.mjs";
import {
  verifyCurrentProductionRelease,
  type VerifiedProductionReleaseIdentity,
} from "./production-release-verifier";

type VercelBuildDependencies = Readonly<{
  build: (environment: Readonly<Record<string, string | undefined>>) => Promise<void>;
  publishProductionMarker: (marker: ProductionReleaseMarker) => Promise<void>;
  verifyProduction: () => Promise<VerifiedProductionReleaseIdentity>;
}>;

export type VercelDeploymentEnvironment =
  | "development"
  | "local"
  | "preview"
  | "production";

export const VERCEL_PRODUCTION_BRANCH = "website-production" as const;
export const WRENCH_VERCEL_BUILD_MARKER = "release-bound-v1" as const;
const productionCommitSha = /^[0-9a-f]{40}$/u;
const productionDeploymentHost = /^wrench-[a-z0-9]+-hraness\.vercel\.app$/u;

export function parseVercelDeploymentEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): VercelDeploymentEnvironment {
  const hasVercelSignal = Object.keys(environment).some((key) => (
    key === "WRENCH_VERCEL_BUILD" || key === "VERCEL" || key.startsWith("VERCEL_")
  ));
  if (!hasVercelSignal) return "local";

  if (environment.WRENCH_VERCEL_BUILD !== WRENCH_VERCEL_BUILD_MARKER) {
    throw new Error(
      `WRENCH_VERCEL_BUILD must equal ${WRENCH_VERCEL_BUILD_MARKER} whenever Vercel state is present.`,
    );
  }
  if (environment.VERCEL !== "1") {
    throw new Error("VERCEL must equal 1 during a release-bound Vercel build.");
  }
  const deployment = environment.VERCEL_ENV;
  if (
    deployment !== "development"
    && deployment !== "preview"
    && deployment !== "production"
  ) {
    throw new Error(`Unsupported VERCEL_ENV: ${deployment ?? "missing"}`);
  }
  const sourceRef = environment.VERCEL_GIT_COMMIT_REF;
  if (
    sourceRef === undefined
    || sourceRef === ""
    || sourceRef.trim() !== sourceRef
  ) {
    throw new Error("VERCEL_GIT_COMMIT_REF must be an exact nonempty Git ref.");
  }
  if (deployment === "production" && sourceRef !== VERCEL_PRODUCTION_BRANCH) {
    throw new Error(
      `Vercel production must build ${VERCEL_PRODUCTION_BRANCH}, not ${sourceRef}.`,
    );
  }
  if (deployment !== "production" && sourceRef === VERCEL_PRODUCTION_BRANCH) {
    throw new Error(
      `${VERCEL_PRODUCTION_BRANCH} must be classified as a production deployment.`,
    );
  }
  if (deployment === "production") {
    if (!productionCommitSha.test(environment.VERCEL_GIT_COMMIT_SHA ?? "")) {
      throw new Error(
        "VERCEL_GIT_COMMIT_SHA must be one lowercase 40-hex commit during production.",
      );
    }
    if (!productionDeploymentHost.test(environment.VERCEL_URL ?? "")) {
      throw new Error("VERCEL_URL must be one exact Wrench production deployment host.");
    }
  }
  return deployment;
}

async function buildCurrentWebsite(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const { buildWebsite } = await import("./build");
  await buildWebsite(environment);
}

async function publishCurrentProductionMarker(
  marker: ProductionReleaseMarker,
): Promise<void> {
  const markerPath = join(import.meta.dir, "dist", PRODUCTION_RELEASE_MARKER_PATH.slice(1));
  await mkdir(join(import.meta.dir, "dist", ".well-known"), {
    mode: 0o755,
    recursive: true,
  });
  await writeFile(markerPath, serializeProductionReleaseMarker(marker), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
}

export async function runVercelWebsiteBuild(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: VercelBuildDependencies = {
    build: buildCurrentWebsite,
    publishProductionMarker: publishCurrentProductionMarker,
    verifyProduction: verifyCurrentProductionRelease,
  },
): Promise<void> {
  const deployment = parseVercelDeploymentEnvironment(environment);
  if (deployment === "production") {
    const identity = await dependencies.verifyProduction();
    if (environment.VERCEL_GIT_COMMIT_SHA !== identity.sourceSha) {
      throw new Error(
        "VERCEL_GIT_COMMIT_SHA does not equal the verifier-proven production HEAD.",
      );
    }
    const marker = createProductionReleaseMarker({
      deploymentUrl: `https://${environment.VERCEL_URL ?? ""}`,
      name: identity.name,
      sourceSha: identity.sourceSha,
      tag: identity.tag,
      version: identity.version,
    });
    await dependencies.build(environment);
    await dependencies.publishProductionMarker(marker);
    return;
  }
  await dependencies.build(environment);
}

if (import.meta.main) await runVercelWebsiteBuild();
