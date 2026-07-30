import {
  metaRelayRequestProofCoordinates,
  type MetaRelayRequest,
} from "./meta-web-descriptors";

const MAX_JSON_ROOTS = 512;
const MAX_TREE_NODES = 250_000;
const MAX_TREE_DEPTH = 40;
const MAX_CONTAINER_ENTRIES = 10_000;
const MAX_STRING_CHARACTERS = 4 * 1024 * 1024;
const MAX_MODULE_ID = 1_000_000;
const MAX_REQUEST_COUNTER = (36 ** 6) - 1;
const FACEBOOK_CURRENT_USER_ASYNC_KEY_PATTERN =
  /^adp_WebWorkerV2HasteResponsePreloader_[A-Za-z0-9_]{1,192}$/u;

const REVIEWED_MODULE_NAMES = Object.freeze([
  "CurrentUserInitialData",
  "RelayAPIConfigDefaults",
  "DTSGInitialData",
  "SprinkleConfig",
  "LSD",
  "SiteData",
] as const);

type ReviewedModuleName = (typeof REVIEWED_MODULE_NAMES)[number];
type JsonRecord = Readonly<Record<string, unknown>>;

export type ParseMetaJsonScripts = (html: unknown) => unknown;

export type MetaCometFieldClass =
  | "identity"
  | "csrf-proof"
  | "derived-proof"
  | "bootstrap-proof"
  | "build"
  | "request-counter";

export type MetaCometFieldLifetime =
  | "browser-session"
  | "bootstrap"
  | "build"
  | "request";

export type MetaCometFieldClassification = {
  readonly name:
    | "viewerId"
    | "actingId"
    | "fb_dtsg"
    | "jazoest"
    | "lsd"
    | "__rev"
    | "__hsi"
    | "__comet_req"
    | "__req";
  readonly class: MetaCometFieldClass;
  readonly source:
    | "bootstrap.viewer"
    | "bootstrap.actor"
    | "bootstrap.fb_dtsg"
    | "derived.fb_dtsg-jazoest"
    | "bootstrap.lsd"
    | "bootstrap.client-revision"
    | "bootstrap.hsi"
    | "bootstrap.comet-environment"
    | "session.request-counter";
  readonly sinks: readonly (
    | "access.viewer-id"
    | "form.__user"
    | "access.actor-id"
    | "form.av"
    | "form.fb_dtsg"
    | "form.jazoest"
    | "form.lsd"
    | "form.__rev"
    | "form.__hsi"
    | "form.__comet_req"
    | "form.__req"
  )[];
  readonly lifetime: MetaCometFieldLifetime;
};

function classification(
  value: MetaCometFieldClassification,
): MetaCometFieldClassification {
  return Object.freeze({
    ...value,
    sinks: Object.freeze([...value.sinks]),
  });
}

export const META_COMET_FIELD_CLASSIFICATIONS = Object.freeze([
  classification({
    name: "viewerId",
    class: "identity",
    source: "bootstrap.viewer",
    sinks: ["access.viewer-id", "form.__user"],
    lifetime: "browser-session",
  }),
  classification({
    name: "actingId",
    class: "identity",
    source: "bootstrap.actor",
    sinks: ["access.actor-id", "form.av"],
    lifetime: "browser-session",
  }),
  classification({
    name: "fb_dtsg",
    class: "csrf-proof",
    source: "bootstrap.fb_dtsg",
    sinks: ["form.fb_dtsg"],
    lifetime: "bootstrap",
  }),
  classification({
    name: "jazoest",
    class: "derived-proof",
    source: "derived.fb_dtsg-jazoest",
    sinks: ["form.jazoest"],
    lifetime: "bootstrap",
  }),
  classification({
    name: "lsd",
    class: "bootstrap-proof",
    source: "bootstrap.lsd",
    sinks: ["form.lsd"],
    lifetime: "bootstrap",
  }),
  classification({
    name: "__rev",
    class: "build",
    source: "bootstrap.client-revision",
    sinks: ["form.__rev"],
    lifetime: "build",
  }),
  classification({
    name: "__hsi",
    class: "build",
    source: "bootstrap.hsi",
    sinks: ["form.__hsi"],
    lifetime: "bootstrap",
  }),
  classification({
    name: "__comet_req",
    class: "build",
    source: "bootstrap.comet-environment",
    sinks: ["form.__comet_req"],
    lifetime: "build",
  }),
  classification({
    name: "__req",
    class: "request-counter",
    source: "session.request-counter",
    sinks: ["form.__req"],
    lifetime: "request",
  }),
] as const satisfies readonly MetaCometFieldClassification[]);

export type MetaCometBootstrapEvidence = {
  readonly schemaVersion: 1;
  readonly provider: "facebook-comet";
  readonly identityBound: true;
  readonly fields: readonly MetaCometFieldClassification[];
};

const BOOTSTRAP_EVIDENCE: MetaCometBootstrapEvidence = Object.freeze({
  schemaVersion: 1,
  provider: "facebook-comet",
  identityBound: true,
  fields: META_COMET_FIELD_CLASSIFICATIONS,
});

export type MetaCometBootstrap = {
  readonly viewerId: string;
  readonly actingId: string;
  readonly evidence: MetaCometBootstrapEvidence;
};

export type MetaCometRequestFieldName =
  | "__user"
  | "av"
  | "fb_dtsg"
  | "jazoest"
  | "lsd"
  | "__rev"
  | "__hsi"
  | "__comet_req"
  | "__req";

export type MetaCometRequestProofEvidence = {
  readonly schemaVersion: 1;
  readonly provider: "facebook-comet";
  readonly redaction: "raw-values-omitted";
  readonly fields: readonly {
    readonly name: MetaCometRequestFieldName;
    readonly class: MetaCometFieldClass;
  }[];
};

const REQUEST_PROOF_EVIDENCE: MetaCometRequestProofEvidence = Object.freeze({
  schemaVersion: 1,
  provider: "facebook-comet",
  redaction: "raw-values-omitted",
  fields: Object.freeze([
    Object.freeze({ name: "__user", class: "identity" }),
    Object.freeze({ name: "av", class: "identity" }),
    Object.freeze({ name: "fb_dtsg", class: "csrf-proof" }),
    Object.freeze({ name: "jazoest", class: "derived-proof" }),
    Object.freeze({ name: "lsd", class: "bootstrap-proof" }),
    Object.freeze({ name: "__rev", class: "build" }),
    Object.freeze({ name: "__hsi", class: "build" }),
    Object.freeze({ name: "__comet_req", class: "build" }),
    Object.freeze({ name: "__req", class: "request-counter" }),
  ]),
});

declare const META_COMET_REQUEST_PROOF: unique symbol;

/**
 * A request-scoped handle. Its only public property is redacted evidence; raw
 * values live in a module-private WeakMap and can cross only the explicit
 * one-use network-request sink below.
 */
export type MetaCometRequestProof = {
  readonly evidence: MetaCometRequestProofEvidence;
  readonly [META_COMET_REQUEST_PROOF]: true;
};

type BootstrapMaterial = {
  readonly viewerId: string;
  readonly actingId: string;
  readonly fbDtsg: string;
  readonly jazoest: string;
  readonly lsd: string;
  readonly revision: string;
  readonly hsi: string;
  readonly cometRequest: string;
  nextRequestCounter: number;
};

type RequestMaterial = {
  readonly fields: readonly (readonly [MetaCometRequestFieldName, string])[];
  readonly request: MetaRelayRequest;
  consumed: boolean;
};

const bootstrapMaterial = new WeakMap<MetaCometBootstrap, BootstrapMaterial>();
const requestMaterial = new WeakMap<MetaCometRequestProof, RequestMaterial>();
const consumedRequests = new WeakSet<MetaRelayRequest>();
const reviewedModuleNameSet = new Set<string>(REVIEWED_MODULE_NAMES);

const PAYLOAD_FIELDS = Object.freeze({
  CurrentUserInitialData: Object.freeze([
    "ACCOUNT_ID",
    "USER_ID",
    "NAME",
    "SHORT_NAME",
    "IS_BUSINESS_PERSON_ACCOUNT",
    "HAS_SECONDARY_BUSINESS_PERSON",
    "IS_FACEBOOK_WORK_ACCOUNT",
    "IS_MESSENGER_ONLY_USER",
    "IS_DEACTIVATED_ALLOWED_ON_MESSENGER",
    "IS_MESSENGER_CALL_GUEST_USER",
    "IS_WORK_MESSENGER_CALL_GUEST_USER",
    "IS_WORKROOMS_USER",
    "APP_ID",
    "IS_BUSINESS_DOMAIN",
    "IS_INSTAGRAM_BUSINESS_PERSON",
    "IS_WABA_BUSINESS_PERSON",
  ]),
  RelayAPIConfigDefaults: Object.freeze([
    "accessToken",
    "actorID",
    "customHeaders",
    "enableNetworkLogger",
    "enableVerboseNetworkLogger",
    "fetchTimeout",
    "graphBatchURI",
    "graphURI",
    "retryDelays",
    "useXController",
    "xhrEncoding",
    "subscriptionTopicURI",
    "withCredentials",
    "isProductionEndpoint",
    "workRequestTaggingProduct",
    "encryptionKeyParams",
  ]),
  DTSGInitialData: Object.freeze(["token", "async_get_token"]),
  SprinkleConfig: Object.freeze(["param_name", "version", "should_randomize"]),
  LSD: Object.freeze(["token"]),
  SiteData: Object.freeze([
    "server_revision",
    "client_revision",
    "tier",
    "push_phase",
    "pkg_cohort",
    "haste_session",
    "pr",
    "haste_site",
    "manifest_base_uri",
    "manifest_origin",
    "manifest_version_prefix",
    "be_one_ahead",
    "is_rtl",
    "is_comet",
    "is_experimental_tier",
    "is_jit_warmed_up",
    "hsi",
    "semr_host_bucket",
    "bl_hash_version",
    "skip_rd_bl",
    "comet_env",
    "wbloks_env",
    "ef_page",
    "compose_bootloads",
    "spin",
    "__spin_r",
    "__spin_b",
    "__spin_t",
    "__spin_dev_mhenv",
    "vip",
    "polytrace_id",
  ]),
} as const satisfies Readonly<Record<ReviewedModuleName, readonly string[]>>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be plain JSON`);
  }
  return value;
}

function dataRecordEntries(value: JsonRecord, label: string): readonly (readonly [string, unknown])[] {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > MAX_CONTAINER_ENTRIES) {
    throw new Error(`${label} exceeded its reviewed field bound`);
  }
  const entries: (readonly [string, unknown])[] = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") throw new Error(`${label} contained unsupported fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) throw new Error(`${label} must contain only plain JSON fields`);
    entries.push(Object.freeze([key, descriptor.value]));
  }
  return entries;
}

function dataArrayValues(value: readonly unknown[], label: string): readonly unknown[] {
  if (value.length > MAX_CONTAINER_ENTRIES) {
    throw new Error(`${label} exceeded its reviewed entry bound`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1
    || ownKeys.some((key) =>
      typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)))
  ) throw new Error(`${label} contained unsupported array fields`);
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) throw new Error(`${label} must be a dense plain JSON array`);
    values.push(descriptor.value);
  }
  return values;
}

function exactInputKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = dataRecordEntries(value, label).map(([key]) => key);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key))
    || keys.some((key) => !allowed.has(key))
  ) throw new Error(`${label} has unsupported fields`);
}

function validatePayloadFields(
  moduleName: ReviewedModuleName,
  payload: JsonRecord,
): void {
  const allowed = new Set<string>(PAYLOAD_FIELDS[moduleName]);
  const keys = dataRecordEntries(payload, `Facebook Comet ${moduleName} payload`).map(
    ([key]) => key,
  );
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(`Facebook Comet ${moduleName} payload has unsupported fields`);
  }
}

function decimalId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,31}$/u.test(value)) {
    throw new Error(`${label} must be a bounded nonzero decimal identifier`);
  }
  return value;
}

function proofToken(
  value: unknown,
  label: string,
  maximumCharacters: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 8
    || value.length > maximumCharacters
    || !/^[A-Za-z0-9._~:-]+$/u.test(value)
  ) throw new Error(`${label} is missing or malformed`);
  return value;
}

function boundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded positive integer`);
  }
  return value as number;
}

function directModulePathIsReviewed(path: readonly (string | number)[]): boolean {
  return (
    path.length === 3
    && typeof path[0] === "number"
    && (path[1] === "define" || path[1] === "require")
    && typeof path[2] === "number"
  );
}

function scheduledServerModulePathIsReviewed(
  roots: readonly unknown[],
  path: readonly (string | number)[],
  moduleValue: readonly unknown[],
): boolean {
  if (
    path.length !== 8
    || typeof path[0] !== "number"
    || path[1] !== "require"
    || typeof path[2] !== "number"
    || path[3] !== 3
    || typeof path[4] !== "number"
    || path[5] !== "__bbox"
    || (path[6] !== "define" && path[6] !== "require")
    || typeof path[7] !== "number"
  ) return false;

  const root = roots[path[0]];
  if (!isRecord(root)) return false;
  const outerContainer = root.require;
  if (!isUnknownArray(outerContainer)) return false;
  const scheduledValue = outerContainer[path[2]];
  if (!isUnknownArray(scheduledValue)) return false;
  const scheduled = dataArrayValues(
    scheduledValue,
    "Facebook Comet ScheduledServerJS module",
  );
  if (
    scheduled.length !== 4
    || scheduled[0] !== "ScheduledServerJS"
    || scheduled[1] !== "handle"
    || scheduled[2] !== null
    || !isUnknownArray(scheduled[3])
  ) return false;
  const payload = scheduled[3][path[4]];
  if (!isRecord(payload) || !isRecord(payload.__bbox)) return false;
  const innerContainer = payload.__bbox[path[6]];
  return (
    isUnknownArray(innerContainer)
    && innerContainer[path[7]] === moduleValue
  );
}

function hydratedAsyncDataModulePathIsReviewed(
  roots: readonly unknown[],
  path: readonly (string | number)[],
  moduleValue: readonly unknown[],
): boolean {
  if (
    path.length !== 16
    || typeof path[0] !== "number"
    || path[1] !== "require"
    || typeof path[2] !== "number"
    || path[3] !== 3
    || typeof path[4] !== "number"
    || path[5] !== "__bbox"
    || path[6] !== "require"
    || typeof path[7] !== "number"
    || path[8] !== 3
    || typeof path[9] !== "number"
    || path[10] !== "data"
    || path[11] !== "__bbox"
    || path[12] !== "hrp"
    || path[13] !== "jsmods"
    || path[14] !== "define"
    || typeof path[15] !== "number"
  ) return false;

  const root = roots[path[0]];
  if (!isRecord(root) || !isUnknownArray(root.require)) return false;
  const scheduledValue = root.require[path[2]];
  if (
    !isUnknownArray(scheduledValue)
    || scheduledValue.length !== 4
    || scheduledValue[0] !== "ScheduledServerJS"
    || scheduledValue[1] !== "handle"
    || scheduledValue[2] !== null
    || !isUnknownArray(scheduledValue[3])
  ) return false;
  const scheduledPayload = scheduledValue[3][path[4]];
  if (
    !isRecord(scheduledPayload)
    || !isRecord(scheduledPayload.__bbox)
    || !isUnknownArray(scheduledPayload.__bbox.require)
  ) return false;
  const asyncValue = scheduledPayload.__bbox.require[path[7]];
  if (
    !isUnknownArray(asyncValue)
    || asyncValue.length !== 4
    || asyncValue[0] !== "AsyncData"
    || asyncValue[1] !== "resolve"
    || !isUnknownArray(asyncValue[2])
    || asyncValue[2].length !== 0
    || !isUnknownArray(asyncValue[3])
    || asyncValue[3].length !== 2
    || typeof asyncValue[3][0] !== "string"
    || !FACEBOOK_CURRENT_USER_ASYNC_KEY_PATTERN.test(asyncValue[3][0])
  ) return false;
  const asyncPayload = asyncValue[3][path[9]];
  if (!isRecord(asyncPayload) || !isRecord(asyncPayload.data)) return false;
  const dataBbox = asyncPayload.data.__bbox;
  if (!isRecord(dataBbox) || !isRecord(dataBbox.hrp)) return false;
  const jsmods = dataBbox.hrp.jsmods;
  return (
    isRecord(jsmods)
    && isUnknownArray(jsmods.define)
    && jsmods.define[path[15]] === moduleValue
  );
}

function modulePathIsReviewed(
  roots: readonly unknown[],
  path: readonly (string | number)[],
  moduleValue: readonly unknown[],
): boolean {
  return (
    directModulePathIsReviewed(path)
    || scheduledServerModulePathIsReviewed(roots, path, moduleValue)
    || hydratedAsyncDataModulePathIsReviewed(roots, path, moduleValue)
  );
}

function reviewedModuleTuple(
  roots: readonly unknown[],
  value: readonly unknown[],
  path: readonly (string | number)[],
  moduleName: ReviewedModuleName,
): JsonRecord {
  if (!modulePathIsReviewed(roots, path, value)) {
    throw new Error(`Facebook Comet ${moduleName} appeared outside a reviewed module path`);
  }
  const items = dataArrayValues(value, `Facebook Comet ${moduleName} module`);
  if (
    items.length !== 4
    || items[0] !== moduleName
    || !Array.isArray(items[1])
    || dataArrayValues(items[1], `Facebook Comet ${moduleName} dependencies`).length !== 0
    || !Number.isSafeInteger(items[3])
    || (items[3] as number) < 0
    || (items[3] as number) > MAX_MODULE_ID
  ) throw new Error(`Facebook Comet ${moduleName} module is malformed`);
  const payload = record(items[2], `Facebook Comet ${moduleName} payload`);
  validatePayloadFields(moduleName, payload);
  return payload;
}

function collectReviewedModules(roots: readonly unknown[]): ReadonlyMap<ReviewedModuleName, JsonRecord> {
  const rootsWithModules = new Map<number, Map<ReviewedModuleName, JsonRecord>>();
  const seen = new WeakSet<object>();
  const stack: {
    readonly value: unknown;
    readonly path: readonly (string | number)[];
    readonly depth: number;
  }[] = roots.map((value, index) => ({
    value,
    path: Object.freeze([index]),
    depth: 0,
  }));
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_TREE_NODES) {
      throw new Error("Facebook Comet bootstrap exceeded its reviewed structural bound");
    }
    if (current.depth > MAX_TREE_DEPTH) {
      throw new Error("Facebook Comet bootstrap exceeded its reviewed depth bound");
    }

    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      if (value.length > MAX_STRING_CHARACTERS) {
        throw new Error("Facebook Comet bootstrap contained oversized text");
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Facebook Comet bootstrap was not plain JSON");
      continue;
    }
    if (typeof value !== "object") {
      throw new Error("Facebook Comet bootstrap was not plain JSON");
    }
    if (seen.has(value)) {
      throw new Error("Facebook Comet bootstrap contained shared or cyclic structures");
    }
    seen.add(value);

    if (Array.isArray(value)) {
      const values = dataArrayValues(value, "Facebook Comet bootstrap array");
      const possibleName = values[0];
      if (typeof possibleName === "string" && reviewedModuleNameSet.has(possibleName)) {
        const moduleName = REVIEWED_MODULE_NAMES.find((name) => name === possibleName);
        if (moduleName === undefined) throw new Error("Facebook Comet module name was not reviewed");
        const rootIndex = current.path[0];
        if (typeof rootIndex !== "number") {
          throw new Error("Facebook Comet module root was malformed");
        }
        const found = rootsWithModules.get(rootIndex) ?? new Map<ReviewedModuleName, JsonRecord>();
        if (found.has(moduleName)) {
          throw new Error(`Facebook Comet bootstrap contained duplicate ${moduleName} modules`);
        }
        found.set(moduleName, reviewedModuleTuple(roots, value, current.path, moduleName));
        rootsWithModules.set(rootIndex, found);
      }
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: values[index],
          path: Object.freeze([...current.path, index]),
          depth: current.depth + 1,
        });
      }
      continue;
    }

    const entries = dataRecordEntries(
      record(value, "Facebook Comet bootstrap object"),
      "Facebook Comet bootstrap object",
    );
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      stack.push({
        value: entry[1],
        path: Object.freeze([...current.path, entry[0]]),
        depth: current.depth + 1,
      });
    }
  }

  const anchoredRoots = [...rootsWithModules.values()].filter((modules) =>
    modules.has("RelayAPIConfigDefaults"));
  if (anchoredRoots.length > 1) {
    throw new Error("Facebook Comet bootstrap contained multiple RelayAPIConfigDefaults anchor roots");
  }

  // Facebook may hydrate later pagelets with fresh DTSG/LSD/SiteData copies.
  // RelayAPIConfigDefaults appears once in the primary bootstrap root, so it
  // anchors one coherent request-proof set without mixing values across roots.
  const selected = anchoredRoots[0]
    ?? (rootsWithModules.size === 1 ? [...rootsWithModules.values()][0] : undefined)
    ?? new Map<ReviewedModuleName, JsonRecord>();
  const selectedUser = selected.get("CurrentUserInitialData");
  if (selectedUser !== undefined) {
    for (const modules of rootsWithModules.values()) {
      const candidate = modules.get("CurrentUserInitialData");
      if (
        candidate !== undefined
        && (
          candidate.ACCOUNT_ID !== selectedUser.ACCOUNT_ID
          || candidate.USER_ID !== selectedUser.USER_ID
        )
      ) throw new Error("Facebook Comet bootstrap identities drifted across hydrated roots");
    }
  }
  return selected;
}

function requiredModule(
  modules: ReadonlyMap<ReviewedModuleName, JsonRecord>,
  name: ReviewedModuleName,
): JsonRecord {
  const payload = modules.get(name);
  if (payload === undefined) throw new Error(`Facebook Comet bootstrap omitted ${name}`);
  return payload;
}

/**
 * Bind a read-only Comet HTML projection to the exact active Relay actor
 * without materializing any request proofs. The caller remains responsible for
 * binding the independently parsed CurrentUser identity and semantic target.
 */
export function assertMetaCometReadActor(
  roots: readonly unknown[],
  expectedViewerId: string,
): void {
  if (roots.length < 1 || roots.length > MAX_JSON_ROOTS) {
    throw new Error("Facebook Comet read actor roots were not a bounded list");
  }
  const expected = decimalId(
    expectedViewerId,
    "Facebook Comet expected read viewer",
  );
  const modules = collectReviewedModules(roots);
  const actingId = decimalId(
    requiredModule(modules, "RelayAPIConfigDefaults").actorID,
    "Facebook Comet RelayAPIConfigDefaults.actorID",
  );
  if (actingId !== expected) {
    throw new Error("Facebook Comet read actor did not match the bound viewer");
  }
}

function deriveJazoest(fbDtsg: string, sprinkle: JsonRecord): string {
  if (
    sprinkle.param_name !== "jazoest"
    || sprinkle.version !== 2
    || sprinkle.should_randomize !== false
  ) throw new Error("Facebook Comet SprinkleConfig changed its reviewed jazoest derivation");
  let sum = 0;
  for (let index = 0; index < fbDtsg.length; index += 1) {
    sum += fbDtsg.charCodeAt(index);
  }
  const value = `2${sum}`;
  if (!/^2[0-9]{2,10}$/u.test(value)) {
    throw new Error("Facebook Comet jazoest derivation exceeded its reviewed bound");
  }
  return value;
}

function isParseMetaJsonScripts(value: unknown): value is ParseMetaJsonScripts {
  return typeof value === "function";
}

function parseOptions(value: unknown): {
  readonly parseMetaJsonScripts: ParseMetaJsonScripts;
  readonly expectedViewerId: string | null;
  readonly expectedActingId: string | null;
} {
  const input = record(value, "Facebook Comet bootstrap options");
  exactInputKeys(
    input,
    ["parseMetaJsonScripts"],
    ["expectedViewerId", "expectedActingId"],
    "Facebook Comet bootstrap options",
  );
  const parser = input.parseMetaJsonScripts;
  if (!isParseMetaJsonScripts(parser)) {
    throw new Error("Facebook Comet bootstrap parser must be a function");
  }
  return Object.freeze({
    parseMetaJsonScripts: parser,
    expectedViewerId: input.expectedViewerId === undefined
      ? null
      : decimalId(input.expectedViewerId, "Facebook Comet expected viewer"),
    expectedActingId: input.expectedActingId === undefined
      ? null
      : decimalId(input.expectedActingId, "Facebook Comet expected actor"),
  });
}

/**
 * Parse one inert root-HTML snapshot through an injected JSON-script parser.
 * This function performs no network, browser, clock, random, or filesystem I/O.
 */
export function bootstrapMetaComet(
  html: unknown,
  options: unknown,
): MetaCometBootstrap {
  const parsedOptions = parseOptions(options);
  let parsed: unknown;
  try {
    parsed = parsedOptions.parseMetaJsonScripts(html);
  } catch {
    throw new Error("Facebook Comet bootstrap JSON parsing failed");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > MAX_JSON_ROOTS
  ) throw new Error("Facebook Comet bootstrap parser returned a malformed bounded root list");
  const roots = dataArrayValues(parsed, "Facebook Comet bootstrap roots");
  const modules = collectReviewedModules(roots);

  const currentUser = requiredModule(modules, "CurrentUserInitialData");
  const accountId = decimalId(
    currentUser.ACCOUNT_ID,
    "Facebook Comet CurrentUserInitialData.ACCOUNT_ID",
  );
  const userId = decimalId(
    currentUser.USER_ID,
    "Facebook Comet CurrentUserInitialData.USER_ID",
  );
  if (accountId !== userId) {
    throw new Error("Facebook Comet bootstrap viewer identities did not agree");
  }

  const relay = requiredModule(modules, "RelayAPIConfigDefaults");
  const actingId = decimalId(
    relay.actorID,
    "Facebook Comet RelayAPIConfigDefaults.actorID",
  );
  if (actingId !== userId) {
    throw new Error("Facebook Comet bootstrap viewer and actor did not agree");
  }
  if (
    parsedOptions.expectedViewerId !== null
    && parsedOptions.expectedViewerId !== userId
  ) throw new Error("Facebook Comet bootstrap viewer did not match the expected identity");
  if (
    parsedOptions.expectedActingId !== null
    && parsedOptions.expectedActingId !== actingId
  ) throw new Error("Facebook Comet bootstrap actor did not match the expected identity");

  const dtsg = requiredModule(modules, "DTSGInitialData");
  const fbDtsg = proofToken(
    dtsg.token,
    "Facebook Comet DTSGInitialData.token",
    4_096,
  );
  const lsd = proofToken(
    requiredModule(modules, "LSD").token,
    "Facebook Comet LSD.token",
    512,
  );
  const jazoest = deriveJazoest(
    fbDtsg,
    requiredModule(modules, "SprinkleConfig"),
  );

  const siteData = requiredModule(modules, "SiteData");
  if (
    siteData.wbloks_env !== false
    || (
      siteData.is_comet !== undefined
      && siteData.is_comet !== true
    )
  ) {
    throw new Error("Facebook Comet SiteData did not describe a reviewed Comet environment");
  }
  const revision = String(boundedPositiveInteger(
    siteData.client_revision,
    "Facebook Comet SiteData.client_revision",
    Number.MAX_SAFE_INTEGER,
  ));
  const hsi = decimalId(siteData.hsi, "Facebook Comet SiteData.hsi");
  const cometRequest = String(boundedPositiveInteger(
    siteData.comet_env,
    "Facebook Comet SiteData.comet_env",
    999,
  ));

  const bootstrap: MetaCometBootstrap = Object.freeze({
    viewerId: userId,
    actingId,
    evidence: BOOTSTRAP_EVIDENCE,
  });
  bootstrapMaterial.set(bootstrap, {
    viewerId: userId,
    actingId,
    fbDtsg,
    jazoest,
    lsd,
    revision,
    hsi,
    cometRequest,
    nextRequestCounter: 1,
  });
  return bootstrap;
}

function requireBootstrapMaterial(bootstrap: MetaCometBootstrap): BootstrapMaterial {
  const material = bootstrapMaterial.get(bootstrap);
  if (material === undefined) {
    throw new Error("Facebook Comet bootstrap handle is invalid");
  }
  return material;
}

function takeRequestCounter(material: BootstrapMaterial): string {
  const current = material.nextRequestCounter;
  if (!Number.isSafeInteger(current) || current < 1 || current > MAX_REQUEST_COUNTER) {
    throw new Error("Facebook Comet request counter exhausted its reviewed range");
  }
  material.nextRequestCounter += 1;
  return current.toString(36);
}

export function nextMetaCometRequestCounter(
  bootstrap: MetaCometBootstrap,
): string {
  return takeRequestCounter(requireBootstrapMaterial(bootstrap));
}

function requestField(
  name: MetaCometRequestFieldName,
  value: string,
): readonly [MetaCometRequestFieldName, string] {
  return Object.freeze([name, value]);
}

export function materializeMetaCometRequestProof(
  bootstrap: MetaCometBootstrap,
  request: MetaRelayRequest,
): MetaCometRequestProof {
  const material = requireBootstrapMaterial(bootstrap);
  const coordinates = metaRelayRequestProofCoordinates(request);
  if (
    coordinates.viewerId !== material.viewerId
    || coordinates.actorId !== material.actingId
  ) {
    throw new Error("Facebook Comet request proof did not match its request access coordinates");
  }
  const fieldNames: MetaCometRequestFieldName[] = [];
  for (const name of coordinates.proofFormFields) {
    if (
      !REQUEST_PROOF_EVIDENCE.fields.some((field) => field.name === name)
      || fieldNames.includes(name)
    ) {
      throw new Error("Facebook Comet request proof fields did not match its descriptor");
    }
    fieldNames.push(name);
  }
  const valueFor = (name: MetaCometRequestFieldName): string => {
    switch (name) {
      case "__user": return material.viewerId;
      case "av": return material.actingId;
      case "fb_dtsg": return material.fbDtsg;
      case "jazoest": return material.jazoest;
      case "lsd": return material.lsd;
      case "__rev": return material.revision;
      case "__hsi": return material.hsi;
      case "__comet_req": return material.cometRequest;
      case "__req": return takeRequestCounter(material);
    }
  };
  const evidence: MetaCometRequestProofEvidence = Object.freeze({
    ...REQUEST_PROOF_EVIDENCE,
    fields: Object.freeze(REQUEST_PROOF_EVIDENCE.fields.filter((field) =>
      fieldNames.includes(field.name))),
  });
  const proof = Object.freeze({
    evidence,
  }) as MetaCometRequestProof;
  requestMaterial.set(proof, {
    fields: Object.freeze(fieldNames.map((name) =>
      requestField(name, valueFor(name)))),
    request,
    consumed: false,
  });
  return proof;
}

export type MetaCometNetworkRequestSink = {
  readonly sink: "network-request";
  readonly write: (name: MetaCometRequestFieldName, value: string) => void;
};

function isMetaCometNetworkWriter(
  value: unknown,
): value is MetaCometNetworkRequestSink["write"] {
  return typeof value === "function";
}

/**
 * Move raw proof values once into the immediate network-request builder.
 * Errors are deliberately replaced with a value-free message.
 */
export function consumeMetaCometRequestProof(
  proof: MetaCometRequestProof,
  request: MetaRelayRequest,
  sinkValue: unknown,
): MetaCometRequestProofEvidence {
  const material = requestMaterial.get(proof);
  if (material === undefined) {
    throw new Error("Facebook Comet request-proof handle is invalid");
  }
  if (material.consumed) {
    throw new Error("Facebook Comet request proof was already consumed");
  }
  metaRelayRequestProofCoordinates(request);
  if (material.request !== request) {
    throw new Error("Facebook Comet request proof did not match its request handle");
  }
  if (consumedRequests.has(request)) {
    throw new Error("Facebook Comet request handle was already consumed");
  }
  const sink = record(sinkValue, "Facebook Comet request-proof sink");
  exactInputKeys(
    sink,
    ["sink", "write"],
    [],
    "Facebook Comet request-proof sink",
  );
  const write = sink.write;
  if (sink.sink !== "network-request" || !isMetaCometNetworkWriter(write)) {
    throw new Error("Facebook Comet raw proof may flow only to the network-request sink");
  }

  material.consumed = true;
  consumedRequests.add(request);
  try {
    for (const [name, value] of material.fields) write(name, value);
  } catch {
    throw new Error("Facebook Comet request-proof network sink failed");
  }
  return proof.evidence;
}
