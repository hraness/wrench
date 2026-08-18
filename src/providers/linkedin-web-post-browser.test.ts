import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { BrowserSession } from "../browser";
import { createLinkedInPostBrowserTransport } from "./linkedin-web-post-browser";

const auth = {
  schemaVersion: 1,
  id: "linkedin-post-browser-test",
  kind: "browser-profile",
  profile: "Disposable LinkedIn",
  browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  trustUnfilteredEgress: true,
  subject: "urn:li:fsd_profile:123456789",
} as const satisfies WrenchAuth;

const FIRST_PAGE_INSTANCE =
  "urn:li:page:d_flagship3_feed_first;fixture==";
const NEWEST_PAGE_INSTANCE =
  "urn:li:page:d_flagship3_feed_newest;fixture==";
const firstTrack = JSON.stringify({ mpName: "voyager-web", request: "first" });
const newestTrack = JSON.stringify({ mpName: "voyager-web", request: "newest" });

function browserRecord(
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: { origin: "https://www.linkedin.com/feed/", result },
  };
}

describe("LinkedIn native post contained-browser transport", () => {
  test("uses the newest validated feed page binding when LinkedIn rotates page instances", async () => {
    let evaluationSource = "";
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          expect(commands).toEqual([
            ["open", "https://www.linkedin.com/feed/"],
            ["wait", "5000"],
          ]);
          return Promise.resolve([{ success: true, result: { opened: true } }]);
        }
        if (command?.[0] === "network") {
          return Promise.resolve([{
            success: true,
            result: {
              requests: [
                {
                  method: "GET",
                  status: 200,
                  url: "https://www.linkedin.com/voyager/api/graphql?fixture=first",
                  headers: {
                    "x-li-page-instance": FIRST_PAGE_INSTANCE,
                    "x-li-track": firstTrack,
                  },
                },
                {
                  method: "GET",
                  status: 200,
                  url: "https://www.linkedin.com/voyager/api/graphql?fixture=newest",
                  headers: {
                    "x-li-page-instance": NEWEST_PAGE_INSTANCE,
                    "x-li-track": newestTrack,
                  },
                },
              ],
            },
          }]);
        }
        if (command?.[0] !== "eval" || command[1] === undefined) {
          throw new Error(`unexpected LinkedIn post browser command ${command?.[0] ?? "missing"}`);
        }
        evaluationSource = command[1];
        return Promise.resolve([browserRecord({
          mediaUrn: "urn:li:digitalmediaAsset:C4D22AQExactImage",
        })]);
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    };

    const transport = await createLinkedInPostBrowserTransport(auth, {
      timeoutMs: 10_000,
      dependencies: {
        createBrowserSession: () => Promise.resolve(session),
      },
    });
    expect(await transport.uploadImage(auth.subject, new Uint8Array(24))).toBe(
      "urn:li:digitalmediaAsset:C4D22AQExactImage",
    );
    await transport.close();

    const match = /const input=(\{.*?\});if\(location\.origin/u.exec(evaluationSource);
    expect(match?.[1]).toBeDefined();
    expect(JSON.parse(match?.[1] ?? "null")).toMatchObject({
      pageInstance: NEWEST_PAGE_INSTANCE,
      track: newestTrack,
    });
    expect(closed).toBeTrue();
    expect(cleaned).toBeTrue();
  });
});
