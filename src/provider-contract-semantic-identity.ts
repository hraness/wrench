import { createHash } from "node:crypto";

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("provider plugin semantic identity contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("provider plugin semantic identity contains an unsupported value");
}

/**
 * Hash an exact provider-owned contract projection. Functions are deliberately
 * excluded: shared planners are implementation sources, while provider-local
 * validators are declared as provider-specific implementation sources.
 */
export function contractSemanticIdentity(
  contracts: readonly object[],
): string {
  const ordered = [...contracts].sort((left, right) => {
    const leftRecord = left as Readonly<Record<string, unknown>>;
    const rightRecord = right as Readonly<Record<string, unknown>>;
    const leftKey = `${String(leftRecord.provider ?? leftRecord.site)}/${String(leftRecord.operation)}@${String(leftRecord.contractVersion)}`;
    const rightKey = `${String(rightRecord.provider ?? rightRecord.site)}/${String(rightRecord.operation)}@${String(rightRecord.contractVersion)}`;
    return leftKey.localeCompare(rightKey);
  });
  return createHash("sha256").update(stableJson(ordered)).digest("hex");
}

export function assertContractSemanticIdentity(
  owner: string,
  contracts: readonly object[],
  expected: string,
): void {
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error(`${owner} contract semantic identity must be a lowercase SHA-256 digest`);
  }
  const actual = contractSemanticIdentity(contracts);
  if (actual !== expected) {
    throw new Error(
      `${owner} contract semantics changed: expected ${expected}, received ${actual}`,
    );
  }
}
