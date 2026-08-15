import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalJson,
  expandBrowserRecipe,
  genericSemanticRisks,
  isBrowserOperation,
  isProviderOperation,
  isReviewedTemplateOperation,
  isWebSessionOperation,
  manifestHash,
  operationRisks,
  parseDiagnosticManifest as parseDiagnosticManifestWithRegistry,
  parseManifest as parseManifestWithRegistry,
  parseRuntimeManifest as parseRuntimeManifestWithRegistry,
  sha256,
  WRENCH_LEGACY_LINKEDIN_MANIFEST_HASH,
  validateOperationInput,
  validatePlatformOperationInput,
  type InputSchema,
  type OperationInput,
  type OperationRisk,
  type WrenchManifest,
} from "./model";
import {
  lazyProviderApiRuntime,
  lazyWebSessionRuntime,
  type ProviderPluginDefinitionV1,
} from "./provider-plugin";
import {
  createProviderPluginRegistry,
  type ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import { semanticOperationNames, type SemanticOperationName } from "./platform-catalog";
import { getProviderContract as getProviderContractWithRegistry } from "./provider-contracts";
import {
  webSessionConditionalInputIssues as webSessionConditionalInputIssuesWithRegistry,
} from "./web-session-contracts";

const parseManifest = (
  value: unknown,
  registry: ProviderPluginRegistry = providerPluginRegistry,
) => parseManifestWithRegistry(value, registry);
const parseDiagnosticManifest = (
  value: unknown,
  registry: ProviderPluginRegistry = providerPluginRegistry,
) => parseDiagnosticManifestWithRegistry(value, registry);
const parseRuntimeManifest = (
  value: unknown,
  registry: ProviderPluginRegistry = providerPluginRegistry,
) => parseRuntimeManifestWithRegistry(value, registry);
const getProviderContract = (
  recipe: Parameters<typeof getProviderContractWithRegistry>[0],
  registry: ProviderPluginRegistry = providerPluginRegistry,
) => getProviderContractWithRegistry(recipe, registry);
const webSessionConditionalInputIssues = (
  recipe: Parameters<typeof webSessionConditionalInputIssuesWithRegistry>[0],
  input: Parameters<typeof webSessionConditionalInputIssuesWithRegistry>[1],
  registry: ProviderPluginRegistry = providerPluginRegistry,
) => webSessionConditionalInputIssuesWithRegistry(recipe, input, registry);

function readOperation(): Record<string, unknown> {
  return {
    description: "Read a member profile",
    risk: "R1",
    sideEffect: "none",
    idempotency: "none",
    dedupeWindowMs: 0,
    input: {
      properties: {
        profile_url: {
          type: "string",
          description: "Exact profile URL",
          minLength: 20,
          maxLength: 2_000,
          format: "url",
        },
        limit: {
          type: "number",
          description: "Maximum items",
          minimum: 1,
          maximum: 100,
        },
        view: {
          type: "string",
          description: "Response detail",
          enum: ["compact", "full"],
        },
        include_archived: {
          type: "boolean",
          description: "Include archived records",
        },
      },
      required: ["profile_url"],
    },
    browser: {
      steps: [
        { kind: "navigate-input", input: "profile_url" },
        { kind: "snapshot", interactive: true },
        { kind: "read" },
      ],
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    },
  };
}

function mutationOperation(steps?: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    description: "Send a message",
    risk: "R2",
    sideEffect: "Sends one external message",
    idempotency: "local-at-most-once",
    dedupeWindowMs: 86_400_000,
    input: {
      properties: {
        conversation_url: {
          type: "string",
          description: "Exact conversation URL",
          format: "url",
        },
        message: {
          type: "string",
          description: "Message body",
          minLength: 1,
          maxLength: 2_000,
        },
      },
      required: ["conversation_url", "message"],
    },
    browser: {
      steps: steps ?? [
        { kind: "navigate-input", input: "conversation_url" },
        {
          kind: "find",
          locator: { by: "role", value: "textbox", name: "Write a message" },
          action: "fill",
          with: "message",
        },
        {
          kind: "find",
          locator: { by: "role", value: "button", name: "Send" },
          action: "click",
          dispatch: true,
        },
        { kind: "assert-text", text: "Message sent" },
      ],
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    },
  };
}

function manifest(operation: Record<string, unknown> = readOperation()): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "example",
    version: "1.2.3",
    displayName: "Example",
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: {
      "profiles.read": operation,
    },
  };
}

function v2ThreadManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const operation = {
    description: "Send a bounded message thread",
    risk: "R3",
    sideEffect: "Sends one external message for each reviewed item",
    idempotency: "local-at-most-once",
    dedupeWindowMs: 86_400_000,
    input: {
      properties: {
        messages: {
          type: "array",
          description: "Reviewed messages in dispatch order",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "string",
            description: "One message",
            minLength: 1,
            maxLength: 2_000,
          },
        },
      },
      required: ["messages"],
    },
    browser: {
      steps: [
        { kind: "navigate", path: "/messages" },
        {
          kind: "for-each",
          input: "messages",
          steps: [
            {
              kind: "find",
              locator: { by: "role", value: "textbox", name: "Message", exact: true },
              action: "fill",
              with: { item: true },
              effect: { kind: "prepare", description: "Fill the reviewed message" },
            },
            {
              kind: "press",
              key: "Enter",
              effect: { kind: "dispatch", id: "send-message", description: "Send one reviewed message" },
            },
            {
              kind: "verify-dispatch",
              dispatch: "send-message",
              assertions: [
                {
                  kind: "assert-input-empty",
                  locator: { by: "role", value: "textbox", name: "Message", exact: true },
                },
              ],
            },
          ],
          between: [{ kind: "wait", milliseconds: 100 }],
        },
      ],
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    },
    ...overrides,
  };
  return {
    schemaVersion: 2,
    id: "example",
    version: "2.0.0",
    displayName: "Example",
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: { "messaging.send": operation },
  };
}

function xPostManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "x-publisher",
    version: "1.0.0",
    displayName: "X publisher",
    surfaceId: "x",
    origins: ["https://x.com"],
    browserDomains: ["x.com"],
    operations: {
      "posts.publish": {
        description: "Publish one reviewed X post",
        risk: "R3",
        sideEffect: "Publishes one externally visible post",
        idempotency: "local-at-most-once",
        dedupeWindowMs: 86_400_000,
        input: {
          properties: {
            body: { type: "string", description: "Post body", minLength: 1, maxLength: 280 },
            attachments: {
              type: "array",
              description: "Reviewed post attachment",
              minItems: 0,
              maxItems: 1,
              items: { type: "file", description: "Image attachment", maxBytes: 10_000_000, mediaTypes: ["image/*"] },
            },
          },
          required: ["body"],
        },
        browser: {
          steps: [
            { kind: "navigate", path: "/compose/post" },
            {
              kind: "find",
              locator: { by: "role", value: "textbox", name: "Post text", exact: true },
              action: "fill",
              with: { input: "body" },
              effect: { kind: "prepare", description: "Fill the reviewed post body" },
            },
            {
              kind: "find",
              locator: { by: "role", value: "button", name: "Post", exact: true },
              action: "click",
              effect: { kind: "dispatch", id: "publish-post", description: "Publish the reviewed post" },
            },
            {
              kind: "verify-dispatch",
              dispatch: "publish-post",
              assertions: [{ kind: "assert-url", pattern: "https://x.com/*/status/*" }],
            },
          ],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      },
    },
  };
}

function xThreadManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "x-thread-publisher",
    version: "1.0.0",
    displayName: "X thread publisher",
    surfaceId: "x",
    origins: ["https://x.com"],
    browserDomains: ["x.com"],
    operations: {
      "threads.publish": {
        description: "Publish one reviewed ordered X thread",
        risk: "R3",
        sideEffect: "Publishes each reviewed thread item in order",
        idempotency: "local-at-most-once",
        dedupeWindowMs: 86_400_000,
        input: {
          properties: {
            items: {
              type: "array",
              description: "Ordered thread items",
              minItems: 1,
              maxItems: 25,
              items: { type: "string", description: "One thread item", minLength: 1, maxLength: 280 },
            },
          },
          required: ["items"],
        },
        browser: {
          steps: [
            { kind: "navigate", path: "/compose/post" },
            {
              kind: "for-each",
              input: "items",
              steps: [
                {
                  kind: "find",
                  locator: { by: "role", value: "textbox", name: "Post text", exact: true },
                  action: "fill",
                  with: { item: true },
                  effect: { kind: "prepare", description: "Fill one reviewed thread item" },
                },
                {
                  kind: "find",
                  locator: { by: "role", value: "button", name: "Post", exact: true },
                  action: "click",
                  effect: { kind: "dispatch", id: "publish-thread-item", description: "Publish one reviewed thread item" },
                },
                {
                  kind: "verify-dispatch",
                  dispatch: "publish-thread-item",
                  assertions: [{ kind: "assert-url", pattern: "https://x.com/*/status/*" }],
                },
              ],
              between: [{ kind: "wait", milliseconds: 100 }],
            },
          ],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      },
    },
  };
}

function blueskyPostManifest(): Record<string, unknown> {
  const candidate = JSON.parse(JSON.stringify(xPostManifest()).replaceAll("https://x.com", "https://bsky.app")) as Record<string, unknown>;
  candidate.id = "bluesky-publisher";
  candidate.displayName = "Bluesky publisher";
  candidate.surfaceId = "bluesky";
  candidate.browserDomains = ["bsky.app"];
  return candidate;
}

function blueskyThreadManifest(): Record<string, unknown> {
  const candidate = JSON.parse(JSON.stringify(xThreadManifest()).replaceAll("https://x.com", "https://bsky.app")) as Record<string, unknown>;
  candidate.id = "bluesky-thread-publisher";
  candidate.displayName = "Bluesky thread publisher";
  candidate.surfaceId = "bluesky";
  candidate.browserDomains = ["bsky.app"];
  return candidate;
}

function providerManifest(
  provider: "linkedin" | "x",
  operationId: SemanticOperationName,
): Record<string, unknown> {
  const recipe = {
    provider,
    action: operationId,
    contractVersion: 1,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  } as const;
  const contract = getProviderContract(recipe);
  const mutating = contract.risk === "R2" || contract.risk === "R3";
  return {
    schemaVersion: 3,
    id: `${provider}-official`,
    version: "1.0.0",
    displayName: `${provider} official API`,
    surfaceId: provider,
    origins: [provider === "linkedin" ? "https://www.linkedin.com" : "https://x.com"],
    browserDomains: [provider === "linkedin" ? "www.linkedin.com" : "x.com"],
    operations: {
      [operationId]: {
        description: `Execute official ${provider} ${operationId}`,
        risk: contract.risk,
        sideEffect: mutating ? `Changes provider state through ${operationId}` : "none",
        idempotency: mutating ? "local-at-most-once" : "none",
        dedupeWindowMs: mutating ? 86_400_000 : 0,
        input: structuredClone(contract.input),
        provider: recipe,
      },
    },
  };
}

function webSessionManifest(site: "linkedin" | "x"): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", site, "wrench-web-adapter.json"),
    "utf8",
  )) as Record<string, unknown>;
}

const syntheticOperationName = "widgets.bulk-sync";
const syntheticInput = {
  properties: {
    widget_id: {
      type: "string",
      description: "Exact synthetic widget ID",
      minLength: 1,
      maxLength: 64,
    },
  },
  required: ["widget_id"],
} as const;

function syntheticPluginDefinition(
  surfaceId = "agent-cloud",
): ProviderPluginDefinitionV1 {
  const commonOperation = {
    name: syntheticOperationName,
    contractVersion: 7,
    risk: "R2",
    input: syntheticInput,
    sideEffect: "Synchronizes one exact synthetic widget",
    idempotency: "local-at-most-once",
    dedupeWindowMs: 60_000,
    state: "observed",
    dispatch: "single",
    implementation: "Synthetic injected-registry contract with no kernel catalog entry",
    planDispatches: () => [{
      id: "sync-widget",
      description: "Synchronize one exact synthetic widget",
    }],
    validateInput: (input: OperationInput) =>
      input.widget_id === "forbidden"
        ? ["input.widget_id is rejected by the synthetic provider"]
        : [],
  } as const;
  return {
    apiVersion: 1,
    id: `${surfaceId}-plugin`,
    version: "1.0.0",
    displayName: "Synthetic agent-authored plugin",
    sourceKind: "source",
    implementationSources: [{
      label: "plugin.ts",
      url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
    }],
    bindings: [
      {
        transport: "provider-api",
        surfaceId,
        origin: "https://api.widgets.example",
        protectedHostnameFamilies: ["widgets.example"],
        authKinds: ["oauth-token-file"],
        operations: [{
          ...commonOperation,
          requiredScopeSets: [["widgets.sync"]],
          coverage: ["widget-sync"],
        }],
        subject: {
          format: "synthetic:<id>",
          matches: (value) => /^synthetic:[a-z0-9-]+$/u.test(value),
        },
        runtime: lazyProviderApiRuntime(
          () => Promise.resolve({
            execute: () => Promise.resolve(),
          }),
        ),
      },
      {
        transport: "web-session-api",
        surfaceId,
        origin: "https://widgets.example",
        protectedHostnameFamilies: ["widgets.example"],
        authKinds: ["cookies-file"],
        operations: [commonOperation],
        subject: {
          format: "synthetic:<id>",
          matches: (value) => /^synthetic:[a-z0-9-]+$/u.test(value),
        },
        runtime: lazyWebSessionRuntime(
          () => Promise.resolve({
            probe: () => Promise.resolve("synthetic:viewer"),
            execute: () =>
              Promise.reject(new Error("synthetic runtime is not invoked")),
          }),
        ),
      },
    ],
  };
}

function syntheticManifest(
  schemaVersion: 3 | 4,
  surfaceId = "agent-cloud",
): Record<string, unknown> {
  const provider = schemaVersion === 3;
  return {
    schemaVersion,
    id: `${surfaceId}-${provider ? "official" : "web"}`,
    version: "1.0.0",
    displayName: "Synthetic plugin manifest",
    surfaceId,
    origins: [provider
      ? "https://api.widgets.example"
      : "https://widgets.example"],
    browserDomains: [provider ? "api.widgets.example" : "widgets.example"],
    operations: {
      [syntheticOperationName]: {
        description: "Synchronize one exact synthetic widget",
        risk: "R2",
        sideEffect: "Synchronizes one exact synthetic widget",
        idempotency: "local-at-most-once",
        dedupeWindowMs: 60_000,
        input: structuredClone(syntheticInput),
        ...(provider
          ? {
              provider: {
                provider: surfaceId,
                action: syntheticOperationName,
                contractVersion: 7,
                timeoutMs: 30_000,
                maxOutputBytes: 64 * 1024,
              },
            }
          : {
              webSession: {
                site: surfaceId,
                action: syntheticOperationName,
                contractVersion: 7,
                timeoutMs: 30_000,
                maxOutputBytes: 64 * 1024,
              },
            }),
      },
    },
  };
}

function reviewedTemplateManifest(risk: "R1" | "R3" = "R1"): Record<string, unknown> {
  const write = risk === "R3";
  const operationId = write ? "messaging.send" : "content.read";
  const input = {
    properties: {
      target_id: {
        type: "string",
        description: "Exact target identifier",
        minLength: 1,
        maxLength: 128,
        format: "path-segment",
      },
      ...(write ? {
        body: { type: "string", description: "Exact message body", minLength: 1, maxLength: 2_000 },
      } : {}),
    },
    required: write ? ["target_id", "body"] : ["target_id"],
  };
  return {
    schemaVersion: 5,
    id: "example-api",
    version: "1.0.0",
    displayName: "Example authenticated API",
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: {
      [operationId]: {
        description: write ? "Send one exact message" : "Read one exact target",
        risk,
        sideEffect: write ? "Sends one externally visible message" : "none",
        idempotency: write ? "local-at-most-once" : "none",
        dedupeWindowMs: write ? 86_400_000 : 0,
        input,
        reviewedTemplate: {
          state: "reviewed",
          contractVersion: 1,
          reviewedAt: "2026-07-22T12:00:00.000Z",
          evidenceSha256: "a".repeat(64),
          timeoutMs: 30_000,
          template: {
            schemaVersion: 1,
            origin: "https://example.com",
            request: {
              method: write ? "POST" : "GET",
              path: [
                { kind: "literal", value: "api" },
                { kind: "literal", value: "targets" },
                { kind: "input", name: "target_id", valueType: "string" },
              ],
              query: [],
              headers: [{ name: "accept", value: { kind: "literal", value: "application/json" } }],
              body: write
                ? {
                    kind: "json",
                    value: {
                      kind: "object",
                      entries: [{ name: "body", value: { kind: "input", name: "body", valueType: "string" } }],
                    },
                  }
                : { kind: "none" },
            },
            response: {
              maxBytes: 65_536,
              variants: [{
                status: 200,
                contentType: "application/json",
                body: {
                  kind: "json",
                  projections: [{
                    name: "id",
                    path: [{ kind: "key", key: "data" }, { kind: "key", key: "id" }],
                    valueType: "string",
                    required: true,
                  }],
                  bindings: write
                    ? [{
                        path: [{ kind: "key", key: "data" }, { kind: "key", key: "body" }],
                        expected: { kind: "input", name: "body", valueType: "string" },
                      }]
                    : [],
                },
              }],
            },
          },
        },
      },
    },
  };
}

function captureRequiredReviewedTemplateManifest(risk: "R1" | "R3" = "R1"): Record<string, unknown> {
  const candidate = reviewedTemplateManifest(risk);
  const operationId = risk === "R3" ? "messaging.send" : "content.read";
  const operation = (candidate.operations as Record<string, Record<string, unknown>>)[operationId];
  if (operation === undefined) throw new Error("missing reviewed-template fixture operation");
  operation.reviewedTemplate = {
    state: "capture-required",
    contractVersion: 1,
    instructions: "Keep this structural reservation inert until contractVersion 2 binds the current account.",
  };
  return candidate;
}

function v3BrowserManifest(surfaceId?: "linkedin" | "x"): Record<string, unknown> {
  const candidate = v2ThreadManifest();
  candidate.schemaVersion = 3;
  if (surfaceId !== undefined) {
    candidate.surfaceId = surfaceId;
    candidate.id = `${surfaceId}-browser`;
    candidate.origins = [surfaceId === "linkedin" ? "https://www.linkedin.com" : "https://x.com"];
    candidate.browserDomains = [surfaceId === "linkedin" ? "www.linkedin.com" : "x.com"];
  }
  return candidate;
}

function marketplaceListingManifest(): Record<string, unknown> {
  const textField = (description: string, maxLength: number, values?: readonly string[]): Record<string, unknown> => ({
    type: "string",
    description,
    minLength: 1,
    maxLength,
    ...(values === undefined ? {} : { enum: values }),
  });
  return {
    schemaVersion: 2,
    id: "facebook-marketplace-listing",
    version: "1.0.0",
    displayName: "Facebook Marketplace listing",
    surfaceId: "facebook-marketplace",
    origins: ["https://www.facebook.com"],
    browserDomains: ["www.facebook.com"],
    operations: {
      "listings.publish": {
        description: "Publish one reviewed Marketplace listing",
        risk: "R3",
        sideEffect: "Uploads reviewed images and publishes one externally visible listing",
        idempotency: "local-at-most-once",
        dedupeWindowMs: 86_400_000,
        input: {
          properties: {
            title: textField("Listing title", 80),
            body: textField("Listing description", 1_000),
            price: textField("Decimal listing price", 24),
            currency: { ...textField("Three-letter currency code", 3), minLength: 3 },
            category: textField("Reviewed provider category", 120, ["furniture", "electronics"]),
            condition: textField("Reviewed provider condition", 80, ["new", "used-good"]),
            location: textField("Listing location", 160),
            delivery: textField("Reviewed delivery option", 80, ["pickup", "shipping"]),
            images: {
              type: "array",
              description: "One to four reviewed listing images",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "file",
                description: "One listing image",
                maxBytes: 20_000_000,
                mediaTypes: ["image/*"],
              },
            },
          },
          required: ["title", "body", "price", "currency", "category", "condition", "location", "delivery", "images"],
        },
        browser: {
          steps: [
            { kind: "navigate", path: "/marketplace/create/item" },
            {
              kind: "find",
              locator: { by: "role", value: "textbox", name: "Title", exact: true },
              action: "fill",
              with: { input: "title" },
              effect: { kind: "prepare", description: "Fill the reviewed listing title" },
            },
            {
              kind: "find",
              locator: { by: "role", value: "button", name: "Add photos", exact: true },
              action: "upload",
              with: { input: "images" },
              effect: { kind: "dispatch", id: "upload-images", description: "Upload the reviewed listing images" },
            },
            {
              kind: "verify-dispatch",
              dispatch: "upload-images",
              assertions: [{ kind: "assert-text", text: "Photos" }],
            },
            {
              kind: "find",
              locator: { by: "role", value: "button", name: "Publish", exact: true },
              action: "click",
              effect: { kind: "dispatch", id: "publish-listing", description: "Publish the reviewed listing" },
            },
            {
              kind: "verify-dispatch",
              dispatch: "publish-listing",
              assertions: [{ kind: "assert-url", pattern: "https://www.facebook.com/marketplace/item/**" }],
            },
          ],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      },
    },
  };
}

function genericPolicyManifest(
  operationId: SemanticOperationName,
  risk: OperationRisk,
): Record<string, unknown> {
  if (operationId === "threads.publish") {
    const candidate = xThreadManifest();
    delete candidate.surfaceId;
    candidate.id = "generic-thread-publisher";
    candidate.origins = ["https://example.com"];
    candidate.browserDomains = ["example.com"];
    const operation = (candidate.operations as Record<string, Record<string, unknown>>)[operationId];
    if (operation !== undefined) operation.risk = risk;
    return candidate;
  }
  const readOnly = risk === "R1";
  const operation: Record<string, unknown> = readOnly
    ? {
        description: `Run reviewed ${operationId}`,
        risk,
        sideEffect: "none",
        idempotency: "none",
        dedupeWindowMs: 0,
        input: { properties: {}, required: [] },
        browser: {
          steps: [{ kind: "navigate", path: "/target" }, { kind: "read" }],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      }
    : {
        description: `Run reviewed ${operationId}`,
        risk,
        sideEffect: "Changes one explicit provider target",
        idempotency: "local-at-most-once",
        dedupeWindowMs: 86_400_000,
        input: {
          properties: {
            body: { type: "string", description: "Reviewed action value", minLength: 1, maxLength: 1_000 },
          },
          required: ["body"],
        },
        browser: {
          steps: [
            { kind: "navigate", path: "/target" },
            {
              kind: "find",
              locator: { by: "role", value: "textbox", name: "Value", exact: true },
              action: "fill",
              with: { input: "body" },
              effect: { kind: "prepare", description: "Fill the reviewed action value" },
            },
            {
              kind: "find",
              locator: { by: "role", value: "button", name: "Apply", exact: true },
              action: "click",
              effect: { kind: "dispatch", id: "apply-action", description: "Apply the reviewed action" },
            },
            {
              kind: "verify-dispatch",
              dispatch: "apply-action",
              assertions: [{ kind: "assert-text", text: "Applied" }],
            },
          ],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      };
  return {
    schemaVersion: 2,
    id: operationId.replaceAll(".", "-"),
    version: "1.0.0",
    displayName: operationId,
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: { [operationId]: operation },
  };
}

function issues(value: unknown): readonly string[] {
  const result = parseManifest(value);
  expect(result.ok).toBeFalse();
  return result.ok ? [] : result.issues;
}

describe("wrench manifest parsing", () => {
  test("keeps the shipped LinkedIn adapter parseable during the managed provider migration", () => {
    const value = JSON.parse(readFileSync(join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.json"), "utf8")) as unknown;
    const result = parseManifest(value);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.id).toBe("linkedin");
    expect(Object.keys(result.value.operations).length).toBeGreaterThan(0);
    for (const [operationId, operation] of Object.entries(result.value.operations)) {
      if (isProviderOperation(operation)) expect(String(operation.provider.action)).toBe(operationId);
      else if (isBrowserOperation(operation)) expect(operation.browser.steps.length).toBeGreaterThan(0);
    }
  });

  test("ships separate official X Article draft and publish contracts with an exact upgrade baseline", () => {
    const currentValue = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.json"),
      "utf8",
    )) as unknown;
    const current = parseRuntimeManifest(currentValue);
    expect(current.ok).toBeTrue();
    if (!current.ok) return;
    expect(current.value.version).toBe("1.2.0");
    const draft = current.value.operations["articles.draft.save"];
    expect(draft !== undefined && isProviderOperation(draft)).toBeTrue();
    if (draft === undefined || !isProviderOperation(draft)) return;
    expect(draft.risk).toBe("R2");
    expect(draft.provider).toMatchObject({
      action: "articles.draft.save",
      contractVersion: 1,
    });
    expect(draft.input.properties.draft_only).toBeUndefined();

    const article = current.value.operations["articles.publish"];
    expect(article !== undefined && isProviderOperation(article)).toBeTrue();
    if (article === undefined || !isProviderOperation(article)) return;
    expect(article.risk).toBe("R3");
    expect(article.provider.contractVersion).toBe(3);
    expect(article.input.properties.draft_only).toBeUndefined();

    const priorValue = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.v1.1.0.json"),
      "utf8",
    )) as unknown;
    const prior = parseDiagnosticManifest(priorValue);
    expect(prior.ok).toBeTrue();
    if (!prior.ok) return;
    const priorArticle = prior.value.operations["articles.publish"];
    expect(prior.value.version).toBe("1.1.0");
    expect(priorArticle !== undefined && isProviderOperation(priorArticle)).toBeTrue();
    if (priorArticle === undefined || !isProviderOperation(priorArticle)) return;
    expect(priorArticle.provider.contractVersion).toBe(2);
    expect(priorArticle.input.properties.draft_only).toMatchObject({
      type: "boolean",
      enum: [true],
    });
    expect(prior.value.operations["articles.draft.save"]).toBeUndefined();

    const originalValue = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.v1.0.0.json"),
      "utf8",
    )) as unknown;
    const original = parseDiagnosticManifest(originalValue);
    expect(original.ok).toBeTrue();
    if (!original.ok) return;
    const originalArticle = original.value.operations["articles.publish"];
    expect(original.value.version).toBe("1.0.0");
    expect(originalArticle !== undefined && isProviderOperation(originalArticle)).toBeTrue();
    if (originalArticle === undefined || !isProviderOperation(originalArticle)) return;
    expect(originalArticle.provider.contractVersion).toBe(1);
    expect(originalArticle.input.properties.draft_only).toBeUndefined();
  });

  test("ships a first-class X authenticated-web Article draft contract with an exact upgrade baseline", () => {
    const currentValue = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "x", "wrench-web-adapter.json"),
      "utf8",
    )) as unknown;
    const current = parseRuntimeManifest(currentValue);
    expect(current.ok).toBeTrue();
    if (!current.ok) return;
    expect(current.value.version).toBe("1.4.0");
    const article = current.value.operations["articles.draft.save"];
    expect(article !== undefined && isWebSessionOperation(article)).toBeTrue();
    if (article === undefined || !isWebSessionOperation(article)) return;
    expect(article.risk).toBe("R2");
    expect(article.webSession.contractVersion).toBe(1);
    expect(article.input.required).toEqual(["title", "document"]);
    expect(article.input.properties.draft_only).toBeUndefined();
    expect(article.input.properties.inline_images).toBeUndefined();
    expect(article.input.properties.cover_image).toBeUndefined();
    expect(article.input.properties.draft_id).toMatchObject({ type: "string", maxLength: 19 });
    const richInput = validateOperationInput(article.input, {
      title: "Harnessing Puerto Rico",
      document: canonicalJson({ schemaVersion: 1, blocks: [{ type: "paragraph", text: "Body" }] }),
    }, current.value.origins);
    expect(richInput.ok).toBeTrue();
    if (richInput.ok) {
      expect(validatePlatformOperationInput(current.value, "articles.draft.save", richInput.value)).toEqual({
        ok: true,
        value: richInput.value,
      });
    }
    const publish = current.value.operations["articles.publish"];
    expect(publish !== undefined && isWebSessionOperation(publish)).toBeTrue();
    if (publish !== undefined && isWebSessionOperation(publish)) {
      expect(publish).toMatchObject({ risk: "R3" });
      expect(publish.webSession.contractVersion).toBe(4);
      expect(publish.input.properties.draft_only).toBeUndefined();
    }

    const priorValue = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "x", "wrench-web-adapter.v1.3.0.json"),
      "utf8",
    )) as unknown;
    const prior = parseDiagnosticManifest(priorValue);
    expect(prior.ok).toBeTrue();
    if (!prior.ok) return;
    const priorArticle = prior.value.operations["articles.publish"];
    expect(prior.value.version).toBe("1.3.0");
    expect(priorArticle !== undefined && isWebSessionOperation(priorArticle)).toBeTrue();
    if (priorArticle === undefined || !isWebSessionOperation(priorArticle)) return;
    expect(priorArticle.webSession.contractVersion).toBe(3);
    expect(priorArticle.input.properties.draft_only).toMatchObject({ type: "boolean", enum: [true] });
    expect(priorArticle.input.required).toEqual(["title", "document", "draft_only"]);
    expect(priorArticle.input.properties.inline_images).toMatchObject({ type: "array", maxItems: 20 });
    expect(priorArticle.input.properties.cover_image).toMatchObject({ type: "file", maxBytes: 5 * 1024 * 1024 });
  });

  test("reserves LinkedIn native Article drafts separately from publication", () => {
    const currentValue = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-web-adapter.json"),
      "utf8",
    )) as unknown;
    const current = parseRuntimeManifest(currentValue);
    expect(current.ok).toBeTrue();
    if (!current.ok) return;
    expect(current.value.version).toBe("1.4.0");
    const draft = current.value.operations["articles.draft.save"];
    expect(draft !== undefined && isWebSessionOperation(draft)).toBeTrue();
    if (draft === undefined || !isWebSessionOperation(draft)) return;
    expect(draft.risk).toBe("R2");
    expect(draft.webSession).toMatchObject({
      action: "articles.draft.save",
      contractVersion: 1,
    });
    expect(draft.input.required).toEqual(["title", "document"]);
    expect(draft.input.properties.cover_image).toBeUndefined();

    const publish = current.value.operations["articles.publish"];
    expect(publish !== undefined && isWebSessionOperation(publish)).toBeTrue();
    if (publish !== undefined && isWebSessionOperation(publish)) {
      expect(publish.risk).toBe("R3");
      expect(publish.webSession.action).toBe("articles.publish");
    }

    const priorValue = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-web-adapter.v1.3.0.json"),
      "utf8",
    )) as unknown;
    const prior = parseDiagnosticManifest(priorValue);
    expect(prior.ok).toBeTrue();
    if (!prior.ok) return;
    expect(prior.value.version).toBe("1.3.0");
    expect(prior.value.operations["articles.draft.save"]).toBeUndefined();
    expect(prior.value.operations["articles.publish"]).toBeDefined();
  });

  test("ships only an inert generic capture reservation and rejects retired DOM recipes at runtime boundaries", () => {
    const value = JSON.parse(readFileSync(join(import.meta.dir, "assets", "adapter-template", "wrench-adapter.json"), "utf8")) as unknown;
    const result = parseManifest(value);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    const operation = result.value.operations["content.read"];
    expect(operation === undefined ? false : isReviewedTemplateOperation(operation)).toBeTrue();
    if (operation === undefined || !isReviewedTemplateOperation(operation)) return;
    expect(operation.reviewedTemplate).toMatchObject({ state: "capture-required", contractVersion: 1 });
    expect(JSON.stringify(value)).not.toContain("\"browser\"");
    expect(parseRuntimeManifest(v2ThreadManifest())).toMatchObject({
      ok: false,
      issues: [expect.stringContaining("runtime DOM action recipes are disabled")],
    });
  });

  test("preserves schema-v1 and schema-v2 browser manifests canonically", () => {
    const legacy = manifest();
    const current = v2ThreadManifest();
    for (const candidate of [legacy, current]) {
      const parsed = parseManifest(candidate);
      expect(parsed.ok).toBeTrue();
      if (!parsed.ok) continue;
      expect(canonicalJson(parsed.value)).toBe(canonicalJson(candidate));
      expect(manifestHash(parsed.value)).toBe(sha256(canonicalJson(candidate)));
      expect(Object.values(parsed.value.operations).every((operation) => !isProviderOperation(operation))).toBeTrue();
    }
  });

  test("parses a bounded, semantic, secret-free manifest", () => {
    const result = parseManifest(manifest());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      id: "example",
      version: "1.2.3",
      origins: ["https://example.com"],
      operations: {
        "profiles.read": {
          risk: "R1",
          sideEffect: "none",
          idempotency: "none",
        },
      },
    });
  });

  test.each([
    {
      label: "top-level extension",
      value: () => ({ ...manifest(), authToken: "must-never-be-accepted" }),
      issue: "manifest.authToken is not supported",
    },
    {
      label: "operation extension",
      value: () => manifest({ ...readOperation(), request: { headers: { authorization: "secret" } } }),
      issue: "request is not supported",
    },
    {
      label: "browser extension",
      value: () => manifest({
        ...readOperation(),
        browser: {
          ...((readOperation().browser as Record<string, unknown>) ?? {}),
          eval: "document.cookie",
        },
      }),
      issue: "browser.eval is not supported",
    },
    {
      label: "step extension",
      value: () => manifest({
        ...readOperation(),
        browser: {
          steps: [{ kind: "read", javascript: "document.cookie" }],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      }),
      issue: "javascript is not supported",
    },
  ])("rejects every unknown key at the $label boundary", ({ value, issue }) => {
    expect(issues(value()).some((candidate) => candidate.includes(issue))).toBeTrue();
  });

  test.each([
    { origin: "http://www.linkedin.com", issue: "exact HTTPS origin" },
    { origin: "https://www.linkedin.com/path", issue: "exact HTTPS origin" },
    { origin: "https://user:password@www.linkedin.com", issue: "exact HTTPS origin" },
    { origin: "not a URL", issue: "valid origin" },
  ])("rejects a non-exact or unsafe adapter origin: $origin", ({ origin, issue }) => {
    expect(issues({ ...manifest(), origins: [origin] }).some((candidate) => candidate.includes(issue))).toBeTrue();
  });

  test("rejects invalid identities, versions, and operation names", () => {
    const value = {
      ...manifest(),
      id: "LinkedIn/../../escape",
      version: "latest",
      operations: { send: readOperation() },
    };
    const resultIssues = issues(value);
    expect(resultIssues.some((issue) => issue.includes("lowercase kebab-case"))).toBeTrue();
    expect(resultIssues.some((issue) => issue.includes("semantic version"))).toBeTrue();
    expect(resultIssues.some((issue) => issue.includes("dotted semantic capability ID"))).toBeTrue();
  });
});

describe("schemaVersion 3 transport and provider binding", () => {
  test("requires exactly one browser or official-provider transport per operation", () => {
    expect(parseManifest(v3BrowserManifest()).ok).toBeTrue();
    expect(parseManifest(providerManifest("x", "feeds.read")).ok).toBeTrue();

    const both = providerManifest("x", "feeds.read");
    const bothOperation = (both.operations as Record<string, Record<string, unknown>>)["feeds.read"];
    if (bothOperation !== undefined) {
      bothOperation.browser = {
        steps: [{ kind: "navigate", path: "/home" }, { kind: "read" }],
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      };
    }
    expect(issues(both).some((issue) => issue.includes("exactly one of browser or provider"))).toBeTrue();

    const neither = providerManifest("x", "feeds.read");
    const neitherOperation = (neither.operations as Record<string, Record<string, unknown>>)["feeds.read"];
    if (neitherOperation !== undefined) delete neitherOperation.provider;
    expect(issues(neither).some((issue) => issue.includes("exactly one of browser or provider"))).toBeTrue();
  });

  test("binds provider, surface, action, contract version, risk, and exact input schema", () => {
    for (const [provider, operationId] of [
      ["linkedin", "posts.read"],
      ["x", "feeds.read"],
    ] as const) {
      expect(parseManifest(providerManifest(provider, operationId)).ok).toBeTrue();
    }

    const wrongSurface = providerManifest("x", "posts.publish");
    wrongSurface.surfaceId = "linkedin";
    wrongSurface.origins = ["https://www.linkedin.com"];
    wrongSurface.browserDomains = ["www.linkedin.com"];
    expect(issues(wrongSurface).some((issue) => issue.includes("provider.provider must match manifest.surfaceId"))).toBeTrue();

    const wrongAction = providerManifest("x", "feeds.read");
    const wrongActionOperation = (wrongAction.operations as Record<string, Record<string, unknown>>)["feeds.read"];
    const wrongActionRecipe = wrongActionOperation?.provider as Record<string, unknown>;
    wrongActionRecipe.action = "posts.read";
    expect(issues(wrongAction).some((issue) => issue.includes("provider.action must equal its canonical operation ID"))).toBeTrue();

    const wrongVersion = providerManifest("linkedin", "posts.read");
    const wrongVersionOperation = (wrongVersion.operations as Record<string, Record<string, unknown>>)["posts.read"];
    const wrongVersionRecipe = wrongVersionOperation?.provider as Record<string, unknown>;
    wrongVersionRecipe.contractVersion = 2;
    expect(issues(wrongVersion).some((issue) => issue.includes("@2 is not installed"))).toBeTrue();

    const wrongRisk = providerManifest("x", "feeds.read");
    const wrongRiskOperation = (wrongRisk.operations as Record<string, Record<string, unknown>>)["feeds.read"];
    if (wrongRiskOperation !== undefined) {
      wrongRiskOperation.risk = "R2";
      wrongRiskOperation.sideEffect = "Changes provider state";
      wrongRiskOperation.idempotency = "local-at-most-once";
      wrongRiskOperation.dedupeWindowMs = 60_000;
    }
    expect(issues(wrongRisk).some((issue) => issue.includes("risk must match provider contract risk R1"))).toBeTrue();

    const driftedInput = providerManifest("linkedin", "comments.create");
    const driftedOperation = (driftedInput.operations as Record<string, Record<string, unknown>>)["comments.create"];
    const input = driftedOperation?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    properties.body = { ...properties.body, maxLength: 499 };
    expect(issues(driftedInput).some((issue) => issue.includes("input must exactly match provider contract"))).toBeTrue();
  });

  test("allows provider read batches of 100 while browser arrays remain capped at 25", () => {
    const provider = parseManifest(providerManifest("x", "posts.read"));
    expect(provider.ok).toBeTrue();
    if (!provider.ok) return;
    expect(provider.value.operations["posts.read"]?.input.properties.post_ids).toMatchObject({
      type: "array",
      maxItems: 100,
    });

    const browser = v2ThreadManifest();
    const operation = (browser.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const input = operation?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    properties.messages = { ...properties.messages, maxItems: 26 };
    expect(issues(browser).some((issue) =>
      issue.includes("input.properties.messages.maxItems must be an integer between 1 and 25"))).toBeTrue();
  });

  test("prohibits browser actions on every protected signed-in site while preserving the schema-v1 migration fixture", () => {
    expect(issues(xPostManifest()).some((issue) =>
      issue.includes("schemaVersion 2 browser actions are prohibited on registered provider plugin surface x"))).toBeTrue();

    const linkedinV2 = xPostManifest();
    linkedinV2.id = "linkedin-browser";
    linkedinV2.surfaceId = "linkedin";
    linkedinV2.origins = ["https://www.linkedin.com"];
    linkedinV2.browserDomains = ["www.linkedin.com"];
    expect(issues(linkedinV2).some((issue) =>
      issue.includes("schemaVersion 2 browser actions are prohibited on registered provider plugin surface linkedin"))).toBeTrue();

    for (const surfaceId of ["linkedin", "x"] as const) {
      expect(issues(v3BrowserManifest(surfaceId)).some((issue) =>
        issue.includes(`schemaVersion 3 browser actions are prohibited on registered provider plugin surface ${surfaceId}`))).toBeTrue();
    }

    for (const [schemaVersion, origin] of [
      [2, "https://api.linkedin.com"],
      [2, "https://upload.twitter.com"],
      [3, "https://api.x.com"],
      [3, "https://www.linkedin.com"],
    ] as const) {
      const candidate = schemaVersion === 2 ? v2ThreadManifest() : v3BrowserManifest();
      candidate.origins = [origin];
      candidate.browserDomains = [new URL(origin).hostname];
      expect(issues(candidate).some((issue) =>
        issue.includes(`schemaVersion ${schemaVersion} browser actions are prohibited on protected signed-in site hostname`))).toBeTrue();
    }

    for (const schemaVersion of [2, 3] as const) {
      for (const protectedDomain of ["*.com", "*.x.com", "*.twitter.com", "*.linkedin.com"] as const) {
        const candidate = schemaVersion === 2 ? v2ThreadManifest() : v3BrowserManifest();
        candidate.browserDomains = ["example.com", protectedDomain];
        expect(issues(candidate).some((issue) =>
          issue.includes(`schemaVersion ${schemaVersion} browser actions are prohibited on protected signed-in site domain ${protectedDomain}`)))
          .toBeTrue();
      }
    }

    for (const schemaVersion of [2, 3] as const) {
      const benignWildcard = schemaVersion === 2 ? v2ThreadManifest() : v3BrowserManifest();
      benignWildcard.browserDomains = ["example.com", "*.social.example"];
      expect(parseManifest(benignWildcard).ok).toBeTrue();
    }

    const officialOnly = providerManifest("x", "feeds.read");
    officialOnly.browserDomains = ["x.com", "*.linkedin.com"];
    expect(issues(officialOnly).some((issue) =>
      issue.includes("manifest.browserDomains must exactly match provider plugin surface x")))
      .toBeTrue();

    const internalApiOnly = webSessionManifest("linkedin");
    internalApiOnly.browserDomains = ["www.linkedin.com", "*.twitter.com"];
    expect(issues(internalApiOnly).some((issue) =>
      issue.includes("manifest.browserDomains must exactly match provider plugin surface linkedin")))
      .toBeTrue();

    const legacy = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.v0.4.0.json"),
      "utf8",
    )) as Record<string, unknown>;
    const parsedLegacy = parseManifest(legacy);
    expect(parsedLegacy.ok).toBeTrue();
    if (parsedLegacy.ok) expect(manifestHash(parsedLegacy.value)).toBe(WRENCH_LEGACY_LINKEDIN_MANIFEST_HASH);

    const inventedLegacy = structuredClone(legacy);
    inventedLegacy.version = "0.4.1";
    expect(issues(inventedLegacy).some((issue) =>
      issue.includes("exact archived v0.4.0 manifest"))).toBeTrue();

    const normalizedLookalike = structuredClone(legacy);
    (normalizedLookalike.browserDomains as string[]).push("www.linkedin.com");
    expect(issues(normalizedLookalike).some((issue) =>
      issue.includes("exact archived v0.4.0 manifest"))).toBeTrue();
  });
});

describe("schemaVersion 4 authenticated web-session binding", () => {
  test("keeps every bundled LinkedIn and X web operation bound to its code-owned contract", () => {
    for (const site of ["linkedin", "x"] as const) {
      const result = parseManifest(webSessionManifest(site));
      expect(result.ok).toBeTrue();
      if (!result.ok) expect(result.issues).toEqual([]);
    }
  });

  test("rejects a forged X input schema even when it selects a real write operation", () => {
    const candidate = webSessionManifest("x");
    const operation = (candidate.operations as Record<string, Record<string, unknown>>)["posts.publish"];
    const input = operation?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    properties.body = { ...properties.body, maxLength: 100_000 };

    expect(issues(candidate).some((issue) =>
      issue.includes("input must exactly match authenticated web contract x/posts.publish@1"))).toBeTrue();
  });

  test("rejects forged confirmation and replay semantics for a real X mutation", () => {
    for (const [field, value] of [
      ["sideEffect", "Performs a harmless local preview"],
      ["idempotency", "none"],
      ["dedupeWindowMs", 0],
    ] as const) {
      const candidate = webSessionManifest("x");
      const operation = (candidate.operations as Record<string, Record<string, unknown>>)["posts.publish"];
      if (operation !== undefined) operation[field] = value;

      expect(issues(candidate).some((issue) =>
        issue.includes(`${field} must exactly match authenticated web contract x/posts.publish@1`))).toBeTrue();
    }
  });

  test("parses retired web contracts only as inert diagnostic migration evidence", () => {
    const retired = webSessionManifest("x");
    retired.version = "0.9.0";
    const operation = (retired.operations as Record<string, Record<string, unknown>>)["feeds.read"];
    const recipe = operation?.webSession as Record<string, unknown> | undefined;
    if (recipe === undefined) throw new Error("missing X feed recipe");
    recipe.contractVersion = 999;

    const diagnostic = parseDiagnosticManifest(retired);
    expect(diagnostic.ok).toBeTrue();
    expect(parseManifest(retired)).toEqual({
      ok: false,
      issues: ["authenticated web contract x/feeds.read@999 is not installed"],
    });
    expect(parseRuntimeManifest(retired)).toEqual({
      ok: false,
      issues: ["authenticated web contract x/feeds.read@999 is not installed"],
    });
  });

  test("accepts every explicitly registered historical web contract identity", () => {
    const historicalContracts = providerPluginRegistry.list().flatMap((plugin) =>
      plugin.bindings.flatMap((binding) =>
        binding.transport === "provider-api"
          ? []
          : binding.operations.flatMap((operation) =>
            (operation.historicalContractVersions ?? []).map((contractVersion) => ({
              site: binding.surfaceId,
              operationId: operation.name,
              contractVersion,
            })))));
    expect(historicalContracts.length).toBeGreaterThan(0);
    for (const { site, operationId, contractVersion } of historicalContracts) {
      const manifest = JSON.parse(readFileSync(
        join(
          import.meta.dir,
          "assets",
          "adapters",
          site,
          "wrench-web-adapter.json",
        ),
        "utf8",
      )) as Record<string, unknown>;
      const operation = (
        manifest.operations as Record<string, Record<string, unknown>>
      )[operationId];
      const recipe = operation?.webSession as Record<string, unknown> | undefined;
      if (recipe === undefined) {
        throw new Error(`missing ${site}/${operationId} web-session recipe`);
      }
      recipe.contractVersion = contractVersion;

      expect(parseManifest(manifest).ok).toBeTrue();
      expect(parseRuntimeManifest(manifest).ok).toBeTrue();
    }
  });
});

describe("injected provider-plugin manifest contracts", () => {
  test("parses a non-built-in surface and hyphenated novel operation in schemaVersion 3 and 4", () => {
    const registry = createProviderPluginRegistry([
      syntheticPluginDefinition(),
    ]);
    expect(parseManifest(syntheticManifest(3), registry).ok).toBeTrue();
    expect(parseRuntimeManifest(syntheticManifest(3), registry).ok).toBeTrue();
    expect(parseManifest(syntheticManifest(4), registry).ok).toBeTrue();
    expect(parseRuntimeManifest(syntheticManifest(4), registry).ok).toBeTrue();
  });

  test("rejects forged descriptor semantics and keeps retired versions diagnostic-only", () => {
    const registry = createProviderPluginRegistry([
      syntheticPluginDefinition(),
    ]);
    for (const schemaVersion of [3, 4] as const) {
      const forged = syntheticManifest(schemaVersion);
      const operation = (forged.operations as Record<string, Record<string, unknown>>)[
        syntheticOperationName
      ];
      if (operation === undefined) throw new Error("missing synthetic operation");
      operation.sideEffect = "none";
      expect(parseManifest(forged, registry)).toMatchObject({
        ok: false,
        issues: [expect.stringContaining("sideEffect must exactly match")],
      });

      const retired = syntheticManifest(schemaVersion);
      const retiredOperation = (
        retired.operations as Record<string, Record<string, unknown>>
      )[syntheticOperationName];
      if (retiredOperation === undefined) throw new Error("missing synthetic operation");
      const recipe = (
        schemaVersion === 3
          ? retiredOperation.provider
          : retiredOperation.webSession
      ) as Record<string, unknown>;
      recipe.contractVersion = 999;

      expect(parseDiagnosticManifest(retired, registry).ok).toBeTrue();
      expect(parseManifest(retired, registry)).toMatchObject({
        ok: false,
        issues: [expect.stringContaining("@999 is not installed")],
      });
      expect(parseRuntimeManifest(retired, registry)).toMatchObject({
        ok: false,
        issues: [expect.stringContaining("@999 is not installed")],
      });
    }
  });

  test("rejects manifest origins and browser domains not owned by the plugin binding", () => {
    const registry = createProviderPluginRegistry([
      syntheticPluginDefinition(),
    ]);
    for (const schemaVersion of [3, 4] as const) {
      const forgedOrigin = syntheticManifest(schemaVersion);
      forgedOrigin.origins = ["https://unowned.example"];
      forgedOrigin.browserDomains = ["unowned.example"];
      expect(parseManifest(forgedOrigin, registry)).toMatchObject({
        ok: false,
        issues: [
          expect.stringContaining(
            "manifest.origins must exactly match provider plugin surface agent-cloud",
          ),
          expect.stringContaining(
            "manifest.browserDomains must exactly match provider plugin surface agent-cloud",
          ),
        ],
      });
      expect(parseDiagnosticManifest(forgedOrigin, registry).ok).toBeTrue();

      const extraDomain = syntheticManifest(schemaVersion);
      extraDomain.browserDomains = [
        ...(extraDomain.browserDomains as string[]),
        "*.unowned.example",
      ];
      expect(parseManifest(extraDomain, registry)).toMatchObject({
        ok: false,
        issues: [
          expect.stringContaining(
            "manifest.browserDomains must exactly match provider plugin surface agent-cloud",
          ),
        ],
      });
    }
  });

  test("does not let the platform catalog veto a plugin-owned operation on a known surface", () => {
    const registry = createProviderPluginRegistry([
      syntheticPluginDefinition("x"),
    ]);
    expect(parseManifest(syntheticManifest(3, "x"), registry).ok).toBeTrue();
    expect(parseManifest(syntheticManifest(4, "x"), registry).ok).toBeTrue();
  });

  test("protects injected plugin origins and exposes provider-owned input laws", () => {
    const registry = createProviderPluginRegistry([
      syntheticPluginDefinition(),
    ]);
    const browser = v2ThreadManifest();
    browser.origins = ["https://widgets.example"];
    browser.browserDomains = ["widgets.example"];
    const protectedResult = parseManifest(browser, registry);
    expect(protectedResult.ok).toBeFalse();
    if (!protectedResult.ok) {
      expect(protectedResult.issues.some((issue) =>
        issue.includes("protected signed-in site"))).toBeTrue();
    }
    const protectedSibling = v2ThreadManifest();
    protectedSibling.origins = ["https://cdn.widgets.example"];
    protectedSibling.browserDomains = ["cdn.widgets.example"];
    const protectedSiblingResult = parseManifest(protectedSibling, registry);
    expect(
      !protectedSiblingResult.ok
      && protectedSiblingResult.issues.some((issue) =>
        issue.includes("protected signed-in site")),
    ).toBeTrue();
    const confusedSurface = v3BrowserManifest();
    confusedSurface.surfaceId = "agent-cloud";
    const confusedSurfaceResult = parseManifest(confusedSurface, registry);
    expect(
      !confusedSurfaceResult.ok
      && confusedSurfaceResult.issues.some((issue) =>
        issue.includes(
          "registered provider plugin surface agent-cloud",
        )),
    ).toBeTrue();
    expect(webSessionConditionalInputIssues({
      site: "agent-cloud",
      action: syntheticOperationName,
      contractVersion: 7,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    }, {
      widget_id: "forbidden",
    }, registry)).toEqual([
      "input.widget_id is rejected by the synthetic provider",
    ]);
  });
});

describe("schemaVersion 5 reviewed authenticated templates", () => {
  test("rejects every executable v1 template, including DELETE disguised as R1", () => {
    for (const method of ["GET", "DELETE"] as const) {
      const candidate = reviewedTemplateManifest("R1");
      const operation = (candidate.operations as Record<string, Record<string, unknown>>)["content.read"];
      const recipe = operation?.reviewedTemplate as Record<string, unknown> | undefined;
      const template = recipe?.template as Record<string, unknown> | undefined;
      const request = template?.request as Record<string, unknown> | undefined;
      if (request === undefined) throw new Error("missing reviewed request fixture");
      request.method = method;
      expect(issues(candidate).some((issue) =>
        issue.includes("reviewed-template contractVersion 2 with a current-account identity preflight"))).toBeTrue();
    }
  });

  test("keeps all schema-v5 operations capture-required until current-account preflight exists", () => {
    const reviewedWrite = reviewedTemplateManifest("R3");
    expect(issues(reviewedWrite).some((issue) =>
      issue.includes("reviewed-template contractVersion 2 with a current-account identity preflight"))).toBeTrue();

    const captureRequiredWrite = captureRequiredReviewedTemplateManifest("R3");
    const result = parseManifest(captureRequiredWrite);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    const parsed = result.value.operations["messaging.send"];
    expect(parsed !== undefined && isReviewedTemplateOperation(parsed) && parsed.reviewedTemplate.state === "capture-required").toBeTrue();
  });

  test("fails closed on origin drift or browser transport substitution", () => {
    const wrongOrigin = reviewedTemplateManifest();
    const read = (wrongOrigin.operations as Record<string, Record<string, unknown>>)["content.read"];
    const recipe = read?.reviewedTemplate as Record<string, unknown>;
    const template = recipe.template as Record<string, unknown>;
    template.origin = "https://other.example";
    expect(issues(wrongOrigin).some((issue) => issue.includes("not one of the exact reviewed origins"))).toBeTrue();

    const browser = reviewedTemplateManifest();
    const browserOperation = (browser.operations as Record<string, Record<string, unknown>>)["content.read"];
    if (browserOperation !== undefined) {
      delete browserOperation.reviewedTemplate;
      browserOperation.browser = {
        steps: [{ kind: "navigate", path: "/api" }, { kind: "read" }],
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
      };
    }
    expect(issues(browser).some((issue) => issue.includes("exactly one reviewedTemplate transport"))).toBeTrue();
  });

  test("rejects protected signed-in hostname families and non-default ports for inert reservations", () => {
    for (const [origin, expected] of [
      ["https://api.x.com", "protected signed-in site hostname api.x.com"],
      ["https://upload.twitter.com", "protected signed-in site hostname upload.twitter.com"],
      ["https://api.linkedin.com", "protected signed-in site hostname api.linkedin.com"],
      ["https://example.com:444", "require the default HTTPS port"],
    ] as const) {
      const candidate = captureRequiredReviewedTemplateManifest("R1");
      candidate.origins = [origin];
      candidate.browserDomains = [new URL(origin).hostname];
      expect(issues(candidate).some((issue) => issue.includes(expected))).toBeTrue();
    }
  });

  test("keeps LinkedIn and X on code-owned schemaVersion 4 contracts", () => {
    for (const [surfaceId, origin] of [
      ["linkedin", "https://www.linkedin.com"],
      ["x", "https://x.com"],
    ] as const) {
      const candidate = captureRequiredReviewedTemplateManifest();
      candidate.surfaceId = surfaceId;
      candidate.origins = [origin];
      candidate.browserDomains = [new URL(origin).hostname];
      expect(issues(candidate).some((issue) => issue.includes("schemaVersion 5 reviewed templates are prohibited"))).toBeTrue();
    }
  });
});

describe("operation input validation", () => {
  const schema: InputSchema = {
    properties: {
      conversation_url: {
        type: "string",
        description: "Conversation URL",
        minLength: 20,
        maxLength: 200,
        format: "url",
        urlPathPrefixes: ["/messaging/thread/"],
      },
      message: {
        type: "string",
        description: "Message body",
        minLength: 1,
        maxLength: 20,
      },
      attempts: {
        type: "number",
        description: "Attempt count",
        minimum: 1,
        maximum: 3,
      },
      tone: {
        type: "string",
        description: "Message tone",
        enum: ["warm", "direct"],
      },
      notify: {
        type: "boolean",
        description: "Send a notification",
      },
    },
    required: ["conversation_url", "message"],
  };
  const origins = ["https://www.linkedin.com"];

  test("accepts and returns only declared, correctly typed fields", () => {
    expect(validateOperationInput(schema, {
      conversation_url: "https://www.linkedin.com/messaging/thread/abc",
      message: "Following up",
      attempts: 2,
      tone: "warm",
      notify: true,
    }, origins)).toEqual({
      ok: true,
      value: {
        conversation_url: "https://www.linkedin.com/messaging/thread/abc",
        message: "Following up",
        attempts: 2,
        tone: "warm",
        notify: true,
      },
    });
  });

  test("treats URL prefixes as route boundaries", () => {
    const boundarySchema: InputSchema = {
      properties: {
        target: {
          type: "string",
          description: "Account route",
          minLength: 1,
          maxLength: 200,
          format: "url",
          urlPathPrefixes: ["/account"],
        },
      },
      required: ["target"],
    };
    expect(validateOperationInput(boundarySchema, {
      target: "https://www.linkedin.com/account/settings",
    }, origins).ok).toBeTrue();
    expect(validateOperationInput(boundarySchema, {
      target: "https://www.linkedin.com/account-delete",
    }, origins)).toEqual({
      ok: false,
      issues: ["input.target must use an allowed URL path prefix"],
    });
  });

  test.each([
    { label: "non-object input", value: [], issue: "input must be a JSON object" },
    {
      label: "unknown field",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/abc", message: "Hi", secret: "x" },
      issue: "input.secret is not supported",
    },
    { label: "missing required field", value: { message: "Hi" }, issue: "input.conversation_url is required" },
    {
      label: "wrong field type",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/abc", message: 42 },
      issue: "input.message must be string",
    },
    {
      label: "string bound",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/abc", message: "x".repeat(21) },
      issue: "input.message has an invalid length",
    },
    {
      label: "NUL byte",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/abc", message: "hello\u0000world" },
      issue: "input.message must not contain NUL",
    },
    {
      label: "unpaired Unicode surrogate",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/abc", message: "hello\ud800world" },
      issue: "input.message must contain well-formed Unicode",
    },
    {
      label: "numeric bound",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/abc", message: "Hi", attempts: 4 },
      issue: "input.attempts is outside its numeric bounds",
    },
    {
      label: "enum",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/abc", message: "Hi", tone: "aggressive" },
      issue: "input.tone is not an allowed value",
    },
    {
      label: "off-origin URL",
      value: { conversation_url: "https://evil.example/messaging/thread/abc", message: "Hi" },
      issue: "input.conversation_url must use an adapter origin",
    },
    {
      label: "credential-bearing URL",
      value: { conversation_url: "https://user:password@www.linkedin.com/messaging/thread/abc", message: "Hi" },
      issue: "input.conversation_url must use an adapter origin and contain no credentials",
    },
    {
      label: "wrong URL route family",
      value: { conversation_url: "https://www.linkedin.com/feed/", message: "Hi" },
      issue: "input.conversation_url must use an allowed URL path prefix",
    },
    {
      label: "encoded route ambiguity",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/%2f/feed", message: "Hi" },
      issue: "input.conversation_url must use an unambiguous allowed URL path",
    },
    {
      label: "encoded dot-segment normalization",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/%2e%2e/feed", message: "Hi" },
      issue: "input.conversation_url must use an unambiguous allowed URL path",
    },
    {
      label: "literal dot-segment normalization",
      value: { conversation_url: "https://www.linkedin.com/messaging/thread/../feed", message: "Hi" },
      issue: "input.conversation_url must use an unambiguous allowed URL path",
    },
  ])("rejects $label", ({ value, issue }) => {
    const result = validateOperationInput(schema, value, origins);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.issues.some((candidate) => candidate.includes(issue))).toBeTrue();
  });
});

describe("canonical binding", () => {
  test("sorts object keys recursively while preserving array order", () => {
    const left = { z: [{ y: 2, x: 1 }], a: true, omitted: undefined };
    const right = { a: true, z: [{ x: 1, y: 2 }] };
    expect(canonicalJson(left)).toBe('{"a":true,"z":[{"x":1,"y":2}]}');
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  test("has a stable SHA-256 fixture and rejects non-JSON values", () => {
    expect(sha256(canonicalJson({ b: 2, a: 1 }))).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow("non-finite");
    expect(() => canonicalJson(1n)).toThrow("JSON-compatible");
  });

  test("hashes semantically identical manifests identically", () => {
    const parsed = parseManifest(manifest());
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    const reordered: WrenchManifest = {
      operations: parsed.value.operations,
      origins: parsed.value.origins,
      displayName: parsed.value.displayName,
      browserDomains: parsed.value.browserDomains,
      version: parsed.value.version,
      id: parsed.value.id,
      schemaVersion: parsed.value.schemaVersion,
    };
    expect(manifestHash(reordered)).toBe(manifestHash(parsed.value));
  });
});

describe("mutation recipe constraints", () => {
  test("accepts one explicitly marked dispatch followed by a postcondition", () => {
    const result = parseManifest(manifest(mutationOperation()));
    expect(result.ok).toBeTrue();
  });

  test.each(["/profiles/../admin", "/profiles/%2e%2e/admin", "/profiles/%252e%252e/admin", "/profiles\\admin"])(
    "rejects an ambiguous static navigation path %j",
    (path) => {
      const operation = readOperation();
      const browser = operation.browser as Record<string, unknown>;
      const resultIssues = issues(manifest({
        ...operation,
        browser: {
          ...browser,
          steps: [{ kind: "navigate", path }, { kind: "read" }],
        },
      }));
      expect(resultIssues.some((issue) => issue.includes("origin-relative path"))).toBeTrue();
    },
  );

  test("requires every path-interpolated input to declare path-segment format", () => {
    const operation = readOperation();
    const browser = operation.browser as Record<string, unknown>;
    const resultIssues = issues(manifest({
      ...operation,
      browser: {
        ...browser,
        steps: [{ kind: "navigate", path: "/profiles/" + "$" + "{input.profile_url}" }, { kind: "read" }],
      },
    }));
    expect(resultIssues.some((issue) => issue.includes("must declare format path-segment"))).toBeTrue();
  });

  test("accepts a sent-text observation followed by an exactly resolved empty-composer postcondition", () => {
    const result = parseManifest(manifest(mutationOperation([
      { kind: "navigate-input", input: "conversation_url" },
      {
        kind: "find",
        locator: { by: "role", value: "textbox", name: "Write a message…", exact: true },
        action: "fill",
        with: "message",
      },
      { kind: "press", key: "Enter", dispatch: true },
      { kind: "assert-text", text: "$" + "{input.message}" },
      {
        kind: "assert-input-empty",
        locator: { by: "role", value: "textbox", name: "Write a message…", exact: true },
      },
    ])));
    expect(result.ok).toBeTrue();
  });

  test.each([
    { locator: { by: "role", value: "textbox", name: "Composer" }, issue: "exact named textbox" },
    { locator: { by: "role", value: "button", name: "Composer", exact: true }, issue: "exact named textbox" },
    { locator: { by: "placeholder", value: "Composer", exact: true }, issue: "exact named textbox" },
  ])("rejects an ambiguous empty-input postcondition: $locator", ({ locator, issue }) => {
    const resultIssues = issues(manifest(mutationOperation([
      { kind: "navigate-input", input: "conversation_url" },
      { kind: "press", key: "Enter", dispatch: true },
      { kind: "assert-input-empty", locator },
    ])));
    expect(resultIssues.some((candidate) => candidate.includes(issue))).toBeTrue();
  });

  test.each([
    {
      label: "no idempotency strategy",
      operation: () => ({ ...mutationOperation(), idempotency: "none" }),
      issue: "must declare local-at-most-once dispatch",
    },
    {
      label: "no dispatch marker",
      operation: () => mutationOperation([
        { kind: "navigate", path: "/messaging/" },
        { kind: "assert-text", text: "Message sent" },
      ]),
      issue: "must mark exactly one dispatch step",
    },
    {
      label: "multiple dispatch markers",
      operation: () => mutationOperation([
        { kind: "press", key: "Enter", dispatch: true },
        {
          kind: "find",
          locator: { by: "role", value: "button", name: "Send" },
          action: "click",
          dispatch: true,
        },
        { kind: "assert-text", text: "Message sent" },
      ]),
      issue: "must mark exactly one dispatch step",
    },
    {
      label: "no observable postcondition",
      operation: () => mutationOperation([
        { kind: "press", key: "Enter", dispatch: true },
        { kind: "snapshot" },
      ]),
      issue: "observable postcondition",
    },
  ])("rejects a mutation with $label", ({ operation, issue }) => {
    expect(issues(manifest(operation())).some((candidate) => candidate.includes(issue))).toBeTrue();
  });

  test("requires the observable postcondition to follow dispatch", () => {
    const operation = mutationOperation([
      { kind: "assert-text", text: "Composer loaded" },
      { kind: "press", key: "Enter", dispatch: true },
    ]);
    expect(issues(manifest(operation)).some((candidate) => candidate.includes("observable postcondition"))).toBeTrue();
  });

  test("forbids form interaction after the dispatch boundary", () => {
    const operation = mutationOperation([
      { kind: "navigate-input", input: "conversation_url" },
      { kind: "press", key: "Enter", dispatch: true },
      {
        kind: "find",
        locator: { by: "role", value: "textbox", name: "Another field" },
        action: "fill",
        with: "message",
      },
      { kind: "assert-url", pattern: "https://www.linkedin.com/messaging/**" },
    ]);
    expect(issues(manifest(operation)).some((candidate) => candidate.includes("cannot interact after dispatch"))).toBeTrue();
  });

  test("forbids navigation after the dispatch boundary", () => {
    const operation = mutationOperation([
      { kind: "navigate-input", input: "conversation_url" },
      { kind: "press", key: "Enter", dispatch: true },
      { kind: "navigate", path: "/another-action" },
      { kind: "assert-url", pattern: "https://www.linkedin.com/another-action" },
    ]);
    expect(issues(manifest(operation)).some((candidate) => candidate.includes("cannot interact after dispatch"))).toBeTrue();
  });

  test("requires every query-bound input so it cannot render as undefined", () => {
    const operation = readOperation();
    const browser = operation.browser as Record<string, unknown>;
    const resultIssues = issues(manifest({
      ...operation,
      browser: {
        ...browser,
        steps: [
          { kind: "navigate", path: "/search", query: { limit: "limit" } },
          { kind: "read" },
        ],
      },
    }));
    expect(resultIssues.some((issue) => issue.includes("must name a required input field"))).toBeTrue();
  });

  test("forbids mutation primitives and side effects in R1 recipes", () => {
    const interactiveRead = {
      ...readOperation(),
      sideEffect: "marks a conversation read",
      browser: {
        steps: [
          {
            kind: "find",
            locator: { by: "role", value: "button", name: "Open" },
            action: "click",
            dispatch: true,
          },
        ],
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      },
    };
    const resultIssues = issues(manifest(interactiveRead));
    expect(resultIssues.some((issue) => issue.includes("cannot mark a dispatch step"))).toBeTrue();
    expect(resultIssues.some((issue) => issue.includes("cannot click, fill, type, hover, or press"))).toBeTrue();
    expect(resultIssues.some((issue) => issue.includes("must declare sideEffect as none"))).toBeTrue();
  });
});

describe("schemaVersion 2 workflow model", () => {
  test("restricts every generic semantic operation to its exact reviewed global risk", () => {
    expect(Object.keys(genericSemanticRisks)).toEqual([...semanticOperationNames]);
    for (const operationId of semanticOperationNames) {
      const expectedRisk = genericSemanticRisks[operationId];
      expect(parseManifest(genericPolicyManifest(operationId, expectedRisk)).ok).toBeTrue();
      for (const wrongRisk of operationRisks.filter((risk) => risk !== expectedRisk)) {
        expect(issues(genericPolicyManifest(operationId, wrongRisk)).some((issue) =>
          issue.includes(`risk must be ${expectedRisk} under the generic semantic policy`))).toBeTrue();
      }
    }

    for (const unknownId of ["custom.send", "profile.read"]) {
      const unknown = genericPolicyManifest("messaging.send", "R3");
      const unknownOperations = unknown.operations as Record<string, unknown>;
      unknownOperations[unknownId] = unknownOperations["messaging.send"];
      delete unknownOperations["messaging.send"];
      expect(issues(unknown).some((issue) => issue.includes("reviewed generic semantic vocabulary"))).toBeTrue();
    }
  });

  test("keeps retired known-platform DOM manifests policy-bound but non-executable", () => {
    const valid = parseManifest(blueskyPostManifest());
    expect(valid.ok).toBeFalse();
    if (!valid.ok) expect(valid.issues.some((issue) =>
      issue.includes("browser actions are prohibited"))).toBeTrue();

    const unbound = blueskyPostManifest();
    delete unbound.surfaceId;
    expect(issues(unbound).some((issue) => issue.includes("surfaceId is required"))).toBeTrue();

    const downgraded = blueskyPostManifest();
    downgraded.schemaVersion = 1;
    delete downgraded.surfaceId;
    expect(issues(downgraded).some((issue) => issue.includes("schemaVersion 1 platform adapters are restricted"))).toBeTrue();

    const wrongRisk = blueskyPostManifest();
    const wrongRiskOperation = (wrongRisk.operations as Record<string, Record<string, unknown>>)["posts.publish"];
    if (wrongRiskOperation !== undefined) wrongRiskOperation.risk = "R2";
    expect(issues(wrongRisk).some((issue) => issue.includes("risk must be R3"))).toBeTrue();

    const outsideOrigin = blueskyPostManifest();
    outsideOrigin.origins = ["https://bsky.app", "https://example.com"];
    (outsideOrigin.browserDomains as string[]).push("example.com");
    expect(issues(outsideOrigin).some((issue) => issue.includes("outside the reviewed bluesky policy"))).toBeTrue();

    const unsupported = blueskyPostManifest();
    const unsupportedOperations = unsupported.operations as Record<string, unknown>;
    unsupportedOperations["comments.create"] = unsupportedOperations["posts.publish"];
    delete unsupportedOperations["posts.publish"];
    expect(issues(unsupported).some((issue) => issue.includes("comments.create is not-applicable on bluesky"))).toBeTrue();

    const oversizedText = blueskyPostManifest();
    const oversizedOperation = (oversizedText.operations as Record<string, Record<string, unknown>>)["posts.publish"];
    const oversizedInput = oversizedOperation?.input as Record<string, unknown>;
    const oversizedProperties = oversizedInput.properties as Record<string, Record<string, unknown>>;
    oversizedProperties.body = { ...oversizedProperties.body, maxLength: 281 };
    expect(issues(oversizedText).some((issue) => issue.includes("body.maxLength must be at most 280"))).toBeTrue();

    const wrongMedia = blueskyPostManifest();
    const wrongMediaOperation = (wrongMedia.operations as Record<string, Record<string, unknown>>)["posts.publish"];
    const wrongMediaInput = wrongMediaOperation?.input as Record<string, unknown>;
    const wrongMediaProperties = wrongMediaInput.properties as Record<string, Record<string, unknown>>;
    const attachments = wrongMediaProperties.attachments;
    wrongMediaProperties.attachments = {
      ...attachments,
      maxItems: 2,
      items: { type: "file", description: "Document", maxBytes: 10_000, mediaTypes: ["application/pdf"] },
    };
    const wrongMediaIssues = issues(wrongMedia);
    expect(wrongMediaIssues.some((issue) => issue.includes("at most 1 binary attachment"))).toBeTrue();
    expect(wrongMediaIssues.some((issue) => issue.includes("outside the reviewed attachment kinds"))).toBeTrue();
  });

  test("keeps retired native-thread DOM adapters non-executable", () => {
    const valid = parseManifest(blueskyThreadManifest());
    expect(valid.ok).toBeFalse();
    if (!valid.ok) expect(valid.issues.some((issue) =>
      issue.includes("browser actions are prohibited"))).toBeTrue();

    const oversized = blueskyThreadManifest();
    const operation = (oversized.operations as Record<string, Record<string, unknown>>)["threads.publish"];
    const input = operation?.input as Record<string, unknown>;
    input.required = [];
    expect(issues(oversized).some((issue) => issue.includes("1-25 items"))).toBeTrue();
  });

  test("keeps the retired Marketplace DOM listing adapter non-executable", () => {
    const valid = parseManifest(marketplaceListingManifest());
    expect(valid.ok).toBeFalse();
    if (!valid.ok) {
      expect(valid.issues.some((issue) =>
        issue.includes("browser actions are prohibited"))).toBeTrue();
      return;
    }
    const operation = valid.value.operations["listings.publish"];
    expect(operation).toBeDefined();
    if (operation === undefined) return;
    const acceptedInput: OperationInput = {
      title: "Desk",
      body: "Solid wood desk",
      price: "125.50",
      currency: "USD",
      category: "furniture",
      condition: "used-good",
      location: "Brooklyn, NY",
      delivery: "pickup",
      images: [{ kind: "file", reference: "asset:one" }],
    };
    const accepted = validatePlatformOperationInput(valid.value, "listings.publish", acceptedInput);
    expect(accepted.ok).toBeTrue();

    for (const price of ["0", "12", "12.34"]) {
      expect(validatePlatformOperationInput(valid.value, "listings.publish", { ...acceptedInput, price }).ok).toBeTrue();
    }
    for (const price of ["-1", "01", "1,000", "$12", "1e3", "12.345"]) {
      expect(validatePlatformOperationInput(valid.value, "listings.publish", { ...acceptedInput, price }).ok).toBeFalse();
    }
    for (const currency of ["usd", "Usd", "US", "USDD"]) {
      expect(validatePlatformOperationInput(valid.value, "listings.publish", { ...acceptedInput, currency }).ok).toBeFalse();
    }

    expect(validateOperationInput(operation.input, {
      ...acceptedInput,
      category: "not-a-reviewed-provider-option",
      images: ["asset:one"],
    }, valid.value.origins).ok).toBeFalse();
    expect(validateOperationInput(operation.input, {
      ...acceptedInput,
      images: [],
    }, valid.value.origins).ok).toBeFalse();
    expect(validateOperationInput(operation.input, {
      ...acceptedInput,
      images: ["asset:1", "asset:2", "asset:3", "asset:4", "asset:5"],
    }, valid.value.origins).ok).toBeFalse();

    const invalid = validatePlatformOperationInput(valid.value, "listings.publish", {
      title: "Desk",
      body: "Solid wood desk",
      price: "-1.999",
      currency: "usd",
      category: "furniture",
      condition: "used-good",
      location: "Brooklyn, NY",
      delivery: "pickup",
      images: [{ kind: "file", reference: "asset:one" }],
    });
    expect(invalid.ok).toBeFalse();
    if (!invalid.ok) {
      expect(invalid.issues.some((issue) => issue.includes("non-negative decimal amount"))).toBeTrue();
      expect(invalid.issues.some((issue) => issue.includes("uppercase currency code"))).toBeTrue();
    }

    const missingOptionEnums = marketplaceListingManifest();
    const optionOperation = (missingOptionEnums.operations as Record<string, Record<string, unknown>>)["listings.publish"];
    const input = optionOperation?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    delete properties.category?.enum;
    expect(issues(missingOptionEnums).some((issue) => issue.includes("provider options"))).toBeTrue();

    const impossibleCurrency = marketplaceListingManifest();
    const impossibleOperation = (impossibleCurrency.operations as Record<string, Record<string, unknown>>)["listings.publish"];
    const impossibleInput = impossibleOperation?.input as Record<string, unknown>;
    const impossibleProperties = impossibleInput.properties as Record<string, Record<string, unknown>>;
    impossibleProperties.currency = { ...impossibleProperties.currency, minLength: 1, maxLength: 2 };
    expect(issues(impossibleCurrency).some((issue) => issue.includes("exactly one three-letter currency code"))).toBeTrue();

    for (const field of ["title", "body", "price", "currency", "category", "condition", "location", "delivery"] as const) {
      const missingField = marketplaceListingManifest();
      const missingOperation = (missingField.operations as Record<string, Record<string, unknown>>)["listings.publish"];
      const missingInput = missingOperation?.input as Record<string, unknown>;
      const missingProperties = missingInput.properties as Record<string, unknown>;
      delete missingProperties[field];
      expect(issues(missingField).some((issue) => issue.includes(`properties.${field} is required`))).toBeTrue();

      const omittedRequirement = marketplaceListingManifest();
      const omittedOperation = (omittedRequirement.operations as Record<string, Record<string, unknown>>)["listings.publish"];
      const omittedInput = omittedOperation?.input as Record<string, unknown>;
      omittedInput.required = (omittedInput.required as string[]).filter((name) => name !== field);
      expect(issues(omittedRequirement).some((issue) => issue.includes(`required must include ${field}`))).toBeTrue();
    }

    const tooFewImages = marketplaceListingManifest();
    const tooFewOperation = (tooFewImages.operations as Record<string, Record<string, unknown>>)["listings.publish"];
    const tooFewInput = tooFewOperation?.input as Record<string, unknown>;
    const tooFewProperties = tooFewInput.properties as Record<string, Record<string, unknown>>;
    tooFewProperties.images = { ...tooFewProperties.images, minItems: 0 };
    expect(issues(tooFewImages).some((issue) => issue.includes("must require at least 1 binary attachment"))).toBeTrue();

    const tooManyImages = marketplaceListingManifest();
    const tooManyOperation = (tooManyImages.operations as Record<string, Record<string, unknown>>)["listings.publish"];
    const tooManyInput = tooManyOperation?.input as Record<string, unknown>;
    const tooManyProperties = tooManyInput.properties as Record<string, Record<string, unknown>>;
    tooManyProperties.images = { ...tooManyProperties.images, maxItems: 5 };
    expect(issues(tooManyImages).some((issue) => issue.includes("at most 4 binary attachment"))).toBeTrue();
  });

  test("expands a bounded for-each into an exact named dispatch schedule", () => {
    const parsed = parseManifest(v2ThreadManifest());
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    const operation = parsed.value.operations["messaging.send"];
    expect(operation).toBeDefined();
    expect(operation === undefined || !isBrowserOperation(operation)).toBeFalse();
    if (operation === undefined || !isBrowserOperation(operation)) return;
    const input = validateOperationInput(operation.input, { messages: ["first", "second"] }, parsed.value.origins);
    expect(input.ok).toBeTrue();
    if (!input.ok) return;
    const expanded = expandBrowserRecipe(operation.browser, input.value);
    expect(expanded.dispatches).toEqual([
      { id: "send-message[1]", description: "Send one reviewed message" },
      { id: "send-message[2]", description: "Send one reviewed message" },
    ]);
    expect(expanded.steps.filter(({ step }) => step.kind === "verify-dispatch").map(({ step }) =>
      step.kind === "verify-dispatch" ? step.dispatch : null)).toEqual(["send-message[1]", "send-message[2]"]);
  });

  test("requires explicit prepare/dispatch effects and matching verification groups", () => {
    const missingEffect = v2ThreadManifest();
    const missingOperation = (missingEffect.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const missingBrowser = missingOperation?.browser as Record<string, unknown>;
    const missingSteps = missingBrowser.steps as Record<string, unknown>[];
    const loop = missingSteps[1] as Record<string, unknown>;
    const loopSteps = loop.steps as Record<string, unknown>[];
    loopSteps[0] = { ...loopSteps[0], effect: undefined };
    expect(issues(missingEffect).some((issue) => issue.includes("explicit prepare or dispatch effect"))).toBeTrue();

    const mismatch = v2ThreadManifest();
    const mismatchOperation = (mismatch.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const mismatchBrowser = mismatchOperation?.browser as Record<string, unknown>;
    const mismatchLoop = (mismatchBrowser.steps as Record<string, unknown>[])[1] as Record<string, unknown>;
    const mismatchSteps = mismatchLoop.steps as Record<string, unknown>[];
    mismatchSteps[2] = { ...mismatchSteps[2], dispatch: "different-dispatch" };
    expect(issues(mismatch).some((issue) => issue.includes("must verify active dispatch send-message"))).toBeTrue();
  });

  test("rejects file and array fields in navigation query parameters", () => {
    const arrayCandidate = v2ThreadManifest();
    const arrayOperation = (arrayCandidate.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const arrayBrowser = arrayOperation?.browser as Record<string, unknown>;
    const arraySteps = arrayBrowser.steps as Record<string, unknown>[];
    arraySteps[0] = { kind: "navigate", path: "/messages", query: { value: "messages" } };
    expect(issues(arrayCandidate).some((issue) => issue.includes("query.value must name a scalar input field"))).toBeTrue();

    const fileCandidate = v2ThreadManifest();
    const fileOperation = (fileCandidate.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const fileInput = fileOperation?.input as Record<string, unknown>;
    const fileProperties = fileInput.properties as Record<string, Record<string, unknown>>;
    fileProperties.attachment = { type: "file", description: "Reviewed file", maxBytes: 1_000_000 };
    fileInput.required = ["messages", "attachment"];
    const fileBrowser = fileOperation?.browser as Record<string, unknown>;
    const fileSteps = fileBrowser.steps as Record<string, unknown>[];
    fileSteps[0] = { kind: "navigate", path: "/messages", query: { value: "attachment" } };
    expect(issues(fileCandidate).some((issue) => issue.includes("query.value must name a scalar input field"))).toBeTrue();
  });

  test("rejects a workflow whose bounded expansion can exceed 25 dispatches", () => {
    const candidate = v2ThreadManifest();
    const operation = (candidate.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const input = operation?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    properties.messages = { ...properties.messages, maxItems: 25 };
    const browser = operation?.browser as Record<string, unknown>;
    const topSteps = browser.steps as Record<string, unknown>[];
    const loop = topSteps[1] as Record<string, unknown>;
    const repeated = loop.steps as Record<string, unknown>[];
    repeated.push(
      {
        kind: "press",
        key: "Enter",
        effect: { kind: "dispatch", id: "send-reaction", description: "Send one reviewed reaction" },
      },
      {
        kind: "verify-dispatch",
        dispatch: "send-reaction",
        assertions: [{ kind: "assert-text", text: "Sent" }],
      },
    );
    expect(issues(candidate).some((issue) => issue.includes("at most 25 dispatches"))).toBeTrue();
  });

  test("rejects a write whose valid empty array can schedule zero dispatches", () => {
    const candidate = v2ThreadManifest();
    const operation = (candidate.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const input = operation?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    properties.messages = { ...properties.messages, minItems: 0 };
    expect(issues(candidate).some((issue) => issue.includes("every valid input must schedule at least one named dispatch"))).toBeTrue();
  });

  test("requires exact semantic snapshot refs for select, upload, check, and uncheck", () => {
    const candidate = v2ThreadManifest();
    const operation = (candidate.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const browser = operation?.browser as Record<string, unknown>;
    const topSteps = browser.steps as Record<string, unknown>[];
    const loop = topSteps[1] as Record<string, unknown>;
    const repeated = loop.steps as Record<string, unknown>[];
    repeated[0] = {
      kind: "find",
      locator: { by: "label", value: "Audience", exact: true },
      action: "select",
      with: { item: true },
      effect: { kind: "prepare", description: "Select the audience" },
    };
    expect(issues(candidate).some((issue) => issue.includes("semantic snapshot"))).toBeTrue();
  });

  test("requires upload itself to be a dispatch boundary", () => {
    const candidate = v2ThreadManifest();
    const operation = (candidate.operations as Record<string, Record<string, unknown>>)["messaging.send"];
    const input = operation?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    const messages = properties.messages;
    properties.messages = {
      ...messages,
      items: { type: "file", description: "One reviewed file", maxBytes: 1_000_000 },
    };
    const browser = operation?.browser as Record<string, unknown>;
    const loop = (browser.steps as Record<string, unknown>[])[1] as Record<string, unknown>;
    const repeated = loop.steps as Record<string, unknown>[];
    repeated[0] = {
      kind: "find",
      locator: { by: "role", value: "button", name: "Add media", exact: true },
      action: "upload",
      with: { item: true },
      effect: { kind: "prepare", description: "Select the reviewed file" },
    };
    expect(issues(candidate).some((issue) => issue.includes("must mark upload as dispatch"))).toBeTrue();
  });

  test("validates bounded scalar and opaque file arrays without exposing paths to templates", () => {
    const schema: InputSchema = {
      properties: {
        attachments: {
          type: "array",
          description: "Reviewed attachments",
          minItems: 1,
          maxItems: 2,
          items: { type: "file", description: "One attachment", maxBytes: 1_000_000 },
        },
      },
      required: ["attachments"],
    };
    const valid = validateOperationInput(schema, { attachments: ["asset:one", "asset:two"] }, ["https://example.com"]);
    expect(valid).toEqual({
      ok: true,
      value: {
        attachments: [
          { kind: "file", reference: "asset:one" },
          { kind: "file", reference: "asset:two" },
        ],
      },
    });
    expect(validateOperationInput(schema, { attachments: [] }, ["https://example.com"]).ok).toBeFalse();
    expect(() => expandBrowserRecipe({
      steps: [{ kind: "for-each", input: "attachments", steps: [{ kind: "read" }] }],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }, { attachments: Array.from({ length: 26 }, (_, index) => `item-${index}`) } satisfies OperationInput)).toThrow("exceeds 25 items");
  });

  test("rejects file inputs on an unconfirmed R1 workflow", () => {
    const candidate = v2ThreadManifest({
      risk: "R1",
      sideEffect: "none",
      idempotency: "none",
      dedupeWindowMs: 0,
      input: {
        properties: {
          attachment: { type: "file", description: "Local file", maxBytes: 1_000_000 },
        },
        required: ["attachment"],
      },
      browser: {
        steps: [{ kind: "navigate", path: "/messages" }, { kind: "read" }],
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      },
    });
    expect(issues(candidate).some((issue) => issue.includes("confirmed R2/R3 upload workflow"))).toBeTrue();
  });
});
