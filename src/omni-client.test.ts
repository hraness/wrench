import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  readCachedOmniView,
  revalidateOmniView,
  type RevalidatedOmniViewCurrent,
} from "./omni-client";

const sourceRequest = {
  adapterId: "reddit-web",
  operationId: "messaging.list" as const,
  authId: "reddit-main",
};
const request = {
  schemaVersion: 1 as const,
  sources: [sourceRequest],
};

describe("public omni client boundary", () => {
  test("exports the dependency-free current-view union", () => {
    const current = {
      schemaVersion: 1,
      source: "omni-live",
      identity: {
        invocationDigest: "0".repeat(64),
        requestDigest: "a".repeat(64),
        sourceSetDigest: "b".repeat(64),
      },
      view: {
        schemaVersion: 1,
        viewRevision: "c".repeat(64),
        entities: [],
        nextCursor: null,
        sources: [],
      },
    } satisfies RevalidatedOmniViewCurrent;
    expect(current.source).toBe("omni-live");
  });

  test("rejects accessor, proxy, circular, and non-JSON requests without observation", () => {
    let getterCalls = 0;
    const accessorInput: Record<string, unknown> = {};
    Object.defineProperty(accessorInput, "cursor", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unreachable";
      },
    });
    expect(() => readCachedOmniView({
      ...request,
      sources: [{ ...sourceRequest, input: accessorInput }],
    })).toThrow("enumerable data property");
    expect(getterCalls).toBe(0);

    let arrayGetterCalls = 0;
    const accessorSources: unknown[] = [];
    Object.defineProperty(accessorSources, "0", {
      enumerable: true,
      configurable: true,
      get() {
        arrayGetterCalls += 1;
        return sourceRequest;
      },
    });
    accessorSources.length = 1;
    expect(() => readCachedOmniView({
      ...request,
      sources: accessorSources as never,
    })).toThrow("enumerable data property");
    expect(arrayGetterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxiedInput = new Proxy({}, {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        return Object.prototype;
      },
      ownKeys() {
        proxyTrapCalls += 1;
        return [];
      },
    });
    expect(() => readCachedOmniView({
      ...request,
      sources: [{ ...sourceRequest, input: proxiedInput }],
    })).toThrow("must not contain proxies");
    expect(proxyTrapCalls).toBe(0);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => readCachedOmniView({
      ...request,
      sources: [{ ...sourceRequest, input: circular }],
    })).toThrow("must not be circular");

    expect(() => readCachedOmniView({
      ...request,
      sources: [{ ...sourceRequest, input: { invalid: undefined } }],
    })).toThrow("must contain only JSON data");
  });

  test("rejects option and platform-object forgery without invoking traps", () => {
    let optionGetterCalls = 0;
    const accessorOptions: Record<string, unknown> = {};
    Object.defineProperty(accessorOptions, "environment", {
      enumerable: true,
      get() {
        optionGetterCalls += 1;
        return {};
      },
    });
    expect(() => readCachedOmniView(
      request,
      accessorOptions as never,
    )).toThrow("enumerable data property");
    expect(optionGetterCalls).toBe(0);

    let environmentTrapCalls = 0;
    const environment = new Proxy({}, {
      getPrototypeOf() {
        environmentTrapCalls += 1;
        return Object.prototype;
      },
      ownKeys() {
        environmentTrapCalls += 1;
        return [];
      },
    });
    expect(() => readCachedOmniView(request, { environment }))
      .toThrow("plain non-proxy object");
    expect(environmentTrapCalls).toBe(0);

    const fakeSignal = Object.create(AbortSignal.prototype) as AbortSignal;
    expect(() => revalidateOmniView(request, { signal: fakeSignal }))
      .toThrow("abort signal is malformed");
  });

  test("proves deferred SWR, strict child parsing, identity fencing, and abort", async () => {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "omni-client-malformed-output.fixture.ts"),
    ], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        deadline = setTimeout(() => {
          child.kill();
          resolve(-1);
        }, 10_000);
      }),
    ]);
    if (deadline !== undefined) clearTimeout(deadline);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});
