import { expect, test } from "bun:test";
import { assertProperty, fc } from "../test-support";

import {
  bindFacebookMarketplacePaginationCursor,
  facebookMarketplacePaginationInputHash,
  reconstructFacebookMarketplacePaginationCursor,
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

function html(): string {
  return `<script type="application/json">${JSON.stringify({
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
            expectedPreloaders: [{
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
              },
            }],
            initialRouteInfo: {},
            qplEvents: [],
            rootElementID: "mount",
            ssrEnabled: true,
          }],
        ]],
      },
    }]]],
  })}</script>`;
}

test("property: unique cursor chains round-trip and reject every prior cursor", () => {
  assertProperty(fc.property(
    fc.uniqueArray(
      fc.integer({ min: 1, max: 1_000_000 }).map((value) => `cursor-${value}`),
      { minLength: 1, maxLength: 24 },
    ),
    (values) => {
      const inputHash = facebookMarketplacePaginationInputHash(html(), VIEWER_ID);
      let bound = bindFacebookMarketplacePaginationCursor(
        VIEWER_ID,
        values[0]!,
        inputHash,
      );
      for (const value of values.slice(1)) {
        bound = bindFacebookMarketplacePaginationCursor(
          VIEWER_ID,
          value,
          inputHash,
          bound,
        );
      }
      const restored = reconstructFacebookMarketplacePaginationCursor(
        VIEWER_ID,
        structuredClone(bound),
      );
      expect(restored).toEqual(bound);
      expect(() => bindFacebookMarketplacePaginationCursor(
        VIEWER_ID,
        values[0]!,
        inputHash,
        restored,
      )).toThrow("repeated an earlier page");
    },
  ));
});
