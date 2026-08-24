import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import type { BrowserFileResolver } from "../browser";
import type { OperationInput } from "../model";
import type { WebSessionOperationDeadline } from "../web-session-execution";
import {
  TIKTOK_PROJECT_STATUS_POLL_POLICY,
  TIKTOK_TOS_PART_BYTES,
  TIKTOK_VIDEO_TRANSCODE_POLL_INTERVAL_MS,
  TIKTOK_VIDEO_TRANSCODE_POLL_TIMEOUT_MS,
  buildTikTokApplyUploadInnerRequest,
  buildTikTokCommitUploadInnerRequest,
  buildTikTokPostDetailRequestProjection,
  buildTikTokProjectStatusRequestProjection,
  buildTikTokPublishedPostDeleteBody,
  buildTikTokTosFinishRequest,
  buildTikTokTosInitRequest,
  buildTikTokTosTransferRequest,
  buildTikTokVideoProjectPayloadProjection,
  buildTikTokVideoTranscodeEnableRequestProjection,
  buildTikTokVideoTranscodeResultRequestProjection,
  buildTikTokVideoUploadAuthRequest,
  parseTikTokApplyUploadResultProjection,
  parseTikTokCommitUploadResultProjection,
  parseTikTokDeletePermissionProjection,
  parseTikTokTosFinishResponse,
  parseTikTokTosInitResponse,
  parseTikTokTosTransferResponse,
  parseTikTokVideoUploadTokenProjection,
  planTikTokTosPartIntegrity,
  planTikTokTosParts,
  resolveTikTokVideoTranscodeState,
  tikTokTosCrc32,
  tiktokWebSanitizedPublishCaptureEvidenceSnapshot,
  tiktokWebStudioBundleEvidenceSnapshot,
  tiktokWebStudioSecurityEvidenceSnapshot,
  verifyTikTokTosCompletedTransfer,
} from "./tiktok-web";
import {
  materializeTikTokVideoPublishInput,
  prepareTikTokPublishedPostDeleteInput,
  revalidateTikTokVideoPublishBindingForDispatch,
} from "./tiktok-web-runtime";

const POST_ID = "7491234567890123456";
const PROJECT_ID = "project-1";
const RUNTIME_TIME_ZONE = "America/Puerto_Rico";
const SUBJECT_ID = "7123456789012345678";

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

function uploadAuth(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  const token = (
    spaceName: "tt_audio_mode" | "tiktok-ai-frame" | "tiktok",
    tokenOverrides: Readonly<Record<string, unknown>> = {},
  ) => ({
    access_key_id: "AKID-1",
    current_time: "2026-08-24T12:00:00Z",
    expired_time: "2026-08-24T13:00:00Z",
    secret_acess_key: "synthetic-secret",
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

const IDENTITY_MATRIX = Object.freeze([
  0x0001_0000,
  0,
  0,
  0,
  0x0001_0000,
  0,
  0,
  0,
  0x4000_0000,
] as const);

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

function mp4Fixture(
  majorBrand = "isom",
  compatibleBrands: readonly string[] = ["isom", "iso2"],
): Buffer {
  const ftyp = Buffer.alloc(8 + compatibleBrands.length * 4);
  ftyp.write(majorBrand, 0, 4, "ascii");
  ftyp.writeUInt32BE(0x200, 4);
  for (const [index, brand] of compatibleBrands.entries()) {
    ftyp.write(brand, 8 + index * 4, 4, "ascii");
  }
  const track = Buffer.alloc(84);
  const matrixOffset = 40;
  for (const [index, value] of IDENTITY_MATRIX.entries()) {
    track.writeUInt32BE(value, matrixOffset + index * 4);
  }
  track.writeUInt32BE(640 * 65_536, 76);
  track.writeUInt32BE(360 * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  const mediaHeader = Buffer.alloc(24);
  mediaHeader.writeUInt32BE(1_000, 12);
  mediaHeader.writeUInt32BE(12_345, 16);
  return Buffer.concat([
    isoBox("ftyp", ftyp),
    isoBox(
      "moov",
      isoBox(
        "trak",
        isoBox("tkhd", track),
        isoBox(
          "mdia",
          isoBox("hdlr", handler),
          isoBox("mdhd", mediaHeader),
        ),
      ),
    ),
    isoBox("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
}

function publishInput(overrides: Readonly<Record<string, unknown>> = {}): OperationInput {
  return {
    allow_ai_remix: false,
    allow_comments: false,
    allow_content_reuse: false,
    allow_duet: false,
    allow_stitch: false,
    audience: "private",
    caption: "Exact temporary fixture",
    commercial_content: "none",
    contains_synthetic_media: false,
    media: { kind: "file", reference: "plan-tiktok-video-1" },
    ...overrides,
  } as OperationInput;
}

async function withFixture<T>(
  bytes: Uint8Array,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "wrench-tiktok-video-test-"));
  const path = join(directory, "fixture.mp4");
  await writeFile(path, bytes);
  try {
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function applyProjection(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    InnerUploadAddress: {
      UploadNodes: [{
        StoreInfos: [{
          Auth: "synthetic-upload-authorization",
          StoreUri: "tos-maliva-v-0068/object-1",
          UploadID: "upload-1",
        }],
        UploadHost: "https://tos16-up-useast8.tiktokcdn-us.com",
        SessionKey: "session-1",
        UploadHeader: "{}",
        ...overrides,
      }],
    },
  };
}

function tosNode() {
  return parseTikTokApplyUploadResultProjection(applyProjection()).primary;
}

describe("TikTok Studio first-party bundle foundations", () => {
  test("retains route and state-machine evidence without dispatch credentials", () => {
    expect(tiktokWebStudioBundleEvidenceSnapshot).toMatchObject({
      role: "bundle-evidence-only",
      observedOn: "2026-08-22",
      upload: {
        auth: "GET /api/v1/video/upload/auth/",
        partBytes: TIKTOK_TOS_PART_BYTES,
      },
      publish: {
        create: "POST /tiktok/web/project/post/v1/",
        status: "GET /tiktok/web/project/status/v1/",
      },
      deletion: {
        detail: "GET /api/v1/post/detail/ item_id={post-id}",
        mutate: "POST /tiktok/post/edit/v1/ scene=1",
      },
    });
    const serialized = JSON.stringify(tiktokWebStudioBundleEvidenceSnapshot);
    expect(serialized).not.toContain("sessionid=");
    expect(serialized).not.toContain("Authorization:");
    expect(serialized).not.toContain("X-Bogus=");
  });

  test("retains only secret-free in-origin proof and interception requirements", () => {
    expect(tiktokWebStudioSecurityEvidenceSnapshot).toEqual({
      schemaVersion: 1,
      role: "bundle-evidence-only",
      observedOn: "2026-08-24",
      aid: 1988,
      baseQuery: {
        aid: "1988",
        ttp2TargetIdc: "useast8",
        verifyFp: "first-profile-read-only-request-only",
      },
      acrawler: {
        intercept: true,
        mode: 513,
        paths: [
          "/api/v1/web/project/post",
          "/api/v1/item/create/bulk/",
          "/api/v1/item/create/",
          "/api/upload/search/user/",
          "/api/upload/challenge/sug/",
          "/api/post/item_list/",
          "/api/v1/user/profile/upload/",
          "/api/v1/video/upload/auth/",
          "/api/v1/draft/create_update/",
          "/tiktok/web/project/post/v1/",
          "/tiktok/web/project/cancel/v1/",
          "/tiktok/post/edit/v1/",
          "/api/user/list/",
        ],
      },
      antiCsrf: {
        host: "www.tiktok.com",
        method: "POST",
        paths: [
          "/api/v1/post_schedule/ack/",
          "/api/v1/video/transcode/enable/",
        ],
      },
      zti: {
        abGate: "creation_use_zti",
        certType: "header",
        scene: "tt_fetch",
        signVersion: 2,
        paths: [
          "/api/v1/web/project/post/",
          "/api/v1/item/create/bulk/",
          "/tiktok/web/project/post/v1/",
          "/tiktok/post/edit/v1/",
        ],
      },
    });
    const serialized = JSON.stringify(tiktokWebStudioSecurityEvidenceSnapshot);
    expect(serialized).not.toContain("tt-csrf-token\":");
    expect(serialized).not.toContain("caller-proof");
  });

  test("retains sanitized success evidence only as a fail-closed structural boundary", () => {
    expect(tiktokWebSanitizedPublishCaptureEvidenceSnapshot).toMatchObject({
      role: "structural-live-evidence-only",
      observedOn: "2026-08-23",
      targetOrigin: "https://www.tiktok.com",
      observedEntries: 1_344,
      writeCandidateCount: 5,
      writeCandidateSamples: 8,
    });
    expect(tiktokWebSanitizedPublishCaptureEvidenceSnapshot.remoteOrigins).toEqual([
      "https://lf16-tiktok-web.tiktokcdn-us.com",
      "https://lf16-cdn-tos.tiktokcdn-us.com",
      "https://tos16-up-useast8.tiktokcdn-us.com",
      "https://tos19-up-useast8.tiktokcdn-us.com",
    ]);
    expect(tiktokWebSanitizedPublishCaptureEvidenceSnapshot.observedUploadOrigins).toEqual([
      "https://tos16-up-useast8.tiktokcdn-us.com",
      "https://tos19-up-useast8.tiktokcdn-us.com",
    ]);
    expect(tiktokWebSanitizedPublishCaptureEvidenceSnapshot.unresolvedForDispatch)
      .toContain("current account, project, post, and audience response binding");
  });

  test("builds fixed upload/auth, apply, commit, and status route projections", () => {
    expect(buildTikTokVideoUploadAuthRequest()).toEqual({
      method: "GET",
      path: "/api/v1/video/upload/auth/",
      query: { aid: "1988" },
    });
    expect(buildTikTokApplyUploadInnerRequest({
      fileSize: 6_291_457,
      nonce: "nonce_123456",
      publicRegion: "ttp2",
    })).toEqual({
      method: "GET",
      path: "/top/v1",
      query: {
        Action: "ApplyUploadInner",
        Version: "2020-11-19",
        SpaceName: "tiktok",
        FileType: "video",
        IsInner: "1",
        FileSize: "6291457",
        "X-Amz-Expires": "604800",
        "tt-target-idc": "useast8",
        s: "nonce_123456",
        device_platform: "web",
        business_tag: "tiktok_video_submission_web",
      },
    });
    expect(buildTikTokCommitUploadInnerRequest("session-1", "ttp2")).toEqual({
      method: "POST",
      path: "/top/v1",
      query: {
        Action: "CommitUploadInner",
        Version: "2020-11-19",
        SpaceName: "tiktok",
        "X-Amz-Expires": "604800",
        "tt-target-idc": "useast8",
      },
      body: { SessionKey: "session-1", Functions: [{ name: "GetMeta" }] },
    });
    expect(buildTikTokProjectStatusRequestProjection("project-1", "ttp2")).toEqual({
      method: "GET",
      path: "/tiktok/web/project/status/v1/",
      query: {
        project_id: "project-1",
        aid: "1988",
        "tt-target-idc": "useast8",
      },
      runtimeSecurity: {
        acrawler: "not-listed-for-route",
        antiCsrf: "not-listed-for-route",
        credentials: "include",
        csrfHeader: "not-explicit-for-route",
        execution: "authenticated-in-origin-studio-session",
        verifyFp: "not-requested-by-base-query",
        zti: "not-listed-for-route",
      },
    });
    expect(() => buildTikTokApplyUploadInnerRequest({
      fileSize: 0,
      nonce: "nonce_123456",
      publicRegion: "ttp2",
    }))
      .toThrow("fileSize");
    expect(() => buildTikTokApplyUploadInnerRequest({
      fileSize: 100,
      nonce: "../escape",
      publicRegion: "ttp2",
    }))
      .toThrow("nonce");
    expect(buildTikTokApplyUploadInnerRequest({
      fileSize: 128 * 1024 * 1024,
      nonce: "nonce_123456",
      publicRegion: "ttp",
    }).query.FileSize).toBe(String(128 * 1024 * 1024));
    expect(() => buildTikTokApplyUploadInnerRequest({
      fileSize: 128 * 1024 * 1024 + 1,
      nonce: "nonce_123456",
      publicRegion: "ttp2",
    })).toThrow("between 24 and 134217728");
    expect(() => buildTikTokProjectStatusRequestProjection("bad\rproject", "ttp"))
      .toThrow("bounded string");
  });

  test("strictly projects temporary STS credentials and explicit upload nodes", () => {
    expect(parseTikTokVideoUploadTokenProjection(uploadAuth())).toEqual({
      accessKeyId: "AKID-1",
      clockState: "reviewed-utc-second",
      expiresAtIso: "2026-08-24T13:00:00.000Z",
      secretAccessKey: "synthetic-secret",
      serverCurrentTimeIso: "2026-08-24T12:00:00.000Z",
      sessionToken: "synthetic-session-token",
    });
    expect(parseTikTokApplyUploadResultProjection(applyProjection())).toEqual({
      primary: {
        authorization: "synthetic-upload-authorization",
        sessionKey: "session-1",
        storeUri: "tos-maliva-v-0068/object-1",
        uploadHost: "https://tos16-up-useast8.tiktokcdn-us.com",
        uploadId: "upload-1",
      },
      fallback: null,
    });
    expect(() => parseTikTokVideoUploadTokenProjection(uploadAuth({
      expired_time: "2026-08-24T11:59:59Z",
    }))).toThrow("expire after");
    expect(() => parseTikTokVideoUploadTokenProjection(uploadAuth({
      unreviewed: true,
    }))).toThrow("bundle-proven fields");
    expect(() => parseTikTokApplyUploadResultProjection(applyProjection({
      UploadHeader: '{"X-Caller-Selected":"no"}',
    }))).toThrow("reviewed empty header object");
    for (const UploadHost of [
      "https://evil.example",
      "https://tos16-up-useast8.tiktokcdn-us.com.evil.example",
      "https://www.tiktok.com",
      "https://user@tos16-up-useast8.tiktokcdn-us.com",
      "https://tos16-up-useast8.tiktokcdn-us.com/upload",
    ]) {
      expect(() => parseTikTokApplyUploadResultProjection(applyProjection({ UploadHost })))
        .toThrow();
    }
  });

  test("plans fixed contiguous 3 MiB parts and binds every CRC acknowledgement", () => {
    const parts = planTikTokTosParts(TIKTOK_TOS_PART_BYTES * 2 + 7);
    const node = tosNode();
    expect(parts).toEqual([
      { partNumber: 1, byteOffset: 0, byteLength: TIKTOK_TOS_PART_BYTES },
      { partNumber: 2, byteOffset: TIKTOK_TOS_PART_BYTES, byteLength: TIKTOK_TOS_PART_BYTES },
      { partNumber: 3, byteOffset: TIKTOK_TOS_PART_BYTES * 2, byteLength: 7 },
    ]);
    expect(tikTokTosCrc32(new TextEncoder().encode("123456789"))).toBe("cbf43926");
    expect(buildTikTokTosInitRequest({ node, subjectId: SUBJECT_ID })).toEqual({
      headers: {
        Authorization: "synthetic-upload-authorization",
        "X-Storage-U": SUBJECT_ID,
      },
      method: "POST",
      origin: "https://tos16-up-useast8.tiktokcdn-us.com",
      path: "/upload/v1/tos-maliva-v-0068/object-1",
      query: { uploadmode: "part", phase: "init" },
    });
    expect(buildTikTokTosTransferRequest({
      node,
      subjectId: SUBJECT_ID,
      uploadId: "upload-1",
      part: parts[1]!,
      crc32: "CBF43926",
    })).toEqual({
      headers: {
        Authorization: "synthetic-upload-authorization",
        "X-Storage-U": SUBJECT_ID,
        "Content-CRC32": "cbf43926",
      },
      method: "POST",
      origin: "https://tos16-up-useast8.tiktokcdn-us.com",
      path: "/upload/v1/tos-maliva-v-0068/object-1",
      query: {
        uploadid: "upload-1",
        part_number: "2",
        phase: "transfer",
        part_offset: String(TIKTOK_TOS_PART_BYTES),
      },
    });
    expect(buildTikTokTosFinishRequest({
      byteLength: TIKTOK_TOS_PART_BYTES * 2 + 7,
      node,
      subjectId: SUBJECT_ID,
      uploadId: "upload-1",
    })).toEqual({
      headers: {
        Authorization: "synthetic-upload-authorization",
        "X-Storage-U": SUBJECT_ID,
      },
      method: "POST",
      origin: "https://tos16-up-useast8.tiktokcdn-us.com",
      path: "/upload/v1/tos-maliva-v-0068/object-1",
      query: {
        uploadmode: "part",
        phase: "finish",
        size: String(TIKTOK_TOS_PART_BYTES * 2 + 7),
        uploadid: "upload-1",
      },
    });
    expect(parseTikTokTosInitResponse({ code: 2000, data: { uploadid: "upload-1" } }))
      .toEqual({ uploadId: "upload-1" });
    expect(parseTikTokTosTransferResponse({
      code: 2000,
      data: { crc32: "cbf43926" },
    }, "cbf43926")).toEqual({ crc32: "cbf43926" });
    expect(parseTikTokTosFinishResponse({ code: 2000, data: { key: "object-key-1" } }))
      .toEqual({ key: "object-key-1" });
    expect(() => parseTikTokTosTransferResponse({
      code: 2000,
      data: { crc32: "00000000" },
    }, "cbf43926")).toThrow("did not bind");
    expect(() => parseTikTokTosInitResponse({
      code: 2000,
      data: { uploadid: "upload-1", extra: true },
    })).toThrow("bundle-proven fields");
    expect(() => buildTikTokTosInitRequest({
      node: { ...node, storeUri: "object/../escape" },
      subjectId: SUBJECT_ID,
    }))
      .toThrow("provider path segments");
    expect(() => buildTikTokTosInitRequest({
      node: { ...node, uploadHost: "https://evil.example" },
      subjectId: SUBJECT_ID,
    })).toThrow("sanitized live capture");
    expect(() => buildTikTokTosInitRequest({
      node,
      subjectId: "caller-selected-user",
    })).toThrow("decimal TikTok identifier");
    expect(() => buildTikTokTosTransferRequest({
      node,
      subjectId: SUBJECT_ID,
      uploadId: "upload-1",
      part: { ...parts[0]!, extra: true } as never,
      crc32: "cbf43926",
    })).toThrow("bundle-proven fields");
    expect(planTikTokTosParts(128 * 1024 * 1024).at(-1)?.byteOffset)
      .toBeLessThan(128 * 1024 * 1024);
    expect(() => planTikTokTosParts(128 * 1024 * 1024 + 1))
      .toThrow("between 24 and 134217728");
  });

  test("binds a complete transfer checkpoint to every exact part and rejects partial recovery", () => {
    const bytes = new Uint8Array(TIKTOK_TOS_PART_BYTES + 7);
    bytes.fill(0x61);
    const parts = planTikTokTosPartIntegrity(bytes);
    expect(parts).toEqual([
      {
        partNumber: 1,
        byteOffset: 0,
        byteLength: TIKTOK_TOS_PART_BYTES,
        crc32: tikTokTosCrc32(bytes.subarray(0, TIKTOK_TOS_PART_BYTES)),
      },
      {
        partNumber: 2,
        byteOffset: TIKTOK_TOS_PART_BYTES,
        byteLength: 7,
        crc32: tikTokTosCrc32(bytes.subarray(TIKTOK_TOS_PART_BYTES)),
      },
    ]);
    const responses = parts.map((part) => ({
      code: 2000,
      data: { crc32: part.crc32 },
    }));
    const checkpoint = verifyTikTokTosCompletedTransfer(bytes, responses);
    expect(checkpoint).toMatchObject({
      byteLength: bytes.byteLength,
      mediaSha256: "7d8aedf62548b6943c912ca5192d7a2c13322cd689d7a47d4b3944b4bb2e30c6",
      parts,
    });
    expect(() => verifyTikTokTosCompletedTransfer(bytes, responses.slice(0, 1)))
      .toThrow("partial transfer remains indeterminate");
    expect(() => verifyTikTokTosCompletedTransfer(bytes, [responses[1], responses[0]]))
      .toThrow("did not bind");
    expect(() => verifyTikTokTosCompletedTransfer(bytes, [
      responses[0],
      { ...responses[1], extra: true },
    ])).toThrow("bundle-proven fields");
  });

  test("models conditional transcode enablement and bounded result polling", () => {
    expect(TIKTOK_VIDEO_TRANSCODE_POLL_INTERVAL_MS).toBe(1_000);
    expect(TIKTOK_VIDEO_TRANSCODE_POLL_TIMEOUT_MS).toBe(3_600_000);
    const enable = buildTikTokVideoTranscodeEnableRequestProjection({
      publicRegion: "ttp2",
      videoId: "video-1",
    });
    expect(enable).toEqual({
      method: "POST",
      path: "/api/v1/video/transcode/enable/",
      query: {
        video_id: "video-1",
        aid: "1988",
        "tt-target-idc": "useast8",
      },
      runtimeSecurity: {
        acrawler: "not-listed-for-route",
        antiCsrf: "required",
        credentials: "include",
        csrfHeader: "in-origin-ephemeral",
        execution: "authenticated-in-origin-studio-session",
        verifyFp: "not-requested-by-base-query",
        zti: "not-listed-for-route",
      },
    });
    expect(enable).not.toHaveProperty("headers");
    expect(buildTikTokVideoTranscodeResultRequestProjection({
      durationSeconds: 8.000_1,
      fileKey: "file-key-1",
      height: 360,
      publicRegion: "ttp",
      videoId: "video-1",
      width: 640,
    })).toEqual({
      body: {
        scene: 0,
        video_info: [{
          file_key: "file-key-1",
          video_id: "video-1",
          original_width: 640,
          original_height: 360,
          original_duration_ms: 8_001,
        }],
      },
      method: "POST",
      path: "/api/v1/video/transcode/result/",
      query: { aid: "1988" },
      runtimeSecurity: {
        acrawler: "not-listed-for-route",
        antiCsrf: "not-listed-for-route",
        credentials: "include",
        csrfHeader: "not-explicit-for-route",
        execution: "authenticated-in-origin-studio-session",
        verifyFp: "not-requested-by-base-query",
        zti: "not-listed-for-route",
      },
    });
    expect([0, 1, 2, 3, 4].map(resolveTikTokVideoTranscodeState)).toEqual([
      "unknown",
      "init",
      "in-progress",
      "success",
      "failed",
    ]);
    expect(() => resolveTikTokVideoTranscodeState(5)).toThrow("between 0 and 4");
    expect(() => buildTikTokVideoTranscodeResultRequestProjection({
      durationSeconds: Number.NaN,
      fileKey: "file-key-1",
      height: 360,
      publicRegion: "ttp",
      videoId: "video-1",
      width: 640,
    })).toThrow("durationSeconds must be finite");
    expect(() => buildTikTokVideoTranscodeEnableRequestProjection({
      publicRegion: "ttp",
      videoId: "video-1",
      verifyFp: "caller-proof",
    } as never)).toThrow("bundle-proven fields");
    expect(TIKTOK_PROJECT_STATUS_POLL_POLICY).toEqual({
      defaultDelayMs: 10_000,
      maxPostingObservations: 50,
      plainVideoInitialDelaysMs: [0, 1_000, 1_000, 1_000, 1_000],
      videoEditedInitialDelaysMs: [10_000, 5_000, 5_000, 5_000, 5_000],
    });
  });

  test("projects one committed video and conservative plain-video settings", () => {
    expect(parseTikTokCommitUploadResultProjection({
      Results: [{
        Vid: "video-1",
        Uri: "tos-maliva-v-0068/object-1",
        VideoMeta: {
          Width: 640,
          Height: 360,
          Duration: 61,
          Format: "mp4",
          Codec: "h264",
          Bitrate: 1_000_000,
        },
      }],
    })).toEqual({
      videoId: "video-1",
      uri: "tos-maliva-v-0068/object-1",
      width: 640,
      height: 360,
      duration: 61,
      format: "mp4",
      codec: "h264",
      bitrate: 1_000_000,
    });
    expect(buildTikTokVideoProjectPayloadProjection({
      allowAiRemix: false,
      allowComments: false,
      allowContentReuse: false,
      allowDuet: false,
      allowStitch: false,
      audience: "private",
      caption: "Exact temporary fixture",
      commercialContent: "none",
      containsSyntheticMedia: true,
    }, {
      creationId: "creation-1",
      durationSeconds: 61,
      enterPostPageFrom: "web_upload",
      posterDelay: 0,
      soundExemption: 0,
      videoId: "video-1",
    })).toMatchObject({
      post_common_info: { creation_id: "creation-1", post_type: 3 },
      feature_common_info_list: [{
        tcm_params: '{"commerce_toggle_info":{}}',
        aigc_info: { aigc_label_type: 1 },
        privacy_setting_info: {
          visibility_type: 1,
          allow_comment: 0,
          allow_duet: 0,
          allow_stitch: 0,
          allow_content_reuse: 0,
          allow_ai_remix: 2,
        },
      }],
      single_post_req_list: [{
        batch_index: 0,
        video_id: "video-1",
        is_long_video: 1,
        single_post_feature_info: {
          text: "Exact temporary fixture",
          markup_text: "Exact temporary fixture",
          poster_delay: 0,
        },
      }],
    });
  });

  test("builds only exact authored-post detail and permission-selected delete projections", () => {
    expect(buildTikTokPostDetailRequestProjection(POST_ID, RUNTIME_TIME_ZONE)).toEqual({
      method: "GET",
      path: "/api/v1/post/detail/",
      query: {
        tz_name: RUNTIME_TIME_ZONE,
        item_id: POST_ID,
        aid: "1988",
      },
    });
    expect(() => buildTikTokPostDetailRequestProjection(POST_ID, "America/Not_A_Zone"))
      .toThrow("recognized IANA name");
    expect(() => buildTikTokPostDetailRequestProjection(POST_ID, "../Puerto_Rico"))
      .toThrow("bounded IANA name");
    expect(buildTikTokPostDetailRequestProjection(POST_ID, "UTC").query.tz_name).toBe("UTC");
    expect(parseTikTokDeletePermissionProjection({
      biz_permissions: [
        deletePermission(1),
        deletePermission(2),
        deletePermission(3, true),
        ...Array.from({ length: 12 }, (_unused, index) => deletePermission(index + 4)),
      ],
    })).toEqual({ recyclable: true });
    expect(parseTikTokDeletePermissionProjection({
      biz_permissions: [deletePermission(1), deletePermission(2, false)],
    })).toEqual({ recyclable: false });
    expect(parseTikTokDeletePermissionProjection({
      biz_permissions: [deletePermission(1)],
    })).toEqual({ recyclable: false });
    expect(buildTikTokPublishedPostDeleteBody({
      postId: POST_ID,
      projectId: PROJECT_ID,
      recyclable: true,
    })).toEqual({
      aweme_id: POST_ID,
      project_id: PROJECT_ID,
      scene: 1,
      delete: { delete_type: 1 },
    });
    expect(buildTikTokPublishedPostDeleteBody({
      postId: POST_ID,
      projectId: undefined,
      recyclable: true,
    })).toEqual({
      aweme_id: POST_ID,
      scene: 1,
      delete: { delete_type: 1 },
    });
    expect(() => buildTikTokPublishedPostDeleteBody({
      postId: POST_ID,
      projectId: null,
      recyclable: true,
    })).toThrow("TikTok delete project ID must be a bounded string");
    expect(() => buildTikTokPublishedPostDeleteBody({
      postId: POST_ID,
      projectId: "not a project",
      recyclable: true,
    })).toThrow("bounded provider identifier");
    expect(() => buildTikTokPublishedPostDeleteBody({
      postId: POST_ID,
      projectId: PROJECT_ID,
      recyclable: false,
    }))
      .toThrow("requires exact is_recyclable true permission");
    expect(() => buildTikTokPublishedPostDeleteBody({
      postId: POST_ID,
      projectId: PROJECT_ID,
      recyclable: "true",
    }))
      .toThrow("requires exact is_recyclable true permission");
    expect(() => buildTikTokPublishedPostDeleteBody({
      postId: "not-a-post",
      projectId: PROJECT_ID,
      recyclable: true,
    }))
      .toThrow("decimal TikTok identifier");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [{ opaque: true }],
    })).toThrow("bundle-proven fields");
    expect(parseTikTokDeletePermissionProjection({
      biz_permissions: [deletePermission(1, true), deletePermission(2, false)],
    })).toEqual({ recyclable: true });
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [deletePermission(1, true), deletePermission(2, true)],
    })).toThrow("at most one exact true is_recyclable permission");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [{ ...deletePermission(1), is_recyclable: 1 }],
    })).toThrow("is_recyclable must be boolean");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [{ ...deletePermission(1), biz_status: -1 }],
    })).toThrow("biz_status must be an integer");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [{ ...deletePermission(1), unreviewed: true }],
    })).toThrow("bundle-proven fields");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [{ ...deletePermission(1), opaque: undefined }, deletePermission(2, true)],
    })).toThrow("must contain only JSON data");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [new Date(0), deletePermission(2, true)],
    })).toThrow("plain prototype");
  });

  test("snapshots permission JSON without invoking proxy traps or accessors", () => {
    let traps = 0;
    const trapped = new Proxy({}, {
      get() {
        traps += 1;
        throw new Error("proxy get trap ran");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("proxy descriptor trap ran");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("proxy prototype trap ran");
      },
      ownKeys() {
        traps += 1;
        throw new Error("proxy ownKeys trap ran");
      },
    });
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [trapped, deletePermission(2, true)],
    })).toThrow("must not contain proxies");
    expect(traps).toBe(0);

    let getterReads = 0;
    const accessorPermission = Object.defineProperty({}, "is_recyclable", {
      enumerable: true,
      get() {
        getterReads += 1;
        return true;
      },
    });
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [accessorPermission],
    })).toThrow("enumerable data properties");
    expect(getterReads).toBe(0);
  });

  test("rejects permission JSON before oversized structures can become dispatch evidence", () => {
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: Array.from({ length: 65 }, () => ({})),
    })).toThrow("arrays must contain at most 64 items");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [
        { opaque: "x".repeat(256 * 1024 + 1) },
        deletePermission(2, true),
      ],
    })).toThrow("oversized string");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [{ ["k".repeat(1_025)]: true }, deletePermission(2, true)],
    })).toThrow("oversized property name");
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [
        ...Array.from({ length: 5 }, () => ({ opaque: "x".repeat(220 * 1024) })),
        deletePermission(6, true),
      ],
    })).toThrow("total JSON byte bound");
    const oversizedObject = Object.fromEntries(
      Array.from({ length: 16_384 }, (_unused, index) => [`opaque_${index}`, null]),
    );
    expect(() => parseTikTokDeletePermissionProjection({
      biz_permissions: [oversizedObject, deletePermission(2, true)],
    })).toThrow("JSON structural bound");
  });
});

describe("TikTok video plan materialization", () => {
  test("materializes one exact stable plan-bound ISO BMFF MP4", async () => {
    await withFixture(mp4Fixture(), async (path) => {
      const resolver: BrowserFileResolver = (files) => {
        expect(files).toEqual([{ kind: "file", reference: "plan-tiktok-video-1" }]);
        return Promise.resolve([path]);
      };
      const result = await materializeTikTokVideoPublishInput(publishInput(), resolver);
      expect({ ...result, bytes: undefined }).toEqual({
        allowAiRemix: false,
        allowComments: false,
        allowContentReuse: false,
        allowDuet: false,
        allowStitch: false,
        audience: "private",
        bytes: undefined,
        byteLength: mp4Fixture().byteLength,
        caption: "Exact temporary fixture",
        commercialContent: "none",
        containsSyntheticMedia: false,
        durationSeconds: 12.345,
        height: 360,
        mediaType: "video/mp4",
        mediaSha256: "557b764e11e24a651d60ada3dcf4c3fb755513a0134016e2b0829b258607994c",
        width: 640,
      });
      expect(result.bytes).toEqual(new Uint8Array(mp4Fixture()));
    });
  });

  test("admits the 128 MiB sparse boundary and rejects the next byte before reading", async () => {
    const maximumBytes = 128 * 1024 * 1024;
    for (const [size, expectedRuns, expectedMessage] of [
      [maximumBytes, 4, "test blocked sparse-file read after admission"],
      [maximumBytes + 1, 3, "128 MiB in-memory publish limit"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), "wrench-tiktok-video-cap-test-"));
      const path = join(directory, "sparse.mp4");
      await writeFile(path, "");
      await truncate(path, size);
      const controller = new AbortController();
      let runs = 0;
      const deadline: WebSessionOperationDeadline = {
        signal: controller.signal,
        remainingTimeMs: () => 60_000,
        run: async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
          runs += 1;
          if (runs === 4) {
            throw new Error("test blocked sparse-file read after admission");
          }
          return work(controller.signal);
        },
        throwIfUnavailable: () => {},
      };
      try {
        await expect(materializeTikTokVideoPublishInput(
          publishInput(),
          () => Promise.resolve([path]),
          deadline,
        )).rejects.toThrow(expectedMessage);
        expect(runs).toBe(expectedRuns);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("revalidates one immutable body for a future dispatch boundary", async () => {
    const fixture = mp4Fixture();
    await withFixture(fixture, async (path) => {
      const binding = await materializeTikTokVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      );
      const checkpoint = revalidateTikTokVideoPublishBindingForDispatch(binding);
      expect({ ...checkpoint, body: undefined }).toEqual({
        allowAiRemix: binding.allowAiRemix,
        allowComments: binding.allowComments,
        allowContentReuse: binding.allowContentReuse,
        allowDuet: binding.allowDuet,
        allowStitch: binding.allowStitch,
        audience: binding.audience,
        body: undefined,
        byteLength: binding.byteLength,
        caption: binding.caption,
        commercialContent: binding.commercialContent,
        containsSyntheticMedia: binding.containsSyntheticMedia,
        durationSeconds: binding.durationSeconds,
        height: binding.height,
        mediaSha256: binding.mediaSha256,
        mediaType: binding.mediaType,
        width: binding.width,
      });
      expect(checkpoint).not.toHaveProperty("bytes");
      expect(checkpoint.body).toBeInstanceOf(Blob);
      expect(checkpoint.body.size).toBe(binding.byteLength);
      expect(checkpoint.body.type).toBe("video/mp4");
      expect(Object.isFrozen(checkpoint)).toBe(true);
      const firstBodyRead = new Uint8Array(await checkpoint.body.arrayBuffer());
      expect(firstBodyRead).toEqual(binding.bytes);
      expect(createHash("sha256").update(firstBodyRead).digest("hex"))
        .toBe(checkpoint.mediaSha256);

      const finalByte = binding.bytes.byteLength - 1;
      const snapshottedByte = binding.bytes[finalByte]!;
      fixture[finalByte] = snapshottedByte ^ 0x55;
      const bindingAlias = new Uint8Array(
        binding.bytes.buffer,
        binding.bytes.byteOffset,
        binding.bytes.byteLength,
      );
      bindingAlias[finalByte] = snapshottedByte ^ 0xff;
      firstBodyRead[finalByte] = snapshottedByte ^ 0xaa;
      expect(Reflect.set(checkpoint, "mediaSha256", "0".repeat(64))).toBe(false);
      const eventualBodyBytes = new Uint8Array(await checkpoint.body.arrayBuffer());
      expect(eventualBodyBytes[finalByte]).toBe(snapshottedByte);
      expect(createHash("sha256").update(eventualBodyBytes).digest("hex"))
        .toBe(checkpoint.mediaSha256);
      expect(() => revalidateTikTokVideoPublishBindingForDispatch(binding))
        .toThrow("changed from its exact bytes");
    });
  });

  test("rejects shared TikTok bytes despite prototype and realm spoofing", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    await withFixture(mp4Fixture(), async (path) => {
      const binding = await materializeTikTokVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      );

      const disguisedBacking = new SharedArrayBuffer(binding.byteLength);
      const disguisedBytes = new Uint8Array(disguisedBacking);
      disguisedBytes.set(binding.bytes);
      Object.setPrototypeOf(disguisedBacking, ArrayBuffer.prototype);
      expect(disguisedBacking).not.toBeInstanceOf(SharedArrayBuffer);
      expect(() => revalidateTikTokVideoPublishBindingForDispatch({
        ...binding,
        bytes: disguisedBytes,
      })).toThrow("one bounded MP4");

      const crossRealmBytes = runInNewContext(
        `new Uint8Array(new SharedArrayBuffer(${binding.byteLength}))`,
      ) as Uint8Array;
      Uint8Array.prototype.set.call(crossRealmBytes, binding.bytes);
      Object.setPrototypeOf(crossRealmBytes, Uint8Array.prototype);
      expect(crossRealmBytes).toBeInstanceOf(Uint8Array);
      expect(crossRealmBytes.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      expect(() => revalidateTikTokVideoPublishBindingForDispatch({
        ...binding,
        bytes: crossRealmBytes,
      })).toThrow("one bounded MP4");
    });
  });

  test("rejects drifted, unknown-field, and non-data dispatch bindings", async () => {
    await withFixture(mp4Fixture(), async (path) => {
      const binding = await materializeTikTokVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      );
      const cases: readonly [unknown, string][] = [
        [{ ...binding, byteLength: binding.byteLength + 1 }, "changed from its exact bytes"],
        [{ ...binding, durationSeconds: binding.durationSeconds + 1 }, "changed from its exact bytes"],
        [{ ...binding, height: binding.height + 1 }, "changed from its exact bytes"],
        [{ ...binding, mediaSha256: "0".repeat(64) }, "changed from its exact bytes"],
        [{ ...binding, width: binding.width + 1 }, "changed from its exact bytes"],
        [{ ...binding, allowComments: "false" }, "creator declarations are invalid"],
        [{ ...binding, audience: "followers" }, "creator declarations are invalid"],
        [{ ...binding, commercialContent: "branded" }, "creator declarations are invalid"],
        [{ ...binding, mediaType: "video/quicktime" }, "creator declarations are invalid"],
        [{ ...binding, extra: true }, "unsupported fields"],
        [Object.assign(Object.create(null), binding, { extra: true }), "unsupported fields"],
        [{ ...binding, [Symbol("extra")]: true }, "unsupported fields"],
        [Buffer.from(binding.bytes), "plain prototype"],
      ];
      for (const [value, message] of cases) {
        expect(() => revalidateTikTokVideoPublishBindingForDispatch(value))
          .toThrow(message);
      }

      let getterReads = 0;
      const accessorBinding = Object.defineProperty(
        { ...binding },
        "caption",
        {
          enumerable: true,
          get() {
            getterReads += 1;
            return binding.caption;
          },
        },
      );
      expect(() => revalidateTikTokVideoPublishBindingForDispatch(accessorBinding))
        .toThrow("enumerable data properties");
      expect(getterReads).toBe(0);

      let traps = 0;
      const trapped = new Proxy(binding, {
        get() {
          traps += 1;
          throw new Error("proxy trap ran");
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error("proxy trap ran");
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error("proxy trap ran");
        },
        ownKeys() {
          traps += 1;
          throw new Error("proxy trap ran");
        },
      });
      expect(() => revalidateTikTokVideoPublishBindingForDispatch(trapped))
        .toThrow("must not be a proxy");
      expect(traps).toBe(0);

      const proxiedBytes = new Proxy(binding.bytes, {
        get(target, key, receiver) {
          traps += 1;
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf(target) {
          traps += 1;
          return Reflect.getPrototypeOf(target);
        },
      });
      expect(() => revalidateTikTokVideoPublishBindingForDispatch({
        ...binding,
        bytes: proxiedBytes,
      })).toThrow("one bounded MP4");
      expect(traps).toBe(0);

      let nestedAccessorReads = 0;
      const decoratedBytes = new Uint8Array(binding.bytes);
      Object.defineProperties(decoratedBytes, {
        buffer: {
          configurable: true,
          get() {
            nestedAccessorReads += 1;
            throw new Error("caller-defined buffer getter ran");
          },
        },
        byteLength: {
          configurable: true,
          get() {
            nestedAccessorReads += 1;
            return 24;
          },
        },
      });
      Object.defineProperty(decoratedBytes, Symbol.iterator, {
        configurable: true,
        get() {
          nestedAccessorReads += 1;
          throw new Error("caller-defined iterator getter ran");
        },
      });
      const safeCheckpoint = revalidateTikTokVideoPublishBindingForDispatch({
        ...binding,
        bytes: decoratedBytes,
      });
      expect(nestedAccessorReads).toBe(0);
      expect(new Uint8Array(await safeCheckpoint.body.arrayBuffer()))
        .toEqual(binding.bytes);
    });
  });

  test("rejects ambiguous settings before resolving any file", async () => {
    const base = publishInput();
    const { audience: _audience, ...withoutAudience } = base;
    const cases: readonly [OperationInput, string][] = [
      [{ ...base, unsupported: true } as OperationInput, "unsupported or missing"],
      [withoutAudience, "unsupported or missing"],
      [publishInput({ media: { kind: "file", reference: "x", extra: true } }), "plan-bound file"],
      [publishInput({ audience: "followers" }), "public, friends, or private"],
      [publishInput({ caption: "bad\rcaption" }), "bounded text"],
      [publishInput({ allow_ai_remix: "false" }), "must be boolean"],
      [publishInput({ commercial_content: "branded" }), "explicitly be none"],
    ];
    for (const [input, message] of cases) {
      let resolutions = 0;
      await expect(materializeTikTokVideoPublishInput(input, () => {
        resolutions += 1;
        return Promise.resolve([]);
      })).rejects.toThrow(message);
      expect(resolutions).toBe(0);
    }
  });

  test("rejects non-MP4 bytes and a file whose stable identity changes", async () => {
    await withFixture(Buffer.alloc(32), async (path) => {
      await expect(materializeTikTokVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
      )).rejects.toThrow("MP4 file-type box");
    });
    await withFixture(mp4Fixture(), async (path) => {
      const controller = new AbortController();
      let runs = 0;
      const deadline: WebSessionOperationDeadline = {
        signal: controller.signal,
        remainingTimeMs: () => 60_000,
        run: async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
          runs += 1;
          const result = await work(controller.signal);
          if (runs === 4) await appendFile(path, Buffer.from([0]));
          return result;
        },
        throwIfUnavailable: () => {},
      };
      await expect(materializeTikTokVideoPublishInput(
        publishInput(),
        () => Promise.resolve([path]),
        deadline,
      )).rejects.toThrow("changed while it was materialized");
    });
  });

  test("rejects QuickTime and unknown-only file-type brands", async () => {
    const cases = [
      mp4Fixture("qt  ", ["isom"]),
      mp4Fixture("zzzz", ["yyyy"]),
    ] as const;
    for (const bytes of cases) {
      await withFixture(bytes, async (path) => {
        await expect(materializeTikTokVideoPublishInput(
          publishInput(),
          () => Promise.resolve([path]),
        )).rejects.toThrow("file-type box is not MP4-compatible");
      });
    }
  });

  test("requires exact authored-post deletion confirmation inputs", () => {
    expect(prepareTikTokPublishedPostDeleteInput({
      post_id: POST_ID,
      expected_caption: "Exact temporary fixture",
    })).toEqual({ postId: POST_ID, expectedCaption: "Exact temporary fixture" });
    expect(() => prepareTikTokPublishedPostDeleteInput({
      post_id: "invalid",
      expected_caption: "Exact temporary fixture",
    })).toThrow("exact decimal TikTok post ID");
    expect(() => prepareTikTokPublishedPostDeleteInput({
      post_id: POST_ID,
      expected_caption: "Exact temporary fixture",
      extra: true,
    })).toThrow("unsupported or missing");
  });
});
