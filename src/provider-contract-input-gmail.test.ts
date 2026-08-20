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
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      include_stats: false,
      limit: 100,
    })).toEqual([]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      include_stats: false,
      stats_scan_limit: 1,
    })).toContain(
      "input.stats_scan_limit is accepted only when include_stats is true",
    );
  });

  test("enforces the three exact Google contact projection shapes", () => {
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "contacts",
      include_dates: false,
    }, 4)).toEqual([
      "input.include_dates is available only in contacts.list contract v5",
    ]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "contacts",
      include_dates: true,
      limit: 20,
      stats_scan_limit: 100,
    }, 5)).toEqual([]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "other-contacts",
      include_dates: false,
      limit: 20,
      stats_scan_limit: 100,
    })).toEqual([]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "other-contacts",
      include_dates: true,
      limit: 20,
      stats_scan_limit: 100,
    })).toEqual([
      "input.include_dates is supported only for saved contacts",
    ]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "interactions",
      before: "2026-08-14T12:00:00.000Z",
      limit: 100,
    })).toEqual([]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "interactions",
      include_dates: false,
      before: "2026-08-14T12:00:00.000Z",
      limit: 100,
    })).toEqual([
      "input.include_dates is not accepted for the interactions collection",
    ]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "interactions",
      include_stats: false,
    })).toEqual([
      "input.include_stats is not accepted for the interactions collection",
      "input.before is required for the interactions collection",
    ]);
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "contacts",
      before: "2026-08-14T12:00:00.000Z",
    })).toContain("input.before is accepted only for the interactions collection");
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "contacts",
      after: "2026-08-14T11:00:00.000Z",
    })).toContain("input.after is accepted only for the interactions collection");
    expect(gmailProviderConditionalInputIssues("contacts.list", {
      collection: "interactions",
      after: "2026-08-14T12:00:00.000Z",
      before: "2026-08-14T12:00:00.000Z",
    })).toContain("input.after must precede input.before");
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
