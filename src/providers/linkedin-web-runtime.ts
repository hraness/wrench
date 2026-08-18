import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  filterCookies,
} from "@hraness/kb/clip/cookies";

import type { WrenchAuth } from "../auth";
import {
  browserCleanupBarrier,
  type BrowserFileResolver,
} from "../browser";
import type { FileInputValue, OperationInput, WebSessionRecipe } from "../model";
import { canonicalJson, sha256 } from "../canonical-json";
import {
  parseArticleDraftDocument,
  parseArticleDraftDocumentV2,
} from "../article-draft-document";
import {
  materializeArticleDraftImage,
  materializeArticleDraftImages,
} from "../article-draft-images";
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
  WebSessionCleanupBarrierRegistrar,
  WebSessionCleanupResourcePublisher,
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
  WebSessionProviderAcceptedMutationTargetEvent,
} from "../web-session-execution";
import { startWebSessionCleanupTrackedOperation } from "../web-session-execution";
import {
  LINKEDIN_ARTICLE_PAGE_MAX_CHARACTERS,
  LINKEDIN_FIRST_PARTY_ARTICLES_PATH,
  LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID,
  buildLinkedInArticleCoverPatch,
  buildLinkedInArticleContentPatch,
  buildLinkedInArticleContentPatchV2,
  buildLinkedInArticleCreateBody,
  buildLinkedInArticleTitlePatch,
  buildLinkedInPostCreateVariables,
  linkedInArticleDraftEditUrl,
  linkedInArticleDraftEnvelopeFromHtml,
  linkedInArticleDraftEntityUrl,
  linkedInArticleDraftId,
  linkedInCsrfTokenFromJSessionId,
  linkedInMailboxUrnFromMiniProfile,
  linkedInMessengerConversationsUrl,
  linkedInPostAltText,
  linkedInPostEntityUrn,
  linkedInPostMediaUrn,
  linkedInPostText,
  linkedInPostVisibility,
  normalizeLinkedInPostProjection,
  normalizeLinkedInArticleDraft,
  normalizeLinkedInArticleDraftMetadata,
  normalizeLinkedInArticleDraftSnapshot,
  normalizeLinkedInArticleDraftV2,
  normalizeLinkedInArticleDraftV2Metadata,
  normalizeLinkedInMessagingList,
} from "./linkedin-web";
import { resolveLinkedInMessengerConversationsQueryId } from "./linkedin-web-bootstrap";
import {
  createLinkedInArticleBrowserTransport,
  type LinkedInArticleBrowserTransport,
} from "./linkedin-web-article-browser";
import {
  createLinkedInPostBrowserTransport,
  type LinkedInPostBrowserTransport,
} from "./linkedin-web-post-browser";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const MAX_SUBJECT_BYTES = 2 * 1024 * 1024;
const LINKEDIN_COOKIE_ROTATION_NAMESPACE = "linkedin-cookie-rotation";
const LINKEDIN_ROTATING_COOKIE_NAMES = Object.freeze(["__cf_bm"] as const);
const LINKEDIN_ROTATING_COOKIE_MAX_CACHE_AGE_SECONDS = 24 * 60 * 60;
const LINKEDIN_ROTATING_COOKIE_TOMBSTONE_TTL_SECONDS = 60 * 60;
const MAX_LINKEDIN_ARTICLE_BLOCKS = 5_000;
const MAX_LINKEDIN_ARTICLE_CHARACTERS = 125_000;
const MAX_LINKEDIN_ARTICLE_INLINE_IMAGES = 20;
const MAX_LINKEDIN_ARTICLE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_LINKEDIN_POST_IMAGE_BYTES = 20 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type LinkedInWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly createArticleBrowserTransport?: typeof createLinkedInArticleBrowserTransport;
  readonly createPostBrowserTransport?: typeof createLinkedInPostBrowserTransport;
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
  readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
  readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
  readonly afterProviderAcceptedMutationTarget?: (
    event: WebSessionProviderAcceptedMutationTargetEvent,
  ) => Promise<void>;
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
  readonly profileUrn: string | null;
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

  const profileReferences = [data["*miniProfile"], data.miniProfile]
    .filter((reference) => reference !== undefined);
  if (profileReferences.length > 1) {
    throw new Error("LinkedIn /voyager/api/me included ambiguous normalized profile references");
  }
  if (profileReferences.length === 1) {
    const reference = linkedInMiniProfileUrn(profileReferences[0]);
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
      profileUrn: linkedInMailboxUrnFromMiniProfile(reference),
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
    profileUrn: null,
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

function linkedInArticleHeaders(
  csrf: string,
  referer: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...headers(csrf, referer),
    "content-type": "application/json; charset=UTF-8",
  });
}

async function createDirectLinkedInArticleTransport(
  auth: WrenchAuth,
  timeoutMs: number,
  options: LinkedInWebExecutionOptions,
): Promise<LinkedInArticleBrowserTransport> {
  const client = await createLinkedInClient(
    auth,
    timeoutMs,
    options.dependencies,
    options,
  );
  const csrf = linkedInCsrfTokenFromJSessionId(
    webSessionCookie(client.cookies, "JSESSIONID"),
  );
  const transport: LinkedInArticleBrowserTransport = {
    currentIdentityResponse: () => client.requestJson({
      url: new URL("/voyager/api/me", LINKEDIN_ORIGIN),
      method: "GET",
      headers: headers(csrf, `${LINKEDIN_ORIGIN}/feed/`),
      expectedContentTypes: [
        "application/vnd.linkedin.normalized+json+2.1",
        "application/json",
      ],
      maxBytes: MAX_SUBJECT_BYTES,
    }),
    prepareCreateDraft: () => Promise.resolve(),
    createDraft: async (profileUrn, title) => {
      const response = await client.requestStatus({
        url: new URL(`${LINKEDIN_FIRST_PARTY_ARTICLES_PATH}/`, LINKEDIN_ORIGIN),
        method: "POST",
        headers: linkedInArticleHeaders(
          csrf,
          `${LINKEDIN_ORIGIN}/article/new/`,
        ),
        body: canonicalJson(buildLinkedInArticleCreateBody(profileUrn, title)),
        expectedStatuses: [201],
        reviewedResponseIdHeader: "x-restli-id",
      });
      return response.responseId ?? null;
    },
    readDraftResponse: async (draftId) => {
      const url = linkedInArticleDraftEditUrl(draftId);
      const html = await client.requestText({
        url,
        headers: { accept: "text/html", referer: url.href },
        expectedContentTypes: ["text/html"],
        maxBytes: LINKEDIN_ARTICLE_PAGE_MAX_CHARACTERS,
      });
      return linkedInArticleDraftEnvelopeFromHtml(html, draftId);
    },
    updateTitle: async (draftId, title) => {
      await client.requestStatus({
        url: linkedInArticleDraftEntityUrl(draftId),
        method: "POST",
        headers: linkedInArticleHeaders(csrf, articleEditUrl(draftId)),
        body: canonicalJson(buildLinkedInArticleTitlePatch(title)),
        expectedStatuses: [200],
      });
    },
    updateContent: async (draftId, document) => {
      await client.requestStatus({
        url: linkedInArticleDraftEntityUrl(draftId),
        method: "POST",
        headers: linkedInArticleHeaders(csrf, articleEditUrl(draftId)),
        body: canonicalJson(buildLinkedInArticleContentPatch(document)),
        expectedStatuses: [200],
      });
    },
    uploadInlineImage: () => {
      throw new Error(
        "LinkedIn Article inline images require the reviewed browser-bound upload transport",
      );
    },
    uploadCoverImage: () => {
      throw new Error(
        "LinkedIn Article cover images require the reviewed browser-bound upload transport",
      );
    },
    updateCover: async (draftId, assetUrn) => {
      await client.requestStatus({
        url: linkedInArticleDraftEntityUrl(draftId),
        method: "POST",
        headers: linkedInArticleHeaders(csrf, articleEditUrl(draftId)),
        body: canonicalJson(buildLinkedInArticleCoverPatch(assetUrn)),
        expectedStatuses: [200],
      });
    },
    updateContentV2: async (draftId, document, imageAssetUrns) => {
      await client.requestStatus({
        url: linkedInArticleDraftEntityUrl(draftId),
        method: "POST",
        headers: linkedInArticleHeaders(csrf, articleEditUrl(draftId)),
        body: canonicalJson(buildLinkedInArticleContentPatchV2(document, imageAssetUrns)),
        expectedStatuses: [200],
      });
    },
    close: () => Promise.resolve(),
  };
  return Object.freeze(transport);
}

async function createLinkedInArticleTransport(
  auth: WrenchAuth,
  timeoutMs: number,
  options: LinkedInWebExecutionOptions,
): Promise<LinkedInArticleBrowserTransport> {
  const injected = options.dependencies?.createArticleBrowserTransport;
  if (injected !== undefined) {
    return injected(auth, {
      timeoutMs,
      ...(options.operationDeadline === undefined
        ? {}
        : { operationDeadline: options.operationDeadline }),
      ...(options.publishCleanupResource === undefined
        ? {}
        : { publishCleanupResource: options.publishCleanupResource }),
    });
  }
  // Secret-free runtime tests inject the exact network seam. Production never
  // uses pinned HTTP for LinkedIn Articles because LinkedIn binds this editor
  // family to its browser/device session after the first authenticated probe.
  if (options.dependencies?.fetch !== undefined) {
    return createDirectLinkedInArticleTransport(auth, timeoutMs, options);
  }
  return createLinkedInArticleBrowserTransport(auth, {
    timeoutMs,
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.publishCleanupResource === undefined
      ? {}
      : { publishCleanupResource: options.publishCleanupResource }),
  });
}

type LinkedInPostImage = {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly width: number;
};

function linkedInPostFileInput(value: unknown): FileInputValue | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error("LinkedIn posts.publish media must contain exactly one plan-bound PNG");
  }
  const descriptor = value[0];
  if (
    Object.keys(descriptor).sort().join(",") !== "kind,reference"
    || descriptor.kind !== "file"
    || typeof descriptor.reference !== "string"
    || descriptor.reference.length < 1
    || descriptor.reference.length > 1_024
  ) throw new Error("LinkedIn posts.publish media must contain exactly one plan-bound PNG");
  return descriptor as FileInputValue;
}

async function materializeLinkedInPostImage(
  media: FileInputValue | null,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
): Promise<LinkedInPostImage | null> {
  if (media === null) return null;
  if (fileResolver === undefined) {
    throw new Error("LinkedIn image upload requires the plan-bound file resolver");
  }
  const resolveFile = () => fileResolver([media]);
  const paths = operationDeadline === undefined
    ? await resolveFile()
    : await operationDeadline.run(
        resolveFile,
        "authenticated web operation deadline",
      );
  if (paths.length !== 1 || typeof paths[0] !== "string") {
    throw new Error("LinkedIn image resolver did not return exactly one file");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = operationDeadline === undefined
    ? await open(paths[0], constants.O_RDONLY | noFollow)
    : await operationDeadline.run(
        () => open(paths[0]!, constants.O_RDONLY | noFollow),
        "authenticated web operation deadline",
      );
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (
      !before.isFile()
      || before.size < 24
      || before.size > MAX_LINKEDIN_POST_IMAGE_BYTES
    ) throw new Error("LinkedIn image must be a regular PNG no larger than 20 MiB");
    const bytes = operationDeadline === undefined
      ? await handle.readFile()
      : await operationDeadline.run(
          () => handle.readFile(),
          "authenticated web operation deadline",
        );
    const after = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size
    ) throw new Error("LinkedIn image changed while it was materialized");
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      signature.some((value, index) => bytes[index] !== value)
      || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    ) throw new Error("LinkedIn image must be a PNG fixture");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (
      width < 1
      || height < 1
      || width > 20_000
      || height > 20_000
      || width * height > 36_152_320
    ) throw new Error("LinkedIn PNG dimensions are outside the reviewed bound");
    return Object.freeze({
      bytes: new Uint8Array(bytes),
      height,
      width,
    });
  } finally {
    await handle.close();
  }
}

async function createLinkedInPostTransport(
  auth: WrenchAuth,
  timeoutMs: number,
  options: LinkedInWebExecutionOptions,
): Promise<LinkedInPostBrowserTransport> {
  const createTransport = options.dependencies?.createPostBrowserTransport
    ?? createLinkedInPostBrowserTransport;
  return createTransport(auth, {
    timeoutMs,
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.publishCleanupResource === undefined
      ? {}
      : { publishCleanupResource: options.publishCleanupResource }),
  });
}

type LinkedInAcceptedPostTarget = Readonly<{
  entityUrn: string;
  mediaUrn: string | null;
}>;

function parseLinkedInAcceptedPostTarget(
  identifier: unknown,
): LinkedInAcceptedPostTarget {
  if (
    typeof identifier !== "string"
    || identifier.length < 1
    || identifier.length > 2_048
    || /[\0\r\n]/u.test(identifier)
  ) throw new Error("LinkedIn accepted post target must be bounded canonical JSON");
  let value: unknown;
  try {
    value = JSON.parse(identifier) as unknown;
  } catch {
    throw new Error("LinkedIn accepted post target must be bounded canonical JSON");
  }
  if (!isRecord(value)) {
    throw new Error("LinkedIn accepted post target changed shape");
  }
  exactKeys(value, ["entityUrn", "mediaUrn"], "LinkedIn accepted post target");
  if (canonicalJson(value) !== identifier) {
    throw new Error("LinkedIn accepted post target must use canonical JSON");
  }
  return Object.freeze({
    entityUrn: linkedInPostEntityUrn(value.entityUrn),
    mediaUrn: value.mediaUrn === null ? null : linkedInPostMediaUrn(value.mediaUrn),
  });
}

async function readLinkedInWebAcceptedPostTargetPresenceInternal(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  acceptedIdentifier: string,
  options: LinkedInWebExecutionOptions,
): Promise<Readonly<{
  present: true;
  entityUrn: string;
  mediaUrn: string | null;
}>> {
  if (
    recipe.site !== "linkedin"
    || recipe.action !== "posts.publish"
    || recipe.contractVersion !== 3
  ) throw new Error("LinkedIn accepted post readback supports only posts.publish@3");
  if (input.media_title !== undefined || input.link_url !== undefined) {
    throw new Error("LinkedIn reviewed post publishing supports text or one PNG image only");
  }
  const target = parseLinkedInAcceptedPostTarget(acceptedIdentifier);
  const body = linkedInPostText(input.body);
  const visibility = linkedInPostVisibility(input.visibility);
  const media = linkedInPostFileInput(input.media);
  const altText = linkedInPostAltText(input.alt_text, media !== null);
  if ((media !== null) !== (target.mediaUrn !== null)) {
    throw new Error("LinkedIn accepted post target did not bind the confirmed media input");
  }
  const transport = await createLinkedInPostTransport(auth, recipe.timeoutMs, options);
  try {
    const identity = identityFromMeResponse(await transport.currentIdentityResponse());
    const profileUrn = requireBoundLinkedInIdentity(identity, auth);
    const expectedSubject = webSessionAuthSubject(auth);
    if (expectedSubject === null || expectedSubject !== identity.subject) {
      throw new Error("LinkedIn current member no longer matches the bound auth subject");
    }
    const variables = buildLinkedInPostCreateVariables({
      altText,
      body,
      mediaUrn: target.mediaUrn,
      visibility,
    });
    const projection = normalizeLinkedInPostProjection(
      await transport.readPost(
        expectedSubject,
        profileUrn,
        variables,
        target.mediaUrn,
        target.entityUrn,
      ),
      { body, mediaUrn: target.mediaUrn, profileUrn },
    );
    if (projection.entityUrn !== target.entityUrn) {
      throw new Error("LinkedIn accepted post target readback changed entity identity");
    }
    return Object.freeze({
      present: true as const,
      entityUrn: target.entityUrn,
      mediaUrn: target.mediaUrn,
    });
  } finally {
    await transport.close();
  }
}

/** Read only the exact provider-accepted LinkedIn post target; never dispatch. */
export function readLinkedInWebAcceptedPostTargetPresence(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  acceptedIdentifier: string,
  options: LinkedInWebExecutionOptions = {},
): Promise<Readonly<{
  present: true;
  entityUrn: string;
  mediaUrn: string | null;
}>> {
  return startWebSessionCleanupTrackedOperation(
    options.registerCleanupBarrier,
    (publishCleanupResource) => readLinkedInWebAcceptedPostTargetPresenceInternal(
      recipe,
      input,
      auth,
      acceptedIdentifier,
      {
        ...options,
        ...(publishCleanupResource === undefined
          ? {}
          : { publishCleanupResource }),
      },
    ),
    browserCleanupBarrier,
  );
}

function linkedInArticleTitle(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 150
    || /[\0\r\n]/u.test(value)
  ) throw new Error("input.title must be one bounded plain-text line");
  return value;
}

function articleEditUrl(id: string): string {
  return `${LINKEDIN_ORIGIN}/article/edit/${id}/`;
}

function linkedInCreatedArticleId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("LinkedIn Article create response omitted its stable draft identity");
  }
  const urnMatch = /^urn:li:fsd_firstPartyArticle:([0-9]{1,32})$/u.exec(value);
  return linkedInArticleDraftId(urnMatch?.[1] ?? value, "LinkedIn created Article draft ID");
}

function linkedInArticleFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const response = /\((session-rejected|request-rejected-(?:400|422)(?::[a-z0-9+_-]+)?|contract-route-(?:not-found|retired)|provider-(?:conflict|throttled|unavailable)|status-drift|content-type-drift|response-drift)\)$/u.exec(message)?.[1];
  if (response !== undefined) return response;
  if (message.includes("agent-browser")) return "browser-command-failed";
  if (message.includes("cleanup") || message.includes("finalization")) return "browser-cleanup-failed";
  if (message.includes("page-instance") || message.includes("page instance")) {
    return "page-instance-binding-missing";
  }
  if (message.includes("bootstrap")) return "bootstrap-response-drift";
  if (message.includes("readback")) return "readback-rejected";
  if (message.includes("image registration request")) return "image-registration-request-failed";
  const imageRegistrationShape = /image registration shape drifted:([a-z0-9-]{1,192})/u
    .exec(message)?.[1];
  if (imageRegistrationShape !== undefined) {
    return `image-registration-shape-${imageRegistrationShape}`;
  }
  if (message.includes("image registration shape")) return "image-registration-shape-drift";
  if (
    message.includes("image registration response")
    || /Article (?:cover |inline )?image registration/u.test(message)
  ) return "image-registration-response-drift";
  if (message.includes("image staging changed shape")) return "image-byte-staging-failed";
  if (message.includes("image staging")) return "image-staging-failed";
  if (message.includes("image bytes")) return "image-byte-staging-failed";
  if (message.includes("image signed transfer status")) return "image-transfer-status-drift";
  if (message.includes("image signed transfer")) return "image-transfer-failed";
  if (/Article (?:cover |inline )?image upload/u.test(message)) {
    return "image-transfer-response-drift";
  }
  return "contract-step-failed";
}

async function readLinkedInArticleDraft(
  transport: LinkedInArticleBrowserTransport,
  draftId: string,
  profileUrn: string,
): Promise<ReturnType<typeof normalizeLinkedInArticleDraft>> {
  const response = await transport.readDraftResponse(draftId);
  return normalizeLinkedInArticleDraft(response, draftId, profileUrn);
}

async function readLinkedInArticleDraftMetadata(
  transport: LinkedInArticleBrowserTransport,
  draftId: string,
  profileUrn: string,
): Promise<ReturnType<typeof normalizeLinkedInArticleDraftMetadata>> {
  const response = await transport.readDraftResponse(draftId);
  return normalizeLinkedInArticleDraftMetadata(response, draftId, profileUrn);
}

async function readLinkedInArticleDraftSnapshot(
  transport: LinkedInArticleBrowserTransport,
  draftId: string,
  profileUrn: string,
): Promise<ReturnType<typeof normalizeLinkedInArticleDraftSnapshot>> {
  const response = await transport.readDraftResponse(draftId);
  return normalizeLinkedInArticleDraftSnapshot(response, draftId, profileUrn);
}

async function readLinkedInArticleDraftV2(
  transport: LinkedInArticleBrowserTransport,
  draftId: string,
  profileUrn: string,
): Promise<ReturnType<typeof normalizeLinkedInArticleDraftV2>> {
  const response = await transport.readDraftResponse(draftId);
  return normalizeLinkedInArticleDraftV2(response, draftId, profileUrn);
}

async function readLinkedInArticleDraftV2Metadata(
  transport: LinkedInArticleBrowserTransport,
  draftId: string,
  profileUrn: string,
): Promise<ReturnType<typeof normalizeLinkedInArticleDraftV2Metadata>> {
  const response = await transport.readDraftResponse(draftId);
  return normalizeLinkedInArticleDraftV2Metadata(response, draftId, profileUrn);
}

function requireBoundLinkedInIdentity(
  identity: LinkedInCurrentIdentity,
  auth: WrenchAuth,
): string {
  const expectedSubject = webSessionAuthSubject(auth);
  if (expectedSubject === null || expectedSubject !== identity.subject) {
    throw new Error("LinkedIn current member no longer matches the bound auth subject");
  }
  if (identity.profileUrn === null) {
    throw new Error("LinkedIn current-account response omitted the Article author profile binding");
  }
  return identity.profileUrn;
}

function articleDispatchEvent(
  id: string,
  index: number,
  planned: number,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return { id, index, progress: { planned, started, verified } };
}

export async function readLinkedInWebArticleDraftDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly dependencies?: LinkedInWebRuntimeDependencies;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
  } = {},
): Promise<{ readonly matches: boolean; readonly draftId: string }> {
  if (
    recipe.site !== "linkedin"
    || recipe.action !== "articles.draft.save"
    || recipe.contractVersion !== 2
  ) throw new Error("LinkedIn Article draft recovery supports only articles.draft.save@2");
  const draftId = linkedInArticleDraftId(input.draft_id, "input.draft_id");
  const title = linkedInArticleTitle(input.title);
  const document = parseArticleDraftDocument(input.document, {
    maximumBlocks: MAX_LINKEDIN_ARTICLE_BLOCKS,
    maximumCharacters: MAX_LINKEDIN_ARTICLE_CHARACTERS,
  });
  // Validate the provider-owned subset before opening the authenticated realm.
  buildLinkedInArticleContentPatch(document);
  const transport = await createLinkedInArticleTransport(auth, recipe.timeoutMs, {
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.publishCleanupResource === undefined
      ? {}
      : { publishCleanupResource: options.publishCleanupResource }),
  });
  try {
    const profileUrn = requireBoundLinkedInIdentity(
      identityFromMeResponse(await transport.currentIdentityResponse()),
      auth,
    );
    const actual = await readLinkedInArticleDraftSnapshot(
      transport,
      draftId,
      profileUrn,
    );
    return Object.freeze({
      draftId,
      matches: actual.title === title
        && actual.document !== null
        && canonicalJson(actual.document) === canonicalJson(document),
    });
  } finally {
    await transport.close();
  }
}

async function executeLinkedInPostPublish(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: LinkedInWebExecutionOptions,
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "linkedin"
    || recipe.action !== "posts.publish"
    || recipe.contractVersion !== 3
  ) throw new Error("LinkedIn post publishing supports only posts.publish@3");
  if (input.media_title !== undefined || input.link_url !== undefined) {
    throw new Error("LinkedIn reviewed post publishing supports text or one PNG image only");
  }
  const body = linkedInPostText(input.body);
  const visibility = linkedInPostVisibility(input.visibility);
  const media = linkedInPostFileInput(input.media);
  const altText = linkedInPostAltText(input.alt_text, media !== null);
  const image = await materializeLinkedInPostImage(
    media,
    options.fileResolver,
    options.operationDeadline,
  );
  let started = 0;
  let verified = 0;
  let transport: LinkedInPostBrowserTransport | null = null;
  let projection: ReturnType<typeof normalizeLinkedInPostProjection> | null = null;
  try {
    transport = await createLinkedInPostTransport(auth, recipe.timeoutMs, options);
    const identity = identityFromMeResponse(await transport.currentIdentityResponse());
    const profileUrn = requireBoundLinkedInIdentity(identity, auth);
    const expectedSubject = webSessionAuthSubject(auth);
    if (expectedSubject === null || expectedSubject !== identity.subject) {
      throw new Error("LinkedIn current member no longer matches the bound auth subject");
    }
    await options.beforeDispatch?.(
      articleDispatchEvent("posts.publish", 1, 1, started, verified),
    );
    started = 1;
    const mediaUrn = image === null
      ? null
      : await transport.uploadImage(expectedSubject, image.bytes);
    const variables = buildLinkedInPostCreateVariables({
      altText,
      body,
      mediaUrn,
      visibility,
    });
    const entityUrn = await transport.createPost(
      expectedSubject,
      profileUrn,
      variables,
      mediaUrn,
    );
    await options.afterProviderAcceptedMutationTarget?.({
      id: "posts.publish",
      index: 1,
      target: {
        schemaVersion: 1,
        identifier: canonicalJson({ entityUrn, mediaUrn }),
      },
    });
    projection = normalizeLinkedInPostProjection(
      await transport.readPost(
        expectedSubject,
        profileUrn,
        variables,
        mediaUrn,
        entityUrn,
      ),
      { body, mediaUrn, profileUrn },
    );
    verified = 1;
    await options.afterDispatchVerified?.(
      articleDispatchEvent("posts.publish", 1, 1, started, verified),
    );
    return {
      status: "succeeded",
      output: Object.freeze({
        provider: "linkedin",
        operation: "posts.publish",
        post: Object.freeze({
          entityUrn: projection.entityUrn,
          url: projection.url,
        }),
        visibility,
        ...(image === null
          ? {}
          : {
              image: Object.freeze({
                altText,
                height: image.height,
                mediaType: "image/png",
                width: image.width,
              }),
            }),
      }),
      finalUrl: projection.url,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > verified ? "indeterminate" : "failed",
      output: null,
      finalUrl: projection?.url ?? null,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > verified
        ? "LinkedIn may have accepted the image upload or post but exact member, text, media, and permalink readback was not verified; reconcile before retrying"
        : "LinkedIn post publishing failed before remote submission",
    };
  } finally {
    await transport?.close();
  }
}

async function executeLinkedInArticleDraftSave(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: LinkedInWebExecutionOptions,
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "linkedin"
    || recipe.action !== "articles.draft.save"
    || recipe.contractVersion !== 2
  ) throw new Error("LinkedIn Article draft saving supports only articles.draft.save@2");
  const title = linkedInArticleTitle(input.title);
  const document = parseArticleDraftDocument(input.document, {
    maximumBlocks: MAX_LINKEDIN_ARTICLE_BLOCKS,
    maximumCharacters: MAX_LINKEDIN_ARTICLE_CHARACTERS,
  });
  // Validate the exact provider projection before opening any authenticated
  // browser session or crossing the durable dispatch boundary.
  buildLinkedInArticleContentPatch(document);
  const requestedDraftId = input.draft_id === undefined
    ? null
    : linkedInArticleDraftId(input.draft_id, "input.draft_id");
  const planned = requestedDraftId === null ? 2 : 1;
  let started = 0;
  let verified = 0;
  let nextIndex = 0;
  let draftId = requestedDraftId;
  let failureStage = "starting the contained LinkedIn Article browser";
  let transport: LinkedInArticleBrowserTransport | null = null;
  const begin = async (id: string): Promise<number> => {
    const index = nextIndex + 1;
    await options.beforeDispatch?.(
      articleDispatchEvent(id, index, planned, started, verified),
    );
    nextIndex = index;
    started = index;
    return index;
  };
  const complete = async (id: string, index: number): Promise<void> => {
    await options.afterDispatchVerified?.(
      articleDispatchEvent(id, index, planned, started, index),
    );
    verified = index;
  };

  try {
    transport = await createLinkedInArticleTransport(
      auth,
      recipe.timeoutMs,
      options,
    );
    failureStage = "reading the current LinkedIn member in the contained browser";
    const currentIdentity = identityFromMeResponse(
      await transport.currentIdentityResponse(),
    );
    failureStage = "binding the current LinkedIn member";
    const profileUrn = requireBoundLinkedInIdentity(currentIdentity, auth);

    let finalDispatchId: string;
    let finalDispatchIndex: number;
    if (draftId === null) {
      failureStage = "opening the private Article editor before creation";
      await transport.prepareCreateDraft();
      const dispatchId = "articles.create";
      failureStage = "creating the private Article title shell";
      const index = await begin(dispatchId);
      draftId = linkedInCreatedArticleId(
        await transport.createDraft(profileUrn, title),
      );
      failureStage = "verifying the new private Article title shell";
      const created = await readLinkedInArticleDraftMetadata(
        transport,
        draftId,
        profileUrn,
      );
      if (created.title !== title) {
        throw new Error("LinkedIn Article create readback did not bind the confirmed title");
      }
      await complete(dispatchId, index);
      finalDispatchId = "articles.content";
      failureStage = "replacing the new private Article document";
      finalDispatchIndex = await begin(finalDispatchId);
      await transport.updateContent(draftId, document);
    } else {
      failureStage = "reading the exact existing private Article";
      const existing = await readLinkedInArticleDraftSnapshot(
        transport,
        draftId,
        profileUrn,
      );
      const titleMatches = existing.title === title;
      const documentMatches = existing.document !== null
        && canonicalJson(existing.document) === canonicalJson(document);
      if (titleMatches && documentMatches) {
        const url = articleEditUrl(draftId);
        return {
          status: "succeeded",
          output: {
            provider: "linkedin",
            operation: "articles.draft.save",
            published: false,
            mode: "draft",
            draftId,
            title,
            documentSchemaVersion: 1,
            effect: "already-satisfied",
          },
          finalUrl: url,
          noOp: true,
          dispatchStarted: false,
          dispatch: { planned, started: 0, verified: 0 },
        };
      }
      finalDispatchId = "articles.replace";
      failureStage = "starting the exact private Article replacement";
      finalDispatchIndex = await begin(finalDispatchId);
      if (!titleMatches) {
        failureStage = "replacing the exact private Article title";
        await transport.updateTitle(draftId, title);
      }
      if (!documentMatches) {
        failureStage = "replacing the exact private Article document";
        await transport.updateContent(draftId, document);
      }
    }

    failureStage = "verifying the replaced private Article document";
    const final = await readLinkedInArticleDraft(
      transport,
      draftId,
      profileUrn,
    );
    if (
      final.title !== title
      || canonicalJson(final.document) !== canonicalJson(document)
    ) throw new Error("LinkedIn Article final readback did not bind the confirmed draft");
    await complete(finalDispatchId, finalDispatchIndex);

    if (nextIndex !== planned || verified !== planned) {
      throw new Error("LinkedIn Article draft workflow did not complete its exact dispatch schedule");
    }
    const url = articleEditUrl(draftId);
    return {
      status: "succeeded",
      output: {
        provider: "linkedin",
        operation: "articles.draft.save",
        published: false,
        mode: "draft",
        draftId,
        title,
        documentSchemaVersion: 1,
        url,
      },
      finalUrl: url,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
    };
  } catch (error) {
    const url = draftId === null ? null : articleEditUrl(draftId);
    const diagnostic = `${failureStage}; ${linkedInArticleFailureCategory(error)}`;
    return {
      status: started > verified ? "indeterminate" : verified > 0 ? "partial" : "failed",
      output: null,
      finalUrl: url,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
      error: started > verified
        ? requestedDraftId === null && verified === 0
          ? "LinkedIn may have accepted the private Article create, but the confirmed input has no exact draft ID for safe reconciliation; preserve the indeterminate run and do not retry"
          : `LinkedIn may have accepted the current private Article replacement dispatch while ${diagnostic}; reconcile the exact existing draft before retrying`
        : verified > 0
          ? `LinkedIn verified only part of the confirmed private Article workflow while ${diagnostic}; inspect the draft before retrying`
          : `LinkedIn Article draft failed before remote submission while ${diagnostic}`,
    };
  } finally {
    await transport?.close();
  }
}

async function executeLinkedInArticleDraftSaveV7(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: LinkedInWebExecutionOptions,
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "linkedin"
    || recipe.action !== "articles.draft.save"
    || recipe.contractVersion !== 7
  ) throw new Error("LinkedIn image Article draft saving supports only articles.draft.save@7");
  const title = linkedInArticleTitle(input.title);
  const document = parseArticleDraftDocumentV2(input.document, {
    maximumBlocks: MAX_LINKEDIN_ARTICLE_BLOCKS,
    maximumCharacters: MAX_LINKEDIN_ARTICLE_CHARACTERS,
    maximumImages: MAX_LINKEDIN_ARTICLE_INLINE_IMAGES,
  });
  const imageCount = document.blocks.filter((block) => block.type === "image").length;
  if (imageCount < 1) {
    throw new Error("LinkedIn ArticleDraftDocument schemaVersion 2 requires at least one inline image");
  }
  const trailing = document.blocks.at(-1);
  const beforeTrailing = document.blocks.at(-2);
  if (
    trailing?.type === "paragraph"
    && trailing.text === ""
    && beforeTrailing?.type === "image"
  ) {
    throw new Error(
      "LinkedIn Article documents must omit the editor-owned empty paragraph after a final image",
    );
  }
  const fixtureAssets = Object.freeze(Array.from(
    { length: imageCount },
    (_, index) => `urn:li:digitalmediaAsset:wrenchFixture${index}`,
  ));
  buildLinkedInArticleContentPatchV2(document, fixtureAssets);
  const requestedDraftId = input.draft_id === undefined
    ? null
    : linkedInArticleDraftId(input.draft_id, "input.draft_id");
  if (input.cover_image === undefined && requestedDraftId === null) {
    throw new Error("input.cover_image is required when creating a LinkedIn Article draft");
  }
  const coverImage = input.cover_image === undefined
    ? null
    : await materializeArticleDraftImage(
        input.cover_image,
        options.fileResolver,
        {
          maximumBytes: MAX_LINKEDIN_ARTICLE_IMAGE_BYTES,
          inputLabel: "input.cover_image",
          filenamePrefix: "cover-image",
          ...(options.operationDeadline === undefined
            ? {}
            : { operationDeadline: options.operationDeadline }),
        },
      );
  const images = await materializeArticleDraftImages(
    input.inline_images,
    options.fileResolver,
    {
      maximumBytes: MAX_LINKEDIN_ARTICLE_IMAGE_BYTES,
      maximumImages: MAX_LINKEDIN_ARTICLE_INLINE_IMAGES,
      ...(options.operationDeadline === undefined
        ? {}
        : { operationDeadline: options.operationDeadline }),
    },
  );
  if (images.length !== imageCount) {
    throw new Error("input.inline_images must match every document imageIndex exactly");
  }
  const planned = images.length
    + (requestedDraftId === null ? 2 : 1)
    + (coverImage === null ? 0 : 1);
  let started = 0;
  let verified = 0;
  let nextIndex = 0;
  let draftId = requestedDraftId;
  let failureStage = "starting the contained LinkedIn Article browser";
  let transport: LinkedInArticleBrowserTransport | null = null;
  const begin = async (id: string): Promise<number> => {
    const index = nextIndex + 1;
    await options.beforeDispatch?.(
      articleDispatchEvent(id, index, planned, started, verified),
    );
    nextIndex = index;
    started = index;
    return index;
  };
  const complete = async (id: string, index: number): Promise<void> => {
    await options.afterDispatchVerified?.(
      articleDispatchEvent(id, index, planned, started, index),
    );
    verified = index;
  };

  try {
    transport = await createLinkedInArticleTransport(
      auth,
      recipe.timeoutMs,
      options,
    );
    failureStage = "reading the current LinkedIn member in the contained browser";
    const currentIdentity = identityFromMeResponse(
      await transport.currentIdentityResponse(),
    );
    failureStage = "binding the current LinkedIn member";
    const profileUrn = requireBoundLinkedInIdentity(currentIdentity, auth);
    if (
      transport.uploadInlineImage === undefined
      || transport.updateContentV2 === undefined
    ) throw new Error("LinkedIn Article cover and inline image transport is unavailable");
    const uploadInlineImage = transport.uploadInlineImage;
    const updateContentV2 = transport.updateContentV2;
    let coverAssetUrn: string | null = null;

    if (draftId === null) {
      failureStage = "opening the private Article editor before creation";
      await transport.prepareCreateDraft();
      const dispatchId = "articles.create";
      failureStage = "creating the private Article title shell";
      const index = await begin(dispatchId);
      draftId = linkedInCreatedArticleId(
        await transport.createDraft(profileUrn, title),
      );
      failureStage = "verifying the new private Article title shell";
      const created = await readLinkedInArticleDraftMetadata(
        transport,
        draftId,
        profileUrn,
      );
      if (created.title !== title) {
        throw new Error("LinkedIn Article create readback did not bind the confirmed title");
      }
      await complete(dispatchId, index);
    } else {
      failureStage = "reading the exact existing private Article";
      const existing = await readLinkedInArticleDraftV2Metadata(
        transport,
        draftId,
        profileUrn,
      );
      coverAssetUrn = existing.coverAssetUrn;
      if (coverImage === null && coverAssetUrn === null) {
        throw new Error("LinkedIn Article replacement without input.cover_image requires one existing private banner");
      }
    }

    if (coverImage !== null) {
      if (
        transport.uploadCoverImage === undefined
        || transport.updateCover === undefined
      ) throw new Error("LinkedIn Article cover transport is unavailable");
      const coverDispatchId = "articles.cover";
      failureStage = "uploading the private Article cover image";
      const coverDispatchIndex = await begin(coverDispatchId);
      coverAssetUrn = await transport.uploadCoverImage(draftId, coverImage);
      failureStage = "binding the private Article cover only to the banner slot";
      await transport.updateCover(draftId, coverAssetUrn);
      failureStage = "verifying the private Article cover banner";
      const covered = await readLinkedInArticleDraftV2Metadata(
        transport,
        draftId,
        profileUrn,
      );
      if (covered.coverAssetUrn !== coverAssetUrn) {
        throw new Error("LinkedIn Article cover readback did not bind the confirmed banner asset");
      }
      await complete(coverDispatchId, coverDispatchIndex);
    }
    if (coverAssetUrn === null) {
      throw new Error("LinkedIn Article draft requires one exact private banner");
    }

    const imageAssetUrns: string[] = [];
    for (const [imageIndex, image] of images.entries()) {
      const dispatchId = `articles.image[${imageIndex + 1}]`;
      failureStage = `uploading private Article inline image ${imageIndex + 1}`;
      const index = await begin(dispatchId);
      imageAssetUrns.push(await uploadInlineImage(draftId, image));
      failureStage = `verifying private Article inline image ${imageIndex + 1}`;
      await complete(dispatchId, index);
    }

    const finalDispatchId = requestedDraftId === null
      ? "articles.content"
      : "articles.replace";
    failureStage = "starting the exact private Article replacement";
    const finalDispatchIndex = await begin(finalDispatchId);
    if (requestedDraftId !== null) {
      failureStage = "replacing the exact private Article title";
      await transport.updateTitle(draftId, title);
    }
    failureStage = "replacing the exact private Article document and inline images";
    await updateContentV2(draftId, document, imageAssetUrns);

    failureStage = "verifying the replaced private Article document and inline images";
    const final = await readLinkedInArticleDraftV2(
      transport,
      draftId,
      profileUrn,
    );
    if (
      final.title !== title
      || canonicalJson(final.document) !== canonicalJson(document)
      || final.coverAssetUrn !== coverAssetUrn
      || canonicalJson(final.imageAssetUrns) !== canonicalJson(imageAssetUrns)
    ) throw new Error("LinkedIn Article final readback did not bind the confirmed draft, cover, and inline images");
    await complete(finalDispatchId, finalDispatchIndex);

    if (nextIndex !== planned || verified !== planned) {
      throw new Error("LinkedIn Article image workflow did not complete its exact dispatch schedule");
    }
    const url = articleEditUrl(draftId);
    return {
      status: "succeeded",
      output: {
        provider: "linkedin",
        operation: "articles.draft.save",
        published: false,
        mode: "draft",
        draftId,
        title,
        documentSchemaVersion: 2,
        coverImageCount: 1,
        inlineImageCount: images.length,
        url,
      },
      finalUrl: url,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
    };
  } catch (error) {
    const url = draftId === null ? null : articleEditUrl(draftId);
    const diagnostic = `${failureStage}; ${linkedInArticleFailureCategory(error)}`;
    return {
      status: started > verified ? "indeterminate" : verified > 0 ? "partial" : "failed",
      output: null,
      finalUrl: url,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
      error: started > verified
        ? `LinkedIn may have accepted the current private Article cover, inline image, or replacement dispatch while ${diagnostic}; preserve the indeterminate run, inspect the exact draft, and do not retry`
        : verified > 0
          ? `LinkedIn verified only part of the confirmed private Article image workflow while ${diagnostic}; inspect the draft before retrying`
          : `LinkedIn Article image draft failed before remote submission while ${diagnostic}`,
    };
  } finally {
    await transport?.close();
  }
}


export async function executeLinkedInWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: LinkedInWebExecutionOptions = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site === "linkedin"
    && recipe.contractVersion === 7
    && recipe.action === "articles.draft.save"
  ) {
    return startWebSessionCleanupTrackedOperation(
      options.registerCleanupBarrier,
      (publishCleanupResource) => executeLinkedInArticleDraftSaveV7(
        recipe,
        input,
        auth,
        {
          ...options,
          ...(publishCleanupResource === undefined
            ? {}
            : { publishCleanupResource }),
        },
      ),
      browserCleanupBarrier,
    );
  }
  if (
    recipe.site === "linkedin"
    && recipe.contractVersion === 3
    && recipe.action === "posts.publish"
  ) {
    return startWebSessionCleanupTrackedOperation(
      options.registerCleanupBarrier,
      (publishCleanupResource) => executeLinkedInPostPublish(
        recipe,
        input,
        auth,
        {
          ...options,
          ...(publishCleanupResource === undefined
            ? {}
            : { publishCleanupResource }),
        },
      ),
      browserCleanupBarrier,
    );
  }
  if (
    recipe.site === "linkedin"
    && recipe.contractVersion === 2
    && recipe.action === "articles.draft.save"
  ) {
    return startWebSessionCleanupTrackedOperation(
      options.registerCleanupBarrier,
      (publishCleanupResource) => executeLinkedInArticleDraftSave(
        recipe,
        input,
        auth,
        {
          ...options,
          ...(publishCleanupResource === undefined
            ? {}
            : { publishCleanupResource }),
        },
      ),
      browserCleanupBarrier,
    );
  }
  // Every ungraduated operation stays inert before cookies, browser state, or network.
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
