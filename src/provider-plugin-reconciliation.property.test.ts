import { expect, test } from "bun:test";

import {
  parseProviderPluginReconciliationContextV1,
  type ProviderPluginReconciliationContextV1,
} from "./provider-plugin";
import { assertProperty, fc } from "./test-support";

const validContext: ProviderPluginReconciliationContextV1 = Object.freeze({
  schemaVersion: 1,
  kind: "provider-accepted-target-presence",
  dispatch: Object.freeze({
    id: "posts.publish",
    index: 1,
    planned: 1,
  }),
  target: Object.freeze({
    schemaVersion: 1,
    identifier: "property:post:private-123",
  }),
});

const validDeletionContext: ProviderPluginReconciliationContextV1 = Object.freeze({
  schemaVersion: 1,
  kind: "provider-bound-target-desired-state",
  dispatch: Object.freeze({
    id: "content.delete",
    index: 1,
    planned: 1,
  }),
  target: Object.freeze({
    schemaVersion: 1,
    identifier: "property:post:private-123",
  }),
});

test("arbitrary JSON cannot escape exact-target context parsing", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    try {
      const parsed = parseProviderPluginReconciliationContextV1(value);
      expect(parseProviderPluginReconciliationContextV1(
        JSON.parse(JSON.stringify(parsed)) as unknown,
      )).toEqual(parsed);
      expect(Object.isFrozen(parsed)).toBeTrue();
      expect(Object.isFrozen(parsed.dispatch)).toBeTrue();
      expect(Object.isFrozen(parsed.target)).toBeTrue();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(Buffer.byteLength((error as Error).message, "utf8"))
        .toBeLessThanOrEqual(256);
    }
  }));
});

test("exact-target context rejects every unknown field", () => {
  assertProperty(fc.property(
    fc.constantFrom(validContext, validDeletionContext),
    fc.constantFrom("context", "dispatch", "target"),
    fc.string({ minLength: 1, maxLength: 64 }),
    fc.jsonValue(),
    (baseContext, location, key, value) => {
      const selected = location === "context"
        ? baseContext
        : location === "dispatch"
          ? baseContext.dispatch
          : baseContext.target;
      fc.pre(!Object.hasOwn(selected, key));
      const candidate = location === "context"
        ? { ...baseContext, [key]: value }
        : location === "dispatch"
          ? { ...baseContext, dispatch: { ...baseContext.dispatch, [key]: value } }
          : { ...baseContext, target: { ...baseContext.target, [key]: value } };
      expect(() => parseProviderPluginReconciliationContextV1(candidate))
        .toThrow("must contain exactly");
    },
  ));
});
