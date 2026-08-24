import { describe, expect, test } from "bun:test";

import {
  TIKTOK_VIDEO_DURABLE_DISPATCH_ORDER,
  TIKTOK_WEB_OPERATIONS,
  bindTikTokVideoReviewedServerClock,
  buildTikTokApplyUploadInnerRequest,
  buildTikTokCommitUploadInnerRequest,
  buildTikTokPostDetailRequestProjection,
  buildTikTokProjectPublishRequestProjection,
  buildTikTokPublishedPostRecycleRequest,
  buildTikTokVideoUploadAuthRequest,
  parseTikTokPostDetailDeletePermissionProjection,
  parseTikTokProjectPublishProjection,
  parseTikTokProjectStatusProjection,
  parseTikTokVideoUploadTokenProjection,
  resolveTikTokVideoUploaderRegion,
  signTikTokVideoTopRequest,
  tikTokVideoReviewedSigningTime,
} from "./tiktok-web";

const POST_ID = "7491234567890123456";
const PROJECT_ID = "project-1";
const RUNTIME_TIME_ZONE = "America/Puerto_Rico";

function deletePermission(
  index: number,
  recyclable?: boolean,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    biz_reason: index,
    biz_status: index % 3,
    biz_type: index + 100,
    ...(recyclable === undefined ? {} : { is_recyclable: recyclable }),
  });
}

function visibilityPermission(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    available_for_ads: 1,
    everyone: 1,
    followers: 1,
    friends: 1,
    only_you: 1,
    sub_only: 1,
    ...overrides,
  });
}

function postDetailPermission(
  bizPermissions: readonly Readonly<Record<string, unknown>>[],
  visibility: Readonly<Record<string, unknown>> = visibilityPermission(),
): unknown {
  return {
    edit_post_info: {
      edit_post_permission: {
        biz_permissions: bizPermissions,
        visibility_permission: visibility,
      },
    },
  };
}

function uploadAuth(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  const token = (
    spaceName: "tt_audio_mode" | "tiktok-ai-frame" | "tiktok",
    tokenOverrides: Readonly<Record<string, unknown>> = {},
  ) => ({
    access_key_id: "AKID-1",
    current_time: "2026-08-24T12:00:00Z",
    expired_time: "2026-08-24T13:00:00Z",
    secret_acess_key: "synthetic-secret-key",
    session_token: "synthetic-session-token",
    space_name: spaceName,
    ...tokenOverrides,
  });
  return {
    ak: "0123456789abcdef0123456789abcdef",
    audio_token_v5: token("tt_audio_mode"),
    auth: "synthetic-auth-envelope",
    extra: {
      fatal_item_ids: [],
      logid: "synthetic-log-id",
      now: 1_787_572_800_000,
    },
    log_pb: { impr_id: "synthetic-impression-id" },
    status_code: 0,
    status_msg: "",
    store_region: "US",
    vframe_token_v5: token("tiktok-ai-frame"),
    video_token_v5: token("tiktok", overrides),
  };
}

function projectPlan(audience: "public" | "private" | "friends") {
  return {
    allowAiRemix: false,
    allowComments: false,
    allowContentReuse: false,
    allowDuet: false,
    allowStitch: false,
    audience,
    caption: "Exact offline fixture",
    commercialContent: "none" as const,
    containsSyntheticMedia: false,
  };
}

const projectBinding = Object.freeze({
  creationId: "creation-1",
  durationSeconds: 8,
  enterPostPageFrom: "web_upload",
  posterDelay: 0,
  soundExemption: 0 as const,
  videoId: "video-1",
});

describe("TikTok pinned uploader region and clock foundations", () => {
  test("maps lowercase ttp regions to US-TTP without hardcoding caller-selected hosts", () => {
    expect(resolveTikTokVideoUploaderRegion("ttp")).toEqual({
      publicRegion: "ttp",
      signingRegion: "US-TTP",
      targetIdc: null,
      useServerCurrentTime: true,
      videoUrl: "https://www.tiktok.com/top/v1",
    });
    expect(resolveTikTokVideoUploaderRegion("ttp2")).toEqual({
      publicRegion: "ttp2",
      signingRegion: "US-TTP",
      targetIdc: "useast8",
      useServerCurrentTime: true,
      videoUrl: "https://www.tiktok.com/top/v1",
    });
    for (const value of ["TTP", "TTP2", "us-east-1", "US-TTP", "unknown", null]) {
      expect(() => resolveTikTokVideoUploaderRegion(value)).toThrow("not bundle-proven");
    }
  });

  test("uses the exact read-only upload-auth query and signs TTP2 VOD requests", () => {
    expect(buildTikTokVideoUploadAuthRequest()).toEqual({
      method: "GET",
      path: "/api/v1/video/upload/auth/",
      query: { aid: "1988" },
    });
    expect(buildTikTokVideoUploadAuthRequest()).not.toHaveProperty("headers");
    expect(buildTikTokApplyUploadInnerRequest({
      fileSize: 1_000_000,
      nonce: "nonce_123456",
      publicRegion: "ttp",
    }).query).toMatchObject({ "X-Amz-Expires": "604800" });
    expect(buildTikTokApplyUploadInnerRequest({
      fileSize: 1_000_000,
      nonce: "nonce_123456",
      publicRegion: "ttp",
    }).query).not.toHaveProperty("tt-target-idc");
    expect(buildTikTokApplyUploadInnerRequest({
      fileSize: 1_000_000,
      nonce: "nonce_123456",
      publicRegion: "ttp2",
    }).query).toMatchObject({
      "X-Amz-Expires": "604800",
      "tt-target-idc": "useast8",
    });
    expect(buildTikTokCommitUploadInnerRequest("session-1", "ttp").query)
      .toMatchObject({ "X-Amz-Expires": "604800" });
    expect(buildTikTokCommitUploadInnerRequest("session-1", "ttp").query)
      .not.toHaveProperty("tt-target-idc");
    expect(buildTikTokCommitUploadInnerRequest("session-1", "ttp2").query)
      .toMatchObject({
        "X-Amz-Expires": "604800",
        "tt-target-idc": "useast8",
      });
  });

  test("strictly parses the full auth envelope and reviewed UTC-second clocks", () => {
    expect(parseTikTokVideoUploadTokenProjection(uploadAuth())).toEqual({
      accessKeyId: "AKID-1",
      clockState: "reviewed-utc-second",
      expiresAtIso: "2026-08-24T13:00:00.000Z",
      secretAccessKey: "synthetic-secret-key",
      serverCurrentTimeIso: "2026-08-24T12:00:00.000Z",
      sessionToken: "synthetic-session-token",
    });
    for (const value of [
      null,
      {},
      [],
      Number.NaN,
      "",
      "bad\nclock",
      "2026-08-24T12:00:00.000Z",
      "2026-02-29T12:00:00Z",
    ]) {
      expect(() => parseTikTokVideoUploadTokenProjection(uploadAuth({
        current_time: value,
      }))).toThrow();
    }
    expect(() => parseTikTokVideoUploadTokenProjection({
      ...(uploadAuth() as Record<string, unknown>),
      unreviewed: true,
    })).toThrow("bundle-proven fields");
    expect(() => parseTikTokVideoUploadTokenProjection({
      ...(uploadAuth() as Record<string, unknown>),
      status_code: 1,
    })).toThrow("exact success");
    expect(() => parseTikTokVideoUploadTokenProjection({
      ...(uploadAuth() as Record<string, unknown>),
      store_region: "useast8",
    })).toThrow("store_region");
  });

  test("models the SDK's first server-time gap without freezing issue time", () => {
    const ignored = bindTikTokVideoReviewedServerClock({
      localAcquiredAtIso: "2026-08-24T12:00:00.000Z",
      serverCurrentTimeIso: "2026-08-24T12:00:59.000Z",
      useServerCurrentTime: true,
    });
    expect(ignored.systemTimeGapMs).toBe(0);
    const applied = bindTikTokVideoReviewedServerClock({
      localAcquiredAtIso: "2026-08-24T12:00:00.000Z",
      serverCurrentTimeIso: "2026-08-24T12:01:01.000Z",
      useServerCurrentTime: true,
    });
    expect(applied.systemTimeGapMs).toBe(61_000);
    expect(tikTokVideoReviewedSigningTime(
      applied,
      "2026-08-24T12:05:00.000Z",
    )).toBe("2026-08-24T12:06:01.000Z");
    expect(() => bindTikTokVideoReviewedServerClock({
      localAcquiredAtIso: "2026-08-24T12:00:00Z",
      serverCurrentTimeIso: "2026-08-24T12:00:00.000Z",
      useServerCurrentTime: true,
    })).toThrow("exact reviewed ISO instant");
    expect(() => bindTikTokVideoReviewedServerClock({
      localAcquiredAtIso: "2026-08-24T12:00:00.000Z",
      serverCurrentTimeIso: "2026-08-24T12:00:00.000Z",
      useServerCurrentTime: false,
    })).toThrow("useServerCurrentTime true");
  });
});

describe("TikTok deterministic SigV4 and upload projections", () => {
  test("signs only a fixed ttp2 ApplyUploadInner request with US-TTP scope", () => {
    const token = parseTikTokVideoUploadTokenProjection(uploadAuth());
    const signed = signTikTokVideoTopRequest({
      publicRegion: "ttp2",
      request: { kind: "apply", fileSize: 1_000_000, nonce: "nonce_123456" },
      reviewedSigningTimeIso: "2026-08-24T12:06:01.000Z",
      token,
    });
    expect(signed.signingTimeUnixMs).toBe(1_787_573_161_000);
    expect(signed.url).toStartWith("https://www.tiktok.com/top/v1?");
    const url = new URL(signed.url);
    expect(url.origin).toBe("https://www.tiktok.com");
    expect(url.pathname).toBe("/top/v1");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      Action: "ApplyUploadInner",
      "X-Amz-Expires": "604800",
      "tt-target-idc": "useast8",
    });
    expect(signed.headers["x-amz-date"]).toBe("20260824T120601Z");
    expect(signed.headers.authorization).toContain(
      "/20260824/US-TTP/vod/aws4_request",
    );
    expect(signed.headers.authorization).toContain(
      "SignedHeaders=x-amz-date;x-amz-security-token",
    );
    expect(signed.bodyText).toBeNull();
    expect(signTikTokVideoTopRequest({
      publicRegion: "ttp2",
      request: { kind: "apply", fileSize: 1_000_000, nonce: "nonce_123456" },
      reviewedSigningTimeIso: "2026-08-24T12:06:01.000Z",
      token,
    })).toEqual(signed);
  });

  test("signs the exact GetMeta commit body and rejects request drift", () => {
    const token = parseTikTokVideoUploadTokenProjection(uploadAuth());
    expect(buildTikTokCommitUploadInnerRequest("session-1", "ttp").body).toEqual({
      SessionKey: "session-1",
      Functions: [{ name: "GetMeta" }],
    });
    const signed = signTikTokVideoTopRequest({
      publicRegion: "ttp2",
      request: { kind: "commit", sessionKey: "session-1" },
      reviewedSigningTimeIso: "2026-08-24T12:06:01.000Z",
      token,
    });
    expect(JSON.parse(signed.bodyText!)).toEqual({
      SessionKey: "session-1",
      Functions: [{ name: "GetMeta" }],
    });
    expect(Object.fromEntries(new URL(signed.url).searchParams)).toMatchObject({
      Action: "CommitUploadInner",
      "X-Amz-Expires": "604800",
      "tt-target-idc": "useast8",
    });
    expect(signed.headers).toHaveProperty("x-amz-content-sha256");
    expect(signed.headers.authorization).toContain(
      "SignedHeaders=x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
    expect(() => signTikTokVideoTopRequest({
      publicRegion: "ttp2",
      request: {
        kind: "apply",
        fileSize: 1_000_000,
        nonce: "nonce_123456",
        extra: true,
      } as never,
      reviewedSigningTimeIso: "2026-08-24T12:06:01.000Z",
      token,
    })).toThrow("bundle-proven fields");
    expect(() => signTikTokVideoTopRequest({
      publicRegion: "us-east-1",
      request: { kind: "commit", sessionKey: "session-1" },
      reviewedSigningTimeIso: "2026-08-24T12:06:01.000Z",
      token,
    })).toThrow("not bundle-proven");
  });
});

describe("TikTok project, detail, and recycle projections", () => {
  test("uses the current visibility_type field and proven enum mapping", () => {
    for (const [audience, visibilityType] of [
      ["public", 0],
      ["private", 1],
      ["friends", 2],
    ] as const) {
      const request = buildTikTokProjectPublishRequestProjection(
        projectPlan(audience),
        projectBinding,
        {
          publicRegion: "ttp2",
          resolvedTimeZone: RUNTIME_TIME_ZONE,
        },
      );
      expect(request).toMatchObject({
        method: "POST",
        path: "/tiktok/web/project/post/v1/",
        query: {
          app_name: "tiktok_web",
          channel: "tiktok_web",
          device_platform: "web",
          tz_name: RUNTIME_TIME_ZONE,
          aid: "1988",
          "tt-target-idc": "useast8",
        },
        runtimeSecurity: {
          acrawler: "required",
          antiCsrf: "not-listed-for-route",
          credentials: "include",
          csrfHeader: "not-explicit-for-route",
          execution: "authenticated-in-origin-studio-session",
          verifyFp: "not-requested-by-base-query",
          zti: "ab-gated",
        },
      });
      const features = request.body?.feature_common_info_list as readonly Record<string, unknown>[];
      const privacy = features[0]?.privacy_setting_info as Record<string, unknown>;
      expect(privacy.visibility_type).toBe(visibilityType);
      expect(privacy).not.toHaveProperty("visibility");
    }
    expect(() => buildTikTokProjectPublishRequestProjection(
      projectPlan("private"),
      projectBinding,
      { publicRegion: "ttp", resolvedTimeZone: "America/Not_A_Zone" },
    )).toThrow("recognized IANA name");
    expect(() => buildTikTokProjectPublishRequestProjection(
      projectPlan("private"),
      projectBinding,
      {
        publicRegion: "ttp",
        resolvedTimeZone: RUNTIME_TIME_ZONE,
        verifyFp: "caller-proof",
      } as never,
    )).toThrow("bundle-proven fields");
  });

  test("binds one exact successful project result and rejects per-post drift", () => {
    expect(parseTikTokProjectPublishProjection({
      project_id: PROJECT_ID,
      single_post_resp_list: [{
        batch_index: 0,
        item_id: POST_ID,
        status_code: 0,
      }],
      status_code: 0,
    })).toEqual({ batchIndex: 0, postId: POST_ID, projectId: PROJECT_ID });
    for (const item of [
      { batch_index: 1, item_id: POST_ID, status_code: 0 },
      { batch_index: 0, item_id: POST_ID, status_code: 1 },
      { batch_index: 0, item_id: "bad", status_code: 0 },
      { batch_index: 0, item_id: POST_ID, status_code: 0, extra: true },
    ]) {
      expect(() => parseTikTokProjectPublishProjection({
        project_id: PROJECT_ID,
        single_post_resp_list: [item],
        status_code: 0,
      })).toThrow();
    }
  });

  test.each([
    [0, "unknown"],
    [1, "posting"],
    [2, "success"],
    [3, "failed"],
    [4, "vediting"],
  ] as const)("parses project state %i as %s without fabricating absence", (code, state) => {
    const taskState = code === 0
      ? "unknown"
      : code === 1
        ? "posting"
        : code === 2
          ? "success"
          : "failed";
    expect(parseTikTokProjectStatusProjection({
      project_status: code,
      task_list: [{ item_id: POST_ID, task_status: Math.min(code, 3) }],
    }, POST_ID)).toEqual({
      state,
      tasks: [{
        postId: POST_ID,
        state: taskState,
      }],
    });
  });

  test("rejects project task ID switches, state drift, and extra fields", () => {
    expect(() => parseTikTokProjectStatusProjection({
      project_status: 2,
      task_list: [{ item_id: "7491234567890123457", task_status: 2 }],
    }, POST_ID)).toThrow("switched the accepted post ID");
    expect(() => parseTikTokProjectStatusProjection({
      project_status: 5,
      task_list: [{ task_status: 0 }],
    })).toThrow("between 0 and 4");
    expect(() => parseTikTokProjectStatusProjection({
      project_status: 2,
      task_list: [{ task_status: 4 }],
    })).toThrow("between 0 and 3");
    expect(() => parseTikTokProjectStatusProjection({
      project_status: 2,
      task_list: [{ task_status: 2, extra: true }],
    })).toThrow("bundle-proven fields");
  });

  test("extracts only recyclable permission from exact detail and keeps mutations inert", () => {
    expect(buildTikTokPostDetailRequestProjection(POST_ID, RUNTIME_TIME_ZONE)).toEqual({
      method: "GET",
      path: "/api/v1/post/detail/",
      query: {
        tz_name: RUNTIME_TIME_ZONE,
        item_id: POST_ID,
        aid: "1988",
      },
    });
    expect(parseTikTokPostDetailDeletePermissionProjection(postDetailPermission([
      deletePermission(1),
      deletePermission(2, true),
      deletePermission(3, false),
    ]))).toEqual({ recyclable: true });
    expect(parseTikTokPostDetailDeletePermissionProjection(postDetailPermission([
      deletePermission(1),
      deletePermission(2, false),
    ]))).toEqual({ recyclable: false });
    expect(() => parseTikTokPostDetailDeletePermissionProjection({})).toThrow(
      "bundle-proven fields",
    );
    expect(() => parseTikTokPostDetailDeletePermissionProjection({
      edit_post_info: {
        edit_post_permission: {
          biz_permissions: [deletePermission(1)],
        },
      },
    })).toThrow("bundle-proven fields");
    expect(() => parseTikTokPostDetailDeletePermissionProjection(postDetailPermission(
      [deletePermission(1)],
      visibilityPermission({ unknown: 1 }),
    ))).toThrow("bundle-proven fields");
    expect(() => parseTikTokPostDetailDeletePermissionProjection(postDetailPermission(
      [deletePermission(1)],
      visibilityPermission({ friends: 1.5 }),
    ))).toThrow("friends must be an integer");
    expect(() => parseTikTokPostDetailDeletePermissionProjection(postDetailPermission([
      { ...deletePermission(1), biz_type: "100" },
    ]))).toThrow("biz_type must be an integer");
    const recycle = buildTikTokPublishedPostRecycleRequest({
      postId: POST_ID,
      projectId: PROJECT_ID,
      recyclable: true,
    });
    expect(recycle).toEqual({
      body: {
        aweme_id: POST_ID,
        project_id: PROJECT_ID,
        scene: 1,
        delete: { delete_type: 1 },
      },
      method: "POST",
      path: "/tiktok/post/edit/v1/",
      query: {},
    });
    expect(buildTikTokPublishedPostRecycleRequest({
      postId: POST_ID,
      projectId: undefined,
      recyclable: true,
    })).toEqual({
      body: {
        aweme_id: POST_ID,
        scene: 1,
        delete: { delete_type: 1 },
      },
      method: "POST",
      path: "/tiktok/post/edit/v1/",
      query: {},
    });
    expect(TIKTOK_WEB_OPERATIONS["media.publish"].state).toBe("capture-required");
    expect(TIKTOK_WEB_OPERATIONS["content.delete"].state).toBe("capture-required");
    expect(TIKTOK_VIDEO_DURABLE_DISPATCH_ORDER).toEqual([
      "beforeDispatch",
      "ApplyUploadInner",
      "TOS.init",
      "TOS.transfer",
      "TOS.finish",
      "CommitUploadInner",
      "transcode.enable-if-required",
      "transcode.result-until-terminal-if-required",
      "project.publish",
      "project.status-until-terminal",
    ]);
  });
});
