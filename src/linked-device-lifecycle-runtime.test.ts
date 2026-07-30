import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createAuth,
  linkedDeviceRealmKey,
  loadAuthSnapshot,
  removeAuth,
  replaceAuthIfUnchanged,
  saveAuth,
  type WrenchAuth,
} from "./auth";
import type {
  LinkedDeviceLifecycleAdmissionStore,
} from "./linked-device-lifecycle-admission";
import {
  createLinkedDeviceLifecycleOwner,
  initialLinkedDeviceLifecycleJournal,
  parseLinkedDeviceLifecycleJournal,
  readLinkedDeviceLifecycleJournal,
  transitionLinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournalListEntry,
  type LinkedDeviceLifecycleJournalSnapshot,
  type LinkedDeviceLifecycleRestartDisposition,
} from "./linked-device-lifecycle-journal";
import {
  LinkedDeviceLifecycleIndeterminateError,
  reconcileLinkedDeviceLifecycleJournal,
  recoverLinkedDeviceLifecycleJournals,
  runLinkedDevicePairLifecycle,
  runLinkedDeviceSyncOnceLifecycle,
  type LinkedDeviceLifecycleAuthSnapshot,
  type LinkedDeviceLifecycleAuthStore,
  type LinkedDeviceLifecycleJournalStore,
} from "./linked-device-lifecycle-runtime";
import { canonicalJson } from "./model";
import type { LinkedDevicePluginBindingV1 } from "./provider-plugin";
import { providerPluginRegistry } from "./provider-plugins";

type LinkedDeviceAuth = Extract<
  WrenchAuth,
  { readonly kind: "linked-device-store" }
>;

const NOW = "2026-07-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const SUBJECT = "whatsapp:pn:15551234567";
const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;
let memoryDeviceStore = "";

type PipedChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function killAndReapChild(
  child: PipedChild,
  stdout: Promise<string>,
  stderr: Promise<string>,
): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // The direct test child already exited.
    }
  }
  await Promise.allSettled([child.exited, stdout, stderr]);
}

beforeAll(() => {
  memoryDeviceStore = mkdtempSync(
    join(tmpdir(), "wrench-linked-device-memory-store-"),
  );
  chmodSync(memoryDeviceStore, 0o700);
  memoryDeviceStore = realpathSync(memoryDeviceStore);
});

afterAll(() => {
  if (memoryDeviceStore !== "") {
    rmSync(memoryDeviceStore, { recursive: true, force: true });
  }
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshot(
  journal: LinkedDeviceLifecycleJournal,
): LinkedDeviceLifecycleJournalSnapshot {
  return Object.freeze({
    journal,
    contentSha256: digest(`${canonicalJson(journal)}\n`),
  });
}

function authSnapshot(auth: LinkedDeviceAuth): LinkedDeviceLifecycleAuthSnapshot {
  return Object.freeze({
    auth,
    contentSha256: digest(`${canonicalJson(auth)}\n`),
  });
}

function linkedAuth(subject?: string): LinkedDeviceAuth {
  return Object.freeze({
    schemaVersion: 1,
    id: "whatsapp-main",
    kind: "linked-device-store",
    provider: "whatsapp",
    path: memoryDeviceStore,
    ...(subject === undefined ? {} : { subject }),
  });
}

function fakeAuthStore(initial: LinkedDeviceAuth): {
  readonly store: LinkedDeviceLifecycleAuthStore;
  readonly current: () => LinkedDeviceLifecycleAuthSnapshot;
  readonly replaceExternally: (auth: LinkedDeviceAuth) => void;
} {
  let current = authSnapshot(initial);
  return {
    store: {
      loadSnapshot: (id) => {
        if (current.auth.id !== id) throw new Error("auth not found");
        return current;
      },
      replaceIfUnchanged: (expected, replacement) => {
        if (current.contentSha256 !== expected.contentSha256) {
          return { replaced: false };
        }
        current = authSnapshot(replacement);
        return { replaced: true, snapshot: current };
      },
    },
    current: () => current,
    replaceExternally: (auth) => {
      current = authSnapshot(auth);
    },
  };
}

function memoryJournalStore(
  restartDisposition?: (
    journal: LinkedDeviceLifecycleJournal,
  ) => LinkedDeviceLifecycleRestartDisposition,
): {
  readonly store: LinkedDeviceLifecycleJournalStore;
  readonly entries: () => readonly LinkedDeviceLifecycleJournalSnapshot[];
} {
  const journals = new Map<string, LinkedDeviceLifecycleJournalSnapshot>();
  const replace = (
    value: LinkedDeviceLifecycleJournalSnapshot,
  ): LinkedDeviceLifecycleJournalSnapshot => {
    journals.set(value.journal.journalId, value);
    return value;
  };
  const store: LinkedDeviceLifecycleJournalStore = {
    createOwner: createLinkedDeviceLifecycleOwner,
    create: (journal) => {
      if (journals.has(journal.journalId)) {
        throw new Error("journal already exists");
      }
      return replace(snapshot(journal));
    },
    update: (current, event) => {
      const stored = journals.get(current.journal.journalId);
      if (
        stored === undefined
        || stored.contentSha256 !== current.contentSha256
      ) throw new Error("journal changed concurrently");
      return replace(snapshot(
        transitionLinkedDeviceLifecycleJournal(current.journal, event),
      ));
    },
    list: () =>
      Object.freeze(
        [...journals.values()] satisfies LinkedDeviceLifecycleJournalListEntry[],
      ),
    classifyRestart: restartDisposition
      ?? (() => ({ kind: "live-owner", reason: "fixture owner is live" })),
    repairInterrupted: (current, options) => {
      const stored = journals.get(current.journal.journalId);
      if (
        stored === undefined
        || stored.contentSha256 !== current.contentSha256
      ) throw new Error("journal changed concurrently");
      const journal = current.journal.phase === "prepared"
        ? parseLinkedDeviceLifecycleJournal({
            ...current.journal,
            revision: current.journal.revision + 1,
            phase: "terminal",
            status: "safe-retry",
            owner: options.owner,
            finishedAt: options.at,
            updatedAt: options.at,
            reasonCode: "owner-exited-before-begin",
          })
        : parseLinkedDeviceLifecycleJournal({
            ...current.journal,
            revision: current.journal.revision + 1,
            phase: "terminal",
            status: "indeterminate",
            reconciliation: "required",
            owner: options.owner,
            finishedAt: current.journal.finishedAt ?? options.at,
            updatedAt: options.at,
            reasonCode: "owner-exited-after-begin",
          });
      return replace(snapshot(journal));
    },
  };
  return {
    store,
    entries: () => Object.freeze([...journals.values()]),
  };
}

function whatsappBinding(): LinkedDevicePluginBindingV1 {
  const binding = providerPluginRegistry.requireSessionRoute("whatsapp");
  if (binding.transport !== "linked-device") {
    throw new Error("WhatsApp fixture is not a linked-device binding");
  }
  return binding;
}

function memoryAdmissionStore(
  journalStore: LinkedDeviceLifecycleJournalStore,
): LinkedDeviceLifecycleAdmissionStore {
  return {
    recover: () => ({
      scanned: 0,
      live: 0,
      repaired: 0,
      invalid: 0,
      issues: [],
    }),
    acquire: (realmKey, authId, acquiredAt) => {
      const owner = journalStore.createOwner(
        new Date(Date.parse(acquiredAt) + 30 * 60_000).toISOString(),
      );
      return {
        realmKey,
        authId,
        acquiredAt,
        owner,
        release: () => undefined,
      };
    },
  };
}

function runtimeOptions(
  authStore: LinkedDeviceLifecycleAuthStore,
  journalStore: LinkedDeviceLifecycleJournalStore,
  journalId: string,
) {
  return {
    registry: providerPluginRegistry,
    authStore,
    journalStore,
    admissionStore: memoryAdmissionStore(journalStore),
    environment: {},
    now: () => new Date(NOW),
    createJournalId: () => journalId,
  };
}

function preparedJournal(
  store: LinkedDeviceLifecycleJournalStore,
  journalId: string,
): LinkedDeviceLifecycleJournalSnapshot {
  const owner = store.createOwner("2026-07-25T12:30:00.000Z");
  return store.create(initialLinkedDeviceLifecycleJournal({
    journalId,
    kind: "pair",
    pluginId: "whatsapp-linked-device",
    pluginVersion: "1.0.0",
    pluginImplementationHash: HASH,
    lifecycleContractVersion: 1,
    surfaceId: "whatsapp",
    authId: "whatsapp-main",
    authRealmHash: HASH,
    authContentHash: HASH,
    initialSubjectState: "unbound",
    phoneProvided: false,
    owner,
    startedAt: NOW,
  }), {});
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("linked-device lifecycle runtime", () => {
  test("commits pair auth by exact snapshot CAS after durable external completion", async () => {
    const authState = fakeAuthStore(linkedAuth());
    const journalState = memoryJournalStore();
    const result = await runLinkedDevicePairLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000001",
        ),
        invokePair: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          return SUBJECT;
        },
      },
    );

    expect(result).toEqual({
      journalId: "00000000-0000-4000-8000-000000000001",
      subject: SUBJECT,
    });
    expect(authState.current().auth.subject).toBe(SUBJECT);
    const journal = journalState.entries()[0]?.journal;
    expect(journal).toMatchObject({
      phase: "terminal",
      status: "succeeded",
      reconciliation: "not-required",
      reasonCode: null,
      result: {
        kind: "pair",
        resultingAuthContentHash: authState.current().contentSha256,
      },
    });
  });

  test("commits sync with a fixed journal projection after its boundary", async () => {
    const authState = fakeAuthStore(linkedAuth(SUBJECT));
    const journalState = memoryJournalStore();
    const pluginResult = {
      itemsStored: 17,
      projection: "whatsapp-message-store",
      emitsProtocolAcknowledgements: true,
    } as const;
    const result = await runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000002",
        ),
        invokeSyncOnce: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          return pluginResult;
        },
      },
    );

    expect(result.result).toEqual(pluginResult);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      phase: "terminal",
      status: "succeeded",
      result: {
        kind: "sync",
        itemsStored: 17,
        projection: "linked-device-local-store",
        emitsProtocolAcknowledgements: true,
      },
    });
  });

  test("revalidates the original auth snapshot before committing sync", async () => {
    const initial = linkedAuth(SUBJECT);
    const authState = fakeAuthStore(initial);
    const journalState = memoryJournalStore();
    const concurrentWinner = Object.freeze({
      ...initial,
      subject: "whatsapp:pn:15550000000",
    });
    const error = await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000009",
        ),
        invokeSyncOnce: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          authState.replaceExternally(concurrentWinner);
          return {
            itemsStored: 1,
            projection: "fixture",
            emitsProtocolAcknowledgements: true,
          };
        },
      },
    ));

    expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
    expect(authState.current().auth).toEqual(concurrentWinner);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
      result: {
        kind: "sync",
        itemsStored: 1,
      },
    });
    authState.replaceExternally(initial);
    const beforeReconciliation = journalState.entries()[0];
    const reconciliationError = await rejectionOf(
      reconcileLinkedDeviceLifecycleJournal(
        "00000000-0000-4000-8000-000000000009",
        {
          outcome: "not-applied",
          evidenceHash: "3".repeat(64),
        },
        runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000009",
        ),
      ),
    );
    expect(reconciliationError).toBeInstanceOf(Error);
    expect(
      reconciliationError instanceof Error
        ? reconciliationError.message
        : "",
    ).toContain("contradicts durable linked-device external completion");
    expect(journalState.entries()[0]).toEqual(beforeReconciliation);
  });

  test("never authorizes retry after the plugin returned but result persistence failed", async () => {
    const authState = fakeAuthStore(linkedAuth(SUBJECT));
    const journalState = memoryJournalStore();
    let injected = false;
    const failingStore: LinkedDeviceLifecycleJournalStore = {
      ...journalState.store,
      update: (current, event, options) => {
        if (!injected && event.type === "external-complete") {
          injected = true;
          throw new Error("injected external-complete persistence failure");
        }
        return journalState.store.update(current, event, options);
      },
    };
    const journalId = "00000000-0000-4000-8000-000000000018";
    const options = runtimeOptions(
      authState.store,
      failingStore,
      journalId,
    );
    const error = await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...options,
        invokeSyncOnce: async (_binding, _auth, invocationOptions) => {
          await invocationOptions.attempt.beforeExternalBegin();
          return {
            itemsStored: 7,
            projection: "fixture",
            emitsProtocolAcknowledgements: true,
          };
        },
      },
    ));
    expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      phase: "terminal",
      status: "indeterminate",
      result: null,
      reasonCode: "external-returned-before-completion-persisted",
    });

    const retryError = await rejectionOf(
      reconcileLinkedDeviceLifecycleJournal(
        journalId,
        {
          outcome: "not-applied",
          evidenceHash: "6".repeat(64),
        },
        options,
      ),
    );
    expect(retryError).toBeInstanceOf(Error);
    expect(
      retryError instanceof Error ? retryError.message : "",
    ).toContain("contradicts durable linked-device external completion");

    expect(await reconcileLinkedDeviceLifecycleJournal(
      journalId,
      {
        outcome: "applied",
        evidenceHash: "7".repeat(64),
        result: {
          kind: "sync",
          itemsStored: 7,
          projection: "linked-device-local-store",
          emitsProtocolAcknowledgements: true,
        },
      },
      options,
    )).toMatchObject({
      outcome: "applied",
      status: "succeeded",
    });
  });

  test("never authorizes retry when a returned call could not persist its external begin", async () => {
    const authState = fakeAuthStore(linkedAuth(SUBJECT));
    const journalState = memoryJournalStore();
    let injected = false;
    const failingStore: LinkedDeviceLifecycleJournalStore = {
      ...journalState.store,
      update: (current, event, options) => {
        if (!injected && event.type === "external-begin") {
          injected = true;
          throw new Error("injected external-begin persistence failure");
        }
        return journalState.store.update(current, event, options);
      },
    };
    const journalId = "00000000-0000-4000-8000-000000000022";
    const options = runtimeOptions(
      authState.store,
      failingStore,
      journalId,
    );
    let invocations = 0;
    const invokeSyncOnce = () => {
      invocations += 1;
      return Promise.resolve({
        itemsStored: 3,
        projection: "fixture" as const,
        emitsProtocolAcknowledgements: true as const,
      });
    };
    const error = await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...options,
        invokeSyncOnce,
      },
    ));
    expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      revision: 1,
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
      externalStartedAt: NOW,
      externalCompletedAt: null,
      result: null,
      reasonCode: "external-returned-before-completion-persisted",
    });

    const reconciliationError = await rejectionOf(
      reconcileLinkedDeviceLifecycleJournal(
        journalId,
        {
          outcome: "not-applied",
          evidenceHash: "8".repeat(64),
        },
        options,
      ),
    );
    expect(reconciliationError).toBeInstanceOf(Error);
    expect(
      reconciliationError instanceof Error
        ? reconciliationError.message
        : "",
    ).toContain("contradicts durable linked-device external completion");

    const retryError = await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...options,
        invokeSyncOnce,
      },
    ));
    expect(retryError).toBeInstanceOf(Error);
    expect(retryError instanceof Error ? retryError.message : "")
      .toContain("unresolved linked-device lifecycle");
    expect(invocations).toBe(1);
    expect(journalState.entries()).toHaveLength(1);
  });

  test("blocks a reused auth ID even when its replacement has a new realm", async () => {
    const authState = fakeAuthStore(linkedAuth(SUBJECT));
    const journalState = memoryJournalStore();
    let oldRealm = preparedJournal(
      journalState.store,
      "00000000-0000-4000-8000-000000000019",
    );
    oldRealm = journalState.store.update(oldRealm, {
      type: "external-begin",
      at: "2026-07-25T12:00:01.000Z",
    }, { owner: oldRealm.journal.owner, environment: {} });
    journalState.store.update(oldRealm, {
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      at: "2026-07-25T12:00:02.000Z",
    }, { owner: oldRealm.journal.owner, environment: {} });

    let invocations = 0;
    const error = await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000020",
        ),
        invokeSyncOnce: () => {
          invocations += 1;
          return Promise.resolve({
            itemsStored: 0,
            projection: "fixture",
            emitsProtocolAcknowledgements: true,
          });
        },
      },
    ));
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "")
      .toContain("unresolved linked-device lifecycle");
    expect(invocations).toBe(0);
    expect(journalState.entries()).toHaveLength(1);
  });

  test("marks sync indeterminate when its canonical store directory is replaced after dispatch", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-store-replacement-test-"),
    );
    chmodSync(directory, 0o700);
    const environment = { WRENCH_STATE_HOME: join(directory, "state") };
    const store = join(realpathSync(directory), "store");
    const journalId = "00000000-0000-4000-8000-000000000012";
    mkdirSync(store, { mode: 0o700 });
    try {
      saveAuth(createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: store,
        subject: SUBJECT,
      }), environment);
      const error = await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
        whatsappBinding(),
        "whatsapp-main",
        {
          registry: providerPluginRegistry,
          environment,
          createJournalId: () => journalId,
          invokeSyncOnce: async (_binding, auth, options) => {
            expect(auth.path).toBe(store);
            await options.attempt.beforeExternalBegin();
            renameSync(store, `${store}.replaced`);
            mkdirSync(store, { mode: 0o700 });
            return {
              itemsStored: 5,
              projection: "fixture",
              emitsProtocolAcknowledgements: true,
            };
          },
        },
      ));

      expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
      expect(
        readLinkedDeviceLifecycleJournal(journalId, environment)?.journal,
      ).toMatchObject({
        phase: "terminal",
        status: "indeterminate",
        reconciliation: "required",
        result: {
          kind: "sync",
          itemsStored: 5,
        },
      });
      expect(() => removeAuth("whatsapp-main", environment))
        .toThrow("active or unreconciled linked-device lifecycle");
      expect(() => saveAuth(createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: store,
        subject: "whatsapp:pn:15550000000",
      }), environment, { force: true }))
        .toThrow("active or unreconciled linked-device lifecycle");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds a newly created pair store at the external boundary", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-new-store-binding-test-"),
    );
    chmodSync(directory, 0o700);
    const root = realpathSync(directory);
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const store = join(root, "new-device-store");
    const journalId = "00000000-0000-4000-8000-000000000021";
    try {
      saveAuth(createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: store,
      }), environment);
      const error = await rejectionOf(runLinkedDevicePairLifecycle(
        whatsappBinding(),
        "whatsapp-main",
        {
          registry: providerPluginRegistry,
          environment,
          createJournalId: () => journalId,
          invokePair: async (_binding, auth, options) => {
            expect(auth.path).toBe(store);
            mkdirSync(store, { mode: 0o700 });
            await options.attempt.beforeExternalBegin();
            renameSync(store, `${store}.replaced`);
            mkdirSync(store, { mode: 0o700 });
            return SUBJECT;
          },
        },
      ));

      expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
      expect(loadAuthSnapshot("whatsapp-main", environment).auth.subject)
        .toBeUndefined();
      expect(
        readLinkedDeviceLifecycleJournal(journalId, environment)?.journal,
      ).toMatchObject({
        phase: "terminal",
        status: "indeterminate",
        reconciliation: "required",
        result: {
          kind: "pair",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a missing legacy store whose alias retargets before the pair boundary", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-legacy-retarget-test-"),
    );
    chmodSync(directory, 0o700);
    const root = realpathSync(directory);
    const original = join(root, "original");
    const alternate = join(root, "alternate");
    const alias = join(root, "alias");
    mkdirSync(original, { mode: 0o700 });
    mkdirSync(alternate, { mode: 0o700 });
    symlinkSync(original, alias);
    const legacyAuth = Object.freeze({
      schemaVersion: 1 as const,
      id: "whatsapp-main",
      kind: "linked-device-store" as const,
      provider: "whatsapp" as const,
      path: join(alias, "new-device-store"),
    });
    const admittedRealm = linkedDeviceRealmKey(legacyAuth);
    const authState = fakeAuthStore(legacyAuth);
    const journalState = memoryJournalStore();
    let externalDispatchReached = false;
    try {
      const error = await rejectionOf(runLinkedDevicePairLifecycle(
        whatsappBinding(),
        "whatsapp-main",
        {
          ...runtimeOptions(
            authState.store,
            journalState.store,
            "00000000-0000-4000-8000-000000000022",
          ),
          invokePair: async (_binding, auth, options) => {
            expect(auth).toEqual(legacyAuth);
            unlinkSync(alias);
            symlinkSync(alternate, alias);
            mkdirSync(auth.path, { mode: 0o700 });
            expect(linkedDeviceRealmKey(auth)).not.toBe(admittedRealm);
            await options.attempt.beforeExternalBegin();
            externalDispatchReached = true;
            return SUBJECT;
          },
        },
      ));

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
      expect(String(error)).toContain(
        "linked-device auth physical realm changed before external dispatch",
      );
      expect(externalDispatchReached).toBeFalse();
      expect(authState.current().auth.subject).toBeUndefined();
      expect(journalState.entries()[0]?.journal).toMatchObject({
        phase: "terminal",
        status: "safe-retry",
        reasonCode: "preflight-failed",
        externalStartedAt: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("removes a symlink alias from the durable realm before external execution", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-alias-retarget-test-"),
    );
    chmodSync(directory, 0o700);
    const root = realpathSync(directory);
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const original = join(root, "original");
    const alternate = join(root, "alternate");
    const alias = join(root, "alias");
    mkdirSync(original, { mode: 0o700 });
    mkdirSync(alternate, { mode: 0o700 });
    symlinkSync(original, alias);
    try {
      const auth = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: alias,
        subject: SUBJECT,
      });
      if (auth.kind !== "linked-device-store") {
        throw new Error("linked-device alias fixture is malformed");
      }
      expect(auth.path).toBe(original);
      saveAuth(auth, environment);

      const result = await runLinkedDeviceSyncOnceLifecycle(
        whatsappBinding(),
        "whatsapp-main",
        {
          registry: providerPluginRegistry,
          environment,
          createJournalId: () =>
            "00000000-0000-4000-8000-000000000015",
          invokeSyncOnce: async (_binding, admittedAuth, options) => {
            await options.attempt.beforeExternalBegin();
            unlinkSync(alias);
            symlinkSync(alternate, alias);
            expect(admittedAuth.path).toBe(original);
            unlinkSync(alias);
            symlinkSync(original, alias);
            return {
              itemsStored: 1,
              projection: "fixture",
              emitsProtocolAcknowledgements: true,
            };
          },
        },
      );
      expect(result.result.itemsStored).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies a plugin preflight failure as safe to retry", async () => {
    const authState = fakeAuthStore(linkedAuth());
    const journalState = memoryJournalStore();
    const error = await rejectionOf(runLinkedDevicePairLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000003",
        ),
        invokePair: () => Promise.reject(new Error("fixture preflight failed")),
      },
    ));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      phase: "terminal",
      status: "safe-retry",
      reasonCode: "preflight-failed",
      externalStartedAt: null,
    });
  });

  test("classifies a failure after the durable boundary as indeterminate", async () => {
    const authState = fakeAuthStore(linkedAuth(SUBJECT));
    const journalState = memoryJournalStore();
    const error = await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000004",
        ),
        invokeSyncOnce: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          throw new Error("fixture runtime failed");
        },
      },
    ));

    expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
      reasonCode: "runtime-error-after-begin",
    });
  });

  test("explicitly discharges an indeterminate lifecycle without retrying it", async () => {
    const authState = fakeAuthStore(linkedAuth(SUBJECT));
    const journalState = memoryJournalStore();
    const journalId = "00000000-0000-4000-8000-000000000010";
    let invocations = 0;
    await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(authState.store, journalState.store, journalId),
        invokeSyncOnce: async (_binding, _auth, options) => {
          invocations += 1;
          await options.attempt.beforeExternalBegin();
          throw new Error("fixture indeterminate result");
        },
      },
    ));

    const reconciled = await reconcileLinkedDeviceLifecycleJournal(
      journalId,
      {
        outcome: "not-applied",
        evidenceHash: "d".repeat(64),
      },
      runtimeOptions(authState.store, journalState.store, journalId),
    );
    expect(reconciled).toEqual({
      ok: true,
      kind: "linked-device-lifecycle-reconciliation",
      journalId,
      authId: "whatsapp-main",
      outcome: "not-applied",
      status: "safe-retry",
      reconciliation: "resolved-not-applied",
      evidenceHash: "d".repeat(64),
    });
    expect(invocations).toBe(1);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      status: "safe-retry",
      reconciliation: "resolved-not-applied",
      reconciliationHash: "d".repeat(64),
    });
  });

  test("requires exact pair and sync results on resolved reconciliation replay", async () => {
    const syncAuth = fakeAuthStore(linkedAuth(SUBJECT));
    const syncJournals = memoryJournalStore();
    const syncJournalId = "00000000-0000-4000-8000-000000000013";
    const syncOptions = runtimeOptions(
      syncAuth.store,
      syncJournals.store,
      syncJournalId,
    );
    await rejectionOf(runLinkedDeviceSyncOnceLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...syncOptions,
        invokeSyncOnce: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          throw new Error("fixture response was lost");
        },
      },
    ));
    const syncInput = {
      outcome: "applied" as const,
      evidenceHash: "1".repeat(64),
      result: {
        kind: "sync" as const,
        itemsStored: 7,
        projection: "linked-device-local-store" as const,
        emitsProtocolAcknowledgements: true as const,
      },
    };
    const syncResolved = await reconcileLinkedDeviceLifecycleJournal(
      syncJournalId,
      syncInput,
      syncOptions,
    );
    expect(await reconcileLinkedDeviceLifecycleJournal(
      syncJournalId,
      syncInput,
      syncOptions,
    )).toEqual(syncResolved);
    const contradictorySync = await rejectionOf(
      reconcileLinkedDeviceLifecycleJournal(
      syncJournalId,
      {
        ...syncInput,
        result: { ...syncInput.result, itemsStored: 999 },
      },
      syncOptions,
      ),
    );
    expect(contradictorySync).toBeInstanceOf(Error);
    expect(
      contradictorySync instanceof Error ? contradictorySync.message : "",
    ).toContain("different reconciliation result");

    const pairAuth = fakeAuthStore(linkedAuth());
    const pairJournals = memoryJournalStore();
    const pairJournalId = "00000000-0000-4000-8000-000000000014";
    const pairOptions = runtimeOptions(
      pairAuth.store,
      pairJournals.store,
      pairJournalId,
    );
    await rejectionOf(runLinkedDevicePairLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...pairOptions,
        invokePair: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          throw new Error("fixture response was lost");
        },
      },
    ));
    const pairInput = {
      outcome: "applied" as const,
      evidenceHash: "2".repeat(64),
      result: {
        kind: "pair" as const,
        subject: SUBJECT,
      },
    };
    const pairResolved = await reconcileLinkedDeviceLifecycleJournal(
      pairJournalId,
      pairInput,
      pairOptions,
    );
    expect(await reconcileLinkedDeviceLifecycleJournal(
      pairJournalId,
      pairInput,
      pairOptions,
    )).toEqual(pairResolved);
    const contradictoryPair = await rejectionOf(
      reconcileLinkedDeviceLifecycleJournal(
      pairJournalId,
      {
        ...pairInput,
        result: {
          kind: "pair",
          subject: "whatsapp:pn:15550000000",
        },
      },
      pairOptions,
      ),
    );
    expect(contradictoryPair).toBeInstanceOf(Error);
    expect(
      contradictoryPair instanceof Error ? contradictoryPair.message : "",
    ).toContain("did not match");
  });

  test("fails conservatively when a plugin returns without awaiting its boundary", async () => {
    const authState = fakeAuthStore(linkedAuth());
    const journalState = memoryJournalStore();
    const error = await rejectionOf(runLinkedDevicePairLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000008",
        ),
        invokePair: () => Promise.resolve(SUBJECT),
      },
    ));

    expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
    expect(authState.current().auth.subject).toBeUndefined();
    expect(journalState.entries()[0]?.journal).toMatchObject({
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
      reasonCode: "external-returned-before-completion-persisted",
    });
  });

  test("repairs dead prepared work locally and marks begun work for reconciliation", () => {
    const journalState = memoryJournalStore((journal) =>
      journal.phase === "prepared"
        ? { kind: "safe-retry", reason: "fixture owner exited" }
        : {
            kind: "reconciliation-required",
            reason: "fixture owner exited after begin",
          });
    preparedJournal(
      journalState.store,
      "00000000-0000-4000-8000-000000000005",
    );
    const begun = preparedJournal(
      journalState.store,
      "00000000-0000-4000-8000-000000000006",
    );
    journalState.store.update(
      begun,
      { type: "external-begin", at: NOW },
      { owner: begun.journal.owner, environment: {} },
    );

    const report = recoverLinkedDeviceLifecycleJournals({
      environment: {},
      journalStore: journalState.store,
      now: () => new Date(NOW),
    });

    expect(report).toEqual({
      scanned: 2,
      complete: 0,
      live: 0,
      repairedSafeRetry: 1,
      repairedIndeterminate: 1,
      invalid: 0,
      blockedAuthIds: ["whatsapp-main"],
      blockedRealmKeys: [HASH],
      issues: [{
        journalId: "00000000-0000-4000-8000-000000000006",
        authId: "whatsapp-main",
        kind: "reconciliation-required",
      }],
    });
    expect(journalState.entries().map((entry) => entry.journal.status).sort())
      .toEqual(["indeterminate", "safe-retry"]);
  });

  test("turns a lost auth CAS after pairing into reconciliation-required state", async () => {
    const authState = fakeAuthStore(linkedAuth());
    const journalState = memoryJournalStore();
    const concurrentWinner = linkedAuth("whatsapp:pn:15550000000");
    const error = await rejectionOf(runLinkedDevicePairLifecycle(
      whatsappBinding(),
      "whatsapp-main",
      {
        ...runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000007",
        ),
        invokePair: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          authState.replaceExternally(concurrentWinner);
          return SUBJECT;
        },
      },
    ));

    expect(error).toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
    expect(authState.current().auth).toEqual(concurrentWinner);
    expect(journalState.entries()[0]?.journal).toMatchObject({
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
      reasonCode: "external-returned-before-completion-persisted",
      result: {
        kind: "pair",
      },
    });
    authState.replaceExternally(linkedAuth());
    const beforeReconciliation = journalState.entries()[0];
    const reconciliationError = await rejectionOf(
      reconcileLinkedDeviceLifecycleJournal(
        "00000000-0000-4000-8000-000000000007",
        {
          outcome: "not-applied",
          evidenceHash: "4".repeat(64),
        },
        runtimeOptions(
          authState.store,
          journalState.store,
          "00000000-0000-4000-8000-000000000007",
        ),
      ),
    );
    expect(reconciliationError).toBeInstanceOf(Error);
    expect(
      reconciliationError instanceof Error
        ? reconciliationError.message
        : "",
    ).toContain("contradicts durable linked-device external completion");
    expect(journalState.entries()[0]).toEqual(beforeReconciliation);
  });

  test("serializes auth aliases by physical provider store and blocks aliases after an indeterminate outcome", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-alias-test-"),
    );
    chmodSync(directory, 0o700);
    const environment = { WRENCH_STATE_HOME: directory };
    const firstAuth = linkedAuth(SUBJECT);
    const aliasAuth = Object.freeze({
      ...firstAuth,
      id: "whatsapp-alias",
    });
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    try {
      expect(linkedDeviceRealmKey(firstAuth))
        .toBe(linkedDeviceRealmKey(aliasAuth));
      saveAuth(firstAuth, environment);
      saveAuth(aliasAuth, environment);
      const first = runLinkedDeviceSyncOnceLifecycle(
        whatsappBinding(),
        firstAuth.id,
        {
          registry: providerPluginRegistry,
          environment,
          invokeSyncOnce: async (_binding, _auth, options) => {
            await options.attempt.beforeExternalBegin();
            markStarted?.();
            await gate;
            return {
              itemsStored: 1,
              projection: "fixture",
              emitsProtocolAcknowledgements: true,
            };
          },
        },
      );
      await started;
      let aliasInvocations = 0;
      const overlap = await rejectionOf(
        runLinkedDeviceSyncOnceLifecycle(
          whatsappBinding(),
          aliasAuth.id,
          {
            registry: providerPluginRegistry,
            environment,
            invokeSyncOnce: () => {
              aliasInvocations += 1;
              return Promise.resolve({
                itemsStored: 1,
                projection: "fixture",
                emitsProtocolAcknowledgements: true,
              });
            },
          },
        ),
      );
      expect(overlap).toBeInstanceOf(Error);
      expect(overlap instanceof Error ? overlap.message : "")
        .toContain("active linked-device lifecycle");
      expect(aliasInvocations).toBe(0);
      releaseFirst?.();
      await first;

      const indeterminate = await rejectionOf(
        runLinkedDeviceSyncOnceLifecycle(
          whatsappBinding(),
          firstAuth.id,
          {
            registry: providerPluginRegistry,
            environment,
            invokeSyncOnce: async (_binding, _auth, options) => {
              await options.attempt.beforeExternalBegin();
              throw new Error("fixture post-boundary failure");
            },
          },
        ),
      );
      expect(indeterminate)
        .toBeInstanceOf(LinkedDeviceLifecycleIndeterminateError);
      const blockedAlias = await rejectionOf(
        runLinkedDeviceSyncOnceLifecycle(
          whatsappBinding(),
          aliasAuth.id,
          {
            registry: providerPluginRegistry,
            environment,
            invokeSyncOnce: () => {
              aliasInvocations += 1;
              return Promise.resolve({
                itemsStored: 1,
                projection: "fixture",
                emitsProtocolAcknowledgements: true,
              });
            },
          },
        ),
      );
      expect(blockedAlias instanceof Error ? blockedAlias.message : "")
        .toContain("unresolved linked-device lifecycle");
      expect(aliasInvocations).toBe(0);
    } finally {
      releaseFirst?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("admits only one external lifecycle per auth across overlapping callers", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-admission-test-"),
    );
    chmodSync(directory, 0o700);
    const environment = { WRENCH_STATE_HOME: directory };
    let markCrossed: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const crossed = new Promise<void>((resolve) => {
      markCrossed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    try {
      saveAuth(linkedAuth(), environment);
      const first = runLinkedDevicePairLifecycle(
        whatsappBinding(),
        "whatsapp-main",
        {
          registry: providerPluginRegistry,
          environment,
          invokePair: async (_binding, _auth, options) => {
            await options.attempt.beforeExternalBegin();
            markCrossed?.();
            await gate;
            return SUBJECT;
          },
        },
      );
      await crossed;

      expect(() => removeAuth("whatsapp-main", environment))
        .toThrow("active linked-device lifecycle");
      const concurrentSnapshot = loadAuthSnapshot(
        "whatsapp-main",
        environment,
      );
      expect(() => replaceAuthIfUnchanged(
        concurrentSnapshot,
        {
          ...linkedAuth(),
          subject: SUBJECT,
        },
        environment,
      )).toThrow("active linked-device lifecycle");
      expect(() => saveAuth(
        {
          ...linkedAuth(),
          path: "/private/wrench-test-whatsapp-replacement-store",
        },
        environment,
        { force: true },
      )).toThrow("active linked-device lifecycle");

      let secondInvocations = 0;
      const secondError = await rejectionOf(runLinkedDevicePairLifecycle(
        whatsappBinding(),
        "whatsapp-main",
        {
          registry: providerPluginRegistry,
          environment,
          invokePair: () => {
            secondInvocations += 1;
            return Promise.resolve(SUBJECT);
          },
        },
      ));
      expect(secondError).toBeInstanceOf(Error);
      expect(
        secondError instanceof Error ? secondError.message : "",
      ).toContain("active linked-device lifecycle");
      expect(secondInvocations).toBe(0);

      releaseFirst?.();
      await first;
    } finally {
      releaseFirst?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a new process discharges a SIGKILL-interrupted post-boundary journal without retrying", async () => {
    const outer = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-process-reconcile-test-"),
    );
    chmodSync(outer, 0o700);
    const state = join(outer, "state");
    const deviceStore = join(outer, "device-store");
    const ready = join(outer, "ready");
    const journalId = "00000000-0000-4000-8000-000000000011";
    const authModule = pathToFileURL(join(import.meta.dir, "auth.ts")).href;
    const runtimeModule = pathToFileURL(
      join(import.meta.dir, "linked-device-lifecycle-runtime.ts"),
    ).href;
    const pluginsModule = pathToFileURL(
      join(import.meta.dir, "provider-plugins.ts"),
    ).href;
    const wrenchModule = pathToFileURL(join(import.meta.dir, "wrench.ts")).href;
    const repositoryRoot = process.cwd();
    const childScript = `
      import { mkdirSync, writeFileSync } from "node:fs";
      const { createAuth, saveAuth } = await import(${JSON.stringify(authModule)});
      const { runLinkedDeviceSyncOnceLifecycle } =
        await import(${JSON.stringify(runtimeModule)});
      const { providerPluginRegistry } =
        await import(${JSON.stringify(pluginsModule)});
      const environment = { WRENCH_STATE_HOME: ${JSON.stringify(state)} };
      mkdirSync(${JSON.stringify(deviceStore)}, {
        recursive: true,
        mode: 0o700,
      });
      const auth = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: ${JSON.stringify(deviceStore)},
        subject: ${JSON.stringify(SUBJECT)},
      });
      saveAuth(auth, environment);
      const binding = providerPluginRegistry.requireSessionRoute("whatsapp");
      if (binding.transport !== "linked-device") throw new Error("bad binding");
      await runLinkedDeviceSyncOnceLifecycle(binding, auth.id, {
        registry: providerPluginRegistry,
        environment,
        createJournalId: () => ${JSON.stringify(journalId)},
        invokeSyncOnce: async (_binding, _auth, options) => {
          await options.attempt.beforeExternalBegin();
          writeFileSync(${JSON.stringify(ready)}, "ready\\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
          throw new Error("test process was not killed");
        },
      });
    `;
    let interrupted: PipedChild | null = null;
    let interruptedStdout: Promise<string> | null = null;
    let interruptedStderr: Promise<string> | null = null;
    let interruptedReaped = false;
    let reconciler: PipedChild | null = null;
    let reconcilerStdout: Promise<string> | null = null;
    let reconcilerStderr: Promise<string> | null = null;
    let reconcilerReaped = false;
    try {
      const spawnedInterrupted = Bun.spawn(
        [process.execPath, "--no-env-file", "--eval", childScript],
        {
          cwd: repositoryRoot,
          env: { NODE_ENV: "test" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      interrupted = spawnedInterrupted;
      interruptedStdout = new Response(spawnedInterrupted.stdout).text();
      interruptedStderr = new Response(spawnedInterrupted.stderr).text();
      const readyDeadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
      while (!existsSync(ready) && performance.now() < readyDeadline) {
        await Bun.sleep(10);
      }
      if (!existsSync(ready)) {
        interrupted.kill("SIGKILL");
        const [, , childErrors] = await Promise.all([
          interrupted.exited,
          interruptedStdout,
          interruptedStderr,
        ]);
        interruptedReaped = true;
        throw new Error(
          `interrupted lifecycle child did not reach its boundary: ${childErrors}`,
        );
      }
      expect(existsSync(ready)).toBeTrue();
      interrupted.kill("SIGKILL");
      await Promise.all([
        interrupted.exited,
        interruptedStdout,
        interruptedStderr,
      ]);
      interruptedReaped = true;

      const input = JSON.stringify({
        outcome: "not-applied",
        evidenceHash: "e".repeat(64),
      });
      const reconcileScript = `
        const { main } = await import(${JSON.stringify(wrenchModule)});
        process.exitCode = await main(
          ["runs", "reconcile", ${JSON.stringify(journalId)}, "--input",
            ${JSON.stringify(input)}, "--json"],
          { WRENCH_STATE_HOME: ${JSON.stringify(state)} },
        );
      `;
      const spawnedReconciler = Bun.spawn(
        [process.execPath, "--no-env-file", "--eval", reconcileScript],
        {
          cwd: repositoryRoot,
          env: { NODE_ENV: "test" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      reconciler = spawnedReconciler;
      reconcilerStdout = new Response(spawnedReconciler.stdout).text();
      reconcilerStderr = new Response(spawnedReconciler.stderr).text();
      const [exitCode, stdout, stderr] = await Promise.all([
        reconciler.exited,
        reconcilerStdout,
        reconcilerStderr,
      ]);
      reconcilerReaped = true;
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        kind: "linked-device-lifecycle-reconciliation",
        journalId,
        outcome: "not-applied",
        status: "safe-retry",
      });
      expect(
        readLinkedDeviceLifecycleJournal(journalId, { WRENCH_STATE_HOME: state })
          ?.journal,
      ).toMatchObject({
        phase: "terminal",
        status: "safe-retry",
        reconciliation: "resolved-not-applied",
        reasonCode: "reconciled-not-applied",
      });
    } finally {
      try {
        try {
          if (
            !reconcilerReaped
            && reconciler !== null
            && reconcilerStdout !== null
            && reconcilerStderr !== null
          ) {
            await killAndReapChild(
              reconciler,
              reconcilerStdout,
              reconcilerStderr,
            );
          }
        } finally {
          if (
            !interruptedReaped
            && interrupted !== null
            && interruptedStdout !== null
            && interruptedStderr !== null
          ) {
            await killAndReapChild(
              interrupted,
              interruptedStdout,
              interruptedStderr,
            );
          }
        }
      } finally {
        rmSync(outer, { recursive: true, force: true });
      }
    }
  });
});
