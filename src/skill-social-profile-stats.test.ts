import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateOperationInput } from "./model";
import {
  type WebSessionContract,
  webSessionContractDefinitions,
} from "./web-session-contract-definitions";

type Authority =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "auth"; authId: string }>;

type ExpectedGap = Readonly<{
  metricKey: string;
  reason: "not-authorized";
  until: "account-eligible";
}>;

type CollectionRead = Readonly<{
  adapter: string;
  operation: string;
  authority: Authority;
  input: Readonly<Record<string, unknown>>;
  expectedOutput: Readonly<{ provider: string; targetUrl: string }>;
  metricKeys: readonly string[];
  expectedCategoricalGaps: readonly ExpectedGap[];
  requiredDelayBeforeMs: number;
  semantics: Readonly<{
    state: "observed";
    risk: "R1";
    sideEffect: "none";
  }>;
}>;

type CollectionAccount = Readonly<{
  accountKey: string;
  reads: readonly CollectionRead[];
}>;

type CollectionManifest = Readonly<{
  schemaVersion: 1;
  collectionKey: "hraness-social-profile-statistics";
  execution: Readonly<{
    order: "sequential";
    observationMode: "live-only";
  }>;
  accounts: readonly CollectionAccount[];
}>;

const skillRoot = join(import.meta.dir, "..", "skills", "wrench");
const manifestPath = join(
  skillRoot,
  "references",
  "hraness-social-profile-stats.json",
);
const referencePath = join(skillRoot, "references", "social-profile-stats.md");
const currentPublicOperationCoordinates = new Set([
  "bluesky/profiles.read",
  "github/organizations.read",
  "github/profiles.read",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return value;
}

function kebabIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded kebab-case identifier`);
  }
  return value;
}

function jsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 8) throw new Error(`${label} exceeds the JSON depth bound`);
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    if (value.length > 32) throw new Error(`${label} exceeds the JSON array bound`);
    value.forEach((item, index) => jsonValue(item, `${label}[${String(index)}]`, depth + 1));
    return;
  }
  const object = record(value, label);
  if (Object.keys(object).length > 32) {
    throw new Error(`${label} exceeds the JSON object bound`);
  }
  for (const [key, item] of Object.entries(object)) {
    if (key.length < 1 || key.length > 128 || /[\0\r\n]/u.test(key)) {
      throw new Error(`${label} has an invalid JSON key`);
    }
    jsonValue(item, `${label}.${key}`, depth + 1);
  }
}

function stringArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must be a bounded non-empty array`);
  }
  const parsed = value.map((item, index) => identifier(item, `${label}[${String(index)}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return Object.freeze(parsed);
}

function parseAuthority(value: unknown, label: string): Authority {
  const source = record(value, label);
  if (source.kind === "public") {
    exactKeys(source, ["kind"], label);
    return Object.freeze({ kind: "public" });
  }
  if (source.kind === "auth") {
    exactKeys(source, ["kind", "authId"], label);
    return Object.freeze({
      kind: "auth",
      authId: kebabIdentifier(source.authId, `${label}.authId`),
    });
  }
  throw new Error(`${label}.kind must be public or auth`);
}

function parseExpectedOutput(
  value: unknown,
  label: string,
): CollectionRead["expectedOutput"] {
  const source = record(value, label);
  exactKeys(source, ["provider", "targetUrl"], label);
  const provider = kebabIdentifier(source.provider, `${label}.provider`);
  if (typeof source.targetUrl !== "string" || source.targetUrl.length > 2_048) {
    throw new Error(`${label}.targetUrl must be a bounded HTTPS URL`);
  }
  let target: URL;
  try {
    target = new URL(source.targetUrl);
  } catch {
    throw new Error(`${label}.targetUrl must be a bounded HTTPS URL`);
  }
  if (
    target.protocol !== "https:"
    || target.username !== ""
    || target.password !== ""
    || target.search !== ""
    || target.hash !== ""
    || target.href !== source.targetUrl
  ) {
    throw new Error(`${label}.targetUrl must be a credential-free canonical HTTPS URL`);
  }
  return Object.freeze({ provider, targetUrl: source.targetUrl });
}

function parseSemantics(
  value: unknown,
  label: string,
): CollectionRead["semantics"] {
  const source = record(value, label);
  exactKeys(source, ["state", "risk", "sideEffect"], label);
  if (
    source.state !== "observed"
    || source.risk !== "R1"
    || source.sideEffect !== "none"
  ) {
    throw new Error(`${label} must be observed R1 with no side effect`);
  }
  return Object.freeze({ state: "observed", risk: "R1", sideEffect: "none" });
}

function parseGaps(
  value: unknown,
  metricKeys: readonly string[],
  label: string,
): readonly ExpectedGap[] {
  if (!Array.isArray(value) || value.length > metricKeys.length) {
    throw new Error(`${label} must be a bounded array`);
  }
  const gaps = value.map((item, index) => {
    const gapLabel = `${label}[${String(index)}]`;
    const source = record(item, gapLabel);
    exactKeys(source, ["metricKey", "reason", "until"], gapLabel);
    const metricKey = identifier(source.metricKey, `${gapLabel}.metricKey`);
    if (
      !metricKeys.includes(metricKey)
      || source.reason !== "not-authorized"
      || source.until !== "account-eligible"
    ) {
      throw new Error(
        `${gapLabel} must bind one not-authorized metric until account eligibility`,
      );
    }
    return Object.freeze({
      metricKey,
      reason: "not-authorized" as const,
      until: "account-eligible" as const,
    });
  });
  if (new Set(gaps.map((gap) => gap.metricKey)).size !== gaps.length) {
    throw new Error(`${label} must not contain duplicate metric keys`);
  }
  return Object.freeze(gaps);
}

function parseRead(value: unknown, label: string): CollectionRead {
  const source = record(value, label);
  exactKeys(source, [
    "adapter",
    "operation",
    "authority",
    "input",
    "expectedOutput",
    "metricKeys",
    "expectedCategoricalGaps",
    "requiredDelayBeforeMs",
    "semantics",
  ], label);
  const input = record(source.input, `${label}.input`);
  jsonValue(input, `${label}.input`);
  if (Object.keys(input).length === 0) throw new Error(`${label}.input must not be empty`);
  const metricKeys = stringArray(source.metricKeys, `${label}.metricKeys`, 16);
  if (
    !Number.isSafeInteger(source.requiredDelayBeforeMs)
    || (source.requiredDelayBeforeMs as number) < 0
    || (source.requiredDelayBeforeMs as number) > 300_000
  ) throw new Error(`${label}.requiredDelayBeforeMs must be a bounded delay`);
  return Object.freeze({
    adapter: kebabIdentifier(source.adapter, `${label}.adapter`),
    operation: identifier(source.operation, `${label}.operation`),
    authority: parseAuthority(source.authority, `${label}.authority`),
    input: Object.freeze(input),
    expectedOutput: parseExpectedOutput(source.expectedOutput, `${label}.expectedOutput`),
    metricKeys,
    expectedCategoricalGaps: parseGaps(
      source.expectedCategoricalGaps,
      metricKeys,
      `${label}.expectedCategoricalGaps`,
    ),
    requiredDelayBeforeMs: source.requiredDelayBeforeMs as number,
    semantics: parseSemantics(source.semantics, `${label}.semantics`),
  });
}

function parseCollectionManifest(value: unknown): CollectionManifest {
  const source = record(value, "manifest");
  exactKeys(source, ["schemaVersion", "collectionKey", "execution", "accounts"], "manifest");
  if (source.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1");
  if (source.collectionKey !== "hraness-social-profile-statistics") {
    throw new Error("manifest.collectionKey is invalid");
  }
  const execution = record(source.execution, "manifest.execution");
  exactKeys(execution, ["order", "observationMode"], "manifest.execution");
  if (execution.order !== "sequential" || execution.observationMode !== "live-only") {
    throw new Error("manifest.execution must require sequential live observations");
  }
  if (!Array.isArray(source.accounts) || source.accounts.length < 1 || source.accounts.length > 64) {
    throw new Error("manifest.accounts must be a bounded non-empty array");
  }
  const accounts = source.accounts.map((item, accountIndex) => {
    const label = `manifest.accounts[${String(accountIndex)}]`;
    const account = record(item, label);
    exactKeys(account, ["accountKey", "reads"], label);
    const accountKey = kebabIdentifier(account.accountKey, `${label}.accountKey`);
    if (!Array.isArray(account.reads) || account.reads.length < 1 || account.reads.length > 4) {
      throw new Error(`${label}.reads must be a bounded non-empty array`);
    }
    const reads = account.reads.map((read, readIndex) =>
      parseRead(read, `${label}.reads[${String(readIndex)}]`)
    );
    const providers = new Set(reads.map((read) => read.expectedOutput.provider));
    if (providers.size !== 1) throw new Error(`${label}.reads must use one provider`);
    const metricKeys = reads.flatMap((read) => read.metricKeys);
    if (new Set(metricKeys).size !== metricKeys.length) {
      throw new Error(`${label}.reads must not overlap metric keys`);
    }
    return Object.freeze({ accountKey, reads: Object.freeze(reads) });
  });
  if (new Set(accounts.map((account) => account.accountKey)).size !== accounts.length) {
    throw new Error("manifest.accounts must not contain duplicate account keys");
  }
  return Object.freeze({
    schemaVersion: 1,
    collectionKey: "hraness-social-profile-statistics",
    execution: Object.freeze({ order: "sequential", observationMode: "live-only" }),
    accounts: Object.freeze(accounts),
  });
}

function readSourceManifest(): unknown {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
}

function mutableManifest(): Record<string, unknown> {
  return structuredClone(readSourceManifest()) as Record<string, unknown>;
}

function firstRead(value: Record<string, unknown>): Record<string, unknown> {
  const accounts = value.accounts as Record<string, unknown>[];
  return (accounts[0]!.reads as Record<string, unknown>[])[0]!;
}

function assertCurrentCatalogConformance(manifest: CollectionManifest): void {
  const definitions = webSessionContractDefinitions as unknown as Readonly<
    Record<string, Readonly<Record<string, WebSessionContract>>>
  >;
  for (const account of manifest.accounts) {
    for (const read of account.reads) {
      const expectedAdapter = `${read.expectedOutput.provider}-web`;
      const provider = definitions[read.expectedOutput.provider];
      if (read.adapter !== expectedAdapter || provider === undefined) {
        throw new Error(`adapter ${read.adapter} is not installed`);
      }
      const operation = provider[read.operation];
      if (operation === undefined) {
        throw new Error(`operation ${read.adapter} ${read.operation} is not installed`);
      }
      if (
        operation.state !== read.semantics.state
        || operation.risk !== read.semantics.risk
        || operation.sideEffect !== read.semantics.sideEffect
      ) {
        throw new Error(`operation ${read.adapter} ${read.operation} semantic contract drifted`);
      }
      const publicAccess = currentPublicOperationCoordinates.has(
        `${read.expectedOutput.provider}/${read.operation}`,
      );
      if (publicAccess !== (read.authority.kind === "public")) {
        throw new Error(`operation ${read.adapter} ${read.operation} authority drifted`);
      }
      const input = validateOperationInput(
        operation.input,
        read.input,
        [new URL(read.expectedOutput.targetUrl).origin],
      );
      if (!input.ok) {
        throw new Error(`operation ${read.adapter} ${read.operation} input drifted: ${input.issues.join("; ")}`);
      }
      if (operation.site !== read.expectedOutput.provider) {
        throw new Error(`operation ${read.adapter} ${read.operation} provider drifted`);
      }
    }
  }
}

describe("packaged Hraness social-profile collection contract", () => {
  test("strictly binds the current ordered accounts, targets, metrics, and gaps", () => {
    const manifest = parseCollectionManifest(readSourceManifest());
    expect(manifest.accounts.map((account) => account.accountKey)).toEqual([
      "x-hraness",
      "x-lifedaysleft",
      "linkedin-personal",
      "linkedin-company-hraness",
      "youtube-hraness",
      "twitch-hranessdotcom",
      "bluesky-hraness",
      "instagram-hraness",
      "threads-hraness",
      "substack-hraness",
      "github-0thernet",
      "github-hraness",
      "tiktok-hraness",
      "reddit-bgdotjpg",
    ]);

    const byKey = new Map(manifest.accounts.map((account) => [account.accountKey, account]));
    expect(byKey.get("x-lifedaysleft")?.reads[0]).toMatchObject({
      input: { handle: "lifedaysleft" },
      expectedOutput: { targetUrl: "https://x.com/lifedaysleft" },
    });
    expect(byKey.get("linkedin-company-hraness")?.reads[0]?.requiredDelayBeforeMs)
      .toBe(60_000);
    expect(byKey.get("twitch-hranessdotcom")?.reads[0]).toMatchObject({
      authority: { kind: "auth", authId: "twitch-chrome" },
      expectedOutput: { targetUrl: "https://www.twitch.tv/hranessdotcom" },
      metricKeys: ["followers"],
    });
    expect(byKey.get("github-0thernet")?.reads[0]).toMatchObject({
      operation: "profiles.read",
      input: { username: "0thernet" },
      metricKeys: ["followers", "following", "publicRepositories"],
    });
    expect(byKey.get("github-hraness")?.reads[0]).toMatchObject({
      operation: "organizations.read",
      authority: { kind: "public" },
      input: { organization: "hraness" },
      metricKeys: ["stars", "followers"],
    });
    expect(byKey.get("threads-hraness")?.reads[0]?.expectedCategoricalGaps).toEqual([
      {
        metricKey: "recentViews",
        reason: "not-authorized",
        until: "account-eligible",
      },
    ]);
    expect(readFileSync(manifestPath, "utf8")).not.toMatch(/hrawdog/iu);
  });

  test("conforms every declared read to the current bundled adapter contract", () => {
    expect(() => assertCurrentCatalogConformance(
      parseCollectionManifest(readSourceManifest()),
    )).not.toThrow();
  });

  test("rejects duplicate account keys and malformed extra fields", () => {
    const duplicate = mutableManifest();
    const duplicateAccounts = duplicate.accounts as Record<string, unknown>[];
    duplicateAccounts.push(structuredClone(duplicateAccounts[0]!));
    expect(() => parseCollectionManifest(duplicate)).toThrow("duplicate account keys");

    const extra = mutableManifest();
    firstRead(extra).rawResponse = true;
    expect(() => parseCollectionManifest(extra)).toThrow("must contain exactly");
  });

  test("rejects non-R1, mutating, and capture-required semantics", () => {
    for (const [field, value] of [
      ["risk", "R2"],
      ["sideEffect", "changes remote state"],
      ["state", "capture-required"],
    ] as const) {
      const candidate = mutableManifest();
      const semantics = firstRead(candidate).semantics as Record<string, unknown>;
      semantics[field] = value;
      expect(() => parseCollectionManifest(candidate)).toThrow(
        "must be observed R1 with no side effect",
      );
    }
  });

  test("rejects missing and uninstalled adapters or operations", () => {
    for (const field of ["adapter", "operation"] as const) {
      const missing = mutableManifest();
      delete firstRead(missing)[field];
      expect(() => parseCollectionManifest(missing)).toThrow("must contain exactly");
    }

    const badAdapter = mutableManifest();
    firstRead(badAdapter).adapter = "missing-web";
    expect(() => assertCurrentCatalogConformance(parseCollectionManifest(badAdapter))).toThrow(
      "adapter missing-web is not installed",
    );

    const badOperation = mutableManifest();
    firstRead(badOperation).operation = "missing.read";
    expect(() => assertCurrentCatalogConformance(parseCollectionManifest(badOperation))).toThrow(
      "operation x-web missing.read is not installed",
    );
  });

  test("keeps the prose and package boundary aligned with the authoritative JSON", () => {
    const manifest = parseCollectionManifest(readSourceManifest());
    const byKey = new Map(manifest.accounts.map((account) => [account.accountKey, account]));
    const lifeDaysLeft = byKey.get("x-lifedaysleft")?.reads[0];
    const linkedInCompany = byKey.get("linkedin-company-hraness")?.reads[0];
    const threads = byKey.get("threads-hraness")?.reads[0];
    const reference = readFileSync(referencePath, "utf8");
    expect(reference).toContain("[Hraness social-profile manifest](hraness-social-profile-stats.json)");
    expect(reference).toContain(`\`${byKey.get("x-lifedaysleft")?.accountKey}\``);
    expect(reference).toContain(`second exact handle is \`${String(lifeDaysLeft?.input.handle)}\``);
    expect(reference).toContain(
      `${String((linkedInCompany?.requiredDelayBeforeMs ?? 0) / 1_000)}-second idle interval`,
    );
    expect(reference).toContain(
      `Threads \`${threads?.expectedCategoricalGaps[0]?.metricKey}\``,
    );
    expect(reference).toContain(
      `\`${threads?.expectedCategoricalGaps[0]?.reason}\``,
    );
    expect(reference).toContain("until the account becomes\neligible");
    expect(reference).not.toMatch(/hrawdog/iu);
    expect(existsSync(manifestPath)).toBeTrue();

    const packageManifest = record(
      JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as unknown,
      "package.json",
    );
    expect(packageManifest.files).toBeArray();
    expect(packageManifest.files as unknown[]).toContain("skills");
    expect(packageManifest.files as unknown[]).toContain("src/providers/read-failure.ts");
  });
});
