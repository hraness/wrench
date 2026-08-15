import { describe, expect, test } from "bun:test";

import {
  parseDerivationReviewFixtures,
  reviewDerivationHarValue,
} from "./derive-review";

const targetOrigin = "https://example.com";

function fixtureHar(): unknown {
  const variables = encodeURIComponent(JSON.stringify({ conversation_id: "conversation-fixture-123" }));
  return {
    log: {
      entries: [
        {
          request: { method: "GET", url: "https://tracker.example.net/collect?secret=cross-origin-secret" },
          response: { status: 204, content: { mimeType: "text/plain", text: "cross-origin-secret" } },
        },
        {
          request: {
            method: "POST",
            url: `${targetOrigin}/api/messages/conversation-fixture-123?variables=${variables}&access_token=query-secret-fixture`,
            headers: [
              { name: "authorization", value: "Bearer header-secret-fixture" },
              { name: "cookie", value: "session=header-secret-fixture" },
              { name: "content-type", value: "application/json" },
            ],
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({
                variables: { conversation_id: "conversation-fixture-123" },
                body: { text: "request-message-fixture" },
              }),
            },
          },
          response: {
            status: 200,
            content: {
              mimeType: "application/json",
              text: JSON.stringify({
                data: {
                  messages: {
                    "dynamic-member-fixture": {
                      id: "message-id-fixture",
                      text: "response-message-fixture",
                    },
                  },
                },
              }),
            },
          },
        },
        {
          request: { method: "GET", url: `${targetOrigin}/assets/private-script.js` },
          response: { status: 200, content: { mimeType: "application/javascript", text: "private-script" } },
        },
      ],
    },
  };
}

function reviewedContractHeaderHar(): unknown {
  return {
    log: {
      entries: [{
        request: {
          method: "POST",
          url: `${targetOrigin}/voyager/api/articles/7000000000000000001`,
          headers: [
            { name: "X-RestLi-Method", value: "PARTIAL_UPDATE" },
            { name: "authorization", value: "Bearer never-match-this" },
            { name: "cookie", value: "session=never-match-this" },
            { name: "x-unreviewed", value: "never-match-this" },
          ],
          postData: { mimeType: "application/json", text: "{}" },
        },
        response: {
          status: 200,
          headers: [
            { name: "x-restli-id", value: "7000000000000000001" },
            { name: "set-cookie", value: "never-match-this" },
          ],
          content: { mimeType: "application/json", text: "{}" },
        },
      }],
    },
  };
}

function sensitiveJsonHar(): unknown {
  return {
    log: {
      entries: [{
        request: {
          method: "POST",
          url: `${targetOrigin}/api/messages`,
          postData: {
            mimeType: "application/json",
            text: JSON.stringify({
              payload: {
                text: "visible-request-fixture",
                password: { nested: { text: "request-password-fixture" } },
                apiToken: { value: "request-token-fixture" },
                requestHeaders: [{ value: "request-header-fixture" }],
                auth: { value: "request-alias-fixture" },
                api_key: { value: "request-alias-fixture" },
                apiKey: { value: "request-alias-fixture" },
                jwt: { value: "request-alias-fixture" },
                csrf: { value: "request-alias-fixture" },
                xsrf: { value: "request-alias-fixture" },
                sid: { value: "request-alias-fixture" },
                bearer: { value: "request-alias-fixture" },
                oauth2: { value: "request-alias-fixture" },
                accessKeyId: { value: "request-alias-fixture" },
                clientSecret: { value: "request-alias-fixture" },
                refresh_token: { value: "request-alias-fixture" },
                id_token: { value: "request-alias-fixture" },
                sessionId: { value: "request-alias-fixture" },
                "connect.sid": { value: "request-alias-fixture" },
                author: { text: "safe-author-fixture" },
                consideration: { text: "safe-consideration-fixture" },
              },
            }),
          },
        },
        response: {
          status: 200,
          content: {
            mimeType: "application/json",
            text: JSON.stringify({
              data: {
                result: {
                  text: "visible-response-fixture",
                  credentials: {
                    password: { value: "response-password-fixture" },
                  },
                  cookieJar: { nested: { value: "response-cookie-fixture" } },
                  access_token: { nested: { value: "response-token-fixture" } },
                  headers: { authorization: { value: "response-header-fixture" } },
                  authContext: { value: "response-alias-fixture" },
                  x_api_key: { value: "response-alias-fixture" },
                  bearerToken: { value: "response-alias-fixture" },
                  csrfMiddlewareToken: { value: "response-alias-fixture" },
                  jwtAssertion: { value: "response-alias-fixture" },
                  privateKey: { value: "response-alias-fixture" },
                  phpsessid: { value: "response-alias-fixture" },
                },
              },
            }),
          },
        },
      }],
    },
  };
}

function rawJsonExchangeHar(requestText: string, responseText: string): unknown {
  return {
    log: {
      entries: [{
        request: {
          method: "POST",
          url: `${targetOrigin}/api/messages`,
          postData: {
            mimeType: "application/json",
            text: requestText,
          },
        },
        response: {
          status: 200,
          content: {
            mimeType: "application/json",
            text: responseText,
          },
        },
      }],
    },
  };
}

function jsonExchangeHar(requestBody: unknown, responseBody: unknown = { data: {} }): unknown {
  return rawJsonExchangeHar(JSON.stringify(requestBody), JSON.stringify(responseBody));
}

function textExchangeHar(mimeType: string, text: string): unknown {
  return {
    log: {
      entries: [{
        request: {
          method: "POST",
          url: `${targetOrigin}/api/messages`,
          postData: { mimeType, text },
        },
        response: {
          status: 200,
          content: { mimeType: "application/json", text: "{}" },
        },
      }],
    },
  };
}

function deeplyNestedFixture(value: string): unknown {
  let nested: unknown = { text: value };
  for (let depth = 0; depth < 9; depth += 1) nested = { body: nested };
  return nested;
}

describe("private derivation review", () => {
  test("matches only reviewed non-secret contract headers and returns locations, never values", () => {
    const fixtures = parseDerivationReviewFixtures({
      method: "PARTIAL_UPDATE",
      created_id: "7000000000000000001",
      forbidden: "never-match-this",
    });
    const result = reviewDerivationHarValue(
      reviewedContractHeaderHar(),
      targetOrigin,
      { kind: "entry", entryIndex: 0, fixtures },
    );
    expect(result.kind).toBe("entry");
    if (result.kind !== "entry") throw new Error("expected entry review");
    expect(Object.fromEntries(result.fixtureMatches.map((match) => [match.label, match.locations]))).toEqual({
      method: ["request.header.x-restli-method[0]"],
      created_id: ["request.path.segment[3]", "response.header.x-restli-id[0]"],
      forbidden: [],
    });
    const rendered = JSON.stringify(result);
    for (const value of Object.values(fixtures)) expect(rendered).not.toContain(value);
  });

  test("lists bounded first-party API entries with raw HAR indices and no values", () => {
    const result = reviewDerivationHarValue(
      fixtureHar(),
      targetOrigin,
      { kind: "list", offset: 0, limit: 50 },
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "list",
      totalHarEntries: 3,
      reviewableEntries: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
      entries: [{
        entryIndex: 1,
        method: "POST",
        origin: targetOrigin,
        path: "/api/messages/:segment1",
        statuses: [200],
      }],
    });
    const rendered = JSON.stringify(result);
    for (const secret of [
      "conversation-fixture-123",
      "query-secret-fixture",
      "header-secret-fixture",
      "request-message-fixture",
      "response-message-fixture",
      "dynamic-member-fixture",
      "cross-origin-secret",
    ]) expect(rendered).not.toContain(secret);
  });

  test("maps stdin fixture labels to sanitized structural locations without echoing values or searching credentials", () => {
    const fixtures = parseDerivationReviewFixtures({
      conversation_id: "conversation-fixture-123",
      request_text: "request-message-fixture",
      response_text: "response-message-fixture",
      header_secret: "header-secret-fixture",
      query_secret: "query-secret-fixture",
      dynamic_key: "dynamic-member-fixture",
    });
    const result = reviewDerivationHarValue(
      fixtureHar(),
      targetOrigin,
      { kind: "entry", entryIndex: 1, fixtures },
    );
    expect(result.kind).toBe("entry");
    if (result.kind !== "entry") throw new Error("expected entry review");
    expect(result.structure).toMatchObject({
      method: "POST",
      path: "/api/messages/:segment1",
    });
    expect(result.structure.requestFieldPaths).toContain("variables.conversation_id");
    expect(result.structure.requestFieldPaths).toContain("body.text");
    expect(result.structure.responseFieldPaths).toContain("data.messages.:dynamic.text");
    expect(Object.fromEntries(result.fixtureMatches.map((match) => [match.label, match.locations]))).toEqual({
      conversation_id: [
        "request.body.variables.conversation_id",
        "request.path.segment[2]",
        "request.query.variables[0].conversation_id",
      ],
      request_text: ["request.body.body.text"],
      response_text: ["response.body.data.messages.:dynamic.text"],
      header_secret: [],
      query_secret: [],
      dynamic_key: [],
    });
    const rendered = JSON.stringify(result);
    for (const value of Object.values(fixtures)) expect(rendered).not.toContain(value);
    expect(rendered).not.toContain("Bearer");
  });

  test("retains only safe top-level X GraphQL variable schema names during fixture review", () => {
    const fixtures = parseDerivationReviewFixtures({
      article_id: "article-id-fixture",
      title: "article-title-fixture",
      credential: "credential-fixture",
      nested_user: "nested-user-fixture",
    });
    const dynamicUserKey = "dynamic-user-key";
    const result = reviewDerivationHarValue(
      {
        log: {
          entries: [{
            request: {
              method: "POST",
              url: "https://x.com/i/api/graphql/btD9FyMDa3_vydVp7fr87Q/ArticleEntityDraftCreate",
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({
                  variables: {
                    articleEntityKey: "article-id-fixture",
                    title: "article-title-fixture",
                    authToken: "credential-fixture",
                    users: {
                      [dynamicUserKey]: { text: "nested-user-fixture" },
                    },
                  },
                }),
              },
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: "{}" },
            },
          }],
        },
      },
      "https://x.com",
      { kind: "entry", entryIndex: 0, fixtures },
    );

    expect(result.kind).toBe("entry");
    if (result.kind !== "entry") throw new Error("expected entry review");
    expect(Object.fromEntries(result.fixtureMatches.map((match) => [match.label, match.locations]))).toEqual({
      article_id: ["request.body.variables.articleEntityKey"],
      title: ["request.body.variables.title"],
      credential: [],
      nested_user: ["request.body.variables.users.:dynamic.text"],
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(dynamicUserKey);
    for (const value of Object.values(fixtures)) expect(rendered).not.toContain(value);
  });

  test("never searches request or response JSON values beneath sensitive keys", () => {
    const fixtures = parseDerivationReviewFixtures({
      visible_request: "visible-request-fixture",
      visible_response: "visible-response-fixture",
      request_password: "request-password-fixture",
      request_token: "request-token-fixture",
      request_header: "request-header-fixture",
      response_password: "response-password-fixture",
      response_cookie: "response-cookie-fixture",
      response_token: "response-token-fixture",
      response_header: "response-header-fixture",
      request_aliases: "request-alias-fixture",
      response_aliases: "response-alias-fixture",
      safe_author: "safe-author-fixture",
      safe_consideration: "safe-consideration-fixture",
    });
    const result = reviewDerivationHarValue(
      sensitiveJsonHar(),
      targetOrigin,
      { kind: "entry", entryIndex: 0, fixtures },
    );
    expect(result.kind).toBe("entry");
    if (result.kind !== "entry") throw new Error("expected entry review");
    expect(Object.fromEntries(result.fixtureMatches.map((match) => [match.label, match.locations]))).toEqual({
      visible_request: ["request.body.payload.text"],
      visible_response: ["response.body.data.result.text"],
      request_password: [],
      request_token: [],
      request_header: [],
      response_password: [],
      response_cookie: [],
      response_token: [],
      response_header: [],
      request_aliases: [],
      response_aliases: [],
      safe_author: ["request.body.payload.:dynamic.text"],
      safe_consideration: ["request.body.payload.:dynamic.text"],
    });
    expect(result.fixtureMatches.every((match) => match.truncated === false)).toBeTrue();
    const rendered = JSON.stringify(result);
    for (const value of Object.values(fixtures)) expect(rendered).not.toContain(value);
  });

  test("suppresses credential routes and credential-bearing structured body values", () => {
    const pathHar = {
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: `${targetOrigin}/auth/path-secret-fixture`,
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: "{}" },
            },
          },
          {
            request: {
              method: "GET",
              url: `${targetOrigin}/api/messages/conversation-path-fixture`,
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: "{}" },
            },
          },
        ],
      },
    };
    const credentialPath = reviewDerivationHarValue(
      pathHar,
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({ secret: "path-secret-fixture" }),
      },
    );
    expect(credentialPath.kind).toBe("entry");
    if (credentialPath.kind !== "entry") throw new Error("expected entry review");
    expect(credentialPath.fixtureMatches).toEqual([{
      label: "secret",
      locations: [],
      truncated: false,
    }]);
    expect(JSON.stringify(credentialPath)).not.toContain("path-secret-fixture");

    const ordinaryPath = reviewDerivationHarValue(
      pathHar,
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 1,
        fixtures: parseDerivationReviewFixtures({ conversation: "conversation-path-fixture" }),
      },
    );
    expect(ordinaryPath.kind).toBe("entry");
    if (ordinaryPath.kind !== "entry") throw new Error("expected entry review");
    expect(ordinaryPath.fixtureMatches).toEqual([{
      label: "conversation",
      locations: ["request.path.segment[2]"],
      truncated: false,
    }]);

    const formFixtures = parseDerivationReviewFixtures({
      visible_text: "form-text-visible-fixture",
      visible_subject: "form-subject-visible-fixture",
      password: "form-password-fixture",
      api_key: "form-api-key-fixture",
      auth: "form-auth-fixture",
    });
    const form = reviewDerivationHarValue(
      textExchangeHar(
        "application/x-www-form-urlencoded",
        [
          "text=form-text-visible-fixture",
          "password=form-password-fixture",
          "apiKey=form-api-key-fixture",
          "auth=form-auth-fixture",
          "subject=form-subject-visible-fixture",
        ].join("&"),
      ),
      targetOrigin,
      { kind: "entry", entryIndex: 0, fixtures: formFixtures },
    );
    expect(form.kind).toBe("entry");
    if (form.kind !== "entry") throw new Error("expected entry review");
    expect(Object.fromEntries(form.fixtureMatches.map((match) => [match.label, match.locations]))).toEqual({
      visible_text: ["request.form.text[0]"],
      visible_subject: ["request.form.subject[0]"],
      password: [],
      api_key: [],
      auth: [],
    });
    expect(form.fixtureMatches.every((match) => match.truncated === false)).toBeTrue();
    const formRendered = JSON.stringify(form);
    for (const value of Object.values(formFixtures)) expect(formRendered).not.toContain(value);

    const multipart = reviewDerivationHarValue(
      textExchangeHar(
        "multipart/form-data; boundary=wrench",
        "name=\"password\"\r\n\r\nmultipart-password-fixture\r\nname=\"text\"\r\n\r\nmultipart-text-fixture",
      ),
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          password: "multipart-password-fixture",
          text: "multipart-text-fixture",
        }),
      },
    );
    expect(multipart.kind).toBe("entry");
    if (multipart.kind !== "entry") throw new Error("expected entry review");
    expect(multipart.fixtureMatches).toEqual([
      { label: "password", locations: [], truncated: true },
      { label: "text", locations: [], truncated: true },
    ]);

    const plain = reviewDerivationHarValue(
      textExchangeHar("text/plain", "plain-authorized-fixture"),
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({ text: "plain-authorized-fixture" }),
      },
    );
    expect(plain.kind).toBe("entry");
    if (plain.kind !== "entry") throw new Error("expected entry review");
    expect(plain.fixtureMatches).toEqual([{
      label: "text",
      locations: ["request.body:text"],
      truncated: false,
    }]);
  });

  test("matches only exact whole values and cannot probe safe content by substring", () => {
    const fixtures = parseDerivationReviewFixtures({
      probe: "private",
      whole: "opaque-private-message",
    });
    const cases = [
      {
        har: textExchangeHar("text/plain", "opaque-private-message"),
        wholeLocation: "request.body:text",
      },
      {
        har: {
          log: {
            entries: [{
              request: {
                method: "GET",
                url: `${targetOrigin}/api/messages?q=opaque-private-message`,
              },
              response: {
                status: 200,
                content: { mimeType: "application/json", text: "{}" },
              },
            }],
          },
        },
        wholeLocation: "request.query.:dynamic[0]",
      },
      {
        har: jsonExchangeHar({
          payload: { text: "opaque-private-message" },
        }),
        wholeLocation: "request.body.payload.text",
      },
    ] as const;
    for (const candidate of cases) {
      const result = reviewDerivationHarValue(
        candidate.har,
        targetOrigin,
        { kind: "entry", entryIndex: 0, fixtures },
      );
      expect(result.kind).toBe("entry");
      if (result.kind !== "entry") throw new Error("expected entry review");
      expect(result.fixtureMatches).toEqual([
        { label: "probe", locations: [], truncated: false },
        { label: "whole", locations: [candidate.wholeLocation], truncated: false },
      ]);
      expect(JSON.stringify(result)).not.toContain("opaque-private-message");
    }
  });

  test("bounds oversized and many-parameter queries without enabling raw probing", () => {
    const oversizedRaw = "opaque-private-message".repeat(
      Math.ceil((2 * 1024 * 1024 + 1) / "opaque-private-message".length),
    );
    const oversizedQuery = reviewDerivationHarValue(
      {
        log: {
          entries: [{
            request: {
              method: "GET",
              url: `${targetOrigin}/api/messages/query-cap-visible-fixture?payload=${oversizedRaw}`,
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: "{}" },
            },
          }],
        },
      },
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          visible: "query-cap-visible-fixture",
          probe: "private",
        }),
      },
    );
    expect(oversizedQuery.kind).toBe("entry");
    if (oversizedQuery.kind !== "entry") throw new Error("expected entry review");
    expect(oversizedQuery.structure.queryNames).toEqual([]);
    expect(oversizedQuery.structure.requestFieldPaths.some((path) => path.startsWith("query."))).toBeFalse();
    expect(oversizedQuery.fixtureMatches).toEqual([
      {
        label: "visible",
        locations: ["request.path.segment[2]"],
        truncated: true,
      },
      { label: "probe", locations: [], truncated: true },
    ]);
    const oversizedRendered = JSON.stringify(oversizedQuery);
    expect(oversizedRendered).not.toContain("query-cap-visible-fixture");
    expect(oversizedRendered).not.toContain("opaque-private-message");

    const manyParameters = [
      "text=many-query-visible-fixture",
      ...Array.from({ length: 999 }, (_value, index) => `p${index}=other`),
      "subject=many-query-hidden-fixture",
    ].join("&");
    const manyQuery = reviewDerivationHarValue(
      {
        log: {
          entries: [{
            request: {
              method: "GET",
              url: `${targetOrigin}/api/messages?${manyParameters}`,
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: "{}" },
            },
          }],
        },
      },
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          visible: "many-query-visible-fixture",
          hidden: "many-query-hidden-fixture",
        }),
      },
    );
    expect(manyQuery.kind).toBe("entry");
    if (manyQuery.kind !== "entry") throw new Error("expected entry review");
    expect(manyQuery.structure.queryNames).toEqual([":dynamic", "text"]);
    expect(manyQuery.structure.queryNames).not.toContain("subject");
    expect(manyQuery.fixtureMatches).toEqual([
      {
        label: "visible",
        locations: ["request.query.text[0]"],
        truncated: true,
      },
      { label: "hidden", locations: [], truncated: true },
    ]);
    const manyRendered = JSON.stringify(manyQuery);
    expect(manyRendered).not.toContain("many-query-visible-fixture");
    expect(manyRendered).not.toContain("many-query-hidden-fixture");
  });

  test("marks depth, array, object, and total-node search caps as truncated without losing safe siblings", () => {
    const oversizedObject = Object.fromEntries(Array.from({ length: 301 }, (_value, index) => [
      `field_${index}`,
      { text: index === 0 ? "object-visible-fixture" : index === 300 ? "object-hidden-fixture" : "other" },
    ]));
    const nodeMatrix = Array.from(
      { length: 100 },
      () => Array.from({ length: 100 }, () => false),
    );
    const scenarios = [
      {
        har: jsonExchangeHar({
          payload: {
            text: "depth-visible-fixture",
            body: deeplyNestedFixture("depth-hidden-fixture"),
          },
        }),
        visible: "depth-visible-fixture",
        visibleLocation: "request.body.payload.text",
        hidden: "depth-hidden-fixture",
      },
      {
        har: jsonExchangeHar({
          payload: {
            items: Array.from({ length: 101 }, (_value, index) => ({
              text: index === 0 ? "array-visible-fixture" : index === 100 ? "array-hidden-fixture" : "other",
            })),
          },
        }),
        visible: "array-visible-fixture",
        visibleLocation: "request.body.payload.items[].text",
        hidden: "array-hidden-fixture",
      },
      {
        har: jsonExchangeHar({ payload: { metadata: oversizedObject } }),
        visible: "object-visible-fixture",
        visibleLocation: "request.body.payload.metadata.:dynamic.text",
        hidden: "object-hidden-fixture",
      },
      {
        har: jsonExchangeHar({
          payload: {
            name: "nodes-visible-fixture",
            items: nodeMatrix,
            text: "nodes-hidden-fixture",
          },
        }),
        visible: "nodes-visible-fixture",
        visibleLocation: "request.body.payload.name",
        hidden: "nodes-hidden-fixture",
      },
    ] as const;

    for (const scenario of scenarios) {
      const fixtures = parseDerivationReviewFixtures({
        visible: scenario.visible,
        hidden: scenario.hidden,
      });
      const result = reviewDerivationHarValue(
        scenario.har,
        targetOrigin,
        { kind: "entry", entryIndex: 0, fixtures },
      );
      expect(result.kind).toBe("entry");
      if (result.kind !== "entry") throw new Error("expected entry review");
      expect(result.fixtureMatches).toEqual([
        { label: "visible", locations: [scenario.visibleLocation], truncated: true },
        { label: "hidden", locations: [], truncated: true },
      ]);
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(scenario.visible);
      expect(rendered).not.toContain(scenario.hidden);
    }
  });

  test("marks response caps as truncated and applies the per-fixture match cap independently", () => {
    const responseCapFixtures = parseDerivationReviewFixtures({
      visible: "response-array-visible-fixture",
      hidden: "response-array-hidden-fixture",
    });
    const responseCap = reviewDerivationHarValue(
      jsonExchangeHar(
        { payload: {} },
        {
          data: {
            items: Array.from({ length: 101 }, (_value, index) => ({
              text: index === 0
                ? "response-array-visible-fixture"
                : index === 100
                  ? "response-array-hidden-fixture"
                  : "other",
            })),
          },
        },
      ),
      targetOrigin,
      { kind: "entry", entryIndex: 0, fixtures: responseCapFixtures },
    );
    expect(responseCap.kind).toBe("entry");
    if (responseCap.kind !== "entry") throw new Error("expected entry review");
    expect(responseCap.fixtureMatches).toEqual([
      {
        label: "visible",
        locations: ["response.body.data.items[].text"],
        truncated: true,
      },
      { label: "hidden", locations: [], truncated: true },
    ]);

    const branches = [
      "body",
      "category",
      "data",
      "edges",
      "elements",
      "extensions",
      "features",
      "fieldToggles",
      "media",
      "metadata",
      "paging",
    ];
    const leaves = [
      "category",
      "conversation_id",
      "count",
      "cursor",
      "entityUrn",
      "id",
      "limit",
      "message",
      "name",
      "subject",
      "text",
    ];
    const repeatedMatches = Object.fromEntries(branches.map((branch) => [
      branch,
      Object.fromEntries(leaves.map((leaf) => [leaf, "match-cap-fixture"])),
    ]));
    const perFixture = reviewDerivationHarValue(
      jsonExchangeHar({
        payload: repeatedMatches,
        total: "independent-control-fixture",
      }),
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          capped: "match-cap-fixture",
          control: "independent-control-fixture",
        }),
      },
    );
    expect(perFixture.kind).toBe("entry");
    if (perFixture.kind !== "entry") throw new Error("expected entry review");
    const capped = perFixture.fixtureMatches.find((match) => match.label === "capped");
    const control = perFixture.fixtureMatches.find((match) => match.label === "control");
    expect(capped).toMatchObject({ truncated: true });
    expect(capped?.locations).toHaveLength(100);
    expect(control).toEqual({
      label: "control",
      locations: ["request.body.total"],
      truncated: false,
    });
    const rendered = JSON.stringify(perFixture);
    expect(rendered).not.toContain("match-cap-fixture");
    expect(rendered).not.toContain("independent-control-fixture");
  });

  test("marks oversized JSON and form-parameter caps without treating malformed JSON as a cap", () => {
    const padding = "x".repeat(2 * 1024 * 1024);
    const oversizedCases = [
      {
        har: rawJsonExchangeHar(
          JSON.stringify({
            payload: {
              text: "oversized-request-hidden-fixture",
              padding,
            },
          }),
          JSON.stringify({ data: { text: "oversized-request-visible-fixture" } }),
        ),
        visible: "oversized-request-visible-fixture",
        visibleLocation: "response.body.data.text",
        hidden: "oversized-request-hidden-fixture",
      },
      {
        har: rawJsonExchangeHar(
          JSON.stringify({ payload: { text: "oversized-response-visible-fixture" } }),
          JSON.stringify({
            data: {
              text: "oversized-response-hidden-fixture",
              padding,
            },
          }),
        ),
        visible: "oversized-response-visible-fixture",
        visibleLocation: "request.body.payload.text",
        hidden: "oversized-response-hidden-fixture",
      },
    ] as const;
    for (const scenario of oversizedCases) {
      const result = reviewDerivationHarValue(
        scenario.har,
        targetOrigin,
        {
          kind: "entry",
          entryIndex: 0,
          fixtures: parseDerivationReviewFixtures({
            visible: scenario.visible,
            hidden: scenario.hidden,
          }),
        },
      );
      expect(result.kind).toBe("entry");
      if (result.kind !== "entry") throw new Error("expected entry review");
      expect(result.fixtureMatches).toEqual([
        { label: "visible", locations: [scenario.visibleLocation], truncated: true },
        { label: "hidden", locations: [], truncated: true },
      ]);
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(scenario.visible);
      expect(rendered).not.toContain(scenario.hidden);
    }

    const oversizedTextHar = {
      log: {
        entries: [{
          request: {
            method: "POST",
            url: `${targetOrigin}/api/messages`,
            postData: {
              mimeType: "text/plain",
              text: `oversized-text-hidden-fixture${padding}`,
            },
          },
          response: {
            status: 200,
            content: {
              mimeType: "application/json",
              text: JSON.stringify({ data: { text: "oversized-text-visible-fixture" } }),
            },
          },
        }],
      },
    };
    const oversizedText = reviewDerivationHarValue(
      oversizedTextHar,
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          visible: "oversized-text-visible-fixture",
          hidden: "oversized-text-hidden-fixture",
        }),
      },
    );
    expect(oversizedText.kind).toBe("entry");
    if (oversizedText.kind !== "entry") throw new Error("expected entry review");
    expect(oversizedText.fixtureMatches).toEqual([
      {
        label: "visible",
        locations: ["response.body.data.text"],
        truncated: true,
      },
      { label: "hidden", locations: [], truncated: true },
    ]);
    expect(JSON.stringify(oversizedText)).not.toContain("oversized-text-visible-fixture");
    expect(JSON.stringify(oversizedText)).not.toContain("oversized-text-hidden-fixture");

    const formParameters = Array.from({ length: 1_001 }, (_value, index) => ({
      name: index === 0 ? "text" : index === 1_000 ? "subject" : `field_${index}`,
      value: index === 0
        ? "form-visible-fixture"
        : index === 1_000
          ? "form-hidden-fixture"
          : "other",
    }));
    const formHar = {
      log: {
        entries: [{
          request: {
            method: "POST",
            url: `${targetOrigin}/api/messages`,
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              params: formParameters,
            },
          },
          response: {
            status: 200,
            content: { mimeType: "application/json", text: "{}" },
          },
        }],
      },
    };
    const formResult = reviewDerivationHarValue(
      formHar,
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          visible: "form-visible-fixture",
          hidden: "form-hidden-fixture",
        }),
      },
    );
    expect(formResult.kind).toBe("entry");
    if (formResult.kind !== "entry") throw new Error("expected entry review");
    expect(formResult.fixtureMatches).toEqual([
      { label: "visible", locations: ["request.form.text[0]"], truncated: true },
      { label: "hidden", locations: [], truncated: true },
    ]);
    expect(JSON.stringify(formResult)).not.toContain("form-visible-fixture");
    expect(JSON.stringify(formResult)).not.toContain("form-hidden-fixture");

    const oversizedName = "x".repeat(4_097);
    const oversizedKeyResult = reviewDerivationHarValue(
      jsonExchangeHar({
        payload: {
          text: "oversized-key-visible-fixture",
          [oversizedName]: { text: "oversized-key-hidden-fixture" },
        },
      }),
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          visible: "oversized-key-visible-fixture",
          hidden: "oversized-key-hidden-fixture",
        }),
      },
    );
    expect(oversizedKeyResult.kind).toBe("entry");
    if (oversizedKeyResult.kind !== "entry") throw new Error("expected entry review");
    expect(oversizedKeyResult.fixtureMatches).toEqual([
      { label: "visible", locations: ["request.body.payload.text"], truncated: true },
      { label: "hidden", locations: [], truncated: true },
    ]);

    const oversizedFormNameResult = reviewDerivationHarValue(
      {
        log: {
          entries: [{
            request: {
              method: "POST",
              url: `${targetOrigin}/api/messages`,
              postData: {
                mimeType: "application/x-www-form-urlencoded",
                params: [
                  { name: "text", value: "oversized-form-visible-fixture" },
                  { name: oversizedName, value: "oversized-form-hidden-fixture" },
                ],
              },
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: "{}" },
            },
          }],
        },
      },
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          visible: "oversized-form-visible-fixture",
          hidden: "oversized-form-hidden-fixture",
        }),
      },
    );
    expect(oversizedFormNameResult.kind).toBe("entry");
    if (oversizedFormNameResult.kind !== "entry") throw new Error("expected entry review");
    expect(oversizedFormNameResult.fixtureMatches).toEqual([
      { label: "visible", locations: ["request.form.text[0]"], truncated: true },
      { label: "hidden", locations: [], truncated: true },
    ]);

    const rawBoundParameters = [
      { name: "text", value: "raw-bound-visible-fixture" },
      ...Array.from({ length: 10_000 }, () => ({
        name: "auth",
        value: "raw-bound-credential-fixture",
      })),
      { name: "subject", value: "raw-bound-hidden-fixture" },
    ];
    const rawBoundResult = reviewDerivationHarValue(
      {
        log: {
          entries: [{
            request: {
              method: "POST",
              url: `${targetOrigin}/api/messages`,
              postData: {
                mimeType: "application/x-www-form-urlencoded",
                params: rawBoundParameters,
              },
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: "{}" },
            },
          }],
        },
      },
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({
          visible: "raw-bound-visible-fixture",
          hidden: "raw-bound-hidden-fixture",
          credential: "raw-bound-credential-fixture",
        }),
      },
    );
    expect(rawBoundResult.kind).toBe("entry");
    if (rawBoundResult.kind !== "entry") throw new Error("expected entry review");
    expect(rawBoundResult.fixtureMatches).toEqual([
      { label: "visible", locations: ["request.form.text[0]"], truncated: true },
      { label: "hidden", locations: [], truncated: true },
      { label: "credential", locations: [], truncated: true },
    ]);
    const rawBoundRendered = JSON.stringify(rawBoundResult);
    expect(rawBoundRendered).not.toContain("raw-bound-visible-fixture");
    expect(rawBoundRendered).not.toContain("raw-bound-hidden-fixture");
    expect(rawBoundRendered).not.toContain("raw-bound-credential-fixture");

    const oversizedMimeType = `${"x".repeat(4_097)}application/json`;
    const mimeCases = [
      {
        har: {
          log: {
            entries: [{
              request: {
                method: "POST",
                url: `${targetOrigin}/api/messages`,
                postData: {
                  mimeType: oversizedMimeType,
                  text: JSON.stringify({ payload: { text: "request-mime-hidden-fixture" } }),
                },
              },
              response: {
                status: 200,
                content: {
                  mimeType: "application/json",
                  text: JSON.stringify({ data: { text: "request-mime-visible-fixture" } }),
                },
              },
            }],
          },
        },
        visible: "request-mime-visible-fixture",
        visibleLocation: "response.body.data.text",
        hidden: "request-mime-hidden-fixture",
      },
      {
        har: {
          log: {
            entries: [{
              request: {
                method: "POST",
                url: `${targetOrigin}/api/messages`,
                postData: {
                  mimeType: "application/json",
                  text: JSON.stringify({ payload: { text: "response-mime-visible-fixture" } }),
                },
              },
              response: {
                status: 200,
                content: {
                  mimeType: oversizedMimeType,
                  text: JSON.stringify({ data: { text: "response-mime-hidden-fixture" } }),
                },
              },
            }],
          },
        },
        visible: "response-mime-visible-fixture",
        visibleLocation: "request.body.payload.text",
        hidden: "response-mime-hidden-fixture",
      },
      {
        har: {
          log: {
            entries: [{
              request: {
                method: "POST",
                url: `${targetOrigin}/api/messages`,
                postData: {
                  mimeType: "application/json",
                  text: JSON.stringify({ payload: { text: "base64-visible-fixture" } }),
                },
              },
              response: {
                status: 200,
                content: {
                  mimeType: "application/json",
                  encoding: "base64",
                  text: "base64-hidden-fixture",
                },
              },
            }],
          },
        },
        visible: "base64-visible-fixture",
        visibleLocation: "request.body.payload.text",
        hidden: "base64-hidden-fixture",
      },
    ] as const;
    for (const scenario of mimeCases) {
      const result = reviewDerivationHarValue(
        scenario.har,
        targetOrigin,
        {
          kind: "entry",
          entryIndex: 0,
          fixtures: parseDerivationReviewFixtures({
            visible: scenario.visible,
            hidden: scenario.hidden,
          }),
        },
      );
      expect(result.kind).toBe("entry");
      if (result.kind !== "entry") throw new Error("expected entry review");
      expect(result.fixtureMatches).toEqual([
        { label: "visible", locations: [scenario.visibleLocation], truncated: true },
        { label: "hidden", locations: [], truncated: true },
      ]);
    }

    const invalid = reviewDerivationHarValue(
      rawJsonExchangeHar(
        "{\"payload\":{\"text\":\"malformed-json-fixture\"}",
        "{\"data\":{}}",
      ),
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: parseDerivationReviewFixtures({ invalid: "malformed-json-fixture" }),
      },
    );
    expect(invalid.kind).toBe("entry");
    if (invalid.kind !== "entry") throw new Error("expected entry review");
    expect(invalid.fixtureMatches).toEqual([{
      label: "invalid",
      locations: [],
      truncated: false,
    }]);
    expect(JSON.stringify(invalid)).not.toContain("malformed-json-fixture");
  });

  test("rejects unsafe selection and fixture shapes without including fixture values in errors", () => {
    expect(() => reviewDerivationHarValue(fixtureHar(), targetOrigin, {
      kind: "entry",
      entryIndex: 0,
      fixtures: {},
    })).toThrow("not a reviewable first-party API exchange");
    expect(() => reviewDerivationHarValue(fixtureHar(), targetOrigin, {
      kind: "entry",
      entryIndex: 99,
      fixtures: {},
    })).toThrow("outside the captured HAR");
    expect(() => reviewDerivationHarValue(fixtureHar(), targetOrigin, {
      kind: "list",
      offset: 0,
      limit: 101,
    })).toThrow("bounds");

    let message = "";
    try {
      parseDerivationReviewFixtures({ bad: "fixture-value-that-must-not-appear", second: 2 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("second");
    expect(message).not.toContain("fixture-value-that-must-not-appear");
    expect(() => parseDerivationReviewFixtures({ "Bad Label": "private" })).toThrow("lowercase identifiers");
    expect(() => parseDerivationReviewFixtures({})).toThrow("1-50");
    const tooManyFixtures = Object.fromEntries(
      Array.from({ length: 51 }, (_value, index) => [`fixture_${index}`, `value-${index}`]),
    );
    expect(() => parseDerivationReviewFixtures(tooManyFixtures)).toThrow("1-50");
    expect(() => reviewDerivationHarValue(
      jsonExchangeHar({ payload: { text: "direct-review-fixture" } }),
      targetOrigin,
      {
        kind: "entry",
        entryIndex: 0,
        fixtures: tooManyFixtures,
      },
    )).toThrow("0-50");
  });
});
