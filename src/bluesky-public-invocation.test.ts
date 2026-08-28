import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCachedPreparedCapability,
  revalidatePreparedCapability,
} from "./read-client";
import { providerPluginRegistry } from "./provider-plugins";
import {
  createReadProjectionQueryForInvocation,
  executeReadInvocation,
  prepareInvocation,
  readRunReceipt,
} from "./runtime";
import { WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY } from "./web-session-cleanup-admission";
import {
  isPublicWebSessionInvocationAuthority,
  publicWebSessionAuthorityIdentityHash,
} from "./web-session-authentication-policy";
import type { WrenchManifest } from "./model";
import { installManifest } from "./storage";

function state(
  manifestFile = "wrench-web-adapter.json",
  onlyOperation?: string,
): {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const directory = mkdtempSync(join(tmpdir(), "wrench-public-bluesky-"));
  const environment = { WRENCH_STATE_HOME: directory } as const;
  let manifest = JSON.parse(readFileSync(join(
    import.meta.dir,
    "assets",
    "adapters",
    "bluesky",
    manifestFile,
  ), "utf8")) as WrenchManifest;
  if (onlyOperation !== undefined) {
    const operation = manifest.operations[onlyOperation];
    if (operation === undefined) {
      throw new Error(`Bluesky fixture operation ${onlyOperation} is unavailable`);
    }
    // v1.4 also carries the intentionally retired media.publish@1 route. The
    // exact profiles.read projection remains useful for proving its own v1
    // authentication policy without making that retired mutation executable.
    manifest = { ...manifest, operations: { [onlyOperation]: operation } };
  }
  installManifest(manifest, {
    force: false,
    environment,
    registry: providerPluginRegistry,
  });
  return { directory, environment };
}

describe("Bluesky public invocation authority", () => {
  test("prepares only the reviewed descriptor without reading an auth locator", () => {
    const selected = state();
    try {
      const invocation = prepareInvocation(
        "bluesky-web",
        "profiles.read",
        { handle: "hraness.bsky.social" },
        undefined,
        selected.environment,
        providerPluginRegistry,
      );
      expect(isPublicWebSessionInvocationAuthority(invocation.auth)).toBeTrue();
      if (!isPublicWebSessionInvocationAuthority(invocation.auth)) {
        throw new Error("expected public authority");
      }
      expect(invocation.readProjectionAuthIdentityHash).toBe(
        publicWebSessionAuthorityIdentityHash(invocation.auth),
      );
      const query = createReadProjectionQueryForInvocation(
        invocation,
        selected.environment,
        providerPluginRegistry,
      );
      expect(query.identity).toMatchObject({
        adapter: { id: "bluesky-web", version: "1.7.0" },
        operation: "profiles.read",
        input: { handle: "hraness.bsky.social" },
        auth: {
          id: invocation.auth.id,
          kind: "public-web-session",
          hash: invocation.readProjectionAuthIdentityHash,
          subject: "public:bluesky-web:profiles.read",
        },
        contract: { transport: "web-session-api" },
      });
      expect(() => prepareInvocation(
        "bluesky-web",
        "profiles.read",
        { handle: "hraness.bsky.social" },
        "bluesky-main",
        selected.environment,
        providerPluginRegistry,
      )).toThrow("is public and does not accept an auth locator");
      expect(() => prepareInvocation(
        "bluesky-web",
        "feeds.read",
        { feed: "home" },
        undefined,
        selected.environment,
        providerPluginRegistry,
      )).toThrow("auth locator bluesky-web was not found");
    } finally {
      rmSync(selected.directory, { recursive: true, force: true });
    }
  });

  test("keeps the archived profiles.read v1 route on authenticated semantics", () => {
    const selected = state("wrench-web-adapter.v1.4.0.json", "profiles.read");
    try {
      expect(() => prepareInvocation(
        "bluesky-web",
        "profiles.read",
        { handle: "hraness.bsky.social" },
        undefined,
        selected.environment,
        providerPluginRegistry,
      )).toThrow("auth locator bluesky-web was not found");
    } finally {
      rmSync(selected.directory, { recursive: true, force: true });
    }
  });

  test("executes through the public hook without durable auth-realm cleanup admission and validates its receipt", async () => {
    const selected = state();
    try {
      const invocation = prepareInvocation(
        "bluesky-web",
        "profiles.read",
        { handle: "hraness.bsky.social" },
        undefined,
        selected.environment,
        providerPluginRegistry,
      );
      let publicExecutions = 0;
      const result = await executeReadInvocation(invocation, {
        headed: false,
        environment: selected.environment,
        registry: providerPluginRegistry,
        executeWebSession: () => {
          throw new Error("authenticated executor must not run");
        },
        executePublicWebSession: (_manifest, recipe, input, options) => {
          publicExecutions += 1;
          expect(recipe).toMatchObject({
            site: "bluesky",
            action: "profiles.read",
            contractVersion: 2,
          });
          expect(input).toEqual({ handle: "hraness.bsky.social" });
          expect(typeof options.registerCleanupBarrier).toBe("function");
          return Promise.resolve({
            status: "succeeded",
            output: { metrics: { followers: { value: 52 } } },
            finalUrl: "https://bsky.app/profile/hraness.bsky.social",
            dispatchStarted: false,
            dispatch: { planned: 0, started: 0, verified: 0 },
          });
        },
      });
      expect(publicExecutions).toBe(1);
      expect(result.receipt.auth).toMatchObject({
        id: invocation.auth.id,
        kind: "public-web-session",
      });
      expect(result.receipt.status).toBe("succeeded");
      expect(readRunReceipt(
        result.receipt.runId,
        selected.environment,
      )).toEqual(result.receipt);
      const receiptPath = join(
        selected.directory,
        "runs",
        `${result.receipt.runId}.json`,
      );
      const stored = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        auth: Record<string, unknown>;
      };
      writeFileSync(receiptPath, `${JSON.stringify({
        ...stored,
        auth: { ...stored.auth, id: "public-tampered" },
      })}\n`);
      expect(() => readRunReceipt(
        result.receipt.runId,
        selected.environment,
      )).toThrow("public invocation authority is malformed");
      expect(existsSync(join(
        selected.directory,
        WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
      ))).toBeFalse();
    } finally {
      rmSync(selected.directory, { recursive: true, force: true });
    }
  });

  test("publishes and serves exact R1 cache data without an auth incarnation", async () => {
    const selected = state();
    try {
      const invocation = prepareInvocation(
        "bluesky-web",
        "profiles.read",
        { handle: "hraness.bsky.social" },
        undefined,
        selected.environment,
        providerPluginRegistry,
      );
      const live = await executeReadInvocation(invocation, {
        headed: false,
        environment: selected.environment,
        registry: providerPluginRegistry,
        executePublicWebSession: () => Promise.resolve({
          status: "succeeded",
          output: { metrics: { followers: { value: 52 } } },
          finalUrl: "https://bsky.app/profile/hraness.bsky.social",
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
        }),
      });
      const revalidated = await revalidatePreparedCapability(invocation, {
        environment: selected.environment,
        registry: providerPluginRegistry,
        executeRead: () => Promise.resolve(live),
      });
      expect(revalidated.cache.status).toBe("stored");
      const cached = readCachedPreparedCapability(invocation, {
        environment: selected.environment,
        registry: providerPluginRegistry,
      });
      expect(cached).toMatchObject({
        status: "hit",
        output: live.output,
      });
      expect(existsSync(join(
        selected.directory,
        "read-projection-control",
        "incarnations",
      ))).toBeFalse();
    } finally {
      rmSync(selected.directory, { recursive: true, force: true });
    }
  });
});
