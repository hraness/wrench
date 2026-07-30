import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCursorToken, sealCursorToken } from "../cursor-token";
import {
  FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
  bindFacebookMarketplacePaginationCursor,
  buildFacebookMarketplacePaginationRequest,
  extractFacebookMarketplacePaginationInput,
  facebookMarketplacePaginationInputHash,
  reconstructFacebookMarketplacePaginationCursor,
  type FacebookMarketplacePaginationCursor,
} from "./meta-marketplace-relay";

const VIEWER_ID = "2468013579";
const SHIPPING_ICON =
  "__relay_internal__pv__CometMarketplaceShouldShowFeedShippingIconrelayprovider";
const TOP_PICKS_STRIKETHROUGH =
  "__relay_internal__pv__CometMarketplaceShouldShowTopPicksStrikethroughrelayprovider";
const SPONSORED_FIELD_NAME =
  "__relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider";
const AD_MODULE =
  "__relay_internal__pv__MarketplaceCometAdmodulerelayprovider";
const stateRoots: string[] = [];

afterEach(() => {
  for (const root of stateRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stateEnvironment(): Readonly<Record<string, string | undefined>> {
  const root = mkdtempSync(join(tmpdir(), "wrench-marketplace-cursor-"));
  chmodSync(root, 0o700);
  stateRoots.push(root);
  return { ...process.env, WRENCH_STATE_HOME: root };
}

function preloader(
  overrides: Readonly<Record<string, unknown>> = {},
  variableOverrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    actorID: VIEWER_ID,
    preloaderID: "marketplace-feed-preloader",
    queryID: "28097605446510041",
    queryName: "MarketplaceCometBrowseFeedLightContainerQuery",
    variables: {
      [SHIPPING_ICON]: false,
      [TOP_PICKS_STRIKETHROUGH]: false,
      [SPONSORED_FIELD_NAME]: true,
      [AD_MODULE]: true,
      buyLocation: { latitude: 40.7128, longitude: -74.006 },
      count: 24,
      cursor: null,
      imageWidth: 256,
      mediaType: "image/jpeg",
      radius: 65_000,
      scale: 2,
      sizing: "cover-fill-cropped",
      useSDFPath: true,
      ...variableOverrides,
    },
    ...overrides,
  };
}

function html(
  preloaders: readonly Readonly<Record<string, unknown>>[] = [preloader()],
  viewerId = VIEWER_ID,
): string {
  return `<html><script type="application/json">${JSON.stringify({
    define: [[
      "CurrentUserInitialData",
      [],
      { ACCOUNT_ID: viewerId, USER_ID: viewerId },
      1,
    ]],
    require: [["ScheduledServerJS", "handle", null, [{
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
            client_id: "client",
            expectedPreloaders: preloaders,
            initialRouteInfo: {},
            qplEvents: [],
            rootElementID: "mount",
            ssrEnabled: true,
          }],
        ]],
      },
    }]]],
  })}</script></html>`;
}

function jsonScript(value: unknown): string {
  return `<script type="application/json">${JSON.stringify(value)}</script>`;
}

function currentUserRoot(viewerId = VIEWER_ID): Readonly<Record<string, unknown>> {
  return {
    define: [[
      "CurrentUserInitialData",
      [],
      { ACCOUNT_ID: viewerId, USER_ID: viewerId },
      1,
    ]],
  };
}

function liveCometPlatformHtml(
  options: {
    readonly preloaders?: readonly Readonly<Record<string, unknown>>[];
    readonly method?: string;
    readonly dependencies?: readonly unknown[];
    readonly payload?: readonly unknown[];
  } = {},
): string {
  const configuration = {
    ConfigOrBuilder: {},
    additional_roots: [],
    backgroundRouteInfo: null,
    client_id: "client",
    expectedPreloaders: options.preloaders ?? [preloader()],
    initialRouteInfo: {},
    qplEvents: [],
    rootElementID: "mount",
    ssrEnabled: true,
  };
  return `<html><script type="application/json">${JSON.stringify({
    define: [[
      "CurrentUserInitialData",
      [],
      { ACCOUNT_ID: VIEWER_ID, USER_ID: VIEWER_ID },
      1,
    ]],
    require: [["ScheduledServerJS", "handle", null, [{
      __bbox: {
        require: [[
          "CometPlatformRootClient",
          options.method ?? "initialize",
          options.dependencies ?? [
            "CometFBLoggedInRootConfig",
            "RequireDeferredReference",
          ],
          options.payload ?? [configuration],
        ]],
      },
    }]]],
  })}</script></html>`;
}

describe("Facebook Marketplace Relay pagination contract", () => {
  test("binds the live preloader context into one exact descriptor-owned request", () => {
    const pagination = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "opaque-page-cursor",
      facebookMarketplacePaginationInputHash(html(), VIEWER_ID),
    );
    const request = buildFacebookMarketplacePaginationRequest(
      html(),
      VIEWER_ID,
      pagination,
    );
    expect(FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR).toMatchObject({
      id: "facebook-marketplace.feeds-read-pagination",
      friendlyName: "MarketplaceCometBrowseFeedLightPaginationQuery",
      docId: "27448592924790037",
      contract: { state: "observed" },
      access: { kind: "marketplace", actorBinding: "viewer" },
    });
    expect(request).toMatchObject({
      operationType: "query",
      origin: "https://www.facebook.com",
      method: "POST",
      path: "/api/graphql/",
      parameterLocation: "form",
      access: {
        kind: "marketplace",
        viewerId: VIEWER_ID,
        actorId: VIEWER_ID,
        targetId: "marketplace_home_feed",
      },
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
    const parameters = new Map(request.parameters.map(({ name, value }) => [name, value]));
    expect(parameters.get("fb_api_req_friendly_name"))
      .toBe("MarketplaceCometBrowseFeedLightPaginationQuery");
    expect(parameters.get("doc_id")).toBe("27448592924790037");
    expect(JSON.parse(parameters.get("variables")!)).toEqual({
      [SHIPPING_ICON]: false,
      [TOP_PICKS_STRIKETHROUGH]: false,
      [SPONSORED_FIELD_NAME]: true,
      [AD_MODULE]: true,
      buyLocation: { latitude: 40.7128, longitude: -74.006 },
      count: 5,
      cursor: "opaque-page-cursor",
      imageWidth: 256,
      includePDPRelevantListings: false,
      mediaType: "image/jpeg",
      pdpListingId: "",
      radius: 65_000,
      refinement: null,
      scale: 2,
      sizing: "cover-fill-cropped",
      useSDFPath: true,
    });
  });

  test("returns only the reviewed preloader variable subset", () => {
    expect(extractFacebookMarketplacePaginationInput(html(), VIEWER_ID)).toEqual({
      [SHIPPING_ICON]: false,
      [TOP_PICKS_STRIKETHROUGH]: false,
      [SPONSORED_FIELD_NAME]: true,
      [AD_MODULE]: true,
      buyLocation: { latitude: 40.7128, longitude: -74.006 },
      imageWidth: 256,
      mediaType: "image/jpeg",
      radius: 65_000,
      scale: 2,
      sizing: "cover-fill-cropped",
      useSDFPath: true,
    });
  });

  test("accepts only the exact live CometPlatformRootClient preloader container", () => {
    expect(extractFacebookMarketplacePaginationInput(
      liveCometPlatformHtml(),
      VIEWER_ID,
    )).toEqual(extractFacebookMarketplacePaginationInput(
      html(),
      VIEWER_ID,
    ));
    for (const source of [
      liveCometPlatformHtml({ method: "unreviewed" }),
      liveCometPlatformHtml({
        dependencies: [
          "RequireDeferredReference",
          "CometFBLoggedInRootConfig",
        ],
      }),
      liveCometPlatformHtml({ payload: [{ expectedPreloaders: [preloader()] }, null] }),
    ]) {
      expect(() => extractFacebookMarketplacePaginationInput(source, VIEWER_ID))
        .toThrow("outside its reviewed root");
    }
  });

  test("does not authorize a preloader from a separate arbitrary top-level root", () => {
    const source = [
      "<html>",
      jsonScript(currentUserRoot()),
      jsonScript({ expectedPreloaders: [preloader()] }),
      "</html>",
    ].join("");
    expect(() => extractFacebookMarketplacePaginationInput(source, VIEWER_ID))
      .toThrow("outside its reviewed root");
  });

  test("does not authorize a preloader from an arbitrary nested container", () => {
    const source = [
      "<html>",
      jsonScript({
        ...currentUserRoot(),
        arbitraryContainer: {
          expectedPreloaders: [preloader()],
        },
      }),
      "</html>",
    ].join("");
    expect(() => extractFacebookMarketplacePaginationInput(source, VIEWER_ID))
      .toThrow("outside its reviewed root");
  });

  test("rejects viewer, actor, candidate, variable, coordinate, and cursor drift", () => {
    expect(() => extractFacebookMarketplacePaginationInput(html(), "987654321"))
      .toThrow("bound viewer");
    expect(() => extractFacebookMarketplacePaginationInput(
      html([preloader({ actorID: "987654321" })]),
      VIEWER_ID,
    )).toThrow("actor changed");
    expect(() => extractFacebookMarketplacePaginationInput(
      html([preloader(), preloader()]),
      VIEWER_ID,
    )).toThrow("ambiguous");
    expect(() => extractFacebookMarketplacePaginationInput(
      html([preloader({}, { borrowed: true })]),
      VIEWER_ID,
    )).toThrow("reviewed fields");
    expect(() => extractFacebookMarketplacePaginationInput(
      html([preloader({}, { buyLocation: { latitude: 91, longitude: 0 } })]),
      VIEWER_ID,
    )).toThrow("bounded finite number");
    expect(() => bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "",
      facebookMarketplacePaginationInputHash(html(), VIEWER_ID),
    ))
      .toThrow("bounded text");
    expect(() => bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "private\ncursor",
      facebookMarketplacePaginationInputHash(html(), VIEWER_ID),
    )).toThrow("bounded text");
    const forgedCursor: FacebookMarketplacePaginationCursor = {
      schemaVersion: 1,
      inputHash: facebookMarketplacePaginationInputHash(html(), VIEWER_ID),
      descriptorKey: "forged",
      actorId: VIEWER_ID,
      targetId: "marketplace_home_feed",
      cursor: "opaque-page-cursor",
      cursorHistory: ["forged"],
    };
    expect(() => buildFacebookMarketplacePaginationRequest(
      html(),
      VIEWER_ID,
      forgedCursor,
    )).toThrow("not issued");
  });

  test("restores only an authenticated coordinate- and chain-bound cursor payload", () => {
    const inputHash = facebookMarketplacePaginationInputHash(html(), VIEWER_ID);
    const previous = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "opaque-page-cursor",
      inputHash,
    );
    const next = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "opaque-next-cursor",
      inputHash,
      previous,
    );
    const restored = reconstructFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      structuredClone(next),
    );
    expect(restored).toEqual(next);
    expect(next.cursorHistory).toHaveLength(2);
    expect(next.cursorHistory[0]).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(() => reconstructFacebookMarketplacePaginationCursor(
      "987654321",
      structuredClone(next),
    )).toThrow("bound coordinates");
    expect(() => reconstructFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      {
        ...structuredClone(next),
        targetId: "borrowed-target",
      },
    )).toThrow("bound coordinates");
  });

  test("rejects A-to-B-to-A cursor cycles across the authenticated history", () => {
    const inputHash = facebookMarketplacePaginationInputHash(html(), VIEWER_ID);
    const first = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "cursor-a",
      inputHash,
    );
    const second = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "cursor-b",
      inputHash,
      first,
    );
    expect(() => bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "cursor-a",
      inputHash,
      second,
    )).toThrow("repeated an earlier page");
  });

  test("keeps a maximum cursor and full bounded history sealable", () => {
    const inputHash = facebookMarketplacePaginationInputHash(html(), VIEWER_ID);
    let cursor = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "cursor-0",
      inputHash,
    );
    for (let index = 1; index < 47; index += 1) {
      cursor = bindFacebookMarketplacePaginationCursor(
        VIEWER_ID,
        `cursor-${index}`,
        inputHash,
        cursor,
      );
    }
    cursor = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "x".repeat(4_096),
      inputHash,
      cursor,
    );
    const environment = stateEnvironment();
    const token = sealCursorToken(
      "facebook-marketplace-feed",
      "facebook-test",
      "a".repeat(64),
      cursor,
      environment,
    );
    expect(token.length).toBeLessThanOrEqual(8_192);
    expect(reconstructFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      openCursorToken(
        "facebook-marketplace-feed",
        "facebook-test",
        "a".repeat(64),
        token,
        environment,
      ),
    )).toEqual(cursor);
    expect(() => bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "é".repeat(4_096),
      inputHash,
    )).toThrow("printable-ASCII");
  });

  test("binds every cursor to the exact preloader-derived feed context", () => {
    const initialHtml = html();
    const cursor = bindFacebookMarketplacePaginationCursor(
      VIEWER_ID,
      "opaque-page-cursor",
      facebookMarketplacePaginationInputHash(initialHtml, VIEWER_ID),
    );
    const movedLocation = html([preloader({}, {
      buyLocation: { latitude: 34.0522, longitude: -118.2437 },
    })]);
    expect(() => buildFacebookMarketplacePaginationRequest(
      movedLocation,
      VIEWER_ID,
      cursor,
    )).toThrow("feed input context");
  });

  test("rejects unsafe literal drift before a request can be built", () => {
    for (const [field, value] of [
      ["mediaType", "image/png"],
      ["sizing", "contain"],
      ["scale", 8],
      ["cursor", "already-initialized"],
    ] as const) {
      const driftedHtml = html([preloader({}, { [field]: value })]);
      if (field === "mediaType" || field === "sizing") {
        expect(() => facebookMarketplacePaginationInputHash(
          driftedHtml,
          VIEWER_ID,
        )).toThrow("drifted from reviewed evidence");
      }
      expect(() => buildFacebookMarketplacePaginationRequest(
        driftedHtml,
        VIEWER_ID,
        bindFacebookMarketplacePaginationCursor(
          VIEWER_ID,
          "opaque-page-cursor",
          facebookMarketplacePaginationInputHash(html(), VIEWER_ID),
        ),
      )).toThrow();
    }
  });
});
