import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";

import {
  linkedDeviceRealmKey,
  loadAuthSnapshot,
  normalizeAuthSubject,
  replaceAuthIfUnchanged,
  type AuthReplaceResult,
  type AuthSnapshot,
  type WrenchAuth,
} from "./auth";
import {
  linkedDeviceLifecycleAdmissionStore,
  type LinkedDeviceLifecycleAdmission,
  type LinkedDeviceLifecycleAdmissionStore,
} from "./linked-device-lifecycle-admission";
import {
  classifyLinkedDeviceLifecycleRestart,
  createLinkedDeviceLifecycleJournal,
  createLinkedDeviceLifecycleOwner,
  initialLinkedDeviceLifecycleJournal,
  listLinkedDeviceLifecycleJournalSnapshots,
  repairInterruptedLinkedDeviceLifecycleJournal,
  updateLinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournalEvent,
  type LinkedDeviceLifecycleJournalListEntry,
  type LinkedDeviceLifecycleJournalSnapshot,
  type LinkedDeviceLifecycleOwner,
  type LinkedDeviceLifecycleRestartDisposition,
  type LinkedDeviceLifecycleResult,
} from "./linked-device-lifecycle-journal";
import { canonicalJson } from "./canonical-json";
import { OperationDeadlineError } from "./operation-deadline";
import { currentProcessStartIdentity } from "./process-identity";
import type {
  LinkedDevicePluginBindingV1,
  ProviderPluginLinkedDeviceAttemptBoundaryV1,
  ProviderPluginLinkedDeviceSyncResultV1,
  ProviderPluginV1,
} from "./provider-plugin";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";

type Environment = Readonly<Record<string, string | undefined>>;
type LinkedDeviceAuth = Extract<
  WrenchAuth,
  { readonly kind: "linked-device-store" }
>;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const OWNER_LEASE_MILLISECONDS = 30 * 60_000;

export type LinkedDeviceLifecycleAuthSnapshot = AuthSnapshot;
export type LinkedDeviceLifecycleAuthReplaceResult = AuthReplaceResult;

/**
 * The concrete implementation is supplied by auth.ts. Keeping this seam
 * explicit makes the runtime unable to fall back to an unconditional write.
 */
export type LinkedDeviceLifecycleAuthStore = {
  readonly loadSnapshot: (
    authId: string,
    environment: Environment,
  ) => LinkedDeviceLifecycleAuthSnapshot;
  readonly replaceIfUnchanged: (
    current: LinkedDeviceLifecycleAuthSnapshot,
    replacement: LinkedDeviceAuth,
    environment: Environment,
    authority: {
      readonly lifecycleAdmission: LinkedDeviceLifecycleAdmission;
    },
  ) => LinkedDeviceLifecycleAuthReplaceResult;
};

const defaultAuthStore: LinkedDeviceLifecycleAuthStore = Object.freeze({
  loadSnapshot: loadAuthSnapshot,
  replaceIfUnchanged: replaceAuthIfUnchanged,
});

export type LinkedDeviceLifecycleJournalStore = {
  readonly createOwner: (leaseUntil: string) => LinkedDeviceLifecycleOwner;
  readonly create: (
    journal: LinkedDeviceLifecycleJournal,
    environment: Environment,
  ) => LinkedDeviceLifecycleJournalSnapshot;
  readonly update: (
    current: LinkedDeviceLifecycleJournalSnapshot,
    event: LinkedDeviceLifecycleJournalEvent,
    options: {
      readonly owner: LinkedDeviceLifecycleOwner;
      readonly environment: Environment;
    },
  ) => LinkedDeviceLifecycleJournalSnapshot;
  readonly list: (
    environment: Environment,
  ) => readonly LinkedDeviceLifecycleJournalListEntry[];
  readonly classifyRestart: (
    journal: LinkedDeviceLifecycleJournal,
  ) => LinkedDeviceLifecycleRestartDisposition;
  readonly repairInterrupted: (
    current: LinkedDeviceLifecycleJournalSnapshot,
    options: {
      readonly owner: LinkedDeviceLifecycleOwner;
      readonly at: string;
      readonly environment: Environment;
    },
  ) => LinkedDeviceLifecycleJournalSnapshot;
};

const defaultJournalStore: LinkedDeviceLifecycleJournalStore = Object.freeze({
  createOwner: createLinkedDeviceLifecycleOwner,
  create: createLinkedDeviceLifecycleJournal,
  update: updateLinkedDeviceLifecycleJournal,
  list: listLinkedDeviceLifecycleJournalSnapshots,
  classifyRestart: classifyLinkedDeviceLifecycleRestart,
  repairInterrupted: repairInterruptedLinkedDeviceLifecycleJournal,
});

export type LinkedDeviceLifecycleRecoveryIssue = {
  readonly journalId: string;
  readonly authId: string | null;
  readonly kind:
    | "invalid-journal"
    | "owner-unknown"
    | "reconciliation-required"
    | "repair-conflict";
};

export type LinkedDeviceLifecycleRecoveryReport = {
  readonly scanned: number;
  readonly complete: number;
  readonly live: number;
  readonly repairedSafeRetry: number;
  readonly repairedIndeterminate: number;
  readonly invalid: number;
  readonly blockedAuthIds: readonly string[];
  readonly blockedRealmKeys: readonly string[];
  readonly issues: readonly LinkedDeviceLifecycleRecoveryIssue[];
};

export type LinkedDevicePairLifecycleResult = {
  readonly journalId: string;
  readonly subject: string;
};

export type LinkedDeviceSyncLifecycleResult = {
  readonly journalId: string;
  readonly result: ProviderPluginLinkedDeviceSyncResultV1;
};

export type LinkedDeviceLifecycleReconciliationInput =
  | {
      readonly outcome: "not-applied";
      readonly evidenceHash: string;
    }
  | {
      readonly outcome: "applied";
      readonly evidenceHash: string;
      readonly result:
        | {
            readonly kind: "pair";
            readonly subject: string;
          }
        | LinkedDeviceSyncResultInput;
    };

type LinkedDeviceSyncResultInput = {
  readonly kind: "sync";
  readonly itemsStored: number;
  readonly projection: "linked-device-local-store";
  readonly emitsProtocolAcknowledgements: true;
};

export type ReconcileLinkedDeviceLifecycleResult = {
  readonly ok: true;
  readonly kind: "linked-device-lifecycle-reconciliation";
  readonly journalId: string;
  readonly authId: string;
  readonly outcome: "applied" | "not-applied";
  readonly status: "succeeded" | "safe-retry";
  readonly reconciliation: "resolved-applied" | "resolved-not-applied";
  readonly evidenceHash: string;
};

export type ReconcileLinkedDeviceLifecycleOptions = RuntimeBaseOptions;

export class LinkedDeviceLifecycleIndeterminateError extends Error {
  readonly journalId: string;

  constructor(journalId: string, cause: unknown) {
    super(
      `linked-device lifecycle attempt ${journalId} has an indeterminate external outcome; inspect it with wrench doctor before retrying`,
      { cause },
    );
    this.name = "LinkedDeviceLifecycleIndeterminateError";
    this.journalId = journalId;
  }
}

type RuntimeBaseOptions = {
  readonly registry: ProviderPluginRegistry;
  readonly authStore?: LinkedDeviceLifecycleAuthStore;
  readonly admissionStore?: LinkedDeviceLifecycleAdmissionStore;
  readonly environment?: Environment;
  readonly journalStore?: LinkedDeviceLifecycleJournalStore;
  readonly now?: () => Date;
  readonly createJournalId?: () => string;
  readonly signal?: AbortSignal;
};

export type RunLinkedDevicePairLifecycleOptions = RuntimeBaseOptions & {
  readonly phone?: string;
  readonly invokePair?: (
    binding: LinkedDevicePluginBindingV1,
    auth: LinkedDeviceAuth,
    options: {
      readonly phone?: string;
      readonly environment: Environment;
      readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    },
  ) => Promise<string>;
};

export type RunLinkedDeviceSyncLifecycleOptions = RuntimeBaseOptions & {
  readonly invokeSyncOnce?: (
    binding: LinkedDevicePluginBindingV1,
    auth: LinkedDeviceAuth,
    options: {
      readonly environment: Environment;
      readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    },
  ) => Promise<ProviderPluginLinkedDeviceSyncResultV1>;
};

function digestBytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalAuthContentHash(auth: LinkedDeviceAuth): string {
  return digestBytes(`${canonicalJson(auth)}\n`);
}

function linkedDeviceStoreIdentity(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  try {
    const bound = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      !bound.isDirectory()
      || current.isSymbolicLink()
      || !current.isDirectory()
      || bound.dev !== current.dev
      || bound.ino !== current.ino
    ) {
      throw new Error(
        "linked-device store must remain one bound canonical physical directory",
      );
    }
    if (realpathSync(path) !== path) {
      throw new Error(
        "linked-device store path changed from its canonical physical locator",
      );
    }
    return `${bound.dev.toString(16)}:${bound.ino.toString(16)}`;
  } finally {
    closeSync(descriptor);
  }
}

function assertLinkedDeviceStoreIdentityUnchanged(
  expected: string | null,
  path: string,
): void {
  const actual = linkedDeviceStoreIdentity(path);
  if (expected === null || actual !== expected) {
    throw new Error(
      "linked-device store physical identity changed during its external lifecycle",
    );
  }
}

function bindLinkedDeviceStoreAtExternalBoundary(
  auth: LinkedDeviceAuth,
  admission: LinkedDeviceLifecycleAdmission,
  expectedIdentity: string | null,
): string {
  if (linkedDeviceRealmKey(auth) !== admission.realmKey) {
    throw new Error(
      "linked-device auth physical realm changed before external dispatch",
    );
  }
  const atBoundary = linkedDeviceStoreIdentity(auth.path);
  if (atBoundary === null) {
    throw new Error(
      "linked-device store must exist before external dispatch begins",
    );
  }
  if (expectedIdentity !== null && atBoundary !== expectedIdentity) {
    throw new Error(
      "linked-device store physical identity changed before external dispatch",
    );
  }
  return atBoundary;
}

function assertAuthSnapshot(
  value: LinkedDeviceLifecycleAuthSnapshot,
  expectedId: string,
): AuthSnapshot & { readonly auth: LinkedDeviceAuth } {
  if (
    value.auth.kind !== "linked-device-store"
    || value.auth.id !== expectedId
    || !sha256Pattern.test(value.contentSha256)
    || canonicalAuthContentHash(value.auth) !== value.contentSha256
  ) {
    throw new Error(
      "linked-device auth snapshot is malformed or not content-bound",
    );
  }
  return Object.freeze({
    auth: value.auth,
    contentSha256: value.contentSha256,
  });
}

function timestamp(now: () => Date): string {
  const value = now();
  if (
    !(value instanceof Date)
    || !Number.isFinite(value.valueOf())
  ) {
    throw new Error("linked-device lifecycle clock returned an invalid time");
  }
  return value.toISOString();
}

function ownerFor(
  journalStore: LinkedDeviceLifecycleJournalStore,
  at: string,
): LinkedDeviceLifecycleOwner {
  return journalStore.createOwner(
    new Date(Date.parse(at) + OWNER_LEASE_MILLISECONDS).toISOString(),
  );
}

function ownerPlugin(
  registry: ProviderPluginRegistry,
  binding: LinkedDevicePluginBindingV1,
): ProviderPluginV1 {
  const owners = registry.list().filter((plugin) =>
    plugin.bindings.includes(binding));
  if (owners.length !== 1 || owners[0] === undefined) {
    throw new Error(
      "linked-device lifecycle binding has no unique registered plugin owner",
    );
  }
  return owners[0];
}

function lifecycleFor(binding: LinkedDevicePluginBindingV1) {
  if (binding.linkedDeviceLifecycle === undefined) {
    throw new Error(
      `provider plugin surface ${binding.surfaceId} has no linked-device lifecycle`,
    );
  }
  return binding.linkedDeviceLifecycle;
}

function validateBindingAuth(
  binding: LinkedDevicePluginBindingV1,
  auth: LinkedDeviceAuth,
): void {
  requireProviderPluginAuth(binding, auth);
  if (auth.provider !== binding.surfaceId) {
    throw new Error("linked-device auth provider does not match its plugin");
  }
}

function createPreparedJournal(
  kind: "pair" | "sync-once",
  binding: LinkedDevicePluginBindingV1,
  snapshot: AuthSnapshot & { readonly auth: LinkedDeviceAuth },
  phoneProvided: boolean,
  admission: LinkedDeviceLifecycleAdmission,
  options: RuntimeBaseOptions,
): {
  readonly owner: LinkedDeviceLifecycleOwner;
  readonly journal: LinkedDeviceLifecycleJournalSnapshot;
} {
  const environment = options.environment ?? process.env;
  const journalStore = options.journalStore ?? defaultJournalStore;
  const startedAt = admission.acquiredAt;
  const owner = admission.owner;
  if (
    admission.authId !== snapshot.auth.id
    || admission.realmKey !== linkedDeviceRealmKey(snapshot.auth)
  ) {
    throw new Error(
      "linked-device lifecycle admission does not match the admitted auth realm",
    );
  }
  const plugin = ownerPlugin(options.registry, binding);
  if (plugin.sourceKind === "portable") {
    throw new Error(
      "portable provider plugins do not support linked-device lifecycle execution",
    );
  }
  const journal = initialLinkedDeviceLifecycleJournal({
    journalId: (options.createJournalId ?? randomUUID)(),
    kind,
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    pluginImplementationHash: options.registry
      .implementationHash(binding)
      .toString("hex"),
    lifecycleContractVersion: 1,
    surfaceId: binding.surfaceId,
    authId: snapshot.auth.id,
    authRealmHash: admission.realmKey,
    authContentHash: snapshot.contentSha256,
    initialSubjectState: snapshot.auth.subject === undefined
      ? "unbound"
      : "bound",
    phoneProvided,
    owner,
    startedAt,
  });
  return Object.freeze({
    owner,
    journal: journalStore.create(journal, environment),
  });
}

async function withLifecycleAdmission<T>(
  authId: string,
  options: RuntimeBaseOptions,
  operation: (
    admission: LinkedDeviceLifecycleAdmission,
    authSnapshot: AuthSnapshot & { readonly auth: LinkedDeviceAuth },
  ) => Promise<T> | T,
): Promise<T> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const authStore = options.authStore ?? defaultAuthStore;
  const admissionStore = options.admissionStore
    ?? linkedDeviceLifecycleAdmissionStore;
  const beforeAdmission = assertAuthSnapshot(
    authStore.loadSnapshot(authId, environment),
    authId,
  );
  const realmKey = linkedDeviceRealmKey(beforeAdmission.auth);
  const recovery = admissionStore.recover(environment);
  if (recovery.issues.length > 0) {
    throw new Error(
      "linked-device lifecycle admissions contain unresolved state; inspect wrench doctor before continuing",
    );
  }
  const admission = admissionStore.acquire(
    realmKey,
    authId,
    timestamp(now),
    environment,
  );
  let result: T;
  try {
    const admittedSnapshot = assertAuthSnapshot(
      authStore.loadSnapshot(authId, environment),
      authId,
    );
    if (
      admittedSnapshot.contentSha256 !== beforeAdmission.contentSha256
      || linkedDeviceRealmKey(admittedSnapshot.auth) !== realmKey
    ) {
      throw new Error(
        `auth locator ${authId} changed while its linked-device realm admission was acquired`,
      );
    }
    result = await operation(admission, admittedSnapshot);
  } catch (error) {
    try {
      admission.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "linked-device lifecycle failed and its admission could not be released",
      );
    }
    throw error;
  }
  admission.release();
  return result;
}

function postBeginReason(
  error: unknown,
  signal: AbortSignal | undefined,
  externalReturned: boolean,
):
  | "runtime-error-after-begin"
  | "cancelled-after-begin"
  | "deadline-after-begin"
  | "external-returned-before-completion-persisted" {
  if (externalReturned) {
    return "external-returned-before-completion-persisted";
  }
  if (
    error instanceof OperationDeadlineError
    && error.failure === "timed-out"
  ) return "deadline-after-begin";
  if (
    signal?.aborted === true
    || (
      error instanceof OperationDeadlineError
      && error.failure === "cancelled"
    )
  ) return "cancelled-after-begin";
  return "runtime-error-after-begin";
}

function failLifecycle(
  current: LinkedDeviceLifecycleJournalSnapshot,
  owner: LinkedDeviceLifecycleOwner,
  error: unknown,
  options: RuntimeBaseOptions,
  externalReturned = false,
): never {
  const environment = options.environment ?? process.env;
  const journalStore = options.journalStore ?? defaultJournalStore;
  const now = options.now ?? (() => new Date());
  const began = current.journal.phase !== "prepared";
  const indeterminate = began || externalReturned;
  try {
    journalStore.update(
      current,
      indeterminate
        ? {
            type: "outcome-not-durable",
            reasonCode: postBeginReason(
              error,
              options.signal,
              externalReturned,
            ),
            at: timestamp(now),
          }
        : {
            type: "aborted-before-external",
            reasonCode: options.signal?.aborted === true
              ? "cancelled-before-begin"
              : "preflight-failed",
            at: timestamp(now),
          },
      { owner, environment },
    );
  } catch {
    // The original failure remains primary. Restart classification handles any
    // journal that could not be terminalized here.
  }
  if (indeterminate) {
    throw new LinkedDeviceLifecycleIndeterminateError(
      current.journal.journalId,
      error,
    );
  }
  throw error;
}

function boundaryFor(
  initial: LinkedDeviceLifecycleJournalSnapshot,
  owner: LinkedDeviceLifecycleOwner,
  options: RuntimeBaseOptions,
  getCurrent: () => LinkedDeviceLifecycleJournalSnapshot,
  setCurrent: (value: LinkedDeviceLifecycleJournalSnapshot) => void,
  bindExternalStore: () => void,
): {
  readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
  readonly wasCrossed: () => boolean;
  readonly crossConservatively: () => Promise<void>;
} {
  const environment = options.environment ?? process.env;
  const journalStore = options.journalStore ?? defaultJournalStore;
  const now = options.now ?? (() => new Date());
  let beginPromise: Promise<void> | null = null;
  const cross = (conservative: boolean): Promise<void> => {
    if (beginPromise !== null) return beginPromise;
    const pending = Promise.resolve().then(() => {
      if (!conservative && options.signal?.aborted === true) {
        throw new OperationDeadlineError(
          "linked-device lifecycle",
          "cancelled",
        );
      }
      const current = getCurrent();
      if (current.journal.phase !== "prepared") return;
      if (!conservative) bindExternalStore();
      setCurrent(journalStore.update(
        current,
        { type: "external-begin", at: timestamp(now) },
        { owner, environment },
      ));
      if (conservative) bindExternalStore();
    });
    beginPromise = pending.catch((error: unknown) => {
      beginPromise = null;
      throw error;
    });
    return beginPromise;
  };
  return Object.freeze({
    attempt: Object.freeze({
      journalId: initial.journal.journalId,
      beforeExternalBegin: () => cross(false),
    }),
    wasCrossed: () => getCurrent().journal.phase !== "prepared",
    crossConservatively: () => cross(true),
  });
}

function recoveryIssue(
  journalId: string,
  authId: string | null,
  kind: LinkedDeviceLifecycleRecoveryIssue["kind"],
): LinkedDeviceLifecycleRecoveryIssue {
  return Object.freeze({ journalId, authId, kind });
}

/**
 * Classify and repair only local journal state. This never invokes a plugin,
 * probes a provider, retries an external action, or claims reconciliation.
 */
export function recoverLinkedDeviceLifecycleJournals(
  options: {
    readonly environment?: Environment;
    readonly journalStore?: LinkedDeviceLifecycleJournalStore;
    readonly now?: () => Date;
  } = {},
): LinkedDeviceLifecycleRecoveryReport {
  const environment = options.environment ?? process.env;
  const journalStore = options.journalStore ?? defaultJournalStore;
  const now = options.now ?? (() => new Date());
  const entries = journalStore.list(environment);
  const issues: LinkedDeviceLifecycleRecoveryIssue[] = [];
  const blockedAuthIds = new Set<string>();
  const blockedRealmKeys = new Set<string>();
  let complete = 0;
  let live = 0;
  let repairedSafeRetry = 0;
  let repairedIndeterminate = 0;
  let invalid = 0;
  let repairOwner: LinkedDeviceLifecycleOwner | null = null;

  for (const entry of entries) {
    if ("invalid" in entry) {
      invalid += 1;
      issues.push(recoveryIssue(
        entry.journalId,
        null,
        "invalid-journal",
      ));
      continue;
    }
    const journal = entry.journal;
    if (journal.phase === "terminal") {
      if (journal.status === "indeterminate") {
        blockedAuthIds.add(journal.authId);
        blockedRealmKeys.add(journal.authRealmHash);
        issues.push(recoveryIssue(
          journal.journalId,
          journal.authId,
          "reconciliation-required",
        ));
      } else {
        complete += 1;
      }
      continue;
    }
    const disposition = journalStore.classifyRestart(journal);
    if (disposition.kind === "complete") {
      complete += 1;
      continue;
    }
    if (disposition.kind === "live-owner") {
      live += 1;
      blockedAuthIds.add(journal.authId);
      blockedRealmKeys.add(journal.authRealmHash);
      continue;
    }
    if (disposition.kind === "owner-unknown") {
      blockedAuthIds.add(journal.authId);
      blockedRealmKeys.add(journal.authRealmHash);
      issues.push(recoveryIssue(
        journal.journalId,
        journal.authId,
        "owner-unknown",
      ));
      continue;
    }
    const at = timestamp(now);
    repairOwner ??= ownerFor(journalStore, at);
    try {
      const repaired = journalStore.repairInterrupted(entry, {
        owner: repairOwner,
        at,
        environment,
      });
      if (repaired.journal.status === "safe-retry") {
        repairedSafeRetry += 1;
      } else {
        repairedIndeterminate += 1;
        blockedAuthIds.add(repaired.journal.authId);
        blockedRealmKeys.add(repaired.journal.authRealmHash);
        issues.push(recoveryIssue(
          repaired.journal.journalId,
          repaired.journal.authId,
          "reconciliation-required",
        ));
      }
    } catch {
      blockedAuthIds.add(journal.authId);
      blockedRealmKeys.add(journal.authRealmHash);
      issues.push(recoveryIssue(
        journal.journalId,
        journal.authId,
        "repair-conflict",
      ));
    }
  }

  return Object.freeze({
    scanned: entries.length,
    complete,
    live,
    repairedSafeRetry,
    repairedIndeterminate,
    invalid,
    blockedAuthIds: Object.freeze([...blockedAuthIds].sort()),
    blockedRealmKeys: Object.freeze([...blockedRealmKeys].sort()),
    issues: Object.freeze(issues),
  });
}

function assertLifecycleMayStart(
  authId: string,
  realmKey: string,
  options: RuntimeBaseOptions,
): void {
  const recovery = recoverLinkedDeviceLifecycleJournals(options);
  if (recovery.invalid > 0) {
    throw new Error(
      "linked-device lifecycle journals contain invalid state; inspect wrench doctor before continuing",
    );
  }
  if (
    recovery.blockedAuthIds.includes(authId)
    || recovery.blockedRealmKeys.includes(realmKey)
  ) {
    throw new Error(
      `auth locator ${authId} has an unresolved linked-device lifecycle; reconcile it before retrying`,
    );
  }
}

function validatePairSubject(
  binding: LinkedDevicePluginBindingV1,
  auth: LinkedDeviceAuth,
  subject: string,
): string {
  const normalized = normalizeAuthSubject(subject);
  if (!binding.subject.matches(normalized)) {
    throw new Error(
      `provider plugin surface ${binding.surfaceId} returned a subject outside ${binding.subject.format}`,
    );
  }
  if (auth.subject !== undefined && auth.subject !== normalized) {
    throw new Error(
      "paired linked-device account did not match the auth realm's existing subject",
    );
  }
  return normalized;
}

function journalSyncResult(
  value: ProviderPluginLinkedDeviceSyncResultV1,
): LinkedDeviceLifecycleResult {
  if (
    !Number.isSafeInteger(value.itemsStored)
    || value.itemsStored < 0
    || value.itemsStored > 1_000_000_000
    || typeof value.projection !== "string"
    || value.projection.length < 1
    || value.projection.length > 256
    || value.emitsProtocolAcknowledgements !== true
  ) {
    throw new Error(
      "linked-device plugin returned an invalid one-shot sync result",
    );
  }
  return Object.freeze({
    kind: "sync",
    itemsStored: value.itemsStored,
    projection: "linked-device-local-store",
    emitsProtocolAcknowledgements: true,
  });
}

function strictReconciliationRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) =>
      typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
  const record: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

export function parseLinkedDeviceLifecycleReconciliationInput(
  value: unknown,
): LinkedDeviceLifecycleReconciliationInput {
  const base = strictReconciliationRecord(
    value,
    typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "result")
      ? ["outcome", "evidenceHash", "result"]
      : ["outcome", "evidenceHash"],
    "linked-device lifecycle reconciliation input",
  );
  if (
    typeof base.evidenceHash !== "string"
    || !sha256Pattern.test(base.evidenceHash)
  ) {
    throw new Error(
      "linked-device lifecycle reconciliation evidence hash is malformed",
    );
  }
  if (base.outcome === "not-applied") {
    if ("result" in base) {
      throw new Error(
        "not-applied linked-device reconciliation must not include a result",
      );
    }
    return Object.freeze({
      outcome: "not-applied",
      evidenceHash: base.evidenceHash,
    });
  }
  if (base.outcome !== "applied" || !("result" in base)) {
    throw new Error(
      "linked-device lifecycle reconciliation outcome is malformed",
    );
  }
  const resultValue = base.result;
  if (
    typeof resultValue === "object"
    && resultValue !== null
    && !Array.isArray(resultValue)
    && Object.prototype.hasOwnProperty.call(resultValue, "kind")
    && Object.getOwnPropertyDescriptor(resultValue, "kind")?.value === "pair"
  ) {
    const result = strictReconciliationRecord(
      resultValue,
      ["kind", "subject"],
      "linked-device pair reconciliation result",
    );
    if (result.kind !== "pair" || typeof result.subject !== "string") {
      throw new Error("linked-device pair reconciliation result is malformed");
    }
    return Object.freeze({
      outcome: "applied",
      evidenceHash: base.evidenceHash,
      result: Object.freeze({
        kind: "pair",
        subject: normalizeAuthSubject(result.subject),
      }),
    });
  }
  const result = strictReconciliationRecord(
    resultValue,
    ["kind", "itemsStored", "projection", "emitsProtocolAcknowledgements"],
    "linked-device sync reconciliation result",
  );
  const parsed = journalSyncResult({
    itemsStored: typeof result.itemsStored === "number"
      ? result.itemsStored
      : Number.NaN,
    projection: typeof result.projection === "string"
      ? result.projection
      : "",
    emitsProtocolAcknowledgements:
      result.emitsProtocolAcknowledgements === true,
  });
  if (
    result.kind !== "sync"
    || result.projection !== "linked-device-local-store"
    || parsed.kind !== "sync"
  ) {
    throw new Error("linked-device sync reconciliation result is malformed");
  }
  return Object.freeze({
    outcome: "applied",
    evidenceHash: base.evidenceHash,
    result: Object.freeze({
      kind: "sync",
      itemsStored: parsed.itemsStored,
      projection: parsed.projection,
      emitsProtocolAcknowledgements: true,
    }),
  });
}

function currentProcessOwns(
  owner: LinkedDeviceLifecycleOwner,
): boolean {
  const identity = currentProcessStartIdentity();
  return owner.pid === process.pid
    && owner.bootId === identity.bootId
    && owner.processStartId === identity.processStartId;
}

function lifecycleSnapshotById(
  journalId: string,
  journalStore: LinkedDeviceLifecycleJournalStore,
  environment: Environment,
): LinkedDeviceLifecycleJournalSnapshot {
  let found: LinkedDeviceLifecycleJournalSnapshot | null = null;
  for (const entry of journalStore.list(environment)) {
    if ("invalid" in entry) {
      if (entry.journalId === journalId) {
        throw new Error(
          `linked-device lifecycle journal ${journalId} is invalid`,
        );
      }
      continue;
    }
    if (entry.journal.journalId !== journalId) continue;
    if (found !== null) {
      throw new Error(
        `linked-device lifecycle journal ${journalId} is duplicated`,
      );
    }
    found = entry;
  }
  if (found === null) {
    throw new Error(
      `linked-device lifecycle journal ${journalId} was not found`,
    );
  }
  return found;
}

function reconciliationResultView(
  journal: LinkedDeviceLifecycleJournal,
  input: LinkedDeviceLifecycleReconciliationInput,
  authSnapshot: AuthSnapshot & { readonly auth: LinkedDeviceAuth },
  binding: LinkedDevicePluginBindingV1,
  validateAppliedResult = true,
): ReconcileLinkedDeviceLifecycleResult {
  if (
    journal.phase !== "terminal"
    || (
      journal.reconciliation !== "resolved-applied"
      && journal.reconciliation !== "resolved-not-applied"
    )
    || journal.reconciliationHash !== input.evidenceHash
    || (
      input.outcome === "applied"
        ? journal.status !== "succeeded"
          || journal.reconciliation !== "resolved-applied"
        : journal.status !== "safe-retry"
          || journal.reconciliation !== "resolved-not-applied"
    )
  ) {
    throw new Error(
      "linked-device lifecycle is already resolved with a different reconciliation",
    );
  }
  if (input.outcome === "applied" && validateAppliedResult) {
    if (input.result.kind === "sync") {
      if (
        journal.kind !== "sync-once"
        || journal.result?.kind !== "sync"
        || journal.result.itemsStored !== input.result.itemsStored
        || journal.result.projection !== input.result.projection
        || journal.result.emitsProtocolAcknowledgements
          !== input.result.emitsProtocolAcknowledgements
      ) {
        throw new Error(
          "linked-device lifecycle is already resolved with a different reconciliation result",
        );
      }
    } else {
      const subject = validatePairSubject(
        binding,
        authSnapshot.auth,
        input.result.subject,
      );
      if (
        journal.kind !== "pair"
        || authSnapshot.auth.subject !== subject
        || journal.result?.kind !== "pair"
        || journal.result.resultingAuthContentHash
          !== authSnapshot.contentSha256
      ) {
        throw new Error(
          "linked-device lifecycle is already resolved with a different reconciliation result",
        );
      }
    }
  }
  return Object.freeze({
    ok: true,
    kind: "linked-device-lifecycle-reconciliation",
    journalId: journal.journalId,
    authId: journal.authId,
    outcome: input.outcome,
    status: input.outcome === "applied" ? "succeeded" : "safe-retry",
    reconciliation: input.outcome === "applied"
      ? "resolved-applied"
      : "resolved-not-applied",
    evidenceHash: input.evidenceHash,
  });
}

/**
 * Discharge an indeterminate post-boundary lifecycle from explicit,
 * independently obtained evidence. This path never invokes the provider
 * lifecycle and never retries the effect-capable operation.
 */
export async function reconcileLinkedDeviceLifecycleJournal(
  journalId: string,
  inputValue: unknown,
  options: ReconcileLinkedDeviceLifecycleOptions,
): Promise<ReconcileLinkedDeviceLifecycleResult> {
  const input = parseLinkedDeviceLifecycleReconciliationInput(inputValue);
  const environment = options.environment ?? process.env;
  const journalStore = options.journalStore ?? defaultJournalStore;
  const initial = lifecycleSnapshotById(
    journalId,
    journalStore,
    environment,
  );
  return withLifecycleAdmission(
    initial.journal.authId,
    options,
    (admission, authSnapshot) => {
      let current = lifecycleSnapshotById(
        journalId,
        journalStore,
        environment,
      );
      if (
        current.journal.authId !== authSnapshot.auth.id
        || current.journal.authRealmHash !== admission.realmKey
      ) {
        throw new Error(
          "linked-device lifecycle journal no longer matches its auth realm",
        );
      }
      const binding = (() => {
        const selected = options.registry.requireSessionRoute(
          current.journal.surfaceId,
        );
        if (selected.transport !== "linked-device") {
          throw new Error(
            "linked-device lifecycle journal surface is no longer linked-device",
          );
        }
        const plugin = ownerPlugin(options.registry, selected);
        if (
          plugin.id !== current.journal.pluginId
          || plugin.version !== current.journal.pluginVersion
          || options.registry.implementationHash(selected).toString("hex")
            !== current.journal.pluginImplementationHash
        ) {
          throw new Error(
            "linked-device lifecycle plugin implementation no longer matches its journal",
          );
        }
        return selected;
      })();
      validateBindingAuth(binding, authSnapshot.auth);
      if (current.journal.phase !== "terminal") {
        const disposition = journalStore.classifyRestart(current.journal);
        if (disposition.kind !== "reconciliation-required") {
          throw new Error(
            `linked-device lifecycle cannot be reconciled: ${disposition.reason}`,
          );
        }
        const at = timestamp(options.now ?? (() => new Date()));
        const repairOwner = ownerFor(journalStore, at);
        current = journalStore.repairInterrupted(current, {
          owner: repairOwner,
          at,
          environment,
        });
      }
      if (
        current.journal.phase === "terminal"
        && current.journal.status !== "indeterminate"
      ) {
        return reconciliationResultView(
          current.journal,
          input,
          authSnapshot,
          binding,
        );
      }
      if (
        current.journal.phase !== "terminal"
        || current.journal.status !== "indeterminate"
        || current.journal.reconciliation !== "required"
      ) {
        throw new Error(
          "linked-device lifecycle is not ready for explicit reconciliation",
        );
      }

      let owner: LinkedDeviceLifecycleOwner;
      if (currentProcessOwns(current.journal.owner)) {
        owner = current.journal.owner;
      } else {
        const disposition = journalStore.classifyRestart(current.journal);
        if (disposition.kind !== "reconciliation-required") {
          throw new Error(
            `linked-device lifecycle cannot be reconciled: ${disposition.reason}`,
          );
        }
        const at = timestamp(options.now ?? (() => new Date()));
        owner = ownerFor(journalStore, at);
        current = journalStore.repairInterrupted(current, {
          owner,
          at,
          environment,
        });
      }

      let journalResult: LinkedDeviceLifecycleResult | undefined;
      if (input.outcome === "not-applied") {
        if (
          current.journal.externalCompletedAt !== null
          || current.journal.result !== null
          || current.journal.reasonCode
            === "external-returned-before-completion-persisted"
        ) {
          throw new Error(
            "not-applied reconciliation contradicts durable linked-device external completion",
          );
        }
        if (authSnapshot.contentSha256 !== current.journal.authContentHash) {
          throw new Error(
            "linked-device auth changed since the indeterminate lifecycle began",
          );
        }
      } else if (input.result.kind === "sync") {
        if (
          current.journal.kind !== "sync-once"
          || authSnapshot.contentSha256 !== current.journal.authContentHash
        ) {
          throw new Error(
            "linked-device sync reconciliation contradicts its journal or auth snapshot",
          );
        }
        journalResult = input.result;
      } else {
        if (current.journal.kind !== "pair") {
          throw new Error(
            "linked-device pair reconciliation contradicts its journal",
          );
        }
        const subject = validatePairSubject(
          binding,
          authSnapshot.auth,
          input.result.subject,
        );
        const replacement = Object.freeze({
          ...authSnapshot.auth,
          subject,
        });
        const desiredHash = canonicalAuthContentHash(replacement);
        journalResult = Object.freeze({
          kind: "pair",
          resultingAuthContentHash: desiredHash,
        });
        if (
          current.journal.result !== null
          && (
            current.journal.result.kind !== "pair"
            || current.journal.result.resultingAuthContentHash !== desiredHash
          )
        ) {
          throw new Error(
            "linked-device pair reconciliation contradicts the external completion journal",
          );
        }
        if (authSnapshot.contentSha256 === current.journal.authContentHash) {
          const authStore = options.authStore ?? defaultAuthStore;
          const replacementResult = authStore.replaceIfUnchanged(
            authSnapshot,
            replacement,
            environment,
            { lifecycleAdmission: admission },
          );
          if (
            !replacementResult.replaced
            || replacementResult.snapshot.contentSha256 !== desiredHash
          ) {
            throw new Error(
              "linked-device pair reconciliation lost its auth commit CAS",
            );
          }
        } else if (authSnapshot.contentSha256 !== desiredHash) {
          throw new Error(
            "linked-device auth changed since the indeterminate pairing began",
          );
        }
      }
      const at = timestamp(options.now ?? (() => new Date()));
      current = journalStore.update(
        current,
        input.outcome === "applied"
          ? {
              type: "reconciled",
              outcome: "applied",
              evidenceHash: input.evidenceHash,
              result: journalResult
                ?? (() => {
                  throw new Error(
                    "applied linked-device reconciliation has no result",
                  );
                })(),
              at,
            }
          : {
              type: "reconciled",
              outcome: "not-applied",
              evidenceHash: input.evidenceHash,
              at,
            },
        { owner, environment },
      );
      return reconciliationResultView(
        current.journal,
        input,
        authSnapshot,
        binding,
        false,
      );
    },
  );
}

async function runLinkedDevicePairLifecycleAdmitted(
  binding: LinkedDevicePluginBindingV1,
  authId: string,
  options: RunLinkedDevicePairLifecycleOptions,
  admission: LinkedDeviceLifecycleAdmission,
  admittedAuthSnapshot: AuthSnapshot & { readonly auth: LinkedDeviceAuth },
): Promise<LinkedDevicePairLifecycleResult> {
  const environment = options.environment ?? process.env;
  const journalStore = options.journalStore ?? defaultJournalStore;
  const authStore = options.authStore ?? defaultAuthStore;
  const now = options.now ?? (() => new Date());
  assertLifecycleMayStart(authId, admission.realmKey, options);
  const authSnapshot = admittedAuthSnapshot;
  let storeIdentity = linkedDeviceStoreIdentity(authSnapshot.auth.path);
  validateBindingAuth(binding, authSnapshot.auth);
  lifecycleFor(binding);
  const prepared = createPreparedJournal(
    "pair",
    binding,
    authSnapshot,
    options.phone !== undefined,
    admission,
    options,
  );
  let current = prepared.journal;
  const boundary = boundaryFor(
    prepared.journal,
    prepared.owner,
    options,
    () => current,
    (value) => {
      current = value;
    },
    () => {
      storeIdentity = bindLinkedDeviceStoreAtExternalBoundary(
        authSnapshot.auth,
        admission,
        storeIdentity,
      );
    },
  );
  let externalReturned = false;
  try {
    if (options.signal?.aborted === true) {
      throw new OperationDeadlineError("linked-device pairing", "cancelled");
    }
    const invoke = options.invokePair
      ?? ((
        selectedBinding: LinkedDevicePluginBindingV1,
        auth: LinkedDeviceAuth,
        invocationOptions: {
          readonly phone?: string;
          readonly environment: Environment;
          readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
        },
      ) => lifecycleFor(selectedBinding).pair(auth, invocationOptions));
    const subject = await invoke(binding, authSnapshot.auth, {
      ...(options.phone === undefined ? {} : { phone: options.phone }),
      environment,
      attempt: boundary.attempt,
    });
    externalReturned = true;
    if (!boundary.wasCrossed()) {
      await boundary.crossConservatively();
      throw new Error(
        "linked-device plugin returned from pairing without crossing its durable external boundary",
      );
    }
    const normalizedSubject = validatePairSubject(
      binding,
      authSnapshot.auth,
      subject,
    );
    const replacement = Object.freeze({
      ...authSnapshot.auth,
      subject: normalizedSubject,
    });
    const result = Object.freeze({
      kind: "pair" as const,
      resultingAuthContentHash: canonicalAuthContentHash(replacement),
    });
    current = journalStore.update(
      current,
      { type: "external-complete", result, at: timestamp(now) },
      { owner: prepared.owner, environment },
    );
    assertLinkedDeviceStoreIdentityUnchanged(
      storeIdentity,
      authSnapshot.auth.path,
    );
    const replacementResult = authStore.replaceIfUnchanged(
      authSnapshot,
      replacement,
      environment,
      { lifecycleAdmission: admission },
    );
    if (!replacementResult.replaced) {
      throw new Error(
        "linked-device auth changed concurrently after external pairing",
      );
    }
    const written = assertAuthSnapshot(replacementResult.snapshot, authId);
    if (written.contentSha256 !== result.resultingAuthContentHash) {
      throw new Error(
        "linked-device auth replacement returned an unexpected content hash",
      );
    }
    current = journalStore.update(
      current,
      { type: "committed", result, at: timestamp(now) },
      { owner: prepared.owner, environment },
    );
    return Object.freeze({
      journalId: current.journal.journalId,
      subject: normalizedSubject,
    });
  } catch (error) {
    return failLifecycle(
      current,
      prepared.owner,
      error,
      options,
      externalReturned,
    );
  }
}

async function runLinkedDeviceSyncOnceLifecycleAdmitted(
  binding: LinkedDevicePluginBindingV1,
  authId: string,
  options: RunLinkedDeviceSyncLifecycleOptions,
  admission: LinkedDeviceLifecycleAdmission,
  admittedAuthSnapshot: AuthSnapshot & { readonly auth: LinkedDeviceAuth },
): Promise<LinkedDeviceSyncLifecycleResult> {
  const environment = options.environment ?? process.env;
  const journalStore = options.journalStore ?? defaultJournalStore;
  const authStore = options.authStore ?? defaultAuthStore;
  const now = options.now ?? (() => new Date());
  assertLifecycleMayStart(authId, admission.realmKey, options);
  const authSnapshot = admittedAuthSnapshot;
  let storeIdentity = linkedDeviceStoreIdentity(authSnapshot.auth.path);
  validateBindingAuth(binding, authSnapshot.auth);
  if (authSnapshot.auth.subject === undefined) {
    throw new Error(
      "linked-device sync requires an account-bound auth locator",
    );
  }
  if (!binding.subject.matches(authSnapshot.auth.subject)) {
    throw new Error(
      `auth subject does not match ${binding.subject.format}`,
    );
  }
  lifecycleFor(binding);
  const prepared = createPreparedJournal(
    "sync-once",
    binding,
    authSnapshot,
    false,
    admission,
    options,
  );
  let current = prepared.journal;
  const boundary = boundaryFor(
    prepared.journal,
    prepared.owner,
    options,
    () => current,
    (value) => {
      current = value;
    },
    () => {
      storeIdentity = bindLinkedDeviceStoreAtExternalBoundary(
        authSnapshot.auth,
        admission,
        storeIdentity,
      );
    },
  );
  let externalReturned = false;
  try {
    if (options.signal?.aborted === true) {
      throw new OperationDeadlineError("linked-device sync", "cancelled");
    }
    const invoke = options.invokeSyncOnce
      ?? ((
        selectedBinding: LinkedDevicePluginBindingV1,
        auth: LinkedDeviceAuth,
        invocationOptions: {
          readonly environment: Environment;
          readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
        },
      ) => lifecycleFor(selectedBinding).syncOnce(auth, invocationOptions));
    const pluginResult = await invoke(binding, authSnapshot.auth, {
      environment,
      attempt: boundary.attempt,
    });
    externalReturned = true;
    if (!boundary.wasCrossed()) {
      await boundary.crossConservatively();
      throw new Error(
        "linked-device plugin returned from sync without crossing its durable external boundary",
      );
    }
    const result = journalSyncResult(pluginResult);
    current = journalStore.update(
      current,
      { type: "external-complete", result, at: timestamp(now) },
      { owner: prepared.owner, environment },
    );
    assertLinkedDeviceStoreIdentityUnchanged(
      storeIdentity,
      authSnapshot.auth.path,
    );
    const commitAuthSnapshot = assertAuthSnapshot(
      authStore.loadSnapshot(authId, environment),
      authId,
    );
    if (
      commitAuthSnapshot.contentSha256 !== authSnapshot.contentSha256
      || linkedDeviceRealmKey(commitAuthSnapshot.auth)
        !== admission.realmKey
    ) {
      throw new Error(
        "linked-device auth changed concurrently after external sync",
      );
    }
    current = journalStore.update(
      current,
      { type: "committed", result, at: timestamp(now) },
      { owner: prepared.owner, environment },
    );
    return Object.freeze({
      journalId: current.journal.journalId,
      result: Object.freeze({ ...pluginResult }),
    });
  } catch (error) {
    return failLifecycle(
      current,
      prepared.owner,
      error,
      options,
      externalReturned,
    );
  }
}

export async function runLinkedDevicePairLifecycle(
  binding: LinkedDevicePluginBindingV1,
  authId: string,
  options: RunLinkedDevicePairLifecycleOptions,
): Promise<LinkedDevicePairLifecycleResult> {
  lifecycleFor(binding);
  const plugin = ownerPlugin(options.registry, binding);
  if (plugin.sourceKind === "portable") {
    throw new Error(
      "portable provider plugins do not support linked-device lifecycle execution",
    );
  }
  return withLifecycleAdmission(
    authId,
    options,
    (admission, authSnapshot) =>
      runLinkedDevicePairLifecycleAdmitted(
        binding,
        authId,
        options,
        admission,
        authSnapshot,
      ),
  );
}

export async function runLinkedDeviceSyncOnceLifecycle(
  binding: LinkedDevicePluginBindingV1,
  authId: string,
  options: RunLinkedDeviceSyncLifecycleOptions,
): Promise<LinkedDeviceSyncLifecycleResult> {
  lifecycleFor(binding);
  const plugin = ownerPlugin(options.registry, binding);
  if (plugin.sourceKind === "portable") {
    throw new Error(
      "portable provider plugins do not support linked-device lifecycle execution",
    );
  }
  return withLifecycleAdmission(
    authId,
    options,
    (admission, authSnapshot) =>
      runLinkedDeviceSyncOnceLifecycleAdmitted(
        binding,
        authId,
        options,
        admission,
        authSnapshot,
      ),
  );
}
