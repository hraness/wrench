import {
  assertEmptyPrivateCdpResult,
  exactPrivateCdpSessionId,
  localBrowserCdpUrl,
  parsePrivateCdpTargetId,
  PrivateCdpClient,
} from "./derivation-file-chooser";
import {
  DERIVATION_GUARD_EXTENSION_ID,
  derivationGuardReadinessCheckCount,
  derivationGuardReadinessPolicySha256,
} from "./derivation-network-guard";

type JsonRecord = Record<string, unknown>;

export type DerivationDnrCdpClient = {
  readonly send: (
    method: string,
    parameters?: JsonRecord,
    sessionId?: string,
  ) => Promise<unknown>;
  readonly close: () => void;
};

type DnrReadinessDependencies = {
  readonly connect: (url: string) => Promise<DerivationDnrCdpClient>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

const extensionOrigin = `chrome-extension://${DERIVATION_GUARD_EXTENSION_ID}`;
const readinessScopeUrl = `${extensionOrigin}/`;
const readinessWorkerUrl = `${extensionOrigin}/readiness.js`;
const readinessTimeoutMs = 10_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} changed shape`);
  }
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string"
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} changed shape`);
  return value;
}

type PageTarget = {
  readonly targetId: string;
  readonly url: string;
};

type ListedTargets = {
  readonly pageTargets: readonly PageTarget[];
  readonly currentPageTargetId: string;
  readonly readinessWorkerTargetIds: readonly string[];
};

const targetInfoKeys = new Set([
  "attached",
  "browserContextId",
  "canAccessOpener",
  "openerFrameId",
  "openerId",
  "parentFrameId",
  "parentId",
  "subtype",
  "targetId",
  "title",
  "type",
  "url",
]);

function listedTargets(value: unknown, currentUrl: string): ListedTargets {
  if (!isRecord(value)) throw new Error("derivation guard target listing changed shape");
  exactKeys(value, ["targetInfos"], "derivation guard target listing");
  if (!Array.isArray(value.targetInfos) || value.targetInfos.length > 100) {
    throw new Error("derivation guard target listing changed shape");
  }
  const pageTargets: PageTarget[] = [];
  const currentPageTargetIds: string[] = [];
  const readinessWorkerTargetIds: string[] = [];
  const allTargetIds = new Set<string>();
  for (const candidate of value.targetInfos) {
    if (
      !isRecord(candidate)
      || Object.keys(candidate).some((key) => !targetInfoKeys.has(key))
      || typeof candidate.attached !== "boolean"
      || typeof candidate.canAccessOpener !== "boolean"
      || typeof candidate.title !== "string"
      || candidate.title.length > 64 * 1024
    ) throw new Error("derivation guard target listing changed shape");
    const targetId = parsePrivateCdpTargetId(candidate.targetId);
    if (allTargetIds.has(targetId)) {
      throw new Error("derivation guard target listing is ambiguous");
    }
    allTargetIds.add(targetId);
    const type = boundedString(candidate.type, 64, "derivation guard target listing");
    const url = boundedString(candidate.url, 64 * 1024, "derivation guard target listing");
    if (type.length === 0) throw new Error("derivation guard target listing changed shape");
    for (const key of [
      "browserContextId",
      "openerFrameId",
      "parentFrameId",
      "parentId",
      "subtype",
    ] as const) {
      if (key in candidate) {
        boundedString(candidate[key], 256, "derivation guard target listing");
      }
    }
    if ("openerId" in candidate) parsePrivateCdpTargetId(candidate.openerId);
    if (url === extensionOrigin || url.startsWith(`${extensionOrigin}/`)) {
      if (type !== "service_worker" || url !== readinessWorkerUrl) {
        throw new Error("derivation guard worker target changed identity");
      }
      readinessWorkerTargetIds.push(targetId);
    }
    if (type === "page") {
      pageTargets.push({ targetId, url });
      if (url === currentUrl) currentPageTargetIds.push(targetId);
    }
  }
  pageTargets.sort((left, right) => left.targetId.localeCompare(right.targetId));
  readinessWorkerTargetIds.sort();
  if (currentPageTargetIds.length !== 1) {
    throw new Error("derivation guard current page target is unavailable or ambiguous");
  }
  return {
    pageTargets,
    currentPageTargetId: currentPageTargetIds[0] as string,
    readinessWorkerTargetIds,
  };
}

function samePageTargets(left: readonly PageTarget[], right: readonly PageTarget[]): boolean {
  return left.length === right.length && left.every((value, index) => (
    value.targetId === right[index]?.targetId && value.url === right[index]?.url
  ));
}

function assertPageTargetsUnchanged(initial: ListedTargets, current: ListedTargets): void {
  if (
    initial.currentPageTargetId !== current.currentPageTargetId
    || !samePageTargets(initial.pageTargets, current.pageTargets)
  ) throw new Error("derivation guard page target set changed during readiness");
}

function readinessEvaluation(
  value: unknown,
  expectedChecks: number,
  expectedPolicySha256: string,
): void {
  if (!isRecord(value)) throw new Error("derivation guard readiness changed shape");
  exactKeys(value, ["result"], "derivation guard readiness");
  if (!isRecord(value.result)) throw new Error("derivation guard readiness changed shape");
  exactKeys(value.result, ["type", "value"], "derivation guard readiness result envelope");
  if (value.result.type !== "object" || !isRecord(value.result.value)) {
    throw new Error("derivation guard readiness changed shape");
  }
  exactKeys(
    value.result.value,
    ["schemaVersion", "ok", "extensionId", "policySha256", "checks"],
    "derivation guard readiness result",
  );
  if (
    value.result.value.schemaVersion !== 1
    || value.result.value.ok !== true
    || value.result.value.extensionId !== DERIVATION_GUARD_EXTENSION_ID
    || value.result.value.checks !== expectedChecks
  ) throw new Error("derivation guard readiness checks did not pass");
  if (
    typeof value.result.value.policySha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.result.value.policySha256)
    || value.result.value.policySha256 !== expectedPolicySha256
  ) throw new Error("derivation guard readiness policy did not match");
}

async function detachExactly(
  client: DerivationDnrCdpClient,
  sessionId: string,
  label: string,
): Promise<void> {
  assertEmptyPrivateCdpResult(
    await client.send("Target.detachFromTarget", { sessionId }),
    label,
  );
}

async function checkWorker(
  client: DerivationDnrCdpClient,
  targetId: string,
  browserDomains: readonly string[],
  dependencies: DnrReadinessDependencies,
): Promise<void> {
  const sessionId = exactPrivateCdpSessionId(await client.send(
    "Target.attachToTarget",
    { flatten: true, targetId },
  ));
  let checkFailure: unknown = null;
  try {
    assertEmptyPrivateCdpResult(
      await client.send("Runtime.enable", {}, sessionId),
      "derivation guard Runtime.enable response",
    );
    const deadline = dependencies.now() + readinessTimeoutMs;
    const expectedPolicySha256 = derivationGuardReadinessPolicySha256(browserDomains);
    for (;;) {
      try {
        readinessEvaluation(await client.send("Runtime.evaluate", {
          awaitPromise: true,
          expression: "globalThis.__wrenchCheckGuard()",
          returnByValue: true,
        }, sessionId), derivationGuardReadinessCheckCount(browserDomains), expectedPolicySha256);
        break;
      } catch (error) {
        if (dependencies.now() >= deadline) throw error;
        await dependencies.sleep(25);
      }
    }
  } catch (error) {
    checkFailure = error;
  }
  try {
    await detachExactly(client, sessionId, "derivation guard worker detach response");
  } catch (detachFailure) {
    if (checkFailure !== null) {
      throw new AggregateError(
        [checkFailure, detachFailure],
        "derivation guard readiness failed and worker detachment could not be proved",
      );
    }
    throw detachFailure;
  }
  if (checkFailure !== null) throw checkFailure;
}

async function waitForExactWorker(
  client: DerivationDnrCdpClient,
  initial: ListedTargets,
  currentUrl: string,
  dependencies: DnrReadinessDependencies,
): Promise<string> {
  const deadline = dependencies.now() + readinessTimeoutMs;
  for (;;) {
    const targets = listedTargets(await client.send("Target.getTargets"), currentUrl);
    assertPageTargetsUnchanged(initial, targets);
    if (targets.readinessWorkerTargetIds.length === 1) {
      return targets.readinessWorkerTargetIds[0] as string;
    }
    if (targets.readinessWorkerTargetIds.length > 1) {
      throw new Error("derivation guard worker target is ambiguous");
    }
    if (dependencies.now() >= deadline) {
      throw new Error("derivation guard worker target did not become ready");
    }
    await dependencies.sleep(25);
  }
}

async function runFreshDerivationDnrReadiness(
  cdpUrlValue: unknown,
  currentUrl: string,
  browserDomains: readonly string[],
  overrides: Partial<DnrReadinessDependencies>,
): Promise<void> {
  const dependencies: DnrReadinessDependencies = {
    connect: overrides.connect ?? ((url) => PrivateCdpClient.connect(url)),
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? ((milliseconds) => Bun.sleep(milliseconds)),
  };
  const client = await dependencies.connect(localBrowserCdpUrl(cdpUrlValue));
  try {
    const initial = listedTargets(await client.send("Target.getTargets"), currentUrl);
    if (initial.readinessWorkerTargetIds.length > 1) {
      throw new Error("derivation guard worker target is ambiguous");
    }
    const failures: unknown[] = [];
    let checkedWorkerTargetId: string | null = null;
    let pageSessionId: string | null = null;
    try {
      pageSessionId = exactPrivateCdpSessionId(await client.send(
        "Target.attachToTarget",
        { flatten: true, targetId: initial.currentPageTargetId },
      ));
      assertEmptyPrivateCdpResult(
        await client.send("ServiceWorker.enable", {}, pageSessionId),
        "derivation guard ServiceWorker.enable response",
      );
      assertEmptyPrivateCdpResult(
        await client.send(
          "ServiceWorker.startWorker",
          { scopeURL: readinessScopeUrl },
          pageSessionId,
        ),
        "derivation guard worker start response",
      );
      checkedWorkerTargetId = await waitForExactWorker(
        client,
        initial,
        currentUrl,
        dependencies,
      );
      await checkWorker(client, checkedWorkerTargetId, browserDomains, dependencies);
    } catch (error) {
      failures.push(error);
    }
    if (pageSessionId !== null) {
      try {
        await detachExactly(client, pageSessionId, "derivation guard page detach response");
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      const final = listedTargets(await client.send("Target.getTargets"), currentUrl);
      assertPageTargetsUnchanged(initial, final);
      if (
        checkedWorkerTargetId !== null
        && (
          final.readinessWorkerTargetIds.length !== 1
          || final.readinessWorkerTargetIds[0] !== checkedWorkerTargetId
        )
      ) throw new Error("derivation guard worker target changed identity");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "derivation guard readiness failed and cleanup stability could not be proved",
      );
    }
  } finally {
    client.close();
  }
}

/** Run every DNR API check in the exact MV3 background service worker. */
export async function initializeDerivationDnrReadiness(
  cdpUrlValue: unknown,
  currentUrl: string,
  browserDomains: readonly string[],
  overrides: Partial<DnrReadinessDependencies> = {},
): Promise<void> {
  await runFreshDerivationDnrReadiness(cdpUrlValue, currentUrl, browserDomains, overrides);
}

/** Re-run every DNR API check in the exact MV3 background service worker. */
export async function verifyDerivationDnrReadiness(
  cdpUrlValue: unknown,
  currentUrl: string,
  browserDomains: readonly string[],
  overrides: Partial<DnrReadinessDependencies> = {},
): Promise<void> {
  await runFreshDerivationDnrReadiness(cdpUrlValue, currentUrl, browserDomains, overrides);
}
