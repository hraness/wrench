import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth, saveAuth } from "./auth";
import { readCachedCapability } from "./client";
import { type WrenchManifest } from "./model";
import { providerPluginRegistry } from "./provider-plugins";
import { publishReadProjection } from "./read-projections";
import {
  createReadProjectionQueryForInvocation,
  prepareInvocation,
} from "./runtime";
import { installManifest } from "./storage";

describe("public persistent-read client", () => {
  let directory = "";
  let environment: Readonly<Record<string, string>> = {};
  let dataRevision = "";
  const input = { view: "all", limit: 25 } as const;
  const persistedMessage =
    "token=ordinary-message-value left\u202eright\u0085tail";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wrench-public-client-test-"));
    chmodSync(directory, 0o700);
    environment = Object.freeze({ WRENCH_STATE_HOME: directory });
    const manifest = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.json"),
      "utf8",
    )) as WrenchManifest;
    installManifest(manifest, {
      force: false,
      environment,
      registry: providerPluginRegistry,
    });
    saveAuth(createAuth("x-messages", {
      oauthProvider: "x",
      tokenFile: join(directory, "unused-token.json"),
      scopes: ["dm.read", "tweet.read", "users.read"],
      subject: "12345",
    }), environment);
    const invocation = prepareInvocation(
      "x",
      "messaging.list",
      input,
      "x-messages",
      environment,
      providerPluginRegistry,
    );
    dataRevision = publishReadProjection(
      createReadProjectionQueryForInvocation(
        invocation,
        environment,
        providerPluginRegistry,
      ),
      {
        conversations: [{
          id: "conversation-1",
          preview: persistedMessage,
        }],
      },
      {
        environment,
        runId: "00000000-0000-4000-8000-000000000101",
        startedAt: "2026-07-31T16:00:00.000Z",
        finishedAt: "2026-07-31T16:00:01.000Z",
      },
    ).dataRevision;
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("returns the installed CLI cache without loading provider runtimes into the client bundle", () => {
    const cached = readCachedCapability({
      adapterId: "x",
      operationId: "messaging.list",
      authId: "x-messages",
      input,
    }, {
      environment,
      freshForMs: 60_000,
      now: new Date("2026-07-31T16:00:31.000Z"),
    });
    expect(cached).toMatchObject({
      status: "hit",
      source: "cache",
      output: {
        conversations: [{
          id: "conversation-1",
          preview: persistedMessage,
        }],
      },
      dataRevision,
      ageMs: 30_000,
      freshness: { state: "fresh", freshForMs: 60_000 },
    });
  });

  test("reports an exact-query cache miss", () => {
    expect(readCachedCapability({
      adapterId: "x",
      operationId: "messaging.list",
      authId: "x-messages",
      input: { view: "all", limit: 50 },
    }, { environment })).toMatchObject({ status: "miss" });
  });

  test("preserves explicit null as invalid operation input", () => {
    expect(() => readCachedCapability({
      adapterId: "x",
      operationId: "messaging.list",
      authId: "x-messages",
      input: null,
    }, { environment })).toThrow("input must be a JSON object");
  });

});
