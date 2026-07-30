/**
 * Code-owned policy primitives for future Meta Relay requests.
 *
 * This module performs no network I/O and contains no live registered-operation
 * revisions. A caller can only build a request template from a reviewed
 * descriptor; capture-required descriptors remain inert. Bootstrap secrets are
 * deliberately absent: descriptors declare their exact source-to-sink flow so
 * a separate opaque bootstrap boundary can write them directly to the request.
 */

import { canonicalJson, sha256 } from "../canonical-json";

export const META_RELAY_ORIGINS = Object.freeze({
  facebook: "https://www.facebook.com",
  instagram: "https://www.instagram.com",
  threads: "https://www.threads.com",
} as const);

export type MetaRelayPlatform = keyof typeof META_RELAY_ORIGINS;
export type MetaRelayOrigin = (typeof META_RELAY_ORIGINS)[MetaRelayPlatform];
export type MetaOperationType = "query" | "mutation";
export type MetaAccessKind = "personal" | "page" | "group" | "marketplace";

export type MetaDescriptorContract =
  | {
    readonly state: "capture-required";
    readonly contractVersion: number;
    readonly reason: string;
  }
  | {
    readonly state: "observed";
    readonly contractVersion: number;
    readonly evidenceId: string;
  };

export type MetaAccessPolicy = {
  readonly kind: MetaAccessKind;
  readonly actorBinding: "viewer" | "target";
};

export type MetaAccessContext =
  | {
    readonly kind: "personal";
    readonly platform: MetaRelayPlatform;
    readonly viewerId: string;
    readonly actorId: string;
    readonly targetId: string;
  }
  | {
    readonly kind: "page" | "group" | "marketplace";
    readonly platform: "facebook";
    readonly viewerId: string;
    readonly actorId: string;
    readonly targetId: string;
  };

export type MetaViewerProofSink = "access.viewer-id" | "form.__user";
export type MetaActorProofSink = "access.actor-id" | "form.av";

export type MetaBootstrapProofDeclaration =
  | {
    readonly kind: "viewer";
    readonly source: "bootstrap.viewer";
    readonly sinks: readonly MetaViewerProofSink[];
  }
  | {
    readonly kind: "actor";
    readonly source: "bootstrap.actor";
    readonly sinks: readonly MetaActorProofSink[];
  }
  | {
    readonly kind: "fb_dtsg";
    readonly source: "bootstrap.fb_dtsg";
    readonly sinks: readonly ["form.fb_dtsg"];
  }
  | {
    readonly kind: "jazoest";
    readonly source: "derived.fb_dtsg-jazoest";
    readonly sinks: readonly ["form.jazoest"];
  }
  | {
    readonly kind: "lsd";
    readonly source: "bootstrap.lsd";
    readonly sinks: readonly ["form.lsd"];
  }
  | {
    readonly kind: "client-revision";
    readonly source: "bootstrap.client-revision";
    readonly sinks: readonly ["form.__rev"];
  }
  | {
    readonly kind: "hsi";
    readonly source: "bootstrap.hsi";
    readonly sinks: readonly ["form.__hsi"];
  }
  | {
    readonly kind: "comet-environment";
    readonly source: "bootstrap.comet-environment";
    readonly sinks: readonly ["form.__comet_req"];
  }
  | {
    readonly kind: "request-counter";
    readonly source: "session.request-counter";
    readonly sinks: readonly ["form.__req"];
  };

export type MetaJsonScalar = string | number | boolean | null;

export type MetaVariableSchema =
  | { readonly kind: "id" }
  | { readonly kind: "cursor" }
  | {
    readonly kind: "string";
    readonly minimumLength: number;
    readonly maximumLength: number;
  }
  | { readonly kind: "boolean" }
  | {
    readonly kind: "integer";
    readonly minimum: number;
    readonly maximum: number;
  }
  | {
    readonly kind: "number";
    readonly minimum: number;
    readonly maximum: number;
  }
  | {
    readonly kind: "enum";
    readonly values: readonly string[];
  }
  | {
    readonly kind: "literal";
    readonly value: MetaJsonScalar;
  }
  | {
    readonly kind: "nullable";
    readonly value: MetaVariableSchema;
  }
  | {
    readonly kind: "list";
    readonly items: MetaVariableSchema;
    readonly minimumItems: number;
    readonly maximumItems: number;
  }
  | {
    readonly kind: "object";
    readonly fields: readonly MetaNestedVariableField[];
  };

export type MetaNestedVariableField = {
  readonly name: string;
  readonly optional: boolean;
  readonly schema: MetaVariableSchema;
};

export type MetaVariableSource =
  | { readonly kind: "input"; readonly key: string }
  | { readonly kind: "viewer" }
  | { readonly kind: "actor" }
  | { readonly kind: "target" }
  | { readonly kind: "pagination" }
  | { readonly kind: "literal"; readonly value: MetaJsonScalar };

export type MetaVariableField = {
  readonly name: string;
  readonly optional: boolean;
  readonly source: MetaVariableSource;
  readonly schema: MetaVariableSchema;
};

export type MetaVariableDefinition = {
  readonly fields: readonly MetaVariableField[];
};

export type MetaPaginationPolicy =
  | { readonly kind: "none" }
  | {
    readonly kind: "cursor";
    readonly variableName: string;
  };

export type MetaQueryResponseRootVariant =
  | {
    readonly kind: "query-data" | "prefetch-data";
    readonly path: readonly string[];
  }
  | {
    readonly kind: "incremental-data";
    readonly label: string;
    readonly path: readonly string[];
  };

export type MetaMutationResponseRootVariant =
  | {
    readonly kind: "mutation-data";
    readonly path: readonly string[];
  }
  | {
    readonly kind: "incremental-data";
    readonly label: string;
    readonly path: readonly string[];
  };

export type MetaResponseRootVariant =
  | MetaQueryResponseRootVariant
  | MetaMutationResponseRootVariant;

export type MetaReadbackSchedule =
  | {
    readonly kind: "none";
    readonly reason: string;
  }
  | {
    readonly kind: "independent-query";
    readonly descriptorId: string;
    readonly after: "dispatch-response";
    readonly actorBinding: "same";
    readonly targetBinding: "same";
    readonly attempts: 1;
  };

export type MetaDispatchSchedule =
  | {
    readonly kind: "inert";
    readonly dispatches: readonly [];
    readonly readback: Extract<MetaReadbackSchedule, { readonly kind: "none" }>;
  }
  | {
    readonly kind: "single-dispatch";
    readonly dispatchId: string;
    readonly attempts: 1;
    readonly retry: "never";
    readonly readback: Extract<
      MetaReadbackSchedule,
      { readonly kind: "independent-query" }
    >;
  };

type MetaBaseDescriptor = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly platform: MetaRelayPlatform;
  readonly friendlyName: string;
  readonly docId: string;
  readonly origin: MetaRelayOrigin;
  readonly path: string;
  readonly contract: MetaDescriptorContract;
  readonly access: MetaAccessPolicy;
  readonly proofs: readonly MetaBootstrapProofDeclaration[];
  readonly variables: MetaVariableDefinition;
  readonly pagination: MetaPaginationPolicy;
};

export type MetaQueryOperationDescriptor = MetaBaseDescriptor & {
  readonly kind: "query";
  readonly operationType: "query";
  readonly method: "GET" | "POST";
  readonly responseRoots: readonly MetaQueryResponseRootVariant[];
};

export type MetaMutationOperationDescriptor = MetaBaseDescriptor & {
  readonly kind: "mutation";
  readonly operationType: "mutation";
  readonly method: "POST";
  readonly responseRoots: readonly MetaMutationResponseRootVariant[];
  readonly schedule: MetaDispatchSchedule;
};

export type MetaOperationDescriptor =
  | MetaQueryOperationDescriptor
  | MetaMutationOperationDescriptor;

export type MetaObservedOperationDescriptor = {
  readonly friendlyName: string;
  readonly docId: string;
  readonly operationType: MetaOperationType;
  readonly origin: MetaRelayOrigin;
  readonly method: "GET" | "POST";
  readonly path: string;
};

export type MetaPaginationCursor = {
  readonly schemaVersion: 1;
  readonly descriptorKey: string;
  readonly actorId: string;
  readonly targetId: string;
  readonly cursor: string;
  readonly previousCursor: string | null;
};

export type MetaRelayRequestBuildInput = {
  readonly input: unknown;
  readonly access: MetaAccessContext;
  readonly pagination?: MetaPaginationCursor | null;
};

export type MetaRelayRequestParameter = {
  readonly name: "fb_api_req_friendly_name" | "doc_id" | "variables";
  readonly value: string;
};

export type MetaRelayProofFormFieldName =
  | "__user"
  | "av"
  | "fb_dtsg"
  | "jazoest"
  | "lsd"
  | "__rev"
  | "__hsi"
  | "__comet_req"
  | "__req";

export type MetaRelayRequest = {
  readonly descriptorId: string;
  readonly operationType: MetaOperationType;
  readonly origin: MetaRelayOrigin;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly url: string;
  readonly parameterLocation: "query" | "form";
  readonly parameters: readonly MetaRelayRequestParameter[];
  readonly proofBindings: readonly MetaBootstrapProofDeclaration[];
  readonly proofFormFields: readonly MetaRelayProofFormFieldName[];
  readonly access: MetaAccessContext;
  readonly pagination: MetaPaginationCursor | null;
  readonly schedule: MetaDispatchSchedule | null;
};

export type MetaRelayRequestProofCoordinates = {
  readonly descriptorKey: string;
  readonly viewerId: string;
  readonly actorId: string;
  readonly targetId: string;
  readonly proofFormFields: readonly MetaRelayProofFormFieldName[];
};

export type MetaRelayResponseBinding = {
  readonly descriptorId: string;
  readonly operationType: MetaOperationType;
  readonly variant: MetaResponseRootVariant;
  readonly value: unknown;
};

const issuedRelayRequestCoordinates = new WeakMap<
  MetaRelayRequest,
  MetaRelayRequestProofCoordinates
>();

type JsonRecord = Record<string, unknown>;

const issuedPaginationCursors = new WeakSet<object>();
const EMPTY_DISPATCHES: readonly [] = Object.freeze([]);

const EXPECTED_ORIGIN = {
  facebook: META_RELAY_ORIGINS.facebook,
  instagram: META_RELAY_ORIGINS.instagram,
  threads: META_RELAY_ORIGINS.threads,
} as const satisfies Readonly<Record<MetaRelayPlatform, MetaRelayOrigin>>;

const EXPECTED_RELAY_PATHS = Object.freeze({
  facebook: Object.freeze(["/api/graphql/"]),
  instagram: Object.freeze(["/api/graphql", "/api/graphql/"]),
  threads: Object.freeze(["/api/graphql", "/api/graphql/"]),
} as const satisfies Readonly<Record<MetaRelayPlatform, readonly string[]>>);

const PROOF_SOURCES = Object.freeze({
  viewer: "bootstrap.viewer",
  actor: "bootstrap.actor",
  fb_dtsg: "bootstrap.fb_dtsg",
  jazoest: "derived.fb_dtsg-jazoest",
  lsd: "bootstrap.lsd",
  "client-revision": "bootstrap.client-revision",
  hsi: "bootstrap.hsi",
  "comet-environment": "bootstrap.comet-environment",
  "request-counter": "session.request-counter",
} as const);

const PROOF_SINKS = Object.freeze({
  viewer: Object.freeze(["access.viewer-id", "form.__user"]),
  actor: Object.freeze(["access.actor-id", "form.av"]),
  fb_dtsg: Object.freeze(["form.fb_dtsg"]),
  jazoest: Object.freeze(["form.jazoest"]),
  lsd: Object.freeze(["form.lsd"]),
  "client-revision": Object.freeze(["form.__rev"]),
  hsi: Object.freeze(["form.__hsi"]),
  "comet-environment": Object.freeze(["form.__comet_req"]),
  "request-counter": Object.freeze(["form.__req"]),
} as const);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0) throw new Error(`${label} omitted ${missing.join(", ")}`);
  if (extra.length > 0) {
    throw new Error(`${label} contained unsupported field(s): ${extra.join(", ")}`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boundedFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function exactIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`${label} must be an exact bounded Meta identifier`);
  }
  return value;
}

function exactCursor(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new Error(`${label} must be an exact bounded opaque cursor`);
  }
  return value;
}

function exactFieldName(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)
    || value === "__proto__"
    || value === "constructor"
    || value === "prototype"
  ) {
    throw new Error(`${label} must be an exact variable field name`);
  }
  return value;
}

function exactDescriptorId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[a-z][a-z0-9.-]{2,127}$/u.test(value)
  ) {
    throw new Error(`${label} must be a stable code-owned descriptor ID`);
  }
  return value;
}

export function assertMetaFriendlyName(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z][A-Za-z0-9_]{2,160}$/u.test(value)
  ) {
    throw new Error("Meta friendlyName must match the reviewed Relay operation-name grammar");
  }
  return value;
}

export function assertMetaDocId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{5,32}$/u.test(value)) {
    throw new Error("Meta docId must be an exact 5-32 digit registered-operation revision");
  }
  return value;
}

function exactPlatform(value: unknown, label: string): MetaRelayPlatform {
  if (value !== "facebook" && value !== "instagram" && value !== "threads") {
    throw new Error(`${label} must be facebook, instagram, or threads`);
  }
  return value;
}

function exactOperationType(value: unknown, label: string): MetaOperationType {
  if (value !== "query" && value !== "mutation") {
    throw new Error(`${label} must be query or mutation`);
  }
  return value;
}

function exactMethod(value: unknown, label: string): "GET" | "POST" {
  if (value !== "GET" && value !== "POST") {
    throw new Error(`${label} must be exactly GET or POST`);
  }
  return value;
}

function exactOrigin(
  value: unknown,
  platform: MetaRelayPlatform,
  label: string,
): MetaRelayOrigin {
  const expected = EXPECTED_ORIGIN[platform];
  if (value !== expected) {
    throw new Error(`${label} must be the exact ${platform} first-party origin`);
  }
  return expected;
}

function exactPath(value: unknown, platform: MetaRelayPlatform, label: string): string {
  if (
    typeof value !== "string"
    || !EXPECTED_RELAY_PATHS[platform].includes(value)
  ) {
    throw new Error(`${label} must be an exact reviewed ${platform} Relay path`);
  }
  return value;
}

function parseContract(value: unknown, label: string): MetaDescriptorContract {
  const candidate = record(value, label);
  if (candidate.state === "capture-required") {
    exactKeys(candidate, ["state", "contractVersion", "reason"], [], label);
    return Object.freeze({
      state: "capture-required",
      contractVersion: boundedInteger(
        candidate.contractVersion,
        `${label}.contractVersion`,
        1,
        1_000_000,
      ),
      reason: boundedString(candidate.reason, `${label}.reason`, 1, 1_024),
    });
  }
  if (candidate.state === "observed") {
    exactKeys(candidate, ["state", "contractVersion", "evidenceId"], [], label);
    return Object.freeze({
      state: "observed",
      contractVersion: boundedInteger(
        candidate.contractVersion,
        `${label}.contractVersion`,
        1,
        1_000_000,
      ),
      evidenceId: boundedString(candidate.evidenceId, `${label}.evidenceId`, 1, 256),
    });
  }
  throw new Error(`${label}.state must be observed or capture-required`);
}

function parseAccessPolicy(
  value: unknown,
  platform: MetaRelayPlatform,
  label: string,
): MetaAccessPolicy {
  const candidate = record(value, label);
  exactKeys(candidate, ["kind", "actorBinding"], [], label);
  const kind = candidate.kind;
  if (
    kind !== "personal"
    && kind !== "page"
    && kind !== "group"
    && kind !== "marketplace"
  ) {
    throw new Error(`${label}.kind must be personal, page, group, or marketplace`);
  }
  if (kind !== "personal" && platform !== "facebook") {
    throw new Error(`${label}.${kind} access is available only on facebook`);
  }
  if (candidate.actorBinding !== "viewer" && candidate.actorBinding !== "target") {
    throw new Error(`${label}.actorBinding must be viewer or target`);
  }
  if (kind !== "page" && candidate.actorBinding !== "viewer") {
    throw new Error(`${label}.${kind} access must bind its actor to the viewer`);
  }
  return Object.freeze({ kind, actorBinding: candidate.actorBinding });
}

function parseProofDeclarations(
  value: unknown,
  method: "GET" | "POST",
  label: string,
): readonly MetaBootstrapProofDeclaration[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const results: MetaBootstrapProofDeclaration[] = [];
  const kinds = new Set<string>();
  const allSinks = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemLabel = `${label}[${index}]`;
    const candidate = record(item, itemLabel);
    exactKeys(candidate, ["kind", "source", "sinks"], [], itemLabel);
    const kind = candidate.kind;
    if (
      kind !== "viewer"
      && kind !== "actor"
      && kind !== "fb_dtsg"
      && kind !== "jazoest"
      && kind !== "lsd"
      && kind !== "client-revision"
      && kind !== "hsi"
      && kind !== "comet-environment"
      && kind !== "request-counter"
    ) {
      throw new Error(`${itemLabel}.kind is not a reviewed Meta bootstrap proof`);
    }
    if (kinds.has(kind)) throw new Error(`${label} contained duplicate ${kind} proof`);
    kinds.add(kind);
    if (candidate.source !== PROOF_SOURCES[kind]) {
      throw new Error(`${itemLabel}.source did not match the ${kind} proof source`);
    }
    if (!Array.isArray(candidate.sinks) || candidate.sinks.length < 1) {
      throw new Error(`${itemLabel}.sinks must be a non-empty array`);
    }
    const allowedSinks: readonly string[] = PROOF_SINKS[kind];
    const sinks: string[] = [];
    for (const sink of candidate.sinks) {
      if (typeof sink !== "string" || !allowedSinks.includes(sink)) {
        throw new Error(`${itemLabel} declared an invalid ${kind} proof sink`);
      }
      if (sinks.includes(sink)) throw new Error(`${itemLabel} contained a duplicate proof sink`);
      if (allSinks.has(sink)) throw new Error(`${label} bound one proof sink more than once`);
      if (method === "GET" && sink.startsWith("form.")) {
        throw new Error(`${itemLabel} may not bind a form proof sink to GET`);
      }
      sinks.push(sink);
      allSinks.add(sink);
    }
    results.push(Object.freeze({
      kind,
      source: PROOF_SOURCES[kind],
      sinks: Object.freeze(sinks),
    }) as MetaBootstrapProofDeclaration);
  }
  if (!allSinks.has("access.viewer-id")) {
    throw new Error(`${label} must bind bootstrap.viewer to access.viewer-id`);
  }
  if (!allSinks.has("access.actor-id")) {
    throw new Error(`${label} must bind bootstrap.actor to access.actor-id`);
  }
  return Object.freeze(results);
}

function parseJsonScalar(value: unknown, label: string): MetaJsonScalar {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error(`${label} must be a JSON scalar`);
}

function parseNestedFields(
  value: unknown,
  label: string,
  depth: number,
): readonly MetaNestedVariableField[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > 128) throw new Error(`${label} exceeded its reviewed field bound`);
  const names = new Set<string>();
  const fields: MetaNestedVariableField[] = [];
  for (const [index, item] of value.entries()) {
    const itemLabel = `${label}[${index}]`;
    const candidate = record(item, itemLabel);
    exactKeys(candidate, ["name", "optional", "schema"], [], itemLabel);
    const name = exactFieldName(candidate.name, `${itemLabel}.name`);
    if (names.has(name)) throw new Error(`${label} contained duplicate field ${name}`);
    names.add(name);
    if (typeof candidate.optional !== "boolean") {
      throw new Error(`${itemLabel}.optional must be boolean`);
    }
    fields.push(Object.freeze({
      name,
      optional: candidate.optional,
      schema: parseVariableSchema(candidate.schema, `${itemLabel}.schema`, depth + 1),
    }));
  }
  return Object.freeze(fields);
}

function parseVariableSchema(
  value: unknown,
  label: string,
  depth = 0,
): MetaVariableSchema {
  if (depth > 12) throw new Error(`${label} exceeded the reviewed schema depth`);
  const candidate = record(value, label);
  switch (candidate.kind) {
    case "id":
    case "cursor":
    case "boolean":
      exactKeys(candidate, ["kind"], [], label);
      return Object.freeze({ kind: candidate.kind });
    case "string": {
      exactKeys(candidate, ["kind", "minimumLength", "maximumLength"], [], label);
      const minimumLength = boundedInteger(
        candidate.minimumLength,
        `${label}.minimumLength`,
        0,
        1_000_000,
      );
      const maximumLength = boundedInteger(
        candidate.maximumLength,
        `${label}.maximumLength`,
        0,
        1_000_000,
      );
      if (maximumLength < minimumLength) {
        throw new Error(`${label}.maximumLength must not be below minimumLength`);
      }
      return Object.freeze({ kind: "string", minimumLength, maximumLength });
    }
    case "integer":
    case "number": {
      exactKeys(candidate, ["kind", "minimum", "maximum"], [], label);
      const minimum = candidate.kind === "integer"
        ? boundedInteger(
          candidate.minimum,
          `${label}.minimum`,
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        )
        : boundedFiniteNumber(candidate.minimum, `${label}.minimum`);
      const maximum = candidate.kind === "integer"
        ? boundedInteger(
          candidate.maximum,
          `${label}.maximum`,
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        )
        : boundedFiniteNumber(candidate.maximum, `${label}.maximum`);
      if (maximum < minimum) throw new Error(`${label}.maximum must not be below minimum`);
      return Object.freeze({ kind: candidate.kind, minimum, maximum });
    }
    case "enum": {
      exactKeys(candidate, ["kind", "values"], [], label);
      if (!Array.isArray(candidate.values) || candidate.values.length < 1) {
        throw new Error(`${label}.values must be a non-empty array`);
      }
      const values = candidate.values.map((item, index) => (
        boundedString(item, `${label}.values[${index}]`, 1, 256)
      ));
      if (new Set(values).size !== values.length) {
        throw new Error(`${label}.values contained duplicates`);
      }
      return Object.freeze({ kind: "enum", values: Object.freeze(values) });
    }
    case "literal":
      exactKeys(candidate, ["kind", "value"], [], label);
      return Object.freeze({
        kind: "literal",
        value: parseJsonScalar(candidate.value, `${label}.value`),
      });
    case "nullable":
      exactKeys(candidate, ["kind", "value"], [], label);
      return Object.freeze({
        kind: "nullable",
        value: parseVariableSchema(candidate.value, `${label}.value`, depth + 1),
      });
    case "list": {
      exactKeys(candidate, ["kind", "items", "minimumItems", "maximumItems"], [], label);
      const minimumItems = boundedInteger(
        candidate.minimumItems,
        `${label}.minimumItems`,
        0,
        10_000,
      );
      const maximumItems = boundedInteger(
        candidate.maximumItems,
        `${label}.maximumItems`,
        0,
        10_000,
      );
      if (maximumItems < minimumItems) {
        throw new Error(`${label}.maximumItems must not be below minimumItems`);
      }
      return Object.freeze({
        kind: "list",
        items: parseVariableSchema(candidate.items, `${label}.items`, depth + 1),
        minimumItems,
        maximumItems,
      });
    }
    case "object":
      exactKeys(candidate, ["kind", "fields"], [], label);
      return Object.freeze({
        kind: "object",
        fields: parseNestedFields(candidate.fields, `${label}.fields`, depth),
      });
    default:
      throw new Error(`${label}.kind is not a reviewed Meta variable schema`);
  }
}

function parseVariableSource(value: unknown, label: string): MetaVariableSource {
  const candidate = record(value, label);
  switch (candidate.kind) {
    case "input":
      exactKeys(candidate, ["kind", "key"], [], label);
      return Object.freeze({
        kind: "input",
        key: exactFieldName(candidate.key, `${label}.key`),
      });
    case "viewer":
    case "actor":
    case "target":
    case "pagination":
      exactKeys(candidate, ["kind"], [], label);
      return Object.freeze({ kind: candidate.kind });
    case "literal":
      exactKeys(candidate, ["kind", "value"], [], label);
      return Object.freeze({
        kind: "literal",
        value: parseJsonScalar(candidate.value, `${label}.value`),
      });
    default:
      throw new Error(`${label}.kind is not a reviewed Meta variable source`);
  }
}

function schemaAcceptsKind(
  schema: MetaVariableSchema,
  kind: "id" | "cursor",
): boolean {
  return schema.kind === kind
    || (schema.kind === "nullable" && schemaAcceptsKind(schema.value, kind));
}

function parseVariableDefinition(value: unknown, label: string): MetaVariableDefinition {
  const candidate = record(value, label);
  exactKeys(candidate, ["fields"], [], label);
  if (!Array.isArray(candidate.fields) || candidate.fields.length > 128) {
    throw new Error(`${label}.fields must be a bounded array`);
  }
  const names = new Set<string>();
  const fields: MetaVariableField[] = [];
  for (const [index, item] of candidate.fields.entries()) {
    const itemLabel = `${label}.fields[${index}]`;
    const field = record(item, itemLabel);
    exactKeys(field, ["name", "optional", "source", "schema"], [], itemLabel);
    const name = exactFieldName(field.name, `${itemLabel}.name`);
    if (names.has(name)) throw new Error(`${label}.fields contained duplicate field ${name}`);
    names.add(name);
    if (typeof field.optional !== "boolean") {
      throw new Error(`${itemLabel}.optional must be boolean`);
    }
    const source = parseVariableSource(field.source, `${itemLabel}.source`);
    const schema = parseVariableSchema(field.schema, `${itemLabel}.schema`);
    if (
      (source.kind === "viewer" || source.kind === "actor" || source.kind === "target")
      && !schemaAcceptsKind(schema, "id")
    ) {
      throw new Error(`${itemLabel} identity source requires an id schema`);
    }
    if (source.kind === "pagination") {
      if (!field.optional || !schemaAcceptsKind(schema, "cursor")) {
        throw new Error(`${itemLabel} pagination source requires an optional cursor schema`);
      }
    }
    if (source.kind === "literal") {
      validateVariableValue(schema, source.value, `${itemLabel}.source.value`);
    }
    fields.push(Object.freeze({ name, optional: field.optional, source, schema }));
  }
  return Object.freeze({ fields: Object.freeze(fields) });
}

function parsePaginationPolicy(
  value: unknown,
  variables: MetaVariableDefinition,
  label: string,
): MetaPaginationPolicy {
  const candidate = record(value, label);
  if (candidate.kind === "none") {
    exactKeys(candidate, ["kind"], [], label);
    if (variables.fields.some((field) => field.source.kind === "pagination")) {
      throw new Error(`${label} none cannot declare a pagination variable`);
    }
    return Object.freeze({ kind: "none" });
  }
  if (candidate.kind === "cursor") {
    exactKeys(candidate, ["kind", "variableName"], [], label);
    const variableName = exactFieldName(candidate.variableName, `${label}.variableName`);
    const cursorFields = variables.fields.filter((field) => field.source.kind === "pagination");
    if (cursorFields.length !== 1 || cursorFields[0]?.name !== variableName) {
      throw new Error(`${label} must bind exactly one matching pagination variable`);
    }
    return Object.freeze({ kind: "cursor", variableName });
  }
  throw new Error(`${label}.kind must be none or cursor`);
}

function parsePath(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error(`${label} must be a non-empty bounded path`);
  }
  return Object.freeze(value.map((segment, index) => (
    exactFieldName(segment, `${label}[${index}]`)
  )));
}

function parseResponseRoots(
  value: unknown,
  operationType: MetaOperationType,
  label: string,
): readonly MetaResponseRootVariant[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error(`${label} must be a non-empty bounded array`);
  }
  const roots: MetaResponseRootVariant[] = [];
  const keys = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemLabel = `${label}[${index}]`;
    const candidate = record(item, itemLabel);
    const kind = candidate.kind;
    if (kind === "incremental-data") {
      exactKeys(candidate, ["kind", "label", "path"], [], itemLabel);
      const root = Object.freeze({
        kind,
        label: exactFieldName(candidate.label, `${itemLabel}.label`),
        path: parsePath(candidate.path, `${itemLabel}.path`),
      });
      const key = `${root.kind}:${root.label}:${root.path.join(".")}`;
      if (keys.has(key)) throw new Error(`${label} contained duplicate response root`);
      keys.add(key);
      roots.push(root);
      continue;
    }
    exactKeys(candidate, ["kind", "path"], [], itemLabel);
    const allowed = operationType === "query"
      ? kind === "query-data" || kind === "prefetch-data"
      : kind === "mutation-data";
    if (!allowed) {
      throw new Error(`${itemLabel}.kind did not agree with ${operationType}`);
    }
    const root = Object.freeze({
      kind,
      path: parsePath(candidate.path, `${itemLabel}.path`),
    }) as MetaResponseRootVariant;
    const key = `${root.kind}:${root.path.join(".")}`;
    if (keys.has(key)) throw new Error(`${label} contained duplicate response root`);
    keys.add(key);
    roots.push(root);
  }
  return Object.freeze(roots);
}

function parseReadbackSchedule(value: unknown, label: string): MetaReadbackSchedule {
  const candidate = record(value, label);
  if (candidate.kind === "none") {
    exactKeys(candidate, ["kind", "reason"], [], label);
    return Object.freeze({
      kind: "none",
      reason: boundedString(candidate.reason, `${label}.reason`, 1, 1_024),
    });
  }
  if (candidate.kind === "independent-query") {
    exactKeys(
      candidate,
      [
        "kind",
        "descriptorId",
        "after",
        "actorBinding",
        "targetBinding",
        "attempts",
      ],
      [],
      label,
    );
    if (
      candidate.after !== "dispatch-response"
      || candidate.actorBinding !== "same"
      || candidate.targetBinding !== "same"
      || candidate.attempts !== 1
    ) {
      throw new Error(`${label} must be one same-actor, same-target independent readback`);
    }
    return Object.freeze({
      kind: "independent-query",
      descriptorId: exactDescriptorId(candidate.descriptorId, `${label}.descriptorId`),
      after: "dispatch-response",
      actorBinding: "same",
      targetBinding: "same",
      attempts: 1,
    });
  }
  throw new Error(`${label}.kind must be none or independent-query`);
}

function parseDispatchSchedule(value: unknown, label: string): MetaDispatchSchedule {
  const candidate = record(value, label);
  if (candidate.kind === "inert") {
    exactKeys(candidate, ["kind", "dispatches", "readback"], [], label);
    if (!Array.isArray(candidate.dispatches) || candidate.dispatches.length !== 0) {
      throw new Error(`${label}.dispatches must be exactly empty while inert`);
    }
    const readback = parseReadbackSchedule(candidate.readback, `${label}.readback`);
    if (readback.kind !== "none") throw new Error(`${label}.inert schedule cannot read back`);
    return Object.freeze({
      kind: "inert",
      dispatches: EMPTY_DISPATCHES,
      readback,
    });
  }
  if (candidate.kind === "single-dispatch") {
    exactKeys(
      candidate,
      ["kind", "dispatchId", "attempts", "retry", "readback"],
      [],
      label,
    );
    if (candidate.attempts !== 1 || candidate.retry !== "never") {
      throw new Error(`${label} must be one non-retried dispatch`);
    }
    const readback = parseReadbackSchedule(candidate.readback, `${label}.readback`);
    if (readback.kind !== "independent-query") {
      throw new Error(`${label} requires an independent query readback`);
    }
    return Object.freeze({
      kind: "single-dispatch",
      dispatchId: exactDescriptorId(candidate.dispatchId, `${label}.dispatchId`),
      attempts: 1,
      retry: "never",
      readback,
    });
  }
  throw new Error(`${label}.kind must be inert or single-dispatch`);
}

export function defineMetaOperationDescriptor(value: unknown): MetaOperationDescriptor {
  const candidate = record(value, "Meta operation descriptor");
  const shared = [
    "schemaVersion",
    "id",
    "platform",
    "kind",
    "operationType",
    "friendlyName",
    "docId",
    "origin",
    "method",
    "path",
    "contract",
    "access",
    "proofs",
    "variables",
    "pagination",
    "responseRoots",
  ] as const;
  if (candidate.kind === "query") {
    exactKeys(candidate, shared, [], "Meta query descriptor");
  } else if (candidate.kind === "mutation") {
    exactKeys(candidate, [...shared, "schedule"], [], "Meta mutation descriptor");
  } else {
    throw new Error("Meta operation descriptor.kind must be query or mutation");
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error("Meta operation descriptor.schemaVersion must be 1");
  }
  const platform = exactPlatform(candidate.platform, "Meta operation descriptor.platform");
  const operationType = exactOperationType(
    candidate.operationType,
    "Meta operation descriptor.operationType",
  );
  if (candidate.kind !== operationType) {
    throw new Error("Meta descriptor kind and operationType did not agree");
  }
  const method = exactMethod(candidate.method, "Meta operation descriptor.method");
  if (operationType === "mutation" && method !== "POST") {
    throw new Error("Meta Relay mutations require POST");
  }
  const origin = exactOrigin(candidate.origin, platform, "Meta operation descriptor.origin");
  const path = exactPath(candidate.path, platform, "Meta operation descriptor.path");
  const contract = parseContract(candidate.contract, "Meta operation descriptor.contract");
  const access = parseAccessPolicy(
    candidate.access,
    platform,
    "Meta operation descriptor.access",
  );
  const proofs = parseProofDeclarations(
    candidate.proofs,
    method,
    "Meta operation descriptor.proofs",
  );
  const variables = parseVariableDefinition(
    candidate.variables,
    "Meta operation descriptor.variables",
  );
  const pagination = parsePaginationPolicy(
    candidate.pagination,
    variables,
    "Meta operation descriptor.pagination",
  );
  const id = exactDescriptorId(candidate.id, "Meta operation descriptor.id");
  const common = {
    schemaVersion: 1 as const,
    id,
    platform,
    friendlyName: assertMetaFriendlyName(candidate.friendlyName),
    docId: assertMetaDocId(candidate.docId),
    origin,
    method,
    path,
    contract,
    access,
    proofs,
    variables,
    pagination,
  };
  if (operationType === "query") {
    return Object.freeze({
      ...common,
      kind: "query",
      operationType: "query",
      method,
      responseRoots: parseResponseRoots(
        candidate.responseRoots,
        "query",
        "Meta operation descriptor.responseRoots",
      ) as readonly MetaQueryResponseRootVariant[],
    });
  }
  const schedule = parseDispatchSchedule(
    candidate.schedule,
    "Meta operation descriptor.schedule",
  );
  if (contract.state === "capture-required" && schedule.kind !== "inert") {
    throw new Error("capture-required Meta mutations must have an inert schedule");
  }
  if (contract.state === "observed" && schedule.kind !== "single-dispatch") {
    throw new Error("observed Meta mutations require one exact dispatch and readback schedule");
  }
  if (
    schedule.kind === "single-dispatch"
    && schedule.readback.descriptorId === id
  ) {
    throw new Error("Meta mutation readback must use a separate query descriptor");
  }
  return Object.freeze({
    ...common,
    kind: "mutation",
    operationType: "mutation",
    method: "POST",
    responseRoots: parseResponseRoots(
      candidate.responseRoots,
      "mutation",
      "Meta operation descriptor.responseRoots",
    ) as readonly MetaMutationResponseRootVariant[],
    schedule,
  });
}

function parseObservedDescriptor(
  value: unknown,
  label: string,
): MetaObservedOperationDescriptor {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    ["friendlyName", "docId", "operationType", "origin", "method", "path"],
    [],
    label,
  );
  const origin = candidate.origin;
  let platform: MetaRelayPlatform;
  if (origin === META_RELAY_ORIGINS.facebook) platform = "facebook";
  else if (origin === META_RELAY_ORIGINS.instagram) platform = "instagram";
  else if (origin === META_RELAY_ORIGINS.threads) platform = "threads";
  else throw new Error(`${label}.origin is not an exact Meta first-party origin`);
  return Object.freeze({
    friendlyName: assertMetaFriendlyName(candidate.friendlyName),
    docId: assertMetaDocId(candidate.docId),
    operationType: exactOperationType(candidate.operationType, `${label}.operationType`),
    origin: exactOrigin(candidate.origin, platform, `${label}.origin`),
    method: exactMethod(candidate.method, `${label}.method`),
    path: exactPath(candidate.path, platform, `${label}.path`),
  });
}

/**
 * Resolve one current observed operation against a code-owned descriptor.
 * Duplicate candidates, type/transport drift, and revision drift fail closed.
 */
export function resolveMetaOperationDescriptor(
  candidatesValue: unknown,
  expectedValue: MetaOperationDescriptor,
): MetaObservedOperationDescriptor {
  if (!Array.isArray(candidatesValue)) {
    throw new Error("observed Meta descriptors must be an array");
  }
  const expected = defineMetaOperationDescriptor(expectedValue);
  const candidates = candidatesValue.map((candidate, index) => (
    parseObservedDescriptor(candidate, `observed Meta descriptor ${index + 1}`)
  ));
  const named = candidates.filter(
    (candidate) => candidate.friendlyName === expected.friendlyName,
  );
  if (named.length === 0) {
    throw new Error(`observed Meta descriptors omitted ${expected.friendlyName}`);
  }
  if (named.some((candidate) => candidate.operationType !== expected.operationType)) {
    throw new Error(`Meta operation-type drift for ${expected.friendlyName}`);
  }
  const typed = named.filter(
    (candidate) => candidate.operationType === expected.operationType,
  );
  if (
    typed.some((candidate) => (
      candidate.origin !== expected.origin
      || candidate.method !== expected.method
      || candidate.path !== expected.path
    ))
  ) {
    throw new Error(`Meta transport drift for ${expected.friendlyName}`);
  }
  if (typed.length > 1) {
    const revisions = new Set(typed.map((candidate) => candidate.docId));
    if (revisions.size === 1) {
      throw new Error(`observed Meta descriptors contained duplicate ${expected.friendlyName}`);
    }
    throw new Error(`observed Meta descriptors contained ambiguous revision drift for ${expected.friendlyName}`);
  }
  const resolved = typed[0];
  if (resolved === undefined) {
    throw new Error(`observed Meta descriptors omitted ${expected.friendlyName}`);
  }
  if (resolved.docId !== expected.docId) {
    throw new Error(`Meta docId drift for ${expected.friendlyName}; reviewed evidence is stale`);
  }
  return resolved;
}

export function metaOperationDescriptorKey(value: MetaOperationDescriptor): string {
  const descriptor = defineMetaOperationDescriptor(value);
  return `meta1:${sha256(canonicalJson(descriptor))}`;
}

export function bindMetaAccessContext(
  descriptorValue: MetaOperationDescriptor,
  value: unknown,
): MetaAccessContext {
  const descriptor = defineMetaOperationDescriptor(descriptorValue);
  const candidate = record(value, "Meta access context");
  exactKeys(
    candidate,
    ["kind", "platform", "viewerId", "actorId", "targetId"],
    [],
    "Meta access context",
  );
  if (candidate.kind !== descriptor.access.kind) {
    throw new Error("Meta access context kind did not match its descriptor");
  }
  if (candidate.platform !== descriptor.platform) {
    throw new Error("Meta access context platform did not match its descriptor");
  }
  const viewerId = exactIdentifier(candidate.viewerId, "Meta access context.viewerId");
  const actorId = exactIdentifier(candidate.actorId, "Meta access context.actorId");
  const targetId = exactIdentifier(candidate.targetId, "Meta access context.targetId");
  const expectedActor = descriptor.access.actorBinding === "viewer" ? viewerId : targetId;
  if (actorId !== expectedActor) {
    throw new Error(
      `Meta ${descriptor.access.kind} actor did not match its ${descriptor.access.actorBinding}`,
    );
  }
  if (descriptor.access.kind === "personal") {
    return Object.freeze({
      kind: "personal",
      platform: descriptor.platform,
      viewerId,
      actorId,
      targetId,
    });
  }
  if (descriptor.platform !== "facebook") {
    throw new Error(`Meta ${descriptor.access.kind} access is available only on facebook`);
  }
  return Object.freeze({
    kind: descriptor.access.kind,
    platform: "facebook",
    viewerId,
    actorId,
    targetId,
  });
}

function validateVariableValue(
  schema: MetaVariableSchema,
  value: unknown,
  label: string,
): unknown {
  switch (schema.kind) {
    case "id":
      return exactIdentifier(value, label);
    case "cursor":
      return exactCursor(value, label);
    case "string":
      return boundedString(value, label, schema.minimumLength, schema.maximumLength);
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
      return value;
    case "integer":
      return boundedInteger(value, label, schema.minimum, schema.maximum);
    case "number": {
      const number = boundedFiniteNumber(value, label);
      if (number < schema.minimum || number > schema.maximum) {
        throw new Error(`${label} must be a number between ${schema.minimum} and ${schema.maximum}`);
      }
      return number;
    }
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) {
        throw new Error(`${label} must be one exact reviewed enum value`);
      }
      return value;
    case "literal":
      if (!Object.is(value, schema.value)) throw new Error(`${label} did not match its exact literal`);
      return schema.value;
    case "nullable":
      return value === null ? null : validateVariableValue(schema.value, value, label);
    case "list": {
      if (
        !Array.isArray(value)
        || value.length < schema.minimumItems
        || value.length > schema.maximumItems
      ) {
        throw new Error(`${label} must be a bounded array`);
      }
      return Object.freeze(value.map((item, index) => (
        validateVariableValue(schema.items, item, `${label}[${index}]`)
      )));
    }
    case "object": {
      const source = record(value, label);
      const required = schema.fields
        .filter((field) => !field.optional)
        .map((field) => field.name);
      const optional = schema.fields
        .filter((field) => field.optional)
        .map((field) => field.name);
      exactKeys(source, required, optional, label);
      const result: Record<string, unknown> = {};
      for (const field of schema.fields) {
        if (!Object.hasOwn(source, field.name)) continue;
        result[field.name] = validateVariableValue(
          field.schema,
          source[field.name],
          `${label}.${field.name}`,
        );
      }
      return Object.freeze(result);
    }
  }
}

function assertPaginationCursorBinding(
  descriptor: MetaOperationDescriptor,
  access: MetaAccessContext,
  value: unknown,
): MetaPaginationCursor {
  if (descriptor.pagination.kind !== "cursor") {
    throw new Error("Meta operation does not permit pagination");
  }
  if (!isRecord(value) || !issuedPaginationCursors.has(value)) {
    throw new Error("Meta pagination cursor was not issued by the binding policy");
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "descriptorKey",
      "actorId",
      "targetId",
      "cursor",
      "previousCursor",
    ],
    [],
    "Meta pagination cursor",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("Meta pagination cursor schemaVersion must be 1");
  }
  if (value.descriptorKey !== metaOperationDescriptorKey(descriptor)) {
    throw new Error("Meta pagination cursor did not match its descriptor");
  }
  if (value.actorId !== access.actorId) {
    throw new Error("Meta pagination cursor did not match its actor");
  }
  if (value.targetId !== access.targetId) {
    throw new Error("Meta pagination cursor did not match its target");
  }
  const cursor = exactCursor(value.cursor, "Meta pagination cursor.cursor");
  const previousCursor = value.previousCursor === null
    ? null
    : exactCursor(value.previousCursor, "Meta pagination cursor.previousCursor");
  if (cursor === previousCursor) {
    throw new Error("Meta pagination cursor did not advance");
  }
  return value as MetaPaginationCursor;
}

export function assertMetaPaginationCursorBinding(
  descriptorValue: MetaOperationDescriptor,
  accessValue: unknown,
  cursorValue: unknown,
): MetaPaginationCursor {
  const descriptor = defineMetaOperationDescriptor(descriptorValue);
  const access = bindMetaAccessContext(descriptor, accessValue);
  return assertPaginationCursorBinding(descriptor, access, cursorValue);
}

/**
 * Bind a provider continuation to the exact descriptor revision and access
 * context that produced it. Passing a previous binding records and validates
 * the one-step cursor chain.
 */
export function bindMetaPaginationCursor(
  descriptorValue: MetaOperationDescriptor,
  accessValue: unknown,
  cursorValue: unknown,
  previousValue: MetaPaginationCursor | null = null,
): MetaPaginationCursor {
  const descriptor = defineMetaOperationDescriptor(descriptorValue);
  const access = bindMetaAccessContext(descriptor, accessValue);
  if (descriptor.pagination.kind !== "cursor") {
    throw new Error("Meta operation does not permit pagination");
  }
  const cursor = exactCursor(cursorValue, "Meta next pagination cursor");
  const previous = previousValue === null
    ? null
    : assertPaginationCursorBinding(descriptor, access, previousValue);
  if (previous?.cursor === cursor) {
    throw new Error("Meta pagination cursor did not advance");
  }
  const result: MetaPaginationCursor = Object.freeze({
    schemaVersion: 1,
    descriptorKey: metaOperationDescriptorKey(descriptor),
    actorId: access.actorId,
    targetId: access.targetId,
    cursor,
    previousCursor: previous?.cursor ?? null,
  });
  issuedPaginationCursors.add(result);
  return result;
}

export function buildMetaRelayVariables(
  descriptorValue: MetaOperationDescriptor,
  inputValue: unknown,
  accessValue: unknown,
  paginationValue: MetaPaginationCursor | null = null,
): Readonly<Record<string, unknown>> {
  const descriptor = defineMetaOperationDescriptor(descriptorValue);
  const access = bindMetaAccessContext(descriptor, accessValue);
  const input = record(inputValue, "Meta semantic input");
  const inputKeys = new Set(
    descriptor.variables.fields.flatMap((field) => (
      field.source.kind === "input" ? [field.source.key] : []
    )),
  );
  const extra = Object.keys(input).filter((key) => !inputKeys.has(key));
  if (extra.length > 0) {
    throw new Error(`Meta semantic input contained unsupported field(s): ${extra.join(", ")}`);
  }
  const pagination = paginationValue === null
    ? null
    : assertPaginationCursorBinding(descriptor, access, paginationValue);
  const result: Record<string, unknown> = {};
  for (const field of descriptor.variables.fields) {
    let sourceValue: unknown;
    let present = true;
    switch (field.source.kind) {
      case "input":
        present = Object.hasOwn(input, field.source.key);
        sourceValue = input[field.source.key];
        break;
      case "viewer":
        sourceValue = access.viewerId;
        break;
      case "actor":
        sourceValue = access.actorId;
        break;
      case "target":
        sourceValue = access.targetId;
        break;
      case "pagination":
        present = pagination !== null;
        sourceValue = pagination?.cursor;
        break;
      case "literal":
        sourceValue = field.source.value;
        break;
    }
    if (!present) {
      if (!field.optional) {
        const sourceName = field.source.kind === "input"
          ? `input.${field.source.key}`
          : field.name;
        throw new Error(`Meta variables omitted required ${sourceName}`);
      }
      continue;
    }
    result[field.name] = validateVariableValue(
      field.schema,
      sourceValue,
      `Meta variables.${field.name}`,
    );
  }
  return Object.freeze(result);
}

function proofFormFields(
  proofs: readonly MetaBootstrapProofDeclaration[],
): readonly MetaRelayProofFormFieldName[] {
  const fields: MetaRelayProofFormFieldName[] = [];
  for (const proof of proofs) {
    for (const sink of proof.sinks) {
      switch (sink) {
        case "form.__user": fields.push("__user"); break;
        case "form.av": fields.push("av"); break;
        case "form.fb_dtsg": fields.push("fb_dtsg"); break;
        case "form.jazoest": fields.push("jazoest"); break;
        case "form.lsd": fields.push("lsd"); break;
        case "form.__rev": fields.push("__rev"); break;
        case "form.__hsi": fields.push("__hsi"); break;
        case "form.__comet_req": fields.push("__comet_req"); break;
        case "form.__req": fields.push("__req"); break;
        case "access.viewer-id":
        case "access.actor-id":
          break;
      }
    }
  }
  return Object.freeze(fields);
}

/**
 * Build a network-inert exact request template. Raw bootstrap proof values are
 * not accepted or returned; an opaque bootstrap boundary must consume each
 * declared proof directly into the named form sink.
 */
export function buildMetaRelayRequest(
  descriptorValue: MetaOperationDescriptor,
  value: unknown,
): MetaRelayRequest {
  const descriptor = defineMetaOperationDescriptor(descriptorValue);
  if (descriptor.contract.state !== "observed") {
    throw new Error(
      `Meta operation ${descriptor.id} is capture-required and cannot build a request`,
    );
  }
  const candidate = record(value, "Meta Relay request build input");
  exactKeys(
    candidate,
    ["input", "access"],
    ["pagination"],
    "Meta Relay request build input",
  );
  const access = bindMetaAccessContext(descriptor, candidate.access);
  const paginationValue = candidate.pagination === undefined || candidate.pagination === null
    ? null
    : assertPaginationCursorBinding(descriptor, access, candidate.pagination);
  const variables = buildMetaRelayVariables(
    descriptor,
    candidate.input,
    access,
    paginationValue,
  );
  const parameters: readonly MetaRelayRequestParameter[] = Object.freeze([
    Object.freeze({
      name: "fb_api_req_friendly_name",
      value: descriptor.friendlyName,
    }),
    Object.freeze({ name: "doc_id", value: descriptor.docId }),
    Object.freeze({ name: "variables", value: JSON.stringify(variables) }),
  ]);
  const request: MetaRelayRequest = Object.freeze({
    descriptorId: descriptor.id,
    operationType: descriptor.operationType,
    origin: descriptor.origin,
    method: descriptor.method,
    path: descriptor.path,
    url: `${descriptor.origin}${descriptor.path}`,
    parameterLocation: descriptor.method === "GET" ? "query" : "form",
    parameters,
    proofBindings: descriptor.proofs,
    proofFormFields: proofFormFields(descriptor.proofs),
    access,
    pagination: paginationValue,
    schedule: descriptor.kind === "mutation" ? descriptor.schedule : null,
  });
  issuedRelayRequestCoordinates.set(request, Object.freeze({
    descriptorKey: metaOperationDescriptorKey(descriptor),
    viewerId: access.viewerId,
    actorId: access.actorId,
    targetId: access.targetId,
    proofFormFields: request.proofFormFields,
  }));
  return request;
}

export function metaRelayRequestProofCoordinates(
  value: unknown,
): MetaRelayRequestProofCoordinates {
  if (!isRecord(value)) {
    throw new Error("Meta Relay request handle is invalid");
  }
  const coordinates = issuedRelayRequestCoordinates.get(value as MetaRelayRequest);
  if (coordinates === undefined) {
    throw new Error("Meta Relay request handle is invalid");
  }
  return coordinates;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Select exactly one reviewed response root. Alternate roots are explicit
 * descriptor variants; a response matching more than one is ambiguous drift.
 */
export function assertMetaRelayResponseBinding(
  descriptorValue: MetaOperationDescriptor,
  responseValue: unknown,
): MetaRelayResponseBinding {
  const descriptor = defineMetaOperationDescriptor(descriptorValue);
  const response = record(responseValue, "Meta Relay response");
  if (Object.hasOwn(response, "errors")) {
    if (!Array.isArray(response.errors)) {
      throw new Error("Meta Relay response.errors must be an array");
    }
    if (response.errors.length > 0) {
      throw new Error("Meta Relay response contained provider errors");
    }
  }
  const matches = descriptor.responseRoots.flatMap((variant) => {
    const value = valueAtPath(response, variant.path);
    return value === undefined || value === null ? [] : [{ variant, value }];
  });
  if (matches.length === 0) {
    throw new Error("Meta Relay response omitted every reviewed root variant");
  }
  if (matches.length > 1) {
    throw new Error("Meta Relay response matched multiple reviewed root variants");
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error("Meta Relay response omitted every reviewed root variant");
  }
  return Object.freeze({
    descriptorId: descriptor.id,
    operationType: descriptor.operationType,
    variant: match.variant,
    value: match.value,
  });
}

export function assertMetaDispatchScheduleBinding(
  mutationValue: MetaOperationDescriptor,
  readbackValue: MetaOperationDescriptor,
): MetaDispatchSchedule {
  const mutation = defineMetaOperationDescriptor(mutationValue);
  const readback = defineMetaOperationDescriptor(readbackValue);
  if (mutation.kind !== "mutation") {
    throw new Error("Meta dispatch schedule requires a mutation descriptor");
  }
  if (mutation.schedule.kind !== "single-dispatch") {
    throw new Error("Meta mutation dispatch schedule is inert");
  }
  if (readback.kind !== "query") {
    throw new Error("Meta mutation readback descriptor must be a query");
  }
  if (mutation.schedule.readback.descriptorId !== readback.id) {
    throw new Error("Meta mutation readback descriptor ID did not match its schedule");
  }
  if (
    mutation.platform !== readback.platform
    || mutation.access.kind !== readback.access.kind
    || mutation.access.actorBinding !== readback.access.actorBinding
  ) {
    throw new Error("Meta mutation readback did not preserve its actor and target access policy");
  }
  if (readback.contract.state !== "observed") {
    throw new Error("Meta mutation readback descriptor is capture-required");
  }
  return mutation.schedule;
}
