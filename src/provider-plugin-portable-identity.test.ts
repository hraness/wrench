import { describe, expect, test } from "bun:test";

import {
  createPortableOperationIdentityV1,
  parsePortableOperationIdentityV1,
  type PortableOperationIdentitySourceV1,
} from "./provider-plugin-portable-identity";
import type {
  PortableProviderPluginBindingV1,
  PortableProviderPluginOperationV1,
} from "./provider-plugin-package";

function fixture(
  options: {
    readonly adapterId?: string;
    readonly pluginVersion?: string;
    readonly bundleSha256?: string;
    readonly manifestSha256?: string;
    readonly sideEffect?: string;
    readonly subjectFormat?: string;
    readonly networkOrigin?: `https://${string}`;
  } = {},
): PortableOperationIdentitySourceV1 {
  const operation: PortableProviderPluginOperationV1 = Object.freeze({
    name: "content.save",
    contractVersion: 7,
    timeoutMs: 5_000,
    maxOutputBytes: 16_384,
    state: "observed",
    risk: "R2",
    dispatch: "single",
    sideEffect: options.sideEffect ?? "Save one exact content item",
    idempotency: "local-at-most-once",
    dedupeWindowMs: 60_000,
    input: Object.freeze({
      properties: Object.freeze({
        content_id: Object.freeze({
          type: "string",
          description: "Exact content identifier",
          minLength: 1,
          maxLength: 128,
        }),
      }),
      required: Object.freeze(["content_id"]),
    }),
    implementation: "Observed first-party save endpoint",
  });
  const probe: PortableProviderPluginOperationV1 = Object.freeze({
    name: "profiles.read",
    contractVersion: 3,
    timeoutMs: 5_000,
    maxOutputBytes: 8_192,
    state: "observed",
    risk: "R1",
    dispatch: "none",
    sideEffect: "none",
    idempotency: "none",
    dedupeWindowMs: 0,
    input: Object.freeze({
      properties: Object.freeze({}),
      required: Object.freeze([]),
    }),
    implementation: "Observed current-account endpoint",
  });
  const authKinds: PortableProviderPluginBindingV1["authKinds"] =
    Object.freeze(["cookie-source"]);
  const binding: PortableProviderPluginBindingV1 = Object.freeze({
    adapterId: options.adapterId ?? "example-save",
    transport: "web-session-api",
    surfaceId: "example",
    origin: "https://www.example.com",
    authKinds,
    subject: Object.freeze({
      format: options.subjectFormat ?? "example:<account-id>",
      kind: "opaque-token",
      probe: Object.freeze({
        operation: probe.name,
        contractVersion: probe.contractVersion,
      }),
    }),
    operations: Object.freeze([operation, probe]),
  });
  return Object.freeze({
    package: Object.freeze({
      id: "example-portable",
      version: options.pluginVersion ?? "1.2.3",
      hostApiVersion: 1,
      bundleSha256: options.bundleSha256 ?? "a".repeat(64),
      manifestSha256: options.manifestSha256 ?? "b".repeat(64),
      capabilities: Object.freeze({
        networkOrigins: Object.freeze([
          options.networkOrigin ?? "https://www.example.com",
        ]),
        planFiles: "none",
        state: "namespaced",
        sessionMaterial: Object.freeze(["cookie-jar"] as const),
      }),
    }),
    binding,
    operation,
  });
}

describe("portable provider operation identity", () => {
  test("is deterministic, immutable, and independent of object insertion order", () => {
    const source = fixture();
    const first = createPortableOperationIdentityV1(source);
    const reordered = createPortableOperationIdentityV1({
      operation: structuredClone(source.operation),
      binding: structuredClone(source.binding),
      package: {
        capabilities: structuredClone(source.package.capabilities),
        manifestSha256: source.package.manifestSha256,
        bundleSha256: source.package.bundleSha256,
        hostApiVersion: 1,
        version: source.package.version,
        id: source.package.id,
      },
    });

    expect(reordered).toEqual(first);
    expect(first).toEqual({
      pluginId: "example-portable",
      pluginVersion: "1.2.3",
      hostApiVersion: 1,
      bundleSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      adapterId: "example-save",
      transport: "web-session-api",
      surfaceId: "example",
      operation: "content.save",
      contractVersion: 7,
      descriptorSha256: first.descriptorSha256,
    });
    expect(first.descriptorSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBeTrue();
  });

  test("changes the descriptor for every relevant metadata boundary", () => {
    const original = createPortableOperationIdentityV1(fixture());
    const changed = [
      fixture({ adapterId: "example-save-v2" }),
      fixture({ pluginVersion: "1.2.4" }),
      fixture({ sideEffect: "Save one exact item with notification" }),
      fixture({ subjectFormat: "example:user:<account-id>" }),
      fixture({ networkOrigin: "https://api.example.com" }),
    ].map(createPortableOperationIdentityV1);

    for (const identity of changed) {
      expect(identity.descriptorSha256).not.toBe(
        original.descriptorSha256,
      );
    }
  });

  test("binds artifact tampering separately from the logical descriptor", () => {
    const original = createPortableOperationIdentityV1(fixture());
    const bundleChanged = createPortableOperationIdentityV1(fixture({
      bundleSha256: "c".repeat(64),
    }));
    const manifestChanged = createPortableOperationIdentityV1(fixture({
      manifestSha256: "d".repeat(64),
    }));

    expect(bundleChanged.descriptorSha256).toBe(original.descriptorSha256);
    expect(manifestChanged.descriptorSha256).toBe(original.descriptorSha256);
    expect(bundleChanged.bundleSha256).not.toBe(original.bundleSha256);
    expect(manifestChanged.manifestSha256).not.toBe(
      original.manifestSha256,
    );
  });

  test("excludes executable wrapper state from descriptor identity", () => {
    const source = fixture();
    const withRuntime: PortableProviderPluginBindingV1 & {
      readonly runtime: Readonly<{
        readonly execute: () => Promise<void>;
      }>;
    } = {
      ...source.binding,
      runtime: Object.freeze({
        execute: () => Promise.resolve(),
      }),
    };

    expect(createPortableOperationIdentityV1({
      ...source,
      binding: withRuntime,
    }).descriptorSha256).toBe(
      createPortableOperationIdentityV1(source).descriptorSha256,
    );
  });

  test("rejects an operation not owned by the exact binding", () => {
    const source = fixture();
    expect(() => createPortableOperationIdentityV1({
      ...source,
      operation: {
        ...source.operation,
        contractVersion: source.operation.contractVersion + 1,
      },
    })).toThrow(
      "portable operation descriptor is not owned by its declared binding",
    );
  });

  test("strictly parses the durable identity without retaining foreign state", () => {
    const identity = createPortableOperationIdentityV1(fixture());
    const parsed = parsePortableOperationIdentityV1(structuredClone(identity));
    expect(parsed).toEqual(identity);
    expect(Object.isFrozen(parsed)).toBeTrue();

    expect(() => parsePortableOperationIdentityV1({
      ...identity,
      unexpected: true,
    })).toThrow("unsupported fields");
    expect(() => parsePortableOperationIdentityV1({
      ...identity,
      contractVersion: 0,
    })).toThrow("malformed");
    expect(() => parsePortableOperationIdentityV1({
      ...identity,
      descriptorSha256: "A".repeat(64),
    })).toThrow("malformed");
  });
});
