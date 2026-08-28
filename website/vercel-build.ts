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

export function parseVercelDeploymentEnvironment(
  value: string | undefined,
  vercelMarker: string | undefined = undefined,
): VercelDeploymentEnvironment {
  const inVercel = vercelMarker === "1";
  if (
    vercelMarker !== undefined
    && vercelMarker.trim() !== ""
    && !inVercel
  ) {
    throw new Error(`Unsupported VERCEL marker: ${vercelMarker}`);
  }
  if (value === undefined || value.trim() === "") {
    if (inVercel) throw new Error("VERCEL_ENV is required during a Vercel build.");
    return "local";
  }
  if (value === "development" || value === "preview" || value === "production") {
    return value;
  }
  throw new Error(`Unsupported VERCEL_ENV: ${value}`);
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
  const deployment = parseVercelDeploymentEnvironment(
    environment.VERCEL_ENV,
    environment.VERCEL,
  );
  if (deployment === "production") {
    if (environment.VERCEL_GIT_COMMIT_REF !== VERCEL_PRODUCTION_BRANCH) {
      const sourceRef = environment.VERCEL_GIT_COMMIT_REF ?? "an unknown ref";
      throw new Error(
        `Vercel production must build ${VERCEL_PRODUCTION_BRANCH}, not ${sourceRef}.`,
      );
    }
    await dependencies.verifyProduction();
  }
  await dependencies.build(environment);
}

if (import.meta.main) await runVercelWebsiteBuild();
