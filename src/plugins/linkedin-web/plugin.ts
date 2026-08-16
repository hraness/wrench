import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  articleDraftDocumentIssues,
  parseArticleDraftDocument,
} from "../../article-draft-document";
import {
  browserSessionAuthKinds,
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";

const linkedinContracts = webSessionContractDefinitions.linkedin;
if (linkedinContracts === undefined) {
  throw new Error("LinkedIn web-session contracts are not installed");
}

function linkedinArticleDraftIssues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues = [...articleDraftDocumentIssues(input.document, {
    maximumBlocks: 5_000,
    maximumCharacters: 125_000,
  })];
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

const operations = webSessionContractOperations(
  Object.values(linkedinContracts),
  "6db6764bd62b5a01c0c217585053b8453228d1b7f78049a67b2711570358d3b5",
  {},
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
    "articles.draft.save": (input) => input.draft_id === undefined
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
            id: "articles.title",
            description: "Replace the exact private LinkedIn Article title",
          }),
          Object.freeze({
            id: "articles.content",
            description: "Replace the exact private LinkedIn Article document",
          }),
        ]),
  },
).map((operation) => operation.name === "articles.draft.save"
  ? Object.freeze({
      ...operation,
      validateInput: linkedinArticleDraftIssues,
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
    })
  : operation);

export const linkedinWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "linkedin-web",
  version: "1.0.0",
  displayName: "LinkedIn Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/browser.ts", "../../browser.ts"],
    ["kernel/article-draft-document.ts", "../../article-draft-document.ts"],
    ["kernel/session-secrets.ts", "../../session-secrets.ts"],
    ["providers/linkedin-web.ts", "../../providers/linkedin-web.ts"],
    ["providers/linkedin-web-bootstrap.ts", "../../providers/linkedin-web-bootstrap.ts"],
    ["providers/linkedin-web-article-browser.ts", "../../providers/linkedin-web-article-browser.ts"],
    ["providers/linkedin-web-runtime.ts", "../../providers/linkedin-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "linkedin",
    origin: "https://www.linkedin.com",
    protectedHostnameFamilies: ["linkedin.com"],
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
        reconcile: async (operation, input, auth) => {
          if (operation !== "articles.draft.save") {
            throw new Error(`LinkedIn authenticated web operation ${operation} has no desired-state reconciler`);
          }
          const readback = await runtime.readLinkedInWebArticleDraftDesiredState({
            site: "linkedin",
            action: operation,
            contractVersion: 1,
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
