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
import { PreservedBrowserArtifactsError } from "../browser";
import { sealCursorToken } from "../cursor-token";
import { canonicalJson, sha256, type WebSessionRecipe } from "../model";
import {
  OperationDeadline,
  OperationDeadlineError,
} from "../operation-deadline";
import {
  InstagramProfileBrowserFailure,
  InstagramProfileBrowserResponseRejectedError,
  type InstagramProfileBrowserTransport,
} from "./instagram-web-profile-browser";
import {
  executeMetaWebOperation,
  instagramConfigureDispatchDecision,
  instagramVideoConfigureForm,
  instagramVideoConfigurePayload,
  instagramVideoConfigureRequestShape,
  instagramVideoRequestConfig,
  instagramVideoUploadId,
  instagramVideoUploadRequestShape,
  probeMetaWebSubject,
  readInstagramVideoAcceptedMutationTargetPresence,
  readThreadsWebPublishedMutationTarget,
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

const instagramRemovedHtml = [
  "<html><head><title>Page not found • Instagram</title></head><body>",
  "Sorry, this page isn't available.",
  "The link you followed may be broken, or the page may have been removed.",
  "Go back to Instagram.",
  "</body></html>",
].join("");

const instagramMutationHtml = `${instagramHtml}${script({
  require: [[
    "InstagramWebPushInfo",
    [],
    { rollout_hash: "rollout-fixture" },
    1,
  ]],
})}`;

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

function instagramVideoPost(
  postId: string,
  postCode: string,
  caption: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: postId,
    pk: postId.split("_", 1)[0],
    code: postCode,
    media_type: 2,
    taken_at: 1_786_923_725,
    caption: { text: caption },
    user: { pk: "12345", username: "viewer" },
    has_liked: false,
    has_viewer_saved: false,
    like_count: 0,
    comment_count: 0,
    ...overrides,
  });
}

function threadsImagePost(
  postId: string,
  postCode: string,
  text: string,
  options: {
    readonly candidateHeight?: number;
    readonly candidateWidth?: number;
    readonly height?: number;
    readonly includeImage?: boolean;
    readonly width?: number;
  } = {},
): Readonly<Record<string, unknown>> {
  const width = options.width ?? 959;
  const height = options.height ?? 1022;
  return Object.freeze({
    pk: postId,
    code: postCode,
    canonical_url: `https://www.threads.com/@viewer/post/${postCode}`,
    caption: { text },
    user: { pk: "12345", username: "viewer" },
    ...(options.includeImage === false
      ? {}
      : {
          media_type: 1,
          original_width: width,
          original_height: height,
          image_versions2: {
            candidates: [{
              width: options.candidateWidth ?? width,
              height: options.candidateHeight ?? height,
              url: "https://scontent.cdninstagram.com/threads-fixture.png",
            }],
          },
        }),
  });
}

function threadsVideoPost(
  postId: string,
  postCode: string,
  text: string,
  options: {
    readonly candidateHeight?: number;
    readonly candidateWidth?: number;
    readonly height?: number;
    readonly width?: number;
  } = {},
): Readonly<Record<string, unknown>> {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  return Object.freeze({
    pk: postId,
    code: postCode,
    canonical_url: `https://www.threads.com/@viewer/post/${postCode}`,
    caption: { text },
    user: { pk: "12345", username: "viewer" },
    media_type: 2,
    original_width: width,
    original_height: height,
    video_duration: 8,
    has_audio: true,
    video_versions: [{
      width: options.candidateWidth ?? width,
      height: options.candidateHeight ?? height,
      url: "https://scontent.cdninstagram.com/threads-fixture.mp4",
    }],
  });
}

function threadsCreateResponse(
  postId: string,
  postCode: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    media: Object.freeze({
      code: postCode,
      permalink: `https://www.threads.com/@viewer/post/${postCode}`,
      pk: postId,
    }),
    status: "ok",
  });
}

function threadsVideoCreateResponse(
  postId: string,
  postCode: string,
  text: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    media: Object.freeze({
      ...threadsVideoPost(postId, postCode, text),
      permalink: `https://www.threads.com/@viewer/post/${postCode}`,
    }),
    status: "ok",
  });
}

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

function isoBox(type: string, ...payloads: readonly Uint8Array[]): Buffer {
  const payloadBytes = payloads.reduce((total, payload) => total + payload.byteLength, 0);
  const bytes = Buffer.alloc(8 + payloadBytes);
  bytes.writeUInt32BE(bytes.byteLength, 0);
  bytes.write(type, 4, 4, "ascii");
  let offset = 8;
  for (const payload of payloads) {
    Buffer.from(payload).copy(bytes, offset);
    offset += payload.byteLength;
  }
  return bytes;
}

function mp4Fixture(width: number, height: number): Buffer {
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write("isom", 0, 4, "ascii");
  ftypPayload.writeUInt32BE(0x200, 4);
  ftypPayload.write("isomiso2", 8, 8, "ascii");
  const trackHeader = Buffer.alloc(84);
  trackHeader[0] = 0;
  trackHeader.writeUInt32BE(0x0001_0000, 40);
  trackHeader.writeUInt32BE(0x0001_0000, 56);
  trackHeader.writeUInt32BE(0x4000_0000, 72);
  trackHeader.writeUInt32BE(width * 65_536, 76);
  trackHeader.writeUInt32BE(height * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  return Buffer.concat([
    isoBox("ftyp", ftypPayload),
    isoBox(
      "moov",
      isoBox("trak", isoBox("tkhd", trackHeader), isoBox("mdia", isoBox("hdlr", handler))),
    ),
    isoBox("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
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

function threadsMutationCookies(): readonly StrictCookie[] {
  return [
    strictCookie("www.threads.com", "csrftoken", "csrf-fixture"),
    strictCookie("www.threads.com", "ds_user_id", "12345"),
    strictCookie("www.threads.com", "sessionid", "private"),
  ];
}

function recipe(
  site: MetaWebSite,
  action: WebSessionRecipe["action"],
  contractVersion = site === "instagram" && action === "media.publish"
    ? 3
    : (
      site === "instagram" && (
        action === "comments.read"
        || action === "content.delete"
        || action === "feeds.read"
        || action === "messaging.list"
      )
  ) || (
    site === "threads" && action === "feeds.read"
  ) || (
    site === "facebook" && (action === "feeds.read" || action === "messaging.list")
  ) || (
    (site === "facebook-group" || site === "facebook-marketplace")
    && action === "feeds.read"
  )
    ? 2
    : site === "threads" && action === "posts.publish"
      ? 5
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

async function executeThreadsCreateFixture(
  createResponse: () => Response,
): Promise<{
  readonly acceptedTargets: number;
  readonly calls: readonly Call[];
  readonly result: Awaited<ReturnType<typeof executeMetaWebOperation>>;
}> {
  const root = mkdtempSync(join(tmpdir(), "wrench-threads-create-response-"));
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
  let acceptedTargets = 0;
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
      afterProviderAcceptedMutationTarget: () => {
        acceptedTargets += 1;
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
            return new Response(JSON.stringify({ status: "ok", upload_id: uploadId }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (call.url.pathname === "/api/v1/media/configure_text_post_app_feed/") {
            return createResponse();
          }
          throw new Error(`unexpected Threads create fixture request ${call.method} ${call.url.pathname}`);
        }, undefined, threadsMutationCookies()),
        now: () => Number(uploadId),
      },
    },
  );
  return { acceptedTargets, calls, result };
}

async function executeThreadsVideoUploadFixture(
  uploadResponse: () => Response,
  observeRoot?: (call: Call, read: number) => void,
): Promise<{
  readonly beforeDispatch: number;
  readonly calls: readonly Call[];
  readonly creates: number;
  readonly result: Awaited<ReturnType<typeof executeMetaWebOperation>>;
  readonly rootReads: number;
}> {
  const root = mkdtempSync(join(tmpdir(), "wrench-threads-video-upload-response-"));
  chmodSync(root, 0o700);
  stateRoots.push(root);
  const videoPath = join(root, "fixture.mp4");
  writeFileSync(videoPath, mp4Fixture(640, 360), { mode: 0o600 });
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
  let rootReads = 0;
  const result = await executeMetaWebOperation(
    recipe("threads", "media.publish"),
    {
      audience: "default",
      body: "Wrench disposable Threads video fixture",
      media: { kind: "file", reference: "fixture" },
    },
    auth("threads"),
    {
      fileResolver: () => Promise.resolve([videoPath]),
      beforeDispatch: () => {
        beforeDispatch += 1;
        return Promise.resolve();
      },
      dependencies: {
        ...dependencies("threads", calls, (call) => {
          if (call.method === "GET" && call.url.pathname === "/") {
            rootReads += 1;
            observeRoot?.(call, rootReads);
            return new Response(bootstrap, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          if (call.url.pathname === `/rupload_igvideo/fb_uploader_${uploadId}`) {
            return uploadResponse();
          }
          if (call.url.pathname === "/api/v1/media/configure_text_post_app_feed/") {
            creates += 1;
            return new Response(JSON.stringify(threadsVideoCreateResponse(
              "987654322_12345",
              "VideoABC",
              "Wrench disposable Threads video fixture",
            )), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`unexpected Threads video upload fixture request ${call.method} ${call.url.pathname}`);
        }, undefined, threadsMutationCookies()),
        now: () => Number(uploadId),
      },
    },
  );
  return { beforeDispatch, calls, creates, result, rootReads };
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

describe("capture-neutral Instagram video request facts", () => {
  const uploadId = "1786923725481";
  const caption = "Synthetic Instagram protocol fixture";
  const csrfToken = "csrf-fixture";
  const requestConfig = Object.freeze({ rolloutHash: "rollout-fixture" });
  const upload = Object.freeze({
    byteLength: 400_123,
    durationMilliseconds: 7_321,
    height: 359,
    mediaType: "video/mp4" as const,
    width: 641,
  });

  test("parses exactly one bounded rollout hash from the established bootstrap module", () => {
    const html = script({
      require: [[
        "InstagramWebPushInfo",
        [],
        { rollout_hash: requestConfig.rolloutHash },
        1,
      ]],
    });
    const parsed = instagramVideoRequestConfig(html);
    expect(parsed).toEqual(requestConfig);
    expect(Object.isFrozen(parsed)).toBeTrue();

    expect(() => instagramVideoRequestConfig(`${html}${html}`))
      .toThrow("one exact InstagramWebPushInfo configuration");
    for (const value of ["", "contains space", "line\nbreak", "x".repeat(257)]) {
      expect(() => instagramVideoRequestConfig(script({
        require: [["InstagramWebPushInfo", [], { rollout_hash: value }, 1]],
      }))).toThrow("rollout hash is invalid");
    }
  });

  test("derives only one canonical 13-digit upload ID", () => {
    expect(instagramVideoUploadId(() => 1_786_923_725_481.9)).toBe(uploadId);
    for (const value of [
      999_999_999_999,
      10_000_000_000_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => instagramVideoUploadId(() => value))
        .toThrow("canonical 13-digit ID");
    }
  });

  test("constructs the exact upload route and header parameters without a body or response parser", () => {
    const request = instagramVideoUploadRequestShape(
      upload,
      uploadId,
      csrfToken,
      requestConfig,
    );
    expect(request).toEqual({
      url: `https://i.instagram.com/rupload_igvideo/fb_uploader_${uploadId}`,
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "video/mp4",
        origin: "https://www.instagram.com",
        referer: "https://www.instagram.com/",
        "x-asbd-id": "359341",
        "x-csrftoken": csrfToken,
        "x-entity-length": String(upload.byteLength),
        "x-entity-name": `fb_uploader_${uploadId}`,
        "x-ig-app-id": "936619743392459",
        "x-instagram-ajax": requestConfig.rolloutHash,
        "x-instagram-rupload-params": JSON.stringify({
          "client-passthrough": "1",
          is_clips_video: "1",
          for_album: false,
          is_sidecar: "0",
          media_type: 2,
          upload_id: uploadId,
          upload_media_duration_ms: upload.durationMilliseconds,
          upload_media_height: upload.height,
          upload_media_width: upload.width,
          video_format: upload.mediaType,
          video_transform: null,
        }),
        offset: "0",
      },
    });
    expect(Object.isFrozen(request)).toBeTrue();
    expect(Object.isFrozen(request.headers)).toBeTrue();
    expect(request).not.toHaveProperty("body");
    expect(request).not.toHaveProperty("expectedStatuses");
  });

  test("rejects every adjacent upload-request bound before constructing headers", () => {
    const invalid = [
      { ...upload, byteLength: 23 },
      { ...upload, byteLength: (128 * 1024 * 1024) + 1 },
      { ...upload, durationMilliseconds: 0 },
      { ...upload, durationMilliseconds: 86_400_001 },
      { ...upload, height: 0 },
      { ...upload, height: 20_001 },
      { ...upload, width: 0 },
      { ...upload, width: 20_001 },
      { ...upload, mediaType: "video/quicktime" },
    ];
    for (const value of invalid) {
      expect(() => instagramVideoUploadRequestShape(
        value as never,
        uploadId,
        csrfToken,
        requestConfig,
      )).toThrow("outside its reviewed bound");
    }
    expect(() => instagramVideoUploadRequestShape(
      upload,
      "178692372548",
      csrfToken,
      requestConfig,
    )).toThrow("outside its reviewed bound");
    expect(() => instagramVideoUploadRequestShape(
      upload,
      uploadId,
      "line\nbreak",
      requestConfig,
    )).toThrow("CSRF cookie is invalid");
  });

  test("constructs the exact configure payload, signed form, route, and headers", () => {
    const payload = instagramVideoConfigurePayload(caption, uploadId);
    expect(payload).toEqual({
      archive_only: false,
      caption,
      clips_share_preview_to_feed: "1",
      disable_comments: "0",
      disable_oa_reuse: false,
      igtv_share_preview_to_feed: 1,
      is_meta_only_post: "0",
      is_unified_video: 1,
      like_and_view_counts_disabled: "0",
      media_share_flow: "creation_flow",
      share_to_facebook: "",
      share_to_fb_destination_type: "USER",
      source_type: "library",
      upload_id: uploadId,
      video_subtitles_enabled: "0",
    });
    expect(Object.isFrozen(payload)).toBeTrue();

    const body = instagramVideoConfigureForm(caption, uploadId);
    const expectedBody = [
      "archive_only=false&caption=Synthetic+Instagram+protocol+fixture",
      "&clips_share_preview_to_feed=1&disable_comments=0&disable_oa_reuse=false",
      "&igtv_share_preview_to_feed=1&is_meta_only_post=0&is_unified_video=1",
      "&like_and_view_counts_disabled=0&media_share_flow=creation_flow",
      "&share_to_facebook=&share_to_fb_destination_type=USER&source_type=library",
      "&upload_id=1786923725481",
      "&video_subtitles_enabled=0&signed_body=SIGNATURE.%7B%22archive_only%22%3Afalse",
      "%2C%22caption%22%3A%22Synthetic+Instagram+protocol+fixture%22",
      "%2C%22clips_share_preview_to_feed%22%3A%221%22",
      "%2C%22disable_comments%22%3A%220%22%2C%22disable_oa_reuse%22%3Afalse",
      "%2C%22igtv_share_preview_to_feed%22%3A1%2C%22is_meta_only_post%22%3A%220%22",
      "%2C%22is_unified_video%22%3A1%2C%22like_and_view_counts_disabled%22%3A%220%22",
      "%2C%22media_share_flow%22%3A%22creation_flow%22",
      "%2C%22share_to_facebook%22%3A%22%22",
      "%2C%22share_to_fb_destination_type%22%3A%22USER%22",
      "%2C%22source_type%22%3A%22library%22",
      "%2C%22upload_id%22%3A%221786923725481%22",
      "%2C%22video_subtitles_enabled%22%3A%220%22%7D",
    ].join("");
    expect(body).toBe(expectedBody);
    const form = Object.fromEntries(new URLSearchParams(body));
    expect(form).toEqual({
      ...Object.fromEntries(
        Object.entries(payload).map(([name, value]) => [name, String(value)]),
      ),
      signed_body: `SIGNATURE.${JSON.stringify(payload)}`,
    });
    const request = instagramVideoConfigureRequestShape(
      caption,
      uploadId,
      csrfToken,
      requestConfig,
    );
    expect(request).toEqual({
      body: expectedBody,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        origin: "https://www.instagram.com",
        referer: "https://www.instagram.com/",
        "x-asbd-id": "359341",
        "x-csrftoken": csrfToken,
        "x-ig-app-id": "936619743392459",
        "x-instagram-ajax": requestConfig.rolloutHash,
      },
      method: "POST",
      url: "https://www.instagram.com/api/v1/media/configure_to_clips/",
    });
    expect(Object.isFrozen(request)).toBeTrue();
    expect(Object.isFrozen(request.headers)).toBeTrue();
  });

  test("keeps configure input bounds strict without interpreting provider responses", () => {
    for (const [selectedCaption, selectedUploadId] of [
      ["", uploadId],
      ["x".repeat(1_001), uploadId],
      ["line\rbreak", uploadId],
      [caption, "178692372548"],
    ] as const) {
      expect(() => instagramVideoConfigureForm(selectedCaption, selectedUploadId))
        .toThrow(/Instagram configure/u);
    }
  });

  test("classifies one configure response without authorizing a repeated POST", () => {
    const terminal = instagramConfigureDispatchDecision(200);
    expect(terminal).toEqual({ kind: "inspect-terminal-envelope" });
    expect(Object.isFrozen(terminal)).toBeTrue();
    const accepted = instagramConfigureDispatchDecision(202);
    expect(accepted).toEqual({ kind: "retain-indeterminate-dispatch" });
    expect(Object.isFrozen(accepted)).toBeTrue();
    for (const status of [199, 201, 500]) {
      expect(() => instagramConfigureDispatchDecision(status))
        .toThrow("unreviewed HTTP status");
    }
  });

  test("keeps exact publishing inert before resolving either plan-bound file", async () => {
    const calls: Call[] = [];
    const acquisitions = { count: 0 };
    let fileResolutions = 0;
    let dispatchCallbacks = 0;
    const message = await rejectionMessage(executeMetaWebOperation(
      recipe("instagram", "media.publish"),
      {
        audience: "default",
        caption,
        media: { kind: "file", reference: "confirmed-video" },
        thumbnail: { kind: "file", reference: "confirmed-thumbnail" },
      },
      auth("instagram"),
      {
        fileResolver: () => {
          fileResolutions += 1;
          return Promise.resolve([]);
        },
        beforeDispatch: () => {
          dispatchCallbacks += 1;
          return Promise.resolve();
        },
        dependencies: dependencies(
          "instagram",
          calls,
          undefined,
          acquisitions,
        ),
      },
    ));
    expect(message).toContain("capture-required");
    expect(acquisitions.count).toBe(0);
    expect(calls).toHaveLength(0);
    expect(fileResolutions).toBe(0);
    expect(dispatchCallbacks).toBe(0);
  });
});

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

  test("projects only an exact Threads signed-out session as auth repair", async () => {
    for (const [loggedOut, expectedCategory, expectedDisposition] of [
      [true, "auth-repair-required", "repair-auth"],
      ["true", "contract-drift", "do-not-retry"],
    ] as const) {
      const calls: Call[] = [];
      const result = await executeMetaWebOperation(
        recipe("threads", "profiles.read"),
        { profile: "viewer" },
        auth("threads"),
        {
          dependencies: dependencies("threads", calls, (call) => {
            if (call.url.pathname === "/") {
              return new Response(script({
                require: [[
                  "BarcelonaSessionInfo",
                  [],
                  { is_th_session: true, is_logged_out: loggedOut },
                  1,
                ]],
              }), {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            throw new Error(`unexpected Threads signed-out request ${call.url.href}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        readFailure: {
          category: expectedCategory,
          retryDisposition: expectedDisposition,
        },
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      expect(calls.map((call) => call.url.pathname)).toEqual(["/"]);
    }
  });

  test("reads exact self-profile metrics without entering the dispatch ledger", async () => {
    const observedAt = Date.UTC(2026, 7, 21, 15, 0, 0);
    const instagramCalls: Call[] = [];
    const instagramBrowserCalls: string[] = [];
    let instagramDispatches = 0;
    const instagramTransport: InstagramProfileBrowserTransport = {
      readCurrentViewerHtml: () => {
        instagramBrowserCalls.push("viewer");
        return Promise.resolve(instagramHtml);
      },
      readProfileJson: (profile) => {
        instagramBrowserCalls.push(`profile:${profile}`);
        return Promise.resolve({
          status: "ok",
          data: {
            user: {
              id: "12345",
              username: "viewer",
              edge_followed_by: { count: 101 },
              edge_follow: { count: 20 },
              edge_owner_to_timeline_media: { count: 7 },
            },
          },
        });
      },
      close: () => {
        instagramBrowserCalls.push("close");
        return Promise.resolve();
      },
    };
    const instagram = await executeMetaWebOperation(
      recipe("instagram", "profiles.read"),
      { profile: "viewer" },
      auth("instagram"),
      {
        beforeDispatch: () => {
          instagramDispatches += 1;
          return Promise.resolve();
        },
        dependencies: {
          ...dependencies("instagram", instagramCalls, () => {
            throw new Error("Instagram browser-contained profile read used direct network access");
          }),
          createInstagramProfileBrowserTransport: (selectedAuth, browserOptions) => {
            expect(selectedAuth).toEqual(auth("instagram"));
            expect(browserOptions).toMatchObject({
              timeoutMs: 1_000,
              maxOutputBytes: 12 * 1024 * 1024,
            });
            return Promise.resolve(instagramTransport);
          },
          now: () => observedAt,
        },
      },
    );
    expect(instagram).toMatchObject({
      status: "succeeded",
      finalUrl: "https://www.instagram.com/viewer/",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      output: {
        schemaVersion: 1,
        provider: "instagram",
        target: { kind: "profile", id: "12345" },
        observedAt: "2026-08-21T15:00:00.000Z",
        completeness: "complete",
        metrics: {
          followers: { status: "available", value: 101, precision: "exact" },
          following: { status: "available", value: 20, precision: "exact" },
          posts: { status: "available", value: 7, precision: "exact" },
        },
      },
    });
    expect(instagramBrowserCalls).toEqual(["viewer", "profile:viewer", "close"]);
    expect(instagramCalls).toHaveLength(0);
    expect(instagramDispatches).toBe(0);

    const threadsCalls: Call[] = [];
    let threadsDispatches = 0;
    const profileHtml = threadsHtml + script({
      profile: {
        pk: "12345",
        username: "viewer",
        follower_count: 99,
      },
    });
    const threads = await executeMetaWebOperation(
      recipe("threads", "profiles.read"),
      { profile: "viewer" },
      auth("threads"),
      {
        beforeDispatch: () => {
          threadsDispatches += 1;
          return Promise.resolve();
        },
        dependencies: {
          ...dependencies("threads", threadsCalls, (call) => {
            if (call.url.pathname === "/") {
              return new Response(threadsHtml, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            if (call.url.pathname === "/@viewer") {
              return new Response(profileHtml, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            if (call.url.pathname === "/insights") {
              return new Response(
                "<main>Insights await Check back in once you've reached 100 followers to see your insights.</main>",
                { status: 200, headers: { "content-type": "text/html" } },
              );
            }
            throw new Error(`unexpected Threads profile request ${call.url.href}`);
          }),
          now: () => observedAt,
        },
      },
    );
    expect(threads).toMatchObject({
      status: "succeeded",
      finalUrl: "https://www.threads.com/@viewer",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      output: {
        schemaVersion: 1,
        provider: "threads",
        target: { kind: "profile", id: "12345" },
        observedAt: "2026-08-21T15:00:00.000Z",
        completeness: "partial",
        metrics: {
          followers: { status: "available", value: 99, precision: "exact" },
          recentViews: { status: "unavailable", reason: "not-authorized" },
        },
      },
    });
    expect(threadsCalls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/@viewer",
      "/insights",
    ]);
    expect(threadsDispatches).toBe(0);

    const supplementalFailureCalls: Call[] = [];
    const threadsWithUnavailableInsights = await executeMetaWebOperation(
      recipe("threads", "profiles.read"),
      { profile: "viewer" },
      auth("threads"),
      {
        dependencies: {
          ...dependencies("threads", supplementalFailureCalls, (call) => {
            if (call.url.pathname === "/") {
              return new Response(threadsHtml, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            if (call.url.pathname === "/@viewer") {
              return new Response(profileHtml, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            if (call.url.pathname === "/insights") {
              return new Response("temporarily unavailable", {
                status: 503,
                headers: { "content-type": "text/html" },
              });
            }
            throw new Error(`unexpected Threads profile request ${call.url.href}`);
          }),
          now: () => observedAt,
        },
      },
    );
    expect(threadsWithUnavailableInsights).toMatchObject({
      status: "succeeded",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      output: {
        completeness: "partial",
        metrics: {
          followers: { status: "available", value: 99, precision: "exact" },
          recentViews: { status: "unavailable", reason: "not-authorized" },
        },
      },
    });
    expect(supplementalFailureCalls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/@viewer",
      "/insights",
    ]);

    for (const failure of ["cancelled", "timed-out"] as const) {
      const deadlineCalls: Call[] = [];
      let now = 0;
      const controller = new AbortController();
      const operationDeadline = new OperationDeadline(100, failure === "cancelled"
        ? { signal: controller.signal }
        : {
            clock: {
              now: () => now,
              schedule: () => () => undefined,
            },
          });
      try {
        const result = await executeMetaWebOperation(
          recipe("threads", "profiles.read"),
          { profile: "viewer" },
          auth("threads"),
          {
            operationDeadline,
            dependencies: {
              ...dependencies("threads", deadlineCalls, (call) => {
                if (call.url.pathname === "/") {
                  return new Response(threadsHtml, {
                    status: 200,
                    headers: { "content-type": "text/html" },
                  });
                }
                if (call.url.pathname === "/@viewer") {
                  return new Response(profileHtml, {
                    status: 200,
                    headers: { "content-type": "text/html" },
                  });
                }
                if (call.url.pathname === "/insights") {
                  if (failure === "cancelled") controller.abort();
                  else now = 100;
                  return new Response("private deadline response", {
                    status: 503,
                    headers: { "content-type": "text/html" },
                  });
                }
                throw new Error(`unexpected Threads deadline request ${call.url.href}`);
              }),
              now: () => observedAt,
            },
          },
        );
        expect(result).toMatchObject({
          status: "failed",
          output: null,
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
          readFailure: failure === "timed-out"
            ? {
                category: "operation-timeout",
                retryDisposition: "retry-once-after-60s",
              }
            : {
                category: "contract-drift",
                retryDisposition: "do-not-retry",
              },
        });
        expect(JSON.stringify(result)).not.toContain("private deadline response");
        expect(deadlineCalls.map((call) => call.url.pathname)).toEqual([
          "/",
          "/@viewer",
          "/insights",
        ]);
      } finally {
        operationDeadline.dispose();
      }
    }
  });

  test("projects target-stage Meta viewer-binding changes as account mismatch", async () => {
    const instagramCalls: Call[] = [];
    const instagramBrowserCalls: string[] = [];
    const instagramTransport: InstagramProfileBrowserTransport = {
      readCurrentViewerHtml: () => {
        instagramBrowserCalls.push("viewer");
        return Promise.resolve(instagramHtml);
      },
      readProfileJson: (profile) => {
        instagramBrowserCalls.push(`profile:${profile}`);
        return Promise.resolve({
          status: "ok",
          data: {
            user: {
              id: "99999",
              username: "viewer",
              edge_followed_by: { count: 101 },
              edge_follow: { count: 20 },
              edge_owner_to_timeline_media: { count: 7 },
            },
          },
        });
      },
      close: () => {
        instagramBrowserCalls.push("close");
        return Promise.resolve();
      },
    };
    const instagram = await executeMetaWebOperation(
      recipe("instagram", "profiles.read"),
      { profile: "viewer" },
      auth("instagram"),
      {
        dependencies: {
          ...dependencies("instagram", instagramCalls, () => {
            throw new Error("Instagram account binding used direct network access");
          }),
          createInstagramProfileBrowserTransport: () => Promise.resolve(
            instagramTransport,
          ),
        },
      },
    );
    expect(instagram).toMatchObject({
      status: "failed",
      readFailure: {
        category: "account-mismatch",
        retryDisposition: "do-not-retry",
      },
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(instagramBrowserCalls).toEqual(["viewer", "profile:viewer", "close"]);
    expect(instagramCalls).toHaveLength(0);

    const threadsCalls: Call[] = [];
    const threads = await executeMetaWebOperation(
      recipe("threads", "profiles.read"),
      { profile: "viewer" },
      auth("threads"),
      {
        dependencies: dependencies("threads", threadsCalls, (call) => {
          if (call.url.pathname === "/") {
            return new Response(threadsHtml, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          if (call.url.pathname === "/@viewer") {
            return new Response(threadsHtml + script({
              profile: {
                pk: "99999",
                username: "viewer",
                follower_count: 99,
              },
            }), {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          if (call.url.pathname === "/insights") {
            return new Response("<main></main>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          throw new Error(`unexpected Threads profile request ${call.url.href}`);
        }),
      },
    );
    expect(threads).toMatchObject({
      status: "failed",
      readFailure: {
        category: "account-mismatch",
        retryDisposition: "do-not-retry",
      },
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(threadsCalls.map((call) => call.url.pathname)).toEqual([
      "/",
      "/@viewer",
      "/insights",
    ]);
  });

  test("projects typed Instagram browser failures without direct access or retry", async () => {
    const cases = [
      {
        failure: new InstagramProfileBrowserResponseRejectedError(401, "text/html"),
        category: "auth-repair-required",
        retryDisposition: "repair-auth",
        stage: "viewer",
      },
      {
        failure: new InstagramProfileBrowserResponseRejectedError(403, "text/html"),
        category: "auth-repair-required",
        retryDisposition: "repair-auth",
        stage: "viewer",
      },
      {
        failure: new InstagramProfileBrowserResponseRejectedError(429, "text/html"),
        category: "provider-throttled",
        retryDisposition: "retry-once-after-60s",
        stage: "viewer",
      },
      {
        failure: new InstagramProfileBrowserResponseRejectedError(503, "text/html"),
        category: "provider-temporary",
        retryDisposition: "retry-once-after-60s",
        stage: "profile",
      },
      {
        failure: new InstagramProfileBrowserFailure(
          "provider-fetch",
          "private Instagram browser fetch detail",
        ),
        category: "provider-temporary",
        retryDisposition: "retry-once-after-60s",
        stage: "profile",
      },
      {
        failure: new InstagramProfileBrowserFailure(
          "authwall",
          "private Instagram browser authwall detail",
        ),
        category: "auth-repair-required",
        retryDisposition: "repair-auth",
        stage: "viewer",
      },
      {
        failure: new InstagramProfileBrowserFailure(
          "profile-json",
          "private Instagram browser response-shape detail",
        ),
        category: "contract-drift",
        retryDisposition: "do-not-retry",
        stage: "profile",
      },
      {
        failure: new OperationDeadlineError(
          "Instagram profile fixture",
          "timed-out",
        ),
        category: "operation-timeout",
        retryDisposition: "retry-once-after-60s",
        stage: "viewer",
      },
    ] as const;

    for (const item of cases) {
      const directCalls: Call[] = [];
      const browserCalls: string[] = [];
      let transportCreations = 0;
      let dispatches = 0;
      const transport: InstagramProfileBrowserTransport = {
        readCurrentViewerHtml: () => {
          browserCalls.push("viewer");
          return item.stage === "viewer"
            ? Promise.reject(item.failure)
            : Promise.resolve(instagramHtml);
        },
        readProfileJson: (profile) => {
          browserCalls.push(`profile:${profile}`);
          return Promise.reject(item.failure);
        },
        close: () => {
          browserCalls.push("close");
          return Promise.resolve();
        },
      };
      const result = await executeMetaWebOperation(
        recipe("instagram", "profiles.read"),
        { profile: "viewer" },
        auth("instagram"),
        {
          beforeDispatch: () => {
            dispatches += 1;
            return Promise.resolve();
          },
          dependencies: {
            ...dependencies("instagram", directCalls, () => {
              throw new Error("typed Instagram browser failure used direct network access");
            }),
            createInstagramProfileBrowserTransport: () => {
              transportCreations += 1;
              return Promise.resolve(transport);
            },
          },
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        output: null,
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
        readFailure: {
          category: item.category,
          retryDisposition: item.retryDisposition,
        },
      });
      expect(browserCalls).toEqual(item.stage === "viewer"
        ? ["viewer", "close"]
        : ["viewer", "profile:viewer", "close"]);
      expect(transportCreations).toBe(1);
      expect(directCalls).toHaveLength(0);
      expect(dispatches).toBe(0);
      expect(JSON.stringify(result)).not.toContain(item.failure.message);
    }
  });

  test("tracks Instagram browser cleanup and preserves finalization failures", async () => {
    const directCalls: Call[] = [];
    const browserCalls: string[] = [];
    const cleanupBarriers: Promise<void>[] = [];
    const cleanupPublisher = (_resource: unknown) => undefined;
    const failure = new PreservedBrowserArtifactsError(
      "private Instagram browser close detail",
      "private-instagram-recovery-handle",
      new Error("private Instagram cleanup cause"),
    );
    const transport: InstagramProfileBrowserTransport = {
      readCurrentViewerHtml: () => {
        browserCalls.push("viewer");
        return Promise.resolve(instagramHtml);
      },
      readProfileJson: (profile) => {
        browserCalls.push(`profile:${profile}`);
        return Promise.resolve({
          status: "ok",
          data: {
            user: {
              id: "12345",
              username: "viewer",
              edge_followed_by: { count: 101 },
              edge_follow: { count: 20 },
              edge_owner_to_timeline_media: { count: 7 },
            },
          },
        });
      },
      close: () => {
        browserCalls.push("close");
        return Promise.reject(failure);
      },
    };
    const action = executeMetaWebOperation(
      recipe("instagram", "profiles.read"),
      { profile: "viewer" },
      auth("instagram"),
      {
        dependencies: {
          ...dependencies("instagram", directCalls, () => {
            throw new Error("Instagram cleanup path used direct network access");
          }),
          createInstagramProfileBrowserTransport: (_selectedAuth, options) => {
            expect(options.publishCleanupResource).toBe(cleanupPublisher);
            return Promise.resolve(transport);
          },
        },
        registerCleanupBarrier: (barrier) => {
          cleanupBarriers.push(barrier);
          return cleanupPublisher;
        },
      },
    );
    expect(cleanupBarriers).toHaveLength(1);
    const operationOutcome = action.then(
      () => null,
      (error: unknown) => error,
    );
    const cleanupOutcome = cleanupBarriers[0]!.then(
      () => null,
      (error: unknown) => error,
    );

    expect(await operationOutcome).toBe(failure);
    expect(await cleanupOutcome).toBe(failure);
    expect(browserCalls).toEqual(["viewer", "profile:viewer", "close"]);
    expect(directCalls).toHaveLength(0);
  });

  test("uploads one plan-bound Threads PNG, rebinds fresh config, and verifies the exact permalink readback", async () => {
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
    const postUploadBootstrap = threadsHtml + script({
      require: [
        ["SprinkleConfig", [], {
          param_name: "jazoest",
          version: 3,
          should_randomize: false,
        }, 1],
        ["WebBloksVersioningID", [], {
          versioningID: "b".repeat(64),
        }, 2],
      ],
    });
    const published = threadsImagePost(postId, postCode, text);
    const readback = threadsHtml + script({ post: published });
    const acceptedTargetIdentifier = canonicalJson({
      code: postCode,
      height: 1022,
      id: postId,
      mediaType: 1,
      remoteMediaId: postId,
      url: `https://www.threads.com/@viewer/post/${postCode}`,
      width: 959,
    });
    const calls: Call[] = [];
    const events: string[] = [];
    let rootReads = 0;
    const network = dependencies(
      "threads",
      calls,
      (call) => {
        events.push(`${call.method} ${call.url.pathname}`);
        if (call.method === "GET" && call.url.pathname === "/") {
          rootReads += 1;
          return new Response(rootReads === 1 ? bootstrap : postUploadBootstrap, {
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
          expect(call.headers.get("x-bloks-version-id")).toBe("b".repeat(64));
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
            jazoest: "31250",
          });
          return new Response(JSON.stringify(threadsCreateResponse(postId, postCode)), {
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
      threadsMutationCookies(),
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
        afterProviderAcceptedMutationTarget: (event) => {
          events.push(`accepted ${event.target.identifier}`);
          expect(event).toEqual({
            id: "posts.publish",
            index: 1,
            target: { schemaVersion: 1, identifier: acceptedTargetIdentifier },
          });
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
        post: {
          id: postId,
          caption: text,
          user: { id: "12345" },
          image: { height: 1022, mediaId: postId, mediaType: 1, width: 959 },
        },
        attachment: {
          height: 1022,
          mediaType: "image/png",
          remoteMediaId: postId,
          verifiedBy: "permalink-readback",
          width: 959,
        },
      },
      finalUrl: `https://www.threads.com/@viewer/post/${postCode}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(events).toEqual([
      "GET /",
      `POST /rupload_igphoto/fb_uploader_${uploadId}`,
      "GET /",
      "before 0",
      "POST /api/v1/media/configure_text_post_app_feed/",
      `accepted ${acceptedTargetIdentifier}`,
      `GET /@viewer/post/${postCode}`,
      "after 1",
    ]);
  });

  test("publishes one text-only Threads post without rupload and verifies permalink readback", async () => {
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
    const published = threadsImagePost(postId, postCode, text, { includeImage: false });
    const readback = threadsHtml + script({ post: published });
    const acceptedTargetIdentifier = canonicalJson({
      code: postCode,
      id: postId,
      url: `https://www.threads.com/@viewer/post/${postCode}`,
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
        if (call.url.pathname.startsWith("/rupload_igphoto/")) {
          throw new Error("text-only Threads publish must not rupload");
        }
        if (call.url.pathname === "/api/v1/media/configure_text_post_app_feed/") {
          expect(call.headers.get("x-csrftoken")).toBe("csrf-fixture");
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
          return new Response(JSON.stringify(threadsCreateResponse(postId, postCode)), {
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
      threadsMutationCookies(),
    );
    const result = await executeMetaWebOperation(
      recipe("threads", "posts.publish"),
      {
        audience: "default",
        body: text,
      },
      auth("threads"),
      {
        beforeDispatch: (event) => {
          events.push(`before ${event.progress.started}`);
          return Promise.resolve();
        },
        afterProviderAcceptedMutationTarget: (event) => {
          events.push(`accepted ${event.target.identifier}`);
          expect(event).toEqual({
            id: "posts.publish",
            index: 1,
            target: { schemaVersion: 1, identifier: acceptedTargetIdentifier },
          });
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
        post: {
          id: postId,
          caption: text,
          user: { id: "12345" },
          image: null,
        },
      },
      finalUrl: `https://www.threads.com/@viewer/post/${postCode}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(result.output).not.toHaveProperty("attachment");
    expect(events).toEqual([
      "GET /",
      "GET /",
      "before 0",
      "POST /api/v1/media/configure_text_post_app_feed/",
      `accepted ${acceptedTargetIdentifier}`,
      `GET /@viewer/post/${postCode}`,
      "after 1",
    ]);
  });

  test("uploads one plan-bound Threads MP4, dispatches once, and verifies the exact permalink readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-threads-video-"));
    chmodSync(root, 0o700);
    stateRoots.push(root);
    const videoPath = join(root, "fixture.mp4");
    const videoBytes = mp4Fixture(640, 360);
    writeFileSync(videoPath, videoBytes, { mode: 0o600 });
    const uploadId = "1786923725481";
    const postId = "987654322_12345";
    const postCode = "VideoABC";
    const text = "Wrench disposable Threads video fixture";
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
      post: threadsVideoPost(postId, postCode, text),
    });
    const acceptedTargetIdentifier = canonicalJson({
      code: postCode,
      height: 360,
      id: postId,
      mediaType: 2,
      remoteMediaId: postId,
      url: `https://www.threads.com/@viewer/post/${postCode}`,
      width: 640,
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
        if (call.url.pathname === `/rupload_igvideo/fb_uploader_${uploadId}`) {
          expect(call.body).toBeInstanceOf(Uint8Array);
          expect((call.body as Uint8Array).byteLength).toBe(videoBytes.byteLength);
          expect(call.headers.get("content-type")).toBe("video/mp4");
          expect(call.headers.get("x-entity-length")).toBe(String(videoBytes.byteLength));
          expect(call.headers.get("x-entity-type")).toBe("video/mp4");
          expect(call.headers.get("x-instagram-rupload-params")).toBe(JSON.stringify({
            extract_cover_frame: "1",
            is_sidecar: "0",
            is_threads: "1",
            media_type: 2,
            upload_id: uploadId,
            upload_media_height: 360,
            upload_media_width: 640,
          }));
          return new Response(JSON.stringify({ status: "ok", upload_id: uploadId }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (call.url.pathname === "/api/v1/media/configure_text_post_app_feed/") {
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
          return new Response(JSON.stringify(threadsVideoCreateResponse(postId, postCode, text)), {
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
        throw new Error(`unexpected Threads video test request ${call.method} ${call.url.pathname}`);
      },
      undefined,
      threadsMutationCookies(),
    );
    const result = await executeMetaWebOperation(
      recipe("threads", "media.publish"),
      {
        audience: "default",
        body: text,
        media: { kind: "file", reference: "fixture" },
      },
      auth("threads"),
      {
        fileResolver: () => Promise.resolve([videoPath]),
        beforeDispatch: (event) => {
          events.push(`before ${event.progress.started}`);
          return Promise.resolve();
        },
        afterProviderAcceptedMutationTarget: (event) => {
          events.push(`accepted ${event.target.identifier}`);
          expect(event).toEqual({
            id: "media.publish",
            index: 1,
            target: { schemaVersion: 1, identifier: acceptedTargetIdentifier },
          });
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
        post: {
          id: postId,
          caption: text,
          user: { id: "12345" },
          video: {
            durationSeconds: 8,
            hasAudio: true,
            height: 360,
            mediaId: postId,
            mediaType: 2,
            width: 640,
          },
        },
        media: {
          durationSeconds: 8,
          hasAudio: true,
          height: 360,
          mediaType: "video/mp4",
          remoteMediaId: postId,
          verifiedBy: "permalink-readback",
          width: 640,
        },
      },
      finalUrl: `https://www.threads.com/@viewer/post/${postCode}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(events).toEqual([
      "GET /",
      `POST /rupload_igvideo/fb_uploader_${uploadId}`,
      "GET /",
      "before 0",
      "POST /api/v1/media/configure_text_post_app_feed/",
      `accepted ${acceptedTargetIdentifier}`,
      `GET /@viewer/post/${postCode}`,
      "after 1",
    ]);
  });

  test("rejects every unbound Threads video upload acknowledgement before dispatch", async () => {
    const uploadId = "1786923725481";
    const cases = [
      ["provider failure status", () => new Response(JSON.stringify({
        status: "fail",
        upload_id: uploadId,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })],
      ["wrong upload ID", () => new Response(JSON.stringify({
        status: "ok",
        upload_id: "1786923725482",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })],
      ["malformed JSON", () => new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      })],
      ["wrong content type", () => new Response(JSON.stringify({
        status: "ok",
        upload_id: uploadId,
      }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })],
    ] as const;
    for (const [label, response] of cases) {
      const fixture = await executeThreadsVideoUploadFixture(response);
      expect(fixture.result, label).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: "Threads video upload failed before post submission; retry with a fresh confirmed plan",
      });
      expect(fixture.beforeDispatch, label).toBe(0);
      expect(fixture.creates, label).toBe(0);
      expect(fixture.rootReads, label).toBe(1);
      expect(fixture.calls.map((call) => `${call.method} ${call.url.pathname}`), label).toEqual([
        "GET /",
        `POST /rupload_igvideo/fb_uploader_${uploadId}`,
      ]);
    }
  });

  test("re-probes Threads after video upload and rejects Set-Cookie account drift before dispatch", async () => {
    const uploadId = "1786923725481";
    const fixture = await executeThreadsVideoUploadFixture(
      () => new Response(JSON.stringify({ status: "ok", upload_id: uploadId }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "ds_user_id=99999; Path=/; Secure; HttpOnly; SameSite=Lax",
        },
      }),
      (call, read) => {
        if (read !== 2) return;
        expect(call.headers.get("cookie")).toContain("ds_user_id=99999");
        expect(call.headers.get("cookie")).not.toContain("ds_user_id=12345");
      },
    );
    expect(fixture.result).toMatchObject({
      status: "failed",
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
      error: "Threads video upload failed before post submission; retry with a fresh confirmed plan",
    });
    expect(fixture.beforeDispatch).toBe(0);
    expect(fixture.creates).toBe(0);
    expect(fixture.rootReads).toBe(2);
    expect(fixture.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /",
      `POST /rupload_igvideo/fb_uploader_${uploadId}`,
      "GET /",
    ]);
  });

  test("keeps a rejected Threads upload before the durable post-dispatch boundary", async () => {
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
    for (const outcome of ["transport", 201, 202] as const) {
      const calls: Call[] = [];
      let beforeDispatch = 0;
      let creates = 0;
      let acceptedTargets = 0;
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
          afterProviderAcceptedMutationTarget: () => {
            acceptedTargets += 1;
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
                if (outcome === "transport") {
                  throw new Error("fixture upload transport failed before a response");
                }
                return new Response(JSON.stringify({ status: "ok", upload_id: uploadId }), {
                  status: outcome,
                  headers: { "content-type": "application/json" },
                });
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
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: "Threads image upload failed before post submission; retry with a fresh confirmed plan",
      });
      expect(beforeDispatch).toBe(0);
      expect(creates).toBe(0);
      expect(acceptedTargets).toBe(0);
      expect(calls.filter((call) => call.url.pathname.includes("/rupload_igphoto/"))).toHaveLength(1);
    }
  });

  test("categorizes Threads create transport, status, content-type, and JSON failures without leaking details", async () => {
    const postId = "987654321_12345";
    const postCode = "CodeABC";
    const cases = [
      ["transport", () => {
        throw new Error("private-transport-sentinel");
      }],
      ["status", () => new Response(JSON.stringify(threadsCreateResponse(postId, postCode)), {
        status: 201,
        headers: { "content-type": "application/json" },
      })],
      ["content-type", () => new Response(JSON.stringify(threadsCreateResponse(postId, postCode)), {
        status: 200,
        headers: { "content-type": "text/html" },
      })],
      ["json", () => new Response("{private-json-sentinel", {
        status: 200,
        headers: { "content-type": "application/json" },
      })],
    ] as const;
    for (const [category, createResponse] of cases) {
      const { acceptedTargets, calls, result } = await executeThreadsCreateFixture(createResponse);
      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
      });
      expect(result.error).toContain(`failure stage: post create response (${category})`);
      expect(result.error).not.toContain("private");
      expect(calls.filter((call) =>
        call.url.pathname === "/api/v1/media/configure_text_post_app_feed/"
      )).toHaveLength(1);
      expect(acceptedTargets).toBe(0);
    }
  });

  test("categorizes every strict Threads create locator binding guard", async () => {
    const postId = "987654321_12345";
    const postCode = "CodeABC";
    const locator = threadsCreateResponse(postId, postCode) as {
      readonly media: Readonly<Record<string, unknown>>;
      readonly status: string;
    };
    const cases = [
      ["success-shape", {
        ...locator,
        media: { ...locator.media, privateDiagnostic: "private-shape-sentinel" },
      }],
      ["identifiers", {
        ...locator,
        media: { ...locator.media, code: "invalid code" },
      }],
      ["permalink", {
        ...locator,
        media: { ...locator.media, permalink: `https://example.com/@viewer/post/${postCode}` },
      }],
      ["actor", {
        ...locator,
        media: { ...locator.media, pk: "987654321_99999" },
      }],
    ] as const;
    for (const [category, response] of cases) {
      const { acceptedTargets, result } = await executeThreadsCreateFixture(() =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
      });
      expect(result.error).toContain(`failure stage: post create response (${category})`);
      expect(result.error).not.toContain("private");
      expect(acceptedTargets).toBe(0);
    }
  });

  test("retains the exact Threads locator when permalink media readback fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-threads-readback-media-"));
    chmodSync(root, 0o700);
    stateRoots.push(root);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, pngFixture(959, 1022), { mode: 0o600 });
    const uploadId = "1786923725481";
    const postId = "987654321_12345";
    const postCode = "CodeABC";
    const text = "how your email finds me";
    const withoutImage = threadsImagePost(postId, postCode, text, { includeImage: false });
    const acceptedTargetIdentifier = canonicalJson({
      code: postCode,
      height: 1022,
      id: postId,
      mediaType: 1,
      remoteMediaId: postId,
      url: `https://www.threads.com/@viewer/post/${postCode}`,
      width: 959,
    });
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
    const events: string[] = [];
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
        afterProviderAcceptedMutationTarget: (event) => {
          events.push(`accepted ${event.target.identifier}`);
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
              return new Response(JSON.stringify({ status: "ok", upload_id: uploadId }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (call.url.pathname === "/api/v1/media/configure_text_post_app_feed/") {
              return new Response(JSON.stringify(threadsCreateResponse(postId, postCode)), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (call.url.pathname === `/@viewer/post/${postCode}`) {
              return new Response(`${threadsHtml}${script({ post: withoutImage })}`, {
                status: 200,
                headers: { "content-type": "text/html" },
              });
            }
            throw new Error(`unexpected Threads test request ${call.method} ${call.url.pathname}`);
          }, undefined, threadsMutationCookies()),
          now: () => Number(uploadId),
        },
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      output: null,
      finalUrl: `https://www.threads.com/@viewer/post/${postCode}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(events).toEqual([`accepted ${acceptedTargetIdentifier}`]);
  });

  test("reconciles one accepted Threads target with its exact permalink GET only", async () => {
    const postId = "987654321_12345";
    const postCode = "CodeABC";
    const text = "how your email finds me";
    const url = `https://www.threads.com/@viewer/post/${postCode}`;
    const identifier = canonicalJson({
      code: postCode,
      height: 1022,
      id: postId,
      mediaType: 1,
      remoteMediaId: postId,
      url,
      width: 959,
    });
    const input = {
      attachment: { kind: "file", reference: "confirmed-fixture" },
      audience: "default",
      body: text,
    } as const;
    const calls: Call[] = [];
    const network = dependencies("threads", calls, (call) => {
      expect(call.method).toBe("GET");
      expect(call.url.href).toBe(url);
      return new Response(
        `${threadsHtml}${script({ post: threadsImagePost(postId, postCode, text) })}`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    expect(await readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish"),
      input,
      auth("threads"),
      identifier,
      { dependencies: network },
    )).toEqual({ present: true, postId });
    expect(calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
      `GET ${url}`,
    ]);

    const noncanonical = JSON.stringify({
      id: postId,
      code: postCode,
      height: 1022,
      mediaType: 1,
      remoteMediaId: postId,
      url,
      width: 959,
    });
    expect(await rejectionMessage(readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish"),
      input,
      auth("threads"),
      noncanonical,
      { dependencies: network },
    ))).toContain("not canonical");
    expect(calls).toHaveLength(1);

    expect(await rejectionMessage(readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish"),
      { ...input, body: "changed body" },
      auth("threads"),
      identifier,
      { dependencies: network },
    ))).toContain("did not bind the confirmed actor");
    expect(calls).toHaveLength(2);

    expect(await rejectionMessage(readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish"),
      input,
      { ...auth("threads"), subject: "threads:99999" },
      identifier,
      { dependencies: network },
    ))).toContain("account cookie did not match");
    expect(calls).toHaveLength(2);

    expect(await readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish", 4),
      input,
      auth("threads"),
      identifier,
      { dependencies: network },
    )).toEqual({ present: true, postId });
    expect(calls).toHaveLength(3);
  });

  test("reconciles one accepted text-only Threads target with its exact permalink GET only", async () => {
    const postId = "987654321_12345";
    const postCode = "CodeABC";
    const text = "how your email finds me";
    const url = `https://www.threads.com/@viewer/post/${postCode}`;
    const identifier = canonicalJson({
      code: postCode,
      id: postId,
      url,
    });
    const input = {
      audience: "default",
      body: text,
    } as const;
    const calls: Call[] = [];
    const network = dependencies("threads", calls, (call) => {
      expect(call.method).toBe("GET");
      expect(call.url.href).toBe(url);
      return new Response(
        `${threadsHtml}${script({
          post: threadsImagePost(postId, postCode, text, { includeImage: false }),
        })}`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    expect(await readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish"),
      input,
      auth("threads"),
      identifier,
      { dependencies: network },
    )).toEqual({ present: true, postId });
    expect(calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
      `GET ${url}`,
    ]);
    expect(await rejectionMessage(readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish"),
      { ...input, attachment: { kind: "file", reference: "confirmed-fixture" } },
      auth("threads"),
      identifier,
      { dependencies: network },
    ))).toContain("did not bind the confirmed media input");
    expect(calls).toHaveLength(1);
  });

  test("reconciles one accepted Threads video target without resolving or uploading the file", async () => {
    const postId = "987654322_12345";
    const postCode = "VideoABC";
    const text = "Wrench disposable Threads video fixture";
    const url = `https://www.threads.com/@viewer/post/${postCode}`;
    const identifier = canonicalJson({
      code: postCode,
      height: 360,
      id: postId,
      mediaType: 2,
      remoteMediaId: postId,
      url,
      width: 640,
    });
    const calls: Call[] = [];
    const network = dependencies("threads", calls, (call) => {
      expect(call.method).toBe("GET");
      expect(call.url.href).toBe(url);
      return new Response(
        `${threadsHtml}${script({ post: threadsVideoPost(postId, postCode, text) })}`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    expect(await readThreadsWebPublishedMutationTarget(
      recipe("threads", "media.publish"),
      {
        audience: "default",
        body: text,
        media: { kind: "file", reference: "confirmed-fixture" },
      },
      auth("threads"),
      identifier,
      { dependencies: network },
    )).toEqual({ present: true, postId });
    expect(calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
      `GET ${url}`,
    ]);

    expect(await rejectionMessage(readThreadsWebPublishedMutationTarget(
      recipe("threads", "posts.publish"),
      {
        attachment: { kind: "file", reference: "confirmed-fixture" },
        audience: "default",
        body: text,
      },
      auth("threads"),
      identifier,
      { dependencies: network },
    ))).toContain("did not bind the confirmed media input");
    expect(calls).toHaveLength(1);
  });

  test("reads one accepted Instagram video target without resolving or uploading the file", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const identifier = canonicalJson({ code, mediaId, url });
    const calls: Call[] = [];
    const network = dependencies("instagram", calls, (call) => {
      if (call.url.pathname === "/") {
        return new Response(instagramHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (call.url.pathname === `/p/${code}/`) {
        expect(call.headers.get("referer")).toBe("https://www.instagram.com/");
        return new Response("<html><head><title>Instagram</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (call.url.pathname === `/api/v1/media/${mediaId}/info/`) {
        expect(call.headers.get("referer")).toBe(url);
        return new Response(JSON.stringify({
          status: "ok",
          items: [instagramVideoPost(mediaId, code, caption)],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected Instagram video readback ${call.method} ${call.url.pathname}`);
    });
    expect(await readInstagramVideoAcceptedMutationTargetPresence(
      recipe("instagram", "media.publish"),
      {
        audience: "default",
        caption,
        media: { kind: "file", reference: "confirmed-fixture" },
        thumbnail: { kind: "file", reference: "confirmed-thumbnail" },
      },
      auth("instagram"),
      identifier,
      { dependencies: network },
    )).toEqual({ code, mediaId, present: true });
    expect(calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
      "GET https://www.instagram.com/",
      `GET ${url}`,
      `GET https://www.instagram.com/api/v1/media/${mediaId}/info/`,
    ]);
  });

  test("proves one deleted Instagram video absent from its exact soft-200 permalink", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const identifier = canonicalJson({ code, mediaId, url });
    const calls: Call[] = [];
    const network = dependencies("instagram", calls, (call) => {
      if (call.url.pathname === "/") {
        return new Response(instagramHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      expect(call.method).toBe("GET");
      expect(call.url.href).toBe(url);
      return new Response(instagramRemovedHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    expect(await readInstagramVideoAcceptedMutationTargetPresence(
      recipe("instagram", "content.delete"),
      {
        expected_caption: caption,
        expected_media_kind: "video",
        media_id: mediaId,
      },
      auth("instagram"),
      identifier,
      { dependencies: network },
    )).toEqual({ code, mediaId, present: false });
    expect(calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
      "GET https://www.instagram.com/",
      `GET ${url}`,
    ]);
  });

  test("does not claim deletion while authenticated media-info still exists", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const calls: Call[] = [];
    const network = dependencies("instagram", calls, (call) => {
      if (call.url.pathname === "/") {
        return new Response(instagramHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (call.url.pathname === `/p/${code}/`) {
        return new Response("<html><head><title>Instagram</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      expect(call.url.pathname).toBe(`/api/v1/media/${mediaId}/info/`);
      return new Response(JSON.stringify({
        status: "ok",
        items: [instagramVideoPost(mediaId, code, caption)],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(await readInstagramVideoAcceptedMutationTargetPresence(
      recipe("instagram", "content.delete"),
      {
        expected_caption: caption,
        expected_media_kind: "video",
        media_id: mediaId,
      },
      auth("instagram"),
      canonicalJson({ code, mediaId, url }),
      { dependencies: network },
    )).toEqual({ code, mediaId, present: true });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      `/p/${code}/`,
      `/api/v1/media/${mediaId}/info/`,
    ]);
  });

  test("deletes one exact authored Instagram video and verifies the soft-200 tombstone", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const calls: Call[] = [];
    const callbacks: string[] = [];
    const network = dependencies(
      "instagram",
      calls,
      (call) => {
        if (call.url.pathname === "/") {
          return new Response(instagramMutationHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (call.url.pathname === `/api/v1/media/${mediaId}/info/`) {
          return new Response(JSON.stringify({
            status: "ok",
            items: [instagramVideoPost(mediaId, code, caption)],
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (call.url.pathname === `/api/v1/web/create/${mediaId}/delete/`) {
          expect(call.method).toBe("POST");
          expect(call.body).toBe("");
          expect(call.headers.get("x-csrftoken")).toBe("csrf-fixture");
          return new Response(JSON.stringify({ status: "ok", did_delete: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        expect(call.url.href).toBe(url);
        return new Response(instagramRemovedHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      undefined,
      [
        strictCookie("www.instagram.com", "csrftoken", "csrf-fixture"),
        strictCookie("www.instagram.com", "ds_user_id", "12345"),
        strictCookie("www.instagram.com", "sessionid", "private"),
      ],
    );
    const result = await executeMetaWebOperation(
      recipe("instagram", "content.delete"),
      {
        expected_caption: caption,
        expected_media_kind: "video",
        media_id: mediaId,
      },
      auth("instagram"),
      {
        beforeDispatch: (event) => {
          callbacks.push(`before:${event.progress.started}`);
          return Promise.resolve();
        },
        afterProviderBoundMutationTarget: (event) => {
          callbacks.push(`target:${event.target.identifier}`);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          callbacks.push(`verified:${event.progress.verified}`);
          return Promise.resolve();
        },
        dependencies: network,
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
      finalUrl: url,
      output: { deleted: true },
    });
    expect(callbacks).toEqual([
      "before:0",
      `target:${canonicalJson({ code, mediaId, url })}`,
      "verified:1",
    ]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      `/api/v1/media/${mediaId}/info/`,
      "/",
      `/api/v1/media/${mediaId}/info/`,
      `/api/v1/web/create/${mediaId}/delete/`,
      "/",
      `/p/${code}/`,
    ]);
  });

  test("never retries an unverified Instagram delete and retains its bound target", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const calls: Call[] = [];
    const retainedTargets: string[] = [];
    const network = dependencies(
      "instagram",
      calls,
      (call) => {
        if (call.url.pathname === "/") {
          return new Response(instagramMutationHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (call.url.pathname === `/api/v1/media/${mediaId}/info/`) {
          return new Response(JSON.stringify({
            status: "ok",
            items: [instagramVideoPost(mediaId, code, caption)],
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        expect(call.url.pathname).toBe(`/api/v1/web/create/${mediaId}/delete/`);
        return new Response(JSON.stringify({ status: "fail", did_delete: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      undefined,
      [
        strictCookie("www.instagram.com", "csrftoken", "csrf-fixture"),
        strictCookie("www.instagram.com", "ds_user_id", "12345"),
        strictCookie("www.instagram.com", "sessionid", "private"),
      ],
    );
    const result = await executeMetaWebOperation(
      recipe("instagram", "content.delete"),
      {
        expected_caption: caption,
        expected_media_kind: "video",
        media_id: mediaId,
      },
      auth("instagram"),
      {
        beforeDispatch: () => Promise.resolve(),
        afterProviderBoundMutationTarget: (event) => {
          retainedTargets.push(event.target.identifier);
          return Promise.resolve();
        },
        dependencies: network,
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(retainedTargets).toEqual([canonicalJson({ code, mediaId, url })]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  test("rejects ambiguous Instagram video accepted targets before authenticated readback", async () => {
    const target = {
      code: "VideoABC",
      mediaId: "900_12345",
      url: "https://www.instagram.com/p/VideoABC/",
    } as const;
    const deleteInput = {
      expected_caption: "Disposable Wrench Instagram video fixture",
      expected_media_kind: "video",
      media_id: target.mediaId,
    } as const;
    const calls: Call[] = [];
    const network = dependencies("instagram", calls);
    expect(await rejectionMessage(readInstagramVideoAcceptedMutationTargetPresence(
      recipe("instagram", "content.delete"),
      deleteInput,
      auth("instagram"),
      JSON.stringify({ mediaId: target.mediaId, code: target.code, url: target.url }),
      { dependencies: network },
    ))).toContain("not canonical");
    expect(await rejectionMessage(readInstagramVideoAcceptedMutationTargetPresence(
      recipe("instagram", "content.delete"),
      { ...deleteInput, media_id: "901_12345" },
      auth("instagram"),
      canonicalJson(target),
      { dependencies: network },
    ))).toContain("did not bind the confirmed media ID");
    expect(calls).toHaveLength(0);
  });

  test("rejects Instagram video permalink marker and status drift before media readback", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const variants = [
      {
        expected: "removal marker changed shape",
        response: () => new Response(
          "<html><head><title>Page not found • Instagram</title></head></html>",
          {
          status: 200,
          headers: { "content-type": "text/html" },
          },
        ),
      },
      {
        expected: "unreviewed status/content type 503/text/html",
        response: () => new Response("<html><head><title>Instagram</title></head></html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      },
    ] as const;
    for (const variant of variants) {
      const calls: Call[] = [];
      const network = dependencies("instagram", calls, (call) => {
        if (call.url.pathname === "/") {
          return new Response(instagramHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        expect(call.url.href).toBe(url);
        return variant.response();
      });
      expect(await rejectionMessage(readInstagramVideoAcceptedMutationTargetPresence(
        recipe("instagram", "media.publish"),
        {
          audience: "default",
          caption,
          media: { kind: "file", reference: "confirmed-fixture" },
          thumbnail: { kind: "file", reference: "confirmed-thumbnail" },
        },
        auth("instagram"),
        canonicalJson({ code, mediaId, url }),
        { dependencies: network },
      ))).toContain(variant.expected);
      expect(calls.map((call) => call.url.pathname)).toEqual([
        "/",
        `/p/${code}/`,
      ]);
    }
  });

  test("rejects Instagram video media-info status, content-type, and output-bound drift", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const validBody = JSON.stringify({
      status: "ok",
      items: [instagramVideoPost(mediaId, code, caption)],
    });
    const variants = [
      {
        expected: "unreviewed status/content type 201/application/json",
        maxOutputBytes: 8 * 1024 * 1024,
        response: () => new Response(validBody, {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      },
      {
        expected: "unreviewed status/content type 200/text/html",
        maxOutputBytes: 8 * 1024 * 1024,
        response: () => new Response(validBody, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      },
      {
        expected: "exceeded its reviewed byte limit",
        maxOutputBytes: 256,
        response: () => new Response(`${validBody}${" ".repeat(512)}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      },
    ] as const;
    for (const variant of variants) {
      const calls: Call[] = [];
      const network = dependencies("instagram", calls, (call) => {
        if (call.url.pathname === "/") {
          return new Response(instagramHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (call.url.pathname === `/p/${code}/`) {
          return new Response("<html><head><title>Instagram</title></head></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        expect(call.url.pathname).toBe(`/api/v1/media/${mediaId}/info/`);
        return variant.response();
      });
      expect(await rejectionMessage(readInstagramVideoAcceptedMutationTargetPresence(
        {
          ...recipe("instagram", "media.publish"),
          maxOutputBytes: variant.maxOutputBytes,
        },
        {
          audience: "default",
          caption,
          media: { kind: "file", reference: "confirmed-fixture" },
          thumbnail: { kind: "file", reference: "confirmed-thumbnail" },
        },
        auth("instagram"),
        canonicalJson({ code, mediaId, url }),
        { dependencies: network },
      ))).toContain(variant.expected);
      expect(calls.map((call) => call.url.pathname)).toEqual([
        "/",
        `/p/${code}/`,
        `/api/v1/media/${mediaId}/info/`,
      ]);
    }
  });

  test("rejects drift in an existing Instagram video target's exact media-info readback", async () => {
    const mediaId = "900_12345";
    const code = "VideoABC";
    const caption = "Disposable Wrench Instagram video fixture";
    const url = `https://www.instagram.com/p/${code}/`;
    const calls: Call[] = [];
    const network = dependencies("instagram", calls, (call) => {
      if (call.url.pathname === "/") {
        return new Response(instagramHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (call.url.pathname === `/p/${code}/`) {
        return new Response("<html><head><title>Instagram</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(JSON.stringify({
        status: "ok",
        items: [instagramVideoPost(mediaId, code, caption, {
          user: { pk: "99999", username: "other" },
        })],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(await rejectionMessage(readInstagramVideoAcceptedMutationTargetPresence(
      recipe("instagram", "media.publish"),
      {
        audience: "default",
        caption,
        media: { kind: "file", reference: "confirmed-fixture" },
        thumbnail: { kind: "file", reference: "confirmed-thumbnail" },
      },
      auth("instagram"),
      canonicalJson({ code, mediaId, url }),
      { dependencies: network },
    ))).toContain("did not bind the confirmed actor");
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/",
      `/p/${code}/`,
      `/api/v1/media/${mediaId}/info/`,
    ]);
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
      ["instagram", "media.publish"],
      ["instagram", "messaging.send"],
      ["threads", "likes.set"],
      ["facebook", "contacts.list"],
      ["facebook", "messaging.list"],
      ["facebook", "posts.publish"],
    ] as const) {
      const calls: Call[] = [];
      const acquisitions = { count: 0 };
      let callbacks = 0;
      let fileResolutions = 0;
      const message = await rejectionMessage(executeMetaWebOperation(
        recipe(site, action),
        {},
        auth(site === "instagram" ? "instagram" : site === "threads" ? "threads" : "facebook"),
        {
          fileResolver: () => {
            fileResolutions += 1;
            return Promise.resolve([]);
          },
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
      expect(fileResolutions).toBe(0);
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
