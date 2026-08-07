import type { OperationInput } from "./model";
import type { ProviderPluginOperationName } from "./provider-plugin-identifiers";

export function linkedinProviderConditionalInputIssues(
  action: ProviderPluginOperationName,
  input: OperationInput,
): readonly string[] {
  const issues: string[] = [];
  if (action === "contacts.list") {
    for (const name of ["start", "count"] as const) {
      if (typeof input[name] === "number" && !Number.isSafeInteger(input[name])) {
        issues.push(`input.${name} must be a safe integer`);
      }
    }
  }
  if (action === "posts.read") {
    if (input.mode === "one") {
      if (typeof input.post_urn !== "string") {
        issues.push("input.post_urn is required when mode is one");
      }
      if (input.author !== undefined) {
        issues.push("input.author is not accepted when mode is one");
      }
    }
    if (input.mode === "author") {
      if (typeof input.author !== "string") {
        issues.push("input.author is required when mode is author");
      }
      if (input.post_urn !== undefined) {
        issues.push("input.post_urn is not accepted when mode is author");
      }
    }
  }
  if (action === "posts.publish") {
    const media = input.media;
    if (Array.isArray(media) && typeof input.article_url === "string") {
      issues.push("input.media and input.article_url are mutually exclusive");
    }
    if (typeof input.article_url === "string") {
      try {
        const url = new URL(input.article_url);
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
          issues.push("input.article_url must be a credential-free HTTPS URL");
        }
      } catch {
        issues.push("input.article_url must be a credential-free HTTPS URL");
      }
      if (typeof input.article_title !== "string") {
        issues.push("input.article_title is required with input.article_url");
      }
    } else if (
      input.article_title !== undefined
      || input.article_description !== undefined
    ) {
      issues.push(
        "input.article_title and input.article_description require input.article_url",
      );
    }
    if (input.alt_text !== undefined && !Array.isArray(media)) {
      issues.push("input.alt_text requires input.media");
    }
    if (input.media_title !== undefined && !Array.isArray(media)) {
      issues.push("input.media_title requires input.media");
    }
  }
  if (action === "reactions.set") {
    if (input.enabled === true && typeof input.reaction !== "string") {
      issues.push("input.reaction is required when input.enabled is true");
    }
    if (input.enabled === false && input.reaction !== undefined) {
      issues.push(
        "input.reaction is not accepted when input.enabled is false because the operation clears any current reaction",
      );
    }
  }
  return issues;
}
