import { describe, expect, test } from "bun:test";

import {
  encodePortableProviderPluginMessage,
  MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES,
  parsePortableProviderPluginFrame,
  parsePortableProviderPluginMessage,
  PortableProviderPluginFrameDecoder,
  type PortableProviderPluginMessage,
} from "./provider-plugin-protocol";

const identity = {
  id: "example-web",
  version: "1.0.0",
  bundleSha256: "a".repeat(64),
} as const;

const hello = {
  protocolVersion: 1,
  kind: "host.hello",
  hostVersion: "0.1.0",
  hostApiVersion: 1,
  plugin: identity,
  granted: {
    networkOrigins: ["https://www.example.com"],
    planFiles: "read",
    state: "namespaced",
    sessionMaterial: ["cookie-jar"],
  },
} as const satisfies PortableProviderPluginMessage;

const invoke = {
  protocolVersion: 1,
  kind: "host.invoke",
  invocationId: "invocation:1",
  route: {
    transport: "web-session-api",
    surfaceId: "example",
    operation: "feeds.read",
    contractVersion: 1,
  },
  input: {
    cursor: "next",
    limit: 20,
  },
  auth: {
    kind: "cookies-file",
    handle: "auth:1",
    subject: "example:user:123",
  },
  files: [
    {
      input: "attachment",
      handle: ["file", "1"].join(":"),
      bytes: 12,
      mediaType: "image/png",
      sha256: "b".repeat(64),
    },
  ],
  timeoutMs: 30_000,
} as const satisfies PortableProviderPluginMessage;

const httpRequest = {
  protocolVersion: 1,
  kind: "plugin.capability.request",
  invocationId: "invocation:1",
  requestId: "request:1",
  request: {
    kind: "http.request",
    method: "POST",
    url: "https://www.example.com/api/feed?limit=20",
    headers: [
      {
        name: "accept",
        value: "application/json",
      },
      {
        name: "content-type",
        value: "application/json",
      },
    ],
    credentials: [
      {
        handle: "auth:1",
        sink: {
          kind: "cookie-jar",
        },
      },
      {
        handle: "material:oauth",
        sink: {
          kind: "header",
          name: "authorization",
        },
      },
    ],
    body: {
      kind: "utf8",
      mediaType: "application/json",
      text: '{"cursor":"next"}',
    },
    redirect: "error",
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    dispatchHandle: "dispatch:1",
  },
} as const satisfies PortableProviderPluginMessage;

function parsedMessage(
  value: PortableProviderPluginMessage,
): PortableProviderPluginMessage {
  const parsed = parsePortableProviderPluginMessage(value);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
}

describe("portable provider plugin protocol messages", () => {
  test("normalizes and round-trips host and plugin messages", () => {
    for (const message of [
      hello,
      invoke,
      httpRequest,
      {
        protocolVersion: 1,
        kind: "plugin.ready",
        plugin: identity,
      },
      {
        protocolVersion: 1,
        kind: "plugin.result",
        invocationId: "invocation:1",
        output: { items: [], next: null },
        finalUrl: "https://www.example.com/feed",
      },
      {
        protocolVersion: 1,
        kind: "host.cancel",
        invocationId: "invocation:1",
        reason: "timeout",
      },
    ] as const satisfies readonly PortableProviderPluginMessage[]) {
      const encoded = encodePortableProviderPluginMessage(message);
      expect(parsePortableProviderPluginFrame(encoded)).toEqual(
        parsedMessage(message),
      );
    }

    expect(parsePortableProviderPluginMessage({
      protocolVersion: 1,
      kind: "plugin.ready",
      plugin: {
        ...identity,
        version: "1.0.0-01",
      },
    })).toEqual({
      ok: false,
      issues: ["plugin identity version must be semantic version text"],
    });
  });

  test("keeps locators, paths, and raw credentials outside invocation and HTTP frames", () => {
    const invalidInvocation = {
      ...invoke,
      auth: {
        ...invoke.auth,
        path: "/private/cookies.json",
      },
    };
    expect(parsePortableProviderPluginMessage(invalidInvocation)).toEqual({
      ok: false,
      issues: [
        "plugin invocation auth must contain exactly: handle, kind, subject",
      ],
    });

    const rawAuthorization = {
      ...httpRequest,
      request: {
        ...httpRequest.request,
        headers: [
          ...httpRequest.request.headers,
          { name: "Authorization", value: "Bearer secret" },
        ],
      },
    };
    expect(parsePortableProviderPluginMessage(rawAuthorization)).toEqual({
      ok: false,
      issues: ["plugin HTTP header 2 cannot carry raw credential material"],
    });

    const rawCookie = {
      ...httpRequest,
      request: {
        ...httpRequest.request,
        headers: [{ name: "Cookie", value: "session=secret" }],
      },
    };
    expect(parsePortableProviderPluginMessage(rawCookie).ok).toBeFalse();

    expect(parsePortableProviderPluginMessage({
      ...invoke,
      files: [{
        ...invoke.files[0],
        input: "media__file_",
      }],
    }).ok).toBeTrue();

    let getterCalls = 0;
    const accessorMessage: Record<string, unknown> = { ...hello };
    Object.defineProperty(accessorMessage, "kind", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "host.hello";
      },
    });
    expect(parsePortableProviderPluginMessage(accessorMessage)).toEqual({
      ok: false,
      issues: ["portable provider plugin message must be an object"],
    });
    expect(getterCalls).toBe(0);
  });

  test("rejects session descriptors outside the executable host-api-v1 set", () => {
    expect(parsePortableProviderPluginMessage({
      ...hello,
      granted: {
        ...hello.granted,
        sessionMaterial: ["csrf-token"],
      },
    })).toEqual({
      ok: false,
      issues: [
        "granted session material csrf-token is unsupported by host API v1",
      ],
    });

    expect(parsePortableProviderPluginMessage({
      protocolVersion: 1,
      kind: "plugin.capability.request",
      invocationId: "invocation:1",
      requestId: "request:session",
      request: {
        kind: "session.acquire",
        name: "csrf-token",
      },
    })).toEqual({
      ok: false,
      issues: [
        "session material csrf-token is unsupported by host API v1",
      ],
    });
  });

  test("rejects redirects, private URLs, repeated sinks, and unsafe state keys", () => {
    expect(parsePortableProviderPluginMessage({
      ...httpRequest,
      request: {
        ...httpRequest.request,
        redirect: "follow",
      },
    })).toEqual({
      ok: false,
      issues: ["plugin HTTP redirects must fail closed"],
    });

    expect(parsePortableProviderPluginMessage({
      ...httpRequest,
      request: {
        ...httpRequest.request,
        url: "https://localhost/private",
      },
    })).toEqual({
      ok: false,
      issues: ["plugin HTTP URL must be a public credential-free HTTPS URL"],
    });

    expect(parsePortableProviderPluginMessage({
      ...httpRequest,
      request: {
        ...httpRequest.request,
        url: "https://localhost./private",
      },
    })).toEqual({
      ok: false,
      issues: ["plugin HTTP URL must be a public credential-free HTTPS URL"],
    });

    expect(parsePortableProviderPluginMessage({
      ...httpRequest,
      request: {
        ...httpRequest.request,
        credentials: [
          httpRequest.request.credentials[0],
          httpRequest.request.credentials[0],
        ],
      },
    })).toEqual({
      ok: false,
      issues: ["plugin HTTP request repeats a credential sink"],
    });

    expect(parsePortableProviderPluginMessage({
      ...httpRequest,
      request: {
        ...httpRequest.request,
        credentials: [
          {
            handle: "material:camel",
            sink: { kind: "form-field", name: "accessToken" },
          },
        ],
      },
    })).toEqual({
      ok: false,
      issues: ["plugin credential sink is unsupported by host API v1"],
    });

    expect(parsePortableProviderPluginMessage({
      ...httpRequest,
      request: {
        ...httpRequest.request,
        credentials: [{
          handle: "material:csrf",
          sink: { kind: "header", name: "x-csrf-token" },
        }],
      },
    })).toEqual({
      ok: false,
      issues: [
        "host API v1 permits only the Authorization credential header sink",
      ],
    });

    expect(parsePortableProviderPluginMessage({
      protocolVersion: 1,
      kind: "plugin.capability.request",
      invocationId: "invocation:1",
      requestId: "request:state",
      request: {
        kind: "state.write",
        key: "../outside",
        value: { secret: false },
      },
    })).toEqual({
      ok: false,
      issues: ["plugin state key is malformed"],
    });

    expect(parsePortableProviderPluginMessage({
      ...httpRequest,
      request: {
        ...httpRequest.request,
        maxOutputBytes: 768 * 1024 + 1,
      },
    })).toEqual({
      ok: false,
      issues: [
        "plugin HTTP maxOutputBytes must be an integer from 1 to 524288",
      ],
    });
  });

  test("validates typed capability results and strips no secret-bearing headers", () => {
    const response = {
      protocolVersion: 1,
      kind: "host.capability.result",
      invocationId: "invocation:1",
      requestId: "request:1",
      result: {
        kind: "http.request",
        status: 200,
        headers: [
          {
            name: "content-type",
            value: "application/json",
          },
        ],
        body: {
          kind: "utf8",
          text: '{"items":[]}',
        },
        finalUrl: "https://www.example.com/api/feed",
      },
    } as const satisfies PortableProviderPluginMessage;
    expect(parsePortableProviderPluginMessage(response).ok).toBeTrue();

    expect(parsePortableProviderPluginMessage({
      ...response,
      result: {
        ...response.result,
        headers: [
          {
            name: "set-cookie",
            value: "session=secret",
          },
        ],
      },
    })).toEqual({
      ok: false,
      issues: ["plugin HTTP result header 0 cannot carry raw credential material"],
    });

    expect(parsePortableProviderPluginMessage({
      ...response,
      result: {
        ...response.result,
        body: {
          kind: "base64",
          data: "ZE==",
        },
      },
    })).toEqual({
      ok: false,
      issues: ["plugin HTTP response data must be bounded canonical base64"],
    });

    const maximumBinary = Buffer.alloc(512 * 1024, 0x61).toString("base64");
    const maximumBinaryResponse = {
      ...response,
      result: {
        ...response.result,
        body: {
          kind: "base64",
          data: maximumBinary,
        },
      },
    } as const satisfies PortableProviderPluginMessage;
    const encoded = encodePortableProviderPluginMessage(maximumBinaryResponse);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(
      MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES + 1,
    );
    expect(parsePortableProviderPluginFrame(encoded)).toEqual(
      parsedMessage(maximumBinaryResponse),
    );

    const version = "c".repeat(64);
    for (const stateMessage of [
      {
        protocolVersion: 1,
        kind: "plugin.capability.request",
        invocationId: "invocation:1",
        requestId: "request:state-read",
        request: {
          kind: "state.read",
          key: "cursor",
          includeVersion: true,
        },
      },
      {
        protocolVersion: 1,
        kind: "host.capability.result",
        invocationId: "invocation:1",
        requestId: "request:state-read",
        result: {
          kind: "state.read",
          found: true,
          value: { page: 1 },
          version,
        },
      },
      {
        protocolVersion: 1,
        kind: "plugin.capability.request",
        invocationId: "invocation:1",
        requestId: "request:state-write",
        request: {
          kind: "state.write",
          key: "cursor",
          value: { page: 2 },
          expectedVersion: version,
        },
      },
      {
        protocolVersion: 1,
        kind: "host.capability.result",
        invocationId: "invocation:1",
        requestId: "request:state-write",
        result: {
          kind: "state.write",
          stored: true,
          version,
        },
      },
    ] as const satisfies readonly PortableProviderPluginMessage[]) {
      expect(parsePortableProviderPluginMessage(stateMessage)).toEqual(
        { ok: true, value: stateMessage },
      );
    }

    expect(parsePortableProviderPluginMessage({
      ...response,
      result: {
        ...response.result,
        body: {
          kind: "base64",
          data: Buffer.alloc(512 * 1024 + 1, 0x61).toString("base64"),
        },
      },
    })).toEqual({
      ok: false,
      issues: ["plugin HTTP response data must be bounded canonical base64"],
    });
  });

  test("requires canonical, single-record, LF-only frames", () => {
    const encoded = encodePortableProviderPluginMessage(hello);
    expect(() =>
      parsePortableProviderPluginFrame(
        encoded.replace('{"protocolVersion"', '{ "protocolVersion"'),
      )).toThrow("canonical JSON encoding");

    expect(() =>
      parsePortableProviderPluginFrame(
        encoded.replace(
          '{"protocolVersion":1,',
          '{"protocolVersion":1,"protocolVersion":1,',
        ),
      )).toThrow("canonical JSON encoding");

    expect(() =>
      parsePortableProviderPluginFrame(encoded.replace("\n", "\r\n"))).toThrow(
      "LF only",
    );
    expect(() =>
      parsePortableProviderPluginFrame(`${encoded}${encoded}`)).toThrow(
      "one record",
    );
    expect(() =>
      parsePortableProviderPluginFrame(encoded.slice(0, -1))).toThrow(
      "LF-terminated",
    );
  });
});

describe("portable provider plugin frame decoder", () => {
  test("decodes arbitrary chunk boundaries and multiple records in order", () => {
    const stream = Buffer.from(
      [
        encodePortableProviderPluginMessage(hello),
        encodePortableProviderPluginMessage(invoke),
        encodePortableProviderPluginMessage(httpRequest),
      ].join(""),
    );
    const decoder = new PortableProviderPluginFrameDecoder();
    const messages: PortableProviderPluginMessage[] = [];
    for (let index = 0; index < stream.byteLength; index += 7) {
      messages.push(...decoder.push(stream.subarray(index, index + 7)));
    }
    decoder.finish();
    expect(messages).toEqual([
      parsedMessage(hello),
      parsedMessage(invoke),
      parsedMessage(httpRequest),
    ]);
  });

  test("rejects oversized, partial, and post-finish input", () => {
    const oversized = new PortableProviderPluginFrameDecoder();
    expect(() =>
      oversized.push(
        Buffer.alloc(MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES + 1, 0x61),
      )).toThrow("exceeds the byte bound");
    expect(() =>
      oversized.push(
        Buffer.from(encodePortableProviderPluginMessage(hello)),
      )).toThrow("has failed");

    const partial = new PortableProviderPluginFrameDecoder();
    partial.push(Buffer.from('{"protocolVersion":1'));
    expect(() => partial.finish()).toThrow("partial frame");

    const finished = new PortableProviderPluginFrameDecoder();
    finished.finish();
    expect(() => finished.push(Buffer.from("\n"))).toThrow("is finished");
    expect(() => finished.finish()).toThrow("already finished");

    const malformed = new PortableProviderPluginFrameDecoder();
    expect(() =>
      malformed.push(Buffer.from('{"protocolVersion":1}\n'))).toThrow(
      "invalid portable provider plugin frame",
    );
    expect(() =>
      malformed.push(
        Buffer.from(encodePortableProviderPluginMessage(hello)),
      )).toThrow("has failed");
  });
});
