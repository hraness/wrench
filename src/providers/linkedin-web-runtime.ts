import {
  filterCookies,
} from "@hraness/kb/clip/cookies";

import type { WrenchAuth } from "../auth";
import type { BrowserFileResolver } from "../browser";
import type { OperationInput, WebSessionRecipe } from "../model";
import { canonicalJson, sha256 } from "../canonical-json";
import {
  readSessionSecretSnapshot,
  writeSessionSecretIfUnchanged,
  type SessionSecretSnapshot,
  type SessionSecretWriteResult,
} from "../session-secrets";
import {
  createWebSessionClient,
  webSessionAuthSubject,
  webSessionCookie,
  type WebSessionClient,
  type WebSessionCookieRotationEntry,
  type WebSessionCookieRotationState,
  type WebSessionCookieRotationTombstone,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID,
  linkedInCsrfTokenFromJSessionId,
  linkedInMailboxUrnFromMiniProfile,
  linkedInMessengerConversationsUrl,
  normalizeLinkedInMessagingList,
} from "./linkedin-web";
import { resolveLinkedInMessengerConversationsQueryId } from "./linkedin-web-bootstrap";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const MAX_SUBJECT_BYTES = 2 * 1024 * 1024;
const LINKEDIN_COOKIE_ROTATION_NAMESPACE = "linkedin-cookie-rotation";
const LINKEDIN_ROTATING_COOKIE_NAMES = Object.freeze(["__cf_bm"] as const);
const LINKEDIN_ROTATING_COOKIE_MAX_CACHE_AGE_SECONDS = 24 * 60 * 60;
const LINKEDIN_ROTATING_COOKIE_TOMBSTONE_TTL_SECONDS = 60 * 60;

type JsonRecord = Record<string, unknown>;

export type LinkedInWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly resolveMessengerConversationsQueryId?: typeof resolveLinkedInMessengerConversationsQueryId;
  /** Test seam for the auth-hash-bound encrypted LinkedIn rotation cache. */
  readonly loadCachedCookies?: (
    auth: WrenchAuth,
    authHash: string,
  ) => SessionSecretSnapshot | Promise<SessionSecretSnapshot>;
  /** Test seam for the auth-hash-bound encrypted LinkedIn rotation cache. */
  readonly saveCachedCookies?: (
    auth: WrenchAuth,
    authHash: string,
    value: unknown,
    expectedContentSha256: string | null,
  ) => SessionSecretWriteResult | Promise<SessionSecretWriteResult>;
};

export type LinkedInWebExecutionOptions = {
  readonly dependencies?: LinkedInWebRuntimeDependencies;
  readonly fileResolver?: BrowserFileResolver;
  readonly signal?: AbortSignal;
  readonly operationDeadline?: WebSessionOperationDeadline;
  readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
  readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} has unsupported fields`);
  }
}

const LINKEDIN_COOKIE_KEYS = Object.freeze([
  "name",
  "value",
  "domain",
  "hostOnly",
  "path",
  "secure",
  "httpOnly",
  "sameSite",
  "expires",
] as const);

function parseCachedLinkedInCookie(
  value: unknown,
  acceptedAtSeconds: number,
  nowSeconds: number,
  includesAcceptanceTime: boolean,
): WebSessionCookieRotationEntry | null {
  const cookie = record(value, "LinkedIn rotating-cookie cache entry");
  const expectedKeys = includesAcceptanceTime
    ? [...LINKEDIN_COOKIE_KEYS, "acceptedAtSeconds"]
    : [...LINKEDIN_COOKIE_KEYS];
  exactKeys(cookie, expectedKeys, "LinkedIn rotating-cookie cache entry");
  if (
    !LINKEDIN_ROTATING_COOKIE_NAMES.includes(cookie.name as (typeof LINKEDIN_ROTATING_COOKIE_NAMES)[number])
  ) throw new Error("LinkedIn rotating-cookie cache contains an unreviewed cookie");
  if (
    typeof cookie.expires !== "number"
    || !Number.isSafeInteger(cookie.expires)
    || cookie.expires < 0
    || cookie.expires > 253_402_300_799
  ) throw new Error("LinkedIn rotating-cookie cache has an invalid expiry");
  const expired = cookie.expires > 0 && cookie.expires <= nowSeconds;
  const candidate = { ...cookie };
  delete candidate.acceptedAtSeconds;
  if (expired) candidate.expires = 0;
  const validated = filterCookies([candidate], new URL(LINKEDIN_ORIGIN), nowSeconds);
  if (validated.rejected !== 0 || validated.cookies.length !== 1) {
    throw new Error("LinkedIn rotating-cookie cache is malformed");
  }
  const parsed = validated.cookies[0];
  if (parsed === undefined) throw new Error("LinkedIn rotating-cookie cache is malformed");
  // Schema one did not record when a session cookie was accepted. Preserve
  // legacy values only when their own absolute expiry bounds their lifetime.
  if (expired || (!includesAcceptanceTime && parsed.expires === 0)) return null;
  return Object.freeze({ acceptedAtSeconds, cookie: parsed });
}

function parseCachedLinkedInCookies(value: unknown): WebSessionCookieRotationState {
  if (value === null) {
    return Object.freeze({
      cookies: Object.freeze([]),
      tombstones: Object.freeze([]),
    });
  }
  const cache = record(value, "LinkedIn rotating-cookie cache");
  if (cache.schemaVersion === 1) {
    exactKeys(cache, ["schemaVersion", "origin", "cookies"], "LinkedIn rotating-cookie cache");
  } else if (cache.schemaVersion === 2) {
    exactKeys(
      cache,
      ["schemaVersion", "origin", "cookies", "tombstones"],
      "LinkedIn rotating-cookie cache",
    );
  } else {
    throw new Error("LinkedIn rotating-cookie cache is malformed");
  }
  if (
    cache.origin !== LINKEDIN_ORIGIN
    || !Array.isArray(cache.cookies)
    || cache.cookies.length > 4
    || (cache.schemaVersion === 2 && (!Array.isArray(cache.tombstones) || cache.tombstones.length > 4))
  ) throw new Error("LinkedIn rotating-cookie cache is malformed");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const cookies: WebSessionCookieRotationEntry[] = [];
  for (const item of cache.cookies) {
    const raw = record(item, "LinkedIn rotating-cookie cache entry");
    const acceptedAtSeconds = cache.schemaVersion === 1 ? nowSeconds : raw.acceptedAtSeconds;
    if (
      !Number.isSafeInteger(acceptedAtSeconds)
      || (acceptedAtSeconds as number) < 0
      || (acceptedAtSeconds as number) > nowSeconds + 300
    ) throw new Error("LinkedIn rotating-cookie cache has an invalid acceptance time");
    const parsed = parseCachedLinkedInCookie(
      item,
      acceptedAtSeconds as number,
      nowSeconds,
      cache.schemaVersion === 2,
    );
    if (parsed !== null) cookies.push(parsed);
  }
  const tombstones: WebSessionCookieRotationTombstone[] = [];
  if (cache.schemaVersion === 2) {
    for (const item of cache.tombstones as unknown[]) {
      const tombstone = record(item, "LinkedIn rotating-cookie cache tombstone");
      exactKeys(
        tombstone,
        ["acceptedAtSeconds", "name", "domain", "hostOnly", "path"],
        "LinkedIn rotating-cookie cache tombstone",
      );
      if (
        !Number.isSafeInteger(tombstone.acceptedAtSeconds)
        || (tombstone.acceptedAtSeconds as number) < 0
        || (tombstone.acceptedAtSeconds as number) > nowSeconds + 300
        || !LINKEDIN_ROTATING_COOKIE_NAMES.includes(
          tombstone.name as (typeof LINKEDIN_ROTATING_COOKIE_NAMES)[number],
        )
        || typeof tombstone.domain !== "string"
        || typeof tombstone.hostOnly !== "boolean"
        || typeof tombstone.path !== "string"
      ) throw new Error("LinkedIn rotating-cookie cache tombstone is malformed");
      tombstones.push(Object.freeze({
        acceptedAtSeconds: tombstone.acceptedAtSeconds as number,
        domain: tombstone.domain,
        hostOnly: tombstone.hostOnly,
        name: tombstone.name as string,
        path: tombstone.path,
      }));
    }
  }
  return Object.freeze({
    cookies: Object.freeze(cookies),
    tombstones: Object.freeze(tombstones),
  });
}

type LinkedInRotationCandidate =
  | {
    readonly kind: "cookie";
    readonly acceptedAtSeconds: number;
    readonly entry: WebSessionCookieRotationEntry;
  }
  | {
    readonly kind: "tombstone";
    readonly acceptedAtSeconds: number;
    readonly entry: WebSessionCookieRotationTombstone;
  };

function linkedInRotationIdentity(
  value: StrictCookieIdentity,
): string {
  return `${value.domain}\0${value.hostOnly ? "host" : "domain"}\0${value.path}\0${value.name}`;
}

type StrictCookieIdentity = {
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly name: string;
  readonly path: string;
};

function linkedInRotationCandidates(
  state: WebSessionCookieRotationState,
): ReadonlyMap<string, LinkedInRotationCandidate> {
  const candidates = new Map<string, LinkedInRotationCandidate>();
  for (const entry of state.cookies) {
    const identity = linkedInRotationIdentity(entry.cookie);
    if (candidates.has(identity)) {
      throw new Error("LinkedIn rotating-cookie cache contains a duplicate");
    }
    candidates.set(identity, Object.freeze({
      kind: "cookie",
      acceptedAtSeconds: entry.acceptedAtSeconds,
      entry,
    }));
  }
  for (const entry of state.tombstones) {
    const identity = linkedInRotationIdentity(entry);
    if (candidates.has(identity)) {
      throw new Error("LinkedIn rotating-cookie cache contains a duplicate");
    }
    candidates.set(identity, Object.freeze({
      kind: "tombstone",
      acceptedAtSeconds: entry.acceptedAtSeconds,
      entry,
    }));
  }
  return candidates;
}

function sameLinkedInRotationCandidate(
  left: LinkedInRotationCandidate,
  right: LinkedInRotationCandidate,
): boolean {
  return left.kind === right.kind
    && canonicalJson(left.entry) === canonicalJson(right.entry);
}

function mergeLinkedInRotationStates(
  attempted: WebSessionCookieRotationState,
  latest: WebSessionCookieRotationState,
): WebSessionCookieRotationState {
  const merged = new Map(linkedInRotationCandidates(latest));
  for (const [identity, candidate] of linkedInRotationCandidates(attempted)) {
    const current = merged.get(identity);
    if (
      current === undefined
      || candidate.acceptedAtSeconds > current.acceptedAtSeconds
    ) {
      merged.set(identity, candidate);
      continue;
    }
    if (candidate.acceptedAtSeconds < current.acceptedAtSeconds) continue;
    if (!sameLinkedInRotationCandidate(candidate, current)) {
      throw new Error(
        "LinkedIn rotating session state changed concurrently without a safe ordering",
      );
    }
  }
  const cookies: WebSessionCookieRotationEntry[] = [];
  const tombstones: WebSessionCookieRotationTombstone[] = [];
  for (const [, candidate] of [...merged].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (candidate.kind === "cookie") cookies.push(candidate.entry);
    else tombstones.push(candidate.entry);
  }
  if (cookies.length > 4 || tombstones.length > 4) {
    throw new Error(
      "LinkedIn rotating session state changed concurrently beyond its reviewed bounds",
    );
  }
  return Object.freeze({
    cookies: Object.freeze(cookies),
    tombstones: Object.freeze(tombstones),
  });
}

function cachedLinkedInCookiesValue(
  state: WebSessionCookieRotationState,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 2,
    origin: LINKEDIN_ORIGIN,
    cookies: Object.freeze(state.cookies.map(({ acceptedAtSeconds, cookie }) =>
      Object.freeze({ ...cookie, acceptedAtSeconds }))),
    tombstones: Object.freeze(state.tombstones.map((tombstone) =>
      Object.freeze({ ...tombstone }))),
  });
}

function linkedInCacheHasOrderedProvenance(
  value: unknown,
  contentSha256: string | null,
): boolean {
  if (value === null) return contentSha256 === null;
  return isRecord(value) && value.schemaVersion === 2;
}

async function loadLinkedInCookieSnapshot(
  auth: WrenchAuth,
  authHash: string,
  dependencies: LinkedInWebRuntimeDependencies | undefined,
): Promise<SessionSecretSnapshot> {
  if (
    (dependencies?.loadCachedCookies === undefined)
    !== (dependencies?.saveCachedCookies === undefined)
  ) {
    throw new Error(
      "LinkedIn rotating-session cache dependencies must be provided together",
    );
  }
  return dependencies?.loadCachedCookies === undefined
    ? readSessionSecretSnapshot(
      LINKEDIN_COOKIE_ROTATION_NAMESPACE,
      auth.id,
      authHash,
    )
    : dependencies.loadCachedCookies(auth, authHash);
}

async function saveLinkedInCookieSnapshot(
  auth: WrenchAuth,
  authHash: string,
  value: unknown,
  expectedContentSha256: string | null,
  dependencies: LinkedInWebRuntimeDependencies | undefined,
): Promise<SessionSecretWriteResult> {
  return dependencies?.saveCachedCookies === undefined
    ? writeSessionSecretIfUnchanged(
      LINKEDIN_COOKIE_ROTATION_NAMESPACE,
      auth.id,
      authHash,
      value,
      expectedContentSha256,
    )
    : dependencies.saveCachedCookies(
      auth,
      authHash,
      value,
      expectedContentSha256,
    );
}

async function createLinkedInClient(
  auth: WrenchAuth,
  timeoutMs: number,
  dependencies: LinkedInWebRuntimeDependencies | undefined,
  budget: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
  } = {},
): Promise<WebSessionClient> {
  const authHash = sha256(canonicalJson(auth));
  const initialSnapshot = await loadLinkedInCookieSnapshot(
    auth,
    authHash,
    dependencies,
  );
  let expectedContentSha256 = initialSnapshot.contentSha256;
  let cacheHasOrderedProvenance = linkedInCacheHasOrderedProvenance(
    initialSnapshot.value,
    initialSnapshot.contentSha256,
  );
  const cachedState = parseCachedLinkedInCookies(initialSnapshot.value);
  return createWebSessionClient(LINKEDIN_ORIGIN, auth, {
    timeoutMs,
    ...(budget.signal === undefined ? {} : { signal: budget.signal }),
    ...(budget.operationDeadline === undefined
      ? {}
      : { operationDeadline: budget.operationDeadline }),
    ...(dependencies === undefined ? {} : { dependencies }),
    cookieRotation: {
      allowedNames: LINKEDIN_ROTATING_COOKIE_NAMES,
      cachedState,
      maxCachedCookieAgeSeconds: LINKEDIN_ROTATING_COOKIE_MAX_CACHE_AGE_SECONDS,
      tombstoneTtlSeconds: LINKEDIN_ROTATING_COOKIE_TOMBSTONE_TTL_SECONDS,
      save: async (state) => {
        const value = cachedLinkedInCookiesValue(state);
        const saved = await saveLinkedInCookieSnapshot(
          auth,
          authHash,
          value,
          expectedContentSha256,
          dependencies,
        );
        if (saved.written) {
          expectedContentSha256 = saved.contentSha256;
          cacheHasOrderedProvenance = true;
          return;
        }
        const latestSnapshot = await loadLinkedInCookieSnapshot(
          auth,
          authHash,
          dependencies,
        );
        if (
          latestSnapshot.contentSha256 === null
          || latestSnapshot.contentSha256 === expectedContentSha256
        ) {
          throw new Error(
            "LinkedIn rotating session state changed concurrently; retry with a fresh session",
          );
        }
        if (
          !cacheHasOrderedProvenance
          || !linkedInCacheHasOrderedProvenance(
            latestSnapshot.value,
            latestSnapshot.contentSha256,
          )
        ) {
          throw new Error(
            "LinkedIn rotating session state changed concurrently without ordered provenance",
          );
        }
        const latest = parseCachedLinkedInCookies(latestSnapshot.value);
        const merged = mergeLinkedInRotationStates(state, latest);
        if (canonicalJson(merged) !== canonicalJson(latest)) {
          const reconciled = await saveLinkedInCookieSnapshot(
            auth,
            authHash,
            cachedLinkedInCookiesValue(merged),
            latestSnapshot.contentSha256,
            dependencies,
          );
          if (!reconciled.written) {
            throw new Error(
              "LinkedIn rotating session state changed repeatedly; retry with a fresh session",
            );
          }
        }
        throw new Error(
          "LinkedIn rotating session state was reconciled concurrently; retry with a fresh session",
        );
      },
    },
  });
}

function responseErrors(value: JsonRecord, label: string): void {
  if (value.serviceErrorCode !== undefined) throw new Error(`${label} contained a service error`);
  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors) || value.errors.length > 0) throw new Error(`${label} contained provider errors`);
  }
  if (typeof value.status === "number" && value.status >= 400) throw new Error(`${label} contained a failure status`);
}

function headers(csrf: string, referer: string): Readonly<Record<string, string>> {
  return {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "csrf-token": csrf,
    referer,
    "x-li-lang": "en_US",
    "x-requested-with": "XMLHttpRequest",
    "x-restli-protocol-version": "2.0.0",
  };
}

function linkedInMemberIdFromUrn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^urn:li:(?:fsd_profile|member):([0-9]{1,32})$/u.exec(value)?.[1] ?? null;
}

function linkedInMiniProfileUrn(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  return /^urn:li:fs_miniProfile:[A-Za-z0-9_-]{1,256}$/u.test(value) ? value : null;
}

type LinkedInCurrentIdentity = {
  readonly subject: string;
  readonly mailboxUrn: string | null;
};

function identityFromMeResponse(value: unknown): LinkedInCurrentIdentity {
  const envelope = record(value, "LinkedIn /voyager/api/me response");
  responseErrors(envelope, "LinkedIn /voyager/api/me response");
  const data = record(envelope.data, "LinkedIn /voyager/api/me response.data");
  const primaryId = typeof data.plainId === "string" && /^[0-9]{1,32}$/u.test(data.plainId)
    ? data.plainId
    : Number.isSafeInteger(data.plainId) && (data.plainId as number) > 0
      ? String(data.plainId)
      : null;
  if (primaryId === null) {
    throw new Error("LinkedIn /voyager/api/me omitted its exact primary member subject");
  }
  const included = envelope.included === undefined ? [] : envelope.included;
  if (!Array.isArray(included) || included.length > 10_000) {
    throw new Error("LinkedIn /voyager/api/me response.included must be a bounded array");
  }
  const entities: JsonRecord[] = [];
  for (const item of included) {
    if (!isRecord(item)) throw new Error("LinkedIn /voyager/api/me included an invalid entity");
    entities.push(item);
  }

  if (data.miniProfile !== undefined) {
    const reference = linkedInMiniProfileUrn(data.miniProfile);
    if (reference === null) {
      throw new Error("LinkedIn /voyager/api/me included an invalid normalized profile reference");
    }
    const referenced = entities.filter((item) => item.entityUrn === reference || item.urn === reference);
    if (referenced.length === 0) {
      throw new Error("LinkedIn /voyager/api/me did not corroborate its normalized profile reference");
    }
    if (referenced.length !== 1) {
      throw new Error("LinkedIn /voyager/api/me included an ambiguous normalized profile reference");
    }
    const memberId = typeof referenced[0]?.objectUrn === "string"
      ? /^urn:li:member:([0-9]{1,32})$/u.exec(referenced[0].objectUrn)?.[1] ?? null
      : null;
    if (memberId === null) {
      throw new Error("LinkedIn /voyager/api/me did not bind its normalized profile to one member subject");
    }
    if (memberId !== primaryId) {
      throw new Error("LinkedIn /voyager/api/me included a conflicting member subject");
    }
    return Object.freeze({
      subject: `urn:li:fsd_profile:${primaryId}`,
      mailboxUrn: linkedInMailboxUrnFromMiniProfile(reference),
    });
  }

  const corroborated = entities.some((item) =>
    ["entityUrn", "backendUrn", "objectUrn", "urn"]
      .some((field) => linkedInMemberIdFromUrn(item[field]) === primaryId));
  if (!corroborated) {
    throw new Error("LinkedIn /voyager/api/me did not corroborate its primary member subject");
  }
  return Object.freeze({
    subject: `urn:li:fsd_profile:${primaryId}`,
    mailboxUrn: null,
  });
}

async function currentIdentity(
  client: WebSessionClient,
  csrf: string,
): Promise<LinkedInCurrentIdentity> {
  const response = await client.requestJson({
    url: new URL("/voyager/api/me", LINKEDIN_ORIGIN),
    method: "GET",
    headers: headers(csrf, `${LINKEDIN_ORIGIN}/feed/`),
    expectedContentTypes: ["application/vnd.linkedin.normalized+json+2.1", "application/json"],
    maxBytes: MAX_SUBJECT_BYTES,
  });
  return identityFromMeResponse(response);
}

export async function probeLinkedInWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: LinkedInWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createLinkedInClient(
    auth,
    options.timeoutMs ?? 60_000,
    options.dependencies,
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const csrf = linkedInCsrfTokenFromJSessionId(webSessionCookie(client.cookies, "JSESSIONID"));
  return (await currentIdentity(client, csrf)).subject;
}

function integerInput(
  input: OperationInput,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[name] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`input.${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function linkedInReadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("cookie")
    || message.includes("session")
    || message.includes("current member")
    || message.includes("primary member subject")
    || /status\/content type (?:302|401|403)\//u.test(message)
  ) {
    return "LinkedIn signed-in session or account binding failed preflight; refresh the selected browser realm and bind it again";
  }
  if (
    message.includes("registered revision")
    || message.includes("query failed")
    || message.includes("query revision")
  ) {
    return "LinkedIn inbox query revision drifted; capture and review the current first-party contract before retrying";
  }
  if (
    message.includes("mailbox")
    || message.includes("normalized profile")
    || message.includes("/voyager/api/me")
  ) {
    return "LinkedIn current-account projection drifted before the inbox read; capture and review the new identity binding";
  }
  return "LinkedIn inbox read failed before any remote write; no conversation was opened or acknowledged";
}

function assertLinkedInWebExecutionAvailable(): void {
  throw new Error(
    "LinkedIn authenticated web operations are capture-required; recapture and review the current first-party contract before execution",
  );
}

export async function executeLinkedInWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: LinkedInWebExecutionOptions = {},
): Promise<WebSessionExecution> {
  // Keep the strict candidate implementation available for recapture work, but
  // make the directly exported boundary fail before it can acquire cookies,
  // inspect browser state, bootstrap a query, or issue network traffic.
  assertLinkedInWebExecutionAvailable();
  if (
    recipe.site !== "linkedin"
    || recipe.contractVersion !== 1
    || recipe.action !== "messaging.list"
  ) throw new Error(`LinkedIn authenticated web operation ${recipe.action} has no executable reviewed contract`);
  try {
    if (input.cursor !== undefined) {
      throw new Error("LinkedIn messaging.list cursor pagination is capture-required");
    }
    const folder = input.folder;
    if (typeof folder !== "string") throw new Error("input.folder must be a LinkedIn inbox folder");
    const limit = integerInput(input, "limit", 20, 1, 100);
    const client = await createLinkedInClient(
      auth,
      recipe.timeoutMs,
      options.dependencies,
      options,
    );
    const csrf = linkedInCsrfTokenFromJSessionId(webSessionCookie(client.cookies, "JSESSIONID"));
    const identity = await currentIdentity(client, csrf);
    const expectedSubject = webSessionAuthSubject(auth);
    if (expectedSubject === null || expectedSubject !== identity.subject) {
      throw new Error("LinkedIn current member no longer matches the bound auth subject");
    }
    if (identity.mailboxUrn === null) {
      throw new Error("LinkedIn current-account response omitted the mailbox-bound normalized profile");
    }
    const requestConversations = (queryId: string): Promise<unknown> => client.requestJson({
      url: linkedInMessengerConversationsUrl(identity.mailboxUrn, queryId),
      method: "GET",
      headers: headers(csrf, `${LINKEDIN_ORIGIN}/feed/`),
      expectedContentTypes: [
        "application/graphql",
        "application/vnd.linkedin.normalized+json+2.1",
        "application/json",
      ],
      maxBytes: recipe.maxOutputBytes,
    });
    let response: unknown;
    try {
      response = await requestConversations(LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID);
    } catch (initialError) {
      const resolveQueryId = options.dependencies?.resolveMessengerConversationsQueryId
        ?? resolveLinkedInMessengerConversationsQueryId;
      let currentQueryId: string;
      try {
        currentQueryId = await resolveQueryId(auth, identity.mailboxUrn, {
          timeoutMs: options.operationDeadline?.remainingTimeMs()
            ?? recipe.timeoutMs,
        });
      } catch (bootstrapError) {
        throw new Error("LinkedIn inbox query failed and its current registered revision could not be resolved", {
          cause: bootstrapError,
        });
      }
      if (currentQueryId === LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID) throw initialError;
      response = await requestConversations(currentQueryId);
    }
    return {
      status: "succeeded",
      output: normalizeLinkedInMessagingList(response, folder, limit),
      finalUrl: `${LINKEDIN_ORIGIN}/messaging/`,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    };
  } catch (error) {
    return {
      status: "failed",
      output: null,
      finalUrl: `${LINKEDIN_ORIGIN}/messaging/`,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      error: linkedInReadFailure(error),
    };
  }
}
