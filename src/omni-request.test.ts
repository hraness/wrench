import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  omniRequestDigest,
  openOmniViewCursorV1,
  parseOmniViewRequestV1,
  sealOmniViewCursorV1,
} from "./omni-request";

function environment(): Readonly<Record<string, string | undefined>> {
  return { ...process.env, WRENCH_HOME: mkdtempSync(join(tmpdir(), "wrench-omni-request-")) };
}

const request = {
  schemaVersion: 1,
  sources: [{
    adapterId: "reddit",
    operationId: "messaging.list",
    authId: "reddit-main",
    input: { limit: 25 },
  }],
  filter: { kinds: ["notification", "message"] },
  page: { limit: 20 },
} as const;

describe("omni request", () => {
  test("strictly parses and canonicalizes source and kind order", () => {
    const parsed = parseOmniViewRequestV1({
      schemaVersion: 1,
      sources: [
        { adapterId: "whatsapp", operationId: "messaging.read", authId: "wa", input: { conversation_jid: "1@g.us" } },
        request.sources[0],
      ],
      filter: { kinds: ["notification", "message"] },
    });
    expect(parsed.sources.map((source) => source.adapterId)).toEqual(["reddit", "whatsapp"]);
    expect(parsed.filter?.kinds).toEqual(["message", "notification"]);
    expect(() => parseOmniViewRequestV1({ ...request, extra: true })).toThrow("is not reviewed");
    expect(() => parseOmniViewRequestV1({ ...request, sources: [] })).toThrow("must not be empty");
    expect(() => parseOmniViewRequestV1({ ...request, sources: [request.sources[0], request.sources[0]] })).toThrow("must not repeat");
  });

  test("rejects hostile object protocols before reading values", () => {
    const getter = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => parseOmniViewRequestV1(getter)).toThrow("data property");
    expect(() => parseOmniViewRequestV1(new Proxy(request, {}))).toThrow("non-proxy");
    const sparse = Array<unknown>(1);
    expect(() => parseOmniViewRequestV1({ ...request, sources: sparse })).toThrow("dense");
    const named = [{ ...request.sources[0] }] as unknown[] & { surprise?: boolean };
    named.surprise = true;
    expect(() => parseOmniViewRequestV1({ ...request, sources: named })).toThrow("dense");

    let sourceGetterCalls = 0;
    const accessorSources: unknown[] = [];
    Object.defineProperty(accessorSources, "0", {
      enumerable: true,
      get() {
        sourceGetterCalls += 1;
        return request.sources[0];
      },
    });
    accessorSources.length = 1;
    expect(() => parseOmniViewRequestV1({
      ...request,
      sources: accessorSources,
    })).toThrow("enumerable data property");
    expect(sourceGetterCalls).toBe(0);

    let inputGetterCalls = 0;
    const accessorInput: unknown[] = [];
    Object.defineProperty(accessorInput, "0", {
      enumerable: true,
      get() {
        inputGetterCalls += 1;
        return "unreachable";
      },
    });
    accessorInput.length = 1;
    expect(() => parseOmniViewRequestV1({
      ...request,
      sources: [{ ...request.sources[0], input: { values: accessorInput } }],
    })).toThrow("enumerable data property");
    expect(inputGetterCalls).toBe(0);
  });

  test("bounds JSON values and rejects non-JSON numbers", () => {
    expect(() => parseOmniViewRequestV1({
      ...request,
      sources: [{ ...request.sources[0], input: { limit: Number.NaN } }],
    })).toThrow("finite numbers");
    let nested: unknown = null;
    for (let index = 0; index < 30; index += 1) nested = { nested };
    expect(() => parseOmniViewRequestV1({
      ...request,
      sources: [{ ...request.sources[0], input: { nested } }],
    })).toThrow("nesting bound");

    const polluted = JSON.parse(
      '{"__proto__":{"polluted":true},"folder":"inbox"}',
    ) as Record<string, unknown>;
    const parsed = parseOmniViewRequestV1({
      ...request,
      sources: [{ ...request.sources[0], input: polluted }],
    });
    expect(Object.getPrototypeOf(parsed.sources[0]?.input)).toBeNull();
    expect(parsed.sources[0]?.input).toHaveProperty("__proto__", {
      polluted: true,
    });
    const cleanObject: { polluted?: boolean } = {};
    expect(cleanObject.polluted).toBeUndefined();
  });

  test("request identity excludes only the page cursor", () => {
    const parsed = parseOmniViewRequestV1(request);
    const withCursor = parseOmniViewRequestV1({
      ...request,
      page: { limit: 20, cursor: "opaque" },
    });
    expect(omniRequestDigest(withCursor)).toBe(omniRequestDigest(parsed));
    expect(omniRequestDigest(parseOmniViewRequestV1({
      ...request,
      page: { limit: 21 },
    }))).not.toBe(omniRequestDigest(parsed));
  });

  test("round trips an authenticated cursor and fences every identity", () => {
    const parsed = parseOmniViewRequestV1(request);
    const sourceSet = "a".repeat(64);
    const view = "b".repeat(64);
    const anchor = { orderedAt: "2026-08-01T12:00:00.000Z", id: "c".repeat(64) } as const;
    const env = environment();
    const token = sealOmniViewCursorV1(parsed, sourceSet, view, anchor, env);
    expect(openOmniViewCursorV1(parsed, sourceSet, view, token, env)).toEqual(anchor);
    expect(() => openOmniViewCursorV1(parsed, "d".repeat(64), view, token, env)).toThrow();
    expect(() => openOmniViewCursorV1(parsed, sourceSet, "e".repeat(64), token, env)).toThrow("invalidated");
    expect(() => openOmniViewCursorV1(
      parseOmniViewRequestV1({ ...request, filter: { kinds: ["conversation"] } }),
      sourceSet,
      view,
      token,
      env,
    )).toThrow("does not belong");
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(() => openOmniViewCursorV1(parsed, sourceSet, view, tampered, env)).toThrow();
  });
});
