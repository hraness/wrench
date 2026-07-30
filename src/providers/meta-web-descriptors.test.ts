import { describe, expect, test } from "bun:test";

import {
  META_RELAY_ORIGINS,
  assertMetaDispatchScheduleBinding,
  assertMetaDocId,
  assertMetaFriendlyName,
  assertMetaPaginationCursorBinding,
  assertMetaRelayResponseBinding,
  bindMetaAccessContext,
  bindMetaPaginationCursor,
  buildMetaRelayRequest,
  buildMetaRelayVariables,
  defineMetaOperationDescriptor,
  metaOperationDescriptorKey,
  resolveMetaOperationDescriptor,
  type MetaAccessContext,
  type MetaObservedOperationDescriptor,
  type MetaOperationDescriptor,
} from "./meta-web-descriptors";

const TEST_DOC_ID = "99999";
const OTHER_TEST_DOC_ID = "88888";

const personalAccess = Object.freeze({
  kind: "personal",
  platform: "facebook",
  viewerId: "viewer_1",
  actorId: "viewer_1",
  targetId: "feed_1",
} as const satisfies MetaAccessContext);

const pageAccess = Object.freeze({
  kind: "page",
  platform: "facebook",
  viewerId: "viewer_1",
  actorId: "page_1",
  targetId: "page_1",
} as const satisfies MetaAccessContext);

const allProofs = Object.freeze([
  Object.freeze({
    kind: "viewer",
    source: "bootstrap.viewer",
    sinks: Object.freeze(["access.viewer-id", "form.__user"]),
  }),
  Object.freeze({
    kind: "actor",
    source: "bootstrap.actor",
    sinks: Object.freeze(["access.actor-id", "form.av"]),
  }),
  Object.freeze({
    kind: "fb_dtsg",
    source: "bootstrap.fb_dtsg",
    sinks: Object.freeze(["form.fb_dtsg"]),
  }),
  Object.freeze({
    kind: "jazoest",
    source: "derived.fb_dtsg-jazoest",
    sinks: Object.freeze(["form.jazoest"]),
  }),
  Object.freeze({
    kind: "lsd",
    source: "bootstrap.lsd",
    sinks: Object.freeze(["form.lsd"]),
  }),
  Object.freeze({
    kind: "client-revision",
    source: "bootstrap.client-revision",
    sinks: Object.freeze(["form.__rev"]),
  }),
  Object.freeze({
    kind: "hsi",
    source: "bootstrap.hsi",
    sinks: Object.freeze(["form.__hsi"]),
  }),
  Object.freeze({
    kind: "comet-environment",
    source: "bootstrap.comet-environment",
    sinks: Object.freeze(["form.__comet_req"]),
  }),
  Object.freeze({
    kind: "request-counter",
    source: "session.request-counter",
    sinks: Object.freeze(["form.__req"]),
  }),
]);

const queryValue = Object.freeze({
  schemaVersion: 1,
  id: "fixture.feed-query",
  platform: "facebook",
  kind: "query",
  operationType: "query",
  friendlyName: "FixtureFeedQuery",
  docId: TEST_DOC_ID,
  origin: META_RELAY_ORIGINS.facebook,
  method: "POST",
  path: "/api/graphql/",
  contract: Object.freeze({
    state: "observed",
    contractVersion: 1,
    evidenceId: "deterministic-fixture",
  }),
  access: Object.freeze({ kind: "personal", actorBinding: "viewer" }),
  proofs: allProofs,
  variables: Object.freeze({
    fields: Object.freeze([
      Object.freeze({
        name: "viewer_id",
        optional: false,
        source: Object.freeze({ kind: "viewer" }),
        schema: Object.freeze({ kind: "id" }),
      }),
      Object.freeze({
        name: "actor_id",
        optional: false,
        source: Object.freeze({ kind: "actor" }),
        schema: Object.freeze({ kind: "id" }),
      }),
      Object.freeze({
        name: "target_id",
        optional: false,
        source: Object.freeze({ kind: "target" }),
        schema: Object.freeze({ kind: "id" }),
      }),
      Object.freeze({
        name: "count",
        optional: false,
        source: Object.freeze({ kind: "input", key: "limit" }),
        schema: Object.freeze({ kind: "integer", minimum: 1, maximum: 50 }),
      }),
      Object.freeze({
        name: "filter",
        optional: true,
        source: Object.freeze({ kind: "input", key: "filter" }),
        schema: Object.freeze({
          kind: "object",
          fields: Object.freeze([
            Object.freeze({
              name: "include_hidden",
              optional: false,
              schema: Object.freeze({ kind: "boolean" }),
            }),
            Object.freeze({
              name: "mode",
              optional: false,
              schema: Object.freeze({
                kind: "enum",
                values: Object.freeze(["RECENT", "RANKED"]),
              }),
            }),
          ]),
        }),
      }),
      Object.freeze({
        name: "include_ads",
        optional: false,
        source: Object.freeze({ kind: "literal", value: false }),
        schema: Object.freeze({ kind: "literal", value: false }),
      }),
      Object.freeze({
        name: "cursor",
        optional: true,
        source: Object.freeze({ kind: "pagination" }),
        schema: Object.freeze({ kind: "cursor" }),
      }),
    ]),
  }),
  pagination: Object.freeze({ kind: "cursor", variableName: "cursor" }),
  responseRoots: Object.freeze([
    Object.freeze({
      kind: "query-data",
      path: Object.freeze(["data", "viewer", "feed"]),
    }),
    Object.freeze({
      kind: "prefetch-data",
      path: Object.freeze(["prefetch", "data", "viewer", "feed"]),
    }),
  ]),
});

function queryDescriptor(
  overrides: Readonly<Record<string, unknown>> = {},
): MetaOperationDescriptor {
  return defineMetaOperationDescriptor({ ...queryValue, ...overrides });
}

function pageReadbackDescriptor(
  overrides: Readonly<Record<string, unknown>> = {},
): MetaOperationDescriptor {
  return defineMetaOperationDescriptor({
    ...queryValue,
    id: "fixture.page-readback-query",
    friendlyName: "FixturePageReadbackQuery",
    docId: OTHER_TEST_DOC_ID,
    access: { kind: "page", actorBinding: "target" },
    variables: {
      fields: [
        {
          name: "actor_id",
          optional: false,
          source: { kind: "actor" },
          schema: { kind: "id" },
        },
        {
          name: "target_id",
          optional: false,
          source: { kind: "target" },
          schema: { kind: "id" },
        },
      ],
    },
    pagination: { kind: "none" },
    responseRoots: [{ kind: "query-data", path: ["data", "page", "state"] }],
    ...overrides,
  });
}

function mutationDescriptor(
  overrides: Readonly<Record<string, unknown>> = {},
): MetaOperationDescriptor {
  return defineMetaOperationDescriptor({
    ...queryValue,
    id: "fixture.page-mutation",
    kind: "mutation",
    operationType: "mutation",
    friendlyName: "FixturePageMutation",
    docId: "77777",
    access: { kind: "page", actorBinding: "target" },
    variables: {
      fields: [
        {
          name: "actor_id",
          optional: false,
          source: { kind: "actor" },
          schema: { kind: "id" },
        },
        {
          name: "target_id",
          optional: false,
          source: { kind: "target" },
          schema: { kind: "id" },
        },
        {
          name: "enabled",
          optional: false,
          source: { kind: "input", key: "enabled" },
          schema: { kind: "boolean" },
        },
      ],
    },
    pagination: { kind: "none" },
    responseRoots: [{ kind: "mutation-data", path: ["data", "page_set_state"] }],
    schedule: {
      kind: "single-dispatch",
      dispatchId: "fixture.page-state-dispatch",
      attempts: 1,
      retry: "never",
      readback: {
        kind: "independent-query",
        descriptorId: "fixture.page-readback-query",
        after: "dispatch-response",
        actorBinding: "same",
        targetBinding: "same",
        attempts: 1,
      },
    },
    ...overrides,
  });
}

function observedCandidate(
  descriptor: MetaOperationDescriptor,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    friendlyName: descriptor.friendlyName,
    docId: descriptor.docId,
    operationType: descriptor.operationType,
    origin: descriptor.origin,
    method: descriptor.method,
    path: descriptor.path,
    ...overrides,
  });
}

describe("strict code-owned Meta Relay descriptors", () => {
  test("defines deeply frozen discriminated query and mutation descriptors", () => {
    const query = queryDescriptor();
    const mutation = mutationDescriptor();
    expect(query).toMatchObject({ kind: "query", operationType: "query" });
    expect(mutation).toMatchObject({
      kind: "mutation",
      operationType: "mutation",
      method: "POST",
    });
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.variables.fields)).toBe(true);
    expect(Object.isFrozen(query.responseRoots[0]?.path)).toBe(true);
    expect(Object.isFrozen(mutation.kind === "mutation" ? mutation.schedule : null)).toBe(true);
  });

  test("validates friendly names and code-owned registered-operation revisions", () => {
    expect(assertMetaFriendlyName("FixtureFeedQuery")).toBe("FixtureFeedQuery");
    expect(assertMetaDocId(TEST_DOC_ID)).toBe(TEST_DOC_ID);
    for (const value of ["ab", "1FixtureQuery", "Fixture-Query", `A${"b".repeat(161)}`]) {
      expect(() => assertMetaFriendlyName(value)).toThrow();
    }
    for (const value of ["9999", "99x99", "9".repeat(33), 99999]) {
      expect(() => assertMetaDocId(value)).toThrow();
    }
  });

  test("rejects extra fields and operation, origin, method, and path drift", () => {
    const failures: readonly unknown[] = [
      { ...queryValue, extra: true },
      { ...queryValue, operationType: "mutation" },
      { ...queryValue, origin: META_RELAY_ORIGINS.instagram },
      { ...queryValue, method: "post" },
      { ...queryValue, path: "/ajax/graphql/" },
      {
        ...queryValue,
        access: { ...queryValue.access, extra: true },
      },
      {
        ...queryValue,
        contract: { ...queryValue.contract, extra: true },
      },
      {
        ...queryValue,
        responseRoots: [{ kind: "mutation-data", path: ["data", "result"] }],
      },
    ];
    for (const value of failures) {
      expect(() => defineMetaOperationDescriptor(value)).toThrow();
    }
    expect(() => defineMetaOperationDescriptor({
      ...mutationDescriptor(),
      method: "GET",
    })).toThrow("mutations require POST");
  });

  test("rejects duplicate variable fields, enum values, response roots, and pagination drift", () => {
    const firstField = queryValue.variables.fields[0];
    expect(() => queryDescriptor({
      variables: { fields: [firstField, firstField] },
      pagination: { kind: "none" },
    })).toThrow("duplicate field");
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(() => queryDescriptor({
        variables: {
          fields: [{
            name,
            optional: false,
            source: { kind: "input", key: "value" },
            schema: { kind: "string", maximum: 10 },
          }],
        },
        pagination: { kind: "none" },
      })).toThrow("exact variable field name");
    }
    expect(() => queryDescriptor({
      variables: {
        fields: [{
          name: "mode",
          optional: false,
          source: { kind: "input", key: "mode" },
          schema: { kind: "enum", values: ["RECENT", "RECENT"] },
        }],
      },
      pagination: { kind: "none" },
    })).toThrow("duplicates");
    expect(() => queryDescriptor({
      responseRoots: [queryValue.responseRoots[0], queryValue.responseRoots[0]],
    })).toThrow("duplicate response root");
    expect(() => queryDescriptor({
      pagination: { kind: "cursor", variableName: "wrong_cursor" },
    })).toThrow("exactly one matching pagination variable");
    expect(() => queryDescriptor({
      pagination: { kind: "none" },
    })).toThrow("cannot declare a pagination variable");
  });

  test("keeps capture-required mutations inert and observed mutations scheduled once", () => {
    const inert = mutationDescriptor({
      contract: {
        state: "capture-required",
        contractVersion: 1,
        reason: "fixture has not proven dispatch or readback",
      },
      schedule: {
        kind: "inert",
        dispatches: [],
        readback: { kind: "none", reason: "capture required" },
      },
    });
    expect(inert.kind === "mutation" ? inert.schedule.kind : null).toBe("inert");
    expect(() => buildMetaRelayRequest(inert, {
      input: { enabled: true },
      access: pageAccess,
    })).toThrow("capture-required");
    expect(() => mutationDescriptor({
      schedule: {
        kind: "inert",
        dispatches: [],
        readback: { kind: "none", reason: "not ready" },
      },
    })).toThrow("observed Meta mutations require");
    expect(() => mutationDescriptor({
      contract: {
        state: "capture-required",
        contractVersion: 1,
        reason: "not ready",
      },
    })).toThrow("capture-required Meta mutations must");
  });
});

describe("Meta bootstrap proof source-to-sink declarations", () => {
  test("preserves only reviewed declarations and returns no raw proof values", () => {
    const request = buildMetaRelayRequest(queryDescriptor(), {
      input: { limit: 10 },
      access: personalAccess,
    });
    expect(request.proofFormFields).toEqual([
      "__user",
      "av",
      "fb_dtsg",
      "jazoest",
      "lsd",
      "__rev",
      "__hsi",
      "__comet_req",
      "__req",
    ]);
    expect(request.proofBindings.map((proof) => proof.source)).toEqual([
      "bootstrap.viewer",
      "bootstrap.actor",
      "bootstrap.fb_dtsg",
      "derived.fb_dtsg-jazoest",
      "bootstrap.lsd",
      "bootstrap.client-revision",
      "bootstrap.hsi",
      "bootstrap.comet-environment",
      "session.request-counter",
    ]);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("token-value");
    expect(serialized).not.toContain("proof-value");
  });

  test("rejects duplicate proof kinds and proof sinks", () => {
    expect(() => queryDescriptor({
      proofs: [allProofs[0], allProofs[0], allProofs[1]],
    })).toThrow("duplicate viewer proof");
    expect(() => queryDescriptor({
      proofs: [
        {
          kind: "viewer",
          source: "bootstrap.viewer",
          sinks: ["access.viewer-id", "access.viewer-id"],
        },
        allProofs[1],
      ],
    })).toThrow("duplicate proof sink");
  });

  test("rejects invalid proof sources, cross-kind sinks, and missing identity bindings", () => {
    const cases: readonly unknown[][] = [
      [
        { kind: "viewer", source: "user-input", sinks: ["access.viewer-id"] },
        allProofs[1],
      ],
      [
        { kind: "viewer", source: "bootstrap.viewer", sinks: ["form.fb_dtsg"] },
        allProofs[1],
      ],
      [
        allProofs[0],
        { kind: "actor", source: "bootstrap.actor", sinks: ["form.__user"] },
      ],
      [allProofs[1]],
      [allProofs[0]],
    ];
    for (const proofs of cases) {
      expect(() => queryDescriptor({ proofs })).toThrow();
    }
  });

  test("forbids form proof sinks on a GET query", () => {
    expect(() => queryDescriptor({ method: "GET" })).toThrow("form proof sink");
    const descriptor = queryDescriptor({
      method: "GET",
      proofs: [
        {
          kind: "viewer",
          source: "bootstrap.viewer",
          sinks: ["access.viewer-id"],
        },
        {
          kind: "actor",
          source: "bootstrap.actor",
          sinks: ["access.actor-id"],
        },
      ],
    });
    expect(buildMetaRelayRequest(descriptor, {
      input: { limit: 1 },
      access: personalAccess,
    }).parameterLocation).toBe("query");
  });
});

describe("Meta operation observation and drift", () => {
  test("resolves one exact current descriptor without turning observations into constants", () => {
    const descriptor = queryDescriptor();
    const expected: MetaObservedOperationDescriptor = {
      friendlyName: descriptor.friendlyName,
      docId: descriptor.docId,
      operationType: descriptor.operationType,
      origin: descriptor.origin,
      method: descriptor.method,
      path: descriptor.path,
    };
    expect(resolveMetaOperationDescriptor(
      [observedCandidate(descriptor)],
      descriptor,
    )).toEqual(expected);
  });

  test("rejects duplicate and ambiguous observed descriptors", () => {
    const descriptor = queryDescriptor();
    const exact = observedCandidate(descriptor);
    expect(() => resolveMetaOperationDescriptor([exact, exact], descriptor)).toThrow(
      "duplicate",
    );
    expect(() => resolveMetaOperationDescriptor([
      exact,
      observedCandidate(descriptor, { docId: OTHER_TEST_DOC_ID }),
    ], descriptor)).toThrow("ambiguous revision drift");
  });

  test("rejects extra observation fields, operation-type drift, transport drift, and docId drift", () => {
    const descriptor = queryDescriptor();
    expect(() => resolveMetaOperationDescriptor([
      observedCandidate(descriptor, { extra: true }),
    ], descriptor)).toThrow("unsupported field");
    expect(() => resolveMetaOperationDescriptor([
      observedCandidate(descriptor, { operationType: "mutation" }),
    ], descriptor)).toThrow("operation-type drift");
    expect(() => resolveMetaOperationDescriptor([
      observedCandidate(descriptor, { method: "GET" }),
    ], descriptor)).toThrow("transport drift");
    let failure: Error | null = null;
    try {
      resolveMetaOperationDescriptor([
        observedCandidate(descriptor, { docId: OTHER_TEST_DOC_ID }),
      ], descriptor);
    } catch (error) {
      failure = error instanceof Error ? error : null;
    }
    expect(failure?.message).toContain("docId drift");
    expect(failure?.message).not.toContain(OTHER_TEST_DOC_ID);
  });
});

describe("Meta viewer, actor, and target access binding", () => {
  test("binds personal, Page, group, and Marketplace access policies", () => {
    expect(bindMetaAccessContext(queryDescriptor(), personalAccess)).toEqual(personalAccess);
    expect(bindMetaAccessContext(pageReadbackDescriptor(), pageAccess)).toEqual(pageAccess);
    for (const kind of ["group", "marketplace"] as const) {
      const descriptor = queryDescriptor({
        id: `fixture.${kind}-query`,
        friendlyName: kind === "group" ? "FixtureGroupQuery" : "FixtureMarketplaceQuery",
        access: { kind, actorBinding: "viewer" },
      });
      const access = {
        kind,
        platform: "facebook",
        viewerId: "viewer_1",
        actorId: "viewer_1",
        targetId: `${kind}_1`,
      } as const;
      expect(bindMetaAccessContext(descriptor, access)).toEqual(access);
    }
  });

  test("rejects mismatched personal actors and Page actor-target bindings", () => {
    expect(() => bindMetaAccessContext(queryDescriptor(), {
      ...personalAccess,
      actorId: "other_actor",
    })).toThrow("actor did not match its viewer");
    expect(() => bindMetaAccessContext(pageReadbackDescriptor(), {
      ...pageAccess,
      actorId: "other_page",
    })).toThrow("actor did not match its target");
  });

  test("rejects scope, platform, target-shape extras, and non-Facebook scoped descriptors", () => {
    expect(() => bindMetaAccessContext(queryDescriptor(), {
      ...personalAccess,
      kind: "group",
    })).toThrow("kind did not match");
    expect(() => bindMetaAccessContext(queryDescriptor(), {
      ...personalAccess,
      platform: "instagram",
    })).toThrow("platform did not match");
    expect(() => bindMetaAccessContext(queryDescriptor(), {
      ...personalAccess,
      extra: true,
    })).toThrow("unsupported field");
    expect(() => queryDescriptor({
      platform: "instagram",
      origin: META_RELAY_ORIGINS.instagram,
      path: "/api/graphql",
      access: { kind: "group", actorBinding: "viewer" },
    })).toThrow("only on facebook");
  });
});

describe("exact Meta variables and request templates", () => {
  test("builds only descriptor-owned variables and exact transport parameters", () => {
    const descriptor = queryDescriptor();
    const variables = buildMetaRelayVariables(
      descriptor,
      {
        limit: 20,
        filter: { include_hidden: false, mode: "RECENT" },
      },
      personalAccess,
    );
    expect(variables).toEqual({
      viewer_id: "viewer_1",
      actor_id: "viewer_1",
      target_id: "feed_1",
      count: 20,
      filter: { include_hidden: false, mode: "RECENT" },
      include_ads: false,
    });
    const request = buildMetaRelayRequest(descriptor, {
      input: { limit: 20 },
      access: personalAccess,
    });
    expect(request).toMatchObject({
      descriptorId: "fixture.feed-query",
      operationType: "query",
      origin: "https://www.facebook.com",
      method: "POST",
      path: "/api/graphql/",
      url: "https://www.facebook.com/api/graphql/",
      parameterLocation: "form",
    });
    expect(request.parameters).toEqual([
      { name: "fb_api_req_friendly_name", value: "FixtureFeedQuery" },
      { name: "doc_id", value: TEST_DOC_ID },
      {
        name: "variables",
        value: JSON.stringify({
          viewer_id: "viewer_1",
          actor_id: "viewer_1",
          target_id: "feed_1",
          count: 20,
          include_ads: false,
        }),
      },
    ]);
  });

  test("rejects missing and extra semantic inputs plus nested variable drift", () => {
    const descriptor = queryDescriptor();
    expect(() => buildMetaRelayVariables(
      descriptor,
      {},
      personalAccess,
    )).toThrow("omitted required input.limit");
    expect(() => buildMetaRelayVariables(
      descriptor,
      { limit: 20, borrowed: true },
      personalAccess,
    )).toThrow("unsupported field");
    expect(() => buildMetaRelayVariables(
      descriptor,
      {
        limit: 20,
        filter: { include_hidden: false, mode: "RECENT", extra: true },
      },
      personalAccess,
    )).toThrow("unsupported field");
    expect(() => buildMetaRelayVariables(
      descriptor,
      { limit: 20, filter: { include_hidden: "false", mode: "RECENT" } },
      personalAccess,
    )).toThrow("must be boolean");
    expect(() => buildMetaRelayVariables(
      descriptor,
      { limit: 20, filter: { include_hidden: false, mode: "UNKNOWN" } },
      personalAccess,
    )).toThrow("enum value");
  });

  test("rejects extras at the request-builder boundary, including raw proof material", () => {
    const descriptor = queryDescriptor();
    expect(() => buildMetaRelayRequest(descriptor, {
      input: { limit: 20 },
      access: personalAccess,
      fbDtsg: "proof-value",
    })).toThrow("unsupported field");
  });
});

describe("descriptor-, actor-, target-, and chain-bound Meta pagination", () => {
  test("changes the cursor key for every security-relevant descriptor revision", () => {
    const original = queryDescriptor();
    const changedContract = defineMetaOperationDescriptor({
      ...queryValue,
      contract: {
        ...queryValue.contract,
        contractVersion: queryValue.contract.contractVersion + 1,
      },
    });
    const changedVariables = defineMetaOperationDescriptor({
      ...queryValue,
      variables: {
        fields: queryValue.variables.fields.map((field) =>
          field.name === "count"
            ? {
                ...field,
                schema: { kind: "integer", minimum: 2, maximum: 50 },
              }
            : field),
      },
    });
    const changedResponse = defineMetaOperationDescriptor({
      ...queryValue,
      responseRoots: [{
        kind: "query-data",
        path: ["data", "viewer", "alternate_feed"],
      }],
    });

    const keys = [
      original,
      changedContract,
      changedVariables,
      changedResponse,
    ].map(metaOperationDescriptorKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^meta1:[a-f0-9]{64}$/u);
  });

  test("issues a continuation bound to the producing descriptor and prior cursor", () => {
    const descriptor = queryDescriptor();
    const first = bindMetaPaginationCursor(
      descriptor,
      personalAccess,
      "cursor_page_2",
    );
    expect(first).toMatchObject({
      descriptorKey: metaOperationDescriptorKey(descriptor),
      actorId: "viewer_1",
      targetId: "feed_1",
      cursor: "cursor_page_2",
      previousCursor: null,
    });
    const second = bindMetaPaginationCursor(
      descriptor,
      personalAccess,
      "cursor_page_3",
      first,
    );
    expect(second.previousCursor).toBe("cursor_page_2");
    expect(assertMetaPaginationCursorBinding(
      descriptor,
      personalAccess,
      second,
    )).toBe(second);
    const request = buildMetaRelayRequest(descriptor, {
      input: { limit: 20 },
      access: personalAccess,
      pagination: first,
    });
    expect(JSON.parse(request.parameters[2]?.value ?? "{}")).toMatchObject({
      cursor: "cursor_page_2",
    });
  });

  test("rejects forged, descriptor-drifted, actor-drifted, and target-drifted cursors", () => {
    const descriptor = queryDescriptor();
    const cursor = bindMetaPaginationCursor(
      descriptor,
      personalAccess,
      "cursor_page_2",
    );
    expect(() => assertMetaPaginationCursorBinding(
      descriptor,
      personalAccess,
      { ...cursor },
    )).toThrow("not issued");
    expect(() => assertMetaPaginationCursorBinding(
      queryDescriptor({ docId: OTHER_TEST_DOC_ID }),
      personalAccess,
      cursor,
    )).toThrow("descriptor");
    expect(() => assertMetaPaginationCursorBinding(
      descriptor,
      {
        ...personalAccess,
        viewerId: "viewer_2",
        actorId: "viewer_2",
      },
      cursor,
    )).toThrow("actor");
    expect(() => assertMetaPaginationCursorBinding(
      descriptor,
      { ...personalAccess, targetId: "feed_2" },
      cursor,
    )).toThrow("target");
  });

  test("rejects repeated cursors, wrong prior chains, and pagination on an inert policy", () => {
    const descriptor = queryDescriptor();
    const first = bindMetaPaginationCursor(
      descriptor,
      personalAccess,
      "cursor_page_2",
    );
    expect(() => bindMetaPaginationCursor(
      descriptor,
      personalAccess,
      "cursor_page_2",
      first,
    )).toThrow("did not advance");
    expect(() => bindMetaPaginationCursor(
      descriptor,
      { ...personalAccess, targetId: "feed_2" },
      "cursor_page_3",
      first,
    )).toThrow("target");
    const notPageable = pageReadbackDescriptor();
    expect(() => bindMetaPaginationCursor(
      notPageable,
      pageAccess,
      "cursor_page_2",
    )).toThrow("does not permit pagination");
  });
});

describe("Meta response roots and mutation readback schedules", () => {
  test("selects one exact primary or prefetch response root variant", () => {
    const descriptor = queryDescriptor();
    const primary = { data: { viewer: { feed: { edges: [] } } } };
    expect(assertMetaRelayResponseBinding(descriptor, primary)).toMatchObject({
      descriptorId: "fixture.feed-query",
      operationType: "query",
      variant: { kind: "query-data" },
      value: { edges: [] },
    });
    const prefetch = {
      prefetch: { data: { viewer: { feed: { edges: ["fixture"] } } } },
    };
    expect(assertMetaRelayResponseBinding(descriptor, prefetch)).toMatchObject({
      variant: { kind: "prefetch-data" },
      value: { edges: ["fixture"] },
    });
  });

  test("rejects missing, ambiguous, errored, and malformed response envelopes", () => {
    const descriptor = queryDescriptor();
    expect(() => assertMetaRelayResponseBinding(descriptor, { data: {} })).toThrow(
      "omitted every reviewed root",
    );
    expect(() => assertMetaRelayResponseBinding(descriptor, {
      data: { viewer: { feed: {} } },
      prefetch: { data: { viewer: { feed: {} } } },
    })).toThrow("multiple reviewed root");
    expect(() => assertMetaRelayResponseBinding(descriptor, {
      data: { viewer: { feed: {} } },
      errors: [{ message: "fixture failure" }],
    })).toThrow("provider errors");
    expect(() => assertMetaRelayResponseBinding(descriptor, {
      data: { viewer: { feed: {} } },
      errors: {},
    })).toThrow("errors must be an array");
  });

  test("binds one mutation dispatch to an observed independent query readback", () => {
    const mutation = mutationDescriptor();
    const readback = pageReadbackDescriptor();
    expect(assertMetaDispatchScheduleBinding(mutation, readback)).toMatchObject({
      kind: "single-dispatch",
      attempts: 1,
      retry: "never",
      readback: {
        kind: "independent-query",
        descriptorId: "fixture.page-readback-query",
        actorBinding: "same",
        targetBinding: "same",
      },
    });
    expect(buildMetaRelayRequest(mutation, {
      input: { enabled: true },
      access: pageAccess,
    }).schedule).toMatchObject({ kind: "single-dispatch" });
  });

  test("rejects mismatched, mutating, capture-required, and cross-context readbacks", () => {
    const mutation = mutationDescriptor();
    expect(() => assertMetaDispatchScheduleBinding(
      mutation,
      pageReadbackDescriptor({ id: "fixture.other-readback-query" }),
    )).toThrow("descriptor ID");
    expect(() => assertMetaDispatchScheduleBinding(
      mutation,
      mutationDescriptor({ id: "fixture.other-mutation" }),
    )).toThrow("must be a query");
    expect(() => assertMetaDispatchScheduleBinding(
      mutation,
      pageReadbackDescriptor({
        contract: {
          state: "capture-required",
          contractVersion: 1,
          reason: "not observed",
        },
      }),
    )).toThrow("capture-required");
    expect(() => assertMetaDispatchScheduleBinding(
      mutation,
      queryDescriptor({ id: "fixture.page-readback-query" }),
    )).toThrow("actor and target access policy");
  });
});
