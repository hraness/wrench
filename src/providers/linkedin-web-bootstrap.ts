import type { WrenchAuth } from "../auth";
import {
  browserResultData,
  createBrowserSession,
  type BrowserSession,
  type CreateBrowserSessionOptions,
} from "../browser";
import type { WrenchManifest } from "../model";
import {
  LINKEDIN_MESSENGER_CONVERSATIONS_QUERY_PREFIX,
  assertLinkedInMessengerConversationsRequest,
  resolveLinkedInRegisteredQueryId,
} from "./linkedin-web";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const MAX_NETWORK_REQUESTS = 10_000;
const MAX_REQUEST_URL_CHARACTERS = 64 * 1_024;

const bootstrapManifest: WrenchManifest = Object.freeze({
  schemaVersion: 4,
  id: "linkedin-query-bootstrap",
  version: "1.0.0",
  displayName: "LinkedIn registered-query bootstrap",
  surfaceId: "linkedin",
  origins: Object.freeze([LINKEDIN_ORIGIN]),
  // Consumer JavaScript is first-party but served from LinkedIn's static
  // asset origin. Cookie-source sessions remain contained to these two hosts.
  browserDomains: Object.freeze(["www.linkedin.com", "static.licdn.com"]),
  operations: Object.freeze({}),
});

export type LinkedInQueryBootstrapDependencies = {
  readonly createSession: (
    manifest: WrenchManifest,
    auth: WrenchAuth,
    options: CreateBrowserSessionOptions,
  ) => Promise<BrowserSession>;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function observedRequests(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  const envelope = record(value);
  if (envelope === null || !Array.isArray(envelope.requests) || envelope.requests.length > MAX_NETWORK_REQUESTS) {
    throw new Error("LinkedIn network observation returned a malformed bounded request list");
  }
  const requests: Readonly<Record<string, unknown>>[] = [];
  for (const item of envelope.requests) {
    const request = record(item);
    if (request === null) throw new Error("LinkedIn network observation returned a malformed request");
    requests.push(request);
  }
  return requests;
}

function queryCandidates(value: unknown, expectedMailboxUrn: string): readonly string[] {
  const candidates: string[] = [];
  for (const request of observedRequests(value)) {
    if (
      request.method !== "GET"
      || request.status !== 200
      || typeof request.url !== "string"
      || request.url.length > MAX_REQUEST_URL_CHARACTERS
    ) continue;
    let reviewed: URL;
    try {
      reviewed = assertLinkedInMessengerConversationsRequest({
        method: request.method,
        url: request.url,
      }, expectedMailboxUrn);
    } catch {
      continue;
    }
    const queryId = reviewed.searchParams.get("queryId");
    if (queryId !== null) candidates.push(queryId);
  }
  return Object.freeze(candidates);
}

/**
 * Resolve only the current registered-query revision from first-party request
 * metadata. The browser never returns message content and never performs the
 * semantic inbox read for wrench; direct pinned HTTPS does that separately.
 */
export async function resolveLinkedInMessengerConversationsQueryId(
  auth: WrenchAuth,
  expectedMailboxUrn: string,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: Partial<LinkedInQueryBootstrapDependencies>;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const createSession = options.dependencies?.createSession ?? createBrowserSession;
  const session = await createSession(bootstrapManifest, auth, {
    headed: false,
    timeoutMs,
    maxOutputBytes: 8 * 1024 * 1024,
    allowCodeOwnedNetworkObservation: true,
  });
  let operationError: unknown;
  let queryId: string | undefined;
  try {
    await session.runBatch([["open", `${LINKEDIN_ORIGIN}/feed/`]], timeoutMs, 2 * 1024 * 1024);
    await session.runBatch([["wait", "8000"]], Math.min(timeoutMs, 20_000), 1024 * 1024);
    const entries = await session.runBatch(
      [["network", "requests", "--filter", LINKEDIN_MESSENGER_CONVERSATIONS_QUERY_PREFIX]],
      Math.min(timeoutMs, 30_000),
      8 * 1024 * 1024,
    );
    const result = entries[0];
    if (result === undefined) throw new Error("LinkedIn network observation omitted its result");
    const candidates = queryCandidates(browserResultData(result), expectedMailboxUrn);
    queryId = resolveLinkedInRegisteredQueryId(
      LINKEDIN_MESSENGER_CONVERSATIONS_QUERY_PREFIX,
      candidates,
    );
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await session.close();
    await session.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) {
    throw new Error(
      "LinkedIn registered-query bootstrap failed and private browser cleanup could not be verified",
      { cause: cleanupError },
    );
  }
  if (operationError !== undefined) {
    throw new Error("LinkedIn current registered query was not observed", { cause: operationError });
  }
  if (queryId !== undefined) return queryId;
  throw new Error("LinkedIn registered-query bootstrap ended without a result");
}
