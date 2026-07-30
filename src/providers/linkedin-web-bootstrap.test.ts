import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { BrowserSession, CreateBrowserSessionOptions } from "../browser";
import type { WrenchManifest } from "../model";
import { linkedInMessengerConversationsUrl } from "./linkedin-web";
import {
  resolveLinkedInMessengerConversationsQueryId,
  type LinkedInQueryBootstrapDependencies,
} from "./linkedin-web-bootstrap";

const MAILBOX_URN = "urn:li:fsd_profile:ACoAAExactMailbox";
const QUERY_ID = "messengerConversations.0123456789abcdef0123456789abcdef";

const auth = {
  schemaVersion: 1,
  id: "linkedin-bootstrap-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: "urn:li:fsd_profile:123456789",
} as const satisfies WrenchAuth;

type BootstrapFixture = {
  readonly dependencies: LinkedInQueryBootstrapDependencies;
  readonly commands: (readonly (readonly string[])[])[];
  readonly manifests: WrenchManifest[];
  readonly options: CreateBrowserSessionOptions[];
  readonly closed: { value: boolean };
  readonly cleaned: { value: boolean };
};

function fixture(requestUrls: readonly URL[]): BootstrapFixture {
  const commands: (readonly (readonly string[])[])[] = [];
  const manifests: WrenchManifest[] = [];
  const options: CreateBrowserSessionOptions[] = [];
  const closed = { value: false };
  const cleaned = { value: false };
  const session: BrowserSession = {
    runBatch: (batch) => {
      commands.push(batch);
      const command = batch[0];
      if (command?.[0] === "network") {
        return Promise.resolve([{
          success: true,
          result: {
            requests: requestUrls.map((url, index) => ({
              id: `request-${index + 1}`,
              method: "GET",
              status: 200,
              url: url.href,
            })),
          },
        }]);
      }
      return Promise.resolve([{ success: true, result: null }]);
    },
    close: () => {
      closed.value = true;
      return Promise.resolve();
    },
    cleanup: () => {
      cleaned.value = true;
      return Promise.resolve();
    },
  };
  const createSession: LinkedInQueryBootstrapDependencies["createSession"] = (
    manifest,
    _auth,
    createOptions,
  ) => {
    manifests.push(manifest);
    options.push(createOptions);
    return Promise.resolve(session);
  };
  return {
    dependencies: { createSession },
    commands,
    manifests,
    options,
    closed,
    cleaned,
  };
}

describe("LinkedIn code-owned registered-query bootstrap", () => {
  test("projects one exact current query ID and always destroys private browser state", async () => {
    const value = fixture([
      linkedInMessengerConversationsUrl(MAILBOX_URN, QUERY_ID),
      linkedInMessengerConversationsUrl(MAILBOX_URN, QUERY_ID),
    ]);
    expect(await resolveLinkedInMessengerConversationsQueryId(auth, MAILBOX_URN, {
      timeoutMs: 30_000,
      dependencies: value.dependencies,
    })).toBe(QUERY_ID);
    expect(value.manifests).toHaveLength(1);
    expect(value.manifests[0]?.browserDomains).toEqual(["www.linkedin.com", "static.licdn.com"]);
    expect(value.options[0]?.allowCodeOwnedNetworkObservation).toBe(true);
    expect(value.commands).toEqual([
      [["open", "https://www.linkedin.com/feed/"]],
      [["wait", "8000"]],
      [["network", "requests", "--filter", "messengerConversations"]],
    ]);
    expect(value.closed.value).toBe(true);
    expect(value.cleaned.value).toBe(true);
  });

  test("rejects wrong-account, wrong-method, and ambiguous revisions without returning raw metadata", async () => {
    const otherMailbox = linkedInMessengerConversationsUrl(
      "urn:li:fsd_profile:ACoAAOtherMailbox",
      QUERY_ID,
    );
    const secondRevision = linkedInMessengerConversationsUrl(
      MAILBOX_URN,
      "messengerConversations.fedcba9876543210fedcba9876543210",
    );
    const value = fixture([otherMailbox, secondRevision, linkedInMessengerConversationsUrl(MAILBOX_URN, QUERY_ID)]);
    let message = "";
    try {
      await resolveLinkedInMessengerConversationsQueryId(auth, MAILBOX_URN, {
        timeoutMs: 30_000,
        dependencies: value.dependencies,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("LinkedIn current registered query was not observed");
    expect(message).not.toContain("ACoAA");
    expect(value.closed.value).toBe(true);
    expect(value.cleaned.value).toBe(true);
  });
});
