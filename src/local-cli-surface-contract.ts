import { types as nodeTypes } from "node:util";

import { sha256 } from "./canonical-json";
import { isProviderPluginOperationName } from "./provider-plugin-identifiers";

export const LOCAL_CLI_SURFACE_DISPOSITIONS = Object.freeze([
  "supported",
  "fixed",
  "absorbed",
  "replaced",
  "internal",
  "R4",
  "unsupported",
] as const);

export type LocalCliSurfaceDispositionV1 =
  (typeof LOCAL_CLI_SURFACE_DISPOSITIONS)[number];

export type LocalCliSurfaceDecisionV1 = Readonly<{
  disposition: LocalCliSurfaceDispositionV1;
  rationale: string;
  operation: string | null;
  replacement: string | null;
  fixedValue: string | number | boolean | null;
}>;

export type LocalCliSurfacePathSemanticInputsV1 = Readonly<
  Record<string, string | number | boolean | null>
>;

export type LocalCliSurfaceDefaultV1 =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "literal";
      value: string | number | boolean;
      authority: "tagged-source" | "jit-plugin-source" | "sdk-openapi";
    }>
  | Readonly<{ kind: "derived"; description: string }>
  | Readonly<{ kind: "environment"; name: string }>;

export type LocalCliSurfacePredicateV1 =
  | Readonly<{ op: "true" }>
  | Readonly<{ op: "present"; field: string }>
  | Readonly<{ op: "eq"; field: string; value: string | number | boolean | null }>
  | Readonly<{ op: "not"; predicate: LocalCliSurfacePredicateV1 }>
  | Readonly<{
      op: "and" | "or";
      predicates: readonly LocalCliSurfacePredicateV1[];
    }>;

export type LocalCliSurfaceInputRuleV1 = Readonly<{
  namespace: "semantic-operation" | "upstream-command";
  when: LocalCliSurfacePredicateV1;
  require: readonly string[];
  requireAny: readonly string[];
  exactlyOne: readonly string[];
  forbid: readonly string[];
  rationale: string;
}>;

export type LocalCliSurfaceArgumentV1 = Readonly<{
  name: string;
  position: number;
  required: boolean;
  multiple: boolean;
  valueType: "string" | "number" | "boolean";
  enum: readonly string[];
  default: LocalCliSurfaceDefaultV1;
  decision: LocalCliSurfaceDecisionV1;
}>;

export type LocalCliSurfaceFlagV1 = Readonly<{
  name: string;
  aliases: readonly string[];
  source: "command" | "global";
  valueType: "string" | "number" | "boolean";
  allowNo: boolean;
  required: boolean;
  multiple: boolean;
  enum: readonly string[];
  default: LocalCliSurfaceDefaultV1;
  decision: LocalCliSurfaceDecisionV1;
}>;

export type LocalCliSurfaceOutputV1 = Readonly<{
  shape: string;
  completeness:
    | "complete"
    | "bounded"
    | "candidate-window"
    | "input-dependent"
    | "internal"
    | "unavailable";
  maxBytes: number | null;
  privateArtifact: boolean;
  truncation: string | null;
}>;

export type LocalCliSurfaceReconciliationV1 = Readonly<{
  availability: "none" | "always" | "input-dependent";
  namespace: "semantic-operation" | null;
  predicate: LocalCliSurfacePredicateV1 | null;
  rationale: string;
}>;

export type LocalCliSurfaceCommandDefinitionV1 = Readonly<{
  path: readonly string[];
  provenance: LocalCliSurfaceProvenanceKindV1;
  profileAuthority: "tagged-source" | "jit-plugin-source";
  package: string | null;
  version: string | null;
  versionKind: "exact" | "range" | null;
  registered: boolean;
  publicManual: boolean;
  generatedCanonical: boolean;
  upstreamReportedMutates: boolean | null;
  reviewedEffect: "read" | "write" | "input-dependent";
  arguments: readonly LocalCliSurfaceArgumentV1[];
  flags: readonly LocalCliSurfaceFlagV1[];
  decision: LocalCliSurfaceDecisionV1;
  /** Semantic inputs fixed by the exact command path before caller input is applied. */
  pathSemanticInputs: LocalCliSurfacePathSemanticInputsV1;
  output: LocalCliSurfaceOutputV1;
  conditionalInputs: readonly LocalCliSurfaceInputRuleV1[];
  reconciliation: LocalCliSurfaceReconciliationV1;
}>;

export type LocalCliSurfaceCommandV1 = LocalCliSurfaceCommandDefinitionV1 &
  Readonly<{ semanticProfileSha256: string }>;

export const LOCAL_CLI_SURFACE_PROVENANCE_KINDS = Object.freeze([
  "built-in-canonical",
  "built-in-hidden",
  "built-in-alias",
  "source-only-private",
  "jit-plugin",
  "dynamic-plugin",
  "documented-only",
] as const);

export type LocalCliSurfaceProvenanceKindV1 =
  (typeof LOCAL_CLI_SURFACE_PROVENANCE_KINDS)[number];

export type LocalCliSurfaceAdditionalEntryV1 = Readonly<{
  path: readonly string[];
  provenance: LocalCliSurfaceProvenanceKindV1;
  profileAuthority: "tagged-source" | "framework-runtime" | "documentation";
  canonicalTarget: readonly string[] | null;
  package: string | null;
  version: string | null;
  versionKind: "exact" | "range" | null;
  registered: boolean;
  publicManual: boolean;
  rationale: string;
  decision: LocalCliSurfaceDecisionV1;
}>;

export type LocalCliSurfaceArtifactV1 = Readonly<{
  platform: string;
  arch: string;
  archiveSha256: string;
  executableSha256: string;
}>;

export type LocalCliSurfaceContractDefinitionV1 = Readonly<{
  schemaVersion: 1;
  format: "wrench.local-cli-surface";
  surface: string;
  executable: Readonly<{
    id: string;
    implementation: string;
    releaseVersion: string;
    releaseDate: string;
    releaseTag: string;
    releaseCommit: string;
    releaseManifestSha256: string;
    runtimeReportedName: string;
    runtimeReportedVersion: string;
    artifacts: readonly LocalCliSurfaceArtifactV1[];
  }>;
  source: Readonly<{
    package: string;
    packagePath: string;
    packageDeclaredVersion: string;
    versionDiscrepancy: string | null;
    generatedManualSha256: string;
    generatedManualIncludesFlagsAndDefaults: boolean;
    generatedManualEntries: number;
    generatedCanonicalEntries: number;
    registeredKeys: number;
  }>;
  sdk: Readonly<{
    package: string;
    version: string;
    commit: string;
  }>;
  runtime: Readonly<{
    providerPluginId: string;
    providerPluginVersion: string;
    adapterId: string;
    adapterVersion: string;
    operationContractVersions: Readonly<Record<string, number>>;
    operationInputTypes: Readonly<
      Record<string, Readonly<Record<string, "string" | "number" | "boolean" | "array" | "file">>>
    >;
    target: string;
    realm: string;
    compatibility: string;
  }>;
  globalFlags: readonly LocalCliSurfaceFlagV1[];
  commands: readonly LocalCliSurfaceCommandDefinitionV1[];
  additionalEntries: readonly LocalCliSurfaceAdditionalEntryV1[];
}>;

export type LocalCliSurfaceContractV1 = Omit<
  LocalCliSurfaceContractDefinitionV1,
  "commands"
> & Readonly<{
  commands: readonly LocalCliSurfaceCommandV1[];
  digests: Readonly<{
    upstreamSurfaceSha256: string;
    classificationSha256: string;
    semanticProfilesSha256: string;
    wholeSurfaceSha256: string;
  }>;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function record(value: unknown, label: string): JsonRecord {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) throw new Error(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbols`);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
      || !hasWellFormedUnicode(key)
    ) throw new Error(`${label} must contain only enumerable Unicode data fields`);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1
  ) throw new Error(`${label} must be a dense array of at most ${maximum} items`);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must contain only enumerable data items`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function string(value: unknown, label: string, maximum = 1_024): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || !hasWellFormedUnicode(value)
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new Error(`${label} must be bounded Unicode text`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function parseVersionKind(
  value: unknown,
  versionValue: unknown,
  label: string,
): "exact" | "range" | null {
  if (versionValue === null) {
    if (value !== null) throw new Error(`${label} requires a package version`);
    return null;
  }
  return exactEnum(value, label, ["exact", "range"] as const);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded integer`);
  }
  return value as number;
}

function exactEnum<T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${label} is unsupported`);
  }
  return value as T;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be one SHA-256 digest`);
  }
  return value;
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${label} must be one full Git commit ID`);
  }
  return value;
}

function canonicalDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) {
    throw new Error(`${label} must be a canonical YYYY-MM-DD date`);
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) throw new Error(`${label} must be a canonical YYYY-MM-DD date`);
  return value;
}

function scalar(value: unknown, label: string): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string") string(value, label, 4_096);
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  throw new Error(`${label} must be a finite JSON scalar`);
}

function stringList(value: unknown, label: string, maximum: number): readonly string[] {
  const result = array(value, label, maximum).map((item, index) =>
    string(item, `${label}[${index}]`, 512));
  if (new Set(result).size !== result.length) throw new Error(`${label} repeats a value`);
  return Object.freeze(result);
}

function commandPath(value: unknown, label: string): readonly string[] {
  const path = stringList(value, label, 16);
  if (path.length < 1 || path.some((segment) => /\s/u.test(segment))) {
    throw new Error(`${label} must contain nonempty whitespace-free command segments`);
  }
  return path;
}

function codePointCompare(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index]!.codePointAt(0)!;
    const rightCodePoint = rightCodePoints[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
  }
  return leftCodePoints.length < rightCodePoints.length
    ? -1
    : leftCodePoints.length > rightCodePoints.length ? 1 : 0;
}

/** Surface-scoped canonical JSON; intentionally independent of host locale. */
function surfaceCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("local CLI surface canonical JSON contains an invalid number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => surfaceCanonicalJson(item)).join(",")}]`;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("local CLI surface canonical JSON contains a non-JSON value");
  }
  const entries = Object.entries(value).sort(([left], [right]) => codePointCompare(left, right));
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${surfaceCanonicalJson(item)}`).join(",")}}`;
}

function parseDefault(value: unknown, label: string): LocalCliSurfaceDefaultV1 {
  const source = record(value, label);
  const kind = exactEnum(source.kind, `${label}.kind`, [
    "none", "literal", "derived", "environment",
  ] as const);
  if (kind === "none") {
    exactKeys(source, ["kind"], [], label);
    return Object.freeze({ kind });
  }
  if (kind === "literal") {
    exactKeys(source, ["kind", "value", "authority"], [], label);
    const value = scalar(source.value, `${label}.value`);
    if (value === null) throw new Error(`${label}.literal null is ambiguous with kind none`);
    return Object.freeze({
      kind,
      value,
      authority: exactEnum(source.authority, `${label}.authority`, [
        "tagged-source", "jit-plugin-source", "sdk-openapi",
      ] as const),
    });
  }
  if (kind === "derived") {
    exactKeys(source, ["kind", "description"], [], label);
    return Object.freeze({ kind, description: string(source.description, `${label}.description`, 500) });
  }
  exactKeys(source, ["kind", "name"], [], label);
  const name = string(source.name, `${label}.name`, 128);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new Error(`${label}.name must be an environment variable`);
  return Object.freeze({ kind, name });
}

function parseDecision(value: unknown, label: string): LocalCliSurfaceDecisionV1 {
  const source = record(value, label);
  exactKeys(source, [
    "disposition", "rationale", "operation", "replacement", "fixedValue",
  ], [], label);
  const disposition = exactEnum(
    source.disposition,
    `${label}.disposition`,
    LOCAL_CLI_SURFACE_DISPOSITIONS,
  );
  const operation = nullableString(source.operation, `${label}.operation`);
  const replacement = nullableString(source.replacement, `${label}.replacement`);
  const fixedValue = scalar(source.fixedValue, `${label}.fixedValue`);
  if (
    operation !== null
    && !isProviderPluginOperationName(operation)
  ) throw new Error(`${label}.operation must be a semantic operation name`);
  if (disposition === "supported" && operation === null) {
    throw new Error(`${label} supported disposition requires an operation`);
  }
  if (disposition === "fixed" && fixedValue === null) {
    throw new Error(`${label}.fixedValue is required for fixed disposition`);
  }
  if (disposition !== "fixed" && fixedValue !== null) {
    throw new Error(`${label}.fixedValue requires fixed disposition`);
  }
  return Object.freeze({
    disposition,
    rationale: string(source.rationale, `${label}.rationale`, 1_000),
    operation,
    replacement,
    fixedValue,
  });
}

function parsePathSemanticInputs(
  value: unknown,
  label: string,
): LocalCliSurfacePathSemanticInputsV1 {
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length > 128) {
    throw new Error(`${label} exceeds its semantic input bound`);
  }
  const parsed: Record<string, string | number | boolean | null> =
    Object.create(null) as Record<string, string | number | boolean | null>;
  for (const [field, fieldValue] of entries) {
    if (!/^[a-z][a-z0-9_]{0,127}$/u.test(field)) {
      throw new Error(`${label} contains an invalid semantic input field ${field}`);
    }
    parsed[field] = scalar(fieldValue, `${label}.${field}`);
  }
  return Object.freeze(parsed);
}

type PredicateTraversal = {
  readonly seen: WeakSet<object>;
  nodes: number;
};

function parsePredicate(
  value: unknown,
  label: string,
  traversal: PredicateTraversal,
  depth = 0,
): LocalCliSurfacePredicateV1 {
  if (depth > 8) throw new Error(`${label} exceeds the predicate depth bound`);
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be a predicate data object`);
  }
  if (traversal.seen.has(value)) {
    throw new Error(`${label} repeats a predicate object identity`);
  }
  traversal.seen.add(value);
  traversal.nodes += 1;
  if (traversal.nodes > 10_000) {
    throw new Error("local CLI surface predicates exceed the whole-contract node bound");
  }
  const source = record(value, label);
  const op = exactEnum(source.op, `${label}.op`, [
    "true", "present", "eq", "not", "and", "or",
  ] as const);
  if (op === "true") {
    exactKeys(source, ["op"], [], label);
    return Object.freeze({ op });
  }
  if (op === "present") {
    exactKeys(source, ["op", "field"], [], label);
    return Object.freeze({ op, field: string(source.field, `${label}.field`, 128) });
  }
  if (op === "eq") {
    exactKeys(source, ["op", "field", "value"], [], label);
    return Object.freeze({
      op,
      field: string(source.field, `${label}.field`, 128),
      value: scalar(source.value, `${label}.value`),
    });
  }
  if (op === "not") {
    exactKeys(source, ["op", "predicate"], [], label);
    return Object.freeze({
      op,
      predicate: parsePredicate(source.predicate, `${label}.predicate`, traversal, depth + 1),
    });
  }
  exactKeys(source, ["op", "predicates"], [], label);
  const predicates = array(source.predicates, `${label}.predicates`, 32)
    .map((item, index) => parsePredicate(
      item,
      `${label}.predicates[${index}]`,
      traversal,
      depth + 1,
    ));
  if (predicates.length < 1) throw new Error(`${label}.predicates must not be empty`);
  return Object.freeze({ op, predicates: Object.freeze(predicates) });
}

function parseRule(
  value: unknown,
  label: string,
  predicateTraversal: PredicateTraversal,
): LocalCliSurfaceInputRuleV1 {
  const source = record(value, label);
  exactKeys(source, [
    "namespace", "when", "require", "requireAny", "exactlyOne", "forbid", "rationale",
  ], [], label);
  const requiredFields = stringList(source.require, `${label}.require`, 64);
  const requireAny = stringList(source.requireAny, `${label}.requireAny`, 64);
  const exactlyOne = stringList(source.exactlyOne, `${label}.exactlyOne`, 64);
  const forbid = stringList(source.forbid, `${label}.forbid`, 64);
  if ([...requiredFields, ...requireAny, ...exactlyOne].some((field) => forbid.includes(field))) {
    throw new Error(`${label} cannot require and forbid the same field`);
  }
  return Object.freeze({
    namespace: exactEnum(source.namespace, `${label}.namespace`, [
      "semantic-operation", "upstream-command",
    ] as const),
    when: parsePredicate(source.when, `${label}.when`, predicateTraversal),
    require: requiredFields,
    requireAny,
    exactlyOne,
    forbid,
    rationale: string(source.rationale, `${label}.rationale`, 1_000),
  });
}

function parseArgument(value: unknown, label: string): LocalCliSurfaceArgumentV1 {
  const source = record(value, label);
  exactKeys(source, [
    "name", "position", "required", "multiple", "valueType", "enum", "default", "decision",
  ], [], label);
  const valueType = exactEnum(source.valueType, `${label}.valueType`, ["string", "number", "boolean"] as const);
  const enumValues = stringList(source.enum, `${label}.enum`, 128);
  const defaultValue = parseDefault(source.default, `${label}.default`);
  const decision = parseDecision(source.decision, `${label}.decision`);
  if (enumValues.length > 0 && valueType !== "string") {
    throw new Error(`${label}.enum requires a string argument`);
  }
  if (
    defaultValue.kind === "literal"
    && enumValues.length > 0
    && !enumValues.includes(defaultValue.value as string)
  ) throw new Error(`${label}.default must belong to the declared enum`);
  if (
    defaultValue.kind === "literal"
    && defaultValue.value !== null
    && typeof defaultValue.value !== valueType
  ) throw new Error(`${label}.default must match the argument value type`);
  if (
    decision.disposition === "fixed"
    && typeof decision.fixedValue !== valueType
  ) throw new Error(`${label}.fixedValue must match the argument value type`);
  if (
    decision.disposition === "fixed"
    && enumValues.length > 0
    && !enumValues.includes(decision.fixedValue as string)
  ) throw new Error(`${label}.fixedValue must belong to the declared enum`);
  return Object.freeze({
    name: string(source.name, `${label}.name`, 128),
    position: integer(source.position, `${label}.position`, 0, 255),
    required: boolean(source.required, `${label}.required`),
    multiple: boolean(source.multiple, `${label}.multiple`),
    valueType,
    enum: enumValues,
    default: defaultValue,
    decision,
  });
}

function parseFlag(value: unknown, label: string): LocalCliSurfaceFlagV1 {
  const source = record(value, label);
  exactKeys(source, [
    "name", "aliases", "source", "valueType", "allowNo", "required", "multiple", "enum", "default", "decision",
  ], [], label);
  const name = string(source.name, `${label}.name`, 128);
  if (!/^--[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`${label}.name must be a long flag`);
  const aliases = stringList(source.aliases, `${label}.aliases`, 8);
  if (aliases.some((alias) => !/^-[a-zA-Z]$/u.test(alias))) {
    throw new Error(`${label}.aliases must be one-character flags`);
  }
  const valueType = exactEnum(source.valueType, `${label}.valueType`, ["string", "number", "boolean"] as const);
  const allowNo = boolean(source.allowNo, `${label}.allowNo`);
  const defaultValue = parseDefault(source.default, `${label}.default`);
  const enumValues = stringList(source.enum, `${label}.enum`, 128);
  const decision = parseDecision(source.decision, `${label}.decision`);
  if (allowNo && valueType !== "boolean") {
    throw new Error(`${label}.allowNo requires a boolean flag`);
  }
  if (enumValues.length > 0 && valueType !== "string") {
    throw new Error(`${label}.enum requires a string flag`);
  }
  if (
    defaultValue.kind === "literal"
    && enumValues.length > 0
    && !enumValues.includes(defaultValue.value as string)
  ) throw new Error(`${label}.default must belong to the declared enum`);
  if (
    defaultValue.kind === "literal"
    && defaultValue.value !== null
    && typeof defaultValue.value !== valueType
  ) throw new Error(`${label}.default must match the flag value type`);
  if (
    decision.disposition === "fixed"
    && typeof decision.fixedValue !== valueType
  ) throw new Error(`${label}.fixedValue must match the flag value type`);
  if (
    decision.disposition === "fixed"
    && enumValues.length > 0
    && !enumValues.includes(decision.fixedValue as string)
  ) throw new Error(`${label}.fixedValue must belong to the declared enum`);
  return Object.freeze({
    name,
    aliases,
    source: exactEnum(source.source, `${label}.source`, ["command", "global"] as const),
    valueType,
    allowNo,
    required: boolean(source.required, `${label}.required`),
    multiple: boolean(source.multiple, `${label}.multiple`),
    enum: enumValues,
    default: defaultValue,
    decision,
  });
}

function parseOutput(value: unknown, label: string): LocalCliSurfaceOutputV1 {
  const source = record(value, label);
  exactKeys(source, [
    "shape", "completeness", "maxBytes", "privateArtifact", "truncation",
  ], [], label);
  const maxBytes = source.maxBytes === null
    ? null
    : integer(source.maxBytes, `${label}.maxBytes`, 1, 4 * 1024 * 1024 * 1024);
  return Object.freeze({
    shape: string(source.shape, `${label}.shape`, 1_000),
    completeness: exactEnum(source.completeness, `${label}.completeness`, [
      "complete", "bounded", "candidate-window", "input-dependent", "internal", "unavailable",
    ] as const),
    maxBytes,
    privateArtifact: boolean(source.privateArtifact, `${label}.privateArtifact`),
    truncation: nullableString(source.truncation, `${label}.truncation`),
  });
}

function parseReconciliation(
  value: unknown,
  label: string,
  predicateTraversal: PredicateTraversal,
): LocalCliSurfaceReconciliationV1 {
  const source = record(value, label);
  exactKeys(source, ["availability", "namespace", "predicate", "rationale"], [], label);
  const availability = exactEnum(source.availability, `${label}.availability`, [
    "none", "always", "input-dependent",
  ] as const);
  const predicate = source.predicate === null
    ? null
    : parsePredicate(source.predicate, `${label}.predicate`, predicateTraversal);
  if ((availability === "input-dependent") !== (predicate !== null)) {
    throw new Error(`${label}.predicate must exactly match input-dependent availability`);
  }
  const namespace = source.namespace === null
    ? null
    : exactEnum(source.namespace, `${label}.namespace`, ["semantic-operation"] as const);
  if ((availability === "input-dependent") !== (namespace !== null)) {
    throw new Error(`${label}.namespace must exactly match input-dependent availability`);
  }
  return Object.freeze({
    availability,
    namespace,
    predicate,
    rationale: string(source.rationale, `${label}.rationale`, 1_000),
  });
}

function parseCommand(
  value: unknown,
  label: string,
  predicateTraversal: PredicateTraversal,
): LocalCliSurfaceCommandDefinitionV1 {
  const source = record(value, label);
  exactKeys(source, [
    "path", "provenance", "profileAuthority", "package", "version", "versionKind",
    "registered", "publicManual", "generatedCanonical",
    "upstreamReportedMutates", "reviewedEffect", "arguments", "flags",
    "decision", "pathSemanticInputs", "output", "conditionalInputs", "reconciliation",
  ], ["semanticProfileSha256"], label);
  const path = commandPath(source.path, `${label}.path`);
  const args = array(source.arguments, `${label}.arguments`, 32)
    .map((item, index) => parseArgument(item, `${label}.arguments[${index}]`));
  const normalizedArgumentNames = args.map((argument) => argument.name.replaceAll("-", "_"));
  if (new Set(normalizedArgumentNames).size !== normalizedArgumentNames.length) {
    throw new Error(`${label}.arguments repeat a normalized name`);
  }
  const positions = args.map((argument) => argument.position);
  if (positions.some((position, index) => position !== index)) {
    throw new Error(`${label}.arguments positions must be contiguous from zero`);
  }
  const flags = array(source.flags, `${label}.flags`, 128)
    .map((item, index) => parseFlag(item, `${label}.flags[${index}]`));
  if (new Set(flags.map((flag) => flag.name)).size !== flags.length) {
    throw new Error(`${label}.flags repeat a long name`);
  }
  if (flags.some((flag) => flag.source !== "command")) {
    throw new Error(`${label}.flags must be command flags`);
  }
  const normalizedFlagNames = flags.map((flag) => flag.name.slice(2).replaceAll("-", "_"));
  if (normalizedFlagNames.some((name) => normalizedArgumentNames.includes(name))) {
    throw new Error(`${label} repeats a normalized argument/flag field`);
  }
  const conditionalInputs = array(source.conditionalInputs, `${label}.conditionalInputs`, 64)
    .map((item, index) => parseRule(item, `${label}.conditionalInputs[${index}]`, predicateTraversal));
  const upstreamReportedMutates = source.upstreamReportedMutates === null
    ? null
    : boolean(source.upstreamReportedMutates, `${label}.upstreamReportedMutates`);
  return Object.freeze({
    path,
    provenance: exactEnum(source.provenance, `${label}.provenance`, LOCAL_CLI_SURFACE_PROVENANCE_KINDS),
    profileAuthority: exactEnum(source.profileAuthority, `${label}.profileAuthority`, [
      "tagged-source", "jit-plugin-source",
    ] as const),
    package: nullableString(source.package, `${label}.package`),
    version: nullableString(source.version, `${label}.version`),
    versionKind: parseVersionKind(source.versionKind, source.version, `${label}.versionKind`),
    registered: boolean(source.registered, `${label}.registered`),
    publicManual: boolean(source.publicManual, `${label}.publicManual`),
    generatedCanonical: boolean(source.generatedCanonical, `${label}.generatedCanonical`),
    upstreamReportedMutates,
    reviewedEffect: exactEnum(source.reviewedEffect, `${label}.reviewedEffect`, [
      "read", "write", "input-dependent",
    ] as const),
    arguments: Object.freeze(args),
    flags: Object.freeze(flags),
    decision: parseDecision(source.decision, `${label}.decision`),
    pathSemanticInputs: parsePathSemanticInputs(
      source.pathSemanticInputs,
      `${label}.pathSemanticInputs`,
    ),
    output: parseOutput(source.output, `${label}.output`),
    conditionalInputs: Object.freeze(conditionalInputs),
    reconciliation: parseReconciliation(source.reconciliation, `${label}.reconciliation`, predicateTraversal),
  });
}

function parseAdditionalEntry(
  value: unknown,
  label: string,
): LocalCliSurfaceAdditionalEntryV1 {
  const source = record(value, label);
  exactKeys(source, [
    "path", "provenance", "profileAuthority", "canonicalTarget", "package", "version", "versionKind", "registered",
    "publicManual", "rationale", "decision",
  ], [], label);
  const path = commandPath(source.path, `${label}.path`);
  const canonicalTarget = source.canonicalTarget === null
    ? null
    : commandPath(source.canonicalTarget, `${label}.canonicalTarget`);
  return Object.freeze({
    path,
    provenance: exactEnum(source.provenance, `${label}.provenance`, LOCAL_CLI_SURFACE_PROVENANCE_KINDS),
    profileAuthority: exactEnum(source.profileAuthority, `${label}.profileAuthority`, [
      "tagged-source", "framework-runtime", "documentation",
    ] as const),
    canonicalTarget,
    package: nullableString(source.package, `${label}.package`),
    version: nullableString(source.version, `${label}.version`),
    versionKind: parseVersionKind(source.versionKind, source.version, `${label}.versionKind`),
    registered: boolean(source.registered, `${label}.registered`),
    publicManual: boolean(source.publicManual, `${label}.publicManual`),
    rationale: string(source.rationale, `${label}.rationale`, 1_000),
    decision: parseDecision(source.decision, `${label}.decision`),
  });
}

function flagSpellings(flag: LocalCliSurfaceFlagV1): readonly string[] {
  return Object.freeze([
    flag.name,
    ...(flag.allowNo ? [`--no-${flag.name.slice(2)}`] : []),
    ...flag.aliases,
  ]);
}

function predicateFieldNames(predicate: LocalCliSurfacePredicateV1): readonly string[] {
  if (predicate.op === "true") return Object.freeze([]);
  if (predicate.op === "present" || predicate.op === "eq") {
    return Object.freeze([predicate.field]);
  }
  if (predicate.op === "not") return predicateFieldNames(predicate.predicate);
  return Object.freeze(predicate.predicates.flatMap(predicateFieldNames));
}

type SurfaceFieldType = "string" | "number" | "boolean" | "array" | "file";

function validatePredicateTypes(
  predicate: LocalCliSurfacePredicateV1,
  fieldTypes: Readonly<Record<string, SurfaceFieldType>>,
  label: string,
): void {
  if (predicate.op === "true" || predicate.op === "present") return;
  if (predicate.op === "eq") {
    const expected = fieldTypes[predicate.field];
    if (
      expected === undefined
      || (
        predicate.value !== null
        && expected !== "file"
        && expected !== "array"
        && typeof predicate.value !== expected
      )
      || ((expected === "file" || expected === "array") && predicate.value !== null)
    ) throw new Error(`${label} equality value does not match field ${predicate.field}`);
    return;
  }
  if (predicate.op === "not") {
    validatePredicateTypes(predicate.predicate, fieldTypes, `${label}.predicate`);
    return;
  }
  predicate.predicates.forEach((item, index) =>
    validatePredicateTypes(item, fieldTypes, `${label}.predicates[${index}]`));
}

function ruleFieldNames(rule: LocalCliSurfaceInputRuleV1): readonly string[] {
  return Object.freeze([
    ...predicateFieldNames(rule.when),
    ...rule.require,
    ...rule.requireAny,
    ...rule.exactlyOne,
    ...rule.forbid,
  ]);
}

function parseArtifact(value: unknown, label: string): LocalCliSurfaceArtifactV1 {
  const source = record(value, label);
  exactKeys(source, ["platform", "arch", "archiveSha256", "executableSha256"], [], label);
  return Object.freeze({
    platform: string(source.platform, `${label}.platform`, 32),
    arch: string(source.arch, `${label}.arch`, 32),
    archiveSha256: sha(source.archiveSha256, `${label}.archiveSha256`),
    executableSha256: sha(source.executableSha256, `${label}.executableSha256`),
  });
}

function parseDefinition(value: unknown): LocalCliSurfaceContractDefinitionV1 {
  const source = record(value, "local CLI surface contract");
  exactKeys(source, [
    "schemaVersion", "format", "surface", "executable", "source", "sdk", "runtime",
    "globalFlags", "commands", "additionalEntries",
  ], ["digests"], "local CLI surface contract");
  if (source.schemaVersion !== 1 || source.format !== "wrench.local-cli-surface") {
    throw new Error("local CLI surface contract version is unsupported");
  }
  const executable = record(source.executable, "local CLI surface executable");
  exactKeys(executable, [
    "id", "implementation", "releaseVersion", "releaseDate", "releaseTag", "releaseCommit",
    "releaseManifestSha256", "runtimeReportedName", "runtimeReportedVersion", "artifacts",
  ], [], "local CLI surface executable");
  const sourceIdentity = record(source.source, "local CLI surface source");
  exactKeys(sourceIdentity, [
    "package", "packagePath", "packageDeclaredVersion", "versionDiscrepancy",
    "generatedManualSha256", "generatedManualIncludesFlagsAndDefaults",
    "generatedManualEntries", "generatedCanonicalEntries", "registeredKeys",
  ], [], "local CLI surface source");
  const sdk = record(source.sdk, "local CLI surface SDK");
  exactKeys(sdk, ["package", "version", "commit"], [], "local CLI surface SDK");
  const runtime = record(source.runtime, "local CLI surface runtime");
  exactKeys(runtime, [
    "providerPluginId", "providerPluginVersion", "adapterId", "adapterVersion",
    "operationContractVersions", "operationInputTypes", "target", "realm", "compatibility",
  ], [], "local CLI surface runtime");
  const rawOperationContractVersions = record(
    runtime.operationContractVersions,
    "local CLI surface runtime.operationContractVersions",
  );
  const operationContractVersionKeys = Object.keys(rawOperationContractVersions)
    .sort(codePointCompare);
  if (
    operationContractVersionKeys.length < 1
    || operationContractVersionKeys.length > 1_000
  ) {
    throw new Error("local CLI surface runtime.operationContractVersions must contain 1 to 1000 operations");
  }
  const operationContractVersions = Object.freeze(Object.fromEntries(
    operationContractVersionKeys.map((operation) => {
      if (!isProviderPluginOperationName(operation)) {
        throw new Error(`local CLI surface runtime operation ${operation} is not a bounded semantic name`);
      }
      return [
        operation,
        integer(
          rawOperationContractVersions[operation],
          `local CLI surface runtime.operationContractVersions.${operation}`,
          1,
          1_000_000,
        ),
      ] as const;
    }),
  ));
  const rawOperationInputTypes = record(
    runtime.operationInputTypes,
    "local CLI surface runtime.operationInputTypes",
  );
  const operationInputTypeKeys = Object.keys(rawOperationInputTypes).sort(codePointCompare);
  if (
    operationInputTypeKeys.length !== operationContractVersionKeys.length
    || operationInputTypeKeys.some((operation, index) =>
      operation !== operationContractVersionKeys[index])
  ) throw new Error("local CLI surface runtime input fields must exactly cover operation versions");
  const operationInputTypes = Object.freeze(Object.fromEntries(
    operationInputTypeKeys.map((operation) => {
      const rawFields = record(
        rawOperationInputTypes[operation],
        `local CLI surface runtime.operationInputTypes.${operation}`,
      );
      const fields = Object.keys(rawFields).sort(codePointCompare);
      if (
        fields.length > 256
        || fields.some((field) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(field))
      ) throw new Error("local CLI surface runtime contains invalid semantic input fields");
      return [operation, Object.freeze(Object.fromEntries(fields.map((field) => [
        field,
        exactEnum(
          rawFields[field],
          `local CLI surface runtime.operationInputTypes.${operation}.${field}`,
          ["string", "number", "boolean", "array", "file"] as const,
        ),
      ])))] as const;
    }),
  ));
  const predicateTraversal: PredicateTraversal = {
    seen: new WeakSet<object>(),
    nodes: 0,
  };
  const commands = array(source.commands, "local CLI surface commands", 1_000)
    .map((item, index) => parseCommand(
      item,
      `local CLI surface commands[${index}]`,
      predicateTraversal,
    ));
  const commandPaths = commands.map((command) => command.path.join(" "));
  if (new Set(commandPaths).size !== commandPaths.length) {
    throw new Error("local CLI surface commands repeat a normalized path");
  }
  const globalFlags = array(source.globalFlags, "local CLI surface globalFlags", 128)
    .map((item, index) => parseFlag(item, `local CLI surface globalFlags[${index}]`));
  if (
    globalFlags.some((flag) => flag.source !== "global")
    || new Set(globalFlags.map((flag) => flag.name)).size !== globalFlags.length
  ) throw new Error("local CLI surface globalFlags must be unique global flags");
  if (globalFlags.some((flag) =>
    flag.default.kind === "literal" && flag.default.authority === "jit-plugin-source")) {
    throw new Error("local CLI surface global flags cannot use JIT plugin default authority");
  }
  const globalSpellings = new Set<string>();
  for (const flag of globalFlags) {
    for (const spelling of flagSpellings(flag)) {
      if (globalSpellings.has(spelling)) {
        throw new Error("local CLI surface globalFlags repeat a flag spelling");
      }
      globalSpellings.add(spelling);
    }
  }
  for (const command of commands) {
    const commandSpellings = new Set<string>();
    for (const flag of command.flags) {
      for (const spelling of flagSpellings(flag)) {
        if (commandSpellings.has(spelling)) {
          throw new Error(`local CLI surface command ${command.path.join(" ")} repeats a flag spelling`);
        }
        if (spelling.startsWith("-") && !spelling.startsWith("--") && globalSpellings.has(spelling)) {
          throw new Error(`local CLI surface command ${command.path.join(" ")} shadows a global short alias`);
        }
        commandSpellings.add(spelling);
      }
    }
  }
  const additionalEntries = array(source.additionalEntries, "local CLI surface additionalEntries", 1_000)
    .map((item, index) => parseAdditionalEntry(item, `local CLI surface additionalEntries[${index}]`));
  const allPaths = [...commandPaths, ...additionalEntries.map((entry) => entry.path.join(" "))];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error("local CLI surface entries repeat a normalized path");
  }
  const allPathSet = new Set(allPaths);
  for (const entry of additionalEntries) {
    if (
      entry.canonicalTarget !== null
      && !allPathSet.has(entry.canonicalTarget.join(" "))
    ) throw new Error("local CLI surface entry has a dangling canonical target");
  }
  const additionalByPath = new Map(additionalEntries.map((entry) => [
    entry.path.join(" "),
    entry,
  ]));
  const aliasVisitState = new Map<string, "visiting" | "visited">();
  for (const entry of additionalEntries) {
    const chain: string[] = [];
    let path = entry.path.join(" ");
    while (true) {
      const state = aliasVisitState.get(path);
      if (state === "visiting") {
        throw new Error("local CLI surface canonical target graph contains an alias cycle");
      }
      if (state === "visited") break;
      aliasVisitState.set(path, "visiting");
      chain.push(path);
      const target = additionalByPath.get(path)?.canonicalTarget?.join(" ") ?? null;
      if (target === null || !additionalByPath.has(target)) break;
      path = target;
    }
    for (const visited of chain) aliasVisitState.set(visited, "visited");
  }
  for (const command of commands) {
    if (
      command.profileAuthority === "tagged-source"
      && (
        !["built-in-canonical", "source-only-private"].includes(command.provenance)
        || command.package !== sourceIdentity.package
        || command.version !== sourceIdentity.packageDeclaredVersion
        || command.versionKind !== "exact"
      )
    ) throw new Error("local CLI surface tagged command profile has inconsistent source authority");
    if (
      command.profileAuthority === "jit-plugin-source"
      && (
        command.provenance !== "jit-plugin"
        || command.package === null
        || command.version === null
        || command.versionKind !== "range"
      )
    ) throw new Error("local CLI surface JIT command profile has inconsistent package authority");
    for (const item of [...command.arguments, ...command.flags]) {
      if (item.default.kind !== "literal") continue;
      if (
        command.profileAuthority === "jit-plugin-source"
        && item.default.authority !== "jit-plugin-source"
      ) throw new Error("local CLI surface JIT command literal default has inconsistent authority");
      if (
        command.profileAuthority === "tagged-source"
        && item.default.authority === "jit-plugin-source"
      ) throw new Error("local CLI surface tagged command literal default has inconsistent authority");
    }
  }
  for (const entry of additionalEntries) {
    if (
      entry.profileAuthority === "tagged-source"
      && (
        entry.package !== sourceIdentity.package
        || entry.version !== sourceIdentity.packageDeclaredVersion
        || entry.versionKind !== "exact"
      )
    ) throw new Error("local CLI surface tagged additional entry has inconsistent source authority");
    if (
      entry.profileAuthority === "documentation"
      && (entry.provenance !== "documented-only" || entry.package !== null || entry.version !== null)
    ) throw new Error("local CLI surface documented entry has inconsistent authority");
  }
  const artifacts = array(executable.artifacts, "local CLI surface executable.artifacts", 32)
    .map((item, index) => parseArtifact(item, `local CLI surface executable.artifacts[${index}]`));
  const artifactCoordinates = artifacts.map((artifact) => `${artifact.platform}/${artifact.arch}`);
  if (artifacts.length < 1 || new Set(artifactCoordinates).size !== artifacts.length) {
    throw new Error("local CLI surface executable artifacts must be unique and nonempty");
  }
  const surface = string(source.surface, "local CLI surface contract.surface", 63);
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(surface)) {
    throw new Error("local CLI surface contract.surface must be a normalized surface ID");
  }
  const generatedManualEntries = integer(
    sourceIdentity.generatedManualEntries,
    "local CLI surface source.generatedManualEntries",
    1,
    10_000,
  );
  const generatedCanonicalEntries = integer(
    sourceIdentity.generatedCanonicalEntries,
    "local CLI surface source.generatedCanonicalEntries",
    1,
    10_000,
  );
  const registeredKeys = integer(
    sourceIdentity.registeredKeys,
    "local CLI surface source.registeredKeys",
    1,
    100_000,
  );
  if (
    commands.filter((command) => command.publicManual).length !== generatedManualEntries
    || commands.filter((command) => command.generatedCanonical).length
      + additionalEntries.filter((entry) =>
        entry.provenance === "built-in-hidden"
        && entry.profileAuthority === "tagged-source").length
      !== generatedCanonicalEntries
    || [
      ...commands,
      ...additionalEntries,
    ].filter((entry) => entry.registered && entry.package === sourceIdentity.package).length
      !== registeredKeys
  ) throw new Error("local CLI surface source counts do not match normalized entries");
  const installedOperations = new Set(operationContractVersionKeys);
  for (const decision of [
    ...globalFlags.map((flag) => flag.decision),
    ...commands.flatMap((command) => [
      command.decision,
      ...command.arguments.map((argument) => argument.decision),
      ...command.flags.map((flag) => flag.decision),
    ]),
    ...additionalEntries.map((entry) => entry.decision),
  ]) {
    if (decision.operation !== null && !installedOperations.has(decision.operation)) {
      throw new Error(`local CLI surface decision references uninstalled operation ${decision.operation}`);
    }
  }
  for (const command of commands) {
    if (
      (command.decision.disposition === "supported")
        !== (command.decision.operation !== null)
    ) {
      throw new Error(
        `local CLI surface command ${command.path.join(" ")} must bind an operation exactly when supported`,
      );
    }
    for (const item of [...command.arguments, ...command.flags]) {
      if (
        item.decision.operation !== null
        && item.decision.operation !== command.decision.operation
      ) {
        throw new Error(
          `local CLI surface command ${command.path.join(" ")} item operation differs from its command`,
        );
      }
    }
    const upstreamFieldTypes = Object.freeze(Object.fromEntries([
      ...command.arguments.map((argument) => [
        argument.name.replaceAll("-", "_"),
        argument.valueType,
      ] as const),
      ...command.flags.map((flag) => [
        flag.name.slice(2).replaceAll("-", "_"),
        flag.valueType,
      ] as const),
    ]));
    const semanticFieldTypes = command.decision.operation === null
      ? null
      : operationInputTypes[command.decision.operation] ?? null;
    for (const [field, value] of Object.entries(command.pathSemanticInputs)) {
      if (semanticFieldTypes === null || !Object.hasOwn(semanticFieldTypes, field)) {
        throw new Error(
          `local CLI surface command ${command.path.join(" ")} path semantic input references unknown field ${field}`,
        );
      }
      const expected = semanticFieldTypes[field];
      if (
        value !== null
        && (
          expected === "file"
          || expected === "array"
          || typeof value !== expected
        )
      ) {
        throw new Error(
          `local CLI surface command ${command.path.join(" ")} path semantic input ${field} has the wrong type`,
        );
      }
    }
    for (const [index, rule] of command.conditionalInputs.entries()) {
      const allowed = rule.namespace === "semantic-operation"
        ? semanticFieldTypes
        : upstreamFieldTypes;
      if (allowed === null) {
        throw new Error(`local CLI surface command ${command.path.join(" ")} has no semantic input namespace`);
      }
      for (const field of ruleFieldNames(rule)) {
        if (!Object.hasOwn(allowed, field)) {
          throw new Error(`local CLI surface command ${command.path.join(" ")} rule references unknown ${rule.namespace} field ${field}`);
        }
      }
      validatePredicateTypes(
        rule.when,
        allowed,
        `local CLI surface command ${command.path.join(" ")} conditionalInputs[${index}].when`,
      );
    }
    if (command.reconciliation.predicate !== null) {
      if (semanticFieldTypes === null) {
        throw new Error(`local CLI surface command ${command.path.join(" ")} has no reconciliation input namespace`);
      }
      for (const field of predicateFieldNames(command.reconciliation.predicate)) {
        if (!Object.hasOwn(semanticFieldTypes, field)) {
          throw new Error(`local CLI surface command ${command.path.join(" ")} reconciliation references unknown semantic field ${field}`);
        }
      }
      validatePredicateTypes(
        command.reconciliation.predicate,
        semanticFieldTypes,
        `local CLI surface command ${command.path.join(" ")} reconciliation.predicate`,
      );
    }
  }
  const releaseVersion = string(
    executable.releaseVersion,
    "local CLI surface executable.releaseVersion",
    128,
  );
  const runtimeReportedVersion = string(
    executable.runtimeReportedVersion,
    "local CLI surface executable.runtimeReportedVersion",
    128,
  );
  if (releaseVersion !== runtimeReportedVersion) {
    throw new Error("local CLI surface pinned release and runtime-reported versions must match");
  }
  const packageDeclaredVersion = string(
    sourceIdentity.packageDeclaredVersion,
    "local CLI surface source.packageDeclaredVersion",
    128,
  );
  const versionDiscrepancy = nullableString(
    sourceIdentity.versionDiscrepancy,
    "local CLI surface source.versionDiscrepancy",
  );
  if ((packageDeclaredVersion !== releaseVersion) !== (versionDiscrepancy !== null)) {
    throw new Error("local CLI surface source version discrepancy must exactly match version divergence");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.local-cli-surface",
    surface,
    executable: Object.freeze({
      id: string(executable.id, "local CLI surface executable.id", 128),
      implementation: string(executable.implementation, "local CLI surface executable.implementation", 512),
      releaseVersion,
      releaseDate: canonicalDate(executable.releaseDate, "local CLI surface executable.releaseDate"),
      releaseTag: string(executable.releaseTag, "local CLI surface executable.releaseTag", 128),
      releaseCommit: commitSha(executable.releaseCommit, "local CLI surface executable.releaseCommit"),
      releaseManifestSha256: sha(executable.releaseManifestSha256, "local CLI surface executable.releaseManifestSha256"),
      runtimeReportedName: string(executable.runtimeReportedName, "local CLI surface executable.runtimeReportedName", 128),
      runtimeReportedVersion,
      artifacts: Object.freeze(artifacts),
    }),
    source: Object.freeze({
      package: string(sourceIdentity.package, "local CLI surface source.package", 128),
      packagePath: string(sourceIdentity.packagePath, "local CLI surface source.packagePath", 512),
      packageDeclaredVersion,
      versionDiscrepancy,
      generatedManualSha256: sha(sourceIdentity.generatedManualSha256, "local CLI surface source.generatedManualSha256"),
      generatedManualIncludesFlagsAndDefaults: boolean(
        sourceIdentity.generatedManualIncludesFlagsAndDefaults,
        "local CLI surface source.generatedManualIncludesFlagsAndDefaults",
      ),
      generatedManualEntries,
      generatedCanonicalEntries,
      registeredKeys,
    }),
    sdk: Object.freeze({
      package: string(sdk.package, "local CLI surface SDK.package", 128),
      version: string(sdk.version, "local CLI surface SDK.version", 128),
      commit: commitSha(sdk.commit, "local CLI surface SDK.commit"),
    }),
    runtime: Object.freeze({
      providerPluginId: string(runtime.providerPluginId, "local CLI surface runtime.providerPluginId", 128),
      providerPluginVersion: string(runtime.providerPluginVersion, "local CLI surface runtime.providerPluginVersion", 128),
      adapterId: string(runtime.adapterId, "local CLI surface runtime.adapterId", 128),
      adapterVersion: string(runtime.adapterVersion, "local CLI surface runtime.adapterVersion", 128),
      operationContractVersions,
      operationInputTypes,
      target: string(runtime.target, "local CLI surface runtime.target", 128),
      realm: string(runtime.realm, "local CLI surface runtime.realm", 1_000),
      compatibility: string(runtime.compatibility, "local CLI surface runtime.compatibility", 1_000),
    }),
    globalFlags: Object.freeze(globalFlags),
    commands: Object.freeze(commands),
    additionalEntries: Object.freeze(additionalEntries),
  });
}

function upstreamProjection(definition: LocalCliSurfaceContractDefinitionV1): unknown {
  return {
    executable: definition.executable,
    source: {
      package: definition.source.package,
      packagePath: definition.source.packagePath,
      packageDeclaredVersion: definition.source.packageDeclaredVersion,
      generatedManualSha256: definition.source.generatedManualSha256,
      generatedManualIncludesFlagsAndDefaults:
        definition.source.generatedManualIncludesFlagsAndDefaults,
      generatedManualEntries: definition.source.generatedManualEntries,
      generatedCanonicalEntries: definition.source.generatedCanonicalEntries,
      registeredKeys: definition.source.registeredKeys,
    },
    sdk: definition.sdk,
    globalFlags: definition.globalFlags.map(({ decision: _decision, ...flag }) => flag),
    commands: definition.commands.map((command) => ({
      path: command.path,
      provenance: command.provenance,
      profileAuthority: command.profileAuthority,
      package: command.package,
      version: command.version,
      versionKind: command.versionKind,
      registered: command.registered,
      publicManual: command.publicManual,
      generatedCanonical: command.generatedCanonical,
      upstreamReportedMutates: command.upstreamReportedMutates,
      arguments: command.arguments.map(({ decision: _decision, ...argument }) => argument),
      flags: command.flags.map(({ decision: _decision, ...flag }) => flag),
    })),
    additionalEntries: definition.additionalEntries.map((entry) => ({
      path: entry.path,
      provenance: entry.provenance,
      profileAuthority: entry.profileAuthority,
      canonicalTarget: entry.canonicalTarget,
      package: entry.package,
      version: entry.version,
      versionKind: entry.versionKind,
      registered: entry.registered,
      publicManual: entry.publicManual,
    })),
  };
}

function classificationProjection(definition: LocalCliSurfaceContractDefinitionV1): unknown {
  return {
    runtime: {
      operationContractVersions: definition.runtime.operationContractVersions,
      operationInputTypes: definition.runtime.operationInputTypes,
    },
    globalFlags: definition.globalFlags.map((flag) => ({
      name: flag.name,
      source: flag.source,
      decision: flag.decision,
    })),
    commands: definition.commands.map((command) => ({
      path: command.path,
      provenance: command.provenance,
      reviewedEffect: command.reviewedEffect,
      decision: command.decision,
      pathSemanticInputs: command.pathSemanticInputs,
      arguments: command.arguments.map((argument) => ({ name: argument.name, decision: argument.decision })),
      flags: command.flags.map((flag) => ({ name: flag.name, source: flag.source, decision: flag.decision })),
    })),
    additionalEntries: definition.additionalEntries.map((entry) => ({
      path: entry.path,
      provenance: entry.provenance,
      decision: entry.decision,
    })),
  };
}

function semanticProfile(command: LocalCliSurfaceCommandDefinitionV1): unknown {
  return {
    path: command.path,
    provenance: command.provenance,
    profileAuthority: command.profileAuthority,
    package: command.package,
    version: command.version,
    versionKind: command.versionKind,
    registered: command.registered,
    upstreamReportedMutates: command.upstreamReportedMutates,
    reviewedEffect: command.reviewedEffect,
    arguments: command.arguments,
    flags: command.flags,
    decision: command.decision,
    pathSemanticInputs: command.pathSemanticInputs,
    output: command.output,
    conditionalInputs: command.conditionalInputs,
    reconciliation: command.reconciliation,
  };
}

function buildContract(
  definitionValue: unknown,
): LocalCliSurfaceContractV1 {
  const definition = parseDefinition(definitionValue);
  const commands = definition.commands.map((command) => Object.freeze({
    ...command,
    semanticProfileSha256: sha256(surfaceCanonicalJson(semanticProfile(command))),
  }));
  const semanticProfileMap = commands.map((command) => ({
    path: command.path,
    semanticProfileSha256: command.semanticProfileSha256,
  }));
  return Object.freeze({
    ...definition,
    commands: Object.freeze(commands),
    digests: Object.freeze({
      upstreamSurfaceSha256: sha256(surfaceCanonicalJson(upstreamProjection(definition))),
      classificationSha256: sha256(surfaceCanonicalJson(classificationProjection(definition))),
      semanticProfilesSha256: sha256(surfaceCanonicalJson(semanticProfileMap)),
      wholeSurfaceSha256: sha256(surfaceCanonicalJson(definition)),
    }),
  });
}

export function defineLocalCliSurfaceContractV1(
  definition: LocalCliSurfaceContractDefinitionV1,
): LocalCliSurfaceContractV1 {
  return buildContract(definition);
}

export function parseLocalCliSurfaceContractV1(
  value: unknown,
): LocalCliSurfaceContractV1 {
  const source = record(value, "local CLI surface contract");
  const suppliedDigests = record(source.digests, "local CLI surface contract.digests");
  exactKeys(suppliedDigests, [
    "upstreamSurfaceSha256", "classificationSha256", "semanticProfilesSha256", "wholeSurfaceSha256",
  ], [], "local CLI surface contract.digests");
  const parsed = buildContract(value);
  for (const key of [
    "upstreamSurfaceSha256", "classificationSha256", "semanticProfilesSha256", "wholeSurfaceSha256",
  ] as const) {
    if (sha(suppliedDigests[key], `local CLI surface contract.digests.${key}`) !== parsed.digests[key]) {
      throw new Error(`local CLI surface contract digest ${key} did not match its canonical content`);
    }
  }
  const suppliedCommands = array(source.commands, "local CLI surface contract.commands", 1_000);
  for (const [index, command] of suppliedCommands.entries()) {
    const commandSource = record(command, `local CLI surface contract.commands[${index}]`);
    if (
      sha(commandSource.semanticProfileSha256, `local CLI surface contract.commands[${index}].semanticProfileSha256`)
      !== parsed.commands[index]?.semanticProfileSha256
    ) throw new Error("local CLI surface command semantic profile digest did not match");
  }
  return parsed;
}
