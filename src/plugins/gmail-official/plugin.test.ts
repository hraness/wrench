import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../../canonical-json";
import { gmailOfficialPlugin } from "./plugin";

const binding = gmailOfficialPlugin.bindings[0];
if (binding?.transport !== "provider-api") {
  throw new Error("Gmail official provider binding is unavailable");
}

describe("Gmail official provider plugin", () => {
  test("owns only the reviewed Google surfaces and API hosts", () => {
    expect(binding.origin).toBe("https://gmail.googleapis.com");
    expect(binding.runtimeOrigins).toEqual([
      "https://gmail.googleapis.com",
      "https://people.googleapis.com",
    ]);
    expect(binding.manifestOrigins).toEqual([
      "https://mail.google.com",
      "https://contacts.google.com",
    ]);
    expect(binding.protectedHostnameFamilies).toEqual([
      "contacts.google.com",
      "gmail.googleapis.com",
      "mail.google.com",
      "people.googleapis.com",
    ]);
    expect(binding.authKinds).toEqual(["oauth-token-file"]);
  });

  test("advertises exactly three observed R1 contracts with bounded scopes", () => {
    expect(binding.operations.map((operation) => operation.name)).toEqual([
      "contacts.list",
      "messaging.list",
      "messaging.read",
    ]);
    expect(binding.operations.every((operation) =>
      operation.risk === "R1"
      && operation.state === "observed"
      && operation.sideEffect === "none"
      && operation.dispatch === "none")).toBeTrue();

    const contacts = binding.operations.find((operation) =>
      operation.name === "contacts.list");
    expect(contacts?.contractVersion).toBe(4);
    expect(contacts?.requiredScopeSets).toEqual([
      [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://mail.google.com/",
      ],
      [
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      [
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      [
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://mail.google.com/",
      ],
    ]);
    expect(contacts?.input.properties.limit).toMatchObject({
      minimum: 1,
      maximum: 100,
    });
    expect(contacts?.input.properties.collection).toMatchObject({
      enum: ["contacts", "other-contacts", "interactions"],
    });
    expect(contacts?.input.properties.stats_scan_limit).toMatchObject({
      minimum: 1,
      maximum: 2_000,
    });
    expect(contacts?.input.properties.include_stats).toMatchObject({
      type: "boolean",
    });
    expect(contacts?.coverage).toEqual([
      "contacts",
      "other-contacts",
      "contact-metadata",
      "contact-email-addresses",
      "optional-sent-counts",
      "optional-received-counts",
      "optional-last-sent-at",
      "optional-last-received-at",
      "bounded-stat-completeness",
      "messages-in-fixed-half-open-window",
      "spam-and-trash-excluded",
      "draft-and-chat-excluded",
      "sent-and-received-message-counts",
      "first-and-last-interaction-times",
      "30-90-365-day-counts",
      "per-direction-completeness",
      "opaque-pagination-evidence",
      "send-as-alias-exclusion",
    ]);

    const list = binding.operations.find((operation) =>
      operation.name === "messaging.list");
    expect(list?.coverage).toContain("thread-urls");
    expect(list?.coverage).toContain("replayable-read-input");
    const read = binding.operations.find((operation) =>
      operation.name === "messaging.read");
    expect(read?.coverage).toContain("attachment-metadata");
    expect(read?.coverage).toContain("render-safe-bodies");

    for (const operationName of ["messaging.list", "messaging.read"] as const) {
      const operation = binding.operations.find((candidate) =>
        candidate.name === operationName);
      expect(operation?.requiredScopeSets).toEqual([
        ["https://www.googleapis.com/auth/gmail.readonly"],
        ["https://www.googleapis.com/auth/gmail.modify"],
        ["https://mail.google.com/"],
      ]);
      expect(operation?.omni).toMatchObject({
        state: "supported",
        schemaVersion: 1,
        materializerId: `gmail-${operationName.replace(".", "-")}`,
        materializerVersion: operationName === "messaging.read" ? 2 : 1,
      });
    }
  });

  test("keeps the public manifest aligned with the plugin surface", () => {
    const manifest = JSON.parse(readFileSync(join(
      import.meta.dir,
      "../../assets/adapters/gmail/wrench-adapter.json",
    ), "utf8")) as {
      readonly surfaceId: string;
      readonly origins: readonly string[];
      readonly browserDomains: readonly string[];
      readonly operations: Readonly<Record<string, {
        readonly risk: string;
        readonly sideEffect: string;
        readonly input: unknown;
        readonly provider: {
          readonly provider: string;
          readonly action: string;
          readonly contractVersion: number;
          readonly timeoutMs: number;
          readonly maxOutputBytes: number;
        };
      }>>;
    };
    expect(manifest.surfaceId).toBe(binding.surfaceId);
    expect(manifest.origins).toEqual(binding.manifestOrigins);
    expect([...manifest.browserDomains].sort()).toEqual([
      "contacts.google.com",
      "mail.google.com",
    ]);
    expect(Object.keys(manifest.operations).sort()).toEqual(
      binding.operations.map((operation) => operation.name).sort(),
    );
    expect(Object.fromEntries(Object.entries(manifest.operations).map(
      ([name, operation]) => [name, {
        timeoutMs: operation.provider.timeoutMs,
        maxOutputBytes: operation.provider.maxOutputBytes,
      }],
    ))).toEqual({
      "contacts.list": {
        timeoutMs: 600_000,
        maxOutputBytes: 10_485_760,
      },
      "messaging.list": {
        timeoutMs: 120_000,
        maxOutputBytes: 4_194_304,
      },
      "messaging.read": {
        timeoutMs: 120_000,
        maxOutputBytes: 10_485_760,
      },
    });
    for (const operation of binding.operations) {
      expect(manifest.operations[operation.name]).toMatchObject({
        risk: operation.risk,
        sideEffect: operation.sideEffect,
        provider: {
          provider: "gmail",
          action: operation.name,
          contractVersion: operation.contractVersion,
        },
      });
      expect(canonicalJson(manifest.operations[operation.name]?.input))
        .toBe(canonicalJson(operation.input));
    }
  });

  test("binds every eager and lazy Gmail implementation source", () => {
    expect(gmailOfficialPlugin.implementationSources.map((source) => source.label))
      .toEqual([
        "plugin.ts",
        "kernel/provider-plugin-builtins.ts",
        "kernel/provider-contract-planning.ts",
        "kernel/provider-contract-semantic-identity.ts",
        "kernel/provider-context.ts",
        "kernel/provider-subject.ts",
        "contracts/gmail-input.ts",
        "kernel/provider-http.ts",
        "kernel/operation-deadline.ts",
        "providers/gmail-api.ts",
        "providers/contact-projection.ts",
        "providers/gmail.ts",
        "providers/gmail-omni.ts",
      ].sort((left, right) => left.localeCompare(right)));
  });
});
