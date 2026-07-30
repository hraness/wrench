import { expect, test } from "bun:test";
import fc from "fast-check";
import type { CaptureMode } from "./args";
import { resolveDirectMediaProbe, routeSource } from "./source-router";

const captureMode = fc.constantFrom<CaptureMode>("archive", "audio", "video", "transcript");
const token = fc.array(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
  { minLength: 1, maxLength: 48 },
).map((characters) => characters.join(""));

test("property: arbitrary URL strings never make routing throw", () => {
  fc.assert(
    fc.property(fc.string(), captureMode, fc.boolean(), (url, mode, inheritYtDlpConfig) => {
      expect(() => routeSource({ url, mode, inheritYtDlpConfig })).not.toThrow();
    }),
    { numRuns: 500 },
  );
});

test("property: URL fragments cannot change transport data or its request digest", () => {
  fc.assert(
    fc.property(token, token, token, token, captureMode, (path, query, leftFragment, rightFragment, mode) => {
      const base = `https://example.com/${path}?value=${query}`;
      const left = routeSource({
        url: `${base}#${leftFragment}`,
        mode,
        inheritYtDlpConfig: false,
      });
      const right = routeSource({
        url: `${base}#${rightFragment}`,
        mode,
        inheritYtDlpConfig: false,
      });
      if (left.kind !== "direct-http" || right.kind !== "direct-http") {
        throw new Error("public HTTP fixture did not produce a direct route");
      }
      expect(left.requestUrl).toBe(right.requestUrl);
      expect(left.requestUrl).not.toContain("#");
      expect(left.requestUrlSha256).toBe(right.requestUrlSha256);
      expect(left.requestUrlSha256).toMatch(/^[0-9a-f]{64}$/u);
    }),
    { numRuns: 300 },
  );
});

test("property: private access routes only with one canonical authorization context", () => {
  fc.assert(
    fc.property(token, captureMode, fc.boolean(), fc.boolean(), (path, mode, hasBrowser, inheritYtDlpConfig) => {
      const route = routeSource({
        url: `https://example.com/${path}`,
        mode,
        ...(hasBrowser ? { browser: "safari" } : {}),
        ...(hasBrowser || inheritYtDlpConfig ? { authContext: "Personal" } : {}),
        inheritYtDlpConfig,
      });
      if (hasBrowser && inheritYtDlpConfig) {
        expect(route).toEqual({ kind: "reject", reason: "ambiguous-private-access" });
      } else if (hasBrowser || inheritYtDlpConfig) {
        expect(route).toMatchObject({ kind: "yt-dlp", authContext: "personal" });
      } else {
        expect(route.kind).toBe("direct-http");
      }
    }),
    { numRuns: 300 },
  );
});

test("property: credentials and every non-HTTP scheme are rejected", () => {
  fc.assert(
    fc.property(token, token, token, (username, password, path) => {
      expect(routeSource({
        url: `https://${username}:${password}@example.com/${path}`,
        mode: "archive",
        inheritYtDlpConfig: false,
      })).toEqual({ kind: "reject", reason: "credentials-not-allowed" });
      for (const url of [
        `ftp://example.com/${path}`,
        `file:///${path}`,
        `ws://example.com/${path}`,
        `mailto:${path}@example.com`,
      ]) {
        expect(routeSource({
          url,
          mode: "archive",
          inheritYtDlpConfig: false,
        })).toEqual({ kind: "reject", reason: "unsupported-protocol" });
      }
    }),
    { numRuns: 300 },
  );
});

test("property: transcript routes remain probe-only while media probes resolve exhaustively", () => {
  fc.assert(
    fc.property(token, captureMode, (path, mode) => {
      const route = routeSource({
        url: `http://example.com/${path}`,
        mode,
        inheritYtDlpConfig: false,
      });
      if (route.kind !== "direct-http") throw new Error("public HTTP fixture did not produce a direct route");
      if (route.intent === "transcript-probe-only") {
        expect(route.mode).toBe("transcript");
        return;
      }
      expect(route.mode).not.toBe("transcript");
      expect(resolveDirectMediaProbe(route, { kind: "applicable" }).kind).toBe("direct-http-capture");
      expect(resolveDirectMediaProbe(route, { kind: "not-applicable" })).toMatchObject({
        kind: "yt-dlp-fallback",
        reason: "not-applicable-media",
      });
    }),
    { numRuns: 300 },
  );
});

test("property: distinct fragment-free request URLs have distinct request digests", () => {
  fc.assert(
    fc.property(token, token, (leftPath, rightPath) => {
      fc.pre(leftPath !== rightPath);
      const left = routeSource({
        url: `https://example.com/${leftPath}`,
        mode: "archive",
        inheritYtDlpConfig: false,
      });
      const right = routeSource({
        url: `https://example.com/${rightPath}`,
        mode: "archive",
        inheritYtDlpConfig: false,
      });
      if (left.kind !== "direct-http" || right.kind !== "direct-http") {
        throw new Error("public HTTP fixture did not produce a direct route");
      }
      expect(left.requestUrl).not.toBe(right.requestUrl);
      expect(left.requestUrlSha256).not.toBe(right.requestUrlSha256);
    }),
    { numRuns: 300 },
  );
});
