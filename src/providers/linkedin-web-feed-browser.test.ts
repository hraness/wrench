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

describe("LinkedIn profile-activity browser transport", () => {
  test("binds identity, observes one registered query, and reads the exact GraphQL page", async () => {
    const commands: (readonly (readonly string[])[])[] = [];
    const pageUrl = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    });
    const session: BrowserSession = {
      runBatch: (batch) => {
        commands.push(batch);
        const command = batch[0];
        if (command?.[0] === "eval" && command[1]?.includes("voyagerFeedDashProfileUpdates")) {
          return Promise.resolve([bodyRecord(JSON.stringify({ data: { data: {} }, included: [] }))]);
        }
        if (command?.[0] === "eval" && command[1]?.includes("/voyager/api/me")) {
          return Promise.resolve([bodyRecord(ME_BODY)]);
        }
        if (command?.[0] === "network") {
          return Promise.resolve([{
            success: true,
            result: {
              requests: [{
                id: "request-1",
                method: "GET",
                status: 200,
                url: pageUrl.href,
              }],
            },
          }]);
        }
        return Promise.resolve([{ success: true, result: null }]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const createSession = (
      _manifest: unknown,
      _auth: WrenchAuth,
      options: CreateBrowserSessionOptions,
    ) => {
      expect(options.allowCodeOwnedEvaluation).toBeTrue();
      expect(options.allowCodeOwnedNetworkObservation).toBeTrue();
      return Promise.resolve(session);
    };
    const transport = await createLinkedInFeedBrowserTransport(auth, {
      timeoutMs: 10_000,
      maxOutputBytes: 1_048_576,
      dependencies: { createBrowserSession: createSession },
    });
    expect(await transport.currentIdentityResponse()).toEqual({
      data: { plainId: "123456789" },
      included: [],
    });
    expect(await transport.resolveProfileActivityBinding("j-hawkins")).toEqual({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
    });
    expect(await transport.readProfileActivityPage({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    })).toEqual({ data: { data: {} }, included: [] });
    await transport.close();
    expect(commands.some((batch) => batch[0]?.[0] === "open")).toBeTrue();
    expect(commands.some((batch) => batch[0]?.[0] === "network")).toBeTrue();
  });

  test("fails closed on a signed-out identity rejection", async () => {
    const session: BrowserSession = {
      runBatch: () => Promise.resolve([rejectedRecord(401)]),
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createLinkedInFeedBrowserTransport(auth, {
      timeoutMs: 10_000,
      maxOutputBytes: 1_048_576,
      dependencies: {
        createBrowserSession: () => Promise.resolve(session),
      },
    });
    try {
      await expect(transport.currentIdentityResponse()).rejects.toBeInstanceOf(
        LinkedInFeedBrowserFailure,
      );
      await expect(transport.currentIdentityResponse()).rejects.toThrow("signed-out authwall");
    } finally {
      await transport.close();
    }
  });
});
