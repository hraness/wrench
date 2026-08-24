import { describe, expect, test } from "bun:test";

import {
  createYouTubeDataApiUploadInitiation,
  createYouTubeDataApiWholeFileTransfer,
  parseYouTubeDataApiResumeState,
  parseYouTubeDataApiUploadSession,
} from "./youtube-official-resumable-upload";

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=opaque_session-1&part=snippet%2Cstatus&notifySubscribers=false";

function input(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    ageRestricted: false,
    byteLength: 349_510,
    caption: "Temporary private fixture",
    categoryId: "22",
    containsSyntheticMedia: false,
    madeForKids: false,
    notifySubscribers: false,
    title: "Temporary private fixture",
    visibility: "private",
    ...overrides,
  };
}

describe("official YouTube Data API resumable upload foundations", () => {
  test("builds one exact OAuth initiation envelope without credentials", () => {
    expect(createYouTubeDataApiUploadInitiation(input())).toEqual({
      body: {
        snippet: {
          categoryId: "22",
          description: "Temporary private fixture",
          title: "Temporary private fixture",
        },
        status: {
          containsSyntheticMedia: false,
          privacyStatus: "private",
          selfDeclaredMadeForKids: false,
        },
      },
      headers: {
        contentType: "application/json; charset=UTF-8",
        uploadContentLength: "349510",
        uploadContentType: "video/mp4",
      },
      method: "POST",
      origin: "https://www.googleapis.com",
      path: "/upload/youtube/v3/videos",
      query: {
        notifySubscribers: "false",
        part: "snippet,status",
        uploadType: "resumable",
      },
    });
    expect(JSON.stringify(createYouTubeDataApiUploadInitiation(input())))
      .not.toMatch(/authorization|bearer|cookie/iu);
  });

  test("rejects declarations the documented insert body cannot preserve", () => {
    for (const [overrides, message] of [
      [{ ageRestricted: true }, "cannot set creator age restriction"],
      [{ byteLength: 23 }, "between 24 bytes and 128 MiB"],
      [{ categoryId: "0" }, "positive integer string"],
      [{ title: "two\nlines" }, "must be one line"],
      [{ visibility: "friends" }, "private, unlisted, or public"],
      [{ extra: true }, "only its reviewed fields"],
    ] as const) {
      expect(() => createYouTubeDataApiUploadInitiation(input(overrides)))
        .toThrow(message);
    }
  });

  test("accepts only the exact provider-issued official session host and query", () => {
    expect(parseYouTubeDataApiUploadSession({ status: 200, location: SESSION }, false))
      .toEqual({ url: SESSION, uploadId: "opaque_session-1" });
    expect(createYouTubeDataApiWholeFileTransfer(SESSION, 349_510, false)).toEqual({
      headers: { contentLength: "349510", contentType: "video/mp4" },
      method: "PUT",
      url: SESSION,
    });
    expect(createYouTubeDataApiWholeFileTransfer(
      SESSION,
      128 * 1024 * 1024,
      false,
    ).headers.contentLength).toBe(String(128 * 1024 * 1024));
    expect(() => createYouTubeDataApiWholeFileTransfer(
      SESSION,
      128 * 1024 * 1024 + 1,
      false,
    )).toThrow("between 24 bytes and 128 MiB");
    for (const location of [
      SESSION.replace("www.googleapis.com", "upload.youtube.com"),
      SESSION.replace("www.googleapis.com", "evil.example"),
      SESSION.replace("upload_id=opaque_session-1", "upload_id=opaque_session-1&redirect=true"),
      SESSION.replace("notifySubscribers=false", "notifySubscribers=true"),
    ]) {
      expect(() => parseYouTubeDataApiUploadSession({ status: 200, location }, false))
        .toThrow();
    }
  });

  test("parses only continuous documented 308 resume positions", () => {
    expect(parseYouTubeDataApiResumeState({
      status: 308,
      range: null,
      retryAfter: null,
    }, 349_510)).toEqual({ status: 308, nextOffset: 0, retryAfterSeconds: null });
    expect(parseYouTubeDataApiResumeState({
      status: 308,
      range: "bytes=0-262143",
      retryAfter: "2",
    }, 349_510)).toEqual({ status: 308, nextOffset: 262_144, retryAfterSeconds: 2 });
    for (const response of [
      { status: 200, range: null, retryAfter: null },
      { status: 308, range: "bytes=1-10", retryAfter: null },
      { status: 308, range: "bytes=0-349510", retryAfter: null },
      { status: 308, range: null, retryAfter: "tomorrow" },
      { status: 308, range: null, retryAfter: null, extra: true },
    ]) {
      expect(() => parseYouTubeDataApiResumeState(response, 349_510)).toThrow();
    }
  });
});
