import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../canonical-json";
import {
  parseArticleDraftDocument,
  parseArticleDraftDocumentV2,
} from "../article-draft-document";

import {
  LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID,
  LINKEDIN_WEB_FOLDER_CATEGORIES,
  LINKEDIN_WEB_OPERATIONS,
  LINKEDIN_WEB_OPERATION_NAMES,
  RESTLI_V2_VALUE_LIMITS,
  assertLinkedInWebR1RequestAllowed,
  buildLinkedInArticleCoverPatch,
  buildLinkedInArticleContent,
  buildLinkedInArticleContentHtml,
  buildLinkedInArticleContentHtmlV2,
  buildLinkedInArticleContentPatch,
  buildLinkedInArticleContentPatchV2,
  buildLinkedInArticleContentV2,
  buildLinkedInArticleCreateBody,
  buildLinkedInArticleTitlePatch,
  buildLinkedInPostCreateVariables,
  encodeRestliV2Value,
  linkedInCsrfTokenFromJSessionId,
  linkedInArticleImageRegistrationDriftCategory,
  linkedInArticleDraftEditUrl,
  linkedInArticleDraftEnvelopeFromHtml,
  linkedInArticleDraftEntityUrl,
  linkedInMailboxUrnFromMiniProfile,
  linkedInMessengerConversationsUrl,
  linkedInOrganizationTarget,
  linkedInPersonalProfileTarget,
  linkedInPostReadbackUrl,
  linkedInWebFolderCategory,
  normalizeLinkedInGraphqlEnvelope,
  normalizeLinkedInArticleDraft,
  normalizeLinkedInArticleDraftV2,
  normalizeLinkedInArticleDraftV2Metadata,
  normalizeLinkedInArticleDraftV2Snapshot,
  normalizeLinkedInArticleImageUploadRegistration,
  normalizeLinkedInArticleImageUploadStatus,
  normalizeLinkedInMessagingList,
  normalizeLinkedInPostProjection,
  projectLinkedInOrganizationStats,
  projectLinkedInPersonalProfileStats,
  resolveLinkedInRegisteredQueryId,
} from "./linkedin-web";

const HASH_A = "0123456789abcdef0123456789abcdef";
const HASH_B = "fedcba9876543210fedcba9876543210";

function assertRejected(action: () => unknown, message: string): void {
  expect(action).toThrow(message);
}

describe("LinkedIn internal-web operation registry", () => {
  test("enumerates the complete semantic surface exactly once", () => {
    expect(LINKEDIN_WEB_OPERATION_NAMES).toEqual([
      "feeds.read",
      "contacts.list",
      "profiles.read",
      "organizations.read",
      "relationships.recommendations.read",
      "messaging.list",
      "messaging.read",
      "messaging.send",
      "posts.read",
      "posts.publish",
      "posts.repost",
      "posts.quote",
      "comments.read",
      "comments.create",
      "replies.create",
      "reactions.set",
      "relationships.connect",
      "articles.read",
      "articles.draft.save",
      "articles.publish",
    ]);
    expect(Object.keys(LINKEDIN_WEB_OPERATIONS).sort()).toEqual([...LINKEDIN_WEB_OPERATION_NAMES].sort());
    expect(new Set(LINKEDIN_WEB_OPERATION_NAMES).size).toBe(LINKEDIN_WEB_OPERATION_NAMES.length);
    expect(Object.isFrozen(LINKEDIN_WEB_OPERATION_NAMES)).toBeTrue();
    expect(Object.isFrozen(LINKEDIN_WEB_OPERATIONS)).toBeTrue();
    for (const contract of Object.values(LINKEDIN_WEB_OPERATIONS)) {
      expect(Object.isFrozen(contract)).toBeTrue();
      expect(Object.isFrozen(contract.requests)).toBeTrue();
      for (const request of contract.requests) expect(Object.isFrozen(request)).toBeTrue();
    }
  });

  test("graduates only private native Article saving and exact post publishing", () => {
    const observed = new Set([
      "articles.draft.save",
      "organizations.read",
      "posts.publish",
      "profiles.read",
    ]);
    for (const operation of LINKEDIN_WEB_OPERATION_NAMES) {
      const contract = LINKEDIN_WEB_OPERATIONS[operation];
      expect(contract.state).toBe(observed.has(operation) ? "observed" : "capture-required");
      expect(contract.requests).toHaveLength(
        operation === "posts.publish" ? 5
          : operation === "profiles.read" || operation === "organizations.read" ? 1
            : 0,
      );
    }
    expect(LINKEDIN_WEB_OPERATIONS["reactions.set"].risk).toBe("R2");
    expect(LINKEDIN_WEB_OPERATIONS["articles.draft.save"].risk).toBe("R2");
    expect(LINKEDIN_WEB_OPERATIONS["articles.draft.save"].evidence).toBe("live-har");
    expect(LINKEDIN_WEB_OPERATIONS["posts.publish"].evidence).toBe("first-party-bundle");
    for (const operation of [
      "messaging.send",
      "posts.publish",
      "posts.repost",
      "posts.quote",
      "comments.create",
      "replies.create",
      "relationships.connect",
      "articles.publish",
    ] as const) {
      expect(LINKEDIN_WEB_OPERATIONS[operation].risk).toBe("R3");
    }
  });
});

describe("LinkedIn exact profile-stat projections", () => {
  const observedAt = "2026-08-21T15:00:00.000Z";
  const subject = "urn:li:fsd_profile:123456789";

  function personalHtml(label = "7,553 followers"): string {
    return `<html><body><a href="/mynetwork/network-manager/people-follow/followers"><p><span>${label.split(" ")[0]}</span> followers</p></a></body></html>`;
  }

  function connectionsHtml(label = "4,877 connections"): string {
    return `<html><body><h1><span>${label.split(" ")[0]}</span> connections</h1><button>Sort by:</button><label>Search with filters</label></body></html>`;
  }

  function bootstrapHtml(value: unknown): string {
    const encoded = JSON.stringify(value).replace(/[&<>"=\\]/gu, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "=": "&#61;",
      "\\": "&#92;",
    })[character] ?? character);
    return `<html><body><code style="display: none" id="bpr-guid-123">${encoded}</code></body></html>`;
  }

  function organizationHtml(followerCount: unknown = 6, universalName = "hraness"): string {
    const companyUrn = "urn:li:fsd_company:123";
    const followingStateUrn = "urn:li:fsd_followingState:organization-123";
    return bootstrapHtml({
      data: {},
      included: [
        {
          $type: "com.linkedin.voyager.dash.organization.Company",
          entityUrn: companyUrn,
          universalName,
          "*followingState": followingStateUrn,
          name: "Hraness",
          description: "Public company description",
          websiteUrl: "https://hraness.com",
        },
        {
          $type: "com.linkedin.voyager.dash.feed.FollowingState",
          entityUrn: followingStateUrn,
          followerCount,
        },
      ],
    });
  }

  test("normalizes only exact public LinkedIn profile and organization URLs", () => {
    expect(linkedInPersonalProfileTarget("https://www.linkedin.com/in/0thernet"))
      .toEqual({ slug: "0thernet", url: "https://www.linkedin.com/in/0thernet/" });
    expect(linkedInOrganizationTarget("https://www.linkedin.com/company/Hraness/"))
      .toEqual({ slug: "hraness", url: "https://www.linkedin.com/company/hraness/" });
    expect(() => linkedInPersonalProfileTarget("https://linkedin.com/in/0thernet"))
      .toThrow("exact public LinkedIn origin");
    expect(() => linkedInOrganizationTarget("https://www.linkedin.com/company/hraness/?view=admin"))
      .toThrow("exact public LinkedIn origin");
  });

  test("projects exact self followers and private connection totals", () => {
    expect(projectLinkedInPersonalProfileStats({
      profileHtml: personalHtml(),
      connectionsHtml: connectionsHtml(),
      profileUrl: "https://www.linkedin.com/in/0thernet",
      expectedSubject: subject,
      expectedPublicIdentifier: "0thernet",
      observedAt,
    })).toEqual({
      schemaVersion: 1,
      provider: "linkedin",
      target: {
        kind: "profile",
        id: subject,
        url: "https://www.linkedin.com/in/0thernet/",
      },
      observedAt,
      completeness: "complete",
      metrics: {
        followers: { status: "available", value: 7553, precision: "exact", unit: "count" },
        connections: { status: "available", value: 4877, precision: "exact", unit: "count" },
      },
      metadata: { profileSlug: "0thernet" },
    });
    expect(projectLinkedInPersonalProfileStats({
      profileHtml: personalHtml(),
      connectionsHtml: null,
      profileUrl: "https://www.linkedin.com/in/0thernet",
      expectedSubject: subject,
      expectedPublicIdentifier: "0thernet",
      observedAt,
    })).toMatchObject({
      completeness: "partial",
      metrics: { connections: { status: "unavailable", reason: "not-authorized" } },
    });
  });

  test("rejects rounded, ambiguous, or unbound personal counts", () => {
    expect(() => projectLinkedInPersonalProfileStats({
      profileHtml: personalHtml("7.5K followers"),
      connectionsHtml: connectionsHtml(),
      profileUrl: "https://www.linkedin.com/in/0thernet",
      expectedSubject: subject,
      expectedPublicIdentifier: "0thernet",
      observedAt,
    })).toThrow("not an exact count");
    expect(() => projectLinkedInPersonalProfileStats({
      profileHtml: `${personalHtml()}${personalHtml("7,554 followers")}`,
      connectionsHtml: connectionsHtml(),
      profileUrl: "https://www.linkedin.com/in/0thernet",
      expectedSubject: subject,
      expectedPublicIdentifier: "0thernet",
      observedAt,
    })).toThrow("one exact self follower count");
    expect(() => projectLinkedInPersonalProfileStats({
      profileHtml: "<html><body><span>7,553 followers</span></body></html>",
      connectionsHtml: connectionsHtml(),
      profileUrl: "https://www.linkedin.com/in/0thernet",
      expectedSubject: "urn:li:fsd_profile:not-numeric",
      expectedPublicIdentifier: "0thernet",
      observedAt,
    })).toThrow("unsupported format");
    expect(() => projectLinkedInPersonalProfileStats({
      profileHtml: personalHtml(),
      connectionsHtml: connectionsHtml(),
      profileUrl: "https://www.linkedin.com/in/crossed-target",
      expectedSubject: subject,
      expectedPublicIdentifier: "0thernet",
      observedAt,
    })).toThrow("does not match the bound current member public identifier");
  });

  test("binds company followerCount through the requested Company and FollowingState URNs", () => {
    expect(projectLinkedInOrganizationStats({
      html: organizationHtml(),
      organizationUrl: "https://www.linkedin.com/company/hraness",
      observedAt,
    })).toEqual({
      schemaVersion: 1,
      provider: "linkedin",
      target: {
        kind: "organization",
        id: "urn:li:fsd_company:123",
        url: "https://www.linkedin.com/company/hraness/",
      },
      observedAt,
      completeness: "complete",
      metrics: {
        followers: { status: "available", value: 6, precision: "exact", unit: "count" },
      },
      metadata: {
        universalName: "hraness",
        name: "Hraness",
        description: "Public company description",
        websiteUrl: "https://hraness.com/",
      },
    });
    expect(() => projectLinkedInOrganizationStats({
      html: organizationHtml(6, "other"),
      organizationUrl: "https://www.linkedin.com/company/hraness",
      observedAt,
    })).toThrow("did not bind the requested universal name");
    expect(() => projectLinkedInOrganizationStats({
      html: organizationHtml("6 followers"),
      organizationUrl: "https://www.linkedin.com/company/hraness",
      observedAt,
    })).toThrow("non-negative safe integer");
  });
});

describe("LinkedIn native post contract", () => {
  const profileUrn = "urn:li:fsd_profile:ACoAAExactCurrentProfile";
  const mediaUrn = "urn:li:digitalmediaAsset:C4D22AQExactImage";
  const entityUrn = "urn:li:fsd_share:7000000000000000000";
  const body = "how your email finds me";

  test("builds the exact published-feed variables and omits absent image alt text", () => {
    expect(buildLinkedInPostCreateVariables({
      body,
      visibility: "public",
      mediaUrn,
      altText: "Two people stand outside in warm sunlight.",
    })).toEqual({
      post: {
        allowedCommentersScope: "ALL",
        commentary: {
          $type: "com.linkedin.voyager.dash.deco.common.text.TextViewModelV2",
          attributesV2: [],
          text: body,
        },
        intendedShareLifeCycleState: "PUBLISHED",
        origin: "FEED",
        paidEndorsement: false,
        visibilityDataUnion: { visibilityType: "ANYONE" },
        media: {
          altText: "Two people stand outside in warm sunlight.",
          category: "IMAGE",
          mediaUrn,
          tapTargets: [],
        },
      },
    });
    const withoutAlt = buildLinkedInPostCreateVariables({
      body,
      visibility: "connections",
      mediaUrn,
      altText: null,
    });
    expect(withoutAlt).toMatchObject({
      post: {
        visibilityDataUnion: { visibilityType: "CONNECTIONS_ONLY" },
        media: { category: "IMAGE", mediaUrn, tapTargets: [] },
      },
    });
    expect("altText" in ((withoutAlt.post as { media: object }).media)).toBeFalse();
  });

  test("builds an exact registered readback and rejects projection drift", () => {
    const url = linkedInPostReadbackUrl(entityUrn);
    expect(url.pathname).toBe("/voyager/api/graphql");
    expect(url.searchParams.get("includeWebMetadata")).toBe("true");
    expect(url.searchParams.get("queryId")).toBe(
      "voyagerFeedDashUpdates.00f9ed72d35c2a949114759b829f9886",
    );
    expect(url.searchParams.get("variables")).toBe(
      `(moduleKey:feed-item:desktop,urnOrNss:${entityUrn})`,
    );
    const projection = {
      actorMatched: true,
      entityMatched: true,
      entityUrn,
      lifecycle: "PUBLISHED",
      mediaMatched: true,
      mediaUrn,
      textMatched: true,
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/",
    };
    expect(normalizeLinkedInPostProjection(projection, {
      body,
      profileUrn,
      mediaUrn,
    })).toEqual({ entityUrn, mediaUrn, url: projection.url });
    expect(() => normalizeLinkedInPostProjection(
      { ...projection, textMatched: false },
      { body, profileUrn, mediaUrn },
    )).toThrow("did not bind the confirmed post");
  });
});

describe("LinkedIn inbox folder mapping", () => {
  test("maps every ergonomic folder to its exact consumer-web enum", () => {
    expect(LINKEDIN_WEB_FOLDER_CATEGORIES).toEqual({
      focused: "PRIMARY_INBOX",
      other: "SECONDARY_INBOX",
      requests: "MESSAGE_REQUEST_PENDING",
      archive: "ARCHIVE",
      spam: "SPAM",
      all: "INBOX",
    });
    for (const [folder, category] of Object.entries(LINKEDIN_WEB_FOLDER_CATEGORIES)) {
      expect(linkedInWebFolderCategory(folder)).toBe(category);
    }
  });

  test("rejects aliases, case drift, inherited names, and non-strings", () => {
    for (const value of ["primary", "Focused", "inbox", "toString", "__proto__", "", null, 1]) {
      assertRejected(
        () => linkedInWebFolderCategory(value),
        "LinkedIn folder must be focused, other, requests, archive, spam, or all",
      );
    }
  });
});

describe("LinkedIn JSESSIONID csrf-token derivation", () => {
  test("preserves an ajax token and removes exactly one cookie wrapper", () => {
    expect(linkedInCsrfTokenFromJSessionId("ajax:1234567890")).toBe("ajax:1234567890");
    expect(linkedInCsrfTokenFromJSessionId('"ajax:a-z_A.9~"')).toBe("ajax:a-z_A.9~");
  });

  test("rejects malformed, unsafe, or oversized cookie values without echoing them", () => {
    const invalid = [
      undefined,
      null,
      42,
      "",
      "session:123",
      "ajax:",
      '"ajax:123',
      'ajax:123"',
      '""ajax:123""',
      "ajax:has space",
      "ajax:line\nbreak",
      "ajax:semicolon;value",
      "ajax:slash\\value",
      `ajax:${"x".repeat(1_024)}`,
    ];
    for (const value of invalid) {
      expect(() => linkedInCsrfTokenFromJSessionId(value)).toThrow();
      try {
        linkedInCsrfTokenFromJSessionId(value);
      } catch (error) {
        if (typeof value === "string" && value.length > 0) {
          expect(String(error)).not.toContain(value);
        }
      }
    }
  });
});

describe("LinkedIn registered-query resolution", () => {
  test("selects one exact unique prefix plus 32-hex ID", () => {
    const expected = `messengerMessages.${HASH_A}`;
    expect(resolveLinkedInRegisteredQueryId("messengerMessages", [
      "unrelated.value",
      expected,
      expected,
      `messengerMessages.${HASH_A}extra`,
    ])).toBe(expected);
    expect(resolveLinkedInRegisteredQueryId("messengerMessages", [
      `messengerMessages.${HASH_A.toUpperCase()}`,
    ])).toBe(`messengerMessages.${HASH_A.toUpperCase()}`);
  });

  test("fails closed when no exact current query is present", () => {
    for (const candidates of [
      [],
      [`messengerMessages.${HASH_A.slice(1)}`],
      [`other.${HASH_A}`],
      [`messengerMessages.${HASH_A}.suffix`],
      [`messengerMessages.${"g".repeat(32)}`],
    ]) {
      assertRejected(
        () => resolveLinkedInRegisteredQueryId("messengerMessages", candidates),
        "LinkedIn registered query messengerMessages was not found",
      );
    }
  });

  test("fails closed when two distinct revisions are present", () => {
    assertRejected(
      () => resolveLinkedInRegisteredQueryId("voyagerFeedDashMainFeed", [
        `voyagerFeedDashMainFeed.${HASH_A}`,
        `voyagerFeedDashMainFeed.${HASH_B}`,
      ]),
      "LinkedIn registered query voyagerFeedDashMainFeed is ambiguous",
    );
  });

  test("bounds and validates both the prefix and candidate set", () => {
    for (const prefix of ["", ".feed", "feed.*", "a".repeat(129), null]) {
      expect(() => resolveLinkedInRegisteredQueryId(prefix, [])).toThrow(
        "LinkedIn registered-query prefix is invalid",
      );
    }
    expect(() => resolveLinkedInRegisteredQueryId("feed", null)).toThrow(
      "LinkedIn registered-query candidates must be a bounded array",
    );
    expect(() => resolveLinkedInRegisteredQueryId("feed", Array.from({ length: 4_097 }, () => "x"))).toThrow(
      "LinkedIn registered-query candidates must be a bounded array",
    );
    expect(() => resolveLinkedInRegisteredQueryId("feed", [1])).toThrow(
      "LinkedIn registered-query candidate is invalid",
    );
  });
});

describe("bounded Rest.li protocol-2.0 value encoding", () => {
  test("encodes scalars with RFC3986-safe structural escaping", () => {
    expect(encodeRestliV2Value(null)).toBe("null");
    expect(encodeRestliV2Value(true)).toBe("true");
    expect(encodeRestliV2Value(false)).toBe("false");
    expect(encodeRestliV2Value(-0)).toBe("0");
    expect(encodeRestliV2Value(9_007_199_254_740_991)).toBe("9007199254740991");
    expect(encodeRestliV2Value("urn:li:fsd_profile:abc")).toBe("urn%3Ali%3Afsd_profile%3Aabc");
    expect(encodeRestliV2Value("A B,():'!*")).toBe("A%20B%2C%28%29%3A%27%21%2A");
    expect(encodeRestliV2Value("café/東京")).toBe("caf%C3%A9%2F%E6%9D%B1%E4%BA%AC");
  });

  test("encodes nested lists and records canonically regardless of insertion order", () => {
    const first = {
      queryParameters: [{ value: ["PEOPLE"], key: "resultType" }],
      enabled: true,
      count: 20,
    };
    const second = {
      count: 20,
      enabled: true,
      queryParameters: [{ key: "resultType", value: ["PEOPLE"] }],
    };
    const expected = "(count:20,enabled:true,queryParameters:List((key:resultType,value:List(PEOPLE))))";
    expect(encodeRestliV2Value(first)).toBe(expected);
    expect(encodeRestliV2Value(second)).toBe(expected);

    const withoutPrototype = Object.create(null) as Record<string, unknown>;
    withoutPrototype.z = 2;
    withoutPrototype.a = 1;
    expect(encodeRestliV2Value(withoutPrototype)).toBe("(a:1,z:2)");
  });

  test("rejects noncanonical primitive and object types", () => {
    for (const value of [undefined, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol("x"), () => 1, new Date()]) {
      expect(() => encodeRestliV2Value(value)).toThrow();
    }
    expect(() => encodeRestliV2Value("\ud800")).toThrow("Rest.li string contains invalid Unicode");
    expect(() => encodeRestliV2Value({ "bad-key": 1 })).toThrow(
      "Rest.li object contains an invalid field name",
    );
    const symbolRecord: Record<PropertyKey, unknown> = { safe: true };
    symbolRecord[Symbol("hidden")] = true;
    expect(() => encodeRestliV2Value(symbolRecord)).toThrow(
      "Rest.li object cannot contain symbol fields",
    );
  });

  test("rejects accessors without evaluating them and detects cycles", () => {
    let evaluated = false;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => {
        evaluated = true;
        return "not-read";
      },
    });
    expect(() => encodeRestliV2Value(accessor)).toThrow(
      "Rest.li object fields must be enumerable data properties",
    );
    expect(evaluated).toBeFalse();

    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => encodeRestliV2Value(cycle)).toThrow("Rest.li value contains a cycle");

    const shared = { value: 1 };
    expect(encodeRestliV2Value([shared, shared])).toBe("List((value:1),(value:1))");
  });

  test("enforces string, list, field, depth, node, and final-output limits", () => {
    expect(() => encodeRestliV2Value("x".repeat(RESTLI_V2_VALUE_LIMITS.maximumStringCharacters + 1))).toThrow(
      "Rest.li string exceeds the value limit",
    );
    expect(() => encodeRestliV2Value(Array.from({
      length: RESTLI_V2_VALUE_LIMITS.maximumListItems + 1,
    }, () => null))).toThrow("Rest.li list exceeds the item limit");

    const fields: Record<string, number> = {};
    for (let index = 0; index <= RESTLI_V2_VALUE_LIMITS.maximumObjectFields; index += 1) {
      fields[`field${index}`] = index;
    }
    expect(() => encodeRestliV2Value(fields)).toThrow("Rest.li object exceeds the field limit");

    let nested: unknown = null;
    for (let index = 0; index < RESTLI_V2_VALUE_LIMITS.maximumDepth + 1; index += 1) nested = [nested];
    expect(() => encodeRestliV2Value(nested)).toThrow("Rest.li value exceeds the nesting-depth limit");

    const manyNodes = Array.from({ length: 512 }, () => Array.from({ length: 9 }, () => null));
    expect(() => encodeRestliV2Value(manyNodes)).toThrow("Rest.li value exceeds the node limit");
    expect(() => encodeRestliV2Value("€".repeat(RESTLI_V2_VALUE_LIMITS.maximumStringCharacters))).toThrow(
      "Rest.li encoded value exceeds the output limit",
    );
  });
});

describe("LinkedIn GraphQL data and included normalization", () => {
  test("normalizes data, deduplicates identical entities, and indexes URN aliases", () => {
    const first = {
      entityUrn: "urn:li:fsd_profile:one",
      backendUrn: "urn:li:member:1",
      name: "One",
      nested: { b: 2, a: 1 },
    };
    const duplicateWithDifferentKeyOrder = {
      nested: { a: 1, b: 2 },
      name: "One",
      backendUrn: "urn:li:member:1",
      entityUrn: "urn:li:fsd_profile:one",
    };
    const normalized = normalizeLinkedInGraphqlEnvelope({
      data: { feed: { elements: ["urn:li:fsd_profile:one"] } },
      included: [first, duplicateWithDifferentKeyOrder, {
        backendUrn: "urn:li:conversation:2",
        title: "Conversation",
      }],
      errors: [],
    });

    expect(normalized.data).toEqual({ feed: { elements: ["urn:li:fsd_profile:one"] } });
    expect(normalized.included).toHaveLength(2);
    expect(normalized.entitiesByUrn.get("urn:li:fsd_profile:one")).toBe(first);
    expect(normalized.entitiesByUrn.get("urn:li:member:1")).toBe(first);
    expect(normalized.entitiesByUrn.get("urn:li:conversation:2")).toMatchObject({ title: "Conversation" });
    expect(Object.isFrozen(normalized.included)).toBeTrue();
  });

  test("accepts an omitted included collection as an empty index", () => {
    const normalized = normalizeLinkedInGraphqlEnvelope({ data: { value: true } });
    expect(normalized.included).toEqual([]);
    expect(normalized.entitiesByUrn.size).toBe(0);
  });

  test("rejects conflicting duplicates under a primary or alias URN", () => {
    expect(() => normalizeLinkedInGraphqlEnvelope({
      data: {},
      included: [
        { entityUrn: "urn:li:entity:1", name: "First" },
        { entityUrn: "urn:li:entity:1", name: "Second" },
      ],
    })).toThrow("LinkedIn GraphQL included entities conflict for one URN");

    expect(() => normalizeLinkedInGraphqlEnvelope({
      data: {},
      included: [
        { entityUrn: "urn:li:entity:1", backendUrn: "urn:li:backend:shared", name: "First" },
        { entityUrn: "urn:li:entity:2", backendUrn: "urn:li:backend:shared", name: "Second" },
      ],
    })).toThrow("LinkedIn GraphQL included entities conflict for one URN");
  });

  test("rejects partial GraphQL and Rest.li-style service errors", () => {
    expect(() => normalizeLinkedInGraphqlEnvelope({ data: {}, errors: [{ message: "partial" }] })).toThrow(
      "LinkedIn GraphQL response contains provider errors",
    );
    expect(() => normalizeLinkedInGraphqlEnvelope({ data: {}, errors: "bad" })).toThrow(
      "LinkedIn GraphQL errors must be an array",
    );
    expect(() => normalizeLinkedInGraphqlEnvelope({ data: {}, serviceErrorCode: 0 })).toThrow(
      "LinkedIn GraphQL response contains a service error",
    );
  });

  test("rejects malformed envelopes, entities, and non-JSON response values", () => {
    for (const value of [null, [], {}, { data: null }, { data: {}, included: {} }]) {
      expect(() => normalizeLinkedInGraphqlEnvelope(value)).toThrow();
    }
    expect(() => normalizeLinkedInGraphqlEnvelope({ data: {}, included: [{ name: "No URN" }] })).toThrow(
      "LinkedIn GraphQL included entity has no canonical URN",
    );
    expect(() => normalizeLinkedInGraphqlEnvelope({
      data: {},
      included: [{ entityUrn: 12 }],
    })).toThrow("LinkedIn GraphQL included entity has an invalid entityUrn");
    expect(() => normalizeLinkedInGraphqlEnvelope({ data: { value: Number.NaN } })).toThrow(
      "LinkedIn GraphQL response contains a non-finite number",
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeLinkedInGraphqlEnvelope({ data: cyclic })).toThrow(
      "LinkedIn GraphQL response contains a cycle",
    );
  });
});

describe("LinkedIn R1 internal-request gate", () => {
  test("keeps the prior mailbox-bound conversation-list candidate inert", () => {
    const mailboxUrn = linkedInMailboxUrnFromMiniProfile("urn:li:fs_miniProfile:ACoAAExactProfile");
    const url = linkedInMessengerConversationsUrl(mailboxUrn);
    expect(url.origin).toBe("https://www.linkedin.com");
    expect(url.pathname).toBe("/voyager/api/voyagerMessagingGraphQL/graphql");
    expect(url.searchParams.get("queryId")).toBe(LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID);
    expect(url.searchParams.get("variables")).toBe(`(mailboxUrn:${mailboxUrn})`);
    expect(() => assertLinkedInWebR1RequestAllowed("messaging.list", {
      method: "GET",
      url,
      mailboxUrn,
    })).toThrow("LinkedIn R1 operation has no captured request contract");
    expect(LINKEDIN_WEB_OPERATIONS["messaging.list"].state).toBe("capture-required");
    expect(LINKEDIN_WEB_OPERATIONS["messaging.list"].requests).toHaveLength(0);
  });

  test("keeps unobserved consumer-web reads capture-required with no executable request rule", () => {
    for (const operation of LINKEDIN_WEB_OPERATION_NAMES) {
      const contract = LINKEDIN_WEB_OPERATIONS[operation];
      if (contract.risk !== "R1" || contract.effect !== "read") continue;
      if (operation === "profiles.read" || operation === "organizations.read") continue;
      expect(contract.requests).toHaveLength(0);
      expect(contract.state).toBe("capture-required");
      expect(() => assertLinkedInWebR1RequestAllowed(operation, {
        method: "GET",
        url: "https://www.linkedin.com/voyager/api/graphql?variables=private",
      })).toThrow("LinkedIn R1 operation has no captured request contract");
    }
  });

  test("allows only exact bounded server-rendered profile targets", () => {
    expect(LINKEDIN_WEB_OPERATIONS["profiles.read"]).toMatchObject({
      state: "observed",
      evidence: "live-response",
    });
    expect(LINKEDIN_WEB_OPERATIONS["organizations.read"]).toMatchObject({
      state: "observed",
      evidence: "live-response",
    });
    expect(() => assertLinkedInWebR1RequestAllowed("profiles.read", {
      method: "GET",
      url: "https://www.linkedin.com/in/0thernet/",
    })).not.toThrow();
    expect(() => assertLinkedInWebR1RequestAllowed("profiles.read", {
      method: "GET",
      url: "https://www.linkedin.com/mynetwork/invite-connect/connections/",
    })).not.toThrow();
    expect(() => assertLinkedInWebR1RequestAllowed("organizations.read", {
      method: "GET",
      url: "https://www.linkedin.com/company/hraness/",
    })).not.toThrow();
    expect(() => assertLinkedInWebR1RequestAllowed("profiles.read", {
      method: "GET",
      url: "https://www.linkedin.com/in/0thernet/?trk=unsafe",
    })).toThrow();
    expect(() => assertLinkedInWebR1RequestAllowed("organizations.read", {
      method: "POST",
      url: "https://www.linkedin.com/company/hraness/",
    })).toThrow("LinkedIn profile reads require GET");
  });

  test("rejects writes and unknown operations before inspecting caller-controlled request data", () => {
    for (const operation of [
      "messaging.send",
      "reactions.set",
      "articles.draft.save",
      "articles.publish",
    ] as const) {
      expect(() => assertLinkedInWebR1RequestAllowed(operation, null)).toThrow(
        "LinkedIn web operation is not an R1 read",
      );
    }
    expect(() => assertLinkedInWebR1RequestAllowed("unknown.operation", {
      secret: "must-not-be-reflected",
    })).toThrow("LinkedIn web operation is unknown");
  });
});

describe("LinkedIn native Article draft contract", () => {
  const draftId = "7000000000000000001";
  const profileUrn = "urn:li:fsd_profile:ACoAAExactCurrentProfile";
  const title = "Exact private draft";
  const document = parseArticleDraftDocument(canonicalJson({
    schemaVersion: 1,
    blocks: [
      { type: "heading1", text: "Harnessing Puerto Rico" },
      {
        type: "paragraph",
        text: "Read the source",
        links: [{ offset: 9, length: 6, url: "https://example.com/source" }],
      },
    ],
  }), { maximumBlocks: 5_000, maximumCharacters: 125_000 });

  function articleResponse(
    content: readonly Readonly<Record<string, unknown>>[],
    overrides: Readonly<Record<string, unknown>> = {},
  ): unknown {
    const urn = `urn:li:fsd_firstPartyArticle:${draftId}`;
    return {
      data: {
        $type: "com.linkedin.restli.common.CollectionResponse",
        "*elements": [urn],
        entityUrn: "urn:li:collectionResponse:article-fixture",
        paging: { count: 10, links: [], start: 0 },
      },
      included: [{
        $type: "com.linkedin.voyager.dash.publishing.FirstPartyArticle",
        activityUrn: null,
        annotation: null,
        annotationActionType: null,
        articleActionUnions: [],
        articleAnnotation: null,
        articlePublishedTimeDescription: null,
        articleType: "FIRST_PARTY_ARTICLE",
        authors: [{ profileUrn }],
        availableLocales: [],
        content,
        contentDescription: null,
        contentHtml: "<p>bounded derived HTML</p>",
        contentSegments: null,
        coverMedia: null,
        coverMediaV2Union: null,
        createdAt: 1,
        entityUrn: urn,
        featured: null,
        followingStateUrn: "urn:li:fsd_followingState:article-fixture",
        gatedArticleMetadata: null,
        initialUpdateUrn: null,
        issueNumber: null,
        linkedInArticleUrn: `urn:li:linkedInArticle:${draftId}`,
        locale: null,
        memberContributionInsight: null,
        permalink: null,
        publishedAt: null,
        scheduledAt: null,
        seoDescription: null,
        seoTitle: null,
        series: null,
        servedLocale: null,
        socialDetailUrn: null,
        socialProofInsight: null,
        sponsoredAccountUrn: null,
        state: "DRAFT",
        surveyComponent: null,
        title,
        trackingId: null,
        ugcPostUrn: null,
        updatedAt: 2,
        version: 3,
        viewerAllowedToEdit: null,
        ...overrides,
      }],
    };
  }

  function articlePage(response: unknown): string {
    const encoded = JSON.stringify(response).replace(/[&<>"=\\]/gu, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "=": "&#61;",
      "\\": "&#92;",
    })[character] ?? character);
    return `<html><body><code style="display: none" id="bpr-guid-123456">${encoded}</code></body></html>`;
  }

  function coverResponseFields(assetUrn: string): Readonly<Record<string, unknown>> {
    const vector = (includeAsset: boolean): Readonly<Record<string, unknown>> => ({
      $type: "com.linkedin.common.VectorImage",
      artifacts: [{
        $type: "com.linkedin.common.VectorArtifact",
        expiresAt: 1_900_000_000_000,
        fileIdentifyingUrlPathSegment: "image/fixture/cover-1200x630",
        height: 630,
        width: 1200,
      }],
      ...(includeAsset ? { digitalmediaAsset: assetUrn } : {}),
      rootUrl: "https://media.licdn.com/dms/image/fixture/",
    });
    const originalImage = (includeAsset: boolean): Readonly<Record<string, unknown>> => ({
      $type: "com.linkedin.voyager.dash.common.image.ImageViewModel",
      attributes: [{
        $type: "com.linkedin.voyager.dash.common.image.ImageAttribute",
        detailDataUnion: { vectorImage: vector(includeAsset) },
      }],
    });
    return {
      coverMedia: {
        $type: "com.linkedin.voyager.dash.publishing.CoverImage",
        caption: {
          $type: "com.linkedin.voyager.dash.common.text.TextViewModel",
          attributesV2: [],
          text: "",
          textDirection: "USER_LOCALE",
        },
        originalImage: originalImage(false),
        originalImageUrn: assetUrn,
      },
      coverMediaV2Union: {
        coverImage: {
          $type: "com.linkedin.voyager.dash.publishing.CoverImage",
          originalImage: originalImage(true),
          originalImageUrn: assetUrn,
        },
      },
    };
  }

  test("builds only the observed create, title, content, and exact-read routes", () => {
    expect(buildLinkedInArticleCreateBody(profileUrn, title)).toEqual({
      authors: [{ profileUrn }],
      contentHtml: "",
      state: "AUTOSAVED",
      title,
    });
    expect(buildLinkedInArticleTitlePatch(title)).toEqual({
      patch: { $set: { state: "AUTOSAVED", title } },
    });
    const coverAssetUrn = "urn:li:digitalmediaAsset:C4D22AQCoverFixture";
    expect(buildLinkedInArticleCoverPatch(coverAssetUrn)).toEqual({
      patch: {
        $set: {
          coverMediaV2Union: {
            coverImage: {
              $type: "com.linkedin.voyager.dash.publishing.CoverImage",
              caption: { text: "" },
              originalImageUrn: coverAssetUrn,
            },
          },
          state: "AUTOSAVED",
        },
      },
    });
    expect(buildLinkedInArticleContentPatch(document)).toEqual({
      patch: {
        $set: {
          content: buildLinkedInArticleContent(document),
          contentHtml: buildLinkedInArticleContentHtml(document),
          state: "AUTOSAVED",
        },
      },
    });
    expect(buildLinkedInArticleContentHtml(document)).toBe(
      "<h2>Harnessing Puerto Rico</h2>"
      + "<p>Read the <a href=\"https://example.com/source\" target=\"_blank\">source</a></p>",
    );
    expect(linkedInArticleDraftEntityUrl(draftId).pathname).toBe(
      `/voyager/api/voyagerPublishingDashFirstPartyArticles/urn:li:fsd_firstPartyArticle:${draftId}`,
    );
    const readUrl = linkedInArticleDraftEditUrl(draftId);
    expect(readUrl.pathname).toBe(`/article/edit/${draftId}/`);
    expect([...readUrl.searchParams.entries()]).toEqual([]);
  });

  test("extracts and normalizes one exact current-author private server readback with native links", () => {
    const content = buildLinkedInArticleContent(document);
    const response = articleResponse(content);
    const extracted = linkedInArticleDraftEnvelopeFromHtml(
      articlePage(response),
      draftId,
    );
    expect(normalizeLinkedInArticleDraft(extracted, draftId, profileUrn)).toEqual({
      draftId,
      profileUrn,
      title,
      document,
    });
  });

  test("projects and independently reads LinkedIn's native QUOTE block", () => {
    const quoteDocument = parseArticleDraftDocument(canonicalJson({
      schemaVersion: 1,
      blocks: [{
        type: "blockquote",
        text: "A quoted X post",
      }],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000 });
    const content = buildLinkedInArticleContent(quoteDocument);
    expect(content).toEqual([{
      textBlock: {
        $type: "com.linkedin.voyager.dash.publishing.TextBlock",
        content: {
          $type: "com.linkedin.voyager.dash.common.text.TextViewModel",
          attributesV2: [],
          text: "A quoted X post",
        },
        type: "QUOTE",
      },
    }]);
    expect(buildLinkedInArticleContentHtml(quoteDocument)).toBe(
      "<blockquote>A quoted X post</blockquote>",
    );
    expect(normalizeLinkedInArticleDraft(
      articleResponse(content, {
        contentHtml: "<blockquote>A quoted X post</blockquote>",
      }),
      draftId,
      profileUrn,
    ).document).toEqual(quoteDocument);
  });

  test("projects and verifies ordered inline images without persisting transient CDN URLs", () => {
    const imageDocument = parseArticleDraftDocumentV2(canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "heading1", text: "Harnessing Puerto Rico" },
        {
          type: "image",
          imageIndex: 0,
          altText: "A lagoon under a bright sky",
          caption: "Puerto Rico",
        },
        { type: "paragraph", text: "After the swim." },
      ],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000, maximumImages: 20 });
    const assetUrn = "urn:li:digitalmediaAsset:C4D22AQFixtureAsset";
    expect(buildLinkedInArticleContentHtmlV2(imageDocument, [assetUrn])).toBe(
      "<h2>Harnessing Puerto Rico</h2>"
      + `<figure><img data-media-urn="${assetUrn}"><figcaption>Puerto Rico</figcaption></figure>`
      + "<p>After the swim.</p>",
    );
    const content = buildLinkedInArticleContentV2(imageDocument, [assetUrn]);
    expect(content[1]).toEqual({
      imageBlock: {
        $type: "com.linkedin.voyager.dash.publishing.ImageBlock",
        alignment: "FULL_WIDTH",
        caption: {
          $type: "com.linkedin.voyager.dash.common.text.TextViewModel",
          text: "Puerto Rico",
        },
        content: {
          $type: "com.linkedin.voyager.dash.common.image.ImageViewModel",
          accessibilityText: "A lagoon under a bright sky",
          attributes: [{
            $type: "com.linkedin.voyager.dash.common.image.ImageAttribute",
            detailDataUnion: {
              vectorImage: {
                $type: "com.linkedin.common.VectorImage",
                artifacts: [],
                digitalmediaAsset: assetUrn,
              },
            },
          }],
        },
      },
    });
    expect(buildLinkedInArticleContentPatchV2(imageDocument, [assetUrn])).toEqual({
      patch: {
        $set: {
          content,
          contentHtml: buildLinkedInArticleContentHtmlV2(imageDocument, [assetUrn]),
          state: "AUTOSAVED",
        },
      },
    });

    const responseContent = [
      content[0]!,
      {
        imageBlock: {
          $type: "com.linkedin.voyager.dash.publishing.ImageBlock",
          alignment: "FULL_WIDTH",
          caption: {
            $type: "com.linkedin.voyager.dash.common.text.TextViewModel",
            attributesV2: [],
            text: "Puerto Rico",
          },
          content: {
            $type: "com.linkedin.voyager.dash.common.image.ImageViewModel",
            accessibilityText: "A lagoon under a bright sky",
            accessibilityTextAttributes: [],
            attributes: [{
              $type: "com.linkedin.voyager.dash.common.image.ImageAttribute",
              detailDataUnion: {
                vectorImage: {
                  $type: "com.linkedin.common.VectorImage",
                  artifacts: [{
                    $type: "com.linkedin.common.VectorArtifact",
                    expiresAt: 1_900_000_000_000,
                    fileIdentifyingUrlPathSegment: "image/fixture/1200x630",
                    height: 630,
                    width: 1200,
                  }],
                  digitalmediaAsset: assetUrn,
                  rootUrl: "https://media.licdn.com/dms/image/fixture/",
                },
              },
            }],
          },
        },
      },
      content[2]!,
    ] as const;
    expect(normalizeLinkedInArticleDraftV2(
      articleResponse(responseContent, {
        contentHtml: `<h2>Harnessing Puerto Rico</h2><figure><img data-media-urn="${assetUrn}" src="https://media.licdn.com/dms/image/fixture/1200x630"><figcaption>Puerto Rico</figcaption></figure><p>After the swim.</p>`,
      }),
      draftId,
      profileUrn,
    )).toEqual({
      draftId,
      profileUrn,
      title,
      document: imageDocument,
      coverAssetUrn: null,
      imageAssetUrns: [assetUrn],
    });
  });

  test("keeps the reviewed cover asset separate from Article body blocks", () => {
    const coverAssetUrn = "urn:li:digitalmediaAsset:C4D22AQCoverFixture";
    const bodyDocument = parseArticleDraftDocumentV2(canonicalJson({
      schemaVersion: 2,
      blocks: [{ type: "paragraph", text: "The complete article body." }],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000, maximumImages: 20 });
    const normalized = normalizeLinkedInArticleDraftV2(
      articleResponse(buildLinkedInArticleContentV2(bodyDocument, []), {
        ...coverResponseFields(coverAssetUrn),
        contentHtml: "<p>The complete article body.</p>",
      }),
      draftId,
      profileUrn,
    );
    expect(normalized.coverAssetUrn).toBe(coverAssetUrn);
    expect(normalized.document).toEqual(bodyDocument);
    expect(normalized.imageAssetUrns).toEqual([]);
    expect(normalized.document.blocks.some((block) => block.type === "image")).toBeFalse();
  });

  test("binds replacement metadata without trusting an incomplete stale body image", () => {
    const assetUrn = "urn:li:digitalmediaAsset:C4D22AQStaleBodyImage";
    const staleDocument = parseArticleDraftDocumentV2(canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Stale partial body." },
        { type: "image", imageIndex: 0, altText: "Expected alt text" },
      ],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000, maximumImages: 20 });
    const staleContent = structuredClone(
      buildLinkedInArticleContentV2(staleDocument, [assetUrn]),
    ) as Record<string, unknown>[];
    const imageBlock = staleContent[1]?.imageBlock as Record<string, unknown>;
    (imageBlock.caption as Record<string, unknown>).attributesV2 = [];
    const imageContent = imageBlock.content as Record<string, unknown>;
    delete imageContent.accessibilityText;
    delete imageContent.accessibilityTextAttributes;
    const vector = (((imageContent.attributes as Record<string, unknown>[])[0]?.detailDataUnion as Record<string, unknown>).vectorImage) as Record<string, unknown>;
    vector.artifacts = [{
      $type: "com.linkedin.common.VectorArtifact",
      expiresAt: 1,
      fileIdentifyingUrlPathSegment: "fixture",
      height: 1,
      width: 1,
    }];
    vector.rootUrl = "https://media.licdn.com/fixture/";
    const response = articleResponse(staleContent);
    expect(normalizeLinkedInArticleDraftV2Metadata(response, draftId, profileUrn)).toEqual({
      coverAssetUrn: null,
      draftId,
      profileUrn,
      title,
    });
    expect(() => normalizeLinkedInArticleDraftV2Snapshot(response, draftId, profileUrn)).toThrow(
      "imageBlock.content has unsupported fields",
    );
  });

  test("strips only LinkedIn's editor-owned paragraph after a final image", () => {
    const imageDocument = parseArticleDraftDocumentV2(canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Before" },
        { type: "image", imageIndex: 0, altText: "A fixture image" },
      ],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000, maximumImages: 20 });
    const assetUrn = "urn:li:digitalmediaAsset:C4D22AQFixtureAsset";
    const write = buildLinkedInArticleContentV2(imageDocument, [assetUrn]);
    const image = structuredClone(write[1]) as Record<string, unknown>;
    const imageBlock = (image.imageBlock as Record<string, unknown>);
    const caption = imageBlock.caption as Record<string, unknown>;
    caption.attributesV2 = [];
    const contentModel = imageBlock.content as Record<string, unknown>;
    contentModel.accessibilityTextAttributes = [];
    const vector = ((((contentModel.attributes as Record<string, unknown>[])[0]?.detailDataUnion as Record<string, unknown>).vectorImage) as Record<string, unknown>);
    vector.artifacts = [{
      $type: "com.linkedin.common.VectorArtifact",
      expiresAt: 1,
      fileIdentifyingUrlPathSegment: "fixture",
      height: 1,
      width: 1,
    }];
    vector.rootUrl = "https://media.licdn.com/fixture/";
    const trailing = structuredClone(write[0]) as Record<string, unknown>;
    const trailingTextBlock = trailing.textBlock as Record<string, unknown>;
    (trailingTextBlock.content as Record<string, unknown>).text = "";
    expect(normalizeLinkedInArticleDraftV2(
      articleResponse([write[0]!, image, trailing]),
      draftId,
      profileUrn,
    ).document).toEqual(imageDocument);
  });

  test("binds exact registration, signed-upload, and completed recipe status", () => {
    const assetUrn = "urn:li:digitalmediaAsset:C4D22AQFixtureAsset";
    const recipe = "urn:li:digitalmediaRecipe:feedshare-image_1280";
    const binding = normalizeLinkedInArticleImageUploadRegistration({
      data: {
        $type: "com.linkedin.restli.common.ActionResponse",
        value: {
          $type: "com.linkedin.mediauploader.MediaUploadMetadata",
          assetRealtimeTopic: "bounded-realtime-topic",
          mediaArtifactUrn: "urn:li:mediaArtifact:fixture",
          pollingUrl: "https://www.linkedin.com/voyager/api/voyagerVideoDashMediaUploadMetadata/fixture",
          recipes: [recipe],
          singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
          singleUploadUrl: "https://www.linkedin.com/dms-uploads/fixture?ca=vector",
          type: "VECTOR",
          urn: assetUrn,
        },
      },
      included: [],
    });
    expect(binding).toMatchObject({ assetUrn, recipes: [recipe] });
    expect(() => normalizeLinkedInArticleImageUploadStatus({
      asset: assetUrn,
      assetStatus: "ALLOWED",
      status: { [recipe]: "PROCESSING" },
    }, binding)).toThrow("did not finish every recipe");
    expect(normalizeLinkedInArticleImageUploadStatus({
      asset: assetUrn,
      assetStatus: "ALLOWED",
      status: { [recipe]: "AVAILABLE" },
    }, binding)).toBeUndefined();

    const fullSingle = normalizeLinkedInArticleImageUploadRegistration({
      data: {
        $type: "com.linkedin.restli.common.ActionResponse",
        value: {
          $type: "com.linkedin.mediauploader.MediaUploadMetadata",
          assetRealtimeTopic: "bounded-realtime-topic",
          mediaArtifactUrn: "urn:li:mediaArtifact:fixture-full-single",
          pollingUrl: "https://www.linkedin.com/current-single-processing/fixture",
          recipes: [recipe],
          singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
          singleUploadUrl: "https://www.linkedin.com/dms-uploads/fixture-full-single?ca=single",
          type: "SINGLE",
          urn: assetUrn,
        },
      },
      included: [],
    });
    expect(fullSingle).toMatchObject({
      assetUrn,
      pollingUrl: null,
      recipes: [recipe],
    });
    expect(() => normalizeLinkedInArticleImageUploadRegistration({
      data: {
        $type: "com.linkedin.restli.common.ActionResponse",
        value: {
          $type: "com.linkedin.mediauploader.MediaUploadMetadata",
          assetRealtimeTopic: "bounded-realtime-topic",
          mediaArtifactUrn: "urn:li:mediaArtifact:fixture-full-single",
          pollingUrl: "https://example.com/unbound-processing",
          recipes: [recipe],
          singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
          singleUploadUrl: "https://www.linkedin.com/dms-uploads/fixture-full-single?ca=single",
          type: "SINGLE",
          urn: assetUrn,
        },
      },
      included: [],
    })).toThrow("escaped its reviewed LinkedIn origin");

    const single = normalizeLinkedInArticleImageUploadRegistration({
      value: {
        mediaArtifactUrn: "urn:li:mediaArtifact:fixture-single",
        recipes: [recipe],
        singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
        singleUploadUrl: "https://www.linkedin.com/dms-uploads/fixture-single?ca=single",
        type: "SINGLE",
        urn: assetUrn,
      },
    });
    expect(single).toMatchObject({
      assetUrn,
      pollingUrl: null,
      recipes: [recipe],
    });
    expect(() => normalizeLinkedInArticleImageUploadStatus({
      asset: assetUrn,
      assetStatus: "ALLOWED",
      status: { [recipe]: "AVAILABLE" },
    }, single)).toThrow("did not expose a polling contract");
    expect(() => normalizeLinkedInArticleImageUploadRegistration({
      value: {
        mediaArtifactUrn: "urn:li:mediaArtifact:fixture-single",
        recipes: [recipe],
        singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
        singleUploadUrl: "https://www.linkedin.com/dms-uploads/fixture-single?ca=single",
        type: "SINGLE",
        unexpected: true,
        urn: assetUrn,
      },
    })).toThrow("unsupported fields");
  });

  test("classifies image-registration drift with bounded value-free structure only", () => {
    const vector = {
      data: {
        $type: "com.linkedin.restli.common.ActionResponse",
        value: {
          $type: "com.linkedin.mediauploader.MediaUploadMetadata",
          assetRealtimeTopic: "private-topic",
          mediaArtifactUrn: "urn:li:mediaArtifact:private-vector",
          pollingUrl: "https://www.linkedin.com/private-polling-url",
          recipes: ["urn:li:digitalmediaRecipe:private"],
          singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
          singleUploadUrl: "https://www.linkedin.com/private-upload-url",
          type: "VECTOR",
          urn: "urn:li:digitalmediaAsset:private-vector",
        },
      },
      included: [],
    };
    expect(linkedInArticleImageRegistrationDriftCategory(
      vector,
      new Error("LinkedIn image registration response.data.value has unsupported fields"),
    )).toBe("registration-fields-e3u0-d3u0-r7e7u0-h1u0-tv-pl");

    const single = {
      value: {
        mediaArtifactUrn: "urn:li:mediaArtifact:private-single",
        recipes: ["urn:li:digitalmediaRecipe:private"],
        singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
        singleUploadUrl: "https://www.linkedin.com/private-upload-url",
        type: "SINGLE",
        urn: "urn:li:digitalmediaAsset:private-single",
      },
    };
    expect(linkedInArticleImageRegistrationDriftCategory(
      single,
      new Error("LinkedIn image upload URL is invalid"),
    )).toBe("upload-url-e4u0-d2u0-r7c4u0-h1u0-ts-pa");

    const privateValue = "must-not-appear-private-value";
    const drift = linkedInArticleImageRegistrationDriftCategory({
      data: {
        value: {
          mediaArtifactUrn: "urn:li:mediaArtifact:private-current",
          recipes: ["urn:li:digitalmediaRecipe:private"],
          singleUploadHeaders: {
            "media-type-family": "STILLIMAGE",
            authorization: privateValue,
          },
          singleUploadUrl: "https://www.linkedin.com/private-upload-url",
          type: "SINGLE",
          unexpectedField: privateValue,
          uploadMechanism: { privateValue },
          urn: "urn:li:digitalmediaAsset:private-current",
        },
      },
      included: [],
      privateEnvelopeField: privateValue,
    }, new Error("LinkedIn image registration response.data.value has unsupported fields"));
    expect(drift).toBe("registration-fields-e3u1-d2u0-r7c4u2-h1u1-ts-pa");
    expect(drift).toMatch(/^[a-z0-9-]{1,192}$/u);
    expect(drift).not.toContain(privateValue);
    expect(drift).not.toContain("authorization");
    expect(drift).not.toContain("unexpectedField");
    expect(drift).not.toContain("uploadMechanism");
    expect(drift).not.toContain("privateEnvelopeField");
  });

  test("accepts only the reviewed current single-upload Article registration shape", () => {
    const assetUrn = "urn:li:digitalmediaAsset:C4D22AQCurrentSingleAsset";
    const binding = normalizeLinkedInArticleImageUploadRegistration({
      data: {
        $type: "com.linkedin.restli.common.ActionResponse",
        value: {
          $type: "com.linkedin.mediauploader.MediaUploadMetadata",
          mediaArtifactUrn: "urn:li:mediaArtifact:current-single",
          singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
          singleUploadUrl: "https://www.linkedin.com/dms-uploads/current-single?ca=article",
          type: "SINGLE",
          urn: assetUrn,
        },
      },
      included: [],
    });
    expect(binding).toEqual({
      assetUrn,
      pollingUrl: null,
      recipes: [],
      uploadHeaders: { "media-type-family": "STILLIMAGE" },
      uploadUrl: "https://www.linkedin.com/dms-uploads/current-single?ca=article",
    });
    expect(() => normalizeLinkedInArticleImageUploadRegistration({
      data: {
        $type: "com.linkedin.restli.common.ActionResponse",
        value: {
          $type: "com.linkedin.mediauploader.MediaUploadMetadata",
          mediaArtifactUrn: "urn:li:mediaArtifact:multipart",
          singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
          singleUploadUrl: "https://www.linkedin.com/dms-uploads/multipart",
          type: "MULTIPART",
          urn: assetUrn,
        },
      },
      included: [],
    })).toThrow("changed its media type");
    expect(() => normalizeLinkedInArticleImageUploadRegistration({
      data: {
        $type: "com.linkedin.restli.common.ActionResponse",
        value: {
          mediaArtifactUrn: "urn:li:mediaArtifact:extra",
          providerPrivateField: "must not be admitted",
          singleUploadHeaders: { "media-type-family": "STILLIMAGE" },
          singleUploadUrl: "https://www.linkedin.com/dms-uploads/extra",
          type: "SINGLE",
          urn: assetUrn,
        },
      },
      included: [],
    })).toThrow("unsupported fields");
  });


  test("rejects payload ambiguity, unsupported styles and blocks, author drift, and published state", () => {
    const styleDocument = parseArticleDraftDocument(canonicalJson({
      schemaVersion: 1,
      blocks: [{
        type: "paragraph",
        text: "bold",
        styles: [{ offset: 0, length: 4, style: "bold" }],
      }],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000 });
    expect(() => buildLinkedInArticleContent(styleDocument)).toThrow("styles remain capture-required");
    const listDocument = parseArticleDraftDocument(canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "ordered-list-item", text: "one" }],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000 });
    expect(() => buildLinkedInArticleContent(listDocument)).toThrow("currently support only");

    const content = buildLinkedInArticleContent(document);
    const response = articleResponse(content);
    const page = articlePage(response);
    expect(() => linkedInArticleDraftEnvelopeFromHtml(
      `${page}${page}`,
      draftId,
    )).toThrow("did not isolate one exact hidden payload");
    expect(() => linkedInArticleDraftEnvelopeFromHtml(
      page.replace("display: none", "display: block"),
      draftId,
    )).toThrow("no longer hidden");
    expect(() => normalizeLinkedInArticleDraft(
      articleResponse(content, { authors: [{ profileUrn: "urn:li:fsd_profile:other" }] }),
      draftId,
      profileUrn,
    )).toThrow("author no longer matches");
    expect(() => normalizeLinkedInArticleDraft(
      articleResponse(content, { state: "PUBLISHED", publishedAt: 3 }),
      draftId,
      profileUrn,
    )).toThrow("not the exact private unpublished draft");
  });
});

describe("LinkedIn bounded inbox projection", () => {
  const conversationUrn = "urn:li:msg_conversation:(urn:li:fsd_profile:viewer,thread-1)";
  const messageUrn = "urn:li:fsd_message:(urn:li:msg_conversation:thread-1,message-1)";
  const participantUrn = "urn:li:msg_messagingParticipant:participant-1";

  function response(categories: readonly string[] = ["INBOX", "PRIMARY_INBOX"]): unknown {
    return {
      data: {
        data: {
          messengerConversationsBySyncToken: {
            $type: "com.linkedin.restli.common.CollectionResponse",
            "*elements": [conversationUrn],
            metadata: { newSyncToken: "next-sync-token" },
          },
        },
      },
      included: [
        {
          $type: "com.linkedin.messenger.Conversation",
          entityUrn: conversationUrn,
          backendUrn: "urn:li:messagingThread:thread-1",
          "*conversationParticipants": [participantUrn],
          categories,
          groupChat: false,
          title: null,
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_001_000,
          lastReadAt: 1_700_000_000_500,
          read: false,
          unreadCount: 1,
          notificationStatus: "ACTIVE",
          messages: {
            $type: "com.linkedin.restli.common.CollectionResponse",
            "*elements": [messageUrn],
          },
          conversationUrl: "https://www.linkedin.com/messaging/thread/thread-1/",
        },
        {
          $type: "com.linkedin.messenger.MessagingParticipant",
          entityUrn: participantUrn,
          backendUrn: "urn:li:messagingParticipant:participant-1",
          hostIdentityUrn: "urn:li:fsd_profile:participant-profile",
          preview: { firstName: "Ada", lastName: "Lovelace" },
        },
        {
          $type: "com.linkedin.messenger.Message",
          entityUrn: messageUrn,
          backendUrn: "urn:li:messagingMessage:message-1",
          deliveredAt: 1_700_000_001_000,
          body: "A bounded message",
          subject: null,
          "*sender": participantUrn,
        },
      ],
    };
  }

  test("projects one main-inbox conversation without claiming its sync token is a cursor", () => {
    expect(normalizeLinkedInMessagingList(response(), "focused", 20)).toEqual({
      folder: "focused",
      conversations: [{
        id: "urn:li:messagingThread:thread-1",
        urn: conversationUrn,
        categories: ["INBOX", "PRIMARY_INBOX"],
        groupChat: false,
        title: null,
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_001_000,
        lastReadAt: 1_700_000_000_500,
        read: false,
        unreadCount: 1,
        notificationStatus: "ACTIVE",
        participants: [{
          urn: participantUrn,
          identityUrn: "urn:li:fsd_profile:participant-profile",
          displayName: "Ada Lovelace",
        }],
        latestMessage: {
          id: "urn:li:messagingMessage:message-1",
          urn: messageUrn,
          deliveredAt: 1_700_000_001_000,
          body: "A bounded message",
          subject: null,
          senderUrn: participantUrn,
        },
        url: "https://www.linkedin.com/messaging/thread/thread-1/",
      }],
      nextCursor: "next-sync-token",
      continuationSupported: false,
      complete: false,
    });
  });

  test("marks only an untruncated response without a provider sync token complete", () => {
    const value = response() as {
      data: {
        data: {
          messengerConversationsBySyncToken: {
            "*elements": string[];
            metadata: { newSyncToken: string | null };
          };
        };
      };
    };
    value.data.data.messengerConversationsBySyncToken.metadata.newSyncToken = null;
    expect(normalizeLinkedInMessagingList(value, "focused", 20)).toMatchObject({
      nextCursor: null,
      continuationSupported: false,
      complete: true,
    });

    value.data.data.messengerConversationsBySyncToken["*elements"].push(conversationUrn);
    expect(normalizeLinkedInMessagingList(value, "focused", 1)).toMatchObject({
      conversations: [{ urn: conversationUrn }],
      nextCursor: null,
      continuationSupported: false,
      complete: false,
    });
  });

  test("filters additional inbox locally and fails closed on reference or route drift", () => {
    expect(normalizeLinkedInMessagingList(response(["INBOX", "SECONDARY_INBOX"]), "other", 1).conversations)
      .toHaveLength(1);
    expect(normalizeLinkedInMessagingList(response(), "other", 1).conversations).toEqual([]);
    const malformed = response() as {
      data: { data: { messengerConversationsBySyncToken: { "*elements": string[] } } };
    };
    malformed.data.data.messengerConversationsBySyncToken["*elements"] = ["urn:li:missing:1"];
    expect(() => normalizeLinkedInMessagingList(malformed, "all", 1)).toThrow(
      "omitted a referenced conversation",
    );
  });
});
