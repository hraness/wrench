import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  PreservedBrowserArtifactsError,
  parseBrowserRecoveryHandle,
  type BrowserCleanupResourceIdentity,
} from "./browser";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
  type ProcessOwnerStatus,
} from "./process-identity";
import {
  localCliCleanupProcessGroupStatus,
  localCliCleanupResourceExtends,
  parseLocalCliCleanupResourceIdentityV1,
  type ProviderPluginCleanupResourceIdentity,
} from "./provider-plugin-cleanup-resource";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  readPrivateStateFileIfPresent,
  readPrivateStateFilesBatched,
  removePrivateDirectoryTree,
  removePrivateStateFileIfUnchanged,
  snapshotPrivateStateDirectory,
  writePrivateJsonIfUnchanged,
} from "./storage";
import type {
  WebSessionCleanupBarrierRegistrar,
} from "./web-session-execution";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

const ADMISSION_SCHEMA_VERSION = 1 as const;
const MAX_ADMISSION_BYTES = 64 * 1024;
const MAX_ACQUISITION_ATTEMPTS = 8;
const digestPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[a-z][a-z0-9-]{0,127}$/u;
const authIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const claimNamePattern = /^([a-f0-9]{64})\.json$/u;
const storageHelperArtifactPatterns = Object.freeze([
  /^\.io-write-[1-9][0-9]{0,9}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u,
  /^\.io-mutation-[a-f0-9]{64}-(?:waiting|candidate|held)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lock$/u,
  /^\.io-mutation-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[1-9][0-9]{0,9}\.tmp$/u,
  /^\.io-remove-file-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.quarantine$/u,
]);

export const WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY =
  "provider-plugin-state/.web-session-cleanup-admissions" as const;

export type WebSessionCleanupAdmissionIdentity = {
  readonly runId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly pluginImplementationHash: string;
  readonly adapterId: string;
  readonly adapterHash: string;
  readonly surfaceId: string;
  readonly authId: string;
  readonly authHash: string;
  /** Present for new claims; omitted only by bounded predecessor readers. */
  readonly transport?: "web-session-api" | "local-cli";
  /** Exact plugin/tool/artifact execution identity for this admitted run. */
  readonly executionIdentityHash?: string;
};

export type WebSessionCleanupAdmissionContainment =
  | { readonly status: "parent-owned" }
  | {
      readonly status:
        | "resource-active"
        | "cleanup-complete"
        | "cleanup-unsafe";
    };

export type WebSessionCleanupAdmissionResource =
  | {
      readonly resourceId: string;
      readonly status: "unpublished";
    }
  | {
      readonly resourceId: string;
      readonly status: "active";
      readonly identity: ProviderPluginCleanupResourceIdentity;
    }
  | {
      readonly resourceId: string;
      readonly status: "browser-closed-artifacts";
      readonly identity: BrowserCleanupResourceIdentity;
    };

export type WebSessionCleanupAdmissionClaim = {
  readonly schemaVersion: typeof ADMISSION_SCHEMA_VERSION;
  readonly realmKey: string;
  readonly runId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly pluginImplementationHash: string;
  readonly adapterId: string;
  readonly adapterHash: string;
  readonly surfaceId: string;
  readonly authId: string;
  readonly authHash: string;
  readonly transport?: "web-session-api" | "local-cli";
  readonly executionIdentityHash?: string;
  readonly owner: ProcessOwnerIdentity & {
    readonly token: string;
  };
  readonly acquiredAt: string;
  readonly containment: WebSessionCleanupAdmissionContainment;
  readonly resources: readonly WebSessionCleanupAdmissionResource[];
};

export type WebSessionCleanupAdmissionSnapshot = {
  readonly claim: WebSessionCleanupAdmissionClaim;
  readonly contentSha256: string;
};

export type WebSessionCleanupAdmissionListEntry =
  | WebSessionCleanupAdmissionSnapshot
  | {
      readonly coordinate: string;
      readonly invalid: true;
    };

export type WebSessionCleanupAdmissionRecoveryIssue = {
  readonly coordinate: string;
  readonly kind:
    | "invalid-admission"
    | "owner-unknown"
    | "resource-active"
    | "cleanup-unsafe"
    | "recovery-conflict";
};

export type WebSessionCleanupAdmissionRecoveryReport = {
  readonly scanned: number;
  readonly repaired: number;
  readonly active: number;
  readonly retained: number;
  readonly invalid: number;
  readonly issues: readonly WebSessionCleanupAdmissionRecoveryIssue[];
};

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: JsonRecord = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new Error(`${label} has unsupported symbol fields`);
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function exactKeys(
  value: JsonRecord,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function identifier(
  value: unknown,
  label: string,
  pattern = idPattern,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function parseOwner(
  value: unknown,
): WebSessionCleanupAdmissionClaim["owner"] {
  const owner = record(value, "web-session cleanup admission owner");
  exactKeys(
    owner,
    ["pid", "token", "bootId", "processStartId"],
    "web-session cleanup admission owner",
  );
  if (
    typeof owner.pid !== "number"
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
  ) {
    throw new Error("web-session cleanup admission owner PID is malformed");
  }
  return Object.freeze({
    pid: owner.pid,
    token: uuid(
      owner.token,
      "web-session cleanup admission owner token",
    ),
    bootId: digest(
      owner.bootId,
      "web-session cleanup admission owner boot identity",
    ),
    processStartId: digest(
      owner.processStartId,
      "web-session cleanup admission owner process identity",
    ),
  });
}

function parseContainment(
  value: unknown,
): WebSessionCleanupAdmissionContainment {
  const containment = record(
    value,
    "web-session cleanup admission containment",
  );
  exactKeys(
    containment,
    ["status"],
    "web-session cleanup admission containment",
  );
  if (
    containment.status !== "parent-owned"
    && containment.status !== "resource-active"
    && containment.status !== "cleanup-complete"
    && containment.status !== "cleanup-unsafe"
  ) {
    throw new Error("web-session cleanup admission containment is malformed");
  }
  return Object.freeze({ status: containment.status });
}

function parsePrivateDirectoryIdentity(
  value: unknown,
  label: string,
): BrowserCleanupResourceIdentity["socketDirectoryIdentity"] {
  const identity = record(value, label);
  exactKeys(identity, ["device", "inode"], label);
  const parseComponent = (
    component: unknown,
    componentLabel: string,
  ): string => {
    if (
      typeof component !== "string"
      || !/^(?:0|[1-9][0-9]{0,39})$/u.test(component)
    ) {
      throw new Error(`${componentLabel} is malformed`);
    }
    return component;
  };
  return Object.freeze({
    device: parseComponent(identity.device, `${label} device`),
    inode: parseComponent(identity.inode, `${label} inode`),
  });
}

function parseBrowserCleanupResourceIdentity(
  value: unknown,
): BrowserCleanupResourceIdentity {
  const identity = record(
    value,
    "web-session cleanup browser resource identity",
  );
  exactKeys(
    identity,
    [
      "kind",
      "recoveryHandle",
      "session",
      "socketDirectory",
      "socketDirectoryIdentity",
      "artifactsDirectory",
      "artifactsDirectoryIdentity",
    ],
    "web-session cleanup browser resource identity",
  );
  if (
    identity.kind !== "agent-browser-session-v1"
    || typeof identity.recoveryHandle !== "string"
    || typeof identity.session !== "string"
    || typeof identity.socketDirectory !== "string"
    || typeof identity.artifactsDirectory !== "string"
  ) {
    throw new Error("web-session cleanup browser resource identity is malformed");
  }
  const recovery = parseBrowserRecoveryHandle(identity.recoveryHandle);
  if (
    recovery.session !== identity.session
    || recovery.socketDirectory !== identity.socketDirectory
    || recovery.artifactsDirectory !== identity.artifactsDirectory
  ) {
    throw new Error(
      "web-session cleanup browser resource does not match its recovery handle",
    );
  }
  return Object.freeze({
    kind: "agent-browser-session-v1",
    recoveryHandle: identity.recoveryHandle,
    session: recovery.session,
    socketDirectory: recovery.socketDirectory,
    socketDirectoryIdentity: parsePrivateDirectoryIdentity(
      identity.socketDirectoryIdentity,
      "web-session cleanup browser socket identity",
    ),
    artifactsDirectory: recovery.artifactsDirectory,
    artifactsDirectoryIdentity: parsePrivateDirectoryIdentity(
      identity.artifactsDirectoryIdentity,
      "web-session cleanup browser artifacts identity",
    ),
  });
}

function parseCleanupResourceIdentity(
  value: unknown,
): ProviderPluginCleanupResourceIdentity {
  const kind = typeof value === "object"
      && value !== null
      && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, "kind")
    : undefined;
  if (
    kind === undefined
    || !kind.enumerable
    || !("value" in kind)
  ) {
    throw new Error("provider cleanup resource identity kind is malformed");
  }
  return kind.value === "local-cli-private-root-v1"
    ? parseLocalCliCleanupResourceIdentityV1(value)
    : parseBrowserCleanupResourceIdentity(value);
}

function parseCleanupResources(
  value: unknown,
): readonly WebSessionCleanupAdmissionResource[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("web-session cleanup resource collection is malformed");
  }
  const resources: WebSessionCleanupAdmissionResource[] = [];
  const resourceIds = new Set<string>();
  for (const valueEntry of value as readonly unknown[]) {
    const entry = record(valueEntry, "web-session cleanup resource");
    if (entry.status === "unpublished") {
      exactKeys(
        entry,
        ["resourceId", "status"],
        "web-session cleanup resource",
      );
      const resourceId = uuid(
        entry.resourceId,
        "web-session cleanup resource ID",
      );
      if (resourceIds.has(resourceId)) {
        throw new Error("web-session cleanup resource ID is duplicated");
      }
      resourceIds.add(resourceId);
      resources.push(Object.freeze({
        resourceId,
        status: "unpublished",
      }));
      continue;
    }
    if (
      entry.status !== "active"
      && entry.status !== "browser-closed-artifacts"
    ) {
      throw new Error("web-session cleanup resource status is malformed");
    }
    exactKeys(
      entry,
      ["resourceId", "status", "identity"],
      "web-session cleanup resource",
    );
    const resourceId = uuid(
      entry.resourceId,
      "web-session cleanup resource ID",
    );
    if (resourceIds.has(resourceId)) {
      throw new Error("web-session cleanup resource ID is duplicated");
    }
    resourceIds.add(resourceId);
    resources.push(entry.status === "browser-closed-artifacts"
      ? Object.freeze({
          resourceId,
          status: "browser-closed-artifacts" as const,
          identity: parseBrowserCleanupResourceIdentity(entry.identity),
        })
      : Object.freeze({
          resourceId,
          status: "active" as const,
          identity: parseCleanupResourceIdentity(entry.identity),
        }));
  }
  return Object.freeze(resources);
}

export function webSessionCleanupRealmKey(
  surfaceIdValue: string,
  authIdValue: string,
): string {
  const surfaceId = identifier(
    surfaceIdValue,
    "web-session cleanup surface ID",
  );
  const authId = identifier(
    authIdValue,
    "web-session cleanup auth ID",
    authIdPattern,
  );
  return sha256(
    `io-web-session-cleanup-realm-v1\0${canonicalJson({
      surfaceId,
      authId,
    })}`,
  );
}

export function parseWebSessionCleanupAdmissionClaim(
  value: unknown,
): WebSessionCleanupAdmissionClaim {
  const claim = record(value, "web-session cleanup admission");
  exactKeys(
    claim,
    [
      "schemaVersion",
      "realmKey",
      "runId",
      "pluginId",
      "pluginVersion",
      "pluginImplementationHash",
      "adapterId",
      "adapterHash",
      "surfaceId",
      "authId",
      "authHash",
      "owner",
      "acquiredAt",
      "containment",
      "resources",
      ...(claim.transport === undefined ? [] : ["transport"]),
      ...(claim.executionIdentityHash === undefined
        ? []
        : ["executionIdentityHash"]),
    ],
    "web-session cleanup admission",
  );
  if (claim.schemaVersion !== ADMISSION_SCHEMA_VERSION) {
    throw new Error("web-session cleanup admission version is unsupported");
  }
  if (
    (claim.transport === undefined)
      !== (claim.executionIdentityHash === undefined)
    || (
      claim.transport !== undefined
      && claim.transport !== "web-session-api"
      && claim.transport !== "local-cli"
    )
  ) {
    throw new Error("web-session cleanup execution identity is malformed");
  }
  const pluginVersion = claim.pluginVersion;
  if (
    typeof pluginVersion !== "string"
    || pluginVersion.length < 1
    || pluginVersion.length > 128
    || /[\0\r\n]/u.test(pluginVersion)
  ) {
    throw new Error("web-session cleanup plugin version is malformed");
  }
  const parsed: WebSessionCleanupAdmissionClaim = Object.freeze({
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    realmKey: digest(
      claim.realmKey,
      "web-session cleanup admission realm key",
    ),
    runId: uuid(claim.runId, "web-session cleanup admission run ID"),
    pluginId: identifier(
      claim.pluginId,
      "web-session cleanup admission plugin ID",
    ),
    pluginVersion,
    pluginImplementationHash: digest(
      claim.pluginImplementationHash,
      "web-session cleanup admission implementation hash",
    ),
    adapterId: identifier(
      claim.adapterId,
      "web-session cleanup admission adapter ID",
      authIdPattern,
    ),
    adapterHash: digest(
      claim.adapterHash,
      "web-session cleanup admission adapter hash",
    ),
    surfaceId: identifier(
      claim.surfaceId,
      "web-session cleanup admission surface ID",
    ),
    authId: identifier(
      claim.authId,
      "web-session cleanup admission auth ID",
      authIdPattern,
    ),
    authHash: digest(
      claim.authHash,
      "web-session cleanup admission auth hash",
    ),
    ...(claim.transport === undefined
      ? {}
      : {
          transport: claim.transport,
          executionIdentityHash: digest(
            claim.executionIdentityHash,
            "web-session cleanup admission execution identity hash",
          ),
        }),
    owner: parseOwner(claim.owner),
    acquiredAt: timestamp(
      claim.acquiredAt,
      "web-session cleanup admission acquisition time",
    ),
    containment: parseContainment(claim.containment),
    resources: parseCleanupResources(claim.resources),
  });
  if (
    parsed.realmKey
    !== webSessionCleanupRealmKey(parsed.surfaceId, parsed.authId)
  ) {
    throw new Error(
      "web-session cleanup admission realm does not match its surface and auth",
    );
  }
  for (const resource of parsed.resources) {
    if (
      resource.status !== "unpublished"
      && resource.identity.kind === "agent-browser-session-v1"
      && !resource.identity.session.startsWith(
        `io-${parsed.owner.pid}-`,
      )
    ) {
      throw new Error(
        "web-session cleanup browser resource does not match its owning process",
      );
    }
    if (
      resource.status !== "unpublished"
      && (
        (parsed.transport === "local-cli")
          !== (resource.identity.kind === "local-cli-private-root-v1")
      )
    ) {
      throw new Error(
        "provider cleanup resource does not match its admitted transport",
      );
    }
  }
  if (
    parsed.containment.status === "parent-owned"
    && parsed.resources.length !== 0
  ) {
    throw new Error(
      "parent-owned web-session cleanup admission cannot own resources",
    );
  }
  if (
    (
      parsed.containment.status === "resource-active"
      || parsed.containment.status === "cleanup-unsafe"
    )
    && parsed.resources.length === 0
  ) {
    throw new Error(
      "resource-owning web-session cleanup admission omitted its resources",
    );
  }
  return parsed;
}

function directory(environment: Environment): string {
  return join(
    wrenchStateHome(environment),
    WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
  );
}

function pathFor(realmKeyValue: string, environment: Environment): string {
  return join(
    directory(environment),
    `${digest(
      realmKeyValue,
      "web-session cleanup admission realm key",
    )}.json`,
  );
}

function claimSnapshot(
  claimValue: WebSessionCleanupAdmissionClaim,
): WebSessionCleanupAdmissionSnapshot {
  const claim = parseWebSessionCleanupAdmissionClaim(claimValue);
  const content = `${canonicalJson(claim)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_ADMISSION_BYTES) {
    throw new Error("web-session cleanup admission exceeds its byte bound");
  }
  return Object.freeze({
    claim,
    contentSha256: sha256(content),
  });
}

function isStorageHelperArtifact(
  entry: {
    readonly name: string;
    readonly kind: "file" | "directory" | "symbolic-link" | "other";
  },
): boolean {
  return entry.kind === "file"
    && storageHelperArtifactPatterns.some((pattern) =>
      pattern.test(entry.name)
    );
}

export function listWebSessionCleanupAdmissions(
  environment: Environment = process.env,
): readonly WebSessionCleanupAdmissionListEntry[] {
  const admissionDirectory = directory(environment);
  const directorySnapshot = snapshotPrivateStateDirectory(
    admissionDirectory,
    environment,
  );
  if (directorySnapshot.identity === null) return Object.freeze([]);
  const admissionEntries = directorySnapshot.entries.filter((entry) =>
    !isStorageHelperArtifact(entry)
  );
  const claimCandidates = admissionEntries.filter((entry) =>
    entry.kind === "file" && claimNamePattern.test(entry.name)
  );
  const files = readPrivateStateFilesBatched(
    admissionDirectory,
    claimCandidates.map((entry) => entry.name),
    {
      maximumBytesPerFile: MAX_ADMISSION_BYTES,
      environment,
      expectedDirectoryIdentity: directorySnapshot.identity,
    },
  );
  const byName = new Map(files.map((file) => [file.name, file] as const));
  return Object.freeze(admissionEntries.map((entry) => {
    const match = claimNamePattern.exec(entry.name);
    const coordinate = match?.[1] ?? sha256(entry.name);
    if (
      entry.kind !== "file"
      || match === null
      || match[1] === undefined
    ) {
      return { coordinate, invalid: true as const };
    }
    const file = byName.get(entry.name);
    if (file?.status !== "present") {
      return { coordinate, invalid: true as const };
    }
    try {
      const claim = parseWebSessionCleanupAdmissionClaim(
        JSON.parse(file.content) as unknown,
      );
      if (
        claim.realmKey !== match[1]
        || file.content !== `${canonicalJson(claim)}\n`
      ) {
        return { coordinate, invalid: true as const };
      }
      return Object.freeze({
        claim,
        contentSha256: sha256(file.content),
      });
    } catch {
      return { coordinate, invalid: true as const };
    }
  }));
}

function readWebSessionCleanupAdmission(
  realmKeyValue: string,
  environment: Environment,
): WebSessionCleanupAdmissionSnapshot | null {
  const realmKey = digest(
    realmKeyValue,
    "web-session cleanup admission realm key",
  );
  const path = pathFor(realmKey, environment);
  let content: string | null;
  try {
    content = readPrivateStateFileIfPresent(
      path,
      MAX_ADMISSION_BYTES,
      "web-session cleanup admission",
      environment,
    );
  } catch (error) {
    throw new Error(
      "requested web-session cleanup admission is unreadable or unsafe; run wrench doctor before continuing",
      { cause: error },
    );
  }
  if (content === null) return null;
  try {
    const claim = parseWebSessionCleanupAdmissionClaim(
      JSON.parse(content) as unknown,
    );
    if (
      claim.realmKey !== realmKey
      || content !== `${canonicalJson(claim)}\n`
    ) {
      throw new Error(
        "web-session cleanup admission does not match its canonical realm",
      );
    }
    return Object.freeze({
      claim,
      contentSha256: sha256(content),
    });
  } catch (error) {
    throw new Error(
      "requested web-session cleanup admission is invalid; run wrench doctor before continuing",
      { cause: error },
    );
  }
}

function replaceClaim(
  current: WebSessionCleanupAdmissionSnapshot,
  claim: WebSessionCleanupAdmissionClaim,
  environment: Environment,
): WebSessionCleanupAdmissionSnapshot {
  const checked = claimSnapshot(current.claim);
  if (checked.contentSha256 !== current.contentSha256) {
    throw new Error(
      "web-session cleanup admission snapshot is not content-bound",
    );
  }
  const next = claimSnapshot(claim);
  if (
    next.claim.realmKey !== checked.claim.realmKey
    || next.claim.runId !== checked.claim.runId
    || next.claim.owner.token !== checked.claim.owner.token
  ) {
    throw new Error(
      "web-session cleanup admission replacement changed its identity",
    );
  }
  if (!writePrivateJsonIfUnchanged(
    pathFor(checked.claim.realmKey, environment),
    next.claim,
    { expectedCurrentContentSha256: checked.contentSha256 },
  )) {
    throw new Error(
      "web-session cleanup admission changed before containment update",
    );
  }
  return next;
}

function replaceContainment(
  current: WebSessionCleanupAdmissionSnapshot,
  containment: WebSessionCleanupAdmissionContainment,
  environment: Environment,
): WebSessionCleanupAdmissionSnapshot {
  return replaceClaim(
    current,
    Object.freeze({
      ...current.claim,
      containment,
    }),
    environment,
  );
}

export type WebSessionCleanupAdmissionController = {
  readonly current: WebSessionCleanupAdmissionSnapshot;
  readonly registerCleanupBarrier: WebSessionCleanupBarrierRegistrar;
  readonly closeRegistration: () => void;
  readonly cleanupComplete: () => void;
  readonly cleanupUnsafe: () => void;
  readonly release: () => void;
  readonly barriers: readonly Promise<void>[];
};

type TrackedCleanupBarrier = {
  promise: Promise<void>;
  status: "pending" | "fulfilled" | "rejected";
  readonly resourceId: string;
  reason?: unknown;
};

function recoverableBrowserResource(
  reason: unknown,
  resource: WebSessionCleanupAdmissionResource,
): WebSessionCleanupAdmissionResource | null {
  if (
    resource.status !== "active"
    || resource.identity.kind !== "agent-browser-session-v1"
    || !(reason instanceof PreservedBrowserArtifactsError)
    || reason.cleanupEvidence?.kind
      !== "agent-browser-closed-artifacts-v1"
    || canonicalJson(reason.cleanupEvidence.resource)
      !== canonicalJson(resource.identity)
  ) {
    return null;
  }
  return Object.freeze({
    resourceId: resource.resourceId,
    status: "browser-closed-artifacts",
    identity: resource.identity,
  });
}

function controller(
  initial: WebSessionCleanupAdmissionSnapshot,
  environment: Environment,
): WebSessionCleanupAdmissionController {
  let current = claimSnapshot(initial.claim);
  if (current.contentSha256 !== initial.contentSha256) {
    throw new Error(
      "web-session cleanup admission snapshot is not content-bound",
    );
  }
  let accepting = true;
  let released = false;
  const barriers: TrackedCleanupBarrier[] = [];
  const result: WebSessionCleanupAdmissionController = {
    get current() {
      return current;
    },
    get barriers() {
      return Object.freeze(barriers.map((barrier) => barrier.promise));
    },
    registerCleanupBarrier: (barrier) => {
      if (!accepting) {
        throw new Error(
          "web-session cleanup admission registration is closed",
        );
      }
      if (
        current.claim.containment.status !== "parent-owned"
        && current.claim.containment.status !== "resource-active"
      ) {
        throw new Error(
          "web-session cleanup admission is not accepting resources",
        );
      }
      if (current.claim.resources.length >= 8) {
        throw new Error(
          "web-session cleanup admission resource count exceeds its bound",
        );
      }
      const resourceId = randomUUID();
      current = replaceClaim(
        current,
        Object.freeze({
          ...current.claim,
          containment: Object.freeze({ status: "resource-active" }),
          resources: Object.freeze([
            ...current.claim.resources,
            Object.freeze({
              resourceId,
              status: "unpublished" as const,
            }),
          ]),
        }),
        environment,
      );
      const tracked: TrackedCleanupBarrier = {
        status: "pending",
        promise: Promise.resolve(),
        resourceId,
      };
      tracked.promise = Promise.resolve(barrier).then(
        () => {
          tracked.status = "fulfilled";
        },
        (cause: unknown) => {
          tracked.status = "rejected";
          tracked.reason = cause;
          throw cause;
        },
      );
      void tracked.promise.catch(() => undefined);
      barriers.push(tracked);
      return (resourceValue) => {
        const resourceIdentity =
          parseCleanupResourceIdentity(resourceValue);
        const resources = current.claim.resources.map((resource) => {
          if (resource.resourceId !== resourceId) return resource;
          if (resource.status === "unpublished") {
            return Object.freeze({
              resourceId,
              status: "active" as const,
              identity: resourceIdentity,
            });
          }
          if (
            resource.status === "active"
            && canonicalJson(resource.identity)
              === canonicalJson(resourceIdentity)
          ) {
            return resource;
          }
          if (
            resource.status === "active"
            && resource.identity.kind === "local-cli-private-root-v1"
            && resourceIdentity.kind === "local-cli-private-root-v1"
            && localCliCleanupResourceExtends(
              resource.identity,
              resourceIdentity,
            )
          ) {
            return Object.freeze({
              resourceId,
              status: "active" as const,
              identity: resourceIdentity,
            });
          }
          throw new Error(
            "web-session cleanup resource identity changed after publication",
          );
        });
        current = replaceClaim(
          current,
          Object.freeze({
            ...current.claim,
            resources: Object.freeze(resources),
          }),
          environment,
        );
      };
    },
    closeRegistration: () => {
      accepting = false;
    },
    cleanupComplete: () => {
      if (current.claim.containment.status === "cleanup-complete") return;
      if (accepting) {
        throw new Error(
          "web-session cleanup admission registration must close before cleanup completion",
        );
      }
      if (current.claim.containment.status === "cleanup-unsafe") {
        throw new Error(
          "web-session cleanup admission cannot complete after becoming unsafe",
        );
      }
      if (barriers.some((barrier) => barrier.status === "pending")) {
        throw new Error(
          "web-session cleanup admission barriers have not all settled",
        );
      }
      if (barriers.some((barrier) => barrier.status === "rejected")) {
        throw new Error(
          "web-session cleanup admission cannot complete after a rejected barrier",
        );
      }
      current = replaceContainment(
        current,
        Object.freeze({ status: "cleanup-complete" }),
        environment,
      );
    },
    cleanupUnsafe: () => {
      if (current.claim.containment.status === "cleanup-unsafe") return;
      if (accepting) {
        throw new Error(
          "web-session cleanup admission registration must close before cleanup is marked unsafe",
        );
      }
      if (current.claim.containment.status === "cleanup-complete") {
        throw new Error(
          "web-session cleanup admission became unsafe after completion",
        );
      }
      const byResourceId = new Map(
        barriers.map((barrier) => [barrier.resourceId, barrier] as const),
      );
      const resources = current.claim.resources.flatMap((resource) => {
        const tracked = byResourceId.get(resource.resourceId);
        if (tracked?.status === "fulfilled") return [];
        if (tracked?.status === "rejected") {
          return [
            recoverableBrowserResource(tracked.reason, resource)
              ?? resource,
          ];
        }
        return [resource];
      });
      current = replaceClaim(
        current,
        Object.freeze({
          ...current.claim,
          containment: Object.freeze({ status: "cleanup-unsafe" }),
          resources: Object.freeze(resources),
        }),
        environment,
      );
    },
    release: () => {
      if (released) return;
      if (current.claim.containment.status !== "cleanup-complete") {
        throw new Error(
          "web-session cleanup admission cannot be released before cleanup completion",
        );
      }
      removePrivateStateFileIfUnchanged(
        pathFor(current.claim.realmKey, environment),
        { expectedCurrentContentSha256: current.contentSha256 },
        environment,
      );
      // Cleanup-complete is itself sufficient retry proof. Another invoker or
      // doctor may already have retired this exact claim and published a
      // successor; a false CAS must never remove that successor or turn the
      // completed operation into a failure.
      released = true;
    },
  };
  return Object.freeze(result);
}

function createClaim(
  identity: WebSessionCleanupAdmissionIdentity,
  acquiredAt: Date,
): WebSessionCleanupAdmissionClaim {
  const realmKey = webSessionCleanupRealmKey(
    identity.surfaceId,
    identity.authId,
  );
  const processIdentity = currentProcessStartIdentity();
  return parseWebSessionCleanupAdmissionClaim({
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    realmKey,
    runId: identity.runId,
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    pluginImplementationHash: identity.pluginImplementationHash,
    adapterId: identity.adapterId,
    adapterHash: identity.adapterHash,
    surfaceId: identity.surfaceId,
    authId: identity.authId,
    authHash: identity.authHash,
    ...(identity.transport === undefined
      || identity.executionIdentityHash === undefined
      ? {}
      : {
          transport: identity.transport,
          executionIdentityHash: identity.executionIdentityHash,
        }),
    owner: {
      pid: process.pid,
      token: randomUUID(),
      ...processIdentity,
    },
    acquiredAt: acquiredAt.toISOString(),
    containment: { status: "parent-owned" },
    resources: [],
  });
}

type SameBootCleanupUnsafeRecovery =
  | "repaired"
  | "live-owner"
  | "owner-unknown"
  | "proof-unavailable"
  | "artifact-conflict"
  | "claim-conflict";

function removeRecoverableBrowserArtifacts(
  claim: WebSessionCleanupAdmissionClaim,
): boolean {
  if (
    claim.resources.length === 0
    || claim.resources.some((resource) =>
      resource.status !== "browser-closed-artifacts"
    )
  ) {
    return false;
  }
  const removed = new Map<string, string>();
  for (const resource of claim.resources) {
    if (resource.status !== "browser-closed-artifacts") return false;
    const roots = [
      {
        path: resource.identity.socketDirectory,
        identity: resource.identity.socketDirectoryIdentity,
      },
      {
        path: resource.identity.artifactsDirectory,
        identity: resource.identity.artifactsDirectoryIdentity,
      },
    ] as const;
    for (const root of roots) {
      const identityKey = canonicalJson(root.identity);
      const prior = removed.get(root.path);
      if (prior !== undefined) {
        if (prior !== identityKey) {
          throw new Error(
            "web-session cleanup recovery root changed identity",
          );
        }
        continue;
      }
      removePrivateDirectoryTree(root.path, root.identity);
      removed.set(root.path, identityKey);
    }
  }
  return true;
}

function removeRecoverableLocalCliRoots(
  claim: WebSessionCleanupAdmissionClaim,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
): SameBootCleanupUnsafeRecovery {
  if (
    claim.resources.length === 0
    || claim.resources.some((resource) =>
      resource.status !== "active"
      || resource.identity.kind !== "local-cli-private-root-v1"
    )
  ) {
    return "proof-unavailable";
  }
  const owner = inspectOwner(claim.owner);
  if (owner === "exact-live-owner") return "live-owner";
  if (owner === "unknown") return "owner-unknown";
  for (const resource of claim.resources) {
    if (
      resource.status !== "active"
      || resource.identity.kind !== "local-cli-private-root-v1"
    ) {
      return "proof-unavailable";
    }
    const groupStatus = localCliCleanupProcessGroupStatus(
      resource.identity,
      inspectOwner,
    );
    if (groupStatus === "active") return "live-owner";
    if (groupStatus !== "quiescent") return "proof-unavailable";
  }
  try {
    for (const resource of claim.resources) {
      if (
        resource.status !== "active"
        || resource.identity.kind !== "local-cli-private-root-v1"
      ) {
        return "proof-unavailable";
      }
      removePrivateDirectoryTree(resource.identity.root.path, {
        device: resource.identity.root.device,
        inode: resource.identity.root.inode,
        birthtimeNs: resource.identity.root.birthtimeNs,
      });
    }
  } catch {
    return "artifact-conflict";
  }
  return "repaired";
}

function removeRebootQuiescentLocalCliRoots(
  claim: WebSessionCleanupAdmissionClaim,
): boolean {
  try {
    for (const resource of claim.resources) {
      if (
        resource.status === "unpublished"
        || resource.identity.kind !== "local-cli-private-root-v1"
      ) {
        continue;
      }
      removePrivateDirectoryTree(resource.identity.root.path, {
        device: resource.identity.root.device,
        inode: resource.identity.root.inode,
        birthtimeNs: resource.identity.root.birthtimeNs,
      });
    }
    return true;
  } catch {
    return false;
  }
}

function recoverSameBootCleanupUnsafe(
  entry: WebSessionCleanupAdmissionSnapshot,
  environment: Environment,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
): SameBootCleanupUnsafeRecovery {
  if (
    entry.claim.containment.status !== "cleanup-unsafe"
    && entry.claim.containment.status !== "resource-active"
  ) {
    return "proof-unavailable";
  }
  if (entry.claim.transport === "local-cli") {
    const localRecovery = removeRecoverableLocalCliRoots(
      entry.claim,
      inspectOwner,
    );
    if (localRecovery !== "repaired") return localRecovery;
    return removePrivateStateFileIfUnchanged(
      pathFor(entry.claim.realmKey, environment),
      { expectedCurrentContentSha256: entry.contentSha256 },
      environment,
    )
      ? "repaired"
      : "claim-conflict";
  }
  if (entry.claim.containment.status !== "cleanup-unsafe") {
    return "proof-unavailable";
  }
  const owner = inspectOwner(entry.claim.owner);
  if (owner === "exact-live-owner") return "live-owner";
  if (owner === "unknown") return "owner-unknown";
  try {
    if (!removeRecoverableBrowserArtifacts(entry.claim)) {
      return "proof-unavailable";
    }
  } catch {
    return "artifact-conflict";
  }
  return removePrivateStateFileIfUnchanged(
    pathFor(entry.claim.realmKey, environment),
    { expectedCurrentContentSha256: entry.contentSha256 },
    environment,
  )
    ? "repaired"
    : "claim-conflict";
}

function blockedAdmissionGuidance(
  claim: WebSessionCleanupAdmissionClaim,
  recovery: SameBootCleanupUnsafeRecovery | null,
): string {
  const realm = `${claim.surfaceId}/${claim.authId}`;
  const transport = claim.transport === "local-cli"
    ? "local CLI"
    : "authenticated web";
  if (recovery === "live-owner") {
    return `${transport} auth realm ${realm} has active or cleanup-unsafe state still owned by an active run; wait for it to finish`;
  }
  if (recovery === "owner-unknown") {
    return `${transport} auth realm ${realm} owner liveness cannot be proved; run wrench doctor again, and reboot before retrying if inspection remains unavailable`;
  }
  if (recovery === "artifact-conflict") {
    return `${transport} auth realm ${realm} has identity-changed private cleanup artifacts; retry is unsafe until manual recovery or reboot`;
  }
  if (recovery === "claim-conflict") {
    return `${transport} auth realm ${realm} cleanup recovery changed concurrently; run wrench doctor before retrying`;
  }
  if (
    claim.containment.status === "cleanup-unsafe"
    && recovery === "proof-unavailable"
  ) {
    return `${transport} auth realm ${realm} has cleanup-unsafe state without exact quiescence evidence; reboot and run wrench doctor before retrying`;
  }
  if (claim.containment.status === "resource-active") {
    return `${transport} auth realm ${realm} has a resource-active crash boundary; same-boot quiescence cannot be proved, so reboot and run wrench doctor before retrying`;
  }
  return `${transport} auth realm ${realm} has active or cleanup-unsafe state; wait for the active run, or run wrench doctor before retrying`;
}

export class WebSessionCleanupAdmissionBlockedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WebSessionCleanupAdmissionBlockedError";
  }
}

function cleanupAdmissionBlocked(error: unknown): WebSessionCleanupAdmissionBlockedError {
  if (error instanceof WebSessionCleanupAdmissionBlockedError) return error;
  return new WebSessionCleanupAdmissionBlockedError(
    error instanceof Error
      ? error.message
      : "web-session cleanup admission could not be acquired",
    error,
  );
}

function acquireWebSessionCleanupAdmissionCore(
  claim: WebSessionCleanupAdmissionClaim,
  environment: Environment,
): WebSessionCleanupAdmissionController {
  const admissionDirectory = directory(environment);
  ensurePrivateStateDirectory(admissionDirectory, environment);
  for (
    let attempt = 0;
    attempt < MAX_ACQUISITION_ATTEMPTS;
    attempt += 1
  ) {
    const existing = readWebSessionCleanupAdmission(
      claim.realmKey,
      environment,
    );
    if (existing !== null) {
      const containment = existing.claim.containment.status;
      const currentBootId = claim.owner.bootId;
      let sameBootUnsafeRecovery:
        | SameBootCleanupUnsafeRecovery
        | null = null;
      if (
        (
          containment === "cleanup-unsafe"
          || (
            containment === "resource-active"
            && existing.claim.transport === "local-cli"
          )
        )
        && existing.claim.owner.bootId === currentBootId
      ) {
        sameBootUnsafeRecovery = recoverSameBootCleanupUnsafe(
          existing,
          environment,
          processOwnerStatus,
        );
        if (sameBootUnsafeRecovery === "repaired") continue;
        if (sameBootUnsafeRecovery === "claim-conflict") continue;
      }
      const rebootQuiescent = (
        containment === "resource-active"
        || containment === "cleanup-unsafe"
      )
        && existing.claim.owner.bootId !== currentBootId;
      const automaticallyRepairable = containment === "cleanup-complete"
        || (
          containment === "parent-owned"
          && processOwnerStatus(existing.claim.owner)
            === "different-or-dead"
        )
        || (
          (
            containment === "resource-active"
            || containment === "cleanup-unsafe"
          )
          && existing.claim.owner.bootId !== currentBootId
        );
      if (automaticallyRepairable) {
        if (
          rebootQuiescent
          && !removeRebootQuiescentLocalCliRoots(existing.claim)
        ) {
          throw new WebSessionCleanupAdmissionBlockedError(
            blockedAdmissionGuidance(existing.claim, "artifact-conflict"),
          );
        }
        removePrivateStateFileIfUnchanged(
          pathFor(claim.realmKey, environment),
          { expectedCurrentContentSha256: existing.contentSha256 },
          environment,
        );
        continue;
      }
      throw new WebSessionCleanupAdmissionBlockedError(
        blockedAdmissionGuidance(
          existing.claim,
          sameBootUnsafeRecovery,
        ),
      );
    }
    let created: { readonly created: boolean };
    try {
      created = createPrivateJsonIfAbsent(
        pathFor(claim.realmKey, environment),
        claim,
        { environment },
      );
    } catch (error) {
      if (
        error instanceof Error
        && error.message.includes("state file mutation is already active")
      ) {
        continue;
      }
      throw error;
    }
    if (created.created) return controller(claimSnapshot(claim), environment);
  }
  throw new WebSessionCleanupAdmissionBlockedError(
    `${claim.transport === "local-cli" ? "local CLI" : "authenticated web"} auth realm ${claim.surfaceId}/${claim.authId} cleanup admission could not be acquired`,
  );
}

export function acquireWebSessionCleanupAdmission(
  identity: WebSessionCleanupAdmissionIdentity,
  environment: Environment = process.env,
  acquiredAt = new Date(),
): WebSessionCleanupAdmissionController {
  const claim = createClaim(identity, acquiredAt);
  try {
    return acquireWebSessionCleanupAdmissionCore(claim, environment);
  } catch (error) {
    throw cleanupAdmissionBlocked(error);
  }
}

/**
 * The operation result and cleanup safety are independent. The operation may
 * return a truthful zero-dispatch failure after its cleanup barrier rejects;
 * the retained durable admission, rather than a fabricated dispatch state,
 * prevents another run in that auth realm.
 */
export async function withWebSessionCleanupAdmission<T>(
  identity: WebSessionCleanupAdmissionIdentity,
  environment: Environment,
  operation: (
    registerCleanupBarrier: WebSessionCleanupBarrierRegistrar,
  ) => Promise<T>,
  acquiredAt = new Date(),
  onAdmissionBlocked?: (
    error: WebSessionCleanupAdmissionBlockedError,
  ) => Promise<T>,
): Promise<T> {
  let admission: WebSessionCleanupAdmissionController;
  try {
    admission = acquireWebSessionCleanupAdmission(
      identity,
      environment,
      acquiredAt,
    );
  } catch (error) {
    if (
      error instanceof WebSessionCleanupAdmissionBlockedError
      && onAdmissionBlocked !== undefined
    ) {
      return onAdmissionBlocked(error);
    }
    throw error;
  }
  let outcome:
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly reason: unknown };
  try {
    try {
      outcome = {
        status: "fulfilled",
        value: await operation(admission.registerCleanupBarrier),
      };
    } catch (reason) {
      outcome = { status: "rejected", reason };
    }
    admission.closeRegistration();
    const cleanup = await Promise.allSettled(admission.barriers);
    if (cleanup.some((result) => result.status === "rejected")) {
      admission.cleanupUnsafe();
    } else {
      admission.cleanupComplete();
      admission.release();
    }
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  } catch (error) {
    admission.closeRegistration();
    if (admission.current.claim.containment.status === "parent-owned") {
      admission.cleanupComplete();
      admission.release();
    }
    throw error;
  }
}

export function recoverWebSessionCleanupAdmissions(
  environment: Environment = process.env,
): WebSessionCleanupAdmissionRecoveryReport {
  return recoverWebSessionCleanupAdmissionsCore(
    environment,
    processOwnerStatus,
    currentProcessStartIdentity().bootId,
  );
}

function recoverWebSessionCleanupAdmissionsCore(
  environment: Environment,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
  currentBootId: string,
): WebSessionCleanupAdmissionRecoveryReport {
  digest(currentBootId, "current boot identity");
  const entries = listWebSessionCleanupAdmissions(environment);
  const issues: WebSessionCleanupAdmissionRecoveryIssue[] = [];
  let repaired = 0;
  let active = 0;
  let retained = 0;
  let invalid = 0;
  for (const entry of entries) {
    if ("invalid" in entry) {
      invalid += 1;
      issues.push({
        coordinate: entry.coordinate,
        kind: "invalid-admission",
      });
      continue;
    }
    const { claim } = entry;
    const containment = claim.containment.status;
    let repairable = containment === "cleanup-complete";
    if (containment === "parent-owned") {
      const owner = inspectOwner(claim.owner);
      if (owner === "exact-live-owner") {
        active += 1;
        continue;
      }
      if (owner === "unknown") {
        retained += 1;
        issues.push({
          coordinate: claim.realmKey,
          kind: "owner-unknown",
        });
        continue;
      }
      repairable = true;
    } else if (
      containment === "resource-active"
      || containment === "cleanup-unsafe"
    ) {
      if (claim.owner.bootId !== currentBootId) {
        if (!removeRebootQuiescentLocalCliRoots(claim)) {
          retained += 1;
          issues.push({
            coordinate: claim.realmKey,
            kind: "recovery-conflict",
          });
          continue;
        }
        repairable = true;
      } else if (
        containment === "cleanup-unsafe"
        || claim.transport === "local-cli"
      ) {
        const recovery = recoverSameBootCleanupUnsafe(
          entry,
          environment,
          inspectOwner,
        );
        if (recovery === "repaired") {
          repaired += 1;
          continue;
        }
        retained += 1;
        issues.push({
          coordinate: claim.realmKey,
          kind: recovery === "owner-unknown"
            ? "owner-unknown"
            : recovery === "live-owner"
              ? "resource-active"
            : recovery === "artifact-conflict"
              || recovery === "claim-conflict"
              ? "recovery-conflict"
              : "cleanup-unsafe",
        });
        continue;
      } else {
        retained += 1;
        issues.push({
          coordinate: claim.realmKey,
          kind: containment,
        });
        continue;
      }
    }
    if (!repairable) continue;
    if (removePrivateStateFileIfUnchanged(
      pathFor(claim.realmKey, environment),
      { expectedCurrentContentSha256: entry.contentSha256 },
      environment,
    )) {
      repaired += 1;
    } else {
      retained += 1;
      issues.push({
        coordinate: claim.realmKey,
        kind: "recovery-conflict",
      });
    }
  }
  return Object.freeze({
    scanned: entries.length,
    repaired,
    active,
    retained,
    invalid,
    issues: Object.freeze(issues),
  });
}
