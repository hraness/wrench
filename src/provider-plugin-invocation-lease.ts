import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  parsePortableOperationIdentityV1,
  type PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import {
  loadInstalledPortableProviderPlugin,
  withPortableProviderPluginCatalogLock,
} from "./provider-plugin-store";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
  type ProcessOwnerStatus,
} from "./process-identity";
import type {
  PortableProviderPluginCleanupContainment,
} from "./provider-plugin-cleanup-barrier";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  readPrivateStateFilesBatched,
  removePrivateStateFileIfUnchanged,
  snapshotPrivateStateDirectory,
  writePrivateJsonIfUnchanged,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

const LEASE_SCHEMA_VERSION = 2 as const;
const LEGACY_LEASE_SCHEMA_VERSION = 1 as const;
const MAX_LEASE_BYTES = 32 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type PortableProviderPluginInvocationLeaseBase = {
  readonly leaseId: string;
  readonly runId: string;
  readonly identity: PortableOperationIdentityV1;
  readonly owner: ProcessOwnerIdentity & {
    readonly token: string;
  };
  readonly acquiredAt: string;
};

export type PortableProviderPluginInvocationLeaseContainment =
  | {
      readonly status: "parent-owned";
    }
  | {
      readonly status: "host-starting" | "host-active";
      readonly host: ProcessOwnerIdentity;
    }
  | {
      readonly status: "cleanup-complete" | "cleanup-unsafe";
      readonly host: ProcessOwnerIdentity | null;
    };

export type PortableProviderPluginInvocationLease =
  | PortableProviderPluginInvocationLeaseBase & {
      readonly schemaVersion: typeof LEGACY_LEASE_SCHEMA_VERSION;
    }
  | PortableProviderPluginInvocationLeaseBase & {
      readonly schemaVersion: typeof LEASE_SCHEMA_VERSION;
      readonly containment: PortableProviderPluginInvocationLeaseContainment;
    };

export type PortableProviderPluginInvocationLeaseSnapshot = {
  readonly lease: PortableProviderPluginInvocationLease;
  readonly contentSha256: string;
};

export type PortableProviderPluginInvocationLeaseListEntry =
  | PortableProviderPluginInvocationLeaseSnapshot
  | {
      readonly leaseId: string;
      readonly invalid: true;
    };

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
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
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
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

function parseProcessOwner(
  value: unknown,
  label: string,
): ProcessOwnerIdentity {
  const owner = record(value, label);
  exactKeys(
    owner,
    ["pid", "bootId", "processStartId"],
    label,
  );
  if (
    typeof owner.pid !== "number"
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || typeof owner.bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(owner.bootId)
    || typeof owner.processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(owner.processStartId)
  ) {
    throw new Error(`${label} is malformed`);
  }
  return Object.freeze({
    pid: owner.pid,
    bootId: owner.bootId,
    processStartId: owner.processStartId,
  });
}

function parseOwner(value: unknown): PortableProviderPluginInvocationLease["owner"] {
  const owner = record(value, "portable invocation lease owner");
  exactKeys(
    owner,
    ["pid", "token", "bootId", "processStartId"],
    "portable invocation lease owner",
  );
  if (
    typeof owner.token !== "string"
    || !uuidPattern.test(owner.token)
  ) {
    throw new Error("portable invocation lease owner is malformed");
  }
  return Object.freeze({
    ...parseProcessOwner(
      {
        pid: owner.pid,
        bootId: owner.bootId,
        processStartId: owner.processStartId,
      },
      "portable invocation lease owner",
    ),
    token: owner.token,
  });
}

function parseContainment(
  value: unknown,
): PortableProviderPluginInvocationLeaseContainment {
  const containment = record(value, "portable invocation lease containment");
  if (containment.status === "parent-owned") {
    exactKeys(
      containment,
      ["status"],
      "portable invocation lease containment",
    );
    return Object.freeze({ status: "parent-owned" });
  }
  if (
    containment.status === "host-starting"
    || containment.status === "host-active"
  ) {
    exactKeys(
      containment,
      ["status", "host"],
      "portable invocation lease containment",
    );
    return Object.freeze({
      status: containment.status,
      host: parseProcessOwner(
        containment.host,
        "portable invocation lease host",
      ),
    });
  }
  if (
    containment.status === "cleanup-complete"
    || containment.status === "cleanup-unsafe"
  ) {
    exactKeys(
      containment,
      ["status", "host"],
      "portable invocation lease containment",
    );
    return Object.freeze({
      status: containment.status,
      host: containment.host === null
        ? null
        : parseProcessOwner(
            containment.host,
            "portable invocation lease host",
          ),
    });
  }
  throw new Error("portable invocation lease containment is malformed");
}

export function parsePortableProviderPluginInvocationLease(
  value: unknown,
): PortableProviderPluginInvocationLease {
  const lease = record(value, "portable invocation lease");
  if (lease.schemaVersion === LEGACY_LEASE_SCHEMA_VERSION) {
    exactKeys(
      lease,
      [
        "schemaVersion",
        "leaseId",
        "runId",
        "identity",
        "owner",
        "acquiredAt",
      ],
      "portable invocation lease",
    );
    return Object.freeze({
      schemaVersion: LEGACY_LEASE_SCHEMA_VERSION,
      leaseId: uuid(lease.leaseId, "portable invocation lease ID"),
      runId: uuid(lease.runId, "portable invocation run ID"),
      identity: parsePortableOperationIdentityV1(lease.identity),
      owner: parseOwner(lease.owner),
      acquiredAt: timestamp(
        lease.acquiredAt,
        "portable invocation lease acquisition time",
      ),
    });
  }
  exactKeys(
    lease,
    [
      "schemaVersion",
      "leaseId",
      "runId",
      "identity",
      "owner",
      "acquiredAt",
      "containment",
    ],
    "portable invocation lease",
  );
  if (lease.schemaVersion !== LEASE_SCHEMA_VERSION) {
    throw new Error("portable invocation lease schema is unsupported");
  }
  return Object.freeze({
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId: uuid(lease.leaseId, "portable invocation lease ID"),
    runId: uuid(lease.runId, "portable invocation run ID"),
    identity: parsePortableOperationIdentityV1(lease.identity),
    owner: parseOwner(lease.owner),
    acquiredAt: timestamp(
      lease.acquiredAt,
      "portable invocation lease acquisition time",
    ),
    containment: parseContainment(lease.containment),
  });
}

function leaseDirectory(environment: Environment): string {
  return join(wrenchStateHome(environment), "provider-plugin-state", ".invocations");
}

function leasePath(
  leaseId: string,
  environment: Environment,
): string {
  return join(
    leaseDirectory(environment),
    `${uuid(leaseId, "portable invocation lease ID")}.json`,
  );
}

function storeRoot(environment: Environment): string {
  return join(wrenchStateHome(environment), "provider-plugins");
}

function snapshot(
  leaseValue: PortableProviderPluginInvocationLease,
): PortableProviderPluginInvocationLeaseSnapshot {
  const lease = parsePortableProviderPluginInvocationLease(leaseValue);
  return Object.freeze({
    lease,
    contentSha256: sha256(`${canonicalJson(lease)}\n`),
  });
}

function assertExactIdentityIsActive(
  identity: PortableOperationIdentityV1,
  environment: Environment,
): void {
  const installed = loadInstalledPortableProviderPlugin(
    storeRoot(environment),
    identity.pluginId,
  );
  if (
    installed === null
    || installed.package.manifest.id !== identity.pluginId
    || installed.package.manifest.version !== identity.pluginVersion
    || installed.package.manifest.hostApiVersion !== identity.hostApiVersion
    || installed.package.bundleSha256 !== identity.bundleSha256
    || installed.package.manifestSha256 !== identity.manifestSha256
  ) {
    throw new Error(
      `portable provider plugin ${identity.pluginId} changed or was disabled before execution; retry from current capabilities`,
    );
  }
}

function assertPortableProviderPluginInvocationAdmitted(
  identity: PortableOperationIdentityV1,
  environment: Environment,
): void {
  for (const entry of listPortableProviderPluginInvocationLeases(environment)) {
    if ("invalid" in entry) {
      throw new Error(
        `portable provider plugin invocation is blocked by malformed lease ${entry.leaseId}; run wrench plugin doctor before retrying`,
      );
    }
    const existing = entry.lease;
    if (existing.identity.pluginId !== identity.pluginId) continue;
    if (
      existing.schemaVersion === LEASE_SCHEMA_VERSION
      && existing.containment.status === "cleanup-complete"
    ) {
      continue;
    }
    if (
      existing.schemaVersion === LEASE_SCHEMA_VERSION
      && existing.containment.status === "cleanup-unsafe"
    ) {
      throw new Error(
        `portable provider plugin ${identity.pluginId} invocation is blocked by cleanup-unsafe lease ${existing.leaseId}; run wrench plugin doctor before retrying`,
      );
    }
    if (
      portableProviderPluginInvocationLeaseOwnerStatus(entry)
      !== "exact-live-owner"
    ) {
      throw new Error(
        `portable provider plugin ${identity.pluginId} invocation is blocked by unverifiable non-complete lease ${existing.leaseId}; run wrench plugin doctor before retrying`,
      );
    }
  }
}

export function acquirePortableProviderPluginInvocationLease(
  identityValue: PortableOperationIdentityV1,
  runIdValue: string,
  environment: Environment = process.env,
  now = new Date(),
): PortableProviderPluginInvocationLeaseSnapshot {
  const identity = parsePortableOperationIdentityV1(identityValue);
  const runId = uuid(runIdValue, "portable invocation run ID");
  return withPortableProviderPluginCatalogLock(
    storeRoot(environment),
    now,
    () => {
      assertExactIdentityIsActive(identity, environment);
      ensurePrivateStateDirectory(leaseDirectory(environment), environment);
      assertPortableProviderPluginInvocationAdmitted(identity, environment);
      const lease: PortableProviderPluginInvocationLease =
        Object.freeze({
          schemaVersion: LEASE_SCHEMA_VERSION,
          leaseId: randomUUID(),
          runId,
          identity,
          owner: Object.freeze({
            pid: process.pid,
            token: randomUUID(),
            ...currentProcessStartIdentity(),
          }),
          acquiredAt: now.toISOString(),
          containment: Object.freeze({
            status: "parent-owned",
          }),
        });
      const created = createPrivateJsonIfAbsent(
        leasePath(lease.leaseId, environment),
        lease,
        { environment },
      );
      if (!created.created) {
        throw new Error("portable invocation lease ID collided");
      }
      return snapshot(lease);
    },
  );
}

function sameProcessOwner(
  left: ProcessOwnerIdentity,
  right: ProcessOwnerIdentity,
): boolean {
  return (
    left.pid === right.pid
    && left.bootId === right.bootId
    && left.processStartId === right.processStartId
  );
}

function replacePortableProviderPluginInvocationLease(
  current: PortableProviderPluginInvocationLeaseSnapshot,
  containment: PortableProviderPluginInvocationLeaseContainment,
  environment: Environment,
  now = new Date(),
): PortableProviderPluginInvocationLeaseSnapshot {
  const checked = snapshot(current.lease);
  if (checked.contentSha256 !== current.contentSha256) {
    throw new Error("portable invocation lease snapshot is not content-bound");
  }
  if (checked.lease.schemaVersion !== LEASE_SCHEMA_VERSION) {
    throw new Error("legacy portable invocation leases cannot bind containment");
  }
  const next = snapshot(Object.freeze({
    ...checked.lease,
    containment,
  }));
  withPortableProviderPluginCatalogLock(
    storeRoot(environment),
    now,
    () => {
      if (!writePrivateJsonIfUnchanged(
        leasePath(checked.lease.leaseId, environment),
        next.lease,
        { expectedCurrentContentSha256: checked.contentSha256 },
      )) {
        throw new Error(
          "portable invocation lease changed or disappeared before containment update",
        );
      }
    },
  );
  return next;
}

export type PortableProviderPluginInvocationLeaseContainmentController =
  PortableProviderPluginCleanupContainment & {
    readonly current: PortableProviderPluginInvocationLeaseSnapshot;
    readonly cleanupComplete: () => void;
  };

/**
 * Bind host containment transitions to one exact durable lease. Every update
 * is a content-addressed CAS under the catalog lock.
 */
export function createPortableProviderPluginInvocationLeaseContainmentController(
  initial: PortableProviderPluginInvocationLeaseSnapshot,
  environment: Environment = process.env,
): PortableProviderPluginInvocationLeaseContainmentController {
  let current = snapshot(initial.lease);
  if (current.contentSha256 !== initial.contentSha256) {
    throw new Error("portable invocation lease snapshot is not content-bound");
  }
  const controller: PortableProviderPluginInvocationLeaseContainmentController = {
    get current() {
      return current;
    },
    hostStarting: (host) => {
      const lease = current.lease;
      if (lease.schemaVersion !== LEASE_SCHEMA_VERSION) {
        throw new Error("legacy portable invocation leases cannot start a host");
      }
      if (lease.containment.status !== "parent-owned") {
        throw new Error("portable invocation lease host started out of order");
      }
      current = replacePortableProviderPluginInvocationLease(
        current,
        Object.freeze({
          status: "host-starting",
          host: Object.freeze({ ...host }),
        }),
        environment,
      );
    },
    hostStarted: (host) => {
      const lease = current.lease;
      if (
        lease.schemaVersion !== LEASE_SCHEMA_VERSION
        || lease.containment.status !== "host-starting"
        || !sameProcessOwner(lease.containment.host, host)
      ) {
        throw new Error("portable invocation lease host admission changed");
      }
      current = replacePortableProviderPluginInvocationLease(
        current,
        Object.freeze({
          status: "host-active",
          host: Object.freeze({ ...host }),
        }),
        environment,
      );
    },
    cleanupComplete: () => {
      const lease = current.lease;
      if (lease.schemaVersion !== LEASE_SCHEMA_VERSION) {
        throw new Error("legacy portable invocation lease cleanup is unverifiable");
      }
      if (lease.containment.status === "cleanup-complete") return;
      if (lease.containment.status === "cleanup-unsafe") {
        throw new Error(
          "portable invocation lease cleanup cannot complete after becoming unsafe",
        );
      }
      const host = lease.containment.status === "parent-owned"
        ? null
        : lease.containment.host;
      current = replacePortableProviderPluginInvocationLease(
        current,
        Object.freeze({
          status: "cleanup-complete",
          host,
        }),
        environment,
      );
    },
    cleanupUnsafe: () => {
      const lease = current.lease;
      if (lease.schemaVersion !== LEASE_SCHEMA_VERSION) {
        throw new Error("legacy portable invocation lease cleanup is unverifiable");
      }
      if (lease.containment.status === "cleanup-unsafe") return;
      if (lease.containment.status === "cleanup-complete") {
        throw new Error(
          "portable invocation lease cleanup became unsafe after completion",
        );
      }
      const host = lease.containment.status === "parent-owned"
        ? null
        : lease.containment.host;
      current = replacePortableProviderPluginInvocationLease(
        current,
        Object.freeze({
          status: "cleanup-unsafe",
          host,
        }),
        environment,
      );
    },
  };
  return Object.freeze(controller);
}

export function releasePortableProviderPluginInvocationLease(
  current: PortableProviderPluginInvocationLeaseSnapshot,
  environment: Environment = process.env,
  now = new Date(),
): void {
  const checked = snapshot(current.lease);
  if (checked.contentSha256 !== current.contentSha256) {
    throw new Error("portable invocation lease snapshot is not content-bound");
  }
  if (
    checked.lease.schemaVersion !== LEASE_SCHEMA_VERSION
    || checked.lease.containment.status !== "cleanup-complete"
  ) {
    throw new Error(
      "portable invocation lease cannot be released before durable cleanup completion",
    );
  }
  withPortableProviderPluginCatalogLock(
    storeRoot(environment),
    now,
    () => {
      if (!removePrivateStateFileIfUnchanged(
        leasePath(checked.lease.leaseId, environment),
        { expectedCurrentContentSha256: checked.contentSha256 },
        environment,
      )) {
        throw new Error(
          "portable invocation lease changed or disappeared before release",
        );
      }
    },
  );
}

export function listPortableProviderPluginInvocationLeases(
  environment: Environment = process.env,
): readonly PortableProviderPluginInvocationLeaseListEntry[] {
  const directory = leaseDirectory(environment);
  const directorySnapshot = snapshotPrivateStateDirectory(
    directory,
    environment,
  );
  if (directorySnapshot.identity === null) return Object.freeze([]);
  const candidates = directorySnapshot.entries.filter((entry) =>
    uuidPattern.test(entry.name.slice(0, -5))
    && entry.name.endsWith(".json")
  );
  const files = readPrivateStateFilesBatched(
    directory,
    candidates
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.name),
    {
      maximumBytesPerFile: MAX_LEASE_BYTES,
      environment,
      expectedDirectoryIdentity: directorySnapshot.identity,
    },
  );
  const byName = new Map(files.map((file) => [file.name, file] as const));
  return Object.freeze(candidates.map((entry) => {
    const leaseId = entry.name.slice(0, -5);
    if (entry.kind !== "file") return { leaseId, invalid: true as const };
    const file = byName.get(entry.name);
    if (file?.status !== "present") {
      return { leaseId, invalid: true as const };
    }
    try {
      const lease = parsePortableProviderPluginInvocationLease(
        JSON.parse(file.content) as unknown,
      );
      if (
        lease.leaseId !== leaseId
        || file.content !== `${canonicalJson(lease)}\n`
      ) {
        return { leaseId, invalid: true as const };
      }
      return Object.freeze({
        lease,
        contentSha256: sha256(file.content),
      });
    } catch {
      return { leaseId, invalid: true as const };
    }
  }));
}

function combinedOwnerStatus(
  lease: PortableProviderPluginInvocationLease,
  inspectOwner: (
    owner: ProcessOwnerIdentity,
  ) => ProcessOwnerStatus,
): ProcessOwnerStatus {
  const parent = inspectOwner(lease.owner);
  if (
    lease.schemaVersion === LEGACY_LEASE_SCHEMA_VERSION
    || lease.containment.status === "parent-owned"
  ) {
    return parent;
  }
  const host = lease.containment.host;
  if (host === null) return parent;
  const child = inspectOwner(host);
  if (
    parent === "exact-live-owner"
    || child === "exact-live-owner"
  ) return "exact-live-owner";
  if (parent === "unknown" || child === "unknown") return "unknown";
  return "different-or-dead";
}

export function portableProviderPluginInvocationLeaseOwnerStatus(
  snapshotValue: PortableProviderPluginInvocationLeaseSnapshot,
  inspectOwner: (
    owner: ProcessOwnerIdentity,
  ) => ProcessOwnerStatus = processOwnerStatus,
): ProcessOwnerStatus {
  const checked = snapshot(snapshotValue.lease);
  if (checked.contentSha256 !== snapshotValue.contentSha256) {
    throw new Error("portable invocation lease snapshot is not content-bound");
  }
  const status = combinedOwnerStatus(checked.lease, inspectOwner);
  if (checked.lease.schemaVersion === LEGACY_LEASE_SCHEMA_VERSION) {
    // Schema v1 did not persist the detached host identity. A dead parent on
    // the same boot is therefore not proof that its old host is gone.
    return status === "exact-live-owner" ? status : "unknown";
  }
  if (
    checked.lease.containment.status === "parent-owned"
    || checked.lease.containment.status === "host-starting"
    || checked.lease.containment.status === "host-active"
    || checked.lease.containment.status === "cleanup-unsafe"
  ) {
    // Every pre-completion state is a tombstone. Parent/host death alone does
    // not prove that detached descendants or parent-side helpers are gone.
    return status === "exact-live-owner" ? status : "unknown";
  }
  return status;
}

export type PortableProviderPluginInvocationLeaseRepairReport = {
  readonly inspected: number;
  readonly removed: number;
  readonly active: number;
  readonly unknown: number;
  readonly invalid: number;
};

type PortableProviderPluginInvocationLeaseRepairOptions = {
  readonly recoverContainmentTombstones?: boolean;
};

/**
 * Remove only leases whose exact process identity is definitely gone. Unknown
 * ownership is retained and reported; wall-clock age is never used as proof.
 */
export function repairPortableProviderPluginInvocationLeases(
  environment: Environment = process.env,
  now = new Date(),
  inspectOwner: (
    owner: ProcessOwnerIdentity,
  ) => ProcessOwnerStatus = processOwnerStatus,
  options: PortableProviderPluginInvocationLeaseRepairOptions = {},
): PortableProviderPluginInvocationLeaseRepairReport {
  return withPortableProviderPluginCatalogLock(
    storeRoot(environment),
    now,
    () => {
      const entries = listPortableProviderPluginInvocationLeases(environment);
      let removed = 0;
      let active = 0;
      let unknown = 0;
      let invalid = 0;
      for (const entry of entries) {
        if ("invalid" in entry) {
          invalid += 1;
          continue;
        }
        let ownerStatus =
          portableProviderPluginInvocationLeaseOwnerStatus(entry, inspectOwner);
        const containmentTombstone = (
          entry.lease.schemaVersion === LEGACY_LEASE_SCHEMA_VERSION
          || (
            entry.lease.containment.status === "parent-owned"
            || entry.lease.containment.status === "host-starting"
            || entry.lease.containment.status === "host-active"
            || entry.lease.containment.status === "cleanup-unsafe"
          )
        );
        if (
          containmentTombstone
          && options.recoverContainmentTombstones === true
          && entry.lease.schemaVersion === LEASE_SCHEMA_VERSION
        ) {
          if (
            entry.lease.containment.status === "parent-owned"
            || entry.lease.containment.status === "host-starting"
          ) {
            ownerStatus = combinedOwnerStatus(entry.lease, inspectOwner);
          } else if (
            entry.lease.containment.status === "host-active"
            || entry.lease.containment.status === "cleanup-unsafe"
          ) {
            try {
              const currentBootId = currentProcessStartIdentity().bootId;
              const hostBootId = entry.lease.containment.host?.bootId;
              // Once plugin code crossed admission, cleanup uncertainty can
              // include detached descendants or parent-side helpers. Only a
              // reboot proves every process from that boundary is gone.
              ownerStatus = (
                  entry.lease.owner.bootId !== currentBootId
                  && (hostBootId === undefined || hostBootId !== currentBootId)
                )
                ? "different-or-dead"
                : "unknown";
            } catch {
              ownerStatus = "unknown";
            }
          }
        }
        if (
          entry.lease.schemaVersion === LEGACY_LEASE_SCHEMA_VERSION
          && options.recoverContainmentTombstones === true
        ) {
          try {
            // A different boot is OS-level proof that no process from the
            // legacy lease can remain. Same-boot v1 state has no safe automatic
            // recovery because it never recorded the detached child.
            if (
              entry.lease.owner.bootId
              !== currentProcessStartIdentity().bootId
            ) {
              ownerStatus = "different-or-dead";
            }
          } catch {
            ownerStatus = "unknown";
          }
        }
        if (ownerStatus === "exact-live-owner") {
          active += 1;
          continue;
        }
        if (
          ownerStatus === "unknown"
          || (
            containmentTombstone
            && options.recoverContainmentTombstones !== true
          )
        ) {
          unknown += 1;
          continue;
        }
        if (removePrivateStateFileIfUnchanged(
          leasePath(entry.lease.leaseId, environment),
          { expectedCurrentContentSha256: entry.contentSha256 },
          environment,
        )) {
          removed += 1;
        } else {
          invalid += 1;
        }
      }
      return Object.freeze({
        inspected: entries.length,
        removed,
        active,
        unknown,
        invalid,
      });
    },
  );
}

/**
 * Explicit operator recovery used by plugin doctor. A pre-admission tombstone
 * is removed only after exact parent-and-host death. Active or unsafe
 * containment is removed only after reboot proves every potentially escaped
 * descendant is gone.
 */
export function recoverPortableProviderPluginInvocationLeaseTombstones(
  environment: Environment = process.env,
  now = new Date(),
  inspectOwner: (
    owner: ProcessOwnerIdentity,
  ) => ProcessOwnerStatus = processOwnerStatus,
): PortableProviderPluginInvocationLeaseRepairReport {
  return repairPortableProviderPluginInvocationLeases(
    environment,
    now,
    inspectOwner,
    { recoverContainmentTombstones: true },
  );
}
