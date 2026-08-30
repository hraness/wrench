import { describe, expect, test } from "bun:test";

import { assertProperty, fc } from "./test-support";
import {
  defineLocalCliSurfaceContractV1,
  parseLocalCliSurfaceContractV1,
  type LocalCliSurfaceContractDefinitionV1,
  type LocalCliSurfaceDecisionV1,
} from "./local-cli-surface-contract";

const digest = (character: string): string => character.repeat(64);
const unsupported = Object.freeze({
  disposition: "unsupported" as const,
  rationale: "The provider does not grant this authority.",
  operation: null,
  replacement: null,
  fixedValue: null,
});
const supported = Object.freeze({
  disposition: "supported" as const,
  rationale: "One bounded semantic read exposes this feature.",
  operation: "items.list",
  replacement: null,
  fixedValue: null,
});

function definition(): LocalCliSurfaceContractDefinitionV1 {
  return {
    schemaVersion: 1,
    format: "wrench.local-cli-surface",
    surface: "example",
    executable: {
      id: "example-cli",
      implementation: "github.com/example/cli",
      releaseVersion: "1.2.3",
      releaseDate: "2026-05-18",
      releaseTag: "v1.2.3",
      releaseCommit: "a".repeat(40),
      releaseManifestSha256: digest("b"),
      runtimeReportedName: "@example/cli",
      runtimeReportedVersion: "1.2.3",
      artifacts: [{
        platform: "darwin",
        arch: "arm64",
        archiveSha256: digest("c"),
        executableSha256: digest("d"),
      }],
    },
    source: {
      package: "@example/cli",
      packagePath: "packages/cli/package.json",
      packageDeclaredVersion: "1.2.2",
      versionDiscrepancy: "The release runtime reports 1.2.3 while tagged source declares 1.2.2.",
      generatedManualSha256: digest("e"),
      generatedManualIncludesFlagsAndDefaults: false,
      generatedManualEntries: 1,
      generatedCanonicalEntries: 1,
      registeredKeys: 2,
    },
    sdk: {
      package: "@example/sdk",
      version: "4.5.6",
      commit: "f".repeat(40),
    },
    runtime: {
      providerPluginId: "example-local",
      providerPluginVersion: "1.0.0",
      adapterId: "example",
      adapterVersion: "1.0.0",
      operationContractVersions: { "items.list": 1 },
      operationInputTypes: { "items.list": { limit: "number" } },
      target: "desktop",
      realm: "One exact local realm.",
      compatibility: "Only the reviewed runtime identity is accepted.",
    },
    globalFlags: [{
      name: "--json",
      aliases: [],
      source: "global",
      valueType: "boolean",
      allowNo: false,
      required: false,
      multiple: false,
      enum: [],
      default: { kind: "literal", value: false, authority: "tagged-source" },
      decision: {
        disposition: "fixed",
        rationale: "The provider always requests structured output.",
        operation: null,
        replacement: null,
        fixedValue: true,
      },
    }],
    commands: [{
      path: ["items", "list"],
      provenance: "built-in-canonical",
      profileAuthority: "tagged-source",
      package: "@example/cli",
      version: "1.2.2",
      versionKind: "exact",
      registered: true,
      publicManual: true,
      generatedCanonical: true,
      upstreamReportedMutates: false,
      reviewedEffect: "read",
      arguments: [],
      flags: [{
        name: "--limit",
        aliases: ["-l"],
        source: "command",
        valueType: "number",
        allowNo: false,
        required: false,
        multiple: false,
        enum: [],
        default: { kind: "literal", value: 50, authority: "tagged-source" },
        decision: supported,
      }],
      decision: supported,
      output: {
        shape: "A bounded normalized item page.",
        completeness: "bounded",
        maxBytes: 1_048_576,
        privateArtifact: false,
        truncation: "The page reports its continuation cursor.",
      },
      conditionalInputs: [],
      reconciliation: {
        availability: "none",
        namespace: null,
        predicate: null,
        rationale: "Reads do not require mutation reconciliation.",
      },
    }],
    additionalEntries: [{
      path: ["items"],
      provenance: "built-in-alias",
      profileAuthority: "tagged-source",
      canonicalTarget: ["items", "list"],
      package: "@example/cli",
      version: "1.2.2",
      versionKind: "exact",
      registered: true,
      publicManual: false,
      rationale: "This generated registration aliases the canonical list command.",
      decision: unsupported,
    }],
  };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [
    key,
    reverseKeys(item),
  ]));
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function mutableArray(value: unknown): unknown[] {
  return value as unknown[];
}

function firstCommand(value: LocalCliSurfaceContractDefinitionV1): Record<string, unknown> {
  return mutableRecord(mutableArray(mutableRecord(value).commands)[0]);
}

function firstCommandFlag(value: LocalCliSurfaceContractDefinitionV1): Record<string, unknown> {
  return mutableRecord(mutableArray(firstCommand(value).flags)[0]);
}

describe("provider-neutral local CLI surface contract", () => {
  test("canonicalizes key order and round trips all four digests", () => {
    const baseline = defineLocalCliSurfaceContractV1(definition());
    const reordered = defineLocalCliSurfaceContractV1(
      reverseKeys(definition()) as LocalCliSurfaceContractDefinitionV1,
    );

    expect(reordered).toEqual(baseline);
    expect(parseLocalCliSurfaceContractV1(structuredClone(baseline))).toEqual(baseline);
    expect(Object.values(baseline.digests).every((value) => /^[a-f0-9]{64}$/u.test(value)))
      .toBeTrue();
    expect(Object.isFrozen(baseline.commands[0])).toBeTrue();
  });

  test("does not depend on host localeCompare and accepts Unicode evidence text", () => {
    const source = definition();
    firstCommand(source).decision = {
      ...supported,
      rationale: "Évidence canonique indépendante de la locale.",
    };
    const baseline = defineLocalCliSurfaceContractV1(source);
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "localeCompare")!;
    Object.defineProperty(String.prototype, "localeCompare", {
      ...descriptor,
      value: () => {
        throw new Error("surface digest must not call localeCompare");
      },
    });
    try {
      expect(defineLocalCliSurfaceContractV1(reverseKeys(source) as LocalCliSurfaceContractDefinitionV1).digests)
        .toEqual(baseline.digests);
    } finally {
      Object.defineProperty(String.prototype, "localeCompare", descriptor);
    }
  });

  test("normalizes and digest-binds exact per-operation contract versions", () => {
    const source = definition();
    (source.runtime as unknown as {
      operationContractVersions: Readonly<Record<string, number>>;
    }).operationContractVersions = {
      "items.read": 3,
      "items.list": 2,
    };
    (source.runtime as unknown as {
      operationInputTypes: Readonly<Record<string, Readonly<Record<string, "number">>>>;
    }).operationInputTypes = {
      "items.read": {},
      "items.list": { limit: "number" },
    };
    const contract = defineLocalCliSurfaceContractV1(source);
    expect(Object.keys(contract.runtime.operationContractVersions)).toEqual([
      "items.list",
      "items.read",
    ]);
    expect(contract.runtime.operationContractVersions).toEqual({
      "items.list": 2,
      "items.read": 3,
    });

    const changed = definition();
    (changed.runtime as unknown as {
      operationContractVersions: Readonly<Record<string, number>>;
    }).operationContractVersions = { "items.list": 2 };
    expect(defineLocalCliSurfaceContractV1(changed).digests.classificationSha256)
      .not.toBe(defineLocalCliSurfaceContractV1(definition()).digests.classificationSha256);
  });

  test("keeps the digest invariant for every top-level key permutation", () => {
    const source = definition();
    const keys = Object.keys(source) as (keyof LocalCliSurfaceContractDefinitionV1)[];
    const baseline = defineLocalCliSurfaceContractV1(source);
    assertProperty(fc.property(
      fc.shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length }),
      (order) => {
        const permuted = Object.fromEntries(order.map((key) => [key, source[key]]));
        expect(defineLocalCliSurfaceContractV1(
          permuted as LocalCliSurfaceContractDefinitionV1,
        ).digests).toEqual(baseline.digests);
      },
    ));
  });

  test("makes one default or disposition change digest-sensitive", () => {
    const baseline = defineLocalCliSurfaceContractV1(definition());
    const changedDefault = definition();
    (changedDefault.commands[0]!.flags[0]! as unknown as {
      default: { kind: "literal"; value: number; authority: "tagged-source" };
    }).default = { kind: "literal", value: 51, authority: "tagged-source" };
    const defaultContract = defineLocalCliSurfaceContractV1(changedDefault);
    expect(defaultContract.commands[0]!.semanticProfileSha256)
      .not.toBe(baseline.commands[0]!.semanticProfileSha256);
    expect(defaultContract.digests.upstreamSurfaceSha256)
      .not.toBe(baseline.digests.upstreamSurfaceSha256);
    expect(defaultContract.digests.semanticProfilesSha256)
      .not.toBe(baseline.digests.semanticProfilesSha256);
    expect(defaultContract.digests.wholeSurfaceSha256)
      .not.toBe(baseline.digests.wholeSurfaceSha256);

    const changedDisposition = definition();
    (changedDisposition.commands[0]!.flags[0]! as unknown as {
      decision: LocalCliSurfaceDecisionV1;
    }).decision = {
      disposition: "absorbed",
      rationale: "The semantic operation has one canonical presentation order.",
      operation: "items.list",
      replacement: null,
      fixedValue: null,
    };
    expect(defineLocalCliSurfaceContractV1(changedDisposition).digests.classificationSha256)
      .not.toBe(baseline.digests.classificationSha256);
  });

  test("keeps upstream identity separate from Wrench-reviewed effect classification", () => {
    const baseline = defineLocalCliSurfaceContractV1(definition());
    const changed = definition();
    (changed.commands[0]! as unknown as {
      reviewedEffect: "read" | "write" | "input-dependent";
    }).reviewedEffect = "write";
    const classified = defineLocalCliSurfaceContractV1(changed);
    expect(classified.digests.upstreamSurfaceSha256)
      .toBe(baseline.digests.upstreamSurfaceSha256);
    expect(classified.digests.classificationSha256)
      .not.toBe(baseline.digests.classificationSha256);
    expect(classified.digests.semanticProfilesSha256)
      .not.toBe(baseline.digests.semanticProfilesSha256);
    expect(classified.digests.wholeSurfaceSha256)
      .not.toBe(baseline.digests.wholeSurfaceSha256);
  });

  test("keeps Wrench rationale and source discrepancy prose out of the upstream digest", () => {
    const baseline = defineLocalCliSurfaceContractV1(definition());
    const changed = definition();
    mutableRecord(changed.source).versionDiscrepancy =
      "The reviewed source metadata differs from the executable release identity.";
    firstCommand(changed).decision = {
      ...supported,
      rationale: "A differently worded Wrench classification rationale.",
    };
    const contract = defineLocalCliSurfaceContractV1(changed);
    expect(contract.digests.upstreamSurfaceSha256).toBe(baseline.digests.upstreamSurfaceSha256);
    expect(contract.digests.classificationSha256).not.toBe(baseline.digests.classificationSha256);
    expect(contract.digests.wholeSurfaceSha256).not.toBe(baseline.digests.wholeSurfaceSha256);
  });

  test("round trips positional argument enums and digest-binds their exact options", () => {
    const source = definition();
    firstCommand(source).arguments = [{
      name: "kind",
      position: 0,
      required: true,
      multiple: false,
      valueType: "string",
      enum: ["alpha", "beta"],
      default: { kind: "none" },
      decision: supported,
    }];
    const baseline = defineLocalCliSurfaceContractV1(source);
    expect(baseline.commands[0]?.arguments[0]?.enum).toEqual(["alpha", "beta"]);
    expect(parseLocalCliSurfaceContractV1(structuredClone(baseline))).toEqual(baseline);

    const changed = structuredClone(source);
    mutableRecord(mutableArray(firstCommand(changed).arguments)[0]).enum = ["alpha", "gamma"];
    expect(defineLocalCliSurfaceContractV1(changed).commands[0]?.semanticProfileSha256)
      .not.toBe(baseline.commands[0]?.semanticProfileSha256);
  });

  test("rejects invalid dates and inconsistent release/source version provenance", () => {
    for (const invalid of ["2026-13-01", "2026-02-30", "May 18, 2026"]) {
      const source = definition();
      mutableRecord(source.executable).releaseDate = invalid;
      expect(() => defineLocalCliSurfaceContractV1(source)).toThrow("canonical YYYY-MM-DD");
    }
    const runtimeMismatch = definition();
    mutableRecord(runtimeMismatch.executable).runtimeReportedVersion = "1.2.4";
    expect(() => defineLocalCliSurfaceContractV1(runtimeMismatch)).toThrow("must match");

    const missingDiscrepancy = definition();
    mutableRecord(missingDiscrepancy.source).versionDiscrepancy = null;
    expect(() => defineLocalCliSurfaceContractV1(missingDiscrepancy)).toThrow("must exactly match");

    const spuriousDiscrepancy = definition();
    mutableRecord(spuriousDiscrepancy.source).packageDeclaredVersion = "1.2.3";
    firstCommand(spuriousDiscrepancy).version = "1.2.3";
    mutableRecord(mutableArray(mutableRecord(spuriousDiscrepancy).additionalEntries)[0]).version =
      "1.2.3";
    expect(() => defineLocalCliSurfaceContractV1(spuriousDiscrepancy)).toThrow("must exactly match");
  });

  test("rejects enum/default/fixed-value type and membership contradictions", () => {
    const enumOnNumber = definition();
    firstCommandFlag(enumOnNumber).enum = ["50"];
    expect(() => defineLocalCliSurfaceContractV1(enumOnNumber)).toThrow("enum requires a string flag");

    const defaultType = definition();
    firstCommandFlag(defaultType).default = {
      kind: "literal", value: "50", authority: "tagged-source",
    };
    expect(() => defineLocalCliSurfaceContractV1(defaultType)).toThrow("default must match");

    const literalNull = definition();
    firstCommandFlag(literalNull).default = {
      kind: "literal", value: null, authority: "tagged-source",
    };
    expect(() => defineLocalCliSurfaceContractV1(literalNull)).toThrow("literal null");

    const negativeZero = definition();
    firstCommandFlag(negativeZero).default = {
      kind: "literal", value: -0, authority: "tagged-source",
    };
    expect(() => defineLocalCliSurfaceContractV1(negativeZero)).toThrow("finite JSON scalar");

    const fixedNull = definition();
    mutableRecord(mutableArray(mutableRecord(fixedNull).globalFlags)[0]).decision = {
      ...mutableRecord(mutableRecord(mutableArray(mutableRecord(fixedNull).globalFlags)[0]).decision),
      fixedValue: null,
    };
    expect(() => defineLocalCliSurfaceContractV1(fixedNull)).toThrow("fixedValue is required");

    const fixedWrongType = definition();
    mutableRecord(mutableArray(mutableRecord(fixedWrongType).globalFlags)[0]).decision = {
      ...mutableRecord(mutableRecord(mutableArray(mutableRecord(fixedWrongType).globalFlags)[0]).decision),
      fixedValue: "true",
    };
    expect(() => defineLocalCliSurfaceContractV1(fixedWrongType)).toThrow("fixedValue must match");

    const defaultOutsideEnum = definition();
    firstCommandFlag(defaultOutsideEnum).valueType = "string";
    firstCommandFlag(defaultOutsideEnum).enum = ["stable", "nightly"];
    firstCommandFlag(defaultOutsideEnum).default = {
      kind: "literal", value: "beta", authority: "tagged-source",
    };
    firstCommandFlag(defaultOutsideEnum).decision = supported;
    expect(() => defineLocalCliSurfaceContractV1(defaultOutsideEnum)).toThrow("default must belong");

    const fixedOutsideEnum = definition();
    firstCommandFlag(fixedOutsideEnum).valueType = "string";
    firstCommandFlag(fixedOutsideEnum).enum = ["stable", "nightly"];
    firstCommandFlag(fixedOutsideEnum).default = { kind: "none" };
    firstCommandFlag(fixedOutsideEnum).decision = {
      disposition: "fixed",
      rationale: "One exact channel is fixed.",
      operation: null,
      replacement: null,
      fixedValue: "beta",
    };
    expect(() => defineLocalCliSurfaceContractV1(fixedOutsideEnum)).toThrow("fixedValue must belong");
  });

  test("rejects source scope, allowNo, duplicate spelling, counts, and alias contradictions", () => {
    const commandSource = definition();
    firstCommandFlag(commandSource).source = "global";
    expect(() => defineLocalCliSurfaceContractV1(commandSource)).toThrow("must be command flags");

    const globalSource = definition();
    mutableRecord(mutableArray(mutableRecord(globalSource).globalFlags)[0]).source = "command";
    expect(() => defineLocalCliSurfaceContractV1(globalSource)).toThrow("unique global flags");

    const allowNoNumber = definition();
    firstCommandFlag(allowNoNumber).allowNo = true;
    expect(() => defineLocalCliSurfaceContractV1(allowNoNumber)).toThrow("requires a boolean flag");

    const taggedDefaultWithJitAuthority = definition();
    mutableRecord(firstCommandFlag(taggedDefaultWithJitAuthority).default).authority =
      "jit-plugin-source";
    expect(() => defineLocalCliSurfaceContractV1(taggedDefaultWithJitAuthority))
      .toThrow("tagged command literal default has inconsistent authority");

    const jitDefaultWithTaggedAuthority = definition();
    const jitCommand = firstCommand(jitDefaultWithTaggedAuthority);
    jitCommand.provenance = "jit-plugin";
    jitCommand.profileAuthority = "jit-plugin-source";
    jitCommand.package = "@example/cli-plugin";
    jitCommand.version = "^1.0.0";
    jitCommand.versionKind = "range";
    expect(() => defineLocalCliSurfaceContractV1(jitDefaultWithTaggedAuthority))
      .toThrow("JIT command literal default has inconsistent authority");

    const duplicateLong = definition();
    firstCommand(duplicateLong).flags = [
      ...mutableArray(firstCommand(duplicateLong).flags),
      structuredClone(mutableArray(firstCommand(duplicateLong).flags)[0]),
    ];
    expect(() => defineLocalCliSurfaceContractV1(duplicateLong)).toThrow("repeat a long name");

    const shortShadow = definition();
    mutableRecord(mutableArray(mutableRecord(shortShadow).globalFlags)[0]).aliases = ["-l"];
    expect(() => defineLocalCliSurfaceContractV1(shortShadow)).toThrow("shadows a global short alias");

    const negatedCollision = definition();
    const enabled = {
      ...firstCommandFlag(negatedCollision),
      name: "--enabled",
      aliases: [],
      valueType: "boolean",
      allowNo: true,
      default: { kind: "literal", value: false, authority: "tagged-source" },
    };
    firstCommand(negatedCollision).flags = [
      enabled,
      { ...enabled, name: "--no-enabled", allowNo: false },
    ];
    expect(() => defineLocalCliSurfaceContractV1(negatedCollision)).toThrow("repeats a flag spelling");

    const wrongCount = definition();
    mutableRecord(wrongCount.source).generatedManualEntries = 2;
    expect(() => defineLocalCliSurfaceContractV1(wrongCount)).toThrow("counts do not match");

    const danglingTarget = definition();
    mutableRecord(mutableArray(mutableRecord(danglingTarget).additionalEntries)[0]).canonicalTarget = ["missing"];
    expect(() => defineLocalCliSurfaceContractV1(danglingTarget)).toThrow("dangling canonical target");

    const selfCycle = definition();
    mutableRecord(mutableArray(mutableRecord(selfCycle).additionalEntries)[0]).canonicalTarget = ["items"];
    expect(() => defineLocalCliSurfaceContractV1(selfCycle)).toThrow("alias cycle");

    const twoEntryCycle = definition();
    const entries = mutableArray(mutableRecord(twoEntryCycle).additionalEntries);
    mutableRecord(entries[0]).canonicalTarget = ["things"];
    entries.push({
      ...structuredClone(mutableRecord(entries[0])),
      path: ["things"],
      canonicalTarget: ["items"],
    });
    expect(() => defineLocalCliSurfaceContractV1(twoEntryCycle)).toThrow("alias cycle");
  });

  test("rejects malformed provider operations and unknown or mistyped predicate fields", () => {
    for (const operation of ["items.-list", `${"a".repeat(41)}.list`, "items.list.extra.more.too-many"]) {
      const source = definition();
      mutableRecord(source.runtime).operationContractVersions = { [operation]: 1 };
      mutableRecord(source.runtime).operationInputTypes = { [operation]: { limit: "number" } };
      expect(() => defineLocalCliSurfaceContractV1(source)).toThrow("bounded semantic name");
    }
    const malformedDecision = definition();
    firstCommand(malformedDecision).decision = {
      ...supported,
      operation: "items.-list",
    };
    expect(() => defineLocalCliSurfaceContractV1(malformedDecision))
      .toThrow("must be a semantic operation name");

    const unknownField = definition();
    firstCommand(unknownField).conditionalInputs = [{
      namespace: "semantic-operation",
      when: { op: "present", field: "typo" },
      require: [], requireAny: [], exactlyOne: [], forbid: [],
      rationale: "A strict field reference.",
    }];
    expect(() => defineLocalCliSurfaceContractV1(unknownField)).toThrow("unknown semantic-operation field typo");

    const wrongType = definition();
    firstCommand(wrongType).conditionalInputs = [{
      namespace: "semantic-operation",
      when: { op: "eq", field: "limit", value: false },
      require: [], requireAny: [], exactlyOne: [], forbid: [],
      rationale: "A typed equality predicate.",
    }];
    expect(() => defineLocalCliSurfaceContractV1(wrongType)).toThrow("equality value does not match");

    const typoReconciliation = definition();
    firstCommand(typoReconciliation).reconciliation = {
      availability: "input-dependent",
      namespace: "semantic-operation",
      predicate: { op: "present", field: "missing" },
      rationale: "Only a declared input can select reconciliation.",
    };
    expect(() => defineLocalCliSurfaceContractV1(typoReconciliation)).toThrow("unknown semantic field missing");
  });

  test("bounds predicate identity, depth, and whole-contract node traversal", () => {
    const selfCycle = definition();
    const cyclic: Record<string, unknown> = { op: "not" };
    cyclic.predicate = cyclic;
    firstCommand(selfCycle).conditionalInputs = [{
      namespace: "semantic-operation", when: cyclic,
      require: [], requireAny: [], exactlyOne: [], forbid: [], rationale: "Cycle probe.",
    }];
    expect(() => defineLocalCliSurfaceContractV1(selfCycle)).toThrow("repeats a predicate object identity");

    const sharedIdentity = definition();
    const shared = { op: "present", field: "limit" };
    firstCommand(sharedIdentity).conditionalInputs = [{
      namespace: "semantic-operation", when: { op: "and", predicates: [shared, shared] },
      require: [], requireAny: [], exactlyOne: [], forbid: [], rationale: "Shared identity probe.",
    }];
    expect(() => defineLocalCliSurfaceContractV1(sharedIdentity)).toThrow("repeats a predicate object identity");

    const tooDeep = definition();
    let deep: Record<string, unknown> = { op: "true" };
    for (let index = 0; index < 9; index += 1) deep = { op: "not", predicate: deep };
    firstCommand(tooDeep).conditionalInputs = [{
      namespace: "semantic-operation", when: deep,
      require: [], requireAny: [], exactlyOne: [], forbid: [], rationale: "Depth probe.",
    }];
    expect(() => defineLocalCliSurfaceContractV1(tooDeep)).toThrow("predicate depth bound");

    const tooMany = definition();
    const broad = (depth: number): Record<string, unknown> => depth === 0
      ? { op: "true" }
      : { op: "and", predicates: Array.from({ length: 22 }, () => broad(depth - 1)) };
    firstCommand(tooMany).conditionalInputs = [{
      namespace: "semantic-operation", when: broad(3),
      require: [], requireAny: [], exactlyOne: [], forbid: [], rationale: "Node budget probe.",
    }];
    expect(() => defineLocalCliSurfaceContractV1(tooMany)).toThrow("whole-contract node bound");
  });

  test("makes every generated single-field default change digest-sensitive", () => {
    const baseline = defineLocalCliSurfaceContractV1(definition());
    assertProperty(fc.property(
      fc.integer({ min: 1, max: 1_000 }).filter((value) => value !== 50),
      (value) => {
        const changed = definition();
        (changed.commands[0]!.flags[0]! as unknown as {
          default: { kind: "literal"; value: number; authority: "tagged-source" };
        }).default = { kind: "literal", value, authority: "tagged-source" };
        const contract = defineLocalCliSurfaceContractV1(changed);
        expect(contract.commands[0]!.semanticProfileSha256)
          .not.toBe(baseline.commands[0]!.semanticProfileSha256);
      },
    ));
  });

  test("rejects extras, proxies, accessors, non-finite values, and malformed Unicode", () => {
    expect(() => defineLocalCliSurfaceContractV1({
      ...definition(),
      extra: true,
    } as LocalCliSurfaceContractDefinitionV1)).toThrow("unsupported field");
    expect(() => defineLocalCliSurfaceContractV1(
      new Proxy(definition(), {}) as LocalCliSurfaceContractDefinitionV1,
    )).toThrow("plain data object");

    let getterCalls = 0;
    const accessor = definition() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "surface", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "example";
      },
    });
    expect(() => defineLocalCliSurfaceContractV1(
      accessor as LocalCliSurfaceContractDefinitionV1,
    )).toThrow("data fields");
    expect(getterCalls).toBe(0);

    const nonFinite = definition();
    (nonFinite.commands[0]!.flags[0]! as unknown as {
      default: { kind: "literal"; value: number; authority: "tagged-source" };
    }).default = { kind: "literal", value: Number.NaN, authority: "tagged-source" };
    expect(() => defineLocalCliSurfaceContractV1(nonFinite)).toThrow("finite JSON scalar");
    const invalidOperationVersion = definition();
    (invalidOperationVersion.runtime as unknown as {
      operationContractVersions: Readonly<Record<string, number>>;
    }).operationContractVersions = { "raw command": 1 };
    expect(() => defineLocalCliSurfaceContractV1(invalidOperationVersion))
      .toThrow("bounded semantic name");
    const ambiguousPath = definition();
    (ambiguousPath.commands[0]! as unknown as { path: readonly string[] }).path = [
      "items list",
    ];
    expect(() => defineLocalCliSurfaceContractV1(ambiguousPath))
      .toThrow("whitespace-free command segments");
    const gappedArguments = definition();
    (gappedArguments.commands[0]! as unknown as {
      arguments: readonly unknown[];
    }).arguments = [{
      name: "id",
      position: 1,
      required: true,
      multiple: false,
      valueType: "string",
      enum: [],
      default: { kind: "none" },
      decision: supported,
    }];
    expect(() => defineLocalCliSurfaceContractV1(gappedArguments))
      .toThrow("contiguous from zero");
    const badUnicode = definition();
    (badUnicode.commands[0]! as unknown as { decision: LocalCliSurfaceDecisionV1 }).decision = {
      ...supported,
      rationale: String.fromCharCode(0xd800),
    };
    expect(() => defineLocalCliSurfaceContractV1(badUnicode)).toThrow("Unicode text");
  });

  test("rejects forged aggregate and per-command digests", () => {
    const contract = structuredClone(defineLocalCliSurfaceContractV1(definition()));
    (contract.digests as unknown as { classificationSha256: string })
      .classificationSha256 = digest("0");
    expect(() => parseLocalCliSurfaceContractV1(contract)).toThrow("did not match");

    const commandContract = structuredClone(defineLocalCliSurfaceContractV1(definition()));
    (commandContract.commands[0]! as unknown as { semanticProfileSha256: string })
      .semanticProfileSha256 = digest("1");
    expect(() => parseLocalCliSurfaceContractV1(commandContract)).toThrow("did not match");
  });
});
