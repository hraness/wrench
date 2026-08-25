import { describe, expect, test } from "bun:test";

import {
  initializeDerivationDnrReadiness,
  verifyDerivationDnrReadiness,
  type DerivationDnrCdpClient,
} from "./derivation-dnr-readiness";
import {
  DERIVATION_GUARD_EXTENSION_ID,
  derivationGuardReadinessCheckCount,
  derivationGuardReadinessPolicySha256,
} from "./derivation-network-guard";

const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/wrench-test";
const extensionOrigin = `chrome-extension://${DERIVATION_GUARD_EXTENSION_ID}`;
const readinessScopeUrl = `${extensionOrigin}/`;
const readinessWorkerUrl = `${extensionOrigin}/readiness.js`;
const workerTargetId = "A".repeat(32);
const secondWorkerTargetId = "B".repeat(32);
const originalTargetId = "C".repeat(32);
const otherPageTargetId = "D".repeat(32);
const currentUrl = "about:blank";
const pageSessionId = "wrench-page-session";
const workerSessionId = "wrench-worker-session";

type Call = {
  readonly method: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
};

function targetInfo(targetId: string, type: string, url: string, attached = false) {
  return {
    attached,
    canAccessOpener: false,
    targetId,
    title: "",
    type,
    url,
  };
}

class FakeDnrCdpClient implements DerivationDnrCdpClient {
  readonly calls: Call[] = [];
  readonly workerTargetIds: string[];
  closed = false;
  pageAttached = false;
  workerAttached = false;
  readinessOk = true;
  readinessPolicySha256: unknown = derivationGuardReadinessPolicySha256(["example.com"]);
  evaluationResult: unknown = null;
  startResult: unknown = {};
  startThrows = false;
  startCreatesWorker = true;
  workerListingsBeforeVisible = 0;
  startRequested = false;
  workerType = "service_worker";
  workerUrl = readinessWorkerUrl;
  workerMutationBeforeAttach: "none" | "swap" | "vanish" = "none";
  workerAttachThrows = false;
  runtimeEnableThrows = false;
  pageDetachResult: unknown = {};
  workerDetachResult: unknown = {};
  removeWorkerAfterDetach = false;
  listingCount = 0;
  driftPageOnListing: number | undefined;
  addPageOnListing: number | undefined;
  extraTargetField = false;

  constructor(workerTargetIds: readonly string[] = []) {
    this.workerTargetIds = [...workerTargetIds];
  }

  send(
    method: string,
    parameters: Readonly<Record<string, unknown>> = {},
    boundSessionId?: string,
  ): Promise<unknown> {
    this.calls.push({
      method,
      parameters,
      ...(boundSessionId === undefined ? {} : { sessionId: boundSessionId }),
    });
    if (method === "Target.getTargets") {
      const listing = this.listingCount++;
      if (this.startRequested && this.workerTargetIds.length === 0 && this.startCreatesWorker) {
        if (this.workerListingsBeforeVisible === 0) this.workerTargetIds.push(workerTargetId);
        else this.workerListingsBeforeVisible -= 1;
      }
      const originalUrl = this.driftPageOnListing === listing
        ? "https://example.com/drift"
        : currentUrl;
      const infos: Array<Record<string, unknown>> = [
        targetInfo(originalTargetId, "page", originalUrl, this.pageAttached),
        targetInfo(otherPageTargetId, "page", "https://example.com/other"),
        ...this.workerTargetIds.map((id) => targetInfo(
          id,
          this.workerType,
          this.workerUrl,
          this.workerAttached,
        )),
      ];
      if (this.addPageOnListing === listing) {
        infos.push(targetInfo("E".repeat(32), "page", "https://example.com/new"));
      }
      if (this.extraTargetField) infos[0] = { ...infos[0], privateValue: "do-not-leak" };
      return Promise.resolve({ targetInfos: infos });
    }
    if (method === "Target.attachToTarget") {
      if (parameters.flatten !== true) throw new Error("unexpected target attachment");
      if (parameters.targetId === originalTargetId) {
        this.pageAttached = true;
        return Promise.resolve({ sessionId: pageSessionId });
      }
      if (parameters.targetId === workerTargetId || parameters.targetId === secondWorkerTargetId) {
        if (this.workerMutationBeforeAttach !== "none") {
          this.workerTargetIds.splice(
            0,
            this.workerTargetIds.length,
            ...(this.workerMutationBeforeAttach === "swap" ? [secondWorkerTargetId] : []),
          );
          this.startCreatesWorker = false;
          return Promise.reject(new Error("private CDP command failed"));
        }
        if (this.workerAttachThrows) {
          return Promise.reject(new Error("private CDP command failed"));
        }
        this.workerAttached = true;
        return Promise.resolve({ sessionId: workerSessionId });
      }
      throw new Error("unexpected target attachment");
    }
    if (method === "ServiceWorker.enable") {
      if (boundSessionId !== pageSessionId || Object.keys(parameters).length !== 0) {
        throw new Error("unexpected worker enable");
      }
      return Promise.resolve({});
    }
    if (method === "ServiceWorker.startWorker") {
      if (
        boundSessionId !== pageSessionId
        || Object.keys(parameters).join(",") !== "scopeURL"
        || parameters.scopeURL !== readinessScopeUrl
      ) throw new Error("unexpected worker start");
      this.startRequested = true;
      if (this.startThrows) return Promise.reject(new Error("private start failure"));
      return Promise.resolve(this.startResult);
    }
    if (method === "Runtime.enable") {
      if (boundSessionId !== workerSessionId || Object.keys(parameters).length !== 0) {
        throw new Error("unexpected Runtime.enable");
      }
      if (this.runtimeEnableThrows) {
        return Promise.reject(new Error("private CDP command failed"));
      }
      return Promise.resolve({});
    }
    if (method === "Runtime.evaluate") {
      if (boundSessionId !== workerSessionId) throw new Error("unexpected evaluation session");
      if (this.evaluationResult !== null) return Promise.resolve(this.evaluationResult);
      return Promise.resolve({
        result: {
          type: "object",
          value: this.readinessOk
            ? {
                schemaVersion: 1,
                ok: true,
                extensionId: DERIVATION_GUARD_EXTENSION_ID,
                policySha256: this.readinessPolicySha256,
                checks: derivationGuardReadinessCheckCount(["example.com"]),
              }
            : {
                schemaVersion: 1,
                ok: false,
                extensionId: "",
                policySha256: "",
                checks: 0,
              },
        },
      });
    }
    if (method === "Target.detachFromTarget") {
      if (parameters.sessionId === workerSessionId) {
        this.workerAttached = false;
        if (this.removeWorkerAfterDetach) {
          this.workerTargetIds.splice(0);
          this.startCreatesWorker = false;
        }
        return Promise.resolve(this.workerDetachResult);
      }
      if (parameters.sessionId === pageSessionId) {
        this.pageAttached = false;
        return Promise.resolve(this.pageDetachResult);
      }
      throw new Error("unexpected target detachment");
    }
    throw new Error(`unexpected CDP method ${method}`);
  }

  close(): void {
    this.closed = true;
  }
}

describe("contained derivation DNR readiness", () => {
  test("starts, proves, and detaches the exact background worker without changing pages", async () => {
    for (const operation of [initializeDerivationDnrReadiness, verifyDerivationDnrReadiness]) {
      const client = new FakeDnrCdpClient();
      await operation(cdpUrl, currentUrl, ["example.com"], {
        connect: () => Promise.resolve(client),
      });
      expect(client.closed).toBeTrue();
      expect(client.calls.map((call) => call.method)).toEqual([
        "Target.getTargets",
        "Target.attachToTarget",
        "ServiceWorker.enable",
        "ServiceWorker.startWorker",
        "Target.getTargets",
        "Target.attachToTarget",
        "Runtime.enable",
        "Runtime.evaluate",
        "Target.detachFromTarget",
        "Target.detachFromTarget",
        "Target.getTargets",
      ]);
      expect(client.calls.find((call) => call.method === "ServiceWorker.startWorker"))
        .toEqual({
          method: "ServiceWorker.startWorker",
          parameters: { scopeURL: readinessScopeUrl },
          sessionId: pageSessionId,
        });
      expect(client.calls.find((call) => call.method === "Runtime.evaluate"))
        .toMatchObject({
          sessionId: workerSessionId,
          parameters: {
            awaitPromise: true,
            expression: "globalThis.__wrenchCheckGuard()",
            returnByValue: true,
          },
        });
      expect(client.calls.some((call) => call.method.includes("stop"))).toBeFalse();
      expect(client.workerTargetIds).toEqual([workerTargetId]);
    }
  });

  test("accepts one pre-existing worker, rejects duplicates, and polls a delayed worker", async () => {
    const existing = new FakeDnrCdpClient([workerTargetId]);
    await verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(existing),
    });
    expect(existing.calls.some((call) => call.method === "ServiceWorker.startWorker")).toBeTrue();

    const duplicate = new FakeDnrCdpClient([workerTargetId, secondWorkerTargetId]);
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(duplicate),
    })).rejects.toThrow("ambiguous");
    expect(duplicate.calls.map((call) => call.method)).toEqual(["Target.getTargets"]);
    expect(duplicate.closed).toBeTrue();

    const delayed = new FakeDnrCdpClient();
    delayed.workerListingsBeforeVisible = 1;
    const sleeps: number[] = [];
    await verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(delayed),
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([25]);
    expect(delayed.calls.filter((call) => call.method === "Target.getTargets")).toHaveLength(4);
  });

  test("fails closed for worker start drift or bounded startup timeout and detaches the page", async () => {
    const rejectedStart = new FakeDnrCdpClient();
    rejectedStart.startThrows = true;
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(rejectedStart),
    })).rejects.toThrow("private start failure");
    expect(rejectedStart.pageAttached).toBeFalse();
    expect(rejectedStart.calls.slice(-2).map((call) => call.method)).toEqual([
      "Target.detachFromTarget",
      "Target.getTargets",
    ]);

    for (const startResult of [{ started: true }, null, []]) {
      const client = new FakeDnrCdpClient();
      client.startResult = startResult;
      await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
        connect: () => Promise.resolve(client),
      })).rejects.toThrow("start response changed shape");
      expect(client.pageAttached).toBeFalse();
      expect(client.calls.slice(-2).map((call) => call.method)).toEqual([
        "Target.detachFromTarget",
        "Target.getTargets",
      ]);
    }

    const timedOut = new FakeDnrCdpClient();
    timedOut.startCreatesWorker = false;
    const times = [0, 0, 10_000];
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(timedOut),
      now: () => times.shift() ?? 10_000,
      sleep: () => Promise.resolve(),
    })).rejects.toThrow("did not become ready");
    expect(timedOut.pageAttached).toBeFalse();
    expect(timedOut.closed).toBeTrue();
  });

  test("fails closed when the exact worker vanishes or swaps after polling before attachment", async () => {
    for (const mutation of ["vanish", "swap"] as const) {
      const client = new FakeDnrCdpClient();
      client.workerMutationBeforeAttach = mutation;
      let failure: unknown = null;
      try {
        await verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
          connect: () => Promise.resolve(client),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toBe(
        "derivation guard readiness failed and cleanup stability could not be proved",
      );
      expect(message).not.toContain(workerTargetId);
      expect(message).not.toContain(secondWorkerTargetId);
      expect(message).not.toContain(readinessWorkerUrl);
      expect(client.pageAttached).toBeFalse();
      expect(client.workerAttached).toBeFalse();
      expect(client.calls.at(-1)?.method).toBe("Target.getTargets");
      expect(client.calls.filter((call) => (
        call.method === "Target.detachFromTarget"
        && call.parameters.sessionId === pageSessionId
      ))).toHaveLength(1);
      expect(client.closed).toBeTrue();
    }
  });

  test("detaches and performs final page proof after worker attach or Runtime.enable fails", async () => {
    const attachFailure = new FakeDnrCdpClient();
    attachFailure.workerAttachThrows = true;
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(attachFailure),
    })).rejects.toThrow("private CDP command failed");
    expect(attachFailure.pageAttached).toBeFalse();
    expect(attachFailure.workerAttached).toBeFalse();
    expect(attachFailure.calls.slice(-2).map((call) => call.method)).toEqual([
      "Target.detachFromTarget",
      "Target.getTargets",
    ]);

    const runtimeFailure = new FakeDnrCdpClient();
    runtimeFailure.runtimeEnableThrows = true;
    runtimeFailure.addPageOnListing = 2;
    let failure: unknown = null;
    try {
      await verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
        connect: () => Promise.resolve(runtimeFailure),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toBe(
      "derivation guard readiness failed and cleanup stability could not be proved",
    );
    expect(message).not.toContain("example.com");
    expect(message).not.toContain(readinessWorkerUrl);
    expect(runtimeFailure.workerAttached).toBeFalse();
    expect(runtimeFailure.pageAttached).toBeFalse();
    expect(runtimeFailure.calls.slice(-3).map((call) => call.method)).toEqual([
      "Target.detachFromTarget",
      "Target.detachFromTarget",
      "Target.getTargets",
    ]);
    expect(runtimeFailure.closed).toBeTrue();
  });

  test("rejects worker URL/type drift and every page ID or URL set change", async () => {
    for (const configure of [
      (client: FakeDnrCdpClient) => {
        client.workerUrl = `${extensionOrigin}/changed.js`;
      },
      (client: FakeDnrCdpClient) => {
        client.workerType = "page";
      },
      (client: FakeDnrCdpClient) => {
        client.driftPageOnListing = 1;
      },
      (client: FakeDnrCdpClient) => {
        client.addPageOnListing = 1;
      },
    ]) {
      const client = new FakeDnrCdpClient();
      configure(client);
      await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
        connect: () => Promise.resolve(client),
      })).rejects.toThrow();
      expect(client.pageAttached).toBeFalse();
      expect(client.closed).toBeTrue();
    }

    const finalDrift = new FakeDnrCdpClient();
    finalDrift.addPageOnListing = 2;
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(finalDrift),
    })).rejects.toThrow("page target set changed");

    const workerDied = new FakeDnrCdpClient();
    workerDied.removeWorkerAfterDetach = true;
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(workerDied),
    })).rejects.toThrow("worker target changed identity");
  });

  test("evaluation failure still strictly detaches both sessions and proves final targets", async () => {
    const failed = new FakeDnrCdpClient();
    failed.readinessOk = false;
    const times = [0, 0, 10_000];
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(failed),
      now: () => times.shift() ?? 10_000,
      sleep: () => Promise.reject(new Error("must not sleep past deadline")),
    })).rejects.toThrow("checks did not pass");
    expect(failed.pageAttached).toBeFalse();
    expect(failed.workerAttached).toBeFalse();
    expect(failed.calls.slice(-3).map((call) => call.method)).toEqual([
      "Target.detachFromTarget",
      "Target.detachFromTarget",
      "Target.getTargets",
    ]);

    const workerDetach = new FakeDnrCdpClient();
    workerDetach.workerDetachResult = { detached: true };
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(workerDetach),
    })).rejects.toThrow("worker detach response changed shape");
    expect(workerDetach.pageAttached).toBeFalse();

    const pageDetach = new FakeDnrCdpClient();
    pageDetach.pageDetachResult = { detached: true };
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(pageDetach),
    })).rejects.toThrow("page detach response changed shape");
    expect(pageDetach.workerAttached).toBeFalse();

    const stalePolicy = new FakeDnrCdpClient();
    stalePolicy.readinessPolicySha256 = derivationGuardReadinessPolicySha256(["stale.example"]);
    const staleTimes = [0, 0, 10_000];
    await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
      connect: () => Promise.resolve(stalePolicy),
      now: () => staleTimes.shift() ?? 10_000,
      sleep: () => Promise.resolve(),
    })).rejects.toThrow("readiness policy did not match");
    expect(derivationGuardReadinessCheckCount(["stale.example"]))
      .toBe(derivationGuardReadinessCheckCount(["example.com"]));
    expect(stalePolicy.workerAttached).toBeFalse();
    expect(stalePolicy.pageAttached).toBeFalse();

    for (const invalidPolicySha256 of [
      null,
      "A".repeat(64),
      "a".repeat(63),
      `${"a".repeat(63)}g`,
    ]) {
      const invalid = new FakeDnrCdpClient();
      invalid.readinessPolicySha256 = invalidPolicySha256;
      const invalidTimes = [0, 0, 10_000];
      await expect(verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
        connect: () => Promise.resolve(invalid),
        now: () => invalidTimes.shift() ?? 10_000,
        sleep: () => Promise.resolve(),
      })).rejects.toThrow("readiness policy did not match");
    }
  });

  test("strict target parsing is categorical and never exposes foreign target data", async () => {
    const malformed = new FakeDnrCdpClient();
    malformed.extraTargetField = true;
    let failure: unknown = null;
    try {
      await verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
        connect: () => Promise.resolve(malformed),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toBe("derivation guard target listing changed shape");
    expect(message).not.toContain("do-not-leak");
    expect(message).not.toContain("example.com");
    expect(malformed.calls.map((call) => call.method)).toEqual(["Target.getTargets"]);

    for (const evaluationResult of [
      { result: { description: "private-value", type: "object", value: {} } },
      { exceptionDetails: { text: "private-value" }, result: { type: "object", value: {} } },
      { result: { type: "object", value: {}, unexpected: "private-value" } },
    ]) {
      const client = new FakeDnrCdpClient();
      client.evaluationResult = evaluationResult;
      const times = [0, 0, 10_000];
      let evaluationFailure: unknown = null;
      try {
        await verifyDerivationDnrReadiness(cdpUrl, currentUrl, ["example.com"], {
          connect: () => Promise.resolve(client),
          now: () => times.shift() ?? 10_000,
          sleep: () => Promise.resolve(),
        });
      } catch (error) {
        evaluationFailure = error;
      }
      expect(evaluationFailure).toBeInstanceOf(Error);
      const evaluationMessage = evaluationFailure instanceof Error
        ? evaluationFailure.message
        : "";
      expect(evaluationMessage).toContain("changed shape");
      expect(evaluationMessage).not.toContain("private-value");
    }
  });
});
