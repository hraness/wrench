import { join } from "node:path";

import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import {
  extendProviderPluginRegistryWithPortablePlugins,
} from "./provider-plugin-registry";
import {
  listPortableProviderPluginInvocationLeases,
  portableProviderPluginInvocationLeaseOwnerStatus,
  type PortableProviderPluginInvocationLeaseListEntry,
  type PortableProviderPluginInvocationLeaseSnapshot,
} from "./provider-plugin-invocation-lease";
import {
  createPortableProviderPluginCatalog,
  projectPortableProviderPluginPackage,
} from "./provider-plugin-portable-catalog";
import type {
  PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import type {
  VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  listLinkedDeviceLifecycleJournalSnapshots,
  type LinkedDeviceLifecycleJournalListEntry,
} from "./linked-device-lifecycle-journal";
import {
  listRecoveryCapsuleSnapshots,
  type RecoveryCapsuleListEntry,
} from "./recovery";
import {
  listRunJournalSnapshots,
  type RunJournalSnapshot,
} from "./run-journal";
import {
  listInvocationPlans,
  listConfirmationClaimSnapshots,
  listRunReceipts,
  loadInvocationPlan,
  type ConfirmationClaimSnapshot,
  type ListedConfirmationClaim,
  type ListedInvocationPlan,
  type ListedRunReceipt,
  type StoredPlan,
} from "./runtime";
import {
  listInstalledDiagnosticManifestSnapshots,
  wrenchStateHome,
  snapshotPrivateStateDirectory,
  type PrivateStateDirectoryEntry,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_REPORTED_BLOCKERS = 64;

export type PortableProviderPluginLifecycleBlocker = {
  readonly kind:
    | "invalid-plan"
    | "confirmation-plan"
    | "invalid-confirmation-claim"
    | "confirmation-claim"
    | "invalid-invocation-lease"
    | "invocation-lease"
    | "invalid-run-journal"
    | "run-journal"
    | "invalid-run-receipt"
    | "run-receipt"
    | "invalid-recovery-capsule"
    | "recovery-capsule"
    | "invalid-linked-device-lifecycle"
    | "linked-device-lifecycle"
    | "unexpected-state-entry";
  readonly coordinate: string;
  readonly reason: string;
};

export type PortableProviderPluginQuiescenceReport = {
  readonly bundleSha256: string;
  readonly quiescent: boolean;
  readonly blockerCount: number;
  readonly blockers: readonly PortableProviderPluginLifecycleBlocker[];
};

export type PortableProviderPluginQuiescenceDependencies = {
  readonly listPlans: (
    environment: Environment,
  ) => readonly ListedInvocationPlan[];
  readonly loadPlan: (
    digest: string,
    environment: Environment,
  ) => StoredPlan;
  readonly listConfirmationClaims: (
    environment: Environment,
  ) => readonly ListedConfirmationClaim[];
  readonly listInvocationLeases: (
    environment: Environment,
  ) => readonly PortableProviderPluginInvocationLeaseListEntry[];
  readonly invocationLeaseOwnerStatus: (
    snapshot: PortableProviderPluginInvocationLeaseSnapshot,
  ) => "exact-live-owner" | "different-or-dead" | "unknown";
  readonly listStateDirectory: (
    path: string,
    environment: Environment,
  ) => readonly PrivateStateDirectoryEntry[];
  readonly listReceipts: (
    environment: Environment,
  ) => readonly ListedRunReceipt[];
  readonly listJournals: (
    environment: Environment,
  ) => readonly (
    | RunJournalSnapshot
    | { readonly runId: string; readonly invalid: true }
  )[];
  readonly listRecoveryCapsules: (
    environment: Environment,
  ) => readonly RecoveryCapsuleListEntry[];
  readonly listLinkedDeviceLifecycles: (
    environment: Environment,
  ) => readonly LinkedDeviceLifecycleJournalListEntry[];
};

const quiescenceDependencies: PortableProviderPluginQuiescenceDependencies =
  Object.freeze({
    listPlans: listInvocationPlans,
    loadPlan: loadInvocationPlan,
    listConfirmationClaims: listConfirmationClaimSnapshots,
    listInvocationLeases: listPortableProviderPluginInvocationLeases,
    invocationLeaseOwnerStatus:
      portableProviderPluginInvocationLeaseOwnerStatus,
    listStateDirectory: (path, environment) =>
      snapshotPrivateStateDirectory(path, environment).entries,
    listReceipts: listRunReceipts,
    listJournals: listRunJournalSnapshots,
    listRecoveryCapsules: listRecoveryCapsuleSnapshots,
    listLinkedDeviceLifecycles:
      listLinkedDeviceLifecycleJournalSnapshots,
  });

function digest(value: string, label: string): string {
  if (!sha256Pattern.test(value)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function isMatchingIdentity(
  identity: PortableOperationIdentityV1,
  bundleSha256: string,
): boolean {
  return identity.bundleSha256 === bundleSha256;
}

function matchingJournalIsUnsettled(
  snapshot: RunJournalSnapshot,
  bundleSha256: string,
): boolean {
  const { journal } = snapshot;
  if (
    journal.contract.transport !== "portable-provider-plugin"
    || !isMatchingIdentity(journal.contract.identity, bundleSha256)
  ) {
    return false;
  }
  return (
    journal.phase !== "terminal"
    || journal.recoveryState === "present"
    || journal.recoveryState === "retained"
    || journal.assetState === "bound"
    || journal.assetState === "retained"
  );
}

/**
 * Inspect every durable execution coordinate that can still require an exact
 * portable bundle. Unknown state blocks all bundle mutations: malformed local
 * evidence must never be interpreted as proof that a plugin is unused.
 */
export function inspectPortableProviderPluginQuiescence(
  bundleSha256Value: string,
  environment: Environment = process.env,
  dependencies: PortableProviderPluginQuiescenceDependencies =
    quiescenceDependencies,
): PortableProviderPluginQuiescenceReport {
  const bundleSha256 = digest(
    bundleSha256Value,
    "portable plugin bundle digest",
  );
  const blockers: PortableProviderPluginLifecycleBlocker[] = [];
  let blockerCount = 0;
  const block = (
    value: PortableProviderPluginLifecycleBlocker,
  ): void => {
    blockerCount += 1;
    if (blockers.length < MAX_REPORTED_BLOCKERS) blockers.push(value);
  };

  const root = wrenchStateHome(environment);
  const directoryShapes = [
    {
      label: "plans",
      path: join(root, "plans"),
      accepts: (entry: PrivateStateDirectoryEntry) =>
        entry.kind === "file"
        && (
          /^[a-f0-9]{64}\.json$/u.test(entry.name)
          || /^[a-f0-9]{64}\.claim\.json$/u.test(entry.name)
        ),
    },
    {
      label: "run receipts",
      path: join(root, "runs"),
      accepts: (entry: PrivateStateDirectoryEntry) =>
        entry.kind === "file"
        && /^[0-9a-f-]{36}\.json$/u.test(entry.name),
    },
    {
      label: "run journals",
      path: join(root, "run-journals"),
      accepts: (entry: PrivateStateDirectoryEntry) =>
        (
          entry.kind === "file"
          && /^[0-9a-f-]{36}\.json$/u.test(entry.name)
        )
        || (
          entry.kind === "directory"
          && (
            entry.name === "linked-device-lifecycle"
            || entry.name === "linked-device-lifecycle-admissions"
          )
        ),
    },
    {
      label: "recovery capsules",
      path: join(root, "recovery", "capsules"),
      accepts: (entry: PrivateStateDirectoryEntry) =>
        entry.kind === "file"
        && /^[0-9a-f-]{36}\.json$/u.test(entry.name),
    },
    {
      label: "portable invocation leases",
      path: join(root, "provider-plugin-state", ".invocations"),
      accepts: (entry: PrivateStateDirectoryEntry) =>
        entry.kind === "file"
        && entry.name.endsWith(".json")
        && uuidV4Pattern.test(entry.name.slice(0, -5)),
    },
    {
      label: "linked-device lifecycle journals",
      path: join(root, "run-journals", "linked-device-lifecycle"),
      accepts: (entry: PrivateStateDirectoryEntry) =>
        entry.kind === "file"
        && entry.name.endsWith(".json")
        && uuidV4Pattern.test(entry.name.slice(0, -5)),
    },
    {
      label: "linked-device lifecycle admissions",
      path: join(
        root,
        "run-journals",
        "linked-device-lifecycle-admissions",
      ),
      accepts: (entry: PrivateStateDirectoryEntry) =>
        entry.kind === "file"
        && entry.name.endsWith(".json")
        && sha256Pattern.test(entry.name.slice(0, -5)),
    },
  ] as const;
  for (const directory of directoryShapes) {
    for (const entry of dependencies.listStateDirectory(
      directory.path,
      environment,
    )) {
      if (directory.accepts(entry)) continue;
      block({
        kind: "unexpected-state-entry",
        coordinate: `${directory.label}/${entry.name}`,
        reason: `unexpected ${entry.kind} state can hide portable plugin ownership`,
      });
    }
  }

  for (const entry of dependencies.listInvocationLeases(environment)) {
    if ("invalid" in entry) {
      block({
        kind: "invalid-invocation-lease",
        coordinate: entry.leaseId,
        reason: "an invocation lease has unknown plugin ownership",
      });
      continue;
    }
    if (
      !isMatchingIdentity(entry.lease.identity, bundleSha256)
      || dependencies.invocationLeaseOwnerStatus(entry)
        === "different-or-dead"
    ) {
      continue;
    }
    block({
      kind: "invocation-lease",
      coordinate: entry.lease.leaseId,
      reason: "the exact bundle has a live or unverifiable invocation owner",
    });
  }

  const matchingPlanDigests = new Set<string>();
  for (const listed of dependencies.listPlans(environment)) {
    if ("invalid" in listed) {
      block({
        kind: "invalid-plan",
        coordinate: listed.digest,
        reason: "an encrypted confirmation plan has unknown ownership",
      });
      continue;
    }
    let stored: StoredPlan;
    try {
      stored = dependencies.loadPlan(listed.digest, environment);
    } catch {
      block({
        kind: "invalid-plan",
        coordinate: listed.digest,
        reason: "a listed confirmation plan changed or could not be authenticated",
      });
      continue;
    }
    if (
      stored.plan.transport === "portable-provider-plugin"
      && isMatchingIdentity(
        stored.plan.portablePluginContract,
        bundleSha256,
      )
    ) {
      matchingPlanDigests.add(stored.digest);
      block({
        kind: "confirmation-plan",
        coordinate: stored.digest,
        reason: "the exact bundle still owns a durable confirmation preview",
      });
    }
  }

  const matchingJournalRunIds = new Set<string>();
  const matchingJournalPlanDigests = new Set<string>();
  const settledMatchingJournalIds = new Set<string>();
  for (const entry of dependencies.listJournals(environment)) {
    if ("invalid" in entry) {
      block({
        kind: "invalid-run-journal",
        coordinate: entry.runId,
        reason: "a run journal has unknown plugin ownership",
      });
      continue;
    }
    const { journal } = entry;
    if (
      journal.contract.transport !== "portable-provider-plugin"
      || !isMatchingIdentity(journal.contract.identity, bundleSha256)
    ) {
      continue;
    }
    matchingJournalRunIds.add(journal.runId);
    matchingJournalPlanDigests.add(journal.planDigest);
    if (matchingJournalIsUnsettled(entry, bundleSha256)) {
      block({
        kind: "run-journal",
        coordinate: journal.runId,
        reason: "the exact bundle owns an active or unreconciled write",
      });
    } else {
      settledMatchingJournalIds.add(journal.runId);
    }
  }

  for (const entry of dependencies.listConfirmationClaims(environment)) {
    if ("invalid" in entry) {
      block({
        kind: "invalid-confirmation-claim",
        coordinate: entry.digest,
        reason: "a confirmation claim has unknown plugin ownership",
      });
      continue;
    }
    const claim: ConfirmationClaimSnapshot["claim"] = entry.claim;
    if (
      !matchingPlanDigests.has(claim.digest)
      && !matchingJournalPlanDigests.has(claim.digest)
      && !matchingJournalRunIds.has(claim.runId)
    ) {
      continue;
    }
    block({
      kind: "confirmation-claim",
      coordinate: claim.digest,
      reason: "the exact bundle still has a confirmation ownership transition",
    });
  }

  for (const receipt of dependencies.listReceipts(environment)) {
    if ("invalid" in receipt) {
      block({
        kind: "invalid-run-receipt",
        coordinate: receipt.runId,
        reason: "a run receipt has unknown plugin ownership",
      });
      continue;
    }
    if (
      receipt.transport !== "portable-provider-plugin"
      || !isMatchingIdentity(
        receipt.portablePluginContract,
        bundleSha256,
      )
      || receipt.planDigest === null
      || (
        receipt.status !== "pending"
        && receipt.status !== "partial"
        && receipt.status !== "indeterminate"
      )
      || settledMatchingJournalIds.has(receipt.runId)
    ) {
      continue;
    }
    block({
      kind: "run-receipt",
      coordinate: receipt.runId,
      reason: "a portable write receipt is not backed by settled journal state",
    });
  }

  for (const entry of dependencies.listRecoveryCapsules(environment)) {
    if ("invalid" in entry) {
      block({
        kind: "invalid-recovery-capsule",
        coordinate: entry.runId,
        reason: "an encrypted recovery capsule has unknown plugin ownership",
      });
      continue;
    }
    if (
      entry.capsule.contract.transport === "portable-provider-plugin"
      && isMatchingIdentity(
        entry.capsule.contract.identity,
        bundleSha256,
      )
    ) {
      block({
        kind: "recovery-capsule",
        coordinate: entry.capsule.runId,
        reason: "the exact bundle still owns encrypted reconciliation input",
      });
    }
  }

  for (const entry of dependencies.listLinkedDeviceLifecycles(environment)) {
    if ("invalid" in entry) {
      block({
        kind: "invalid-linked-device-lifecycle",
        coordinate: entry.journalId,
        reason: "a linked-device lifecycle has unknown plugin ownership",
      });
      continue;
    }
    const { journal } = entry;
    if (
      journal.pluginImplementationHash !== bundleSha256
      || (
        journal.phase === "terminal"
        && journal.status !== "indeterminate"
      )
    ) {
      continue;
    }
    block({
      kind: "linked-device-lifecycle",
      coordinate: journal.journalId,
      reason: "the exact bundle owns an active or unreconciled linked-device lifecycle",
    });
  }

  return Object.freeze({
    bundleSha256,
    quiescent: blockerCount === 0,
    blockerCount,
    blockers: Object.freeze(blockers),
  });
}

export function assertPortableProviderPluginQuiescent(
  bundleSha256: string,
  _artifactPath: string,
  environment: Environment = process.env,
): void {
  const report = inspectPortableProviderPluginQuiescence(
    bundleSha256,
    environment,
  );
  if (report.quiescent) return;
  const examples = report.blockers.slice(0, 4).map((blocker) =>
    `${blocker.kind} ${blocker.coordinate}: ${blocker.reason}`
  ).join("; ");
  const remaining = report.blockerCount - Math.min(
    report.blockerCount,
    4,
  );
  throw new Error(
    `portable plugin bundle ${report.bundleSha256} is not quiescent: ${examples}${
      remaining > 0 ? `; and ${remaining} more blocker(s)` : ""
    }. Cancel previews and reconcile or repair interrupted runs before changing this plugin`,
  );
}

/**
 * Check a candidate against the complete command-scoped provider catalog and
 * the adapter store. This executes no plugin code and runs inside the store's
 * catalog mutation lock.
 */
export function assertPortableProviderPluginActivatable(
  candidate: VerifiedPortableProviderPluginPackage,
  sourceRegistry: ProviderPluginRegistry,
  environment: Environment = process.env,
): void {
  const current = createPortableProviderPluginCatalog(
    sourceRegistry,
    environment,
  ).installed
    .filter((installed) =>
      installed.package.manifest.id !== candidate.manifest.id
    )
    .map((installed) =>
      projectPortableProviderPluginPackage(
        installed.package,
        environment,
      )
    );
  const candidatePlugin = projectPortableProviderPluginPackage(
    candidate,
    environment,
  );
  const candidateRegistry = extendProviderPluginRegistryWithPortablePlugins(
    sourceRegistry,
    [
    ...current,
    candidatePlugin,
    ],
  );
  const ownedAdapterIds = new Set(
    candidateRegistry.listOwnedManifests().map((manifest) => manifest.id),
  );
  for (const { id, snapshot } of
    listInstalledDiagnosticManifestSnapshots(
      environment,
      candidateRegistry,
    )) {
    if (!ownedAdapterIds.has(id)) continue;
    const safety = snapshot.availability === "unsafe"
      ? "unsafe"
      : snapshot.result.ok ? "valid" : "invalid";
    throw new Error(
      `portable provider plugin adapter ${id} collides with ${safety} stored adapter state`,
    );
  }
}
