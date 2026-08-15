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

function xArticleDraftIssues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues = [...articleDraftDocumentIssues(input.document, {
    maximumBlocks: 2_000,
    maximumCharacters: 20_000,
  })];
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

const operations = webSessionContractOperations(
  Object.values(webSessionContractDefinitions.x),
  "fb1bbf6b21ad0de15dca8ff5c4cd50e81c66a2602b131cb299c15721dbac7ae7",
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
    "articles.draft.save": (input) => input.draft_id === undefined
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
  },
).map((operation) => {
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
      validateInput: xArticleDraftIssues,
      reconciliation: Object.freeze({
        kind: "boolean-desired-state" as const,
        desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
          if (
            typeof input.draft_id !== "string"
          ) {
            throw new Error(
              "X articles.draft.save create has no safe reconciliation because input.draft_id is absent; preserve the indeterminate run and do not retry",
            );
          }
          return true;
        },
      }),
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

export const xWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "x-web",
  version: "1.0.0",
  displayName: "X Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/browser.ts", "../../browser.ts"],
    ["kernel/article-draft-document.ts", "../../article-draft-document.ts"],
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
        reconcile: async (operation, input, auth) => {
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
