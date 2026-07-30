import { describe, expect, test } from "bun:test";

import {
  bootstrapMetaComet,
  consumeMetaCometRequestProof,
  materializeMetaCometRequestProof,
  META_COMET_FIELD_CLASSIFICATIONS,
  nextMetaCometRequestCounter,
  type MetaCometRequestFieldName,
} from "./meta-bootstrap";
import {
  buildMetaRelayRequest,
  defineMetaOperationDescriptor,
  META_RELAY_ORIGINS,
  type MetaOperationDescriptor,
  type MetaRelayRequest,
} from "./meta-web-descriptors";

const VIEWER_ID = "2468013579";
const FB_DTSG = "AQH-private-dtsg_token:42";
const LSD = "private-lsd_token";
const HSI = "7392731950764655501";
const REVISION = 1_014_951_646;
const COMET_REQUEST = 15;

const TEST_REQUEST_DESCRIPTOR = defineMetaOperationDescriptor({
  schemaVersion: 1,
  id: "facebook.test-proof-query",
  platform: "facebook",
  kind: "query",
  operationType: "query",
  friendlyName: "WrenchTestProofQuery",
  docId: "12345678901234567",
  origin: META_RELAY_ORIGINS.facebook,
  method: "POST",
  path: "/api/graphql/",
  contract: {
    state: "observed",
    contractVersion: 1,
    evidenceId: "test-only-proof-binding",
  },
  access: { kind: "personal", actorBinding: "viewer" },
  proofs: [
    {
      kind: "viewer",
      source: "bootstrap.viewer",
      sinks: ["access.viewer-id", "form.__user"],
    },
    {
      kind: "actor",
      source: "bootstrap.actor",
      sinks: ["access.actor-id", "form.av"],
    },
    {
      kind: "fb_dtsg",
      source: "bootstrap.fb_dtsg",
      sinks: ["form.fb_dtsg"],
    },
    {
      kind: "jazoest",
      source: "derived.fb_dtsg-jazoest",
      sinks: ["form.jazoest"],
    },
    {
      kind: "lsd",
      source: "bootstrap.lsd",
      sinks: ["form.lsd"],
    },
    {
      kind: "client-revision",
      source: "bootstrap.client-revision",
      sinks: ["form.__rev"],
    },
    {
      kind: "hsi",
      source: "bootstrap.hsi",
      sinks: ["form.__hsi"],
    },
    {
      kind: "comet-environment",
      source: "bootstrap.comet-environment",
      sinks: ["form.__comet_req"],
    },
    {
      kind: "request-counter",
      source: "session.request-counter",
      sinks: ["form.__req"],
    },
  ],
  variables: { fields: [] },
  pagination: { kind: "none" },
  responseRoots: [{
    kind: "query-data",
    path: ["viewer"],
  }],
});

function requestForDescriptor(
  descriptor: MetaOperationDescriptor,
  viewerId = VIEWER_ID,
): MetaRelayRequest {
  return buildMetaRelayRequest(descriptor, {
    input: {},
    access: {
      kind: "personal",
      platform: "facebook",
      viewerId,
      actorId: viewerId,
      targetId: viewerId,
    },
  });
}

function proofRequest(viewerId = VIEWER_ID): MetaRelayRequest {
  return requestForDescriptor(TEST_REQUEST_DESCRIPTOR, viewerId);
}

type ModuleTuple = readonly [string, readonly unknown[], Readonly<Record<string, unknown>>, number];

function moduleTuple(
  name: string,
  payload: Readonly<Record<string, unknown>>,
): ModuleTuple {
  return Object.freeze([name, Object.freeze([]), Object.freeze(payload), 1]);
}

function reviewedModules(
  overrides: Partial<Readonly<Record<string, Readonly<Record<string, unknown>>>>> = {},
): readonly ModuleTuple[] {
  return Object.freeze([
    moduleTuple("CurrentUserInitialData", overrides.CurrentUserInitialData ?? {
      ACCOUNT_ID: VIEWER_ID,
      USER_ID: VIEWER_ID,
      NAME: "Fixture",
      SHORT_NAME: "Fixture",
      IS_BUSINESS_PERSON_ACCOUNT: false,
      HAS_SECONDARY_BUSINESS_PERSON: false,
      IS_FACEBOOK_WORK_ACCOUNT: false,
      IS_MESSENGER_ONLY_USER: false,
      IS_DEACTIVATED_ALLOWED_ON_MESSENGER: false,
      IS_MESSENGER_CALL_GUEST_USER: false,
      IS_WORK_MESSENGER_CALL_GUEST_USER: false,
      IS_WORKROOMS_USER: false,
      APP_ID: "2220391788200892",
      IS_BUSINESS_DOMAIN: false,
      IS_INSTAGRAM_BUSINESS_PERSON: false,
      IS_WABA_BUSINESS_PERSON: false,
    }),
    moduleTuple("RelayAPIConfigDefaults", overrides.RelayAPIConfigDefaults ?? {
      accessToken: "",
      actorID: VIEWER_ID,
      customHeaders: {},
      enableNetworkLogger: false,
      enableVerboseNetworkLogger: false,
      fetchTimeout: 30_000,
      graphBatchURI: "/api/graphqlbatch/",
      graphURI: "/api/graphql/",
      retryDelays: [1_000, 3_000],
      useXController: true,
      xhrEncoding: null,
      subscriptionTopicURI: null,
      withCredentials: false,
      isProductionEndpoint: false,
      workRequestTaggingProduct: null,
      encryptionKeyParams: null,
    }),
    moduleTuple("DTSGInitialData", overrides.DTSGInitialData ?? {
      token: FB_DTSG,
    }),
    moduleTuple("SprinkleConfig", overrides.SprinkleConfig ?? {
      param_name: "jazoest",
      version: 2,
      should_randomize: false,
    }),
    moduleTuple("LSD", overrides.LSD ?? {
      token: LSD,
    }),
    moduleTuple("SiteData", overrides.SiteData ?? {
      server_revision: REVISION + 1,
      client_revision: REVISION,
      is_comet: true,
      hsi: HSI,
      comet_env: COMET_REQUEST,
      wbloks_env: false,
      __spin_r: REVISION,
    }),
  ]);
}

function rootWithModules(modules: readonly ModuleTuple[]): unknown {
  return {
    require: [
      ["ScheduledServerJS", "handle", null, [{
        __bbox: {
          define: [
            moduleTuple("UnrelatedModule", { token: "must-not-be-used" }),
            ...modules,
          ],
        },
      }]],
    ],
  };
}

function rootWithHydratedModules(
  modules: readonly ModuleTuple[],
  asyncModuleName = "AsyncData",
  method = "resolve",
  args: readonly unknown[] = [],
  payloadKey = "adp_WebWorkerV2HasteResponsePreloader_TestBundle_abc123",
): unknown {
  return {
    require: [
      ["ScheduledServerJS", "handle", null, [{
        __bbox: {
          require: [[asyncModuleName, method, args, [
            payloadKey,
            {
              data: {
                __bbox: {
                  hrp: {
                    jsmods: { define: modules },
                  },
                },
              },
            },
          ]]],
        },
      }]],
    ],
  };
}

function parserFor(roots: unknown): (html: unknown) => unknown {
  return (html) => {
    expect(html).toBe("<root-html>");
    return roots;
  };
}

function bootstrap(
  modules: readonly ModuleTuple[] = reviewedModules(),
) {
  return bootstrapMetaComet("<root-html>", {
    parseMetaJsonScripts: parserFor([rootWithModules(modules)]),
    expectedViewerId: VIEWER_ID,
    expectedActingId: VIEWER_ID,
  });
}

function jazoest(token: string): string {
  let sum = 0;
  for (let index = 0; index < token.length; index += 1) sum += token.charCodeAt(index);
  return `2${sum}`;
}

function rejectionMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected rejection");
}

describe("Facebook Comet bootstrap proof model", () => {
  test("extracts one bound identity and emits exact proof/build fields only to a one-use network sink", () => {
    const value = bootstrap();
    expect(value).toMatchObject({
      viewerId: VIEWER_ID,
      actingId: VIEWER_ID,
      evidence: {
        provider: "facebook-comet",
        identityBound: true,
      },
    });

    const request = proofRequest();
    const proof = materializeMetaCometRequestProof(value, request);
    const fields = new Map<MetaCometRequestFieldName, string>();
    const evidence = consumeMetaCometRequestProof(proof, request, {
      sink: "network-request",
      write: (name: MetaCometRequestFieldName, rawValue: string) => {
        fields.set(name, rawValue);
      },
    });
    expect(Object.fromEntries(fields)).toEqual({
      __user: VIEWER_ID,
      av: VIEWER_ID,
      fb_dtsg: FB_DTSG,
      jazoest: jazoest(FB_DTSG),
      lsd: LSD,
      __rev: String(REVISION),
      __hsi: HSI,
      __comet_req: String(COMET_REQUEST),
      __req: "1",
    });
    expect(evidence).toEqual(proof.evidence);
    expect(evidence.fields.map(({ name, class: valueClass }) => [name, valueClass])).toEqual([
      ["__user", "identity"],
      ["av", "identity"],
      ["fb_dtsg", "csrf-proof"],
      ["jazoest", "derived-proof"],
      ["lsd", "bootstrap-proof"],
      ["__rev", "build"],
      ["__hsi", "build"],
      ["__comet_req", "build"],
      ["__req", "request-counter"],
    ]);
    expect(() => consumeMetaCometRequestProof(proof, request, {
      sink: "network-request",
      write: () => undefined,
    })).toThrow("already consumed");
  });

  test("binds proof material to one exact request handle and access context", () => {
    const value = bootstrap();
    const request = proofRequest();
    const otherRequest = proofRequest();
    const proof = materializeMetaCometRequestProof(value, request);
    const secondProof = materializeMetaCometRequestProof(value, request);

    expect(() => consumeMetaCometRequestProof(proof, otherRequest, {
      sink: "network-request",
      write: () => undefined,
    })).toThrow("did not match its request handle");

    consumeMetaCometRequestProof(proof, request, {
      sink: "network-request",
      write: () => undefined,
    });
    expect(() => consumeMetaCometRequestProof(secondProof, request, {
      sink: "network-request",
      write: () => undefined,
    })).toThrow("request handle was already consumed");

    expect(() => materializeMetaCometRequestProof(
      bootstrap(),
      proofRequest("987654321"),
    )).toThrow("did not match its request access coordinates");
  });

  test("emits and reports only the proof fields declared by the bound descriptor", () => {
    const subsetDescriptor = defineMetaOperationDescriptor({
      ...TEST_REQUEST_DESCRIPTOR,
      id: "facebook.test-proof-subset-query",
      friendlyName: "WrenchTestProofSubsetQuery",
      docId: "12345678901234568",
      proofs: TEST_REQUEST_DESCRIPTOR.proofs.filter(({ kind }) =>
        kind === "viewer" || kind === "actor"),
    });
    const request = requestForDescriptor(subsetDescriptor);
    const proof = materializeMetaCometRequestProof(bootstrap(), request);
    const fields = new Map<MetaCometRequestFieldName, string>();
    const evidence = consumeMetaCometRequestProof(proof, request, {
      sink: "network-request",
      write: (name: MetaCometRequestFieldName, value: string) => {
        fields.set(name, value);
      },
    });
    expect([...fields]).toEqual([
      ["__user", VIEWER_ID],
      ["av", VIEWER_ID],
    ]);
    expect(evidence).toBe(proof.evidence);
    expect(evidence.fields.map(({ name }) => name)).toEqual(["__user", "av"]);
  });

  test("keeps all raw proof and build values out of serialization, reflection, and evidence", () => {
    const value = bootstrap();
    const proof = materializeMetaCometRequestProof(value, proofRequest());
    const rendered = [
      JSON.stringify(value),
      JSON.stringify(value.evidence),
      JSON.stringify(proof),
      JSON.stringify(proof.evidence),
      Object.prototype.toString.call(proof),
      Bun.inspect(proof),
      JSON.stringify(Object.entries(proof)),
      JSON.stringify(META_COMET_FIELD_CLASSIFICATIONS),
    ].join("\n");
    for (const secret of [
      FB_DTSG,
      LSD,
      jazoest(FB_DTSG),
      HSI,
      String(REVISION),
      String(COMET_REQUEST),
    ]) {
      expect(rendered).not.toContain(secret);
    }
    expect(JSON.parse(JSON.stringify(proof))).toEqual({
      evidence: proof.evidence,
    });
    expect(Object.keys(proof)).toEqual(["evidence"]);
  });

  test("generates the reviewed monotonic base-36 request counter without clock or randomness", () => {
    const value = bootstrap();
    expect(Array.from({ length: 38 }, () => nextMetaCometRequestCounter(value))).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9",
      "a", "b", "c", "d", "e", "f", "g", "h", "i",
      "j", "k", "l", "m", "n", "o", "p", "q", "r",
      "s", "t", "u", "v", "w", "x", "y", "z", "10",
      "11", "12",
    ]);
    const request = proofRequest();
    const proof = materializeMetaCometRequestProof(value, request);
    let counter = "";
    consumeMetaCometRequestProof(proof, request, {
      sink: "network-request",
      write: (name: MetaCometRequestFieldName, rawValue: string) => {
        if (name === "__req") counter = rawValue;
      },
    });
    expect(counter).toBe("13");
  });

  test("classifies every identity, proof, build, and request value by source, sink, and lifetime", () => {
    expect(META_COMET_FIELD_CLASSIFICATIONS).toEqual([
      {
        name: "viewerId",
        class: "identity",
        source: "bootstrap.viewer",
        sinks: ["access.viewer-id", "form.__user"],
        lifetime: "browser-session",
      },
      {
        name: "actingId",
        class: "identity",
        source: "bootstrap.actor",
        sinks: ["access.actor-id", "form.av"],
        lifetime: "browser-session",
      },
      {
        name: "fb_dtsg",
        class: "csrf-proof",
        source: "bootstrap.fb_dtsg",
        sinks: ["form.fb_dtsg"],
        lifetime: "bootstrap",
      },
      {
        name: "jazoest",
        class: "derived-proof",
        source: "derived.fb_dtsg-jazoest",
        sinks: ["form.jazoest"],
        lifetime: "bootstrap",
      },
      {
        name: "lsd",
        class: "bootstrap-proof",
        source: "bootstrap.lsd",
        sinks: ["form.lsd"],
        lifetime: "bootstrap",
      },
      {
        name: "__rev",
        class: "build",
        source: "bootstrap.client-revision",
        sinks: ["form.__rev"],
        lifetime: "build",
      },
      {
        name: "__hsi",
        class: "build",
        source: "bootstrap.hsi",
        sinks: ["form.__hsi"],
        lifetime: "bootstrap",
      },
      {
        name: "__comet_req",
        class: "build",
        source: "bootstrap.comet-environment",
        sinks: ["form.__comet_req"],
        lifetime: "build",
      },
      {
        name: "__req",
        class: "request-counter",
        source: "session.request-counter",
        sinks: ["form.__req"],
        lifetime: "request",
      },
    ]);
  });

  test("rejects duplicate modules and multiple Relay-anchored bootstrap roots", () => {
    const modules = reviewedModules();
    const first = modules[0]!;
    const duplicate = [
      ...modules,
      moduleTuple(first[0], { ...first[2] }),
    ];
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([rootWithModules(duplicate)]),
    })).toThrow("duplicate CurrentUserInitialData");

    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithModules(modules),
        rootWithModules(reviewedModules()),
      ]),
    })).toThrow("multiple RelayAPIConfigDefaults anchor roots");
  });

  test("anchors one coherent bootstrap while accepting identity-bound hydrated pagelet copies", () => {
    const modules = reviewedModules();
    const hydrated = reviewedModules({
      DTSGInitialData: { token: "AQH-hydrated-dtsg_token:84" },
      LSD: { token: "hydrated-lsd_token" },
      SiteData: {
        server_revision: REVISION + 2,
        client_revision: REVISION + 1,
        is_comet: true,
        hsi: "8392731950764655501",
        comet_env: COMET_REQUEST,
        wbloks_env: false,
        __spin_r: REVISION + 1,
      },
    }).filter(([name]) => name !== "RelayAPIConfigDefaults");
    const result = bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithModules(modules),
        rootWithModules(hydrated),
      ]),
      expectedViewerId: VIEWER_ID,
      expectedActingId: VIEWER_ID,
    });
    expect(result.evidence.identityBound).toBe(true);

    const fields = new Map<MetaCometRequestFieldName, string>();
    const request = proofRequest();
    consumeMetaCometRequestProof(
      materializeMetaCometRequestProof(result, request),
      request,
      {
      sink: "network-request",
      write: (name: MetaCometRequestFieldName, value: string) => fields.set(name, value),
      },
    );
    expect(fields.get("fb_dtsg")).toBe(FB_DTSG);
    expect(fields.get("lsd")).toBe(LSD);

    const driftedIdentity = reviewedModules({
      CurrentUserInitialData: {
        ACCOUNT_ID: "987654321",
        USER_ID: "987654321",
      },
    }).filter(([name]) => name !== "RelayAPIConfigDefaults");
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithModules(modules),
        rootWithModules(driftedIdentity),
      ]),
    })).toThrow("identities drifted across hydrated roots");
  });

  test("rejects missing proof modules and never substitutes lookalike token fields", () => {
    const modules = reviewedModules();
    for (const omitted of [
      "CurrentUserInitialData",
      "RelayAPIConfigDefaults",
      "DTSGInitialData",
      "SprinkleConfig",
      "LSD",
      "SiteData",
    ]) {
      const without = modules.filter(([name]) => name !== omitted);
      expect(() => bootstrapMetaComet("<root-html>", {
        parseMetaJsonScripts: parserFor([{
          token: FB_DTSG,
          actorID: VIEWER_ID,
          client_revision: REVISION,
          require: without,
        }]),
      })).toThrow(`omitted ${omitted}`);
    }
  });

  test("rejects viewer, actor, and externally expected identity disagreement", () => {
    expect(() => bootstrap(reviewedModules({
      CurrentUserInitialData: {
        ACCOUNT_ID: VIEWER_ID,
        USER_ID: "987654321",
      },
    }))).toThrow("viewer identities did not agree");

    expect(() => bootstrap(reviewedModules({
      RelayAPIConfigDefaults: { actorID: "987654321" },
    }))).toThrow("viewer and actor did not agree");

    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([rootWithModules(reviewedModules())]),
      expectedViewerId: "987654321",
    })).toThrow("viewer did not match");
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([rootWithModules(reviewedModules())]),
      expectedActingId: "987654321",
    })).toThrow("actor did not match");
  });

  test("rejects malformed proof/build values and unsupported jazoest modes without echoing them", () => {
    const privateMalformed = "PRIVATE TOKEN WITH SPACES";
    expect(bootstrap(reviewedModules({
      SiteData: {
        client_revision: REVISION,
        hsi: HSI,
        comet_env: COMET_REQUEST,
        wbloks_env: false,
      },
    })).viewerId).toBe(VIEWER_ID);
    for (const [moduleName, payload, expected] of [
      ["DTSGInitialData", { token: privateMalformed }, "DTSGInitialData.token"],
      ["LSD", { token: privateMalformed }, "LSD.token"],
      ["SprinkleConfig", {
        param_name: "jazoest",
        version: 3,
        should_randomize: false,
      }, "jazoest derivation"],
      ["SprinkleConfig", {
        param_name: "jazoest",
        version: 2,
        should_randomize: true,
      }, "jazoest derivation"],
      ["SiteData", {
        client_revision: REVISION,
        hsi: HSI,
        comet_env: 0,
        wbloks_env: false,
        is_comet: true,
      }, "comet_env"],
      ["SiteData", {
        client_revision: REVISION,
        hsi: HSI,
        comet_env: COMET_REQUEST,
        wbloks_env: true,
        is_comet: true,
      }, "Comet environment"],
      ["SiteData", {
        client_revision: REVISION,
        hsi: HSI,
        comet_env: COMET_REQUEST,
        wbloks_env: false,
        is_comet: false,
      }, "Comet environment"],
      ["SiteData", {
        client_revision: REVISION,
        hsi: HSI,
        comet_env: COMET_REQUEST,
        wbloks_env: false,
        is_comet: "true",
      }, "Comet environment"],
    ] as const) {
      const message = rejectionMessage(() => bootstrap(reviewedModules({
        [moduleName]: payload,
      })));
      expect(message).toContain(expected);
      expect(message).not.toContain(privateMalformed);
    }
  });

  test("rejects extra module, payload, option, and sink fields", () => {
    const modules = reviewedModules();
    const malformedTuple = [
      ...modules.slice(0, 2),
      [...modules[2]!, "extra"],
      ...modules.slice(3),
    ];
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([rootWithModules(malformedTuple as readonly ModuleTuple[])]),
    })).toThrow("DTSGInitialData module is malformed");

    expect(() => bootstrap(reviewedModules({
      LSD: { token: LSD, unreviewed: "field" },
    }))).toThrow("LSD payload has unsupported fields");

    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([rootWithModules(modules)]),
      extra: true,
    })).toThrow("options has unsupported fields");

    const request = proofRequest();
    const proof = materializeMetaCometRequestProof(bootstrap(), request);
    expect(() => consumeMetaCometRequestProof(proof, request, {
      sink: "network-request",
      write: () => undefined,
      extra: true,
    })).toThrow("sink has unsupported fields");
  });

  test("accepts only exact root or ScheduledServerJS module containers", () => {
    expect(bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([{ require: reviewedModules() }]),
      expectedViewerId: VIEWER_ID,
      expectedActingId: VIEWER_ID,
    }).evidence.identityBound).toBe(true);
    expect(bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithHydratedModules(reviewedModules()),
      ]),
      expectedViewerId: VIEWER_ID,
      expectedActingId: VIEWER_ID,
    }).evidence.identityBound).toBe(true);
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithHydratedModules(reviewedModules(), "AsyncDataLookalike"),
      ]),
    })).toThrow("outside a reviewed module path");
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithHydratedModules(reviewedModules(), "AsyncData", "unreviewed"),
      ]),
    })).toThrow("outside a reviewed module path");
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithHydratedModules(
          reviewedModules(),
          "AsyncData",
          "resolve",
          ["unexpected"],
        ),
      ]),
    })).toThrow("outside a reviewed module path");
    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([
        rootWithHydratedModules(
          reviewedModules(),
          "AsyncData",
          "resolve",
          [],
          "adp_UnrelatedPreloader_abc123",
        ),
      ]),
    })).toThrow("outside a reviewed module path");

    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([{
        unreviewed: [moduleTuple("DTSGInitialData", { token: FB_DTSG })],
        require: reviewedModules(),
      }]),
    })).toThrow("outside a reviewed module path");

    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([{
        unrelated: {
          require: reviewedModules(),
        },
      }]),
    })).toThrow("outside a reviewed module path");

    expect(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: parserFor([{
        require: [
          ["UnrelatedServerJS", "handle", null, [{
            __bbox: { define: reviewedModules() },
          }]],
        ],
      }]),
    })).toThrow("outside a reviewed module path");
  });

  test("rejects malformed foreign roots", () => {
    for (const roots of [
      null,
      [],
      "not-roots",
      [{ require: [undefined] }],
      [{ require: [[Number.NaN]] }],
    ]) {
      expect(() => bootstrapMetaComet("<root-html>", {
        parseMetaJsonScripts: parserFor(roots),
      })).toThrow();
    }
  });

  test("redacts parser and network-sink failures and rejects non-network sinks", () => {
    const parserSecret = "parser-private-value";
    const parserMessage = rejectionMessage(() => bootstrapMetaComet("<root-html>", {
      parseMetaJsonScripts: () => {
        throw new Error(parserSecret);
      },
    }));
    expect(parserMessage).toBe("Facebook Comet bootstrap JSON parsing failed");
    expect(parserMessage).not.toContain(parserSecret);

    const request = proofRequest();
    const proof = materializeMetaCometRequestProof(bootstrap(), request);
    expect(() => consumeMetaCometRequestProof(proof, request, {
      sink: "receipt",
      write: () => undefined,
    })).toThrow("only to the network-request sink");

    const secondRequest = proofRequest();
    const secondProof = materializeMetaCometRequestProof(bootstrap(), secondRequest);
    const sinkMessage = rejectionMessage(() => consumeMetaCometRequestProof(secondProof, secondRequest, {
      sink: "network-request",
      write: (_name: MetaCometRequestFieldName, rawValue: string) => {
        throw new Error(rawValue);
      },
    }));
    expect(sinkMessage).toBe("Facebook Comet request-proof network sink failed");
    for (const secret of [FB_DTSG, LSD, HSI]) expect(sinkMessage).not.toContain(secret);
    expect(() => consumeMetaCometRequestProof(secondProof, secondRequest, {
      sink: "network-request",
      write: () => undefined,
    })).toThrow("already consumed");
  });

  test("rejects forged bootstrap and request-proof handles", () => {
    const forgedBootstrap = {
      viewerId: VIEWER_ID,
      actingId: VIEWER_ID,
      evidence: bootstrap().evidence,
    };
    expect(() => nextMetaCometRequestCounter(forgedBootstrap)).toThrow("handle is invalid");
    expect(() => materializeMetaCometRequestProof(
      forgedBootstrap,
      proofRequest(),
    )).toThrow("handle is invalid");

    const request = proofRequest();
    const genuine = materializeMetaCometRequestProof(bootstrap(), request);
    const forgedProof = { evidence: genuine.evidence };
    expect(() => consumeMetaCometRequestProof(
      forgedProof as typeof genuine,
      request,
      { sink: "network-request", write: () => undefined },
    )).toThrow("handle is invalid");
  });
});
