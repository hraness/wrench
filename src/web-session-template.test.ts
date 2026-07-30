import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support";

import type { InputSchema } from "./model";
import {
  parseWebSessionTemplate,
  webSessionMethods,
  type ParseWebSessionTemplateOptions,
} from "./web-session-template";

const input = {
  properties: {
    post_id: {
      type: "string",
      description: "Post identifier",
      format: "path-segment",
      minLength: 1,
      maxLength: 128,
    },
    text: { type: "string", description: "Post text", minLength: 1, maxLength: 8_000 },
    count: { type: "number", description: "Count", minimum: 0, maximum: 1_000 },
    published: { type: "boolean", description: "Published state" },
    tags: {
      type: "array",
      description: "Tags",
      items: { type: "string", description: "Tag", minLength: 1, maxLength: 100 },
      minItems: 0,
      maxItems: 10,
    },
    attachment: { type: "file", description: "Attachment", maxBytes: 1_000_000 },
    optional_text: { type: "string", description: "Optional text", maxLength: 100 },
  },
  required: ["post_id", "text", "count", "published", "tags"],
} as const satisfies InputSchema;

const options = {
  input,
  allowedOrigins: ["https://x.com", "https://www.linkedin.com"],
} as const satisfies ParseWebSessionTemplateOptions;

function literal(value: null | string | number | boolean): Record<string, unknown> {
  return { kind: "literal", value };
}

function source(name: string, valueType: string): Record<string, unknown> {
  return { kind: "input", name, valueType };
}

function hasHttpControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validRequest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    method: "POST",
    path: [
      { kind: "literal", value: "i" },
      { kind: "literal", value: "api" },
      { kind: "literal", value: "graphql" },
      source("post_id", "string"),
    ],
    query: [
      {
        name: "variables",
        encoding: "json",
        value: {
          kind: "object",
          entries: [
            { name: "postId", value: source("post_id", "string") },
            { name: "tags", value: source("tags", "string[]") },
          ],
        },
      },
      { name: "includePromoted", encoding: "scalar", value: literal(false) },
    ],
    headers: [
      { name: "accept", value: literal("application/json") },
      { name: "x-twitter-auth-type", value: literal("OAuth2Session") },
      {
        name: "x-csrf-token",
        value: {
          kind: "browser-csrf",
          source: { kind: "cookie", name: "ct0" },
          transform: "identity",
        },
      },
      {
        name: "authorization",
        value: {
          kind: "browser-authorization",
          source: { kind: "captured-header", name: "authorization" },
          transform: "identity",
        },
      },
    ],
    body: {
      kind: "json",
      value: {
        kind: "object",
        entries: [
          { name: "text", value: source("text", "string") },
          { name: "count", value: source("count", "number") },
          { name: "published", value: source("published", "boolean") },
          {
            name: "metadata",
            value: {
              kind: "object",
              entries: [{ name: "client", value: literal("wrench") }],
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

function validResponse(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    maxBytes: 1_000_000,
    variants: [
      {
        status: 200,
        contentType: "application/json",
        body: {
          kind: "json",
          projections: [
            {
              name: "postId",
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "id" }],
              valueType: "string",
              required: true,
            },
            {
              name: "firstTag",
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "tags" }, { kind: "index", index: 0 }],
              valueType: "string",
              required: false,
            },
          ],
          bindings: [
            {
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "requestText" }],
              expected: source("text", "string"),
            },
            {
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "published" }],
              expected: literal(true),
            },
          ],
        },
      },
      { status: 204, contentType: null, body: { kind: "empty" } },
    ],
    ...overrides,
  };
}

function validTemplate(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    origin: "https://x.com",
    request: validRequest(),
    response: validResponse(),
    ...overrides,
  };
}

function issueText(value: unknown, parseOptions: ParseWebSessionTemplateOptions = options): string {
  const result = parseWebSessionTemplate(value, parseOptions);
  expect(result.ok).toBeFalse();
  return result.ok ? "" : result.issues.join("\n");
}

describe("parseWebSessionTemplate", () => {
  test("accepts a closed same-origin exchange with typed inputs and browser-only credentials", () => {
    const result = parseWebSessionTemplate(validTemplate(), options);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;

    expect(result.value.origin).toBe("https://x.com");
    expect(result.value.request.method).toBe("POST");
    expect(result.value.request.path.at(-1)).toEqual({ kind: "input", name: "post_id", valueType: "string" });
    expect(result.value.response.variants.map(({ status, contentType }) => [status, contentType])).toEqual([
      [200, "application/json"],
      [204, null],
    ]);
  });

  test("rejects extra fields at every closed AST boundary", () => {
    expect(issueText({ ...validTemplate(), url: "https://evil.example" })).toContain("$.url is not supported");
    expect(issueText(validTemplate({ request: validRequest({ origin: "https://evil.example" }) }))).toContain("$.request.origin is not supported");
    expect(issueText(validTemplate({ response: validResponse({ fallback: true }) }))).toContain("$.response.fallback is not supported");
  });

  test("requires an exact canonical reviewed HTTPS origin", () => {
    expect(issueText(validTemplate({ origin: "http://x.com" }))).toContain("canonical HTTPS origin");
    expect(issueText(validTemplate({ origin: "https://x.com/" }))).toContain("canonical HTTPS origin");
    expect(issueText(validTemplate({ origin: "https://*.x.com" }))).toContain("canonical HTTPS origin");
    expect(issueText(validTemplate({ origin: "https://api.x.com" }))).toContain("not one of the exact reviewed origins");
    expect(issueText(validTemplate(), { input, allowedOrigins: [] })).toContain("must contain 1-32");
  });

  test("rejects dynamic or unreviewed methods", () => {
    expect(issueText(validTemplate({ request: validRequest({ method: { kind: "input", name: "method" } }) }))).toContain("fixed reviewed method");
    expect(issueText(validTemplate({ request: validRequest({ method: "CONNECT" }) }))).toContain("fixed reviewed method");
    expect(issueText(validTemplate({ request: validRequest({ method: "post" }) }))).toContain("fixed reviewed method");
  });

  test("allows no request body on GET or HEAD", () => {
    expect(issueText(validTemplate({ request: validRequest({ method: "GET" }) }))).toContain("body must be none for GET");
    const get = parseWebSessionTemplate(validTemplate({
      request: validRequest({ method: "GET", body: { kind: "none" } }),
    }), options);
    expect(get.ok).toBeTrue();
    expect(issueText(validTemplate({
      request: validRequest({ method: "HEAD", body: { kind: "none" } }),
    }))).toContain("cannot project a JSON body for a HEAD request");
  });

  test("builds paths from independently encoded fixed or path-segment inputs", () => {
    expect(issueText(validTemplate({ request: validRequest({ path: [{ kind: "literal", value: "../admin" }] }) }))).toContain("unescaped path segment");
    expect(issueText(validTemplate({ request: validRequest({ path: [{ kind: "literal", value: "%2fadmin" }] }) }))).toContain("unescaped path segment");
    expect(issueText(validTemplate({ request: validRequest({ path: [source("text", "string")] }) }))).toContain("format path-segment");
    expect(issueText(validTemplate({ request: validRequest({ path: [source("tags", "string[]")] }) }))).toContain("format path-segment");
  });

  test("checks source type, existence, requiredness, and binary exclusion", () => {
    const cases = [
      [source("text", "number"), "must match input.text (string)"],
      [source("missing", "string"), "must name a declared input field"],
      [source("optional_text", "string"), "must name a required input field"],
      [source("attachment", "string"), "cannot expose file input bytes"],
    ] as const;
    for (const [candidate, expected] of cases) {
      const body = { kind: "json", value: { kind: "array", items: [candidate] } };
      expect(issueText(validTemplate({ request: validRequest({ body }) }))).toContain(expected);
    }
  });

  test("keeps query names fixed and scalar encoding scalar", () => {
    expect(issueText(validTemplate({ request: validRequest({
      query: [{ name: { kind: "input", name: "text" }, encoding: "scalar", value: literal("x") }],
    }) }))).toContain("must be a 1-128 character string");
    expect(issueText(validTemplate({ request: validRequest({
      query: [{ name: "access_token", encoding: "scalar", value: source("text", "string") }],
    }) }))).toContain("fixed non-credential query name");
    expect(issueText(validTemplate({ request: validRequest({
      query: [{ name: "items", encoding: "scalar", value: source("tags", "string[]") }],
    }) }))).toContain("one non-null scalar");
    expect(issueText(validTemplate({ request: validRequest({
      query: [
        { name: "q", encoding: "scalar", value: literal("one") },
        { name: "q", encoding: "scalar", value: literal("two") },
      ],
    }) }))).toContain("duplicates q");
  });

  test("keeps browser credentials out of query and body value ASTs", () => {
    const browserCredential = {
      kind: "browser-csrf",
      source: { kind: "cookie", name: "ct0" },
      transform: "identity",
    };
    expect(issueText(validTemplate({ request: validRequest({
      query: [{ name: "q", encoding: "json", value: browserCredential }],
    }) }))).toContain("kind must be literal, input, object, or array");
    expect(issueText(validTemplate({ request: validRequest({
      body: { kind: "json", value: browserCredential },
    }) }))).toContain("kind must be literal, input, object, or array");
  });

  test("rejects prototype keys, credential sinks, excessive nesting, and excessive nodes", () => {
    for (const name of ["__proto__", "constructor", "accessToken", "csrf_token"]) {
      const body = { kind: "json", value: { kind: "object", entries: [{ name, value: literal("x") }] } };
      expect(parseWebSessionTemplate(validTemplate({ request: validRequest({ body }) }), options).ok).toBeFalse();
    }
    let nested: Record<string, unknown> = literal("leaf");
    for (let index = 0; index < 14; index += 1) nested = { kind: "array", items: [nested] };
    expect(issueText(validTemplate({ request: validRequest({ body: { kind: "json", value: nested } }) }))).toContain("value-template depth");
    const many = Array.from({ length: 513 }, () => literal(true));
    expect(issueText(validTemplate({ request: validRequest({ body: { kind: "json", value: { kind: "array", items: many } } }) }))).toContain("at most 100 entries");
  });

  test("admits only fixed safe headers and dedicated credential destinations", () => {
    const headerCases = [
      [{ name: "Cookie", value: literal("a=b") }, "canonical lower-case"],
      [{ name: "cookie", value: literal("a=b") }, "browser-managed"],
      [{ name: "origin", value: literal("https://evil.example") }, "browser-managed"],
      [{ name: "authorization", value: literal("Bearer secret") }, "literal into a credential-bearing header"],
      [{ name: "x-csrf-token", value: literal("secret") }, "literal into a credential-bearing header"],
      [{ name: "x-api-key", value: literal("secret") }, "literal into a credential-bearing header"],
    ] as const;
    for (const [header, expected] of headerCases) {
      expect(issueText(validTemplate({ request: validRequest({ headers: [header] }) }))).toContain(expected);
    }
  });

  test("cannot route CSRF or authorization browser sources to another header", () => {
    const csrf = {
      kind: "browser-csrf",
      source: { kind: "cookie", name: "JSESSIONID" },
      transform: "strip-surrounding-quotes",
    };
    const authorization = {
      kind: "browser-authorization",
      source: { kind: "storage", area: "local", key: "accessToken" },
      transform: "bearer",
    };
    expect(issueText(validTemplate({ request: validRequest({ headers: [{ name: "x-leak", value: csrf }] }) }))).toContain("only in a fixed CSRF/XSRF header");
    expect(issueText(validTemplate({ request: validRequest({ headers: [{ name: "x-leak", value: authorization }] }) }))).toContain("only in the fixed authorization header");
    expect(issueText(validTemplate({ request: validRequest({ headers: [{
      name: "authorization",
      value: {
        kind: "browser-authorization",
        source: { kind: "captured-header", name: "authorization" },
        transform: "bearer",
      },
    }] }) }))).toContain("identity for a captured authorization header");
  });

  test("accepts bounded storage/meta credential sources only in their typed header lane", () => {
    const result = parseWebSessionTemplate(validTemplate({ request: validRequest({ headers: [
      {
        name: "csrf-token",
        value: {
          kind: "browser-csrf",
          source: { kind: "meta", name: "csrf-token" },
          transform: "identity",
        },
      },
      {
        name: "authorization",
        value: {
          kind: "browser-authorization",
          source: { kind: "storage", area: "session", key: "bearer" },
          transform: "bearer",
        },
      },
    ] }) }), options);
    expect(result.ok).toBeTrue();
  });

  test("uses exact bounded status/content-type pairs", () => {
    expect(issueText(validTemplate({ response: validResponse({ variants: [] }) }))).toContain("at least one exact response variant");
    expect(issueText(validTemplate({ response: validResponse({ variants: [
      { status: 302, contentType: "application/json", body: { kind: "json", projections: [], bindings: [] } },
    ] }) }))).toContain("between 200 and 299");
    expect(issueText(validTemplate({ response: validResponse({ variants: [
      { status: 200, contentType: "Application/JSON", body: { kind: "json", projections: [], bindings: [] } },
    ] }) }))).toContain("lower-case media-type essence");
    expect(issueText(validTemplate({ response: validResponse({ variants: [
      { status: 200, contentType: "application/json; charset=utf-8", body: { kind: "json", projections: [], bindings: [] } },
    ] }) }))).toContain("lower-case media-type essence");
    expect(issueText(validTemplate({ response: validResponse({ maxBytes: 10 * 1024 * 1024 + 1 }) }))).toContain("between 1 and 10485760");
  });

  test("requires response body mode to agree with the exact content type", () => {
    expect(issueText(validTemplate({ response: validResponse({ variants: [
      { status: 200, contentType: "text/plain", body: { kind: "json", projections: [], bindings: [] } },
    ] }) }))).toContain("exact JSON contentType");
    expect(issueText(validTemplate({ response: validResponse({ variants: [
      { status: 204, contentType: null, body: { kind: "discard" } },
    ] }) }))).toContain("discard requires an exact contentType");
    expect(issueText(validTemplate({ response: validResponse({ variants: [
      { status: 204, contentType: "application/json", body: { kind: "empty" } },
    ] }) }))).toContain("empty requires a null contentType");
  });

  test("rejects duplicate response pairs, output names, and binding paths", () => {
    const duplicateVariant = { status: 204, contentType: null, body: { kind: "empty" } };
    expect(issueText(validTemplate({ response: validResponse({ variants: [duplicateVariant, duplicateVariant] }) }))).toContain("duplicates an exact status/contentType pair");
    const projection = {
      name: "same",
      path: [{ kind: "key", key: "data" }],
      valueType: "object",
      required: true,
    };
    expect(issueText(validTemplate({ response: validResponse({ variants: [{
      status: 200,
      contentType: "application/json",
      body: { kind: "json", projections: [projection, projection], bindings: [] },
    }] }) }))).toContain("duplicates same");
    const binding = { path: [{ kind: "key", key: "id" }], expected: source("text", "string") };
    expect(issueText(validTemplate({ response: validResponse({ variants: [{
      status: 200,
      contentType: "application/json",
      body: { kind: "json", projections: [], bindings: [binding, binding] },
    }] }) }))).toContain("duplicates another binding path");
  });

  test("bounds and types projections and bindings without expression languages", () => {
    expect(issueText(validTemplate({ response: validResponse({ variants: [{
      status: 200,
      contentType: "application/json",
      body: {
        kind: "json",
        projections: [{ name: "token", path: [{ kind: "key", key: "accessToken" }], valueType: "any", required: "yes" }],
        bindings: [{ path: [], expected: { kind: "array", items: [] } }],
      },
    }] }) }))).toContain("must contain at least one fixed segment");
    expect(issueText(validTemplate({ response: validResponse({ variants: [{
      status: 200,
      contentType: "application/json",
      body: {
        kind: "json",
        projections: [],
        bindings: [{ path: [{ kind: "key", key: "data" }], expected: source("tags", "string[]") }],
      },
    }] }) }))).toContain("one non-null scalar literal or scalar input");
  });
});

test("property: every non-enumerated method is rejected", () => {
  assertProperty(fc.property(fc.string({ maxLength: 40 }), (method) => {
    fc.pre(!webSessionMethods.some((candidate) => candidate === method));
    expect(parseWebSessionTemplate(validTemplate({ request: validRequest({ method }) }), options).ok).toBeFalse();
  }));
});

test("property: arbitrary top-level extension fields are rejected", () => {
  assertProperty(fc.property(
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,20}$/u).filter((key) => !["schemaVersion", "origin", "request", "response"].includes(key)),
    fc.jsonValue(),
    (key, value) => {
      expect(parseWebSessionTemplate({ ...validTemplate(), [key]: value }, options).ok).toBeFalse();
    },
  ));
});

test("property: credential-bearing literal headers never parse", () => {
  assertProperty(fc.property(
    fc.constantFrom("authorization", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token", "cookie"),
    fc.string({ maxLength: 100 }).filter((value) => !hasHttpControl(value)),
    (name, value) => {
      const headers = [{ name, value: literal(value) }];
      expect(parseWebSessionTemplate(validTemplate({ request: validRequest({ headers }) }), options).ok).toBeFalse();
    },
  ));
});

test("property: path literal metacharacters cannot escape the reviewed origin-relative path", () => {
  assertProperty(fc.property(
    fc.constantFrom("/", "\\", "%", "?", "#"),
    fc.string({ minLength: 1, maxLength: 20 }).filter((value) => !hasHttpControl(value)),
    (metacharacter, suffix) => {
      const path = [{ kind: "literal", value: `safe${metacharacter}${suffix}` }];
      expect(parseWebSessionTemplate(validTemplate({ request: validRequest({ path }) }), options).ok).toBeFalse();
    },
  ));
});

test("property: response limits reject out-of-range status, size, path depth, and indexes", () => {
  assertProperty(fc.property(
    fc.oneof(fc.integer({ min: -1_000, max: 199 }), fc.integer({ min: 300, max: 1_000 })),
    (status) => {
      const response = validResponse({ variants: [{ status, contentType: null, body: { kind: "empty" } }] });
      expect(parseWebSessionTemplate(validTemplate({ response }), options).ok).toBeFalse();
    },
  ));
  assertProperty(fc.property(fc.integer({ min: 10_001, max: 1_000_000 }), (index) => {
    const response = validResponse({ variants: [{
      status: 200,
      contentType: "application/json",
      body: {
        kind: "json",
        projections: [{ name: "item", path: [{ kind: "index", index }], valueType: "string", required: true }],
        bindings: [],
      },
    }] });
    expect(parseWebSessionTemplate(validTemplate({ response }), options).ok).toBeFalse();
  }));
});
