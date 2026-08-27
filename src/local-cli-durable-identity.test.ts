import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { saveAuth, type WrenchAuth } from "./auth";
import { canonicalJson, parseRuntimeManifest, sha256 } from "./model";
import { parseLocalCliToolIdentityV1 } from "./local-cli-tool-identity";
import type {
  LocalCliPluginBindingV1,
  ProviderPluginBindingV1,
} from "./provider-plugin";
import type {
  ProviderPluginOperationResolutionV1,
  ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  readRecoveryCapsule,
  recoveryContractHash,
  writeRecoveryCapsule,
  type RecoveryCapsule,
} from "./recovery";
import { initialRunJournal, parseRunJournal } from "./run-journal";
import {
  confirmInvocation,
  createInvocationPlan,
  readRunReceipt,
  saveInvocationPlan,
  type InvocationPlan,
  type PreparedInvocation,
} from "./runtime";
import {
  ensurePrivateStateDirectory,
  wrenchStateHome,
  writePrivateJson,
} from "./storage";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function environment(): Readonly<Record<string, string | undefined>> {
  const root = mkdtempSync(join(tmpdir(), "wrench-local-durable-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { WRENCH_STATE_HOME: root, HOME: root };
}

function currentManifest() {
  const parsed = parseRuntimeManifest(JSON.parse(readFileSync(join(
    import.meta.dir,
    "assets/adapters/beeper/wrench-web-adapter.json",
  ), "utf8")) as unknown, providerPluginRegistry);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
}

function authority(): WrenchAuth {
  return {
    schemaVersion: 1,
    id: "beeper-main",
    kind: "linked-device-store",
    provider: "beeper",
    path: "/private/tmp/wrench-test-beeper-store",
    subject: `beeper:local:${"a".repeat(64)}`,
  };
}

function invocation(): PreparedInvocation {
  return {
    manifest: currentManifest(),
    operationId: "messaging.send",
    input: {
      account_id: "account:example",
      conversation_id: "!chat:example.org",
      kind: "text",
      text: "hello from a schema-seven fixture",
    },
    auth: authority(),
  };
}

function localPlan(): Extract<InvocationPlan, { readonly schemaVersion: 7 }> {
  const stored = createInvocationPlan(
    invocation(),
    new Date("2026-08-26T12:00:00.000Z"),
    providerPluginRegistry,
  );
  if (stored.plan.schemaVersion !== 7) {
    throw new Error("Beeper plan did not use schema 7");
  }
  return stored.plan;
}

function registryWithDriftedTool(): ProviderPluginRegistry {
  const original = providerPluginRegistry.requireRoute(
    "local-cli",
    "beeper",
  );
  if (original.transport !== "local-cli") {
    throw new Error("Beeper local binding is unavailable");
  }
  const rawTool = structuredClone(original.tool);
  const artifact = rawTool.artifacts[0];
  if (artifact === undefined) throw new Error("Beeper tool has no artifact");
  (artifact as { executableSha256: string }).executableSha256 =
    artifact.executableSha256 === "f".repeat(64)
      ? "e".repeat(64)
      : "f".repeat(64);
  const drifted: LocalCliPluginBindingV1 = Object.freeze({
    ...original,
    tool: parseLocalCliToolIdentityV1(rawTool),
  });
  const binding = (candidate: ProviderPluginBindingV1): ProviderPluginBindingV1 =>
    candidate === drifted ? original : candidate;
  const resolution = (
    value: ProviderPluginOperationResolutionV1 | undefined,
  ): ProviderPluginOperationResolutionV1 | undefined =>
    value === undefined || value.binding !== original
      ? value
      : Object.freeze({ ...value, binding: drifted });
  return Object.freeze({
    ...providerPluginRegistry,
    resolveRoute: (transport, surfaceId) =>
      transport === "local-cli" && surfaceId === "beeper"
        ? drifted
        : providerPluginRegistry.resolveRoute(transport, surfaceId),
    requireRoute: (transport, surfaceId) =>
      transport === "local-cli" && surfaceId === "beeper"
        ? drifted
        : providerPluginRegistry.requireRoute(transport, surfaceId),
    resolveAccountRoute: (surfaceId) => surfaceId === "beeper"
      ? drifted
      : providerPluginRegistry.resolveAccountRoute(surfaceId),
    requireAccountRoute: (surfaceId) => surfaceId === "beeper"
      ? drifted
      : providerPluginRegistry.requireAccountRoute(surfaceId),
    resolveOperation: (transport, surfaceId, operation, contractVersion) =>
      transport === "local-cli" && surfaceId === "beeper"
        ? drifted
        : providerPluginRegistry.resolveOperation(
            transport,
            surfaceId,
            operation,
            contractVersion,
          ),
    requireOperation: (transport, surfaceId, operation, contractVersion) =>
      transport === "local-cli" && surfaceId === "beeper"
        ? drifted
        : providerPluginRegistry.requireOperation(
            transport,
            surfaceId,
            operation,
            contractVersion,
          ),
    resolveOperationDefinition: (transport, surfaceId, operation, contractVersion) =>
      resolution(providerPluginRegistry.resolveOperationDefinition(
        transport,
        surfaceId,
        operation,
        contractVersion,
      )),
    requireOperationDefinition: (transport, surfaceId, operation, contractVersion) => {
      const value = resolution(providerPluginRegistry.requireOperationDefinition(
        transport,
        surfaceId,
        operation,
        contractVersion,
      ));
      if (value === undefined) throw new Error("operation disappeared");
      return value;
    },
    implementationHash: (candidate) =>
      providerPluginRegistry.implementationHash(binding(candidate)),
    contractImplementationHash: (candidate) =>
      providerPluginRegistry.contractImplementationHash(binding(candidate)),
    legacyContractImplementationHashes: (candidate, operation, version) =>
      providerPluginRegistry.legacyContractImplementationHashes(
        binding(candidate),
        operation,
        version,
      ),
    implementationClosureHash: (candidate) =>
      providerPluginRegistry.implementationClosureHash(binding(candidate)),
    artifactSha256: (candidate) =>
      providerPluginRegistry.artifactSha256(binding(candidate)),
  });
}

describe("local CLI durable identity", () => {
  test("pins schema-7 plans and invalidates confirmation after tool drift", async () => {
    const selectedEnvironment = environment();
    const prepared = invocation();
    saveAuth(prepared.auth as WrenchAuth, selectedEnvironment);
    const stored = createInvocationPlan(
      prepared,
      new Date("2026-08-26T12:00:00.000Z"),
      providerPluginRegistry,
    );
    expect(stored.plan).toMatchObject({
      schemaVersion: 7,
      transport: "local-cli",
      localCliContract: {
        surface: "beeper",
        action: "messaging.send",
        version: 1,
        tool: { schemaVersion: 1, id: "beeper-cli" },
      },
    });
    saveInvocationPlan(stored, selectedEnvironment);

    await expect(confirmInvocation(stored.digest, {
      headed: false,
      environment: selectedEnvironment,
      registry: registryWithDriftedTool(),
      now: new Date("2026-08-26T12:00:01.000Z"),
      loadManifest: () => ({ ok: true, value: prepared.manifest }),
    })).rejects.toThrow(
      "local CLI tool or contract changed after preview",
    );
  });

  test("round trips the exact identity through journals and recovery capsules", () => {
    const selectedEnvironment = environment();
    const plan = localPlan();
    const identity = plan.localCliContract;
    const runId = randomUUID();
    const auth = authority();
    const inputHash = sha256(canonicalJson({ account_id: "account:example" }));
    const journal = initialRunJournal({
      runId,
      planDigest: "1".repeat(64),
      adapter: plan.adapter,
      operation: plan.operation,
      risk: "R3",
      inputHash,
      auth: { id: auth.id, hash: "2".repeat(64), kind: auth.kind },
      contract: { transport: "local-cli", identity },
      plannedDispatches: 1,
      hasPlanAssets: false,
      owner: {
        pid: 123,
        token: randomUUID(),
        bootId: "3".repeat(64),
        processStartId: "4".repeat(64),
        leaseUntil: "2026-08-26T12:10:00.000Z",
      },
      startedAt: "2026-08-26T12:00:00.000Z",
      dedupeExpiresAt: "2026-08-27T12:00:00.000Z",
    });
    expect(parseRunJournal(structuredClone(journal))).toEqual(journal);
    expect(journal.contract).toEqual({ transport: "local-cli", identity });

    const capsule: RecoveryCapsule = {
      schemaVersion: 1,
      runId,
      createdAt: "2026-08-26T12:00:00.000Z",
      planDigest: journal.planDigest,
      adapter: journal.adapter,
      operation: journal.operation,
      risk: journal.risk,
      input: { account_id: "account:example" },
      inputHash,
      auth: journal.auth,
      contract: { transport: "local-cli", identity },
    };
    writeRecoveryCapsule(capsule, selectedEnvironment);
    expect(readRecoveryCapsule(
      runId,
      journal.auth.id,
      journal.auth.hash,
      selectedEnvironment,
    )).toEqual(capsule);
    expect(recoveryContractHash(capsule.contract)).toBe(identity.hash);

    const drifted = registryWithDriftedTool().requireRoute(
      "local-cli",
      "beeper",
    );
    if (drifted.transport !== "local-cli") throw new Error("wrong drift route");
    expect(canonicalJson(drifted.tool)).not.toBe(canonicalJson(identity.tool));
  });

  test("reads exact schema-7 and predecessor schema-4 receipts without transport confusion", () => {
    const selectedEnvironment = environment();
    const plan = localPlan();
    const runs = join(wrenchStateHome(selectedEnvironment), "runs");
    ensurePrivateStateDirectory(runs, selectedEnvironment);
    const common = {
      runId: randomUUID(),
      planDigest: "1".repeat(64),
      adapter: plan.adapter,
      operation: plan.operation,
      risk: plan.risk,
      inputHash: plan.inputHash,
      auth: { id: "beeper-main", hash: "2".repeat(64), kind: "linked-device-store" },
      status: "submitted",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
      startedAt: "2026-08-26T12:00:00.000Z",
      finishedAt: "2026-08-26T12:00:01.000Z",
      finalOrigin: "https://www.beeper.com",
      error: null,
    } as const;
    writePrivateJson(join(runs, `${common.runId}.json`), {
      ...common,
      schemaVersion: 7,
      transport: "local-cli",
      localCliContract: plan.localCliContract,
    });
    expect(readRunReceipt(common.runId, selectedEnvironment)).toMatchObject({
      schemaVersion: 7,
      transport: "local-cli",
      localCliContract: plan.localCliContract,
    });

    const legacyRunId = randomUUID();
    writePrivateJson(join(runs, `${legacyRunId}.json`), {
      ...common,
      runId: legacyRunId,
      schemaVersion: 4,
      transport: "web-session-api",
      webSessionContractHash: "5".repeat(64),
    });
    expect(readRunReceipt(legacyRunId, selectedEnvironment)).toMatchObject({
      schemaVersion: 4,
      transport: "web-session-api",
      webSessionContractHash: "5".repeat(64),
    });
  });
});
