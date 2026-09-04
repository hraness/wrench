import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { BrowserSession, CreateBrowserSessionOptions } from "../browser";
import {
  createLinkedInFeedBrowserTransport,
  LinkedInFeedBrowserFailure,
} from "./linkedin-web-feed-browser";
import {
  LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX,
  linkedInProfileActivityPageUrl,
  linkedInProfileActivityTargetFromVanity,
} from "./linkedin-web-feed";

const QUERY_ID = `${LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX}.7f16f6612fc18a3623688ca7a74d7696`;
const PROFILE_URN = "urn:li:fsd_profile:ACoAAExactTargetProfile";
const ME_BODY = JSON.stringify({ data: { plainId: "123456789" }, included: [] });

const auth = {
  schemaVersion: 1,
  id: "linkedin-feed-browser-test",
  kind: "browser-profile",
  profile: "Persistent LinkedIn",
  trustUnfilteredEgress: true,
  subject: "urn:li:fsd_profile:123456789",
} as const satisfies WrenchAuth;

function bodyRecord(body: string): Readonly<Record<string, unknown>> {
  const bytes = Buffer.from(body, "utf8");
  return {
    success: true,
    result: {
      origin: "https://www.linkedin.com/feed/",
      result: {
        authWall: false,
        bodyBase64: bytes.toString("base64"),
        bodyBytes: bytes.byteLength,
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: "application/json",
        status: 200,
      },
    },
  };
}

function rejectedRecord(status: number): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: {
      origin: "https://www.linkedin.com/feed/",
      result: {
        authWall: false,
        bodyBase64: null,
        bodyBytes: 0,
        bodySha256: null,
        contentType: "text/html",
        status,
      },
    },
  };
}

function redirectRecord(status = 0): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: {
      origin: "https://www.linkedin.com/feed/",
      result: {
        authWall: true,
        bodyBase64: null,
        bodyBytes: 0,
        bodySha256: null,
        contentType: "",
        status,
      },
    },
  };
}

function networkRecord(
  requests: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>> {
  return { success: true, result: { requests } };
}

function currentUrlRecord(url: string): Readonly<Record<string, unknown>> {
  return { success: true, result: { url } };
}

function createTransport(session: BrowserSession) {
  return createLinkedInFeedBrowserTransport(auth, {
    timeoutMs: 10_000,
    maxOutputBytes: 1_048_576,
    dependencies: {
      createBrowserSession: (
        _manifest: unknown,
        _auth: WrenchAuth,
        options: CreateBrowserSessionOptions,
      ) => {
        expect(options.allowCodeOwnedEvaluation).toBeTrue();
        expect(options.allowCodeOwnedNetworkObservation).toBeTrue();
        return Promise.resolve(session);
      },
    },
  });
}

describe("LinkedIn profile-activity browser transport", () => {
  test("binds fresh navigation evidence and reuses only its internal query and profile", async () => {
    const commands: (readonly (readonly string[])[])[] = [];
    const target = linkedInProfileActivityTargetFromVanity("j-hawkins");
    const pageUrl = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    });
    const staleRequest = {
      requestId: "stale-request",
      method: "GET",
      status: 200,
      url: pageUrl.href,
    } as const;
    const freshRequest = {
      ...staleRequest,
      requestId: "fresh-request",
    } as const;
    let networkReads = 0;
    let pageReads = 0;
    const pageSources: string[] = [];
    const session: BrowserSession = {
      runBatch: (batch) => {
        commands.push(batch);
        const command = batch[0];
        if (command?.[0] === "eval" && command[1]?.includes("voyagerFeedDashProfileUpdates")) {
          const start = pageReads * 10;
          pageReads += 1;
          pageSources.push(command[1]);
          return Promise.resolve([bodyRecord(JSON.stringify({ page: start }))]);
        }
        if (command?.[0] === "eval" && command[1]?.includes("/voyager/api/me")) {
          return Promise.resolve([bodyRecord(ME_BODY)]);
        }
        if (command?.[0] === "network") {
          networkReads += 1;
          return Promise.resolve([
            networkRecord(networkReads === 1 ? [staleRequest] : [staleRequest, freshRequest]),
          ]);
        }
        if (command?.[0] === "get" && command[1] === "url") {
          return Promise.resolve([currentUrlRecord(target.activityUrl)]);
        }
        return Promise.resolve([{ success: true, result: null }]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createTransport(session);
    try {
      expect(await transport.currentIdentityResponse()).toEqual({
        data: { plainId: "123456789" },
        included: [],
      });
      expect(await transport.resolveProfileActivityBinding("j-hawkins")).toEqual({
        queryId: QUERY_ID,
        profileUrn: PROFILE_URN,
      });
      expect(await transport.readProfileActivityPage({ count: 10, start: 0 }))
        .toEqual({ page: 0 });
      expect(await transport.readProfileActivityPage({ count: 10, start: 10 }))
        .toEqual({ page: 10 });
    } finally {
      await transport.close();
    }
    expect(networkReads).toBe(2);
    expect(pageReads).toBe(2);
    for (const [index, source] of pageSources.entries()) {
      const expectedUrl = linkedInProfileActivityPageUrl({
        queryId: QUERY_ID,
        profileUrn: PROFILE_URN,
        count: 10,
        start: index * 10,
      });
      expect(source).toContain(`${expectedUrl.pathname}${expectedUrl.search}`);
      expect(source).toContain(`\"documentUrl\":\"${target.activityUrl}\"`);
      expect(source).toContain("redirect:\"manual\"");
    }
    expect(commands.some((batch) => batch[0]?.[0] === "open")).toBeTrue();
    expect(commands.some((batch) => batch[0]?.[0] === "network")).toBeTrue();
    expect(commands.some((batch) => batch[0]?.[0] === "get")).toBeTrue();
  });

  test("refuses page reads until navigation establishes the internal binding", async () => {
    const session: BrowserSession = {
      runBatch: () => Promise.resolve([bodyRecord(ME_BODY)]),
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createTransport(session);
    try {
      await transport.currentIdentityResponse();
      await expect(transport.readProfileActivityPage({ count: 10, start: 0 }))
        .rejects.toThrow("page read is out of order");
    } finally {
      await transport.close();
    }
  });

  test("rejects stale observations that did not follow this navigation", async () => {
    const target = linkedInProfileActivityTargetFromVanity("j-hawkins");
    const pageUrl = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    });
    const stale = {
      requestId: "stale-request",
      method: "GET",
      status: 200,
      url: pageUrl.href,
    } as const;
    const session: BrowserSession = {
      runBatch: (batch) => {
        const command = batch[0];
        if (command?.[0] === "eval") return Promise.resolve([bodyRecord(ME_BODY)]);
        if (command?.[0] === "network") return Promise.resolve([networkRecord([stale])]);
        if (command?.[0] === "get") return Promise.resolve([currentUrlRecord(target.activityUrl)]);
        return Promise.resolve([{ success: true, result: null }]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createTransport(session);
    try {
      await transport.currentIdentityResponse();
      await expect(transport.resolveProfileActivityBinding("j-hawkins"))
        .rejects.toThrow("current registered query was not observed");
    } finally {
      await transport.close();
    }
  });

  test("fails closed when navigation lands on another profile or an authwall", async () => {
    const run = async (currentUrl: string): Promise<LinkedInFeedBrowserFailure> => {
      const pageUrl = linkedInProfileActivityPageUrl({
        queryId: QUERY_ID,
        profileUrn: PROFILE_URN,
        count: 10,
        start: 0,
      });
      let networkReads = 0;
      const session: BrowserSession = {
        runBatch: (batch) => {
          const command = batch[0];
          if (command?.[0] === "eval") return Promise.resolve([bodyRecord(ME_BODY)]);
          if (command?.[0] === "network") {
            networkReads += 1;
            return Promise.resolve([networkRecord(
              networkReads === 1 || currentUrl.includes("/uas/login")
                ? []
                : [{
                    requestId: "fresh-request",
                    method: "GET",
                    status: 200,
                    url: pageUrl.href,
                  }],
            )]);
          }
          if (command?.[0] === "get") return Promise.resolve([currentUrlRecord(currentUrl)]);
          return Promise.resolve([{ success: true, result: null }]);
        },
        close: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      };
      const transport = await createTransport(session);
      try {
        await transport.currentIdentityResponse();
        try {
          await transport.resolveProfileActivityBinding("j-hawkins");
        } catch (error) {
          expect(error).toBeInstanceOf(LinkedInFeedBrowserFailure);
          return error as LinkedInFeedBrowserFailure;
        }
        throw new Error("expected LinkedIn navigation to fail closed");
      } finally {
        await transport.close();
      }
    };

    const otherProfile = await run(
      "https://www.linkedin.com/in/other-profile/recent-activity/all/",
    );
    expect(otherProfile.category).toBe("response-envelope");
    expect(otherProfile.message).toContain("left its exact target page");
    const authwall = await run("https://www.linkedin.com/uas/login-submit/");
    expect(authwall.category).toBe("authwall");
    expect(authwall.message).toContain("signed-out authwall");
  });

  test("maps a known authwall reached after binding to auth repair evidence", async () => {
    const target = linkedInProfileActivityTargetFromVanity("j-hawkins");
    const pageUrl = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    });
    let networkReads = 0;
    const session: BrowserSession = {
      runBatch: (batch) => {
        const command = batch[0];
        if (command?.[0] === "eval" && command[1]?.includes("voyagerFeedDashProfileUpdates")) {
          return Promise.reject(new Error(
            "LinkedIn profile-activity browser reached its signed-out authwall",
          ));
        }
        if (command?.[0] === "eval") return Promise.resolve([bodyRecord(ME_BODY)]);
        if (command?.[0] === "network") {
          networkReads += 1;
          return Promise.resolve([networkRecord(networkReads === 1 ? [] : [{
            requestId: "fresh-request",
            method: "GET",
            status: 200,
            url: pageUrl.href,
          }])]);
        }
        if (command?.[0] === "get") return Promise.resolve([currentUrlRecord(target.activityUrl)]);
        return Promise.resolve([{ success: true, result: null }]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createTransport(session);
    try {
      await transport.currentIdentityResponse();
      await transport.resolveProfileActivityBinding("j-hawkins");
      let failure: unknown;
      try {
        await transport.readProfileActivityPage({ count: 10, start: 0 });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LinkedInFeedBrowserFailure);
      expect((failure as LinkedInFeedBrowserFailure).category).toBe("authwall");
      expect((failure as Error).message).toBe(
        "LinkedIn profile-activity browser reached the signed-out authwall",
      );
    } finally {
      await transport.close();
    }
  });

  test("classifies manual and opaque redirects as authwall without leaking the destination", async () => {
    const commands: (readonly (readonly string[])[])[] = [];
    const session: BrowserSession = {
      runBatch: (batch) => {
        commands.push(batch);
        return Promise.resolve([redirectRecord()]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createTransport(session);
    try {
      let failure: unknown;
      try {
        await transport.currentIdentityResponse();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LinkedInFeedBrowserFailure);
      expect((failure as LinkedInFeedBrowserFailure).category).toBe("authwall");
      expect((failure as Error).message).toBe(
        "LinkedIn profile-activity browser reached the signed-out authwall",
      );
      const source = commands[0]?.[0]?.[1] ?? "";
      expect(source).toContain("redirect:\"manual\"");
      expect(source).toContain('response.type===\"opaqueredirect\"');
    } finally {
      await transport.close();
    }
  });

  test("keeps a generic browser fetch failure distinct from observable authwall evidence", async () => {
    const session: BrowserSession = {
      runBatch: () => Promise.reject(new Error("Failed to fetch")),
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createTransport(session);
    try {
      let failure: unknown;
      try {
        await transport.currentIdentityResponse();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LinkedInFeedBrowserFailure);
      expect((failure as LinkedInFeedBrowserFailure).category).toBe("provider-fetch");
      expect((failure as Error).message).not.toContain("authwall");
    } finally {
      await transport.close();
    }
  });

  test("accepts exact 401 auth evidence and rejects inconsistent redirect envelopes", async () => {
    const runIdentity = async (
      record: Readonly<Record<string, unknown>>,
    ): Promise<LinkedInFeedBrowserFailure> => {
      const session: BrowserSession = {
        runBatch: () => Promise.resolve([record]),
        close: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      };
      const transport = await createTransport(session);
      try {
        try {
          await transport.currentIdentityResponse();
        } catch (error) {
          expect(error).toBeInstanceOf(LinkedInFeedBrowserFailure);
          return error as LinkedInFeedBrowserFailure;
        }
        throw new Error("expected LinkedIn identity read to fail closed");
      } finally {
        await transport.close();
      }
    };
    const unauthorized = await runIdentity(rejectedRecord(401));
    expect(unauthorized.category).toBe("authwall");
    const inconsistentRedirect = await runIdentity(rejectedRecord(302));
    expect(inconsistentRedirect.category).toBe("response-envelope");
  });
});
