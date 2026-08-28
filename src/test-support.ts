import fc from "fast-check";
import type { IAsyncProperty, IProperty, Parameters } from "fast-check";

export { fc };
export type * from "fast-check";

type PropertyReplayEnvironment = Readonly<Record<string, unknown>>;

const MIN_FAST_CHECK_SEED = -2_147_483_648;
const MAX_FAST_CHECK_SEED = 2_147_483_647;
const MAX_FAST_CHECK_PATH_BYTES = 512;
const MAX_FAST_CHECK_PATH_SEGMENT = 10_000;
const MAX_FAST_CHECK_PATH_WORK = 100_000;

function isComputationallyBoundedFastCheckPath(path: string): boolean {
  if (!/^(?:0|[1-9]\d*)(?::(?:0|[1-9]\d*))*$/u.test(path)) return false;
  let work = 0;
  for (const segment of path.split(":")) {
    const skip = Number(segment);
    if (!Number.isSafeInteger(skip) || skip > MAX_FAST_CHECK_PATH_SEGMENT) {
      return false;
    }
    work += skip;
    if (work > MAX_FAST_CHECK_PATH_WORK) return false;
  }
  return true;
}

/**
 * Parse an opt-in fast-check replay coordinate without accepting ambiguous or
 * unbounded process input. A path is meaningful only with the seed that
 * produced it, so the pair fails closed instead of silently replaying a
 * different workload.
 */
export function propertyReplayParameters(
  environment: PropertyReplayEnvironment = process.env,
): Readonly<{ seed?: number; path?: string }> {
  const rawSeed = environment.WRENCH_PROPERTY_SEED;
  const rawPath = environment.WRENCH_PROPERTY_PATH;
  if (rawSeed === undefined && rawPath === undefined) return Object.freeze({});
  if (rawSeed === undefined) {
    throw new Error(
      "WRENCH_PROPERTY_PATH requires WRENCH_PROPERTY_SEED",
    );
  }
  if (
    typeof rawSeed !== "string"
    || !/^-?(?:0|[1-9]\d{0,9})$/u.test(rawSeed)
  ) {
    throw new Error("WRENCH_PROPERTY_SEED must be a canonical 32-bit integer");
  }
  const seed = Number(rawSeed);
  if (
    !Number.isSafeInteger(seed)
    || Object.is(seed, -0)
    || seed < MIN_FAST_CHECK_SEED
    || seed > MAX_FAST_CHECK_SEED
  ) {
    throw new Error("WRENCH_PROPERTY_SEED must be a canonical 32-bit integer");
  }
  if (rawPath === undefined) return Object.freeze({ seed });
  if (
    typeof rawPath !== "string"
    || Buffer.byteLength(rawPath, "utf8") > MAX_FAST_CHECK_PATH_BYTES
    || !isComputationallyBoundedFastCheckPath(rawPath)
  ) {
    throw new Error("WRENCH_PROPERTY_PATH must be a bounded fast-check path");
  }
  return Object.freeze({ seed, path: rawPath });
}

export const propertyParameters = {
  numRuns: 200,
  interruptAfterTimeLimit: 10_000,
  markInterruptAsFailure: true,
  ...propertyReplayParameters(),
} satisfies Parameters<unknown>;

/** Run a synchronous property with the repository defaults and native replay output. */
export function assertProperty<Values>(
  property: IProperty<Values>,
  overrides: Parameters<Values> = {},
): void {
  fc.assert(property, { ...propertyParameters, ...overrides });
}

/** Run an asynchronous property with the same bounded repository defaults. */
export async function assertAsyncProperty<Values>(
  property: IAsyncProperty<Values>,
  overrides: Parameters<Values> = {},
): Promise<void> {
  await fc.assert(property, { ...propertyParameters, ...overrides });
}
