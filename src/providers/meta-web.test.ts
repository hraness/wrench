import { describe, expect, test } from "bun:test";

import facebookGroupManifest from "../assets/adapters/facebook-group/wrench-web-adapter.json";
import facebookMarketplaceManifest from "../assets/adapters/facebook-marketplace/wrench-web-adapter.json";
import facebookPageManifest from "../assets/adapters/facebook-page/wrench-web-adapter.json";
import facebookManifest from "../assets/adapters/facebook/wrench-web-adapter.json";
import instagramManifest from "../assets/adapters/instagram/wrench-web-adapter.json";
import instagramV1Manifest from "../assets/adapters/instagram/wrench-web-adapter.v1.0.0.json";
import threadsManifest from "../assets/adapters/threads/wrench-web-adapter.json";
import threadsV1Manifest from "../assets/adapters/threads/wrench-web-adapter.v1.0.0.json";
import { metaWebPlugin } from "../plugins/meta-web/plugin";
import {
  META_WEB_OPERATIONS,
  META_WEB_OPERATION_NAMES,
  META_WEB_SITES,
  metaWebEvidenceSnapshot,
  normalizeFacebookFeedHtml,
  normalizeFacebookInboxHtml,
  normalizeFacebookMarketplaceFeedDocuments,
  normalizeFacebookMarketplaceFeedHtml,
  normalizeFacebookMarketplaceListingHtml,
  normalizeInstagramComments,
  normalizeInstagramContacts,
  normalizeInstagramFeed,
  normalizeInstagramInbox,
  normalizeInstagramPost,
  normalizeThreadsFeedHtml,
  parseFacebookViewerId,
  parseInstagramViewerId,
  parseMetaJsonScripts,
  parseThreadsViewerId,
} from "./meta-web";

const manifests = {
  instagram: instagramManifest,
  threads: threadsManifest,
  facebook: facebookManifest,
  "facebook-page": facebookPageManifest,
  "facebook-group": facebookGroupManifest,
  "facebook-marketplace": facebookMarketplaceManifest,
} as const;

function html(...values: readonly unknown[]): string {
  return values.map((value) =>
    `<script type="application/json">${JSON.stringify(value)}</script>`).join("");
}

function hydratedModuleRoot(
  module: readonly unknown[],
  asyncModuleName = "AsyncData",
  method = "resolve",
  args: readonly unknown[] = [],
  payloadKey = "adp_WebWorkerV2HasteResponsePreloader_TestBundle_abc123",
): unknown {
  return {
    require: [["ScheduledServerJS", "handle", null, [{
      __bbox: {
        require: [[asyncModuleName, method, args, [
          payloadKey,
          {
            data: {
              __bbox: {
                hrp: {
                  jsmods: {
                    define: [module],
                  },
                },
              },
            },
          },
        ]]],
      },
    }]]],
  };
}

function hydratedFacebookViewerRoot(
  asyncModuleName = "AsyncData",
  method = "resolve",
  args: readonly unknown[] = [],
  payloadKey = "adp_WebWorkerV2HasteResponsePreloader_TestBundle_abc123",
  actorId = "24680",
): unknown {
  const root = hydratedModuleRoot(
    ["CurrentUserInitialData", [], {
      ACCOUNT_ID: "24680",
      USER_ID: "24680",
    }, 7],
    asyncModuleName,
    method,
    args,
    payloadKey,
  ) as { readonly require: readonly unknown[] };
  return {
    require: [
      ...root.require,
      ["RelayAPIConfigDefaults", [], { actorID: actorId }, 8],
    ],
  };
}

function relayPrefetchedStreamResult(
  result: unknown,
  options: {
    readonly moduleName?: string;
    readonly method?: string;
    readonly args?: readonly unknown[];
    readonly key?: string;
    readonly payload?: readonly unknown[];
  } = {},
): unknown {
  const payload = options.payload ?? [
    options.key ?? "adp_CometModernHomeFeedQueryRelayPreloader_Test_abc123",
    { __bbox: { result } },
  ];
  return {
    require: [["ScheduledServerJS", "handle", null, [{
      __bbox: {
        require: [[
          options.moduleName ?? "RelayPrefetchedStreamCache",
          options.method ?? "next",
          options.args ?? [],
          payload,
        ]],
      },
    }]]],
  };
}

function nestedContainer(depth: number): unknown {
  let value: unknown = { hidden: true };
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

const instagramHtml = html({
  require: [["PolarisViewer", [], { data: {}, id: "12345" }, 7]],
});

const threadsHtml = html({
  require: [
    ["BarcelonaSessionInfo", [], { is_th_session: true, is_logged_out: false }, 7],
    ["RelayPrefetch", [], {
      __bbox: {
        result: {
          data: {
            viewer: { user: { id: "12345" } },
            feedData: {
              edges: [{
                cursor: "opaque",
                node: {
                  text_post_app_thread: {
                    id: "thread-1",
                    thread_items: [{
                      post: {
                        id: "900_12345",
                        code: "Code1",
                        canonical_url: "https://www.threads.com/@person/post/Code1",
                        caption: { text: "hello" },
                        user: { pk: "12345", username: "person", full_name: "Person" },
                        taken_at: 100,
                        has_liked: false,
                        has_viewer_saved: true,
                        like_count: 2,
                      },
                    }],
                  },
                },
              }],
            },
          },
        },
      },
    }, 7],
  ],
});

const facebookHtml = html(
  hydratedFacebookViewerRoot(),
  relayPrefetchedStreamResult({
    data: {
      viewer: {
        news_feed: {
          edges: [{
            cursor: "opaque",
            node: {
              __typename: "Story",
              __isFeedUnit: "Story",
              id: "story-1",
              post_id: "24680_999",
              creation_time: 100,
              permalink_url: "https://www.facebook.com/24680/posts/999",
              actors: [{ id: "24680", name: "Viewer" }],
              comet_sections: {
                content: { story: { message: { text: "hello" } } },
              },
            },
          }],
        },
        message_threads: {
          edges: [{
            node: {
              id: "opaque-node",
              thread_key: { thread_fbid: "777" },
              updated_time: 100,
              name: "Friends",
              all_participants: {
                edges: [{
                  node: {
                    id: "participant-edge",
                    messaging_actor: { id: "123", name: "Friend" },
                  },
                }],
              },
            },
          }],
        },
      },
    },
  }),
);

const facebookMarketplaceHtml = html(
  {
    require: [
      ["CurrentUserInitialData", [], {
        ACCOUNT_ID: "24680",
        USER_ID: "24680",
      }, 7],
      ["RelayAPIConfigDefaults", [], { actorID: "24680" }, 8],
    ],
  },
  {
    result: {
      data: {
        marketplace_home_feed: {
          edges: [{
            cursor: "edge-0",
            node: {
              __typename: "MarketplaceFeedTopPicksUnit",
              marketplace_listings: [{
                __typename: "GroupCommerceProductItem",
                id: "111",
                marketplace_listing_title: "Top pick",
                listing_price: { amount: "12.00" },
                formatted_price: { text: "$12" },
                primary_listing_photo: {
                  id: "811",
                  image: { uri: "https://example.com/top.jpg" },
                },
                location: { reverse_geocode: { city: "Brooklyn", state: "NY" } },
                creation_time: 100,
              }],
            },
          }],
        },
      },
    },
  },
  {
    path: ["marketplace_home_feed", "edges", 1],
    data: {
      cursor: "edge-1",
      node: {
        __typename: "MarketplaceFeedGeneralListingObject",
        __isMarketplaceFeedGeneralListingData: "MarketplaceFeedGeneralListingObject",
        data: {
          title: "General listing",
          price: { amount_with_offset: "20.00", currency: "USD" },
        },
        entity: {
          id: "222",
          location: { reverse_geocode: { city: "Queens", state: "NY" } },
        },
        listing: { id: "222", creation_time: 101 },
        photo: {
          id: "822",
          default_image: { uri: "https://example.com/general.jpg" },
        },
      },
    },
    extensions: { is_final: false },
  },
  {
    path: ["marketplace_home_feed"],
    data: { page_info: { end_cursor: "next-page", has_next_page: true } },
    extensions: { is_final: true },
  },
  {
    data: {
      viewer: {
        marketplace_product_details_page: {
          target: {
            __typename: "GroupCommerceProductItem",
            id: "222",
            primary_mp_ent: { id: "222" },
            marketplace_listing_title: "General listing",
            redacted_description: { text: "Description" },
            listing_price: {
              amount: "20.00",
              currency: "USD",
              formatted_amount_zeros_stripped: "$20",
            },
            location_text: { text: "Queens, NY" },
            marketplace_listing_seller: {
              id: "13579",
              user_id: "13579",
              name: "Seller",
            },
            creation_time: 101,
            is_live: true,
            is_pending: false,
            is_sold: false,
            is_viewer_seller: false,
          },
        },
      },
    },
  },
  {
    data: {
      viewer: {
        marketplace_product_details_page: {
          target: {
            __typename: "GroupCommerceProductItem",
            id: "222",
            listing_photos: [{
              id: "822",
              accessibility_caption: "Listing photo",
              image: {
                uri: "https://example.com/listing.jpg",
                width: 640,
                height: 480,
              },
            }],
            pre_recorded_videos: [],
          },
        },
      },
    },
  },
);

const facebookMarketplaceObservedHtml = (() => {
  const roots = parseMetaJsonScripts(facebookMarketplaceHtml);
  const initialResult = (roots[1] as { readonly result: unknown }).result;
  return html(
    roots[0],
    relayPrefetchedStreamResult(initialResult, {
      key: "adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_Test_abc123",
    }),
    relayPrefetchedStreamResult(roots[2], {
      key: "adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_Test_abc123",
    }),
    relayPrefetchedStreamResult(roots[3], {
      key: "adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_Test_abc123",
    }),
    relayPrefetchedStreamResult(roots[4], {
      key: "adp_MarketplacePDPContainerQueryRelayPreloader_Test_abc123",
    }),
    relayPrefetchedStreamResult(roots[5], {
      key: "adp_MarketplacePDPC2CMediaViewerWithImagesQueryRelayPreloader_Test_abc123",
    }),
  );
})();

describe("Meta consumer-web policy", () => {
  test("keeps every schema-v4 manifest in exact parity with the full policy map", () => {
    for (const site of META_WEB_SITES) {
      const manifest = manifests[site];
      expect(manifest.schemaVersion).toBe(4);
      expect(manifest.surfaceId).toBe(site);
      expect(Object.keys(manifest.operations).sort()).toEqual(
        [...META_WEB_OPERATION_NAMES[site]].sort(),
      );
      const operations: Readonly<Record<string, { readonly risk: string }>> = manifest.operations;
      for (const operation of META_WEB_OPERATION_NAMES[site]) {
        expect(operations[operation]?.risk).toBe(META_WEB_OPERATIONS[site][operation]?.risk);
      }
    }
  });

  test("keeps unproven writes and protocol-sensitive messaging capture-required", () => {
    expect(META_WEB_OPERATIONS.instagram["feeds.read"]).toMatchObject({
      state: "observed",
      contractVersion: 2,
    });
    expect(META_WEB_OPERATIONS.instagram["comments.read"]).toMatchObject({
      state: "observed",
      contractVersion: 2,
    });
    expect(META_WEB_OPERATIONS.instagram["messaging.list"]).toMatchObject({
      state: "observed",
      contractVersion: 2,
    });
    expect(META_WEB_OPERATIONS.threads["feeds.read"]).toMatchObject({
      state: "observed",
      contractVersion: 2,
    });
    expect(META_WEB_OPERATIONS.instagram["likes.set"]).toMatchObject({ state: "capture-required" });
    expect(META_WEB_OPERATIONS.instagram["messaging.send"]?.reason).toContain("E2EE");
    expect(META_WEB_OPERATIONS.threads["messaging.list"]).toMatchObject({ state: "capture-required" });
    expect(META_WEB_OPERATIONS.facebook["feeds.read"]).toMatchObject({
      state: "observed",
      contractVersion: 2,
    });
    expect(META_WEB_OPERATIONS.facebook["messaging.list"]).toMatchObject({
      state: "capture-required",
      evidence: "none",
      contractVersion: 2,
    });
    expect(META_WEB_OPERATIONS.facebook["messaging.list"]?.reason).toContain("homepage Comet preload");
    expect(META_WEB_OPERATIONS.facebook["messaging.list"]?.reason).toContain("Msys/E2EE");
    expect(META_WEB_OPERATIONS.facebook["messaging.send"]?.reason).toContain("Msys");
    expect(META_WEB_OPERATIONS["facebook-page"]["feeds.read"]).toMatchObject({ state: "capture-required" });
    expect(META_WEB_OPERATIONS["facebook-group"]["posts.publish"]).toMatchObject({ risk: "R3" });
    expect(META_WEB_OPERATIONS["facebook-marketplace"]["listings.publish"]).toMatchObject({
      state: "capture-required",
    });
    expect(META_WEB_OPERATIONS["facebook-marketplace"]["feeds.read"]).toMatchObject({
      state: "observed",
      risk: "R1",
      contractVersion: 2,
    });
    expect(META_WEB_OPERATIONS["facebook-marketplace"]["listings.read"]).toMatchObject({
      state: "observed",
      contractVersion: 2,
    });
  });

  test("versions first-page-only Instagram and Threads contracts without losing v1 resolution", () => {
    const affected = [
      ["instagram", "comments.read", instagramManifest, instagramV1Manifest],
      ["instagram", "feeds.read", instagramManifest, instagramV1Manifest],
      ["instagram", "messaging.list", instagramManifest, instagramV1Manifest],
      ["threads", "feeds.read", threadsManifest, threadsV1Manifest],
    ] as const;

    expect(instagramManifest.version).toBe("1.2.0");
    expect(instagramV1Manifest.version).toBe("1.0.0");
    expect(threadsManifest.version).toBe("1.2.0");
    expect(threadsV1Manifest.version).toBe("1.0.0");

    for (const [site, operation, current, prior] of affected) {
      const currentOperation = current.operations[operation];
      const priorOperation = prior.operations[operation];
      expect(currentOperation.webSession.contractVersion).toBe(2);
      expect(priorOperation.webSession.contractVersion).toBe(1);
      expect(currentOperation.input.properties).not.toHaveProperty("cursor");
      expect(priorOperation.input.properties).toHaveProperty("cursor");
      expect(currentOperation.description).toContain("one bounded first page");

      const binding = metaWebPlugin.bindings.find((candidate) =>
        candidate.surfaceId === site);
      const descriptor = binding?.operations.find((candidate) =>
        candidate.name === operation);
      expect(descriptor?.contractVersions).toEqual([1, 2]);
    }
  });

  test("binds each consumer surface to its exact bootstrapped viewer", () => {
    expect(parseInstagramViewerId(instagramHtml)).toBe("12345");
    expect(parseThreadsViewerId(threadsHtml)).toBe("12345");
    expect(parseFacebookViewerId(facebookHtml)).toBe("24680");
    expect(parseFacebookViewerId(
      html(hydratedFacebookViewerRoot()),
    )).toBe("24680");
    expect(() => parseFacebookViewerId(
      html(hydratedFacebookViewerRoot("AsyncDataLookalike")),
    )).toThrow("outside a reviewed module path");
    expect(() => parseFacebookViewerId(
      html(hydratedFacebookViewerRoot("AsyncData", "unreviewed")),
    )).toThrow("outside a reviewed module path");
    expect(() => parseFacebookViewerId(
      html(hydratedFacebookViewerRoot("AsyncData", "resolve", ["unexpected"])),
    )).toThrow("outside a reviewed module path");
    expect(() => parseFacebookViewerId(
      html(hydratedFacebookViewerRoot(
        "AsyncData",
        "resolve",
        [],
        "adp_UnrelatedPreloader_abc123",
      )),
    )).toThrow("outside a reviewed module path");
    expect(() => parseInstagramViewerId(html(hydratedModuleRoot(
      ["PolarisViewer", [], { data: {}, id: "12345" }, 7],
    )))).toThrow("outside a reviewed module path");
    expect(() => parseThreadsViewerId(html(hydratedModuleRoot(
      ["BarcelonaSessionInfo", [], {
        is_th_session: true,
        is_logged_out: false,
      }, 7],
    )))).toThrow("outside a reviewed module path");
    expect(() => parseFacebookViewerId(html({
      require: [["CurrentUserInitialData", [], { ACCOUNT_ID: "1", USER_ID: "2" }, 7]],
    }))).toThrow("malformed or conflicting viewer identities");
    expect(() => parseFacebookViewerId(html(
      {
        require: [["CurrentUserInitialData", [], {
          ACCOUNT_ID: "24680",
          USER_ID: "24680",
        }, 7]],
      },
      {
        require: [["CurrentUserInitialData", [], {
          ACCOUNT_ID: "999",
          USER_ID: "888",
        }, 7]],
      },
    ))).toThrow("malformed or conflicting viewer identities");
    expect(() => parseFacebookViewerId(html({
      require: [
        ["CurrentUserInitialData", [], {
          ACCOUNT_ID: "24680",
          USER_ID: "24680",
        }, 7],
        ["CurrentUserInitialData", [], "malformed", 8],
      ],
    }))).toThrow("module was malformed");
    expect(() => parseFacebookViewerId(html({
      data: {
        require: [["CurrentUserInitialData", [], {
          ACCOUNT_ID: "24680",
          USER_ID: "24680",
        }, 7]],
      },
    }))).toThrow("outside a reviewed module path");
    expect(() => parseFacebookViewerId(
      '<script data-type="application/json">{"require":[]}</script>',
    )).toThrow("omitted bootloader JSON");
    expect(() => parseFacebookViewerId(
      '<script type="application/json" type="application/json">{"require":[]}</script>',
    )).toThrow("duplicate element attributes");
  });

  test("projects bounded Instagram timeline, post, comments, and inbox shapes", () => {
    const media = {
      id: "900_12345",
      pk: "900",
      code: "Code1",
      media_type: 1,
      taken_at: 100,
      caption: { text: "caption" },
      user: { pk: "12345", username: "person", full_name: "Person" },
      has_liked: false,
      has_viewer_saved: true,
      like_count: 2,
      comment_count: 1,
    };
    expect(normalizeInstagramFeed({
      status: "ok",
      feed_items: [{ media_or_ad: media }],
      next_max_id: "next",
      more_available: true,
    }, 10)).toEqual({
      feed: "home",
      items: [{
        id: "900_12345",
        pk: "900",
        code: "Code1",
        media_type: 1,
        taken_at: 100,
        caption: "caption",
        user: { id: "12345", username: "person", full_name: "Person" },
        has_liked: false,
        has_viewer_saved: true,
        like_count: 2,
        comment_count: 1,
      }],
      page_scope: "first-page-only",
      continuation_supported: false,
    });
    expect(normalizeInstagramPost({ status: "ok", items: [media] }, "900_12345")).toMatchObject({
      id: "900_12345",
    });
    expect(normalizeInstagramComments({
      status: "ok",
      caption: { media_id: "900" },
      comments: [{
        pk: "comment-1",
        text: "reply",
        created_at: 101,
        user: { pk: "222", username: "friend" },
      }],
      next_min_id: "comments-next",
      has_more_comments: true,
    }, "900_12345", 10)).toEqual({
      media_id: "900_12345",
      comments: [{
        id: "comment-1",
        text: "reply",
        created_at: 101,
        parent_comment_id: null,
        user: { id: "222", username: "friend", full_name: null },
        has_liked_comment: null,
        comment_like_count: null,
      }],
      page_scope: "first-page-only",
      continuation_supported: false,
    });
    expect(normalizeInstagramInbox({
      status: "ok",
      viewer: { pk: "12345" },
      pending_requests_total: 2,
      inbox: {
        oldest_cursor: "inbox-next",
        has_older: true,
        threads: [{
          thread_id: "thread-1",
          thread_title: "Friends",
          last_activity_at: 100,
          read_state: 1,
          pending: false,
          users: [{ pk: "222", username: "friend" }],
        }],
      },
    }, "12345", 10)).toEqual({
      folder: "inbox",
      threads: [{
        thread_id: "thread-1",
        thread_title: "Friends",
        users: [{ id: "222", username: "friend", full_name: null }],
        last_activity_at: 100,
        read_state: 1,
        pending: false,
      }],
      page_scope: "first-page-only",
      continuation_supported: false,
      raw_thread_count: 1,
      provider_has_older: true,
      provider_cursor_present: true,
      pending_requests_total: 2,
    });
  });

  test("projects bounded unique Instagram inbox contacts without fabricating message statistics", () => {
    const response = {
      status: "ok",
      viewer: { pk: "12345" },
      inbox: {
        oldest_cursor: "provider-cursor",
        has_older: true,
        threads: [
          {
            thread_id: "thread-1",
            users: [
              { pk: "12345", username: "viewer", full_name: "Viewer" },
              { pk: "222", username: "friend", full_name: "Friend" },
              { pk: "333", username: "other", full_name: null },
            ],
          },
          {
            thread_id: "thread-2",
            users: [
              { pk: "222", username: "changed", full_name: "Changed" },
            ],
          },
        ],
      },
    };

    expect(normalizeInstagramContacts(response, "12345", 20, 50)).toEqual({
      provider: "instagram",
      operation: "contacts.list",
      accountSubject: "instagram:12345",
      contacts: [
        {
          providerId: "222",
          displayName: "Friend",
          handle: "friend",
          sentCount: null,
          sentCountComplete: false,
          sentCountLowerBound: false,
          sentCountTruncated: false,
          receivedCount: null,
          receivedCountComplete: false,
          receivedCountLowerBound: false,
          receivedCountTruncated: false,
          lastSentAt: null,
          lastSentAtComplete: false,
          lastSentAtBasis: "unavailable",
          sentStatsIncompleteReasons: ["message-history-capture-required"],
          lastReceivedAt: null,
          lastReceivedAtComplete: false,
          lastReceivedAtBasis: "unavailable",
          receivedStatsIncompleteReasons: ["message-history-capture-required"],
        },
        {
          providerId: "333",
          displayName: null,
          handle: "other",
          sentCount: null,
          sentCountComplete: false,
          sentCountLowerBound: false,
          sentCountTruncated: false,
          receivedCount: null,
          receivedCountComplete: false,
          receivedCountLowerBound: false,
          receivedCountTruncated: false,
          lastSentAt: null,
          lastSentAtComplete: false,
          lastSentAtBasis: "unavailable",
          sentStatsIncompleteReasons: ["message-history-capture-required"],
          lastReceivedAt: null,
          lastReceivedAtComplete: false,
          lastReceivedAtBasis: "unavailable",
          receivedStatsIncompleteReasons: ["message-history-capture-required"],
        },
      ],
      metadataScope: "first-page-inbox-participant-summary",
      contactSetCompleteness: "first-page-only",
      contactSetIncompleteReasons: [
        "first-inbox-page-only",
        "provider-has-older",
        "provider-cursor-present",
      ],
      contactTruncated: true,
      statsScope: "unavailable-without-acknowledgement-free-message-history",
    });

    expect(normalizeInstagramContacts(response, "12345", 20, 1)).toMatchObject({
      contacts: [{ providerId: "222" }],
      contactSetCompleteness: "first-page-only",
      contactSetIncompleteReasons: [
        "first-inbox-page-only",
        "provider-has-older",
        "provider-cursor-present",
        "contact-limit-reached",
      ],
      contactTruncated: true,
    });
  });

  test("distinguishes terminal Instagram pages from provider and local truncation", () => {
    const thread = (threadId: string, participantId: string) => ({
      thread_id: threadId,
      users: [{ pk: participantId, username: `person-${participantId}` }],
    });
    const terminal = {
      status: "ok",
      viewer: { pk: "12345" },
      inbox: {
        has_older: false,
        threads: [thread("thread-1", "222")],
      },
    };

    expect(normalizeInstagramContacts(terminal, "12345", 20, 50)).toMatchObject({
      contacts: [{ providerId: "222" }],
      contactSetIncompleteReasons: ["first-inbox-page-only"],
      contactTruncated: false,
    });
    expect(normalizeInstagramContacts({
      ...terminal,
      inbox: {
        ...terminal.inbox,
        next_cursor: "provider-next",
      },
    }, "12345", 20, 50)).toMatchObject({
      contactSetIncompleteReasons: [
        "first-inbox-page-only",
        "provider-cursor-present",
      ],
      contactTruncated: true,
    });
    expect(normalizeInstagramContacts({
      ...terminal,
      inbox: {
        ...terminal.inbox,
        threads: [
          thread("thread-1", "222"),
          thread("thread-2", "333"),
        ],
      },
    }, "12345", 1, 50)).toMatchObject({
      contacts: [{ providerId: "222" }],
      contactSetIncompleteReasons: [
        "first-inbox-page-only",
        "thread-limit-reached",
      ],
      contactTruncated: true,
    });
  });

  test("rejects Instagram inbox participant collections beyond the reviewed bound", () => {
    const response = {
      status: "ok",
      viewer: { pk: "12345" },
      inbox: {
        threads: [{
          thread_id: "thread-1",
          users: Array.from({ length: 101 }, (_unused, index) => ({
            pk: String(index + 1),
            username: `person${index + 1}`,
          })),
        }],
      },
    };
    expect(() => normalizeInstagramContacts(response, "12345", 20, 50)).toThrow(
      "Instagram inbox thread[0].users exceeded its reviewed bound",
    );
    expect(() => normalizeInstagramContacts({
      ...response,
      inbox: { threads: [{ thread_id: "thread-1", users: {} }] },
    }, "12345", 20, 50)).toThrow(
      "Instagram inbox thread[0].users must be a bounded array",
    );
    for (const id of ["0", "01"]) {
      expect(() => normalizeInstagramContacts({
        ...response,
        inbox: {
          threads: [{
            thread_id: "thread-1",
            users: [{ pk: id, username: "malformed" }],
          }],
        },
      }, "12345", 20, 50)).toThrow(
        "must be a canonical decimal account ID",
      );
    }
  });

  test("projects viewer-bound Threads and Facebook Relay preloads", () => {
    expect(normalizeThreadsFeedHtml(threadsHtml, "12345", 10)).toMatchObject({
      feed: "for-you",
      posts: [{ id: "900_12345", caption: "hello" }],
      page_scope: "first-page-only",
      continuation_supported: false,
    });
    expect(normalizeFacebookFeedHtml(facebookHtml, "24680", 10)).toMatchObject({
      feed: "home",
      posts: [{ id: "24680_999", message: "hello" }],
      nextCursor: null,
      continuationSupported: false,
      complete: false,
    });
    expect(normalizeFacebookInboxHtml(facebookHtml, "24680", 10)).toMatchObject({
      folder: "inbox",
      threads: [{ thread_id: "777", participants: [{ id: "123", name: "Friend" }] }],
    });
    expect(metaWebEvidenceSnapshot.operations.facebook).not.toHaveProperty("inbox");
  });

  test("accepts Facebook Stories only from one error-free reviewed news-feed root", () => {
    const currentUser = {
      require: [
        ["CurrentUserInitialData", [], {
          ACCOUNT_ID: "24680",
          USER_ID: "24680",
        }, 7],
        ["RelayAPIConfigDefaults", [], { actorID: "24680" }, 8],
      ],
    };
    const edge = {
      cursor: "edge-cursor",
      node: {
        __typename: "Story",
        __isFeedUnit: "Story",
        id: "story-1",
        post_id: "24680_999",
        actors: [],
      },
    };
    expect(() => normalizeFacebookFeedHtml(
      html(currentUser, { not_news_feed: edge }),
      "24680",
      10,
    )).toThrow("exactly one news-feed root");
    expect(() => normalizeFacebookFeedHtml(
      html(currentUser, {
        require: [{
          __bbox: {
            result: {
              data: { viewer: { news_feed: { edges: [edge] } } },
            },
          },
        }],
      }),
      "24680",
      10,
    )).toThrow("outside its reviewed Relay data root");
    expect(() => normalizeFacebookFeedHtml(
      html(hydratedFacebookViewerRoot(), relayPrefetchedStreamResult({
        errors: [{ message: "private provider rejection" }],
        data: { viewer: { news_feed: { edges: [edge] } } },
      })),
      "24680",
      10,
    )).toThrow("contained provider errors");
    expect(() => normalizeFacebookFeedHtml(
      html(hydratedFacebookViewerRoot(), relayPrefetchedStreamResult({
        errors: {},
        data: { viewer: { news_feed: { edges: [edge] } } },
      })),
      "24680",
      10,
    )).toThrow("errors must be an array");

    const conflictingStoryEdge = structuredClone(edge);
    conflictingStoryEdge.node.__typename = "User";
    expect(() => normalizeFacebookFeedHtml(
      html(hydratedFacebookViewerRoot(), relayPrefetchedStreamResult({
        data: {
          viewer: { news_feed: { edges: [conflictingStoryEdge] } },
        },
      })),
      "24680",
      10,
    )).toThrow("changed its Story type markers");

    const secondEdge = structuredClone(edge);
    secondEdge.cursor = "edge-cursor-2";
    secondEdge.node.id = "story-2";
    secondEdge.node.post_id = "24680_1000";
    expect(normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult({
          data: { viewer: { news_feed: { edges: [] } } },
        }),
        relayPrefetchedStreamResult({
          path: ["viewer", "news_feed", "edges", 0],
          data: edge,
          extensions: { is_final: false },
        }),
        relayPrefetchedStreamResult({
          path: ["viewer", "news_feed", "edges", 1],
          data: secondEdge,
          extensions: { is_final: false },
        }),
        relayPrefetchedStreamResult({
          path: ["viewer", "news_feed"],
          data: {
            page_info: {
              has_next_page: true,
              end_cursor: "next-page",
            },
          },
          extensions: { is_final: true },
        }),
      ),
      "24680",
      10,
    )).toMatchObject({
      posts: [{ id: "24680_999" }, { id: "24680_1000" }],
    });

    const streamRoot = {
      data: {
        viewer: {
          news_feed: {
            edges: [edge],
          },
        },
      },
    };
    const streamEdge = {
      path: ["viewer", "news_feed", "edges", 1],
      data: secondEdge,
      extensions: { is_final: false },
    };
    const streamFinal = {
      path: ["viewer", "news_feed"],
      data: {
        page_info: {
          has_next_page: true,
          end_cursor: "next-page",
        },
      },
      extensions: { is_final: true },
    };
    expect(normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult(streamRoot),
        relayPrefetchedStreamResult(streamEdge),
        relayPrefetchedStreamResult(streamFinal),
      ),
      "24680",
      10,
    )).toMatchObject({
      posts: [{ id: "24680_999" }, { id: "24680_1000" }],
    });
    expect(() => normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult(streamRoot, {
          key: "adp_CometModernHomeFeedQueryRelayPreloader_Stream_A",
        }),
        relayPrefetchedStreamResult(streamEdge, {
          key: "adp_CometModernHomeFeedQueryRelayPreloader_Stream_B",
        }),
      ),
      "24680",
      10,
    )).toThrow("changed its bound preloader key");
    expect(() => normalizeFacebookFeedHtml(
      html(currentUser, {
        require: [["RelayPrefetch", [], {
          __bbox: { result: streamRoot },
        }, 7]],
      }),
      "24680",
      10,
    )).toThrow("outside its reviewed Relay data root");
    for (const wrapper of [
      relayPrefetchedStreamResult(streamRoot, {
        moduleName: "RelayPrefetchedStreamCacheLookalike",
      }),
      relayPrefetchedStreamResult(streamRoot, { method: "unreviewed" }),
      relayPrefetchedStreamResult(streamRoot, { args: ["unexpected"] }),
      relayPrefetchedStreamResult(streamRoot, {
        key: "adp_UnrelatedRelayPreloader_abc123",
      }),
      relayPrefetchedStreamResult(streamRoot, {
        payload: [null, { __bbox: { result: streamRoot } }, null],
      }),
    ]) {
      expect(() => normalizeFacebookFeedHtml(
        html(hydratedFacebookViewerRoot(), wrapper),
        "24680",
        10,
      )).toThrow("outside its reviewed Relay data root");
    }
    expect(() => normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult({
          ...streamRoot,
          errors: [{ message: "private provider rejection" }],
        }),
      ),
      "24680",
      10,
    )).toThrow("contained provider errors");
    expect(() => normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult(streamRoot),
        relayPrefetchedStreamResult(streamRoot),
      ),
      "24680",
      10,
    )).toThrow("initial root out of order");
    expect(() => normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult(streamFinal),
        relayPrefetchedStreamResult(streamRoot),
        relayPrefetchedStreamResult(streamEdge),
      ),
      "24680",
      10,
    )).toThrow("final patch appeared outside its reviewed stream order");
    expect(() => normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult(streamRoot),
        relayPrefetchedStreamResult(streamFinal),
        relayPrefetchedStreamResult(streamEdge),
      ),
      "24680",
      10,
    )).toThrow("edge patch appeared outside its reviewed stream order");

    expect(() => normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult({
          data: { viewer: { news_feed: { edges: [] } } },
        }),
        relayPrefetchedStreamResult({
          path: ["viewer", "news_feed", "edges", 0],
          data: edge,
          extensions: { is_final: false },
        }),
        relayPrefetchedStreamResult({
          path: ["viewer", "news_feed", "edges", 0],
          data: secondEdge,
          extensions: { is_final: false },
        }),
      ),
      "24680",
      10,
    )).toThrow("duplicate edge coordinate");
    expect(() => normalizeFacebookFeedHtml(
      html(
        hydratedFacebookViewerRoot(),
        relayPrefetchedStreamResult({
          data: { viewer: { news_feed: { edges: [] } } },
        }),
        relayPrefetchedStreamResult({
          path: ["viewer", "news_feed", "edges", 1],
          data: secondEdge,
          extensions: { is_final: false },
        }),
        relayPrefetchedStreamResult({
          path: ["viewer", "news_feed"],
          data: {
            page_info: {
              has_next_page: true,
              end_cursor: "next-page",
            },
          },
          extensions: { is_final: true },
        }),
      ),
      "24680",
      10,
    )).toThrow("noncontiguous edge coordinate");
    expect(() => normalizeFacebookFeedHtml(
      facebookHtml.replace('"actorID":"24680"', '"actorID":"99999"'),
      "24680",
      10,
    )).toThrow("actor did not match the bound viewer");
  });

  test("assembles the complete initial Marketplace stream and exposes only a non-skipping cursor", () => {
    const marketplaceFixtureRoots = parseMetaJsonScripts(facebookMarketplaceHtml);
    const marketplaceViewerRoot = marketplaceFixtureRoots[0];
    const marketplaceInitialResult = (
      marketplaceFixtureRoots[1] as { readonly result: unknown }
    ).result;
    const marketplaceEdgePatch = marketplaceFixtureRoots[2];
    const marketplaceFinalPatch = marketplaceFixtureRoots[3];
    const marketplaceStreamKey =
      "adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_Test_abc123";
    expect(normalizeFacebookMarketplaceFeedHtml(
      html(
        marketplaceViewerRoot,
        relayPrefetchedStreamResult(marketplaceInitialResult, {
          key: marketplaceStreamKey,
        }),
        relayPrefetchedStreamResult(marketplaceEdgePatch, {
          key: marketplaceStreamKey,
        }),
        relayPrefetchedStreamResult(marketplaceFinalPatch, {
          key: marketplaceStreamKey,
        }),
      ),
      "24680",
      10,
    )).toMatchObject({
      listings: [{ id: "111" }, { id: "222" }],
    });
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      html(
        marketplaceViewerRoot,
        relayPrefetchedStreamResult(marketplaceFinalPatch, {
          key: marketplaceStreamKey,
        }),
        relayPrefetchedStreamResult(marketplaceInitialResult, {
          key: marketplaceStreamKey,
        }),
      ),
      "24680",
      10,
    )).toThrow("outside its reviewed stream order");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      html(
        marketplaceViewerRoot,
        relayPrefetchedStreamResult(marketplaceInitialResult, {
          key: marketplaceStreamKey,
        }),
        relayPrefetchedStreamResult(marketplaceFinalPatch, {
          key: marketplaceStreamKey,
        }),
        relayPrefetchedStreamResult(marketplaceEdgePatch, {
          key: marketplaceStreamKey,
        }),
      ),
      "24680",
      10,
    )).toThrow("outside its reviewed stream order");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      html(
        marketplaceViewerRoot,
        relayPrefetchedStreamResult(marketplaceInitialResult, {
          key: "adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_Stream_A",
        }),
        relayPrefetchedStreamResult(marketplaceEdgePatch, {
          key: "adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_Stream_B",
        }),
      ),
      "24680",
      10,
    )).toThrow("changed its bound preloader key");

    expect(() => normalizeFacebookMarketplaceFeedHtml(
      html(
        {
          require: [
            ["CurrentUserInitialData", [], {
              ACCOUNT_ID: "24680",
              USER_ID: "24680",
            }, 7],
            ["RelayAPIConfigDefaults", [], { actorID: "24680" }, 8],
          ],
        },
        relayPrefetchedStreamResult({
          data: {
            marketplace_home_feed: { edges: [] },
          },
        }),
      ),
      "24680",
      10,
    )).toThrow("outside its reviewed Relay data root");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      html(marketplaceViewerRoot, {
        require: [["RelayPrefetch", [], {
          __bbox: { result: marketplaceInitialResult },
        }, 7]],
      }),
      "24680",
      10,
    )).toThrow("outside its reviewed Relay data root");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      facebookMarketplaceHtml,
      "24680",
      10,
    )).toThrow("outside its reviewed Relay data root");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      facebookMarketplaceObservedHtml.replace(
        '"actorID":"24680"',
        '"actorID":"99999"',
      ),
      "24680",
      10,
    )).toThrow("actor did not match the bound viewer");
    expect(normalizeFacebookMarketplaceFeedHtml(
      facebookMarketplaceObservedHtml,
      "24680",
      10,
    )).toEqual({
      feed: "marketplace",
      listings: [
        {
          id: "111",
          title: "Top pick",
          amount: "12.00",
          currency: null,
          formatted_price: "$12",
          location: { city: "Brooklyn", state: "NY" },
          image_url: "https://example.com/top.jpg",
          creation_time: 100,
        },
        {
          id: "222",
          title: "General listing",
          amount: "20.00",
          currency: "USD",
          formatted_price: null,
          location: { city: "Queens", state: "NY" },
          image_url: "https://example.com/general.jpg",
          creation_time: 101,
        },
      ],
      sponsored_units: 0,
      provider_has_next_page: true,
      next_cursor: "next-page",
      continuation_supported: true,
      truncated: false,
      complete: false,
    });
    expect(normalizeFacebookMarketplaceFeedHtml(
      facebookMarketplaceObservedHtml,
      "24680",
      1,
    )).toMatchObject({
      listings: [{ id: "111" }],
      next_cursor: null,
      truncated: true,
      complete: false,
    });

    const documents = [...facebookMarketplaceHtml.matchAll(
      /<script type="application\/json">([\s\S]*?)<\/script>/gu,
    )]
      .slice(1, 4)
      .map((match) => match[1])
      .join("\n");
    expect(normalizeFacebookMarketplaceFeedDocuments(
      `for (;;);${documents}\n`,
      "previous-page",
      10,
    )).toMatchObject({
      listings: [{ id: "111" }, { id: "222" }],
      next_cursor: "next-page",
      continuation_supported: true,
      truncated: false,
    });
    expect(() => normalizeFacebookMarketplaceFeedDocuments(
      documents,
      "next-page",
      10,
    )).toThrow("repeated its prior cursor");
    expect(() => normalizeFacebookMarketplaceFeedDocuments(
      documents.replace('"is_final":false', '"is_final":true'),
      "previous-page",
      10,
    )).toThrow("explicitly nonfinal");
    expect(() => normalizeFacebookMarketplaceFeedDocuments(
      `${documents}\n${JSON.stringify({
        path: ["marketplace_home_feed"],
        data: {
          page_info: {
            end_cursor: "duplicate-final",
            has_next_page: true,
          },
        },
        extensions: { is_final: true },
      })}`,
      "previous-page",
      10,
    )).toThrow("outside its reviewed stream order");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      `${facebookMarketplaceObservedHtml}${html({
        errors: [{ message: "private provider rejection" }],
      })}`,
      "24680",
      10,
    )).toThrow("contained provider errors");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      `${facebookMarketplaceObservedHtml}${html({
        decoy: {
          marketplace_home_feed: { edges: [] },
        },
      })}`,
      "24680",
      10,
    )).toThrow("outside its reviewed Relay data root");
  });

  test("projects one exact Marketplace listing while keeping item-seen outside the contract", () => {
    const marketplaceFixtureRoots = parseMetaJsonScripts(facebookMarketplaceHtml);
    const marketplaceViewerRoot = marketplaceFixtureRoots[0];
    const marketplaceDetailResult = marketplaceFixtureRoots[4];
    const marketplaceMediaResult = marketplaceFixtureRoots[5];
    const marketplaceDetailKey =
      "adp_MarketplacePDPContainerQueryRelayPreloader_Test_abc123";
    const marketplaceMediaKey =
      "adp_MarketplacePDPC2CMediaViewerWithImagesQueryRelayPreloader_Test_abc123";
    expect(normalizeFacebookMarketplaceListingHtml(
      html(
        marketplaceViewerRoot,
        relayPrefetchedStreamResult(marketplaceDetailResult, {
          key: marketplaceDetailKey,
        }),
        relayPrefetchedStreamResult(marketplaceMediaResult, {
          key: marketplaceMediaKey,
        }),
      ),
      "24680",
      "222",
    )).toMatchObject({
      id: "222",
      photos: [{ id: "822" }],
    });
    for (const [detailKey, mediaKey] of [
      [marketplaceMediaKey, marketplaceDetailKey],
      [marketplaceDetailKey, marketplaceDetailKey],
      [marketplaceMediaKey, marketplaceMediaKey],
    ] as const) {
      expect(() => normalizeFacebookMarketplaceListingHtml(
        html(
          marketplaceViewerRoot,
          relayPrefetchedStreamResult(marketplaceDetailResult, {
            key: detailKey,
          }),
          relayPrefetchedStreamResult(marketplaceMediaResult, {
            key: mediaKey,
          }),
        ),
        "24680",
        "222",
      )).toThrow("unreviewed preloader");
    }
    expect(() => normalizeFacebookMarketplaceListingHtml(
      html(
        marketplaceViewerRoot,
        relayPrefetchedStreamResult(marketplaceDetailResult, {
          key: "adp_MarketplaceUnrelatedQueryRelayPreloader_Test_abc123",
        }),
        relayPrefetchedStreamResult(marketplaceMediaResult, {
          key: marketplaceMediaKey,
        }),
      ),
      "24680",
      "222",
    )).toThrow("outside its reviewed Relay data root");
    expect(() => normalizeFacebookMarketplaceListingHtml(
      html(
        marketplaceViewerRoot,
        {
          require: [["RelayPrefetch", [], {
            __bbox: { result: marketplaceDetailResult },
          }, 7]],
        },
        relayPrefetchedStreamResult(marketplaceMediaResult, {
          key: marketplaceMediaKey,
        }),
      ),
      "24680",
      "222",
    )).toThrow("outside its reviewed Relay data root");
    expect(() => normalizeFacebookMarketplaceListingHtml(
      facebookMarketplaceHtml,
      "24680",
      "222",
    )).toThrow("outside its reviewed Relay data root");
    expect(() => normalizeFacebookMarketplaceListingHtml(
      facebookMarketplaceObservedHtml.replace(
        '"actorID":"24680"',
        '"actorID":"99999"',
      ),
      "24680",
      "222",
    )).toThrow("actor did not match the bound viewer");

    expect(normalizeFacebookMarketplaceListingHtml(
      facebookMarketplaceObservedHtml,
      "24680",
      "222",
    )).toEqual({
      id: "222",
      title: "General listing",
      description: "Description",
      price: { amount: "20.00", currency: "USD", formatted: "$20" },
      location: "Queens, NY",
      creation_time: 101,
      is_live: true,
      is_pending: false,
      is_sold: false,
      is_viewer_seller: false,
      seller: { id: "13579", name: "Seller" },
      photos: [{
        id: "822",
        url: "https://example.com/listing.jpg",
        width: 640,
        height: 480,
        accessibility_caption: "Listing photo",
      }],
      video_count: 0,
    });
    expect(() => normalizeFacebookMarketplaceListingHtml(
      facebookMarketplaceObservedHtml.replaceAll(
        "marketplace_product_details_page",
        "unrelated_product_details_page",
      ),
      "24680",
      "222",
    )).toThrow("did not bind one exact detailed listing");
    expect(() => normalizeFacebookMarketplaceListingHtml(
      `${facebookMarketplaceObservedHtml}${html({
        errors: [{ message: "private provider rejection" }],
      })}`,
      "24680",
      "222",
    )).toThrow("contained provider errors");
  });

  test("rejects malformed or cross-target responses", () => {
    expect(() => normalizeInstagramPost({
      status: "ok",
      items: [{ id: "901_12345" }],
    }, "900_12345")).toThrow("did not bind");
    expect(() => normalizeThreadsFeedHtml(threadsHtml, "99999", 10)).toThrow("changed its bound viewer");
    expect(() => normalizeFacebookFeedHtml(facebookHtml, "99999", 10)).toThrow("changed its bound viewer");
    expect(() => normalizeFacebookMarketplaceFeedHtml(
      facebookMarketplaceObservedHtml,
      "99999",
      10,
    )).toThrow("changed its bound viewer");
    expect(() => normalizeFacebookMarketplaceListingHtml(
      facebookMarketplaceObservedHtml,
      "24680",
      "333",
    )).toThrow("changed its requested listing target");
  });

  test("rejects nonempty Meta content hidden beyond the reviewed traversal depth", () => {
    expect(() => parseFacebookViewerId(
      `${facebookHtml}${html(nestedContainer(41))}`,
    )).toThrow("reviewed depth bound");
  });
});
