import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./model";
import {
  readProviderAcceptedMutationTargetEvidence,
  readRecoveryCapsule,
  removeProviderAcceptedMutationTargetEvidence,
  writeProviderAcceptedMutationTargetEvidence,
  writeRecoveryCapsule,
  type ProviderAcceptedMutationTargetEvidence,
  type RecoveryCapsule,
} from "./recovery";

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const TARGET = "provider:post:private-target-123";
const DISPATCH = Object.freeze({
  id: "posts.publish",
  index: 1,
  planned: 1,
});

function state(): TestState {
  const directory = mkdtempSync(
    join(tmpdir(), "wrench-provider-accepted-target-test-"),
  );
  chmodSync(directory, 0o700);
  return {
    directory,
    environment: { WRENCH_STATE_HOME: directory },
  };
}

function capsule(): RecoveryCapsule {
  const input = { body: "private post body" };
  return Object.freeze({
    schemaVersion: 1,
    runId: RUN_ID,
    createdAt: "2026-08-18T12:00:00.000Z",
    planDigest: "a".repeat(64),
    adapter: Object.freeze({
      id: "example-web",
      version: "1.0.0",
      hash: "b".repeat(64),
    }),
    operation: "posts.publish",
    risk: "R3",
    input,
    inputHash: sha256(canonicalJson(input)),
    auth: Object.freeze({
      id: "example-main",
      hash: "c".repeat(64),
      kind: "cookie-source",
    }),
    contract: Object.freeze({
      transport: "web-session-api",
      site: "example",
      action: "posts.publish",
      version: 1,
      hash: "d".repeat(64),
    }),
  });
}

function evidence(
  selectedCapsule: RecoveryCapsule = capsule(),
  identifier = TARGET,
): ProviderAcceptedMutationTargetEvidence {
  if (selectedCapsule.contract.transport !== "web-session-api") {
    throw new Error("expected a web-session recovery capsule");
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: selectedCapsule.runId,
    acceptedAt: "2026-08-18T12:00:01.000Z",
    planDigest: selectedCapsule.planDigest,
    adapter: selectedCapsule.adapter,
    operation: selectedCapsule.operation,
    inputHash: selectedCapsule.inputHash,
    auth: selectedCapsule.auth,
    contract: selectedCapsule.contract,
    dispatch: DISPATCH,
    target: Object.freeze({ schemaVersion: 1, identifier }),
  });
}

function installCapsule(testState: TestState): RecoveryCapsule {
  const selected = capsule();
  writeRecoveryCapsule(selected, testState.environment);
  return selected;
}

function errorMessage(action: () => void): string {
  try {
    action();
    return "completed";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("encrypted provider-accepted mutation target evidence", () => {
  test("persists one exact target without exposing target or input content", () => {
    const testState = state();
    try {
      const selectedCapsule = installCapsule(testState);
      const selectedEvidence = evidence(selectedCapsule);
      writeProviderAcceptedMutationTargetEvidence(
        selectedEvidence,
        testState.environment,
      );

      expect(readProviderAcceptedMutationTargetEvidence(
        selectedCapsule,
        DISPATCH,
        testState.environment,
      )).toEqual(selectedEvidence);
      const raw = readFileSync(join(
        testState.directory,
        "recovery",
        "provider-accepted-targets",
        RUN_ID,
        "1.json",
      ), "utf8");
      expect(raw).not.toContain(TARGET);
      expect(raw).not.toContain("private post body");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("returns null for historical runs that have no accepted-target evidence", () => {
    const testState = state();
    try {
      const selectedCapsule = installCapsule(testState);
      expect(readProviderAcceptedMutationTargetEvidence(
        selectedCapsule,
        DISPATCH,
        testState.environment,
      )).toBeNull();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects binding mismatches without changing the first evidence", () => {
    const testState = state();
    try {
      const selectedCapsule = installCapsule(testState);
      const selectedEvidence = evidence(selectedCapsule);
      writeProviderAcceptedMutationTargetEvidence(
        selectedEvidence,
        testState.environment,
      );
      const wrongCapsule = {
        ...selectedCapsule,
        adapter: { ...selectedCapsule.adapter, hash: "e".repeat(64) },
      };

      expect(() => readProviderAcceptedMutationTargetEvidence(
        wrongCapsule,
        DISPATCH,
        testState.environment,
      )).toThrow("different run coordinates");
      expect(() => readProviderAcceptedMutationTargetEvidence(
        selectedCapsule,
        { ...DISPATCH, id: "posts.publish[1]" },
        testState.environment,
      )).toThrow("different run coordinates");
      expect(readProviderAcceptedMutationTargetEvidence(
        selectedCapsule,
        DISPATCH,
        testState.environment,
      )).toEqual(selectedEvidence);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("accepts an exact create-once replay and rejects a contradictory target", () => {
    const testState = state();
    try {
      const selectedCapsule = installCapsule(testState);
      const selectedEvidence = evidence(selectedCapsule);
      writeProviderAcceptedMutationTargetEvidence(
        selectedEvidence,
        testState.environment,
      );
      writeProviderAcceptedMutationTargetEvidence(
        selectedEvidence,
        testState.environment,
      );
      const contradictoryTarget = "provider:post:contradictory-456";
      const message = errorMessage(() =>
        writeProviderAcceptedMutationTargetEvidence(
          evidence(selectedCapsule, contradictoryTarget),
          testState.environment,
        )
      );

      expect(message).toContain("contradictory");
      expect(message).not.toContain(TARGET);
      expect(message).not.toContain(contradictoryTarget);
      expect(readProviderAcceptedMutationTargetEvidence(
        selectedCapsule,
        DISPATCH,
        testState.environment,
      )).toEqual(selectedEvidence);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("strictly rejects malformed foreign evidence before persistence", () => {
    const testState = state();
    try {
      const selectedCapsule = installCapsule(testState);
      const selectedEvidence = evidence(selectedCapsule);
      const accessor = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(accessor, {
        schemaVersion: { value: 1, enumerable: true },
        identifier: { get: () => TARGET, enumerable: true },
      });
      for (const malformed of [
        { ...selectedEvidence, unsupported: true },
        {
          ...selectedEvidence,
          dispatch: { ...DISPATCH, planned: 26 },
        },
        {
          ...selectedEvidence,
          target: { schemaVersion: 1, identifier: `${TARGET}\n` },
        },
        { ...selectedEvidence, target: accessor },
      ]) {
        expect(() => writeProviderAcceptedMutationTargetEvidence(
          malformed,
          testState.environment,
        )).toThrow();
      }
      expect(readProviderAcceptedMutationTargetEvidence(
        selectedCapsule,
        DISPATCH,
        testState.environment,
      )).toBeNull();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("a missing recovery key cannot strand an empty accepted-target owner", () => {
    const testState = state();
    try {
      const selectedCapsule = installCapsule(testState);
      rmSync(join(testState.directory, ".recovery-encryption-key"));
      expect(() => writeProviderAcceptedMutationTargetEvidence(
        evidence(selectedCapsule),
        testState.environment,
      )).toThrow("recovery encryption key");
      expect(existsSync(join(
        testState.directory,
        "recovery",
        "provider-accepted-targets",
        RUN_ID,
      ))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("removes only the target evidence during recovery lifecycle cleanup", () => {
    const testState = state();
    try {
      const selectedCapsule = installCapsule(testState);
      writeProviderAcceptedMutationTargetEvidence(
        evidence(selectedCapsule),
        testState.environment,
      );

      expect(removeProviderAcceptedMutationTargetEvidence(
        RUN_ID,
        testState.environment,
      )).toBeTrue();
      expect(readProviderAcceptedMutationTargetEvidence(
        selectedCapsule,
        DISPATCH,
        testState.environment,
      )).toBeNull();
      expect(readRecoveryCapsule(
        selectedCapsule.runId,
        selectedCapsule.auth.id,
        selectedCapsule.auth.hash,
        testState.environment,
      )).toEqual(selectedCapsule);
      expect(existsSync(join(
        testState.directory,
        "recovery",
        "provider-accepted-targets",
        RUN_ID,
      ))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
