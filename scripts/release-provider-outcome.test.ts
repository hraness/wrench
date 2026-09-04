import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  exactLatestPredecessor,
  latestReleaseConvergenceBudget,
  requireLatestRelease,
  revalidateLatestReleaseProjection,
  releasePublicHostRequestBudget,
  validateMatchingPublishedReleases,
  waitForLatestRelease,
  WrenchPublicSite,
} from "./release-provider-outcome.mjs";
import {
  createProductionReleaseMarker,
  PRODUCTION_RELEASE_MARKER_MAX_BYTES,
  serializeProductionReleaseMarker,
} from "../website/production-release-marker.mjs";

const tag = "v0.16.5";
const sourceSha = "2".repeat(40);
const deploymentUrl = "https://wrench-release123-hraness.vercel.app";
const markerBody = serializeProductionReleaseMarker(createProductionReleaseMarker({
  deploymentUrl,
  name: "@hraness/wrench",
  sourceSha,
  tag,
  version: tag.slice(1),
}));

type FetchCall = Readonly<{ init: RequestInit; url: string }>;

function responseAt(
  url: string,
  body: BodyInit | null,
  init: ResponseInit,
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { configurable: false, value: url });
  return response;
}

function siteWithFetch(
  implementation: (url: string, init: RequestInit) => Promise<Response> | Response,
): Readonly<{ calls: FetchCall[]; site: WrenchPublicSite }> {
  const calls: FetchCall[] = [];
  let nonce = 0;
  const fetchImplementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const exactInit = init ?? {};
    calls.push(Object.freeze({ init: exactInit, url }));
    return implementation(url, exactInit);
  };
  return Object.freeze({
    calls,
    site: new WrenchPublicSite({
      fetchImplementation,
      nonce: () => `nonce-${String(++nonce).padStart(4, "0")}`,
    }),
  });
}

function cancellableResponse(
  url: string,
  {
    body = "blocked",
    headers = {},
    status = 200,
  }: Readonly<{
    body?: string;
    headers?: Readonly<Record<string, string>>;
    status?: number;
  }> = {},
): Readonly<{ cancelled: () => boolean; response: Response }> {
  let wasCancelled = false;
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      wasCancelled = true;
    },
    start(controller) {
      controller.enqueue(bytes);
    },
  });
  return Object.freeze({
    cancelled: () => wasCancelled,
    response: responseAt(url, stream, { headers, status }),
  });
}

function expectedMarkerUrl(nonce = "nonce-0001"): string {
  return `https://wrench.rip/.well-known/wrench-release.json?release=${tag}&source=${sourceSha}&nonce=${nonce}`;
}

describe("public production outcome transport", () => {
  test("uses bounded exact GET requests for the marker, health routes, and www redirect", async () => {
    const { calls, site } = siteWithFetch((url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "www.wrench.rip") {
        const requestsPlainText = (
          init.headers as Readonly<Record<string, string>> | undefined
        )?.Accept === "text/plain";
        return responseAt(url, requestsPlainText
          ? "Redirecting...\n"
          : `${JSON.stringify({
            redirect: `https://wrench.rip${parsed.pathname}${parsed.search}`,
            status: "308",
          })}\n`, {
          headers: {
            "content-type": requestsPlainText ? "text/plain" : "application/json",
            location: `https://wrench.rip${parsed.pathname}${parsed.search}`,
          },
          status: 308,
        });
      }
      if (parsed.pathname === "/.well-known/wrench-release.json") {
        return responseAt(url, markerBody, {
          headers: {
            "cache-control": "no-store, max-age=0",
            "content-type": "application/json; charset=utf-8",
          },
          status: 200,
        });
      }
      if (parsed.pathname === "/llms.txt") {
        return responseAt(url, "# Wrench\nExact public provider guide.\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
        });
      }
      const canonical = parsed.pathname === "/"
        ? "https://wrench.rip/"
        : "https://wrench.rip/providers/beeper/";
      return responseAt(
        url,
        `<!doctype html>\n<link rel="canonical" href="${canonical}">\n`,
        {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        },
      );
    });

    const marker = await site.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 });
    expect(marker).toMatchObject({ kind: "release", marker: { deploymentUrl, sourceSha, tag } });
    expect(marker.bodySha256).toBe(createHash("sha256").update(markerBody).digest("hex"));
    expect(marker.requestPath).toBe(new URL(expectedMarkerUrl()).pathname + new URL(expectedMarkerUrl()).search);
    await site.readHealthRoute("/", tag, sourceSha, { timeoutMilliseconds: 9_999 });
    await site.readHealthRoute("/providers/beeper/", tag, sourceSha, {
      timeoutMilliseconds: 9_998,
    });
    await site.readHealthRoute("/llms.txt", tag, sourceSha, { timeoutMilliseconds: 9_997 });
    await site.readWwwRedirect(marker.requestPath, { timeoutMilliseconds: 9_996 });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/.well-known/wrench-release.json",
      "/",
      "/providers/beeper/",
      "/llms.txt",
      "/.well-known/wrench-release.json",
    ]);
    expect(calls.map((call) => (call.init.headers as Record<string, string>).Accept)).toEqual([
      "application/json",
      "text/html",
      "text/html",
      "text/plain",
      "text/plain",
    ]);
    expect(calls.map((call) => call.init.method)).toEqual(Array(5).fill("GET"));
    expect(calls.map((call) => call.init.cache)).toEqual(Array(5).fill("no-store"));
    expect(calls.map((call) => call.init.credentials)).toEqual(Array(5).fill("omit"));
    expect(calls.map((call) => call.init.redirect)).toEqual([
      "error",
      "error",
      "error",
      "error",
      "manual",
    ]);
    expect(calls.every((call) => call.init.signal instanceof AbortSignal)).toBe(true);
    expect(calls.every((call) => (
      call.init.headers as Record<string, string>
    )["User-Agent"] === "wrench-production-outcome-verifier")).toBe(true);
    expect(calls.every((call) => {
      const headers = call.init.headers as Record<string, string>;
      return Object.keys(headers).sort().join(",") === "Accept,User-Agent"
        && !("Authorization" in headers)
        && !("Cookie" in headers);
    })).toBe(true);
    expect(new URL(calls[4]!.url).search).toBe(new URL(calls[0]!.url).search);
  });

  test("accepts the bounded first-marker 404 and rejects every other marker transport drift", async () => {
    const missingBody = "x".repeat(17_481);
    const missing = siteWithFetch((url) => responseAt(url, missingBody, {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 404,
    }));
    await expect(missing.site.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 }))
      .resolves.toEqual(expect.objectContaining({
        bodySha256: createHash("sha256").update(missingBody).digest("hex"),
        kind: "missing",
      }));

    const rejectionCases = [
      {
        expected: "changed its exact request URL",
        make: (url: string) => cancellableResponse(`${url}/drift`, {
          headers: {
            "cache-control": "no-store, max-age=0",
            "content-type": "application/json; charset=utf-8",
          },
        }),
      },
      {
        expected: "returned HTTP 500",
        make: (url: string) => cancellableResponse(url, { status: 500 }),
      },
      {
        expected: "exact application/json; charset=utf-8",
        make: (url: string) => cancellableResponse(url, {
          headers: { "content-type": "application/json" },
        }),
      },
      {
        expected: "exact Cache-Control: no-store, max-age=0",
        make: (url: string) => cancellableResponse(url, {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      },
      {
        expected: `exceeded ${String(PRODUCTION_RELEASE_MARKER_MAX_BYTES)} bytes`,
        make: (url: string) => cancellableResponse(url, {
          headers: {
            "cache-control": "no-store, max-age=0",
            "content-length": String(PRODUCTION_RELEASE_MARKER_MAX_BYTES + 1),
            "content-type": "application/json; charset=utf-8",
          },
        }),
      },
      {
        expected: "invalid Content-Length",
        make: (url: string) => cancellableResponse(url, {
          headers: {
            "cache-control": "no-store, max-age=0",
            "content-length": "+1",
            "content-type": "application/json; charset=utf-8",
          },
        }),
      },
    ] as const;
    for (const rejectionCase of rejectionCases) {
      let fixture: ReturnType<typeof cancellableResponse> | undefined;
      const { site } = siteWithFetch((url) => {
        fixture = rejectionCase.make(url);
        return fixture.response;
      });
      await expect(site.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 }))
        .rejects.toThrow(rejectionCase.expected);
      expect(fixture?.cancelled()).toBe(true);
    }

    for (const body of [
      "x".repeat(PRODUCTION_RELEASE_MARKER_MAX_BYTES + 1),
      markerBody.slice(0, -1),
      `${markerBody}\n`,
      "not json\n",
    ]) {
      const { site } = siteWithFetch((url) => responseAt(url, body, {
        headers: {
          "cache-control": "no-store, max-age=0",
          "content-type": "application/json; charset=utf-8",
        },
        status: 200,
      }));
      await expect(site.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 }))
        .rejects.toThrow();
    }
    const invalidUtf8 = siteWithFetch((url) => responseAt(url, new Uint8Array([0xff]), {
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
      },
      status: 200,
    }));
    await expect(invalidUtf8.site.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 }))
      .rejects.toThrow("not valid UTF-8");

    const oversized404 = siteWithFetch((url) => responseAt(
      url,
      "x".repeat(256 * 1_024 + 1),
      {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 404,
      },
    ));
    await expect(oversized404.site.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 }))
      .rejects.toThrow("exceeded 262144 bytes");
  });

  test("rejects invalid timeouts, nonce reuse, and timed-out public requests", async () => {
    const successful = siteWithFetch((url) => responseAt(url, markerBody, {
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
      },
      status: 200,
    }));
    for (const timeoutMilliseconds of [0, -1, 10_001, 1.5, Number.NaN]) {
      await expect(successful.site.readMarker(tag, sourceSha, { timeoutMilliseconds }))
        .rejects.toThrow("invalid request timeout");
    }

    let calls = 0;
    const reused = new WrenchPublicSite({
      fetchImplementation: async (input: string | URL | Request) => {
        calls += 1;
        return responseAt(String(input), markerBody, {
          headers: {
            "cache-control": "no-store, max-age=0",
            "content-type": "application/json; charset=utf-8",
          },
        });
      },
      nonce: () => "same-nonce",
    });
    await reused.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 });
    await expect(reused.readMarker(tag, sourceSha, { timeoutMilliseconds: 10_000 }))
      .rejects.toThrow("nonce was reused");
    expect(calls).toBe(1);

    const timed = siteWithFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await expect(timed.site.readMarker(tag, sourceSha, { timeoutMilliseconds: 1 }))
      .rejects.toThrow();
    expect(timed.calls).toHaveLength(1);
  });

  test("bounds and validates each exact canonical health route", async () => {
    const canonicalBodies = new Map([
      ["/", '<!doctype html>\n<link rel="canonical" href="https://wrench.rip/">\n'],
      [
        "/providers/beeper/",
        '<!doctype html>\n<link rel="canonical" href="https://wrench.rip/providers/beeper/">\n',
      ],
      ["/llms.txt", "# Wrench\nProvider documentation.\n"],
    ]);
    const valid = siteWithFetch((url) => {
      const path = new URL(url).pathname;
      return responseAt(url, canonicalBodies.get(path) ?? "", {
        headers: {
          "content-type": path === "/llms.txt"
            ? "text/plain; charset=utf-8"
            : "text/html; charset=utf-8",
        },
      });
    });
    for (const route of canonicalBodies.keys()) {
      await expect(valid.site.readHealthRoute(route, tag, sourceSha, {
        timeoutMilliseconds: 10_000,
      })).resolves.toMatchObject({ path: route, status: 200 });
    }
    const priorCalls = valid.calls.length;
    await expect(valid.site.readHealthRoute("/providers/other/", tag, sourceSha, {
      timeoutMilliseconds: 10_000,
    })).rejects.toThrow("health route is unsupported");
    expect(valid.calls).toHaveLength(priorCalls);

    for (const [route, body, expected] of [
      ["/", "not wrench", "not the canonical Wrench document"],
      [
        "/providers/beeper/",
        '<!doctype html>\n<link rel="canonical" href="https://wrench.rip/">\n',
        "not the canonical Wrench document",
      ],
      ["/llms.txt", "# Other\n", "not the canonical Wrench text document"],
    ] as const) {
      const invalid = siteWithFetch((url) => responseAt(url, body, {
        headers: {
          "content-type": route === "/llms.txt"
            ? "text/plain; charset=utf-8"
            : "text/html; charset=utf-8",
        },
      }));
      await expect(invalid.site.readHealthRoute(route, tag, sourceSha, {
        timeoutMilliseconds: 10_000,
      })).rejects.toThrow(expected);
    }

    let fixture: ReturnType<typeof cancellableResponse> | undefined;
    const wrongStatus = siteWithFetch((url) => {
      fixture = cancellableResponse(url, { status: 503 });
      return fixture.response;
    });
    await expect(wrongStatus.site.readHealthRoute("/", tag, sourceSha, {
      timeoutMilliseconds: 10_000,
    })).rejects.toThrow("returned HTTP 503");
    expect(fixture?.cancelled()).toBe(true);

    const oversized = siteWithFetch((url) => responseAt(url, "x", {
      headers: {
        "content-length": String(256 * 1_024 + 1),
        "content-type": "text/html; charset=utf-8",
      },
    }));
    await expect(oversized.site.readHealthRoute("/", tag, sourceSha, {
      timeoutMilliseconds: 10_000,
    })).rejects.toThrow("exceeded 262144 bytes");
  });

  test("accepts only one exact no-follow www 308 preserving marker path and query", async () => {
    const requestPath = new URL(expectedMarkerUrl()).pathname + new URL(expectedMarkerUrl()).search;
    const valid = siteWithFetch((url) => responseAt(url, "Redirecting...\n", {
      headers: {
        "content-type": "text/plain",
        location: `https://wrench.rip${requestPath}`,
      },
      status: 308,
    }));
    await expect(valid.site.readWwwRedirect(requestPath, { timeoutMilliseconds: 10_000 }))
      .resolves.toEqual({
        bodySha256: createHash("sha256").update("Redirecting...\n").digest("hex"),
        contentType: "text/plain",
        location: `https://wrench.rip${requestPath}`,
        status: 308,
      });
    expect(valid.calls[0]?.init.redirect).toBe("manual");
    expect((valid.calls[0]?.init.headers as Readonly<Record<string, string>>).Accept)
      .toBe("text/plain");

    for (const request of ["/", "/.well-known/wrench-release.json", `${requestPath}#x`]) {
      await expect(valid.site.readWwwRedirect(request, { timeoutMilliseconds: 10_000 }))
        .rejects.toThrow("redirect probe path is malformed");
    }

    const cases = [
      { expected: "returned HTTP 307", headers: {}, status: 307 },
      {
        expected: "exact text/plain",
        headers: { "content-type": "text/plain; charset=utf-8" },
        status: 308,
      },
      {
        expected: "preserve the exact HTTPS path and query",
        headers: {
          "content-type": "text/plain",
          location: "https://wrench.rip/.well-known/wrench-release.json",
        },
        status: 308,
      },
    ] as const;
    for (const item of cases) {
      let fixture: ReturnType<typeof cancellableResponse> | undefined;
      const invalid = siteWithFetch((url) => {
        fixture = cancellableResponse(url, { headers: item.headers, status: item.status });
        return fixture.response;
      });
      await expect(invalid.site.readWwwRedirect(requestPath, { timeoutMilliseconds: 10_000 }))
        .rejects.toThrow(item.expected);
      expect(fixture?.cancelled()).toBe(true);
    }

    for (const body of ["Redirecting...", "Redirecting...\r\n", "x".repeat(1_025)]) {
      const invalid = siteWithFetch((url) => responseAt(url, body, {
        headers: {
          "content-type": "text/plain",
          location: `https://wrench.rip${requestPath}`,
        },
        status: 308,
      }));
      await expect(invalid.site.readWwwRedirect(requestPath, { timeoutMilliseconds: 10_000 }))
        .rejects.toThrow();
    }
  });

  test("keeps the complete public request budget explicit", () => {
    expect(releasePublicHostRequestBudget).toEqual({
      firstMarkerTag: "v0.16.5",
      perRequestTimeoutMilliseconds: 10_000,
      providerBaseline: 2,
      providerOutcome: 30,
      total: 32,
    });
    expect(Object.isFrozen(releasePublicHostRequestBudget)).toBe(true);
  });
});

function release(tagName: string, id: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    assets: [],
    draft: false,
    id,
    immutable: true,
    prerelease: false,
    published_at: tagName === tag ? "2026-09-04T12:00:00Z" : "2026-09-03T12:00:00Z",
    tag_name: tagName,
    target_commitish: "main",
  });
}

describe("immutable Latest Release convergence", () => {
  test("waits on absolute bounded slots for an older eventual-consistency result", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const timeouts: number[] = [];
    const snapshots = [release("v0.16.4", 9), release(tag, 10)];
    let read = 0;
    const result = await waitForLatestRelease({
      api: {
        async get(endpoint: string, options: Readonly<{ timeoutMilliseconds: number }>) {
          expect(endpoint).toBe("/repos/hraness/wrench/releases/latest");
          timeouts.push(options.timeoutMilliseconds);
          now += 1;
          return snapshots[Math.min(read++, snapshots.length - 1)];
        },
      },
      monotonicNow: () => now,
      predecessorRelease: release("v0.16.4", 9),
      repository: "hraness/wrench",
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    });
    expect(result).toEqual({ attempts: 2, releaseId: 10, tag });
    expect(sleeps).toEqual([4_999]);
    expect(timeouts).toEqual([10_000, 10_000]);
    expect(now).toBe(5_001);
  });

  test("rejects supersession, identity drift, malformed state, and exhausted convergence", async () => {
    const run = (
      snapshots: readonly Readonly<Record<string, unknown>>[],
      overrides: Readonly<Record<string, unknown>> = {},
    ): Promise<unknown> => {
      let now = 0;
      let read = 0;
      return waitForLatestRelease({
        api: {
          async get(_endpoint: string, _options: Readonly<{ timeoutMilliseconds: number }>) {
            now += 1;
            return snapshots[Math.min(read++, snapshots.length - 1)];
          },
        },
        maxAttempts: 2,
        monotonicNow: () => now,
        pollIntervalMilliseconds: 0,
        predecessorRelease: release("v0.16.4", 9),
        repository: "hraness/wrench",
        sleep: async () => {},
        targetRelease: release(tag, 10),
        verifiedTag: tag,
        ...overrides,
      });
    };
    await expect(run([release("v0.16.6", 11)]))
      .rejects.toThrow("changed from the pinned predecessor");
    await expect(run([release("v0.16.3", 8)]))
      .rejects.toThrow("changed from the pinned predecessor");
    await expect(run([{ ...release("v0.16.4", 9), published_at: "2026-09-02T12:00:00Z" }]))
      .rejects.toThrow("changed from the pinned predecessor");
    await expect(run([release(tag, 11)]))
      .rejects.toThrow("does not bind the immutable target Release");
    await expect(run([{ ...release(tag, 10), immutable: false }]))
      .rejects.toThrow("is not exact, published, immutable, and asset-free");
    await expect(run([release("v0.16.4", 9)]))
      .rejects.toThrow("bounded attempt budget");
    await expect(run([release("v0.16.4-beta.1", 9)]))
      .rejects.toThrow("not one stable semantic-version tag");
  });

  test("fails closed on invalid, regressing, expired, or stuck timing", async () => {
    const api = {
      async get() {
        return release(tag, 10);
      },
    };
    for (const options of [
      { maxAttempts: 0 },
      { maxAttempts: 13 },
      { maxAttempts: 1.5 },
      { pollIntervalMilliseconds: -1 },
      { pollIntervalMilliseconds: 5_001 },
    ] as const) {
      await expect(waitForLatestRelease({
        api,
        predecessorRelease: release("v0.16.4", 9),
        repository: "hraness/wrench",
        targetRelease: release(tag, 10),
        verifiedTag: tag,
        ...options,
      })).rejects.toThrow();
    }

    let clockRead = 0;
    await expect(waitForLatestRelease({
      api,
      monotonicNow: () => [10, 10, 9][clockRead++] ?? 9,
      predecessorRelease: release("v0.16.4", 9),
      repository: "hraness/wrench",
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    })).rejects.toThrow("monotonic clock regressed");

    let now = 0;
    await expect(waitForLatestRelease({
      api: {
        async get() {
          now = 60_001;
          return release(tag, 10);
        },
      },
      monotonicNow: () => now,
      predecessorRelease: release("v0.16.4", 9),
      repository: "hraness/wrench",
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    })).rejects.toThrow("did not converge as Latest within 60 seconds");

    await expect(waitForLatestRelease({
      api: {
        async get() {
          return release("v0.16.4", 9);
        },
      },
      maxAttempts: 2,
      monotonicNow: () => 0,
      predecessorRelease: release("v0.16.4", 9),
      repository: "hraness/wrench",
      sleep: async () => {},
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    })).rejects.toThrow("sleep did not reach its monotonic schedule");

    expect(latestReleaseConvergenceBudget).toEqual({
      deadlineMilliseconds: 60_000,
      maxAttempts: 12,
      perRequestTimeoutMilliseconds: 10_000,
      pollIntervalMilliseconds: 5_000,
    });
    expect(Object.isFrozen(latestReleaseConvergenceBudget)).toBe(true);
  });

  test("admits only one exact immutable predecessor and requires existing Releases to be Latest", async () => {
    expect(exactLatestPredecessor(release("v0.16.4", 9), tag)).toEqual({
      release: release("v0.16.4", 9),
      tag: "v0.16.4",
    });
    for (const predecessor of [
      release(tag, 10),
      release("v0.16.6", 11),
      { ...release("v0.16.4", 9), immutable: false },
    ]) {
      expect(() => exactLatestPredecessor(predecessor, tag)).toThrow();
    }

    const calls: string[] = [];
    const exact = await requireLatestRelease({
      api: {
        async get(endpoint: string, options: Readonly<{ timeoutMilliseconds: number }>) {
          calls.push(endpoint);
          expect(options).toEqual({ timeoutMilliseconds: 10_000 });
          return release(tag, 10);
        },
      },
      repository: "hraness/wrench",
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    });
    expect(exact).toEqual({ releaseId: 10, tag });
    expect(calls).toEqual(["/repos/hraness/wrench/releases/latest"]);

    await expect(requireLatestRelease({
      api: { async get() { return release("v0.16.4", 9); } },
      repository: "hraness/wrench",
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    })).rejects.toThrow("is no longer Latest");

    expect(validateMatchingPublishedReleases(
      release(tag, 10),
      release(tag, 10),
      tag,
    )).toEqual({ releaseId: 10, tag });
    expect(() => validateMatchingPublishedReleases(
      release(tag, 11),
      release(tag, 10),
      tag,
    )).toThrow("does not bind the immutable target Release");
  });

  test("terminally sandwiches the exact Release and rejects Latest drift after convergence", async () => {
    const calls: string[] = [];
    const result = await revalidateLatestReleaseProjection({
      api: {
        async get(endpoint: string, options: Readonly<{ timeoutMilliseconds: number }>) {
          calls.push(endpoint);
          expect(options).toEqual({ timeoutMilliseconds: 10_000 });
          return release(tag, 10);
        },
      },
      repository: "hraness/wrench",
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    });
    expect(result).toEqual({ releaseId: 10, tag });
    expect(calls).toEqual([
      `/repos/hraness/wrench/releases/tags/${tag}`,
      "/repos/hraness/wrench/releases/latest",
    ]);

    let read = 0;
    await expect(revalidateLatestReleaseProjection({
      api: {
        async get() {
          return read++ === 0 ? release(tag, 10) : release("v0.16.6", 11);
        },
      },
      repository: "hraness/wrench",
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    })).rejects.toThrow("is no longer Latest");

    await expect(revalidateLatestReleaseProjection({
      api: {
        async get() {
          return release(tag, 11);
        },
      },
      repository: "hraness/wrench",
      targetRelease: release(tag, 10),
      verifiedTag: tag,
    })).rejects.toThrow("does not bind the immutable target Release");
  });
});
