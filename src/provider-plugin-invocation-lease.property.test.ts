import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support";

import {
  parsePortableProviderPluginInvocationLease,
  type PortableProviderPluginInvocationLease,
} from "./provider-plugin-invocation-lease";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const uuid = "12345678-1234-4123-8123-123456789abc";

const validLease: PortableProviderPluginInvocationLease = {
  schemaVersion: 1,
  leaseId: uuid,
  runId: uuid,
  identity: {
    pluginId: "portable-test",
    pluginVersion: "1.0.0",
    hostApiVersion: 1,
    bundleSha256: hashA,
    manifestSha256: hashB,
    adapterId: "portable-test",
    transport: "provider-api",
    surfaceId: "portable-test",
    operation: "records.read",
    contractVersion: 1,
    descriptorSha256: hashC,
  },
  owner: {
    pid: 123,
    token: uuid,
    bootId: hashA,
    processStartId: hashB,
  },
  acquiredAt: "2026-07-25T12:00:00.000Z",
};

test("arbitrary JSON cannot escape strict invocation lease parsing", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    try {
      const parsed = parsePortableProviderPluginInvocationLease(value);
      expect(parsePortableProviderPluginInvocationLease(
        JSON.parse(JSON.stringify(parsed)) as unknown,
      )).toEqual(parsed);
      expect(Object.isFrozen(parsed)).toBeTrue();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  }));
});

test("every unknown top-level lease field is inert", () => {
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 64 })
      .filter((key) => !Object.hasOwn(validLease, key)),
    fc.jsonValue(),
    (key, value) => {
      expect(() =>
        parsePortableProviderPluginInvocationLease({
          ...validLease,
          [key]: value,
        })
      ).toThrow("unsupported fields");
    },
  ));
});
