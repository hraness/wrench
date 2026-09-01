import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  articleDraftDocumentIssues,
  articleDraftDocumentV2Issues,
  parseArticleDraftDocument,
  parseArticleDraftDocumentV2,
} from "../../article-draft-document";
import { articleDraftImageFileInputs } from "../../article-draft-images";
import archivedXWebManifest from "../../assets/adapters/x/wrench-web-adapter.v1.4.0.json";
import archivedXWebPostsPublishV2Manifest from "../../assets/adapters/x/wrench-web-adapter.v1.7.0.json";
import archivedXWebPostsPublishV3Manifest from "../../assets/adapters/x/wrench-web-adapter.v1.9.0.json";
import archivedXWebArticlesReadV1Manifest from "../../assets/adapters/x/wrench-web-adapter.v1.11.0.json";
import archivedXWebLongPostPredecessorManifest from "../../assets/adapters/x/wrench-web-adapter.v1.13.0.json";
import {
  browserSessionAuthKinds,
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import type { OperationInput } from "../../model";
import {
  planWebSessionContractDispatches,
  reviewedArchivedWebSessionContract,
  webSessionContractDefinitions,
} from "../../web-session-contract-definitions";

function xArticleDraftIdentityIssues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues: string[] = [];
  if (
    typeof input.title !== "string"
    || input.title.length < 1
    || input.title.length > 100
    || /[\0\r\n]/u.test(input.title)
  ) {
    issues.push("input.title must be one bounded plain-text line");
  }
  if (
    input.draft_id !== undefined
    && (typeof input.draft_id !== "string" || !/^[0-9]{1,19}$/u.test(input.draft_id))
  ) {
    issues.push("input.draft_id must be one exact 1-19 digit private X Article ID");
  }
  return issues;
}

function xArticleDraftV1Issues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues = [
    ...articleDraftDocumentIssues(input.document, {
      maximumBlocks: 2_000,
      maximumCharacters: 20_000,
    }),
    ...xArticleDraftIdentityIssues(input),
  ];
  if (issues.length === 0) {
    const document = parseArticleDraftDocument(input.document, {
      maximumBlocks: 2_000,
      maximumCharacters: 20_000,
    });
    const linkCount = document.blocks.reduce(
      (total, block) => total + block.links.length,
      0,
    );
    if (document.blocks.some((block) =>
      block.links.some((link) => link.url.length > 2_048))) {
      issues.push("input.document native link URLs must contain at most 2048 UTF-16 code units for X");
    }
    if (linkCount > 2_000) {
      issues.push("input.document must contain at most 2000 native link ranges for X");
    }
  }
  return Object.freeze(issues);
}

function xArticleDraftV2Issues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues = [
    ...articleDraftDocumentV2Issues(input.document, {
      maximumBlocks: 2_000,
      maximumCharacters: 20_000,
      maximumImages: 20,
    }),
    ...xArticleDraftIdentityIssues(input),
  ];
  try {
    articleDraftImageFileInputs(input.inline_images, 20);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "input.inline_images is invalid");
  }
  if (issues.length === 0) {
    const document = parseArticleDraftDocumentV2(input.document, {
      maximumBlocks: 2_000,
      maximumCharacters: 20_000,
      maximumImages: 20,
    });
    const textBlocks = document.blocks.filter((block) => block.type !== "image");
    const linkCount = textBlocks.reduce(
      (total, block) => total + block.links.length,
      0,
    );
    if (textBlocks.some((block) =>
      block.links.some((link) => link.url.length > 2_048))) {
      issues.push("input.document native link URLs must contain at most 2048 UTF-16 code units for X");
    }
    if (linkCount > 2_000) {
      issues.push("input.document must contain at most 2000 native link ranges for X");
    }
    const images = document.blocks.filter((block) => block.type === "image");
    if (images.length !== (input.inline_images as readonly unknown[]).length) {
      issues.push("input.inline_images must match every document imageIndex exactly");
    }
    if (images.some((block) => block.altText !== undefined)) {
      issues.push("X Article inline-image alternative text remains capture-required");
    }
  }
  return Object.freeze(issues);
}

function xArticleDraftV2Dispatches(
  input: Readonly<Record<string, unknown>>,
): readonly { readonly id: string; readonly description: string }[] {
  const count = Array.isArray(input.inline_images) ? input.inline_images.length : 0;
  const images = Array.from({ length: count }, (_, index) => Object.freeze({
    id: `articles.media.inline[${index + 1}]`,
    description: `Upload exact inline image ${index + 1}`,
  }));
  return input.draft_id === undefined
    ? Object.freeze([
        ...images,
        Object.freeze({
          id: "articles.create",
          description: "Create one exact private structured X Article draft",
        }),
      ])
    : Object.freeze([
        ...images,
        Object.freeze({
          id: "articles.title",
          description: "Update the exact private X Article draft title",
        }),
        Object.freeze({
          id: "articles.content",
          description: "Replace the exact private X Article draft content and images",
        }),
      ]);
}

const currentOperations = webSessionContractOperations(
  Object.values(webSessionContractDefinitions.x),
  "c3d649bf6fa94a2f6488fefbafc65e20474993e6c90c99ddf46a82caea6c892d",
  {
    "likes.set": [1],
  },
  {
    "messaging.list": {
      state: "unsupported",
      reason: "X web Chat inbox events are encrypted and require reviewed key recovery before plaintext normalization",
    },
    "messaging.read": {
      state: "unsupported",
      reason: "X web Chat conversation events are encrypted and require reviewed key recovery before plaintext normalization",
    },
  },
  {
    "articles.draft.save": xArticleDraftV2Dispatches,
  },
).map((operation) => {
  if (operation.name === "posts.publish") {
    return Object.freeze({
      ...operation,
      reconciliation: Object.freeze({
        kind: "provider-accepted-target-presence" as const,
      }),
    });
  }
  if (
    operation.name !== "content.save"
    && operation.name !== "likes.set"
    && operation.name !== "articles.draft.save"
  ) {
    return operation;
  }
  if (operation.name === "articles.draft.save") {
    return Object.freeze({
      ...operation,
      validateInput: xArticleDraftV2Issues,
    });
  }
  const stateKey = operation.name === "content.save" ? "saved" : "liked";
  return Object.freeze({
    ...operation,
    reconciliation: Object.freeze({
      kind: "boolean-desired-state" as const,
      desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
        const value = input[stateKey];
        if (typeof value !== "boolean") {
          throw new Error(
            `X ${operation.name} reconciliation requires boolean input.${stateKey}`,
          );
        }
        return value;
      },
    }),
  });
});

const archivedArticleDraftContract = reviewedArchivedWebSessionContract(
  archivedXWebManifest,
  {
    adapterId: "x-web",
    adapterVersion: "1.4.0",
    site: "x",
    operation: "articles.draft.save",
    contractVersion: 1,
    risk: "R2",
    state: "observed",
    implementation: "current Article entity create/title/content mutations save one response-bound private rich-text draft and never call ArticleEntityPublish",
  },
);

const archivedArticleDraftOperation = Object.freeze({
  name: archivedArticleDraftContract.operation,
  contractVersion: archivedArticleDraftContract.contractVersion,
  risk: archivedArticleDraftContract.risk,
  input: archivedArticleDraftContract.input,
  sideEffect: archivedArticleDraftContract.sideEffect,
  idempotency: archivedArticleDraftContract.idempotency,
  dedupeWindowMs: archivedArticleDraftContract.dedupeWindowMs,
  state: archivedArticleDraftContract.state,
  dispatch: archivedArticleDraftContract.dispatch,
  implementation: archivedArticleDraftContract.implementation,
  planDispatches: (input: Readonly<Record<string, unknown>>) => input.draft_id === undefined
    ? Object.freeze([Object.freeze({
        id: "articles.create",
        description: "Create one exact private structured X Article draft",
      })])
    : Object.freeze([
        Object.freeze({
          id: "articles.title",
          description: "Update the exact private X Article draft title",
        }),
        Object.freeze({
          id: "articles.content",
          description: "Replace the exact private X Article draft content",
        }),
      ]),
  validateInput: xArticleDraftV1Issues,
  reconciliation: Object.freeze({
    kind: "boolean-desired-state" as const,
    desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
      if (typeof input.draft_id !== "string") {
        throw new Error(
          "X articles.draft.save create has no safe reconciliation because input.draft_id is absent; preserve the indeterminate run and do not retry",
        );
      }
      return true;
    },
  }),
});

const archivedArticlesReadContract = reviewedArchivedWebSessionContract(
  archivedXWebArticlesReadV1Manifest,
  {
    adapterId: "x-web",
    adapterVersion: "1.11.0",
    site: "x",
    operation: "articles.read",
    contractVersion: 1,
    risk: "R1",
    state: "capture-required",
    implementation:
      "x articles.read@1 was an entitlement-generic Article reservation and remains inert historical identity",
  },
);

const archivedArticlesReadOperation = Object.freeze({
  name: archivedArticlesReadContract.operation,
  contractVersion: archivedArticlesReadContract.contractVersion,
  risk: archivedArticlesReadContract.risk,
  input: archivedArticlesReadContract.input,
  sideEffect: archivedArticlesReadContract.sideEffect,
  idempotency: archivedArticlesReadContract.idempotency,
  dedupeWindowMs: archivedArticlesReadContract.dedupeWindowMs,
  state: archivedArticlesReadContract.state,
  dispatch: archivedArticlesReadContract.dispatch,
  implementation: archivedArticlesReadContract.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedArticlesReadContract, input),
  validateInput: () => Object.freeze([]),
});

function archivedXWebPostsPublishOperation(
  manifest: unknown,
  adapterVersion: string,
  contractVersion: number,
) {
  const contract = reviewedArchivedWebSessionContract(
    manifest,
    {
      adapterId: "x-web",
      adapterVersion,
      site: "x",
      operation: "posts.publish",
      contractVersion,
      risk: "R3",
      state: "observed",
      implementation:
        "optional single-PNG upload plus strict CreateTweet response, durable accepted-target evidence, and bounded independent TweetResultByRestId readback binding",
    },
  );
  return Object.freeze({
    name: contract.operation,
    contractVersion: contract.contractVersion,
    risk: contract.risk,
    input: contract.input,
    sideEffect: contract.sideEffect,
    idempotency: contract.idempotency,
    dedupeWindowMs: contract.dedupeWindowMs,
    state: contract.state,
    dispatch: contract.dispatch,
    implementation: contract.implementation,
    planDispatches: (input: OperationInput) =>
      planWebSessionContractDispatches(contract, input),
    validateInput: () => Object.freeze([]),
    reconciliation: Object.freeze({
      kind: "provider-accepted-target-presence" as const,
    }),
  });
}

function archivedXWebCaptureRequiredOperation(
  manifest: unknown,
  adapterVersion: string,
  operation: "posts.quote" | "content.delete",
  implementation: string,
) {
  const contract = reviewedArchivedWebSessionContract(
    manifest,
    {
      adapterId: "x-web",
      adapterVersion,
      site: "x",
      operation,
      contractVersion: 1,
      risk: "R3",
      state: "capture-required",
      implementation,
    },
  );
  return Object.freeze({
    name: contract.operation,
    contractVersion: contract.contractVersion,
    risk: contract.risk,
    input: contract.input,
    sideEffect: contract.sideEffect,
    idempotency: contract.idempotency,
    dedupeWindowMs: contract.dedupeWindowMs,
    state: contract.state,
    dispatch: contract.dispatch,
    implementation: contract.implementation,
    planDispatches: (input: OperationInput) =>
      planWebSessionContractDispatches(contract, input),
    validateInput: () => Object.freeze([]),
  });
}

const operations = Object.freeze([
  ...currentOperations,
  archivedArticlesReadOperation,
  archivedArticleDraftOperation,
  archivedXWebPostsPublishOperation(
    archivedXWebPostsPublishV2Manifest,
    "1.7.0",
    2,
  ),
  archivedXWebPostsPublishOperation(
    archivedXWebPostsPublishV3Manifest,
    "1.9.0",
    3,
  ),
  archivedXWebPostsPublishOperation(
    archivedXWebLongPostPredecessorManifest,
    "1.13.0",
    4,
  ),
  archivedXWebCaptureRequiredOperation(
    archivedXWebLongPostPredecessorManifest,
    "1.13.0",
    "posts.quote",
    "x posts.quote@1 kept the leftover 280-unit body cap and remains a capture-required reservation",
  ),
  archivedXWebCaptureRequiredOperation(
    archivedXWebLongPostPredecessorManifest,
    "1.13.0",
    "content.delete",
    "x content.delete@1 kept the leftover 280-unit expected_text cap and remains a capture-required reservation",
  ),
]);

export const xWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "x-web",
  version: "1.4.0",
  displayName: "X Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/read-failure.ts", "../../providers/read-failure.ts"],
    ["kernel/browser.ts", "../../browser.ts"],
    ["kernel/article-draft-document.ts", "../../article-draft-document.ts"],
    ["kernel/article-draft-images.ts", "../../article-draft-images.ts"],
    ["providers/x-web.ts", "../../providers/x-web.ts"],
    ["providers/x-web-runtime.ts", "../../providers/x-web-runtime.ts"],
    ["providers/x-transaction-id.ts", "../../providers/x-transaction-id.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "x",
    origin: "https://x.com",
    protectedHostnameFamilies: ["twitter.com", "x.com"],
    authKinds: browserSessionAuthKinds,
    operations,
    subject: {
      format: "1–19 digit X account ID",
      matches: (value) => /^[0-9]{1,19}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/x-web-runtime");
      return {
        probe: runtime.probeXWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeXWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth, context) => {
          if (operation === "posts.publish") {
            if (context?.kind !== "provider-accepted-target-presence") {
              throw new Error("X posts.publish reconciliation requires one exact accepted target");
            }
            const readback = await runtime.readXWebPublishedMutationTarget({
              site: "x",
              action: operation,
              contractVersion: 5,
              timeoutMs: 60_000,
              maxOutputBytes: 2 * 1024 * 1024,
            }, input, auth, context.target.identifier);
            return {
              actualState: readback.present,
              reason: "exact-target-readback",
            };
          }
          if (operation === "articles.draft.save") {
            const readback = await runtime.readXWebArticleDraftDesiredState({
              site: "x",
              action: operation,
              contractVersion: 1,
              timeoutMs: 60_000,
              maxOutputBytes: 2 * 1024 * 1024,
            }, input, auth);
            return {
              actualState: readback.matches,
              reason: "exact-readback",
            };
          }
          if (operation !== "content.save" && operation !== "likes.set") {
            throw new Error(`X ${operation} has no reconciliation hook`);
          }
          const readback = await runtime.readXWebDesiredState({
            site: "x",
            action: operation,
            contractVersion: operation === "content.save" ? 1 : 2,
            timeoutMs: 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
          }, input, auth);
          return {
            actualState: readback.enabled,
            reason: "exact-readback",
          };
        },
      };
    }),
  }],
});

export default xWebPlugin;
