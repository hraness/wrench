import { verifyCurrentProductionRelease } from "./production-release-verifier";

type VercelBuildDependencies = Readonly<{
  build: (environment: Readonly<Record<string, string | undefined>>) => Promise<void>;
  verifyProduction: () => Promise<unknown>;
}>;

export type VercelDeploymentEnvironment =
  | "development"
  | "local"
  | "preview"
  | "production";

export const VERCEL_PRODUCTION_BRANCH = "website-production" as const;
export const WRENCH_VERCEL_BUILD_MARKER = "release-bound-v1" as const;

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
  return deployment;
}

async function buildCurrentWebsite(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const { buildWebsite } = await import("./build");
  await buildWebsite(environment);
}

export async function runVercelWebsiteBuild(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: VercelBuildDependencies = {
    build: buildCurrentWebsite,
    verifyProduction: verifyCurrentProductionRelease,
  },
): Promise<void> {
  const deployment = parseVercelDeploymentEnvironment(environment);
  if (deployment === "production") {
    await dependencies.verifyProduction();
  }
  await dependencies.build(environment);
}

if (import.meta.main) await runVercelWebsiteBuild();
