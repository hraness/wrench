import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import { sealCursorToken } from "../cursor-token";
import { canonicalJson, sha256, type WebSessionRecipe } from "../model";
import {
  executeMetaWebOperation,
  probeMetaWebSubject,
  type MetaWebRuntimeDependencies,
} from "./meta-web-runtime";
import type { MetaWebSite } from "./meta-web";
import {
  bindFacebookMarketplacePaginationCursor,
  facebookMarketplacePaginationInputHash,
} from "./meta-marketplace-relay";

function script(value: unknown): string {
  return `<script type="application/json">${JSON.stringify(value)}</script>`;
}

function hydratedFacebookViewer(): unknown {
  return {
    require: [
      ["ScheduledServerJS", "handle", null, [{
        __bbox: {
          require: [["AsyncData", "resolve", [], [
            "adp_WebWorkerV2HasteResponsePreloader_RuntimeFixture_abc123",
            {
              data: {
                __bbox: {
                  hrp: {
                    jsmods: {
                      define: [[
                        "CurrentUserInitialData",
                        [],
                        { ACCOUNT_ID: "24680", USER_ID: "24680" },
                        1,
                      ]],
                    },
                  },
                },
              },
            },
          ]]],
        },
      }]],
      ["RelayAPIConfigDefaults", [], { actorID: "24680" }, 2],
    ],
  };
}

function facebookStream(
  key: string,
  result: unknown,
): unknown {
  return {
    require: [["ScheduledServerJS", "handle", null, [{
      __bbox: {
        require: [["RelayPrefetchedStreamCache", "next", [], [
          key,
          { __bbox: { result } },
        ]]],
      },
    }]]],
  };
}

const facebookHomeStreamKey =
  "adp_CometModernHomeFeedQueryRelayPreloader_RuntimeFixture_abc123";
const facebookGroupStreamKey =
  "adp_CometGroupDiscussionRootSuccessQueryRelayPreloader_RuntimeFixture_abc123";
const facebookMarketplaceFeedStreamKey =
  "adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_RuntimeFixture_abc123";
const facebookMarketplaceDetailStreamKey =
  "adp_MarketplacePDPContainerQueryRelayPreloader_RuntimeFixture_abc123";
const facebookMarketplaceMediaStreamKey =
  "adp_MarketplacePDPC2CMediaViewerWithImagesQueryRelayPreloader_RuntimeFixture_abc123";

const instagramHtml = script({
  require: [["PolarisViewer", [], { id: "12345", data: {} }, 1]],
});

const threadsHtml = script({
  require: [
    ["BarcelonaSessionInfo", [], { is_th_session: true, is_logged_out: false }, 1],
    ["Relay", [], {
      __bbox: {
        result: {
          data: {
            viewer: { user: { id: "12345" } },
            feedData: {
              edges: [{
                node: {
                  text_post_app_thread: {
                    id: "thread",
                    thread_items: [{
                      post: {
                        id: "900_12345",
                        caption: { text: "hello" },
                        user: { pk: "12345", username: "viewer" },
                      },
                    }],
                  },
                },
              }],
            },
          },
        },
      },
    }, 1],
  ],
});

const facebookHtml = [
  script(hydratedFacebookViewer()),
  script(facebookStream(facebookHomeStreamKey, {
    data: {
      viewer: {
        news_feed: {
          edges: [{
            cursor: "fixture-feed-edge",
            node: {
              __isFeedUnit: "Story",
              id: "story",
              post_id: "24680_999",
              actors: [],
            },
          }],
        },
        message_threads: {
          edges: [{
            node: {
              thread_key: { thread_fbid: "777" },
              id: "node",
              all_participants: {
                edges: [{
                  node: { messaging_actor: { id: "123", name: "Friend" } },
                }],
              },
            },
          }],
        },
      },
    },
  })),
].join("");

const facebookGroupHtml = [
  script(hydratedFacebookViewer()),
  script(facebookStream(facebookGroupStreamKey, {
    data: {
      group: {
        __typename: "Group",
        id: "13579",
        group_feed: {
          edges: [{
            cursor: "header-edge",
            node: {
              __typename: "GroupsSectionHeaderUnit",
              __isFeedUnit: "GroupsSectionHeaderUnit",
              id: "header-node",
              target_group: { id: "13579" },
            },
          }],
        },
      },
    },
  })),
  script(facebookStream(facebookGroupStreamKey, {
    path: ["group", "group_feed", "edges", 1],
    data: {
      cursor: "post-edge",
      node: {
        __typename: "Story",
        __isFeedUnit: "Story",
        id: "opaque-story",
        post_id: "9001",
        creation_time: 101,
        actors: [{ id: "801", name: "Fixture actor" }],
        to: { __typename: "Group", id: "13579" },
        comet_sections: {
          content: {
            story: {
              id: "opaque-story",
              post_id: "9001",
              target_group: { id: "13579" },
              actors: [{ id: "801", name: "Fixture actor" }],
              message: { text: "Fixture post" },
            },
          },
        },
      },
    },
    extensions: { is_final: false, prefetch_uris_v2: [] },
  })),
  script(facebookStream(facebookGroupStreamKey, {
    path: ["group", "group_feed"],
    data: {
      page_info: {
        has_next_page: true,
        end_cursor: "provider-only-cursor",
      },
    },
    extensions: { is_final: true, prefetch_uris_v2: [] },
  })),
].join("");

const facebookMarketplaceHtml = [
  '<link rel="preload" as="script" crossorigin="anonymous" nonce="fixture" href="https://static.xx.fbcdn.net/rsrc.php/v4/test/bundle.js">',
  script({
    require: [
      ["CurrentUserInitialData", [], {
        ACCOUNT_ID: "24680",
        USER_ID: "24680",
      }, 1],
      ["RelayAPIConfigDefaults", [], { actorID: "24680" }, 2],
      ["DTSGInitialData", [], { token: "fixture-dtsg-token" }, 3],
      ["SprinkleConfig", [], {
        param_name: "jazoest",
        version: 2,
        should_randomize: false,
      }, 4],
      ["LSD", [], { token: "fixture-lsd-token" }, 5],
      ["SiteData", [], {
        client_revision: 1_014_951_646,
        hsi: "7392731950764655501",
        comet_env: 15,
        wbloks_env: false,
        is_comet: true,
      }, 6],
      ["ScheduledServerJS", "handle", null, [{
        __bbox: {
          require: [[
            "CometPlatformRootClient",
            "initialize",
            [
              "CometFBLoggedInRootConfig",
              "RequireDeferredReference",
            ],
            [{
              ConfigOrBuilder: {},
              additional_roots: [],
              backgroundRouteInfo: null,
              client_id: "runtime-fixture",
              expectedPreloaders: [{
                actorID: "24680",
                preloaderID: "marketplace-feed-preloader",
                queryID: "28097605446510041",
                queryName: "MarketplaceCometBrowseFeedLightContainerQuery",
                variables: {
                  __relay_internal__pv__CometMarketplaceShouldShowFeedShippingIconrelayprovider: false,
                  __relay_internal__pv__CometMarketplaceShouldShowTopPicksStrikethroughrelayprovider: false,
                  __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: true,
                  __relay_internal__pv__MarketplaceCometAdmodulerelayprovider: true,
                  buyLocation: { latitude: 40.7128, longitude: -74.006 },
                  count: 24,
                  cursor: null,
                  imageWidth: 256,
                  mediaType: "image/jpeg",
                  radius: 65_000,
                  scale: 2,
                  sizing: "cover-fill-cropped",
                  useSDFPath: true,
                },
              }],
              initialRouteInfo: {},
              qplEvents: [],
              rootElementID: "mount",
              ssrEnabled: true,
            }],
          ]],
        },
      }]],
    ],
    assets: [
      "https://static.xx.fbcdn.net/rsrc.php/v4/test/bundle.js",
    ],
  }),
  script(facebookStream(facebookMarketplaceFeedStreamKey, {
    data: {
      marketplace_home_feed: {
        edges: [{
          cursor: "edge-0",
          node: {
            __typename: "MarketplaceFeedGeneralListingObject",
            __isMarketplaceFeedGeneralListingData: "MarketplaceFeedGeneralListingObject",
            data: {
              title: "Listing",
              price: { amount_with_offset: "20.00", currency: "USD" },
            },
            entity: {
              id: "222",
              location: { reverse_geocode: { city: "Queens", state: "NY" } },
            },
            listing: { id: "222", creation_time: 101 },
            photo: { default_image: { uri: "https://example.com/listing.jpg" } },
          },
        }],
      },
    },
  })),
  script(facebookStream(facebookMarketplaceFeedStreamKey, {
    path: ["marketplace_home_feed"],
    data: { page_info: { end_cursor: "next", has_next_page: true } },
    extensions: { is_final: true },
  })),
  script(facebookStream(facebookMarketplaceDetailStreamKey, {
    data: {
      target: {
        __typename: "GroupCommerceProductItem",
        id: "222",
        primary_mp_ent: { id: "222" },
        marketplace_listing_title: "Listing",
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
      },
    },
  })),
  script(facebookStream(facebookMarketplaceMediaStreamKey, {
    data: {
      target: {
        __typename: "GroupCommerceProductItem",
        id: "222",
        listing_photos: [{
          id: "822",
          image: {
            uri: "https://example.com/listing.jpg",
            width: 640,
            height: 480,
          },
        }],
        pre_recorded_videos: [],
      },
    },
  })),
].join("");

const stateRoots: string[] = [];

afterEach(() => {
  for (const root of stateRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stateEnvironment(): Readonly<Record<string, string | undefined>> {
  const root = mkdtempSync(join(tmpdir(), "wrench-meta-runtime-"));
  chmodSync(root, 0o700);
  stateRoots.push(root);
  return { ...process.env, WRENCH_STATE_HOME: root };
}

function pngFixture(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const facebookMarketplaceBundle =
  "__d(\"MarketplaceCometBrowseFeedLightPaginationQuery_facebookRelayOperation\",[],"
  + "(function(a,b,c,d,e,f){\"use strict\";e.exports=\"27448592924790037\"}),null);";

const facebookMarketplacePaginationText = [
  {
    data: {
      marketplace_home_feed: {
        edges: [],
      },
    },
    extensions: {},
  },
  {
    path: ["marketplace_home_feed", "edges", 0],
    data: {
      cursor: "edge-1",
      node: {
        __typename: "MarketplaceFeedGeneralListingObject",
        __isMarketplaceFeedGeneralListingData: "MarketplaceFeedGeneralListingObject",
        data: {
          title: "Second listing",
          price: { amount_with_offset: "30.00", currency: "USD" },
        },
        entity: {
          id: "333",
          location: { reverse_geocode: { city: "Brooklyn", state: "NY" } },
        },
        listing: { id: "333", creation_time: 102 },
        photo: { default_image: { uri: "https://example.com/second.jpg" } },
      },
    },
    extensions: { is_final: false },
  },
  {
    path: ["marketplace_home_feed"],
    data: { page_info: { end_cursor: "next-2", has_next_page: true } },
    extensions: { is_final: true },
  },
].map((value) => JSON.stringify(value)).join("\r\n");

function strictCookie(domain: string, name: string, value: string): StrictCookie {
  return {
    name,
    value,
    domain,
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
  };
}

type Call = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | Uint8Array | null;
};

function dependencies(
  site: "instagram" | "threads" | "facebook",
  calls: Call[],
  handler?: (call: Call) => Response,
  acquisitions?: { count: number },
  sessionCookies?: readonly StrictCookie[],
): MetaWebRuntimeDependencies {
  const domain = site === "instagram"
    ? "www.instagram.com"
    : site === "threads"
      ? "www.threads.com"
      : "www.facebook.com";
  const cookies = sessionCookies ?? (site === "facebook"
    ? [strictCookie(domain, "c_user", "24680"), strictCookie(domain, "xs", "private")]
    : [strictCookie(domain, "ds_user_id", "12345"), strictCookie(domain, "sessionid", "private")]);
  const acquireCookies: CookieRecordReader = () => {
    if (acquisitions !== undefined) acquisitions.count += 1;
    return Promise.resolve({ cookies, warnings: [] });
  };
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? init.body
          : null,
    };
    calls.push(call);
    if (handler !== undefined) return Promise.resolve(handler(call));
    const body = site === "instagram" ? instagramHtml : site === "threads" ? threadsHtml : facebookHtml;
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  return { acquireCookies, fetch };
}

function auth(site: "instagram" | "threads" | "facebook"): WrenchAuth {
  return {
    schemaVersion: 1,
    id: `${site}-test`,
    kind: "cookie-source",
    source: "arc",
    profile: "Profile 1",
    subject: site === "instagram"
      ? "instagram:12345"
      : site === "threads"
        ? "threads:12345"
        : "facebook:user:24680",
  };
}

function recipe(
  site: MetaWebSite,
  action: WebSessionRecipe["action"],
  contractVersion = (
    site === "instagram" && (
      action === "comments.read"
      || action === "feeds.read"
      || action === "messaging.list"
    )
  ) || (
    site === "threads" && (
      action === "feeds.read" || action === "posts.publish"
    )
  ) || (
    site === "facebook" && (action === "feeds.read" || action === "messaging.list")
  ) || (
    (site === "facebook-group" || site === "facebook-marketplace")
    && action === "feeds.read"
  )
    ? 2
    : 1,
): WebSessionRecipe {
  return {
    site,
    action,
    contractVersion,
    timeoutMs: 1_000,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

async function rejectionMessage(value: Promise<unknown>): Promise<string> {
  try {
    await value;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected rejection");
}

async function issueMarketplaceCursor(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const calls: Call[] = [];
  const result = await executeMetaWebOperation(
    recipe("facebook-marketplace", "feeds.read"),
    { feed: "marketplace", limit: 10 },
    auth("facebook"),
    {
      environment,
      dependencies: dependencies("facebook", calls, (call) =>
        new Response(
          call.url.pathname === "/" ? facebookHtml : facebookMarketplaceHtml,
          { status: 200, headers: { "content-type": "text/html" } },
        )),
    },
  );
  const cursor = (result.output as { next_cursor: unknown }).next_cursor;
  if (typeof cursor !== "string" || !cursor.startsWith("smn1.")) {
    throw new Error("fixture did not issue an authenticated Marketplace cursor");
  }
  return cursor;
}

function issueMarketplaceCursorWithHistory(
  environment: Readonly<Record<string, string | undefined>>,
  historyLength: number,
): string {
  const marketplaceAuth = auth("facebook");
  const inputHash = facebookMarketplacePaginationInputHash(
    facebookMarketplaceHtml,
    "24680",
  );
  let cursor = bindFacebookMarketplacePaginationCursor(
    "24680",
    "history-cursor-0",
    inputHash,
  );
  for (let index = 1; index < historyLength; index += 1) {
    cursor = bindFacebookMarketplacePaginationCursor(
      "24680",
      `history-cursor-${index}`,
      inputHash,
      cursor,
    );
  }
  return sealCursorToken(
    "facebook-marketplace-feed",
    marketplaceAuth.id,
    sha256(canonicalJson(marketplaceAuth)),
    cursor,
    environment,
  );
}

describe("Meta authenticated internal-data runtime", () => {
  test("probes exact Instagram, Threads, and Facebook identities by direct HTTPS", async () => {
    for (const [site, expected] of [
      ["instagram", "instagram:12345"],
      ["threads", "threads:12345"],
      ["facebook", "facebook:user:24680"],
    ] as const) {
      const calls: Call[] = [];
      expect(await probeMetaWebSubject(site, auth(site), {
        dependencies: dependencies(site, calls),
      })).toBe(expected);
      expect(calls.map((call) => call.url.href)).toEqual([
        site === "instagram"
          ? "https://www.instagram.com/"
          : site === "threads"
            ? "https://www.threads.com/"
            : "https://www.facebook.com/",
      ]);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.headers.get("cookie")).toContain(site === "facebook" ? "c_user=" : "ds_user_id=");
    }
  });

  test("uploads one plan-bound Threads PNG, dispatches once, and verifies the exact permalink readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-threads-post-"));
    chmodSync(root, 0o700);
    stateRoots.push(root);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, pngFixture(959, 1022), { mode: 0o600 });
    const uploadId = "1786923725481";
    const postId = "987654321_12345";
    const postCode = "CodeABC";
    const text = "how your email finds me";
    const bootstrap = threadsHtml + script({
      require: [
        ["SprinkleConfig", [], {
          param_name: "jazoest",
          version: 2,
          should_randomize: false,
        }, 1],
        ["WebBloksVersioningID", [], {
          versioningID: "a".repeat(64),
        }, 2],
      ],
    });
    const readback = threadsHtml + script({
      post: {
        pk: postId,
        code: postCode,
        canonical_url: `https://www.threads.com/@viewer/post/${postCode}`,
        caption: { text },
        user: { pk: "12345", username: "viewer" },
      },
    });
    const calls: Call[] = [];
    const events: string[] = [];
    const network = dependencies(
      "threads",
      calls,
      (call) => {
        events.push(`${call.method} ${call.url.pathname}`);
        if (call.method === "GET" && call.url.pathname === "/") {
          return new Response(bootstrap, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (call.url.pathname === `/rupload_igphoto/fb_uploader_${uploadId}`) {
          expect(call.body).toBeInstanceOf(Uint8Array);
          expect((call.body as Uint8Array).byteLength).toBe(24);
          expect(call.headers.get("x-entity-length")).toBe("24");
          expect(call.headers.get("x-instagram-rupload-params")).toBe(JSON.stringify({
            is_sidecar: "0",
            is_threads: "1",
            media_type: 1,
            upload_id: uploadId,
            upload_media_height: 1022,
            upload_media_width: 959,
          }));
          return new Response(JSON.stringify({ status: "ok", upload_id: uploadId }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (call.url.pathname === "/api/v1/media/configure_text_post_app_feed/") {
          expect(call.headers.get("x-csrftoken")).toBe("csrf-fixture");
          expect(call.headers.get("x-bloks-version-id")).toBe("a".repeat(64));
          const form = new URLSearchParams(typeof call.body === "string" ? call.body : "");
          expect(Object.fromEntries(form)).toEqual({
            audience: "default",
            caption: text,
            creator_geo_gating_info: JSON.stringify({ whitelist_country_codes: [] }),
            is_threads: "true",
            should_include_permalink: "true",
            text_post_app_info: JSON.stringify({
              excluded_inline_media_ids: "[]",
              is_genai_invocation_post: false,
              is_reply_approval_enabled: false,
              is_spoiler_media: false,
              text_with_entities: { entities: [], text },
            }),
            upload_id: uploadId,
            web_session_id: "::wg8yw9",
            jazoest: "21250",
          });
          return new Response(JSON.stringify({
            status: "ok",
            media: {
              code: postCode,
              permalink: `https://www.threads.com/@viewer/post/${postCode}`,
              pk: postId,
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (call.url.pathname === `/@viewer/post/${postCode}`) {
          return new Response(readback, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        throw new Error(`unexpected Threads test request ${call.method} ${call.url.pathname}`);
      },
      undefined,
      [
        strictCookie("www.threads.com", "csrftoken", "csrf-fixture"),
        strictCookie("www.threads.com", "ds_user_id", "12345"),
        strictCookie("www.threads.com", "sessionid", "private"),
      ],
    );
    const result = await executeMetaWebOperation(
      recipe("threads", "posts.publish"),
      {
        attachment: { kind: "file", reference: "fixture" },
        audience: "default",
        body: text,
      },
      auth("threads"),
      {
        fileResolver: () => Promise.resolve([imagePath]),
        beforeDispatch: (event) => {
          events.push(`before ${event.progress.started}`);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          events.push(`after ${event.progress.verified}`);
          return Promise.resolve();
        },
        dependencies: { ...network, now: () => Number(uploadId) },
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        post: { id: postId, caption: text, user: { id: "12345" } },
        attachment: { height: 1022, mediaType: "image/png", width: 959 },
      },
      finalUrl: `https://www.threads.com/@viewer/post/${postCode}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(events).toEqual([
      "GET /",
      "GET /",
      "before 0",
      `POST /rupload_igphoto/fb_uploader_${uploadId}`,
      "POST /api/v1/media/configure_text_post_app_feed/",
      `GET /@viewer/post/${postCode}`,
      "after 1",
    ]);
  });

  test("marks a Threads image-upload failure indeterminate after durable dispatch and never creates a post", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-threads-upload-failure-"));
    chmodSync(root, 0o700);
    stateRoots.push(root);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, pngFixture(959, 1022), { mode: 0o600 });
    const uploadId = "1786923725481";
    const bootstrap = threadsHtml + script({
      require: [
        ["SprinkleConfig", [], {
          param_name: "jazoest",
          version: 2,
          should_randomize: false,
        }, 1],
        ["WebBloksVersioningID", [], {
          versioningID: "a".repeat(64),
        }, 2],
      ],
    });
    const calls: Call[] = [];
    let beforeDispatch = 0;
    let creates = 0;
    const result = await executeMetaWebOperation(
      recipe("threads", "posts.publish"),
      {
        attachment: { kind: "file", reference: "fixture" },
        audience: "default",
        body: "how your email finds me",
      },
      auth("threads"),
      {
        fileResolver: () => Promise.resolve([imagePath]),
        beforeDispatch: () => {
          beforeDispatch += 1;
          return Promise.resolve();
        },
        dependencies: {
          ...dependencies("threads", calls, (call) => {
            if (call.method === "GET" && call.url.pathname === "/") {
              return new Response(bootstrap, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            if (call.url.pathname === `/rupload_igphoto/fb_uploader_${uploadId}`) {
              return new Response("upload failed", { status: 500 });
            }
            if (call.url.pathname === "/api/v1/media/configure_text_post_app_feed/") {
              creates += 1;
            }
            throw new Error(`unexpected Threads test request ${call.method} ${call.url.pathname}`);
          }),
          now: () => Number(uploadId),
        },
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(beforeDispatch).toBe(1);
    expect(creates).toBe(0);
    expect(calls.filter((call) => call.url.pathname.includes("/rupload_igphoto/"))).toHaveLength(1);
  });

  test("executes Instagram timeline through the exact JSON endpoint with no dispatch", async () => {
    const calls: Call[] = [];
    let callbacks = 0;
    const result = await executeMetaWebOperation(
      recipe("instagram", "feeds.read"),
      { feed: "home", limit: 5 },
      auth("instagram"),
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        dependencies: dependencies("instagram", calls, (call) => {
          if (call.url.pathname === "/") {
            return new Response(instagramHtml, { status: 200, headers: { "content-type": "text/html" } });
          }
          expect(call.url.pathname).toBe("/api/v1/feed/timeline/");
          expect(Object.fromEntries(call.url.searchParams)).toEqual({ count: "5" });
          expect(call.headers.get("x-ig-app-id")).toBe("936619743392459");
          return new Response(JSON.stringify({
            status: "ok",
            viewer: { pk: "12345" },
            feed_items: [{
              media_or_ad: {
                id: "900_12345",
                pk: "900",
                user: { pk: "12345", username: "viewer" },
              },
            }],
            next_max_id: "provider-next-page",
            more_available: true,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }),
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        feed: "home",
        items: [{ id: "900_12345" }],
        page_scope: "first-page-only",
        continuation_supported: false,
      },
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(calls).toHaveLength(2);
    expect(callbacks).toBe(0);
  });

  test("executes Instagram contacts through the exact inbox summary GET with unavailable statistics", async () => {
    const calls: Call[] = [];
    let callbacks = 0;
    const result = await executeMetaWebOperation(
      recipe("instagram", "contacts.list"),
      { contact_limit: 1, thread_limit: 3 },
      auth("instagram"),
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        dependencies: dependencies("instagram", calls, (call) => {
          expect(call.method).toBe("GET");
          if (call.url.pathname === "/") {
            return new Response(instagramHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          expect(call.url.pathname).toBe("/api/v1/direct_v2/inbox/");
          expect(Object.fromEntries(call.url.searchParams)).toEqual({
            limit: "3",
            thread_message_limit: "1",
            persistentBadging: "true",
            visual_message_return_type: "unseen",
          });
          expect(call.headers.get("x-ig-app-id")).toBe("936619743392459");
          expect(call.headers.get("x-requested-with")).toBe("XMLHttpRequest");
          expect(call.headers.get("referer"))
            .toBe("https://www.instagram.com/direct/inbox/");
          return new Response(JSON.stringify({
            status: "ok",
            viewer: { pk: "12345" },
            inbox: {
              oldest_cursor: "provider-only-cursor",
              has_older: true,
              threads: [{
                thread_id: "thread-1",
                users: [
                  { pk: "12345", username: "viewer" },
                  { pk: "222", username: "friend", full_name: "Friend" },
                  { pk: "333", username: "other", full_name: "Other" },
                ],
              }],
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        provider: "instagram",
        operation: "contacts.list",
        accountSubject: "instagram:12345",
        contacts: [{
          providerId: "222",
          displayName: "Friend",
          handle: "friend",
          sentCount: null,
          sentCountComplete: false,
          sentCountLowerBound: false,
          receivedCount: null,
          receivedCountComplete: false,
          receivedCountLowerBound: false,
          lastSentAt: null,
          lastSentAtBasis: "unavailable",
          sentStatsIncompleteReasons: ["message-history-capture-required"],
          lastReceivedAt: null,
          lastReceivedAtBasis: "unavailable",
          receivedStatsIncompleteReasons: ["message-history-capture-required"],
        }],
        metadataScope: "first-page-inbox-participant-summary",
        contactSetCompleteness: "first-page-only",
        contactTruncated: true,
        statsScope: "unavailable-without-acknowledgement-free-message-history",
      },
      finalUrl: "https://www.instagram.com/direct/inbox/",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/api/v1/direct_v2/inbox/",
    ]);
    expect(callbacks).toBe(0);
  });

  test("executes partial direct Relay feed preloads for Threads and Facebook", async () => {
    const threadsCalls: Call[] = [];
    const threads = await executeMetaWebOperation(
      recipe("threads", "feeds.read"),
      { feed: "for-you", limit: 5 },
      auth("threads"),
      { dependencies: dependencies("threads", threadsCalls) },
    );
    expect(threads).toMatchObject({
      output: {
        posts: [{ id: "900_12345" }],
        page_scope: "first-page-only",
        continuation_supported: false,
      },
      dispatchStarted: false,
    });
    expect(threadsCalls).toHaveLength(1);

    const facebookCalls: Call[] = [];
    const feed = await executeMetaWebOperation(
      recipe("facebook", "feeds.read"),
      { feed: "home", limit: 5 },
      auth("facebook"),
      { dependencies: dependencies("facebook", facebookCalls) },
    );
    expect(feed).toMatchObject({
      output: {
        posts: [{ id: "24680_999" }],
        nextCursor: null,
        continuationSupported: false,
        complete: false,
      },
      finalUrl: "https://www.facebook.com/",
      dispatchStarted: false,
    });
    expect(facebookCalls).toHaveLength(1);
  });

  test("executes one exact Group feed page through inert HTML only", async () => {
    const calls: Call[] = [];
    let callbacks = 0;
    const result = await executeMetaWebOperation(
      recipe("facebook-group", "feeds.read"),
      { group_id: "13579", feed: "group", limit: 5 },
      auth("facebook"),
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        dependencies: dependencies("facebook", calls, (call) => {
          expect(call.method).toBe("GET");
          if (call.url.pathname === "/") {
            return new Response(facebookHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          expect(call.url.pathname).toBe("/groups/13579/");
          return new Response(facebookGroupHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }),
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        feed: "group",
        group_id: "13579",
        posts: [{ id: "9001" }],
        provider_has_next_page: true,
        next_cursor: null,
        continuation_supported: false,
        complete: false,
      },
      finalUrl: "https://www.facebook.com/groups/13579/",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/groups/13579/",
    ]);
    expect(callbacks).toBe(0);
  });

  test("executes Marketplace feed and exact listing reads through HTML bootstrap only", async () => {
    const calls: Call[] = [];
    const environment = stateEnvironment();
    let callbacks = 0;
    const handler = (call: Call): Response => {
      expect(call.method).toBe("GET");
      if (call.url.pathname === "/") {
        return new Response(facebookHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      expect(["/marketplace/", "/marketplace/item/222/"]).toContain(call.url.pathname);
      return new Response(facebookMarketplaceHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const marketplaceAuth = auth("facebook");
    const feed = await executeMetaWebOperation(
      recipe("facebook-marketplace", "feeds.read"),
      { feed: "marketplace", limit: 10 },
      marketplaceAuth,
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        environment,
        dependencies: dependencies("facebook", calls, handler),
      },
    );
    expect(feed).toMatchObject({
      output: {
        feed: "marketplace",
        listings: [{ id: "222" }],
        continuation_supported: true,
      },
      finalUrl: "https://www.facebook.com/marketplace/",
      dispatchStarted: false,
    });
    expect((feed.output as { next_cursor: unknown }).next_cursor)
      .toMatch(/^smn1\.[A-Za-z0-9_-]+$/u);
    const listing = await executeMetaWebOperation(
      recipe("facebook-marketplace", "listings.read", 2),
      { listing_id: "222" },
      marketplaceAuth,
      {
        dependencies: dependencies("facebook", calls, handler),
        environment,
      },
    );
    expect(listing).toMatchObject({
      output: {
        id: "222",
        title: "Listing",
        photos: [{ id: "822" }],
      },
      finalUrl: "https://www.facebook.com/marketplace/item/222/",
      dispatchStarted: false,
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/marketplace/",
      "/",
      "/marketplace/item/222/",
    ]);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
    expect(callbacks).toBe(0);
  });

  test("never advertises a Marketplace continuation from drifted preloader literals", async () => {
    const calls: Call[] = [];
    const environment = stateEnvironment();
    const message = await rejectionMessage(executeMetaWebOperation(
      recipe("facebook-marketplace", "feeds.read"),
      { feed: "marketplace", limit: 10 },
      auth("facebook"),
      {
        environment,
        dependencies: dependencies("facebook", calls, (call) =>
          new Response(
            call.url.pathname === "/"
              ? facebookHtml
              : facebookMarketplaceHtml.replace(
                '"mediaType":"image/jpeg"',
                '"mediaType":"image/png"',
              ),
            { status: 200, headers: { "content-type": "text/html" } },
          )),
      },
    ));
    expect(message).toContain("media type drifted from reviewed evidence");
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/marketplace/",
    ]);
  });

  test("executes Marketplace continuation through the resolved first-party Relay query", async () => {
    const calls: Call[] = [];
    const environment = stateEnvironment();
    let callbacks = 0;
    const marketplaceAuth = auth("facebook");
    const initial = await executeMetaWebOperation(
      recipe("facebook-marketplace", "feeds.read"),
      { feed: "marketplace", limit: 10 },
      marketplaceAuth,
      {
        environment,
        dependencies: dependencies("facebook", calls, (call) => {
          if (call.url.pathname === "/") {
            return new Response(facebookHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          return new Response(facebookMarketplaceHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }),
      },
    );
    const cursor = (initial.output as { next_cursor: unknown }).next_cursor;
    expect(cursor).toMatch(/^smn1\.[A-Za-z0-9_-]+$/u);
    if (typeof cursor !== "string") throw new Error("fixture cursor was not a string");
    calls.splice(0);
    const result = await executeMetaWebOperation(
      recipe("facebook-marketplace", "feeds.read"),
      { feed: "marketplace", cursor, limit: 50 },
      marketplaceAuth,
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        environment,
        dependencies: dependencies("facebook", calls, (call) => {
          if (call.url.origin === "https://static.xx.fbcdn.net") {
            expect(call.method).toBe("GET");
            return new Response(facebookMarketplaceBundle, {
              status: 200,
              headers: { "content-type": "application/x-javascript" },
            });
          }
          if (call.url.pathname === "/") {
            return new Response(facebookHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          if (call.url.pathname === "/marketplace/") {
            return new Response(facebookMarketplaceHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          expect(call.url.pathname).toBe("/api/graphql/");
          expect(call.method).toBe("POST");
          const form = new URLSearchParams(typeof call.body === "string" ? call.body : "");
          expect(form.get("fb_api_req_friendly_name"))
            .toBe("MarketplaceCometBrowseFeedLightPaginationQuery");
          expect(form.get("doc_id")).toBe("27448592924790037");
          expect(form.get("fb_dtsg")).toBe("fixture-dtsg-token");
          expect(form.get("lsd")).toBe("fixture-lsd-token");
          expect(form.get("__user")).toBe("24680");
          expect(form.get("av")).toBe("24680");
          expect(form.get("__req")).toBe("1");
          expect(JSON.parse(form.get("variables")!)).toMatchObject({
            cursor: "next",
            count: 5,
            includePDPRelevantListings: false,
            pdpListingId: "",
            refinement: null,
          });
          return new Response(facebookMarketplacePaginationText, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }),
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        feed: "marketplace",
        listings: [{ id: "333" }],
        continuation_supported: true,
        provider_has_next_page: true,
        truncated: false,
      },
      finalUrl: "https://www.facebook.com/marketplace/",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect((result.output as { next_cursor: unknown }).next_cursor)
      .toMatch(/^smn1\.[A-Za-z0-9_-]+$/u);
    expect(calls.map((call) => `${call.method} ${call.url.origin}${call.url.pathname}`))
      .toEqual([
        "GET https://www.facebook.com/",
        "GET https://www.facebook.com/marketplace/",
        "GET https://static.xx.fbcdn.net/rsrc.php/v4/test/bundle.js",
        "POST https://www.facebook.com/api/graphql/",
      ]);
    expect(callbacks).toBe(0);
  });

  test("keeps the final reviewed Marketplace page but suppresses its unusable successor", async () => {
    const calls: Call[] = [];
    const environment = stateEnvironment();
    const cursor = issueMarketplaceCursorWithHistory(environment, 47);
    const result = await executeMetaWebOperation(
      recipe("facebook-marketplace", "feeds.read"),
      { feed: "marketplace", cursor, limit: 50 },
      auth("facebook"),
      {
        environment,
        dependencies: dependencies("facebook", calls, (call) => {
          if (call.url.origin === "https://static.xx.fbcdn.net") {
            return new Response(facebookMarketplaceBundle, {
              status: 200,
              headers: { "content-type": "application/x-javascript" },
            });
          }
          if (call.url.pathname === "/") {
            return new Response(facebookHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          if (call.url.pathname === "/marketplace/") {
            return new Response(facebookMarketplaceHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          return new Response(facebookMarketplacePaginationText, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }),
      },
    );
    expect(result.output).toMatchObject({
      listings: [{ id: "333" }],
      provider_has_next_page: true,
      next_cursor: null,
      continuation_supported: false,
      complete: false,
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/marketplace/",
      "/rsrc.php/v4/test/bundle.js",
      "/api/graphql/",
    ]);
  });

  test("never retries an indeterminate Meta HTML request", async () => {
    const calls: Call[] = [];
    const environment = stateEnvironment();
    let marketplaceAttempts = 0;
    const message = await rejectionMessage(executeMetaWebOperation(
      recipe("facebook-marketplace", "feeds.read"),
      { feed: "marketplace", limit: 10 },
      auth("facebook"),
      {
        environment,
        dependencies: dependencies("facebook", calls, (call) => {
          if (call.url.pathname === "/") {
            return new Response(facebookHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          marketplaceAttempts += 1;
          throw new Error("simulated connection refusal");
        }),
      },
    ));
    expect(message).toContain(
      "failed before a reviewed response was received",
    );
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/marketplace/",
    ]);
    expect(marketplaceAttempts).toBe(1);
  });

  test("rejects forged or cross-auth Marketplace cursors before cookies or network", async () => {
    const environment = stateEnvironment();
    const valid = await issueMarketplaceCursor(environment);
    const envelope = Buffer.from(valid.slice("smn1.".length), "base64url");
    envelope[12] = (envelope[12] ?? 0) ^ 1;
    const tampered = `smn1.${envelope.toString("base64url")}`;

    for (const [candidate, candidateAuth] of [
      ["raw-provider-cursor", auth("facebook")],
      [tampered, auth("facebook")],
      [valid, { ...auth("facebook"), id: "facebook-other" }],
      [valid, { ...auth("facebook"), subject: "facebook:user:97531" }],
    ] as const) {
      const calls: Call[] = [];
      const acquisitions = { count: 0 };
      const message = await rejectionMessage(executeMetaWebOperation(
        recipe("facebook-marketplace", "feeds.read"),
        { feed: "marketplace", cursor: candidate, limit: 50 },
        candidateAuth,
        {
          environment,
          dependencies: dependencies(
            "facebook",
            calls,
            undefined,
            acquisitions,
          ),
        },
      ));
      expect(message).toMatch(/cursor token (?:is malformed|authentication failed)/u);
      expect(message).not.toContain(candidate);
      expect(acquisitions.count).toBe(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects an exhausted authenticated Marketplace cursor before cookies or network", async () => {
    const environment = stateEnvironment();
    const cursor = issueMarketplaceCursorWithHistory(environment, 48);
    const calls: Call[] = [];
    const acquisitions = { count: 0 };
    const message = await rejectionMessage(executeMetaWebOperation(
      recipe("facebook-marketplace", "feeds.read"),
      { feed: "marketplace", cursor, limit: 50 },
      auth("facebook"),
      {
        environment,
        dependencies: dependencies(
          "facebook",
          calls,
          undefined,
          acquisitions,
        ),
      },
    ));
    expect(message).toContain("reviewed chain bound");
    expect(acquisitions.count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("rejects zero route IDs before cookies or network", async () => {
    for (const [site, action, input] of [
      ["facebook-group", "feeds.read", { feed: "group", group_id: "0" }],
      ["facebook-marketplace", "listings.read", { listing_id: "0" }],
    ] as const) {
      const calls: Call[] = [];
      const acquisitions = { count: 0 };
      const message = await rejectionMessage(executeMetaWebOperation(
        recipe(site, action, 2),
        input,
        auth("facebook"),
        {
          dependencies: dependencies(
            "facebook",
            calls,
            undefined,
            acquisitions,
          ),
        },
      ));
      expect(message).toContain("nonzero");
      expect(acquisitions.count).toBe(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects every malformed observed input and bound subject before cookies or network", async () => {
    const { subject, ...missingFacebookSubject } = auth("facebook");
    void subject;
    const cases: readonly {
      readonly site: MetaWebSite;
      readonly action: WebSessionRecipe["action"];
      readonly input: Record<string, string | number | boolean>;
      readonly auth: WrenchAuth;
      readonly dependencySite: "instagram" | "threads" | "facebook";
    }[] = [
      {
        site: "facebook",
        action: "feeds.read",
        input: { feed: "wrong" },
        auth: auth("facebook"),
        dependencySite: "facebook",
      },
      {
        site: "facebook",
        action: "feeds.read",
        input: { feed: "home", extra: true },
        auth: auth("facebook"),
        dependencySite: "facebook",
      },
      {
        site: "facebook-group",
        action: "feeds.read",
        input: { feed: "group", group_id: "13579", cursor: "raw" },
        auth: auth("facebook"),
        dependencySite: "facebook",
      },
      {
        site: "facebook-group",
        action: "feeds.read",
        input: { feed: "wrong", group_id: "13579" },
        auth: auth("facebook"),
        dependencySite: "facebook",
      },
      {
        site: "facebook-group",
        action: "feeds.read",
        input: { feed: "group", group_id: "13579", limit: 0 },
        auth: auth("facebook"),
        dependencySite: "facebook",
      },
      {
        site: "facebook-marketplace",
        action: "feeds.read",
        input: { feed: "marketplace", limit: 0 },
        auth: auth("facebook"),
        dependencySite: "facebook",
      },
      {
        site: "facebook-marketplace",
        action: "listings.read",
        input: { listing_id: "222", extra: true },
        auth: auth("facebook"),
        dependencySite: "facebook",
      },
      {
        site: "instagram",
        action: "contacts.list",
        input: { contact_limit: 0, thread_limit: 20 },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "instagram",
        action: "contacts.list",
        input: { contact_limit: 50, thread_limit: 51 },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "instagram",
        action: "contacts.list",
        input: { contact_limit: 50, thread_limit: 20, cursor: "raw" },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "instagram",
        action: "media.read",
        input: { media_id: "not/a/media-id" },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "instagram",
        action: "feeds.read",
        input: { feed: "home", cursor: "raw" },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "instagram",
        action: "messaging.list",
        input: { folder: "requests" },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "instagram",
        action: "messaging.list",
        input: { folder: "inbox", cursor: "raw" },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "instagram",
        action: "comments.read",
        input: { media_id: "900_12345", cursor: "raw" },
        auth: auth("instagram"),
        dependencySite: "instagram",
      },
      {
        site: "threads",
        action: "feeds.read",
        input: { feed: "for-you", cursor: "raw" },
        auth: auth("threads"),
        dependencySite: "threads",
      },
      {
        site: "facebook",
        action: "feeds.read",
        input: { feed: "home" },
        auth: missingFacebookSubject,
        dependencySite: "facebook",
      },
      {
        site: "facebook",
        action: "feeds.read",
        input: { feed: "home" },
        auth: { ...auth("facebook"), subject: "instagram:24680" },
        dependencySite: "facebook",
      },
      {
        site: "facebook",
        action: "feeds.read",
        input: { feed: "home" },
        auth: { ...auth("facebook"), subject: "facebook:user:0" },
        dependencySite: "facebook",
      },
      {
        site: "instagram",
        action: "feeds.read",
        input: { feed: "home" },
        auth: { ...auth("instagram"), subject: "instagram:0" },
        dependencySite: "instagram",
      },
      {
        site: "threads",
        action: "feeds.read",
        input: { feed: "for-you" },
        auth: { ...auth("threads"), subject: "threads:000" },
        dependencySite: "threads",
      },
    ];

    for (const testCase of cases) {
      const calls: Call[] = [];
      const acquisitions = { count: 0 };
      const message = await rejectionMessage(executeMetaWebOperation(
        recipe(testCase.site, testCase.action),
        testCase.input,
        testCase.auth,
        {
          dependencies: dependencies(
            testCase.dependencySite,
            calls,
            undefined,
            acquisitions,
          ),
        },
      ));
      expect(message).not.toBe("");
      expect(acquisitions.count).toBe(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects missing or mismatched account cookies after acquisition but before network", async () => {
    for (const testCase of [
      {
        site: "instagram",
        input: { feed: "home" },
        auth: auth("instagram"),
        domain: "www.instagram.com",
        accountCookie: "ds_user_id",
        sessionCookie: "sessionid",
      },
      {
        site: "threads",
        input: { feed: "for-you" },
        auth: auth("threads"),
        domain: "www.threads.com",
        accountCookie: "ds_user_id",
        sessionCookie: "sessionid",
      },
      {
        site: "facebook",
        input: { feed: "home" },
        auth: auth("facebook"),
        domain: "www.facebook.com",
        accountCookie: "c_user",
        sessionCookie: "xs",
      },
    ] as const) {
      for (const accountCookies of [
        [
          strictCookie(
            testCase.domain,
            testCase.sessionCookie,
            "private",
          ),
        ],
        [
          strictCookie(
            testCase.domain,
            testCase.accountCookie,
            "97531",
          ),
          strictCookie(
            testCase.domain,
            testCase.sessionCookie,
            "private",
          ),
        ],
      ]) {
        const calls: Call[] = [];
        const acquisitions = { count: 0 };
        const message = await rejectionMessage(executeMetaWebOperation(
          recipe(testCase.site, "feeds.read"),
          testCase.input,
          testCase.auth,
          {
            dependencies: dependencies(
              testCase.site,
              calls,
              undefined,
              acquisitions,
              accountCookies,
            ),
          },
        ));
        expect(message).not.toBe("");
        expect(acquisitions.count).toBe(1);
        expect(calls).toHaveLength(0);
      }
    }
  });

  test("rejects Relay errors and ambiguous roots after exactly one POST", async () => {
    const environment = stateEnvironment();
    const cursor = await issueMarketplaceCursor(environment);
    const baseDocuments = facebookMarketplacePaginationText
      .split("\r\n")
      .map((value) => JSON.parse(value) as Record<string, unknown>);

    const erroredDocuments = structuredClone(baseDocuments);
    erroredDocuments[1] = {
      ...erroredDocuments[1],
      errors: [{ message: "private provider rejection" }],
    };
    const ambiguousDocuments = structuredClone(baseDocuments);
    ambiguousDocuments[0] = {
      ...ambiguousDocuments[0],
      decoy: {
        marketplace_home_feed: {
          edges: [],
        },
      },
    };

    for (const [documents, expected] of [
      [erroredDocuments, "provider errors"],
      [ambiguousDocuments, "outside its reviewed Relay data root"],
    ] as const) {
      const calls: Call[] = [];
      const message = await rejectionMessage(executeMetaWebOperation(
        recipe("facebook-marketplace", "feeds.read"),
        { feed: "marketplace", cursor, limit: 50 },
        auth("facebook"),
        {
          environment,
          dependencies: dependencies("facebook", calls, (call) => {
            if (call.url.origin === "https://static.xx.fbcdn.net") {
              return new Response(facebookMarketplaceBundle, {
                status: 200,
                headers: { "content-type": "application/x-javascript" },
              });
            }
            if (call.url.pathname === "/") {
              return new Response(facebookHtml, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            if (call.url.pathname === "/marketplace/") {
              return new Response(facebookMarketplaceHtml, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            return new Response(
              documents.map((value) => JSON.stringify(value)).join("\r\n"),
              {
                status: 200,
                headers: { "content-type": "text/html" },
              },
            );
          }),
        },
      ));
      expect(message).toContain(expected);
      expect(message).not.toContain("private provider rejection");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    }
  });

  test("rejects all unobserved Page, Group, Marketplace, message-send, and mutation operations before auth or dispatch", async () => {
    for (const [site, action] of [
      ["facebook-page", "feeds.read"],
      ["facebook-group", "posts.read"],
      ["facebook-marketplace", "media.read"],
      ["instagram", "messaging.send"],
      ["threads", "likes.set"],
      ["facebook", "contacts.list"],
      ["facebook", "messaging.list"],
      ["facebook", "posts.publish"],
    ] as const) {
      const calls: Call[] = [];
      const acquisitions = { count: 0 };
      let callbacks = 0;
      const message = await rejectionMessage(executeMetaWebOperation(
        recipe(site, action),
        {},
        auth(site === "instagram" ? "instagram" : site === "threads" ? "threads" : "facebook"),
        {
          beforeDispatch: () => {
            callbacks += 1;
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            callbacks += 1;
            return Promise.resolve();
          },
          dependencies: dependencies("facebook", calls, undefined, acquisitions),
        },
      ));
      expect(message).toContain("capture-required");
      expect(acquisitions.count).toBe(0);
      expect(calls).toHaveLength(0);
      expect(callbacks).toBe(0);
    }
  });

  test("rejects a stale Facebook v1 feed plan before auth, network, or callbacks", async () => {
    const calls: Call[] = [];
    const acquisitions = { count: 0 };
    let callbacks = 0;
    const message = await rejectionMessage(executeMetaWebOperation(
      recipe("facebook", "feeds.read", 1),
      { feed: "home", limit: 5 },
      auth("facebook"),
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        dependencies: dependencies("facebook", calls, undefined, acquisitions),
      },
    ));
    expect(message).toContain("contract version 1 is not installed");
    expect(acquisitions.count).toBe(0);
    expect(calls).toHaveLength(0);
    expect(callbacks).toBe(0);
  });

  test("rejects stale v1 Instagram and Threads first-page plans before auth or network", async () => {
    for (const [site, action, input, dependencySite] of [
      ["instagram", "feeds.read", { feed: "home", limit: 5 }, "instagram"],
      ["instagram", "comments.read", { media_id: "900_12345", limit: 5 }, "instagram"],
      ["instagram", "messaging.list", { folder: "inbox", limit: 5 }, "instagram"],
      ["threads", "feeds.read", { feed: "for-you", limit: 5 }, "threads"],
    ] as const) {
      const calls: Call[] = [];
      const acquisitions = { count: 0 };
      const message = await rejectionMessage(executeMetaWebOperation(
        recipe(site, action, 1),
        input,
        auth(site),
        {
          dependencies: dependencies(
            dependencySite,
            calls,
            undefined,
            acquisitions,
          ),
        },
      ));
      expect(message).toContain("contract version 1 is not installed");
      expect(acquisitions.count).toBe(0);
      expect(calls).toHaveLength(0);
    }
  });
});
