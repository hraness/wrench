import { describe, expect, test } from "bun:test";

import {
  buildTikTokStudioContentListRequest,
  buildTikTokStudioExactCaptionListBody,
  observeTikTokStudioContentListTarget,
  parseTikTokStudioContentListBody,
  parseTikTokStudioContentListCommonQuery,
  parseTikTokStudioContentListEnvelope,
  parseTikTokStudioNormalItem,
  tiktokStudioContentListLiveEvidenceSnapshot,
} from "./tiktok-studio-content-list";

const ITEM_ID = "7491234567890123456";
const DESCRIPTION = "Disposable exact-caption fixture";

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

function actionPermission(showType = 2): Record<string, unknown> {
  return { reason: "", show_type: showType };
}

function visibilityPermission(visibilityStatus = 1): Record<string, unknown> {
  return { reason: "", visibility_status: visibilityStatus };
}

function permissions(): Record<string, unknown> {
  return {
    can_add_to_playlist: actionPermission(),
    can_change_privacy: {
      reason: "",
      show_type: 2,
      visibility_options: {
        visibility_available_for_ads: visibilityPermission(),
        visibility_everyone: visibilityPermission(),
        visibility_followers: visibilityPermission(),
        visibility_friends: visibilityPermission(),
        visibility_only_you: visibilityPermission(),
      },
    },
    can_delete: actionPermission(),
    can_edit: actionPermission(),
    can_edit_cover: actionPermission(),
    can_pin: actionPermission(),
  };
}

function normalItem(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    comment_count: "1",
    cover_url: [
      "https://media.example.invalid/cover-one?signature=discard-me",
      "https://media.example.invalid/cover-two?signature=discard-me-too",
    ],
    create_time: "1786730515",
    desc: DESCRIPTION,
    download_info: {
      allow_download: true,
      download_urls: ["https://media.example.invalid/download?signature=discard-me"],
    },
    duration: 50_046,
    favorite_count: "1",
    in_review: false,
    is_pinned: false,
    item_id: ITEM_ID,
    item_type: 1,
    like_count: "20",
    permissions: permissions(),
    play_addr: ["https://media.example.invalid/play?signature=discard-me"],
    play_count: "301",
    post_time: "1786730515",
    schedule_time: "0",
    share_count: "3",
    status: 1,
    vid: "video-fixture-1",
    visibility: 1,
    ...overrides,
  };
}

function successEnvelope(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    cursor: 3,
    enable_query: true,
    extra: {
      fatal_item_ids: [],
      logid: "fixture-log-id",
      now: 1_787_555_280_000,
    },
    has_more: false,
    is_limited: true,
    item_list: [normalItem()],
    log_pb: { impr_id: "fixture-impression-id" },
    status_code: 0,
    status_msg: "",
    ...overrides,
  };
}

describe("TikTok Studio content-list request contract", () => {
  test("retains only secret-free structural evidence", () => {
    expect(tiktokStudioContentListLiveEvidenceSnapshot).toEqual({
      schemaVersion: 1,
      role: "live-read-only-exact-structure",
      observedOn: "2026-08-24",
      origin: "https://www.tiktok.com",
      request: {
        method: "POST",
        path: "/tiktok/creator/manage/item_list/v1/",
        commonQueryKeys: [
          "aid",
          "app_language",
          "app_name",
          "browser_language",
          "browser_name",
          "browser_platform",
          "browser_version",
          "channel",
          "device_id",
          "device_platform",
          "locale",
          "msToken",
          "os",
          "priority_region",
          "region",
          "screen_height",
          "screen_width",
          "tz_name",
        ],
        opaqueCredentialSinkKeys: ["device_id", "msToken"],
        bodyKeys: ["cursor", "query", "size"],
      },
      response: {
        status: 200,
        contentType: "application/json; charset=utf-8",
        envelopeKeys: [
          "cursor",
          "enable_query",
          "extra",
          "has_more",
          "is_limited",
          "item_list",
          "log_pb",
          "status_code",
          "status_msg",
        ],
        normalItemKeys: [
          "comment_count",
          "cover_url",
          "create_time",
          "desc",
          "download_info",
          "duration",
          "favorite_count",
          "in_review",
          "is_pinned",
          "item_id",
          "item_type",
          "like_count",
          "permissions",
          "play_addr",
          "play_count",
          "post_time",
          "schedule_time",
          "share_count",
          "status",
          "vid",
          "visibility",
        ],
      },
      binding: {
        presentTargetFields: ["item_list[].item_id", "item_list[].desc"],
        absentFields: ["actor", "project_id"],
        accountRequirement: "separate exact current-account realm probe",
        absencePolicy: "content-list nonappearance never proves a deletion tombstone",
      },
    });
    const serialized = JSON.stringify(tiktokStudioContentListLiveEvidenceSnapshot);
    expect(serialized).not.toContain("fixture-only-opaque-ms-token");
    expect(serialized).not.toContain(ITEM_ID);
    expect(serialized).not.toContain(DESCRIPTION);
  });

  test("validates the exact common-query key set and isolates opaque sinks", () => {
    const parsed = parseTikTokStudioContentListCommonQuery(commonQuery());
    expect(parsed as unknown).toEqual(commonQuery());
    expect(Object.isFrozen(parsed)).toBe(true);

    const unknown = commonQuery();
    unknown.extra = "drift";
    expect(() => parseTikTokStudioContentListCommonQuery(unknown))
      .toThrow("changed its reviewed fields");

    const missing = commonQuery();
    delete missing.msToken;
    expect(() => parseTikTokStudioContentListCommonQuery(missing))
      .toThrow("changed its reviewed fields");
    expect(() => parseTikTokStudioContentListCommonQuery({
      ...commonQuery(),
      device_id: "caller-selected-device",
    })).toThrow("opaque format");
    expect(() => parseTikTokStudioContentListCommonQuery({
      ...commonQuery(),
      msToken: "has whitespace",
    })).toThrow("opaque format");
  });

  test("builds only the fixed POST route around validated provider state", () => {
    const body = buildTikTokStudioExactCaptionListBody({
      cursor: 0,
      description: DESCRIPTION,
    });
    expect(body).toEqual({
      cursor: 0,
      size: 50,
      query: {
        conditions: [{
          field_name: "desc",
          field_values: [DESCRIPTION],
          op: 1,
        }],
        is_recent_posts: false,
        sort_orders: [{ field_name: "post_time", order: 2 }],
      },
    });
    expect(buildTikTokStudioExactCaptionListBody({
      cursor: 3,
      description: DESCRIPTION,
    }).size).toBe(10);

    expect(buildTikTokStudioContentListRequest({
      body,
      commonQuery: commonQuery(),
    }) as unknown).toEqual({
      body,
      method: "POST",
      path: "/tiktok/creator/manage/item_list/v1/",
      query: commonQuery(),
    });
  });

  test("admits only captured and bundle-proven body variants", () => {
    expect(parseTikTokStudioContentListBody({
      cursor: 0,
      size: 50,
      query: { sort_orders: [{ field_name: "post_time", order: 1 }] },
    })).toEqual({
      cursor: 0,
      size: 50,
      query: { sort_orders: [{ field_name: "post_time", order: 1 }] },
    });
    expect(parseTikTokStudioContentListBody({
      cursor: 0,
      size: 1,
      query: {
        conditions: [],
        sort_orders: [{ field_name: "post_time", order: 2 }],
      },
    }).size).toBe(1);
    expect(parseTikTokStudioContentListBody({
      cursor: 0,
      size: 50,
      query: {
        conditions: [
          { field_name: "like_count", field_values: ["1000"], op: 6 },
          { field_name: "visibility", field_values: ["1"], op: 1 },
        ],
        is_recent_posts: false,
        sort_orders: [
          { field_name: "like_count", order: 1 },
          { field_name: "post_time", order: 2 },
        ],
      },
    }).query.conditions).toHaveLength(2);

    expect(() => parseTikTokStudioContentListBody({
      cursor: 0,
      size: 10,
      query: { sort_orders: [{ field_name: "post_time", order: 2 }] },
    })).toThrow("cursor and size");
    expect(() => parseTikTokStudioContentListBody({
      cursor: 0,
      size: 50,
      query: { sort_orders: [{ field_name: "like_count", order: 1 }] },
    })).toThrow("tie-breaker");
    expect(() => parseTikTokStudioContentListBody({
      cursor: 0,
      size: 50,
      query: {
        conditions: [{ field_name: "like_count", field_values: ["999"], op: 6 }],
        is_recent_posts: false,
        sort_orders: [{ field_name: "post_time", order: 2 }],
      },
    })).toThrow("reviewed count condition");
  });
});

describe("TikTok Studio content-list response contract", () => {
  test("strictly parses normal items while discarding signed URL values", () => {
    const item = parseTikTokStudioNormalItem(normalItem());
    expect(item).toEqual({
      commentCount: "1",
      coverUrlCount: 2,
      createTime: "1786730515",
      description: DESCRIPTION,
      downloadAllowed: true,
      downloadUrlCount: 1,
      duration: 50_046,
      favoriteCount: "1",
      inReview: false,
      isPinned: false,
      itemId: ITEM_ID,
      itemType: 1,
      likeCount: "20",
      permissions: {
        canAddToPlaylist: { reason: "", showType: 2 },
        canChangePrivacy: {
          reason: "",
          showType: 2,
          visibilityOptions: {
            availableForAds: { reason: "", visibilityStatus: 1 },
            everyone: { reason: "", visibilityStatus: 1 },
            followers: { reason: "", visibilityStatus: 1 },
            friends: { reason: "", visibilityStatus: 1 },
            onlyYou: { reason: "", visibilityStatus: 1 },
          },
        },
        canDelete: { reason: "", showType: 2 },
        canEdit: { reason: "", showType: 2 },
        canEditCover: { reason: "", showType: 2 },
        canPin: { reason: "", showType: 2 },
      },
      playAddressCount: 1,
      playCount: "301",
      postTime: "1786730515",
      scheduleTime: "0",
      shareCount: "3",
      status: 1,
      videoId: "video-fixture-1",
      visibility: 1,
    });
    expect(JSON.stringify(item)).not.toContain("signature=discard-me");
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.permissions.canChangePrivacy.visibilityOptions)).toBe(true);
  });

  test("parses the exact successful envelope and binds item ID plus description", () => {
    const page = parseTikTokStudioContentListEnvelope(successEnvelope());
    expect(page).toMatchObject({
      canProveAbsence: false,
      cursor: 3,
      enableQuery: true,
      hasMore: false,
      isLimited: true,
    });
    expect(page.items).toHaveLength(1);
    expect(observeTikTokStudioContentListTarget(page, {
      description: DESCRIPTION,
      itemId: ITEM_ID,
    })).toMatchObject({ kind: "present", item: { itemId: ITEM_ID, description: DESCRIPTION } });
    expect(observeTikTokStudioContentListTarget(page, {
      description: "Different caption",
      itemId: ITEM_ID,
    })).toEqual({ kind: "binding-mismatch", observedDescription: DESCRIPTION });
  });

  test("never promotes content-list nonappearance to deletion proof", () => {
    const limited = parseTikTokStudioContentListEnvelope(successEnvelope({ item_list: [] }));
    expect(observeTikTokStudioContentListTarget(limited, {
      description: DESCRIPTION,
      itemId: ITEM_ID,
    })).toEqual({
      absenceProven: false,
      kind: "absence-unproven",
      reason: "limited-response",
    });

    const more = parseTikTokStudioContentListEnvelope(successEnvelope({
      has_more: true,
      is_limited: false,
      item_list: [],
    }));
    expect(observeTikTokStudioContentListTarget(more, {
      description: DESCRIPTION,
      itemId: ITEM_ID,
    })).toEqual({
      absenceProven: false,
      kind: "absence-unproven",
      reason: "additional-page-required",
    });

    const complete = parseTikTokStudioContentListEnvelope(successEnvelope({
      has_more: false,
      is_limited: false,
      item_list: [],
    }));
    expect(observeTikTokStudioContentListTarget(complete, {
      description: DESCRIPTION,
      itemId: ITEM_ID,
    })).toEqual({
      absenceProven: false,
      kind: "absence-unproven",
      reason: "list-is-not-a-tombstone",
    });
  });

  test("fails closed on envelope, item, permission, and identity drift", () => {
    expect(() => parseTikTokStudioContentListEnvelope({
      ...successEnvelope(),
      actor: { id: "not-reviewed" },
    })).toThrow("changed its reviewed fields");
    expect(() => parseTikTokStudioContentListEnvelope(successEnvelope({
      item_list: [normalItem({ project_id: "not-reviewed" })],
    }))).toThrow("changed its reviewed fields");
    expect(() => parseTikTokStudioContentListEnvelope(successEnvelope({
      item_list: [normalItem({
        permissions: { ...permissions(), new_permission: actionPermission() },
      })],
    }))).toThrow("changed its reviewed fields");
    expect(() => parseTikTokStudioContentListEnvelope(successEnvelope({
      item_list: [normalItem({
        permissions: {
          ...permissions(),
          can_change_privacy: {
            reason: "",
            show_type: 2,
            visibility_options: {
              visibility_available_for_ads: visibilityPermission(),
              visibility_everyone: visibilityPermission(),
              visibility_followers: visibilityPermission(),
              visibility_friends: visibilityPermission(),
              visibility_only_you: visibilityPermission(),
              visibility_subscribers: visibilityPermission(),
            },
          },
        },
      })],
    }))).toThrow("changed its reviewed fields");
    expect(() => parseTikTokStudioContentListEnvelope(successEnvelope({
      status_code: 1,
      status_msg: "not successful",
    }))).toThrow("exact success");
    expect(() => parseTikTokStudioContentListEnvelope(successEnvelope({
      extra: { fatal_item_ids: [ITEM_ID], logid: "fixture", now: 1_787_555_280_000 },
    }))).toThrow("fatal item IDs");
  });

  test("rejects accessors, cycles, duplicate item IDs, and signed non-HTTPS URLs", () => {
    expect(() => parseTikTokStudioContentListEnvelope(new Proxy(successEnvelope(), {
      ownKeys() {
        throw new Error("proxy trap must not execute");
      },
    }))).toThrow("must not contain proxies");

    const getterEnvelope = successEnvelope();
    Object.defineProperty(getterEnvelope, "cursor", {
      enumerable: true,
      get: () => 0,
    });
    expect(() => parseTikTokStudioContentListEnvelope(getterEnvelope))
      .toThrow("only enumerable data properties");

    const cyclic = successEnvelope();
    cyclic.extra = cyclic;
    expect(() => parseTikTokStudioContentListEnvelope(cyclic)).toThrow("cycles");

    expect(() => parseTikTokStudioContentListEnvelope(successEnvelope({
      item_list: [normalItem(), normalItem()],
    }))).toThrow("duplicate item IDs");
    expect(() => parseTikTokStudioNormalItem(normalItem({
      play_addr: ["http://media.example.invalid/not-https"],
    }))).toThrow("absolute HTTPS URL");
  });
});
