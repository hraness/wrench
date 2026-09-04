import type { InputField, InputSchema } from "../../model";
import type { WebSessionContract } from "../../web-session-contract-definitions";

export const REDDIT_FLAIR_OPERATION_NAMES = [
  "flair.user.choices",
  "flair.post.choices",
  "flair.user.select",
  "flair.post.select",
] as const;

export type RedditFlairOperation = (typeof REDDIT_FLAIR_OPERATION_NAMES)[number];

type FlairTarget =
  | { readonly kind: "user"; readonly community: string }
  | { readonly kind: "post"; readonly community: string; readonly postId: string };

export type RedditFlairInput =
  | { readonly action: "choices"; readonly target: FlairTarget }
  | {
      readonly action: "select";
      readonly target: FlairTarget;
      readonly templateId: string;
      readonly expectedText: string;
    };

export function isRedditFlairOperation(value: string): value is RedditFlairOperation {
  return REDDIT_FLAIR_OPERATION_NAMES.some((operation) => operation === value);
}

export function parseRedditFlairInput(
  operation: RedditFlairOperation,
  value: unknown,
): RedditFlairInput {
  if (!isRedditFlairOperation(operation)) throw new Error("Unsupported Reddit flair operation");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Reddit flair input must be an object");
  }
  const input = value as Record<string, unknown>;
  const isPost = operation.startsWith("flair.post.");
  const isSelect = operation.endsWith(".select");
  const required = ["community", ...(isPost ? ["post_id"] : []),
    ...(isSelect ? ["template_id", "expected_text"] : [])];
  if (Object.keys(input).length !== required.length
    || required.some((key) => !Object.hasOwn(input, key))) {
    throw new Error("Reddit flair input contains missing or unsupported fields");
  }
  const community = input.community;
  if (typeof community !== "string" || !/^[A-Za-z0-9_]{2,21}$/u.test(community)) {
    throw new Error("Reddit flair community must be an exact subreddit name");
  }
  let target: FlairTarget = { kind: "user", community };
  if (isPost) {
    const postId = input.post_id;
    if (typeof postId !== "string" || !/^t3_[a-z0-9]{1,32}$/u.test(postId)) {
      throw new Error("Reddit post flair requires an exact post fullname");
    }
    target = { kind: "post", community, postId };
  }
  if (!isSelect) return { action: "choices", target };
  const templateId = input.template_id;
  if (typeof templateId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(templateId)) {
    throw new Error("Reddit flair selection requires a canonical template ID");
  }
  const expectedText = input.expected_text;
  if (typeof expectedText !== "string" || expectedText.length < 1
    || expectedText.length > 256 || /[\u0000-\u001f\u007f]/u.test(expectedText)
    || expectedText.trim() !== expectedText) {
    throw new Error("Reddit flair selection requires a bounded exact label");
  }
  return { action: "select", target, templateId, expectedText };
}

const communityField = {
  type: "string", description: "Exact subreddit name without r/", minLength: 2, maxLength: 21,
} as const satisfies InputField;

export const redditFlairContracts: readonly WebSessionContract[] = Object.freeze(
  REDDIT_FLAIR_OPERATION_NAMES.map((operation): WebSessionContract => {
    const isPost = operation.startsWith("flair.post.");
    const isSelect = operation.endsWith(".select");
    const properties: Record<string, InputField> = { community: communityField };
    if (isPost) properties.post_id = {
      type: "string", description: "Exact t3_ fullname of the current account's post",
      minLength: 4, maxLength: 35,
    };
    if (isSelect) {
      properties.template_id = {
        type: "string", description: "Exact self-selectable template ID from a fresh choices read",
        minLength: 36, maxLength: 36,
      };
      properties.expected_text = {
        type: "string", description: "Exact label from that same choices read; not custom flair text",
        minLength: 1, maxLength: 256,
      };
    }
    const input: InputSchema = {
      properties: Object.freeze(properties), required: Object.freeze(Object.keys(properties)),
    };
    return Object.freeze({
      site: "reddit", operation, contractVersion: 1,
      risk: isSelect ? (isPost ? "R3" : "R2") : "R1",
      input,
      sideEffect: isSelect
        ? (isPost ? "Select one flair on the current account's exact post"
          : "Select one community user flair for the current account")
        : "none",
      idempotency: isSelect ? "local-at-most-once" : "none",
      dedupeWindowMs: isSelect ? 300_000 : 0,
      state: "capture-required", dispatch: isSelect ? "single" : "none",
      implementation: "Reddit flair requires reviewed same-account choice, selection, and readback evidence; no request is installed",
    });
  }),
);
