import { describe, expect, test } from "bun:test";
import type { CaptureMode } from "./args";
import {
  resolveDirectMediaProbe,
  routeSource,
  type DirectHttpMediaProbeRoute,
  type SourceRouteInput,
} from "./source-router";

function input(overrides: Partial<SourceRouteInput> = {}): SourceRouteInput {
  return {
    url: "https://example.com/media.mp4",
    mode: "archive",
    inheritYtDlpConfig: false,
    ...overrides,
  };
}

describe("routeSource", () => {
  test("classifies every public media mode as a direct HTTP media probe", () => {
    for (const mode of ["archive", "audio", "video"] as const) {
      const route = routeSource(input({ mode }));
      expect(route).toMatchObject({
        kind: "direct-http",
        intent: "media-probe",
        mode,
        requestUrl: "https://example.com/media.mp4",
      });
      if (route.kind !== "direct-http") throw new Error("fixture did not produce a direct route");
      expect(route.requestUrlSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("classifies transcript mode as probe-only", () => {
    expect(routeSource(input({ mode: "transcript" }))).toMatchObject({
      kind: "direct-http",
      intent: "transcript-probe-only",
      mode: "transcript",
    });
  });

  test("routes browser and ambient-config requests through yt-dlp", () => {
    for (const [overrides, reason] of [
      [{ browser: "safari", authContext: "Personal" }, "browser-auth"],
      [{ inheritYtDlpConfig: true, authContext: "Work" }, "ambient-config"],
    ] as const) {
      expect(routeSource(input(overrides))).toMatchObject({
        kind: "yt-dlp",
        reason,
        authContext: overrides.authContext.toLowerCase(),
      });
    }
  });

  test("rejects every ambiguous authorization-context combination", () => {
    for (const browser of ["", "safari\nsecret", "x".repeat(513)]) {
      expect(routeSource(input({ browser, authContext: "personal" }))).toEqual({
        kind: "reject",
        reason: "invalid-browser",
      });
    }
    expect(routeSource(input({ browser: "safari" }))).toEqual({
      kind: "reject",
      reason: "auth-context-required",
    });
    expect(routeSource(input({ inheritYtDlpConfig: true }))).toEqual({
      kind: "reject",
      reason: "auth-context-required",
    });
    expect(routeSource(input({ authContext: "personal" }))).toEqual({
      kind: "reject",
      reason: "auth-context-not-applicable",
    });
    expect(routeSource(input({ browser: "safari", authContext: "bad context" }))).toEqual({
      kind: "reject",
      reason: "invalid-auth-context",
    });
    expect(routeSource(input({
      browser: "safari",
      inheritYtDlpConfig: true,
      authContext: "personal",
    }))).toEqual({
      kind: "reject",
      reason: "ambiguous-private-access",
    });
  });

  test("strips fragments before transport and hashes the exact request URL", () => {
    const route = routeSource(input({
      url: "https://EXAMPLE.com:443/media.mp4?quality=best#local-state",
    }));
    expect(route).toEqual({
      kind: "direct-http",
      intent: "media-probe",
      mode: "archive",
      requestUrl: "https://example.com/media.mp4?quality=best",
      requestUrlSha256: "31a4be805de486e048b1a6992c00c7052df8ae84b42e3ad0967ab142762d76cf",
    });
  });

  test("rejects credentials, non-HTTP schemes, and malformed URLs", () => {
    expect(routeSource(input({ url: "https://alice:secret@example.com/media" }))).toEqual({
      kind: "reject",
      reason: "credentials-not-allowed",
    });
    for (const url of ["ftp://example.com/media", "file:///tmp/media", "data:text/plain,x"]) {
      expect(routeSource(input({ url }))).toEqual({
        kind: "reject",
        reason: "unsupported-protocol",
      });
    }
    for (const url of ["", "not a url", "http://"]) {
      expect(routeSource(input({ url }))).toEqual({
        kind: "reject",
        reason: "malformed-url",
      });
    }
  });
});

describe("resolveDirectMediaProbe", () => {
  function mediaRoute(mode: Exclude<CaptureMode, "transcript">): DirectHttpMediaProbeRoute {
    const route = routeSource(input({ mode }));
    if (route.kind !== "direct-http" || route.intent !== "media-probe") {
      throw new Error("fixture did not produce a media probe");
    }
    return route;
  }

  test("captures applicable media directly", () => {
    expect(resolveDirectMediaProbe(mediaRoute("video"), { kind: "applicable" })).toEqual({
      kind: "direct-http-capture",
      mode: "video",
      requestUrl: "https://example.com/media.mp4",
      requestUrlSha256: "93105cb72f7ead2101688368b98d1cb7c3d609c396b5dbde64375cf76149a1b1",
    });
  });

  test("falls back to yt-dlp when a media probe is not applicable", () => {
    expect(resolveDirectMediaProbe(mediaRoute("audio"), { kind: "not-applicable" })).toEqual({
      kind: "yt-dlp-fallback",
      reason: "not-applicable-media",
      mode: "audio",
      requestUrl: "https://example.com/media.mp4",
      requestUrlSha256: "93105cb72f7ead2101688368b98d1cb7c3d609c396b5dbde64375cf76149a1b1",
    });
  });

  test("fails closed if an untyped caller forges a transcript capture route", () => {
    const transcript = routeSource(input({ mode: "transcript" }));
    if (transcript.kind !== "direct-http") throw new Error("fixture did not produce a direct route");
    expect(() => resolveDirectMediaProbe(
      transcript as unknown as DirectHttpMediaProbeRoute,
      { kind: "applicable" },
    )).toThrow("only a direct HTTP media probe can resolve to capture");
  });
});
