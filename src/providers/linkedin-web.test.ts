import { describe, expect, test } from "bun:test";

import {
  LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID,
  LINKEDIN_WEB_FOLDER_CATEGORIES,
  LINKEDIN_WEB_OPERATIONS,
  LINKEDIN_WEB_OPERATION_NAMES,
  RESTLI_V2_VALUE_LIMITS,
  assertLinkedInWebR1RequestAllowed,
  encodeRestliV2Value,
  linkedInCsrfTokenFromJSessionId,
  linkedInMailboxUrnFromMiniProfile,
  linkedInMessengerConversationsUrl,
  linkedInWebFolderCategory,
  normalizeLinkedInGraphqlEnvelope,
  normalizeLinkedInMessagingList,
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

  test("keeps every LinkedIn consumer-web operation capture-required", () => {
    for (const operation of LINKEDIN_WEB_OPERATION_NAMES) {
      const contract = LINKEDIN_WEB_OPERATIONS[operation];
      expect(contract.state).toBe("capture-required");
      expect(contract.requests).toHaveLength(0);
    }
    expect(LINKEDIN_WEB_OPERATIONS["reactions.set"].risk).toBe("R2");
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

  test("keeps every consumer-web read capture-required with no executable request rule", () => {
    for (const operation of LINKEDIN_WEB_OPERATION_NAMES) {
      const contract = LINKEDIN_WEB_OPERATIONS[operation];
      expect(contract.state).toBe("capture-required");
      expect(contract.requests).toHaveLength(0);
      if (contract.risk !== "R1" || contract.effect !== "read") continue;
      expect(() => assertLinkedInWebR1RequestAllowed(operation, {
        method: "GET",
        url: "https://www.linkedin.com/voyager/api/graphql?variables=private",
      })).toThrow("LinkedIn R1 operation has no captured request contract");
    }
  });

  test("rejects writes and unknown operations before inspecting caller-controlled request data", () => {
    for (const operation of ["messaging.send", "reactions.set", "articles.publish"] as const) {
      expect(() => assertLinkedInWebR1RequestAllowed(operation, null)).toThrow(
        "LinkedIn web operation is not an R1 read",
      );
    }
    expect(() => assertLinkedInWebR1RequestAllowed("unknown.operation", {
      secret: "must-not-be-reflected",
    })).toThrow("LinkedIn web operation is unknown");
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
