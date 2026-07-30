import { describe, expect, test } from "bun:test";

import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "./operation-deadline";

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

  pendingTimers(): number {
    return this.#scheduled.size;
  }
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

describe("operation deadline", () => {
  test("tracks one monotonic budget and cancels its timer on disposal", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(1_000, { clock });

    expect(deadline.remainingTimeMs()).toBe(1_000);
    clock.advance(400);
    expect(deadline.remainingTimeMs()).toBe(600);
    expect(await deadline.run(() => Promise.resolve("done"))).toBe("done");
    expect(clock.pendingTimers()).toBe(1);

    deadline.dispose();
    expect(clock.pendingTimers()).toBe(0);
    expect(deadline.signal.aborted).toBeTrue();
    expect(() => deadline.throwIfUnavailable()).toThrow("deadline is no longer active");
  });

  test("uses one absolute cutoff across work instead of resetting per call", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(100, { clock });
    let calls = 0;

    expect(await deadline.run(() => {
      calls += 1;
      clock.advance(60);
      return Promise.resolve("first");
    })).toBe("first");
    expect(deadline.remainingTimeMs()).toBe(40);

    expect(await rejectionMessage(deadline.run(() => {
      calls += 1;
      clock.advance(40);
      return Promise.resolve("second");
    }))).toContain("timed out");
    expect(await rejectionMessage(deadline.run(() => {
      calls += 1;
      return Promise.resolve("must-not-run");
    }))).toContain("timed out");

    expect(calls).toBe(2);
    expect(clock.pendingTimers()).toBe(0);
    deadline.dispose();
  });

  test("combines caller cancellation without retaining its reason or timer", async () => {
    const clock = new FakeMonotonicClock();
    const caller = new AbortController();
    const deadline = new OperationDeadline(5_000, {
      clock,
      signal: caller.signal,
    });
    const blocked = deadline.run(
      () => new Promise<string>(() => undefined),
      "provider operation",
    );

    caller.abort("private caller reason");

    const message = await rejectionMessage(blocked);
    expect(message).toContain("provider operation was cancelled");
    expect(message).not.toContain("private caller reason");
    expect(clock.pendingTimers()).toBe(0);
    deadline.dispose();
  });

  test("never invokes work for an already-aborted caller or expired budget", async () => {
    const clock = new FakeMonotonicClock();
    const caller = new AbortController();
    caller.abort();
    const cancelled = new OperationDeadline(1_000, {
      clock,
      signal: caller.signal,
    });
    let calls = 0;
    expect(await rejectionMessage(cancelled.run(() => {
      calls += 1;
      return Promise.resolve();
    }))).toContain("cancelled");
    expect(calls).toBe(0);

    const expired = new OperationDeadline(10, { clock });
    clock.advance(10);
    expect(await rejectionMessage(expired.run(() => {
      calls += 1;
      return Promise.resolve();
    }))).toContain("timed out");
    expect(calls).toBe(0);
  });
});
