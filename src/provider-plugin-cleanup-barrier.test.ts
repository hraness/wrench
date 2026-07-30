import { describe, expect, test } from "bun:test";

import {
  PortableProviderPluginCleanupUnverifiedError,
  registerPortableProviderPluginCleanupBarrier,
  settlePortableProviderPluginCleanup,
  trackPortableProviderPluginHostCompletion,
} from "./provider-plugin-cleanup-barrier";

describe("portable provider plugin cleanup barriers", () => {
  test("keeps an ordinary execution error distinct from verified cleanup", async () => {
    const executionError = new Error("ordinary plugin failure");
    const outcome = await settlePortableProviderPluginCleanup(() => {
      const cleanup = registerPortableProviderPluginCleanupBarrier();
      cleanup.verified();
      return Promise.reject(executionError);
    });

    expect(outcome).toEqual({
      status: "rejected",
      reason: executionError,
    });
  });

  test("joins host completion after the operation has already terminalized", async () => {
    let finishHost: (() => void) | undefined;
    const host = new Promise<void>((resolve) => {
      finishHost = resolve;
    });
    let joined = false;
    const cleanup = settlePortableProviderPluginCleanup(() => {
      void trackPortableProviderPluginHostCompletion(host);
      return Promise.resolve("terminal");
    }).then((outcome) => {
      joined = true;
      return outcome;
    });

    await Promise.resolve();
    expect(joined).toBeFalse();
    finishHost?.();
    expect(await cleanup).toEqual({
      status: "fulfilled",
      value: "terminal",
    });
  });

  test("persists cleanup completion only after every barrier joins", async () => {
    let finishCleanup: (() => void) | undefined;
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const events: string[] = [];
    const cleanup = settlePortableProviderPluginCleanup(
      () => {
        void trackPortableProviderPluginHostCompletion(pendingCleanup);
        events.push("operation");
        return Promise.resolve("terminal");
      },
      {
        cleanupComplete: () => {
          events.push("complete");
        },
      },
    );

    await Promise.resolve();
    expect(events).toEqual(["operation"]);
    finishCleanup?.();
    expect(await cleanup).toEqual({
      status: "fulfilled",
      value: "terminal",
    });
    expect(events).toEqual(["operation", "complete"]);
  });

  test("rejects unsafe cleanup instead of reporting quiescence", async () => {
    let completed = false;
    const cleanup = settlePortableProviderPluginCleanup(
      () => {
        registerPortableProviderPluginCleanupBarrier().unsafe(
          new Error("unsafe cleanup fixture"),
        );
        return Promise.resolve("must-not-be-quiescent");
      },
      {
        cleanupComplete: () => {
          completed = true;
        },
      },
    );

    let error: unknown;
    try {
      await cleanup;
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(
      PortableProviderPluginCleanupUnverifiedError,
    );
    expect(completed).toBeFalse();
  });

  test("joins an un-awaited nested cleanup scope into its parent", async () => {
    let finishNested: (() => void) | undefined;
    const nestedHost = new Promise<void>((resolve) => {
      finishNested = resolve;
    });
    let parentSettled = false;
    const parent = settlePortableProviderPluginCleanup(() => {
      void settlePortableProviderPluginCleanup(async () => {
        await trackPortableProviderPluginHostCompletion(nestedHost);
        return "nested";
      });
      return Promise.resolve("parent");
    }).then((outcome) => {
      parentSettled = true;
      return outcome;
    });

    await Promise.resolve();
    expect(parentSettled).toBeFalse();
    finishNested?.();
    expect(await parent).toEqual({
      status: "fulfilled",
      value: "parent",
    });
  });

  test("rejects delayed cleanup registration before a resource can start", async () => {
    let attemptedResolve: (() => void) | undefined;
    const attempted = new Promise<void>((resolve) => {
      attemptedResolve = resolve;
    });
    const outcome = await settlePortableProviderPluginCleanup(() => {
      setTimeout(() => {
        expect(() =>
          registerPortableProviderPluginCleanupBarrier()
        ).toThrow("operation scope closed");
        attemptedResolve?.();
      }, 0);
      return Promise.resolve("terminal");
    });

    expect(outcome).toEqual({
      status: "fulfilled",
      value: "terminal",
    });
    await attempted;
  });
});
