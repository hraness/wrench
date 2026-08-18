import { expect, test } from "bun:test";

import { canonicalJson, sha256 } from "./model";
import {
  parseProviderAcceptedMutationTargetEvidence,
  type ProviderAcceptedMutationTargetEvidence,
} from "./recovery";
import { assertProperty, fc } from "./test-support";

const input = Object.freeze({ body: "property input" });
const validEvidence: ProviderAcceptedMutationTargetEvidence = Object.freeze({
  schemaVersion: 1,
  runId: "10000000-0000-4000-8000-000000000001",
  acceptedAt: "2026-08-18T12:00:01.000Z",
  planDigest: "a".repeat(64),
  adapter: Object.freeze({
    id: "property-web",
    version: "1.0.0",
    hash: "b".repeat(64),
  }),
  operation: "posts.publish",
  inputHash: sha256(canonicalJson(input)),
  auth: Object.freeze({
    id: "property-main",
    hash: "c".repeat(64),
    kind: "cookie-source",
  }),
  contract: Object.freeze({
    transport: "web-session-api",
    site: "property",
    action: "posts.publish",
    version: 1,
    hash: "d".repeat(64),
  }),
  dispatch: Object.freeze({
    id: "posts.publish",
    index: 1,
    planned: 1,
  }),
  target: Object.freeze({
    schemaVersion: 1,
    identifier: "property:post:123",
  }),
});

test("arbitrary JSON cannot escape accepted-target evidence parsing", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    try {
      const parsed = parseProviderAcceptedMutationTargetEvidence(value);
      expect(parseProviderAcceptedMutationTargetEvidence(
        JSON.parse(JSON.stringify(parsed)) as unknown,
      )).toEqual(parsed);
      expect(Object.isFrozen(parsed)).toBeTrue();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(Buffer.byteLength((error as Error).message, "utf8"))
        .toBeLessThanOrEqual(256);
    }
  }));
});

test("every unknown accepted-target evidence field is rejected", () => {
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 64 })
      .filter((key) => !Object.hasOwn(validEvidence, key)),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseProviderAcceptedMutationTargetEvidence({
        ...validEvidence,
        [key]: value,
      })).toThrow("unsupported fields");
    },
  ));
});
