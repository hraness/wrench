import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256, type OperationInput } from "./model";
import {
  appendReconciliationObservation,
  listRecoveryCapsuleSnapshots,
  listReconciliationObservations,
  readRecoveryCapsule,
  recoveryContractHash,
  removeRecoveryCapsule,
  writeRecoveryCapsule,
  type ReconciliationObservation,
  type RecoveryCapsule,
  type RecoveryContractIdentity,
} from "./recovery";
import type { PortableOperationIdentityV1 } from "./provider-plugin-portable-identity";

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ID = "20000000-0000-4000-8000-000000000002";
const AUTH_HASH = "a".repeat(64);
const CONTRACT_HASH = "b".repeat(64);
const ADAPTER_HASH = "c".repeat(64);
const PLAN_DIGEST = "d".repeat(64);
const PORTABLE_IDENTITY: PortableOperationIdentityV1 = Object.freeze({
  pluginId: "portable-social",
  pluginVersion: "2.3.4",
  hostApiVersion: 1,
  bundleSha256: "1".repeat(64),
  manifestSha256: "2".repeat(64),
  adapterId: "portable-social-web",
  transport: "web-session-api",
  surfaceId: "portable-social",
  operation: "content.save",
  contractVersion: 9,
  descriptorSha256: "3".repeat(64),
});

function state(): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-recovery-test-"));
  chmodSync(directory, 0o700);
  return { directory, environment: { WRENCH_STATE_HOME: directory } };
}

function capsule(
  input: OperationInput = {
    post_id: "2078889282404569267",
    saved: true,
    private_note: "private-recovery-value-☃",
  },
): RecoveryCapsule {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    createdAt: "2026-07-23T12:00:00.000Z",
    planDigest: PLAN_DIGEST,
    adapter: { id: "x-web", version: "1.0.0", hash: ADAPTER_HASH },
    operation: "content.save",
    risk: "R2",
    input,
    inputHash: sha256(canonicalJson(input)),
    auth: { id: "x-main", hash: AUTH_HASH, kind: "cookie-source" },
    contract: {
      transport: "web-session-api",
      site: "x",
      action: "content.save",
      version: 1,
      hash: CONTRACT_HASH,
    },
  };
}

function portableContract(
  identity: PortableOperationIdentityV1 = PORTABLE_IDENTITY,
): RecoveryContractIdentity {
  return Object.freeze({
    transport: "portable-provider-plugin",
    identity,
  });
}

function portableCapsule(
  identity: PortableOperationIdentityV1 = PORTABLE_IDENTITY,
): RecoveryCapsule {
  return {
    ...capsule(),
    contract: portableContract(identity),
  };
}

function observation(
  observationId: string,
  observedAt: string,
  outcome: ReconciliationObservation["outcome"] = "desired-state-observed",
): ReconciliationObservation {
  const inconclusive = outcome === "inconclusive";
  const matched = outcome === "desired-state-observed";
  return {
    schemaVersion: 1,
    observationId,
    runId: RUN_ID,
    observedAt,
    receiptHash: "e".repeat(64),
    adapterHash: ADAPTER_HASH,
    operation: "content.save",
    inputHash: capsule().inputHash,
    authHash: AUTH_HASH,
    contractHash: CONTRACT_HASH,
    inputSource: "capsule",
    outcome,
    desiredStateMatched: inconclusive ? null : matched,
    actualState: inconclusive ? null : matched,
    reason: inconclusive ? "readback-failed" : "exact-readback",
  };
}

describe("encrypted recovery capsules", () => {
  test("lists exact decrypted identities and preserves invalid ownership", () => {
    const testState = state();
    try {
      const value = portableCapsule();
      writeRecoveryCapsule(value, testState.environment);
      expect(listRecoveryCapsuleSnapshots(testState.environment)).toEqual([{
        capsule: value,
      }]);

      writeFileSync(
        join(
          testState.directory,
          "recovery",
          "capsules",
          `${RUN_ID}.json`,
        ),
        "{\"schemaVersion\":1}\n",
        { mode: 0o600 },
      );
      expect(listRecoveryCapsuleSnapshots(testState.environment)).toEqual([{
        runId: RUN_ID,
        invalid: true,
      }]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("encrypts exact input, binds coordinates, and accepts only an identical duplicate", () => {
    const testState = state();
    try {
      const value = capsule();
      writeRecoveryCapsule(value, testState.environment);
      const path = join(testState.directory, "recovery", "capsules", `${RUN_ID}.json`);
      const raw = readFileSync(path, "utf8");

      expect(raw).toContain('"encryption":"aes-256-gcm"');
      expect(raw).not.toContain("private-recovery-value");
      expect(raw).not.toContain("2078889282404569267");
      expect(readRecoveryCapsule(
        RUN_ID,
        value.auth.id,
        value.auth.hash,
        testState.environment,
      )).toEqual(value);
      expect(() => writeRecoveryCapsule(value, testState.environment)).not.toThrow();
      const changed = capsule({ post_id: "2078889282404569267", saved: false });
      expect(() => writeRecoveryCapsule(changed, testState.environment))
        .toThrow("does not match this run");

      expect(lstatSync(testState.directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(testState.directory, "recovery")).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(testState.directory, "recovery", "capsules")).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(testState.directory, ".recovery-encryption-key")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects authenticated-ciphertext and coordinate tampering", () => {
    const testState = state();
    try {
      const value = capsule();
      writeRecoveryCapsule(value, testState.environment);
      const path = join(testState.directory, "recovery", "capsules", `${RUN_ID}.json`);
      const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const tamperedTag = String(original.tag);
      writeFileSync(path, `${JSON.stringify({
        ...original,
        tag: `${tamperedTag[0] === "A" ? "B" : "A"}${tamperedTag.slice(1)}`,
      })}\n`, { mode: 0o600 });
      expect(() => readRecoveryCapsule(
        RUN_ID,
        value.auth.id,
        value.auth.hash,
        testState.environment,
      )).toThrow("failed authentication");

      writeFileSync(path, `${JSON.stringify({ ...original, authHash: "f".repeat(64) })}\n`, {
        mode: 0o600,
      });
      expect(() => readRecoveryCapsule(
        RUN_ID,
        value.auth.id,
        value.auth.hash,
        testState.environment,
      )).toThrow("bound to different run or auth coordinates");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("does not manufacture a replacement key while reading an existing capsule", () => {
    const testState = state();
    try {
      const value = capsule();
      writeRecoveryCapsule(value, testState.environment);
      const key = join(testState.directory, ".recovery-encryption-key");
      rmSync(key);

      expect(() => readRecoveryCapsule(
        RUN_ID,
        value.auth.id,
        value.auth.hash,
        testState.environment,
      )).toThrow();
      expect(existsSync(key)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses a new capsule rather than replacing a missing key for existing capsules", () => {
    const testState = state();
    try {
      const value = capsule();
      writeRecoveryCapsule(value, testState.environment);
      const key = join(testState.directory, ".recovery-encryption-key");
      rmSync(key);
      const next = {
        ...value,
        runId: SECOND_ID,
        createdAt: "2026-07-23T12:01:00.000Z",
      };

      expect(() => writeRecoveryCapsule(next, testState.environment))
        .toThrow("refusing to replace it");
      expect(existsSync(key)).toBeFalse();
      expect(existsSync(join(
        testState.directory,
        "recovery",
        "capsules",
        `${RUN_ID}.json`,
      ))).toBeTrue();
      expect(existsSync(join(
        testState.directory,
        "recovery",
        "capsules",
        `${SECOND_ID}.json`,
      ))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("round-trips non-built-in provider identities without requiring an installed plugin", () => {
    const testState = state();
    try {
      const web: RecoveryCapsule = {
        ...capsule(),
        operation: "direct-messaging.send-message",
        contract: {
          transport: "web-session-api",
          site: "example-social",
          action: "direct-messaging.send-message",
          version: 1_000_000,
          hash: CONTRACT_HASH,
        },
      };
      const provider: RecoveryCapsule = {
        ...capsule(),
        runId: SECOND_ID,
        operation: "timelines.bulk-read",
        contract: {
          transport: "provider-api",
          provider: "mastodon",
          action: "timelines.bulk-read",
          version: 42,
          hash: CONTRACT_HASH,
        },
      };

      writeRecoveryCapsule(web, testState.environment);
      writeRecoveryCapsule(provider, testState.environment);
      expect(readRecoveryCapsule(
        RUN_ID,
        web.auth.id,
        web.auth.hash,
        testState.environment,
      )).toEqual(web);
      expect(readRecoveryCapsule(
        SECOND_ID,
        provider.auth.id,
        provider.auth.hash,
        testState.environment,
      )).toEqual(provider);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("authenticates the complete portable identity and returns it frozen", () => {
    const testState = state();
    try {
      const value = portableCapsule();
      const expectedContractHash = recoveryContractHash(value.contract);
      writeRecoveryCapsule(value, testState.environment);
      const path = join(
        testState.directory,
        "recovery",
        "capsules",
        `${RUN_ID}.json`,
      );
      const encrypted = JSON.parse(
        readFileSync(path, "utf8"),
      ) as Record<string, unknown>;
      expect(encrypted.contractHash).toBe(expectedContractHash);
      expect(expectedContractHash).not.toBe(
        PORTABLE_IDENTITY.descriptorSha256,
      );

      const read = readRecoveryCapsule(
        RUN_ID,
        value.auth.id,
        value.auth.hash,
        testState.environment,
      );
      expect(read).toEqual(value);
      expect(
        read?.contract.transport === "portable-provider-plugin"
        && Object.isFrozen(read.contract),
      ).toBeTrue();
      expect(
        read?.contract.transport === "portable-provider-plugin"
        && Object.isFrozen(read.contract.identity),
      ).toBeTrue();
      expect(() => writeRecoveryCapsule(value, testState.environment))
        .not.toThrow();

      const changedIdentity = Object.freeze({
        ...PORTABLE_IDENTITY,
        manifestSha256: "4".repeat(64),
      });
      expect(recoveryContractHash(portableContract(changedIdentity)))
        .not.toBe(expectedContractHash);
      expect(() => writeRecoveryCapsule(
        portableCapsule(changedIdentity),
        testState.environment,
      )).toThrow("does not match this run");

      const tamperedHash = String(encrypted.contractHash);
      writeFileSync(path, `${JSON.stringify({
        ...encrypted,
        contractHash: `${tamperedHash[0] === "a" ? "b" : "a"}${tamperedHash.slice(1)}`,
      })}\n`, { mode: 0o600 });
      expect(() => readRecoveryCapsule(
        RUN_ID,
        value.auth.id,
        value.auth.hash,
        testState.environment,
      )).toThrow("failed authentication");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects portable contract extensions and identity accessors before storage", () => {
    const testState = state();
    try {
      expect(() => writeRecoveryCapsule({
        ...portableCapsule(),
        contract: {
          transport: "portable-provider-plugin",
          identity: {
            ...PORTABLE_IDENTITY,
            extension: true,
          },
        } as unknown as RecoveryContractIdentity,
      }, testState.environment)).toThrow("unsupported fields");

      expect(() => writeRecoveryCapsule({
        ...portableCapsule(),
        contract: {
          transport: "portable-provider-plugin",
          identity: {
            ...PORTABLE_IDENTITY,
            descriptorSha256: "A".repeat(64),
          },
        },
      }, testState.environment)).toThrow("malformed");

      let invoked = false;
      const identity: Record<string, unknown> = { ...PORTABLE_IDENTITY };
      Object.defineProperty(identity, "descriptorSha256", {
        enumerable: true,
        get() {
          invoked = true;
          return "3".repeat(64);
        },
      });
      expect(() => writeRecoveryCapsule({
        ...portableCapsule(),
        contract: {
          transport: "portable-provider-plugin",
          identity,
        } as unknown as RecoveryContractIdentity,
      }, testState.environment)).toThrow("unsupported accessor");
      expect(invoked).toBeFalse();
      expect(existsSync(join(testState.directory, "recovery"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "provider surface",
      contract: {
        transport: "provider-api",
        provider: "Mastodon",
        action: "timelines.read",
        version: 1,
        hash: CONTRACT_HASH,
      },
      message: "provider is malformed",
    },
    {
      label: "web-session surface",
      contract: {
        transport: "web-session-api",
        site: "../example",
        action: "feeds.read",
        version: 1,
        hash: CONTRACT_HASH,
      },
      message: "site is malformed",
    },
    {
      label: "operation",
      contract: {
        transport: "web-session-api",
        site: "example-social",
        action: "direct..send",
        version: 1,
        hash: CONTRACT_HASH,
      },
      message: "action is malformed",
    },
    {
      label: "contract version",
      contract: {
        transport: "provider-api",
        provider: "mastodon",
        action: "timelines.read",
        version: 1_000_001,
        hash: CONTRACT_HASH,
      },
      message: "version is malformed",
    },
  ])("rejects a malformed $label before storing a capsule", ({ contract, message }) => {
    const testState = state();
    try {
      const malformed = {
        ...capsule(),
        contract,
      } as unknown as RecoveryCapsule;
      expect(() => writeRecoveryCapsule(malformed, testState.environment))
        .toThrow(message);
      expect(existsSync(join(testState.directory, "recovery"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("append-only reconciliation observations", () => {
  test("appends immutable observations in deterministic time order", () => {
    const testState = state();
    try {
      const later = observation(
        SECOND_ID,
        "2026-07-23T12:01:00.000Z",
        "desired-state-not-observed",
      );
      const earlier = observation(RUN_ID, "2026-07-23T12:00:00.000Z");
      const laterPath = appendReconciliationObservation(later, testState.environment);
      const earlierPath = appendReconciliationObservation(earlier, testState.environment);
      const original = readFileSync(earlierPath, "utf8");

      expect(listReconciliationObservations(RUN_ID, testState.environment))
        .toEqual([earlier, later]);
      expect(lstatSync(laterPath).mode & 0o777).toBe(0o600);
      expect(() => appendReconciliationObservation(
        {
          ...earlier,
          outcome: "desired-state-not-observed",
          desiredStateMatched: false,
          actualState: false,
        },
        testState.environment,
      )).toThrow("already exists");
      expect(readFileSync(earlierPath, "utf8")).toBe(original);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("capsule cleanup never removes reconciliation history", () => {
    const testState = state();
    try {
      const value = capsule();
      writeRecoveryCapsule(value, testState.environment);
      const recorded = observation(RUN_ID, "2026-07-23T12:00:00.000Z", "inconclusive");
      appendReconciliationObservation(recorded, testState.environment);

      expect(removeRecoveryCapsule(RUN_ID, testState.environment)).toBeTrue();
      expect(removeRecoveryCapsule(RUN_ID, testState.environment)).toBeFalse();
      expect(listReconciliationObservations(RUN_ID, testState.environment)).toEqual([recorded]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
