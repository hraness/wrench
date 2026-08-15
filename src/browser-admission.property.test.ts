import { expect, test } from "bun:test";

import {
  parseBrowserAdmissionClaim,
  type BrowserAdmissionClaim,
} from "./browser-admission";
import { canonicalJson } from "./canonical-json";
import { assertProperty, fc } from "./test-support";

const digestArbitrary = fc.integer({ min: 0, max: 15 }).map(
  (nibble) => nibble.toString(16).repeat(64),
);
const timestampArbitrary = fc.integer({ min: 0, max: 86_400_000 }).map(
  (offset) => new Date(Date.parse("2026-08-15T00:00:00.000Z") + offset).toISOString(),
);

test("every generated exact browser claim round-trips canonically", () => {
  assertProperty(fc.property(
    fc.constantFrom<0 | 1>(0, 1),
    fc.integer({ min: 1, max: 2_147_483_647 }),
    digestArbitrary,
    digestArbitrary,
    timestampArbitrary,
    (slot, pid, bootId, processStartId, acquiredAt) => {
      const claim: BrowserAdmissionClaim = {
        schemaVersion: 1,
        slot,
        acquiredAt,
        owner: {
          pid,
          token: "11111111-1111-4111-8111-111111111111",
          bootId,
          processStartId,
        },
      };
      const parsed = parseBrowserAdmissionClaim(
        JSON.parse(canonicalJson(claim)) as unknown,
      );
      expect(parsed).toEqual(claim);
      expect(canonicalJson(parsed)).toBe(canonicalJson(claim));
    },
  ));
});

test("no arbitrary extra field can enter an otherwise valid claim", () => {
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 32 }).filter(
      (key) => !["schemaVersion", "slot", "acquiredAt", "owner"].includes(key),
    ),
    fc.jsonValue(),
    (key, value) => {
      const claim: Record<string, unknown> = {
        schemaVersion: 1,
        slot: 0,
        acquiredAt: "2026-08-15T00:00:00.000Z",
        owner: {
          pid: 123,
          token: "11111111-1111-4111-8111-111111111111",
          bootId: "a".repeat(64),
          processStartId: "b".repeat(64),
        },
      };
      Object.defineProperty(claim, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      expect(() => parseBrowserAdmissionClaim(claim)).toThrow();
    },
  ));
});

test("an enumerable __proto__ field remains visible to exact-key parsing", () => {
  const claim: Record<string, unknown> = {
    schemaVersion: 1,
    slot: 0,
    acquiredAt: "2026-08-15T00:00:00.000Z",
    owner: {
      pid: 123,
      token: "11111111-1111-4111-8111-111111111111",
      bootId: "a".repeat(64),
      processStartId: "b".repeat(64),
    },
  };
  Object.defineProperty(claim, "__proto__", {
    enumerable: true,
    value: 0,
  });
  expect(() => parseBrowserAdmissionClaim(claim)).toThrow("unsupported fields");
});

test("an owner __proto__ field remains visible to exact-key parsing", () => {
  const owner: Record<string, unknown> = {
    pid: 123,
    token: "11111111-1111-4111-8111-111111111111",
    bootId: "a".repeat(64),
    processStartId: "b".repeat(64),
  };
  Object.defineProperty(owner, "__proto__", {
    enumerable: true,
    value: 0,
  });
  expect(() => parseBrowserAdmissionClaim({
    schemaVersion: 1,
    slot: 0,
    acquiredAt: "2026-08-15T00:00:00.000Z",
    owner,
  })).toThrow("unsupported fields");
});

test("foreign JSON either fails strict parsing or normalizes to the exact schema", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    try {
      const parsed = parseBrowserAdmissionClaim(value);
      expect(Object.keys(parsed).sort()).toEqual([
        "acquiredAt",
        "owner",
        "schemaVersion",
        "slot",
      ]);
      expect(Object.keys(parsed.owner).sort()).toEqual([
        "bootId",
        "pid",
        "processStartId",
        "token",
      ]);
      expect(parseBrowserAdmissionClaim(
        JSON.parse(canonicalJson(parsed)) as unknown,
      )).toEqual(parsed);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  }));
});
