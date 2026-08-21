import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { BrowserSession, CreateBrowserSessionOptions, createBrowserSession } from "../browser";
import type { WrenchManifest } from "../model";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "../operation-deadline";
import {
  generateXClientTransactionId,
  parseXTransactionRuntimeIds,
} from "./x-transaction-id";

const MAIN_URL = "https://abs.twimg.com/responsive-web/client-web/main.9929b02a.js";
const MUTATION_PATH = "/i/api/graphql/WXTdKnLddrQOunD6MhWi3g/CreateTweet";
const TRANSACTION_ID = "synthetic_transaction_id_0123456789";
const MAIN_BUNDLE = [
  "previousModule()},991160(e,t,r){\"use strict\";let cached;r.d(t,{Ay:()=>l,_E:()=>s,kc:()=>a});",
  "cached=cached||new Promise(done=>{r.e(59924).then(r.bind(r,208932)).then(module=>done(module.default()))});",
  "feature.isTrue(\"rweb_client_transaction_id_enabled\")&&",
  "(request.headers[\"x-client-transaction-id\"]=await a(request.host,request.path,request.method))}",
].join("");

const cookieAuth = {
  schemaVersion: 1,
  id: "x-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: "123456789012345678",
} as const satisfies WrenchAuth;

class FakeMonotonicClock implements OperationDeadlineClock {
  #nowMs = 0;
  #nextId = 1;
  readonly #scheduled = new Map<number, {
    readonly at: number;
    readonly callback: () => void;
  }>();

  readonly now = (): number => this.#nowMs;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#scheduled.set(id, { at: this.#nowMs + delayMs, callback });
    return () => {
      this.#scheduled.delete(id);
    };
  };

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, value]) => value.at <= this.#nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }
}

type FakeBrowserOptions = {
  readonly currentUrl?: string;
  readonly evaluationValue?: unknown;
  readonly failEvaluation?: boolean;
  readonly closeFailure?: boolean;
  readonly cleanupFailure?: boolean;
};

function fakeBrowser(options: FakeBrowserOptions = {}): {
  readonly createSession: typeof createBrowserSession;
  readonly commands: (readonly string[])[];
  readonly batchTimeouts: number[];
  readonly lifecycle: { created: number; closed: number; cleaned: number; evaluations: number };
  readonly creation: {
    manifest: WrenchManifest | null;
    auth: WrenchAuth | null;
    options: CreateBrowserSessionOptions | null;
  };
} {
  const commands: (readonly string[])[] = [];
  const batchTimeouts: number[] = [];
  const lifecycle = { created: 0, closed: 0, cleaned: 0, evaluations: 0 };
  const creation: {
    manifest: WrenchManifest | null;
    auth: WrenchAuth | null;
    options: CreateBrowserSessionOptions | null;
  } = { manifest: null, auth: null, options: null };
  const createSession: typeof createBrowserSession = (manifest, auth, sessionOptions) => {
    lifecycle.created += 1;
    creation.manifest = manifest;
    creation.auth = auth;
    creation.options = sessionOptions;
    const session: BrowserSession = {
      runBatch: (batch, timeoutMs) => {
        expect(batch).toHaveLength(1);
        const command = batch[0];
        if (command === undefined) throw new Error("missing fake browser command");
        commands.push([...command]);
        batchTimeouts.push(timeoutMs);
        if (command[0] === "get" && command[1] === "url") {
          return Promise.resolve([{
            success: true,
            data: { url: options.currentUrl ?? "https://x.com/home" },
          }]);
        }
        if (command[0] === "eval") {
          lifecycle.evaluations += 1;
          if (options.failEvaluation === true) throw new Error("synthetic transaction evaluation failure");
          return Promise.resolve([{
            success: true,
            data: {
              origin: "https://x.com/",
              result: options.evaluationValue ?? TRANSACTION_ID,
            },
          }]);
        }
        return Promise.resolve([{ success: true, data: null }]);
      },
      close: () => {
        lifecycle.closed += 1;
        return options.closeFailure === true
          ? Promise.reject(new Error("synthetic close failure"))
          : Promise.resolve();
      },
      cleanup: () => {
        lifecycle.cleaned += 1;
        return options.cleanupFailure === true
          ? Promise.reject(new Error("synthetic cleanup failure"))
          : Promise.resolve();
      },
    };
    return Promise.resolve(session);
  };
  return { createSession, commands, batchTimeouts, lifecycle, creation };
}

function generate(fake: ReturnType<typeof fakeBrowser>, overrides: Partial<{
  readonly auth: WrenchAuth;
  readonly mainBundleText: string;
  readonly mainBundleUrl: string;
  readonly method: "POST";
  readonly path: string;
  readonly operationDeadline: OperationDeadline;
}> = {}): Promise<string> {
  return generateXClientTransactionId({
    auth: overrides.auth ?? cookieAuth,
    mainBundleText: overrides.mainBundleText ?? MAIN_BUNDLE,
    mainBundleUrl: overrides.mainBundleUrl ?? MAIN_URL,
    method: overrides.method ?? "POST",
    path: overrides.path ?? MUTATION_PATH,
    timeoutMs: 1_000,
    maxOutputBytes: 2 * 1024 * 1024,
    ...(overrides.operationDeadline === undefined
      ? {}
      : { operationDeadline: overrides.operationDeadline }),
    dependencies: { createBrowserSession: fake.createSession },
  });
}

async function rejectionMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected action to reject");
}

describe("X client transaction runtime discovery", () => {
  test("parses the unique current lazy chunk and module IDs", () => {
    expect(parseXTransactionRuntimeIds(MAIN_BUNDLE)).toEqual({
      wrapperModuleId: 991_160,
      exportName: "kc",
      chunkId: 59_924,
      moduleId: 208_932,
    });
  });

  test("fails closed on wrapper, binding, or module-ID drift", () => {
    expect(() => parseXTransactionRuntimeIds("const unrelated=true")).toThrow("one unique current wrapper");
    expect(() => parseXTransactionRuntimeIds(`${MAIN_BUNDLE}${MAIN_BUNDLE}`)).toThrow("one unique current wrapper");
    expect(() => parseXTransactionRuntimeIds(MAIN_BUNDLE.replace("r.e(59924)", "r.e(0)"))).toThrow(
      "one unique lazy runtime binding",
    );
    expect(() => parseXTransactionRuntimeIds(MAIN_BUNDLE.replace(
      "feature.isTrue",
      "r.e(12345).then(r.bind(r,67890));feature.isTrue",
    ))).toThrow("one unique lazy runtime binding");
    expect(() => parseXTransactionRuntimeIds(MAIN_BUNDLE.replace("x-client-transaction-id", "other-header"))).toThrow(
      "omitted its reviewed request header",
    );
  });
});

describe("X client transaction browser bootstrap", () => {
  test("runs one fixed code-owned evaluation in a contained private session", async () => {
    const fake = fakeBrowser();
    expect(await generate(fake)).toBe(TRANSACTION_ID);

    expect(fake.creation.manifest).toMatchObject({
      origins: ["https://x.com"],
      browserDomains: ["x.com", "*.x.com", "abs.twimg.com"],
      operations: {},
    });
    expect(fake.creation.auth).toEqual(cookieAuth);
    expect(fake.creation.options).toMatchObject({
      headed: false,
      timeoutMs: 1_000,
      allowCodeOwnedEvaluation: true,
      maxOutputBytes: 64 * 1024,
    });
    expect(fake.batchTimeouts).toEqual([1_000, 1_000, 1_000]);
    expect(fake.commands[0]).toEqual(["open", "https://x.com/home"]);
    expect(fake.commands[1]).toEqual(["get", "url"]);
    expect(fake.commands[2]?.[0]).toBe("eval");
    const source = fake.commands[2]?.[1] ?? "";
    expect(source).toContain('"method":"POST"');
    expect(source).toContain(`"path":"${MUTATION_PATH}"`);
    expect(source).toContain('"mainBundlePath":"/responsive-web/client-web/main.9929b02a.js"');
    expect(source).toContain("https://abs.twimg.com");
    expect(source).toContain("listedMains");
    expect(source).toContain("text/html");
    expect(source).toContain("X webpack runtime is unavailable");
    expect(source).not.toContain("https://x.com/robots.txt");
    expect(source).toContain('"wrapperModuleId":991160');
    expect(source).toContain('"exportName":"kc"');
    expect(source).toContain('"chunkId":59924');
    expect(source).toContain('"moduleId":208932');
    expect(source).toContain("webpackChunk_twitter_responsive_web");
    expect(fake.lifecycle).toEqual({ created: 1, closed: 1, cleaned: 1, evaluations: 1 });
  });

  test("does not create a browser for a pre-aborted shared operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const operationDeadline = new OperationDeadline(1_000, {
      signal: controller.signal,
    });
    const fake = fakeBrowser();
    try {
      expect(await rejectionMessage(generate(fake, { operationDeadline }))).toContain("was cancelled");
      expect(fake.lifecycle).toEqual({ created: 0, closed: 0, cleaned: 0, evaluations: 0 });
      expect(fake.commands).toEqual([]);
    } finally {
      operationDeadline.dispose();
    }
  });

  test("stops before a later browser batch when the shared budget expires mid-sequence", async () => {
    const clock = new FakeMonotonicClock();
    const operationDeadline = new OperationDeadline(100, { clock });
    const commands: string[] = [];
    const batchTimeouts: number[] = [];
    const lifecycle = { closed: 0, cleaned: 0 };
    let markBlockedBatchStarted: (() => void) | undefined;
    const blockedBatchStarted = new Promise<void>((resolve) => {
      markBlockedBatchStarted = resolve;
    });
    let releaseBlockedBatch: (() => void) | undefined;
    const blockedBatch = new Promise<readonly Record<string, unknown>[]>(
      (resolve) => {
        releaseBlockedBatch = () => resolve([{
          success: true,
          data: { url: "https://x.com/home" },
        }]);
      },
    );
    const createSession: typeof createBrowserSession = (_manifest, _auth, options) => {
      expect(options.timeoutMs).toBe(100);
      expect(options.operationDeadline).toBe(operationDeadline);
      clock.advance(20);
      const session: BrowserSession = {
        runBatch: (batch, timeoutMs) => {
          const command = batch[0]?.[0];
          if (batch.length !== 1 || command === undefined) {
            throw new Error("unexpected transaction browser batch");
          }
          commands.push(command);
          batchTimeouts.push(timeoutMs);
          if (command === "open") {
            clock.advance(30);
            return Promise.resolve([{ success: true, data: null }]);
          }
          if (command === "get") {
            markBlockedBatchStarted?.();
            return blockedBatch;
          }
          throw new Error(`unexpected browser command ${command}`);
        },
        close: () => {
          lifecycle.closed += 1;
          return Promise.resolve();
        },
        cleanup: () => {
          lifecycle.cleaned += 1;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    };
    const operation = generateXClientTransactionId({
      auth: cookieAuth,
      mainBundleText: MAIN_BUNDLE,
      mainBundleUrl: MAIN_URL,
      method: "POST",
      path: MUTATION_PATH,
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      operationDeadline,
      dependencies: { createBrowserSession: createSession },
    });
    try {
      await blockedBatchStarted;
      clock.advance(50);
      await Promise.resolve();
      expect(commands).toEqual(["open", "get"]);
      expect(batchTimeouts).toEqual([80, 50]);
      expect(lifecycle).toEqual({ closed: 0, cleaned: 0 });
      releaseBlockedBatch?.();
      expect(await rejectionMessage(operation)).toContain("timed out");
      expect(lifecycle).toEqual({ closed: 1, cleaned: 1 });
    } finally {
      operationDeadline.dispose();
    }
  });

  test("finalizes a browser that resolves after the shared creation race", async () => {
    const clock = new FakeMonotonicClock();
    const operationDeadline = new OperationDeadline(100, { clock });
    const lifecycle = { created: 0, closed: 0, cleaned: 0, batches: 0 };
    let resolveCreation: ((session: BrowserSession) => void) | undefined;
    const pendingCreation = new Promise<BrowserSession>((resolve) => {
      resolveCreation = resolve;
    });
    const session: BrowserSession = {
      runBatch: () => {
        lifecycle.batches += 1;
        return Promise.resolve([]);
      },
      close: () => {
        lifecycle.closed += 1;
        return Promise.resolve();
      },
      cleanup: () => {
        lifecycle.cleaned += 1;
        return Promise.resolve();
      },
    };
    const createSession: typeof createBrowserSession = () => {
      lifecycle.created += 1;
      return pendingCreation;
    };
    const operation = generateXClientTransactionId({
      auth: cookieAuth,
      mainBundleText: MAIN_BUNDLE,
      mainBundleUrl: MAIN_URL,
      method: "POST",
      path: MUTATION_PATH,
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      operationDeadline,
      dependencies: { createBrowserSession: createSession },
    });
    try {
      await Promise.resolve();
      expect(lifecycle.created).toBe(1);
      clock.advance(100);
      expect(await rejectionMessage(operation)).toContain("timed out");
      resolveCreation?.(session);
      await Promise.resolve();
      await Promise.resolve();
      expect(lifecycle).toEqual({ created: 1, closed: 1, cleaned: 1, batches: 0 });
    } finally {
      operationDeadline.dispose();
    }
  });

  test("converts a hybrid profile to target-filtered cookie auth", async () => {
    const fake = fakeBrowser();
    const auth: WrenchAuth = {
      schemaVersion: 1,
      id: "x-hybrid",
      kind: "browser-profile",
      profile: "/private/profile",
      trustUnfilteredEgress: true,
      cookieSource: "arc",
      cookieProfile: "Profile 2",
      subject: "123",
    };
    await generate(fake, { auth });
    expect(fake.creation.auth).toEqual({
      schemaVersion: 1,
      id: "x-hybrid",
      kind: "cookie-source",
      source: "arc",
      profile: "Profile 2",
      subject: "123",
    });
  });

  test("rejects unsupported auth, method, path, and asset origin before launch", async () => {
    const unsupportedAuth: WrenchAuth = {
      schemaVersion: 1,
      id: "profile-only",
      kind: "browser-profile",
      profile: "/private/profile",
      trustUnfilteredEgress: true,
    };
    for (const action of [
      generate(fakeBrowser(), { auth: unsupportedAuth }),
      generate(fakeBrowser(), { method: "GET" as unknown as "POST" }),
      generate(fakeBrowser(), { path: "/i/api/graphql/id/CreateTweet?escape=true" }),
      generate(fakeBrowser(), { mainBundleUrl: "https://evil.example/main.9929b02a.js" }),
    ]) expect(await rejectionMessage(action)).not.toBe("");
  });

  test("cleans up after origin drift, invalid output, and evaluation failure without retrying", async () => {
    const cases = [
      fakeBrowser({ currentUrl: "https://twitter.com/home" }),
      fakeBrowser({ evaluationValue: "bad" }),
      fakeBrowser({ failEvaluation: true }),
    ];
    for (const fake of cases) {
      expect(await rejectionMessage(generate(fake))).not.toBe("");
      expect(fake.lifecycle.created).toBe(1);
      expect(fake.lifecycle.closed).toBe(1);
      expect(fake.lifecycle.cleaned).toBe(1);
      expect(fake.lifecycle.evaluations).toBeLessThanOrEqual(1);
    }
    expect(cases[2]!.lifecycle.evaluations).toBe(1);
  });

  test("fails closed when close or cleanup cannot be verified", async () => {
    for (const fake of [
      fakeBrowser({ closeFailure: true }),
      fakeBrowser({ cleanupFailure: true }),
    ]) {
      expect(await rejectionMessage(generate(fake))).toContain("private artifacts were preserved");
      expect(fake.lifecycle).toEqual({ created: 1, closed: 1, cleaned: 1, evaluations: 1 });
    }
  });
});
