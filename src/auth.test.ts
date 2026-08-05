import { describe, expect, test } from "bun:test";

import {
  createAuth,
  normalizeOAuthScopes,
  parseAuth,
} from "./auth";

describe("OAuth scope normalization", () => {
  test("accepts and sorts canonical HTTPS provider scopes", () => {
    expect(normalizeOAuthScopes([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
    ])).toEqual([
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(normalizeOAuthScopes(["tweet.read", "users.read"]))
      .toEqual(["tweet.read", "users.read"]);
    expect(normalizeOAuthScopes(["https://mail.google.com/"]))
      .toEqual(["https://mail.google.com/"]);
    expect(normalizeOAuthScopes([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/contacts",
    ])).toEqual([
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);

    const gmail = createAuth("gmail-main", {
      oauthProvider: "gmail",
      tokenFile: "/private/gmail-token.json",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
      ],
      subject: "reader@gmail.com",
    });
    expect(gmail).toMatchObject({
      kind: "oauth-token-file",
      provider: "gmail",
      scopes: [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      subject: "reader@gmail.com",
    });
    expect(parseAuth(gmail)).toEqual(gmail);
  });

  test.each([
    "http://www.googleapis.com/auth/gmail.readonly",
    "https://user@example.com/auth/read",
    "https://www.googleapis.com/",
    "https://www.googleapis.com/auth/read?audience=all",
    "https://www.googleapis.com/auth/read#fragment",
    "https://localhost/auth/read",
    "https://www.googleapis.com/auth/read%0Aspoofed",
  ])("rejects unsafe URL-form OAuth scope %s", (scope) => {
    expect(() => normalizeOAuthScopes([scope])).toThrow(
      "provider scope names or canonical HTTPS scope URLs",
    );
  });

  test.each([
    "o'connor@example.com",
    "reader!tag@example.com",
  ])("round-trips a safe Google Workspace mailbox subject %s", (subject) => {
    const auth = createAuth("gmail-punctuation", {
      oauthProvider: "gmail",
      tokenFile: "/private/gmail-token.json",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      subject,
    });
    expect(parseAuth(auth)).toEqual(auth);
  });
});
