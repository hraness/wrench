import { describe, expect, test } from "bun:test";

import { linkedinProviderConditionalInputIssues } from "./provider-contract-input-linkedin";

describe("LinkedIn provider conditional input", () => {
  test("accepts exact bounded connection paging integers", () => {
    expect(linkedinProviderConditionalInputIssues("contacts.list", {
      start: 0,
      count: 50,
    })).toEqual([]);
  });

  test("rejects fractional connection paging values", () => {
    expect(linkedinProviderConditionalInputIssues("contacts.list", {
      start: 1.5,
      count: 10.5,
    })).toEqual([
      "input.start must be a safe integer",
      "input.count must be a safe integer",
    ]);
  });
});
