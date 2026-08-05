import { describe, expect, test } from "bun:test";

import { isGmailAccountSubject } from "./provider-subject";

describe("Gmail provider subject", () => {
  test.each([
    "reader@gmail.com",
    "Reader.Name+archive@GMAIL.COM",
    "operator_1@team.example.org",
  ])("accepts bounded ASCII mailbox subject %s", (subject) => {
    expect(isGmailAccountSubject(subject)).toBeTrue();
  });

  test.each([
    " reader@gmail.com",
    "reader@gmail.com\nspoofed",
    ".reader@gmail.com",
    "reader..archive@gmail.com",
    "reader@localhost",
    "reader@-example.com",
    "reader@example-.com",
    "réader@gmail.com",
    `${"a".repeat(65)}@gmail.com`,
  ])("rejects ambiguous Gmail mailbox subject %s", (subject) => {
    expect(isGmailAccountSubject(subject)).toBeFalse();
  });
});
