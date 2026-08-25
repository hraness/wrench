import { expect, test } from "bun:test";

import { assertProperty, fc } from "../test-support";
import {
  buildTikTokStudioExactCaptionListBody,
  observeTikTokStudioContentListTarget,
  parseTikTokStudioContentListBody,
  parseTikTokStudioContentListCommonQuery,
  parseTikTokStudioContentListEnvelope,
  parseTikTokStudioNormalItem,
  type TikTokStudioContentListPage,
} from "./tiktok-studio-content-list";

const ITEM_ID = "7491234567890123456";

const actionPermission = Object.freeze({ reason: "", show_type: 2 });
const visibilityPermission = Object.freeze({ reason: "", visibility_status: 1 });

function commonQuery(): Record<string, unknown> {
  return {
    aid: "1988",
    app_language: "en",
    app_name: "tiktok_web",
    browser_language: "en-US",
    browser_name: "Mozilla",
    browser_platform: "MacIntel",
    browser_version: "151.0.0.0",
    channel: "tiktok_web",
    device_id: "1234567890123456789",
    device_platform: "web_pc",
    locale: "en",
    msToken: "fixture-only-opaque-ms-token",
    os: "mac",
    priority_region: "PR",
    region: "US",
    screen_height: "982",
    screen_width: "1512",
    tz_name: "America/Puerto_Rico",
  };
}

function normalItem(description = "Exact fixture"): Record<string, unknown> {
  return {
    comment_count: "1",
    cover_url: ["https://media.example.invalid/cover"],
    create_time: "1786730515",
    desc: description,
    download_info: {
      allow_download: true,
      download_urls: ["https://media.example.invalid/download"],
    },
    duration: 8_000,
    favorite_count: "0",
    in_review: false,
    is_pinned: false,
    item_id: ITEM_ID,
    item_type: 1,
    like_count: "2",
    permissions: {
      can_add_to_playlist: actionPermission,
      can_change_privacy: {
        reason: "",
        show_type: 2,
        visibility_options: {
          visibility_available_for_ads: visibilityPermission,
          visibility_everyone: visibilityPermission,
          visibility_followers: visibilityPermission,
          visibility_friends: visibilityPermission,
          visibility_only_you: visibilityPermission,
        },
      },
      can_delete: actionPermission,
      can_edit: actionPermission,
      can_edit_cover: actionPermission,
      can_pin: actionPermission,
    },
    play_addr: ["https://media.example.invalid/play"],
    play_count: "3",
    post_time: "1786730515",
    schedule_time: "0",
    share_count: "4",
    status: 1,
    vid: "video-fixture-1",
    visibility: 1,
  };
}

function successEnvelope(description = "Exact fixture"): Record<string, unknown> {
  return {
    cursor: 0,
    enable_query: true,
    extra: { fatal_item_ids: [], logid: "fixture-log", now: 1_787_555_280_000 },
    has_more: false,
    is_limited: false,
    item_list: [normalItem(description)],
    log_pb: { impr_id: "fixture-impression" },
    status_code: 0,
    status_msg: "",
  };
}

const unknownCommonQueryKey = fc.string({ minLength: 1, maxLength: 48 }).filter((key) =>
  !Object.hasOwn(commonQuery(), key)
);

test("property: TikTok Studio common query rejects every unknown field", () => {
  assertProperty(fc.property(
    unknownCommonQueryKey,
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseTikTokStudioContentListCommonQuery({
        ...commonQuery(),
        [key]: value,
      })).toThrow();
    },
  ));
});

test("property: TikTok Studio common query rejects every missing required field", () => {
  assertProperty(fc.property(
    fc.constantFrom(...Object.keys(commonQuery())),
    (key) => {
      const query = commonQuery();
      delete query[key];
      expect(() => parseTikTokStudioContentListCommonQuery(query))
        .toThrow("changed its reviewed fields");
    },
  ));
});

test("property: exact-caption body round trips bounded captions and cursor pages", () => {
  const caption = fc.string({ minLength: 1, maxLength: 256 })
    .filter((value) => !value.includes("\0") && !value.includes("\r"));
  assertProperty(fc.property(
    caption,
    fc.integer({ min: 0, max: 1_000_000 }),
    (description, cursor) => {
      const body = buildTikTokStudioExactCaptionListBody({ cursor, description });
      expect(parseTikTokStudioContentListBody(body)).toEqual(body);
      expect(body.size).toBe(cursor === 0 ? 50 : 10);
      expect(body.query.conditions?.[0]?.field_values).toEqual([description]);
    },
  ));
});

test("property: exact-caption body admits LF but rejects every NUL or CR caption", () => {
  expect(buildTikTokStudioExactCaptionListBody({
    cursor: 0,
    description: "line one\nline two",
  }).query.conditions?.[0]?.field_values).toEqual(["line one\nline two"]);

  assertProperty(fc.property(
    fc.string({ maxLength: 64 }),
    fc.constantFrom("\0", "\r"),
    fc.string({ maxLength: 64 }),
    (before, prohibited, after) => {
      expect(() => buildTikTokStudioExactCaptionListBody({
        cursor: 0,
        description: `${before}${prohibited}${after}`,
      })).toThrow("NUL or carriage return");
    },
  ));
});

test("property: normal-item parser rejects every unknown item field", () => {
  const known = new Set(Object.keys(normalItem()));
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 48 }).filter((key) => !known.has(key)),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseTikTokStudioNormalItem({
        ...normalItem(),
        [key]: value,
      })).toThrow();
    },
  ));
});

test("property: successful envelope rejects every unknown top-level field", () => {
  const known = new Set(Object.keys(successEnvelope()));
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 48 }).filter((key) => !known.has(key)),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseTikTokStudioContentListEnvelope({
        ...successEnvelope(),
        [key]: value,
      })).toThrow();
    },
  ));
});

test("property: list nonappearance is never classified as deletion proof", () => {
  assertProperty(fc.property(
    fc.boolean(),
    fc.boolean(),
    (hasMore, isLimited) => {
      const page = Object.freeze({
        canProveAbsence: false,
        cursor: 0,
        enableQuery: true,
        hasMore,
        isLimited,
        items: Object.freeze([]),
      }) satisfies TikTokStudioContentListPage;
      const observation = observeTikTokStudioContentListTarget(page, {
        description: "Exact fixture",
        itemId: ITEM_ID,
      });
      expect(observation.kind).toBe("absence-unproven");
      if (observation.kind === "absence-unproven") {
        expect(observation.absenceProven).toBe(false);
        expect(observation.reason).toBe(
          isLimited
            ? "limited-response"
            : hasMore
            ? "additional-page-required"
            : "list-is-not-a-tombstone",
        );
      }
    },
  ));
});

test("property: parsed item descriptions preserve every supported LF caption exactly", () => {
  const description = fc.string({ maxLength: 256 })
    .filter((value) => !value.includes("\0") && !value.includes("\r"));
  assertProperty(fc.property(description, (value) => {
    const response = parseTikTokStudioContentListEnvelope(successEnvelope(value));
    expect(response.items[0]?.description).toBe(value);
  }));
});
