import { describe, expect, test } from "bun:test";

import type { WebSessionRecipe } from "./model";
import type { OperationDeadlineClock } from "./operation-deadline";
import {
  WEB_SESSION_CLEANUP_JOIN_TIMEOUT_MS,
} from "./web-session-execution";
import {
  requireValidWebSessionOperationInput,
  runWebSessionOperationWithDeadline,
  startWebSessionCleanupTrackedOperation,
  type WebSessionExecutionOptions,
} from "./web-session";

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
        .sort((left, right) =>
          left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }

  pendingTimers(): number {
    return this.#scheduled.size;
  }
}

const recipe = {
  site: "x",
  action: "posts.read",
  contractVersion: 1,
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
} as const satisfies WebSessionRecipe;

async function rejectionMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

describe("web-session plugin execution boundary", () => {
  test("enforces plugin-owned conditional input validation", () => {
    const operation = {
      validateInput: (input: Readonly<Record<string, unknown>>) =>
        input.channel === "verified"
          ? []
          : ["channel must be verified for this provider"],
    };

    expect(() => requireValidWebSessionOperationInput(
      operation,
      { channel: "verified" },
    )).not.toThrow();
    expect(() => requireValidWebSessionOperationInput(
      operation,
      { channel: "unverified" },
    )).toThrow("channel must be verified for this provider");
  });

  test("rejects a pre-aborted caller before invoking the runtime hook", async () => {
    const caller = new AbortController();
    caller.abort("private cancellation reason");
    let calls = 0;
    const message = await rejectionMessage(
      runWebSessionOperationWithDeadline(
        recipe,
        { signal: caller.signal },
        () => {
          calls += 1;
          return Promise.resolve("must-not-run");
        },
      ),
    );

    expect(calls).toBe(0);
    expect(message).toContain("was cancelled");
    expect(message).not.toContain("private cancellation reason");
  });

  test("bounds an uncooperative hook and rejects its late dispatch callback", async () => {
    const clock = new FakeMonotonicClock();
    const captured: { options?: WebSessionExecutionOptions } = {};
    let durableCallbacks = 0;
    const execution = runWebSessionOperationWithDeadline(
      recipe,
      {
        deadlineClock: clock,
        beforeDispatch: () => {
          durableCallbacks += 1;
          return Promise.resolve();
        },
        afterProviderBoundMutationTarget: () => {
          durableCallbacks += 1;
          return Promise.resolve();
        },
      },
      (options) => {
        captured.options = options;
        return new Promise<never>(() => undefined);
      },
    );

    clock.advance(recipe.timeoutMs);
    expect(await rejectionMessage(execution)).toContain("timed out");
    const callback = captured.options?.beforeDispatch;
    if (callback === undefined) {
      throw new Error("bounded hook did not receive its dispatch callback");
    }
    expect(await rejectionMessage(callback({
      id: "late",
      index: 1,
      progress: { planned: 1, started: 0, verified: 0 },
    }))).toContain("timed out");
    const targetCallback = captured.options?.afterProviderBoundMutationTarget;
    if (targetCallback === undefined) {
      throw new Error("bounded hook did not receive its provider-bound target callback");
    }
    expect(await rejectionMessage(targetCallback({
      id: "late",
      index: 1,
      target: { schemaVersion: 1, identifier: "private:late-target" },
    }))).toContain("timed out");
    const registerCleanupBarrier = captured.options?.registerCleanupBarrier;
    if (registerCleanupBarrier === undefined) {
      throw new Error("bounded hook did not receive its cleanup registrar");
    }
    let starts = 0;
    expect(() => startWebSessionCleanupTrackedOperation(
      registerCleanupBarrier,
      () => {
        starts += 1;
        return Promise.resolve("must-not-start");
      },
      (operation) => operation.then(() => undefined),
    )).toThrow("cleanup registration is already closed");
    expect(starts).toBe(0);
    expect(durableCallbacks).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("joins bounded browser cleanup and normalizes an unsafe teardown after timeout", async () => {
    const clock = new FakeMonotonicClock();
    let rejectCleanup: ((error: Error) => void) | undefined;
    const cleanup = new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject;
    });
    const execution = runWebSessionOperationWithDeadline(
      recipe,
      { deadlineClock: clock },
      (options) => {
        options.registerCleanupBarrier?.(cleanup);
        return new Promise<never>(() => undefined);
      },
    );
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    clock.advance(recipe.timeoutMs);
    await Promise.resolve();
    expect(settled).toBeFalse();

    rejectCleanup?.(new Error("private raw cleanup detail"));
    const message = await rejectionMessage(execution);
    expect(message).toContain("cleanup could not be verified");
    expect(message).not.toContain("private raw cleanup detail");
    expect(settled).toBeTrue();
    expect(clock.pendingTimers()).toBe(0);
  });

  test("bounds a permanently pending cleanup barrier and propagates cleanup-unsafe state", async () => {
    const clock = new FakeMonotonicClock();
    const cleanup = new Promise<void>(() => undefined);
    let kernelBarrier: Promise<void> | undefined;
    const execution = runWebSessionOperationWithDeadline(
      recipe,
      {
        deadlineClock: clock,
        registerCleanupBarrier: (barrier) => {
          kernelBarrier = barrier;
        },
      },
      (options) => {
        options.registerCleanupBarrier?.(cleanup);
        return new Promise<never>(() => undefined);
      },
    );

    clock.advance(recipe.timeoutMs);
    for (let turns = 0; turns < 10 && clock.pendingTimers() === 0; turns += 1) {
      await Promise.resolve();
    }
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(WEB_SESSION_CLEANUP_JOIN_TIMEOUT_MS);

    const message = await rejectionMessage(execution);
    expect(message).toContain("cleanup could not be verified");
    expect(message).toContain("retry is unsafe");
    if (kernelBarrier === undefined) {
      throw new Error("kernel did not receive the bounded cleanup barrier");
    }
    expect(await rejectionMessage(kernelBarrier)).toBe(message);
    expect(clock.pendingTimers()).toBe(0);
  });
});
