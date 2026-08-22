import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readCachedCapability, revalidateCapability } from "./client";
import type { RevalidatedCapabilityCurrent } from "./client";

describe("public client process boundary", () => {
  test("exports the typed current SWR winner", () => {
    const current: RevalidatedCapabilityCurrent = {
      source: "live",
      output: { messages: [] },
    };
    expect(current.source).toBe("live");
  });

  test("rejects an invalid observation date without a freshness window", () => {
    expect(() => readCachedCapability({
      adapterId: "x",
      operationId: "messaging.list",
    }, {
      now: new Date(Number.NaN),
    })).toThrow("Wrench client observation time is invalid");
  });

  test("validates asynchronous CLI output and rejects account or execution-contract swaps", async () => {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "client-malformed-output.fixture.ts"),
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
        }, 2_000);
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

  test("invokes and validates one public capability without synthesizing --auth", async () => {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "client-public.fixture.ts"),
    ], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
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

  test("rejects accessors without executing them", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "cursor", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "drifted";
      },
    });

    expect(() => readCachedCapability({
      adapterId: "x",
      operationId: "messaging.list",
      input,
    })).toThrow("Wrench client request objects must contain only data properties");
    expect(getterCalls).toBe(0);
  });

  test("rejects option and environment indirection without executing it", () => {
    const request = {
      adapterId: "x",
      operationId: "messaging.list",
    } as const;
    let optionGetterCalls = 0;
    const accessorOptions: Record<string, unknown> = {};
    Object.defineProperty(accessorOptions, "environment", {
      enumerable: true,
      get() {
        optionGetterCalls += 1;
        return {};
      },
    });
    expect(() => readCachedCapability(
      request,
      accessorOptions as never,
    )).toThrow("Wrench client options must contain only data properties");
    expect(optionGetterCalls).toBe(0);

    let environmentGetterCalls = 0;
    const accessorEnvironment: Record<string, unknown> = {};
    Object.defineProperty(accessorEnvironment, "WRENCH_STATE_HOME", {
      enumerable: true,
      get() {
        environmentGetterCalls += 1;
        return "/tmp/unreachable";
      },
    });
    expect(() => readCachedCapability(request, {
      environment: accessorEnvironment as never,
    })).toThrow("Wrench client environment must contain only data properties");
    expect(environmentGetterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxiedEnvironment = new Proxy({}, {
      ownKeys() {
        proxyTrapCalls += 1;
        return [];
      },
    });
    expect(() => readCachedCapability(request, {
      environment: proxiedEnvironment,
    })).toThrow("Wrench client environment must use a plain, non-proxy object");
    expect(proxyTrapCalls).toBe(0);

    let optionsProxyTrapCalls = 0;
    const proxiedOptions = new Proxy({}, {
      getPrototypeOf() {
        optionsProxyTrapCalls += 1;
        return Object.prototype;
      },
    });
    expect(() => readCachedCapability(
      request,
      proxiedOptions,
    )).toThrow("Wrench client options must use a plain, non-proxy object");
    expect(optionsProxyTrapCalls).toBe(0);

    const unsupportedOptions: Record<string, unknown> = { unexpected: true };
    expect(() => readCachedCapability(
      request,
      unsupportedOptions as never,
    )).toThrow("Wrench client options contain an unsupported field");
    expect(() => readCachedCapability(
      request,
      { [Symbol("unexpected")]: true },
    )).toThrow("Wrench client options have unsupported symbol fields");
    const inheritedOptions: Record<string, unknown> = {};
    Object.setPrototypeOf(inheritedOptions, { environment: {} });
    expect(() => readCachedCapability(
      request,
      inheritedOptions as never,
    )).toThrow("Wrench client options must use a plain, non-proxy object");
  });

  test("rejects nested proxies and unbranded platform options before traps run", () => {
    const request = {
      adapterId: "x",
      operationId: "messaging.list",
    } as const;
    let proxyTrapCalls = 0;
    const trapHandler = <Target extends object>(): ProxyHandler<Target> => ({
      get() {
        proxyTrapCalls += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        return undefined;
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        return Object.prototype;
      },
      ownKeys() {
        proxyTrapCalls += 1;
        return [];
      },
    });
    const proxiedRequestTarget = { ...request };
    const proxiedRequest = new Proxy(
      proxiedRequestTarget,
      trapHandler<typeof proxiedRequestTarget>(),
    );
    expect(() => readCachedCapability(proxiedRequest)).toThrow(
      "Wrench client request must not contain proxies",
    );
    const proxiedInputTarget = { limit: 20 };
    const proxiedInput = new Proxy(
      proxiedInputTarget,
      trapHandler<typeof proxiedInputTarget>(),
    );
    expect(() => readCachedCapability({
      ...request,
      input: { query: proxiedInput },
    })).toThrow("Wrench client request must not contain proxies");

    const proxiedDate = new Proxy(
      new Date("2026-07-31T12:00:00.000Z"),
      trapHandler<Date>(),
    );
    expect(() => readCachedCapability(request, {
      now: proxiedDate,
    })).toThrow("Wrench client observation time is invalid");

    const controller = new AbortController();
    const proxiedSignal = new Proxy(
      controller.signal,
      trapHandler<AbortSignal>(),
    );
    expect(() => revalidateCapability(request, {
      signal: proxiedSignal,
    })).toThrow("Wrench client abort signal is malformed");
    expect(proxyTrapCalls).toBe(0);

    const fakeSignal = Object.create(AbortSignal.prototype) as AbortSignal;
    expect(() => revalidateCapability(request, {
      signal: fakeSignal,
    })).toThrow("Wrench client abort signal is malformed");
  });

  test("rejects values that do not have an exact JSON representation", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const customPrototype = Object.create({ inherited: true }) as Record<
      string,
      unknown
    >;
    customPrototype.value = "not-plain";

    const invalidInputs: readonly unknown[] = [
      undefined,
      new Date("2026-07-31T12:00:00.000Z"),
      new Map([["cursor", "one"]]),
      customPrototype,
      { nested: undefined },
      { nested: () => "value" },
      { nested: Number.NaN },
      circular,
      Array(1),
    ];
    for (const input of invalidInputs) {
      expect(() => readCachedCapability({
        adapterId: "x",
        operationId: "messaging.list",
        input,
      })).toThrow();
    }
  });
});
