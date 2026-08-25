/**
 * Fail-closed detection of X's Made with AI / sparkle disclosure.
 *
 * A live label is a terminal unlabeled-copy failure. The post may already
 * exist; do not delete it. The run journal forbids `failed` after dispatch
 * starts, so x-web reports `indeterminate` with this error.
 */

export const X_UNLABELED_COPY_POLICY_ERROR =
  "X applied Made with AI label; publish failed for unlabeled-copy policy";

const DISCLOSURE_KEY = /^(made_with_ai|content_disclosure|ai_generated_disclosure|ai_generated|is_ai_generated|has_ai_generated_media|ai_highlight(?:_label|_info)?|grok_generated|trained_algorithmic_media|digital_source_type)$/iu;
const DISCLOSURE_TEXT = /made with (?:ai|grok)|ai-generated content|trainedalgorithmicmedia|digitalsourcetype/iu;
const AUTHOR_TEXT_KEYS = new Set([
  "full_text",
  "description",
  "screen_name",
  "location",
  "username",
]);

export class XUnlabeledCopyPolicyError extends Error {
  readonly post: { readonly id: string; readonly url: string } | undefined;

  constructor(post?: { readonly id: string; readonly url: string }) {
    super(X_UNLABELED_COPY_POLICY_ERROR);
    this.name = "XUnlabeledCopyPolicyError";
    this.post = post;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipAuthorText(key: string, ancestors: readonly string[]): boolean {
  if (AUTHOR_TEXT_KEYS.has(key)) return true;
  if (key === "name") {
    return ancestors.includes("user_results") || ancestors.includes("core") || ancestors.includes("user");
  }
  if (key !== "text") return false;
  return ancestors.includes("legacy") || ancestors.includes("note_tweet");
}

function annotationLooksLikeAi(value: unknown): boolean {
  if (typeof value === "string") return DISCLOSURE_TEXT.test(value) || DISCLOSURE_KEY.test(value);
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (DISCLOSURE_KEY.test(key)) return true;
    if (typeof item === "string" && (DISCLOSURE_TEXT.test(item) || DISCLOSURE_KEY.test(item))) {
      return true;
    }
  }
  return false;
}

function walkTweet(
  value: unknown,
  ancestors: readonly string[],
): boolean {
  if (typeof value === "string") {
    const key = ancestors.at(-1) ?? "";
    if (skipAuthorText(key, ancestors.slice(0, -1))) return false;
    return DISCLOSURE_TEXT.test(value) || DISCLOSURE_KEY.test(value);
  }
  if (typeof value === "boolean") {
    const key = ancestors.at(-1) ?? "";
    return value === true && DISCLOSURE_KEY.test(key);
  }
  if (Array.isArray(value)) {
    const key = ancestors.at(-1) ?? "";
    if (
      (key === "semantic_annotations" || key === "semantic_annotation_ids")
      && value.some(annotationLooksLikeAi)
    ) {
      return true;
    }
    return value.some((item) => walkTweet(item, ancestors));
  }
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (DISCLOSURE_KEY.test(key)) {
      if (item === true) return true;
      if (typeof item === "string" && item.length > 0 && item !== "false") return true;
      if (isRecord(item) || Array.isArray(item)) {
        if (walkTweet(item, [...ancestors, key])) return true;
      }
      continue;
    }
    if (walkTweet(item, [...ancestors, key])) return true;
  }
  return false;
}

export function xTweetHasMadeWithAiLabel(value: unknown): boolean {
  return walkTweet(value, []);
}

export function rejectXTweetMadeWithAiLabel(
  value: unknown,
  post?: { readonly id: string; readonly url: string },
): void {
  if (xTweetHasMadeWithAiLabel(value)) {
    throw new XUnlabeledCopyPolicyError(post);
  }
}
