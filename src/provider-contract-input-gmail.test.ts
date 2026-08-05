import { describe, expect, test } from "bun:test";

import { gmailProviderConditionalInputIssues } from "./provider-contract-input-gmail";

describe("Gmail provider conditional input", () => {
  test("requires a query only for search", () => {
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "search",
      query: "from:sender@example.com newer_than:7d",
    })).toEqual([]);
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "search",
    })).toContain("input.query is required when view is search");
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "inbox",
      query: "is:unread",
    })).toContain("input.query is not accepted when view is inbox");
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "inbox",
      include_spam_trash: true,
    })).toContain(
      "input.include_spam_trash is accepted only when view is search",
    );
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "search",
      query: "   ",
    })).toContain("input.query must contain a non-whitespace search expression");
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "search",
      query: "x".repeat(513),
    })).toContain(
      "input.query must be a 1-512 character string without unsafe controls",
    );
  });

  test("rejects fractional bounds and unsafe opaque values", () => {
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      limit: 1.5,
      stats_scan_limit: 100.5,
      cursor: "next\npage",
    })).toEqual([
      "input.cursor must be a 1-4096 character string without unsafe controls",
      "input.limit must be a safe integer",
      "input.stats_scan_limit must be a safe integer",
    ]);
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "search",
      query: "in:anywhere",
      include_spam_trash: true,
      limit: 50,
    })).toEqual([]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      limit: 100,
      stats_scan_limit: 2_000,
    })).toContain(
      "input.limit multiplied by input.stats_scan_limit must not exceed 2000",
    );
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      limit: 1,
      stats_scan_limit: 2_000,
    })).toEqual([]);
  });

  test("accepts only exact bounded Gmail thread IDs", () => {
    expect(gmailProviderConditionalInputIssues("messaging.read", {
      thread_id: "18f0AbC_def-123",
    })).toEqual([]);
    expect(gmailProviderConditionalInputIssues("messaging.read", {
      thread_id: "thread/id",
    })).toContain("input.thread_id must be an exact bounded Gmail thread ID");
  });

  test("rejects ill-formed UTF-16 before query or cursor encoding", () => {
    const unpaired = String.fromCharCode(0xd800);
    expect(gmailProviderConditionalInputIssues("messaging.list", {
      view: "search",
      query: `from:reader@example.com${unpaired}`,
      cursor: `page${unpaired}`,
    })).toEqual([
      "input.cursor must be a 1-4096 character string without unsafe controls",
      "input.query must be a 1-512 character string without unsafe controls",
    ]);
  });
});
