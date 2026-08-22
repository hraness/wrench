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
import {
  articleDraftImageFileInput,
  articleDraftImageFileInputs,
} from "../../article-draft-images";
import archivedLinkedInWebManifest from "../../assets/adapters/linkedin/wrench-web-adapter.v1.8.0.json";
import {
  browserSessionAuthKinds,
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import {
  reviewedArchivedWebSessionContract,
  webSessionContractDefinitions,
} from "../../web-session-contract-definitions";

const linkedinContracts = webSessionContractDefinitions.linkedin;
if (linkedinContracts === undefined) {
  throw new Error("LinkedIn web-session contracts are not installed");
}

function linkedinArticleDraftIdentityIssues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues: string[] = [];
  if (
    typeof input.title !== "string"
    || input.title.length < 1
    || input.title.length > 150
    || /[\0\r\n]/u.test(input.title)
  ) issues.push("input.title must be one bounded plain-text line");
  if (
    input.draft_id !== undefined
    && (typeof input.draft_id !== "string" || !/^[0-9]{1,32}$/u.test(input.draft_id))
  ) issues.push("input.draft_id must be one exact 1-32 digit private LinkedIn Article ID");
  return issues;
}

function linkedinArticleDraftV1Issues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues = [
    ...articleDraftDocumentIssues(input.document, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
    }),
    ...linkedinArticleDraftIdentityIssues(input),
  ];
  if (issues.length === 0) {
    const document = parseArticleDraftDocument(input.document, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
    });
    if (document.blocks.some((block) =>
      block.type !== "paragraph"
      && block.type !== "heading1"
      && block.type !== "heading2")) {
      issues.push("LinkedIn Article drafts currently support only paragraph, heading1, and heading2 blocks");
    }
    if (document.blocks.some((block) => block.styles.length !== 0)) {
      issues.push("LinkedIn Article text styles remain capture-required");
    }
  }
  return Object.freeze(issues);
}

function linkedinArticleDraftV2Issues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues = [
    ...articleDraftDocumentV2Issues(input.document, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
      maximumImages: 20,
    }),
    ...linkedinArticleDraftIdentityIssues(input),
  ];
  if (input.cover_image === undefined) {
    if (input.draft_id === undefined) {
      issues.push("input.cover_image is required when creating a LinkedIn Article draft");
    }
  } else {
    try {
      articleDraftImageFileInput(input.cover_image, "input.cover_image");
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "input.cover_image is invalid");
    }
  }
  try {
    articleDraftImageFileInputs(input.inline_images, 20);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "input.inline_images is invalid");
  }
  if (issues.length === 0) {
    const document = parseArticleDraftDocumentV2(input.document, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
      maximumImages: 20,
    });
    const textBlocks = document.blocks.filter((block) => block.type !== "image");
    if (textBlocks.some((block) =>
      block.type !== "paragraph"
      && block.type !== "heading1"
      && block.type !== "heading2"
      && block.type !== "blockquote")) {
      issues.push("LinkedIn Article drafts currently support only paragraph, heading1, heading2, and blockquote blocks");
    }
    if (textBlocks.some((block) => block.styles.length !== 0)) {
      issues.push("LinkedIn Article text styles remain capture-required");
    }
    const images = document.blocks.filter((block) => block.type === "image");
    if (images.length !== (input.inline_images as readonly unknown[]).length) {
      issues.push("input.inline_images must match every document imageIndex exactly");
    }
    if (images.some((block) => block.altText === undefined)) {
      issues.push("LinkedIn Article inline images require descriptive altText");
    }
    const trailing = document.blocks.at(-1);
    const beforeTrailing = document.blocks.at(-2);
    if (
      trailing?.type === "paragraph"
      && trailing.text === ""
      && beforeTrailing?.type === "image"
    ) {
      issues.push("LinkedIn Article documents must omit the editor-owned empty paragraph after a final image");
    }
  }
  return Object.freeze(issues);
}

function linkedinPostIssues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (input.alt_text === undefined) return Object.freeze([]);
  if (!Array.isArray(input.media) || input.media.length !== 1) {
    return Object.freeze(["input.alt_text requires exactly one input.media PNG"]);
  }
  return Object.freeze([]);
}

function linkedinArticleDraftV2Dispatches(
  input: Readonly<Record<string, unknown>>,
): readonly { readonly id: string; readonly description: string }[] {
  const count = Array.isArray(input.inline_images) ? input.inline_images.length : 0;
  const images = Array.from({ length: count }, (_, index) => Object.freeze({
    id: `articles.image[${index + 1}]`,
    description: `Upload and process exact inline image ${index + 1}`,
  }));
  const cover = Object.freeze({
    id: "articles.cover",
    description: "Upload and bind the exact Article cover image only to LinkedIn's banner slot",
  });
  const covers = input.cover_image === undefined ? [] : [cover];
  return input.draft_id === undefined
    ? Object.freeze([
        Object.freeze({
          id: "articles.create",
          description: "Create one exact private LinkedIn Article title shell",
        }),
        ...covers,
        ...images,
        Object.freeze({
          id: "articles.content",
          description: "Replace the new private LinkedIn Article document and inline images while preserving the confirmed cover",
        }),
      ])
    : Object.freeze([
        ...covers,
        ...images,
        Object.freeze({
          id: "articles.replace",
          description: input.cover_image === undefined
            ? "Bring the exact private LinkedIn Article title, document, and inline images to the confirmed state while preserving its existing banner"
            : "Bring the exact private LinkedIn Article title, cover, document, and inline images to the confirmed state",
        }),
      ]);
}

const currentOperations = webSessionContractOperations(
  Object.values(linkedinContracts),
  "e46975d0843555649e9fd48aa46c31c9ab92bc269103105d804c5fcbfbb74363",
  {
    "posts.publish": [2],
  },
  {
    "messaging.list": {
      state: "unsupported",
      reason: "LinkedIn web mailbox projection and paging remain capture-required",
    },
    "messaging.read": {
      state: "unsupported",
      reason: "LinkedIn web message variables and acknowledgement-free response handling remain capture-required",
    },
  },
  {
    "posts.publish": () => Object.freeze([Object.freeze({
      id: "posts.publish",
      description: "Publish one externally visible LinkedIn post with the exact confirmed audience and content.",
    })]),
    "articles.draft.save": linkedinArticleDraftV2Dispatches,
  },
).map((operation) => {
  if (operation.name === "posts.publish") {
    return Object.freeze({
      ...operation,
      validateInput: linkedinPostIssues,
      reconciliation: Object.freeze({
        kind: "provider-accepted-target-presence" as const,
      }),
    });
  }
  return operation.name === "articles.draft.save"
    ? Object.freeze({
        ...operation,
        validateInput: linkedinArticleDraftV2Issues,
      })
    : operation;
});

const archivedArticleDraftContract = reviewedArchivedWebSessionContract(
  archivedLinkedInWebManifest,
  {
    adapterId: "linkedin-web",
    adapterVersion: "1.8.0",
    site: "linkedin",
    operation: "articles.draft.save",
    contractVersion: 2,
    risk: "R2",
    state: "observed",
    implementation: "reviewed current-member-bound native Article title/content autosave with stable draft identity and exact unpublished server-response readback",
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
    ? Object.freeze([
        Object.freeze({
          id: "articles.create",
          description: "Create one exact private LinkedIn Article title shell",
        }),
        Object.freeze({
          id: "articles.content",
          description: "Replace the new private LinkedIn Article document",
        }),
      ])
    : Object.freeze([
        Object.freeze({
          id: "articles.replace",
          description: "Bring the exact private LinkedIn Article title and document to the confirmed state",
        }),
      ]),
  validateInput: linkedinArticleDraftV1Issues,
  reconciliation: Object.freeze({
    kind: "boolean-desired-state" as const,
    desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
      if (typeof input.draft_id !== "string") {
        throw new Error(
          "LinkedIn articles.draft.save create has no safe reconciliation because input.draft_id is absent; preserve the indeterminate run and do not retry",
        );
      }
      return true;
    },
  }),
});

const operations = Object.freeze([
  ...currentOperations,
  archivedArticleDraftOperation,
]);

export const linkedinWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "linkedin-web",
  version: "1.2.0",
  displayName: "LinkedIn Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/browser.ts", "../../browser.ts"],
    ["kernel/article-draft-document.ts", "../../article-draft-document.ts"],
    ["kernel/article-draft-images.ts", "../../article-draft-images.ts"],
    ["kernel/session-secrets.ts", "../../session-secrets.ts"],
    ["providers/linkedin-web.ts", "../../providers/linkedin-web.ts"],
    ["providers/linkedin-web-bootstrap.ts", "../../providers/linkedin-web-bootstrap.ts"],
    ["providers/linkedin-web-article-browser.ts", "../../providers/linkedin-web-article-browser.ts"],
    ["providers/linkedin-web-post-browser.ts", "../../providers/linkedin-web-post-browser.ts"],
    ["providers/linkedin-web-profile-browser.ts", "../../providers/linkedin-web-profile-browser.ts"],
    ["providers/linkedin-web-runtime.ts", "../../providers/linkedin-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "linkedin",
    origin: "https://www.linkedin.com",
    manifestOrigins: [
      "https://www.linkedin.com",
      "https://static.licdn.com",
    ],
    protectedHostnameFamilies: ["linkedin.com", "licdn.com"],
    authKinds: browserSessionAuthKinds,
    operations,
    subject: {
      format: "urn:li:fsd_profile:<numeric-id>",
      matches: (value) => /^urn:li:fsd_profile:[0-9]{1,32}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/linkedin-web-runtime");
      return {
        probe: runtime.probeLinkedInWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeLinkedInWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth, context) => {
          if (operation === "posts.publish") {
            if (context?.kind !== "provider-accepted-target-presence") {
              throw new Error("LinkedIn posts.publish reconciliation requires one exact accepted target");
            }
            const readback = await runtime.readLinkedInWebAcceptedPostTargetPresence({
              site: "linkedin",
              action: operation,
              contractVersion: 3,
              timeoutMs: 60_000,
              maxOutputBytes: 2 * 1024 * 1024,
            }, input, auth, context.target.identifier);
            return {
              actualState: readback.present,
              reason: "exact-target-readback",
            };
          }
          if (operation !== "articles.draft.save") {
            throw new Error(`LinkedIn authenticated web operation ${operation} has no desired-state reconciler`);
          }
          const readback = await runtime.readLinkedInWebArticleDraftDesiredState({
            site: "linkedin",
            action: operation,
            contractVersion: 2,
            timeoutMs: 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
          }, input, auth);
          return {
            actualState: readback.matches,
            reason: "exact-unpublished-readback",
          };
        },
      };
    }),
  }],
});

export default linkedinWebPlugin;
