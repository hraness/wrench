import type { OperationInput } from "./model";
import type { ProviderPluginOperationName } from "./provider-plugin-identifiers";

function hasUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f
      || code === 0x7f
      || (code >= 0x80 && code <= 0x9f)
      || code === 0x061c
      || code === 0x200e
      || code === 0x200f
      || (code >= 0x2028 && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function boundedTextIssue(
  name: string,
  value: unknown,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  return value.length < 1
      || value.length > maximum
      || !isWellFormedText(value)
      || hasUnsafeControl(value)
    ? `input.${name} must be a 1-${maximum} character string without unsafe controls`
    : null;
}

function safeIntegerIssue(name: string, value: unknown): string | null {
  return typeof value === "number" && !Number.isSafeInteger(value)
    ? `input.${name} must be a safe integer`
    : null;
}

export function gmailProviderConditionalInputIssues(
  action: ProviderPluginOperationName,
  input: OperationInput,
): readonly string[] {
  const issues: string[] = [];
  const cursorIssue = boundedTextIssue("cursor", input.cursor, 4_096);
  if (cursorIssue !== null) issues.push(cursorIssue);

  if (action === "contacts.list") {
    for (const name of ["limit", "stats_scan_limit"] as const) {
      const issue = safeIntegerIssue(name, input[name]);
      if (issue !== null) issues.push(issue);
    }
    const limit = input.limit ?? 20;
    const statsScanLimit = input.stats_scan_limit ?? 100;
    if (
      typeof limit === "number"
      && Number.isSafeInteger(limit)
      && limit >= 1
      && limit <= 100
      && typeof statsScanLimit === "number"
      && Number.isSafeInteger(statsScanLimit)
      && statsScanLimit >= 1
      && statsScanLimit <= 2_000
      && limit * statsScanLimit > 2_000
    ) {
      issues.push("input.limit multiplied by input.stats_scan_limit must not exceed 2000");
    }
  }

  if (action === "messaging.list") {
    const limitIssue = safeIntegerIssue("limit", input.limit);
    if (limitIssue !== null) issues.push(limitIssue);
    if (input.view === "search") {
      if (typeof input.query !== "string") {
        issues.push("input.query is required when view is search");
      } else {
        const queryIssue = boundedTextIssue("query", input.query, 512);
        if (queryIssue !== null) issues.push(queryIssue);
        else if (input.query.trim().length === 0) {
          issues.push("input.query must contain a non-whitespace search expression");
        }
      }
    }
    if (input.view === "inbox" && input.query !== undefined) {
      issues.push("input.query is not accepted when view is inbox");
    }
    if (input.view === "inbox" && input.include_spam_trash !== undefined) {
      issues.push("input.include_spam_trash is accepted only when view is search");
    }
  }

  if (
    action === "messaging.read"
    && typeof input.thread_id === "string"
    && !/^[A-Za-z0-9_-]{1,256}$/u.test(input.thread_id)
  ) {
    issues.push("input.thread_id must be an exact bounded Gmail thread ID");
  }
  return issues;
}
