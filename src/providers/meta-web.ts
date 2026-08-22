/**
 * Shared policy and bounded projections for Meta's signed-in consumer sites.
 *
 * This file never performs network I/O. It accepts only whole responses from
 * exact requests owned by meta-web-runtime.ts and projects them to stable,
 * bounded values. Relay bootloader JSON is treated as foreign input.
 */

import { assertMetaCometReadActor } from "./meta-bootstrap";
import { projectContactDirectionStats } from "./contact-projection";
import { extractMetaJsonScriptTexts } from "./meta-relay-bundle";

export const META_WEB_SITES = Object.freeze([
  "instagram",
  "threads",
  "facebook",
  "facebook-page",
  "facebook-group",
  "facebook-marketplace",
] as const);

export type MetaWebSite = (typeof META_WEB_SITES)[number];
export type MetaWebRisk = "R1" | "R2" | "R3";
export type MetaWebContractState = "observed" | "capture-required";

const unavailableInstagramContactStats = Object.freeze({
  count: null,
  complete: false,
  lowerBound: false,
  truncated: false,
  lastAt: null,
  lastAtComplete: false,
  lastAtBasis: "unavailable",
  incompleteReasons: Object.freeze(["message-history-capture-required"]),
} as const);

const unavailableInstagramContactStatsProjection = projectContactDirectionStats(
  unavailableInstagramContactStats,
  unavailableInstagramContactStats,
);

export const META_WEB_OPERATION_NAMES = Object.freeze({
  instagram: Object.freeze([
    "comments.create", "comments.read", "contacts.list", "content.edit", "content.save", "content.share",
    "feeds.read", "likes.set", "media.publish", "media.read", "messaging.list",
    "messaging.read", "messaging.send", "posts.read", "posts.repost", "reactions.set",
    "relationships.follow.set", "replies.create",
  ] as const),
  threads: Object.freeze([
    "comments.read", "content.edit", "content.save", "content.share", "feeds.read",
    "likes.set", "media.read", "messaging.list", "messaging.read", "messaging.send",
    "posts.publish", "posts.quote", "posts.read", "posts.repost",
    "relationships.follow.set", "replies.create", "threads.publish",
  ] as const),
  facebook: Object.freeze([
    "comments.create", "comments.read", "contacts.list", "content.edit", "content.save", "content.share",
    "feeds.read", "likes.set", "media.publish", "media.read", "messaging.list",
    "messaging.read", "messaging.send", "posts.publish", "posts.quote", "posts.read",
    "posts.repost", "reactions.set", "relationships.follow.set", "replies.create",
  ] as const),
  "facebook-page": Object.freeze([
    "comments.create", "comments.read", "content.edit", "content.save", "content.schedule",
    "content.share", "feeds.read", "likes.set", "media.publish", "media.read",
    "messaging.list", "messaging.read", "messaging.send", "posts.publish", "posts.quote",
    "posts.read", "posts.repost", "reactions.set", "relationships.follow.set",
    "replies.create",
  ] as const),
  "facebook-group": Object.freeze([
    "comments.create", "comments.read", "communities.membership.set", "content.edit",
    "content.save", "content.share", "feeds.read", "likes.set", "media.publish",
    "media.read", "posts.publish", "posts.quote", "posts.read", "posts.repost",
    "reactions.set", "replies.create",
  ] as const),
  "facebook-marketplace": Object.freeze([
    "content.edit", "content.save", "content.share", "feeds.read", "listings.publish",
    "listings.read", "media.read", "messaging.list", "messaging.read", "messaging.send",
  ] as const),
} satisfies Readonly<Record<MetaWebSite, readonly string[]>>);

export type MetaWebOperationName = (typeof META_WEB_OPERATION_NAMES)[MetaWebSite][number];

const META_NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;

/** True only for Meta account IDs in their one canonical decimal representation. */
export function isCanonicalMetaNumericId(value: unknown): value is string {
  return typeof value === "string" && META_NUMERIC_ID_PATTERN.test(value);
}

export type MetaWebOperationContract = {
  readonly contractVersion: number;
  readonly effect: "read" | "write";
  readonly risk: MetaWebRisk;
  readonly state: MetaWebContractState;
  readonly evidence: "live-direct" | "first-party-bundle" | "none";
  readonly reason: string;
};

const observed = (reason: string, contractVersion = 1): MetaWebOperationContract => Object.freeze({
  contractVersion,
  effect: "read",
  risk: "R1",
  state: "observed",
  evidence: "live-direct",
  reason,
});

const observedMutation = (
  risk: "R2" | "R3",
  reason: string,
  contractVersion = 1,
): MetaWebOperationContract => Object.freeze({
  contractVersion,
  effect: "write",
  risk,
  state: "observed",
  evidence: "first-party-bundle",
  reason,
});

function riskForOperation(operation: string): MetaWebRisk {
  if (
    operation.endsWith(".read")
    || operation.endsWith(".list")
    || operation === "feeds.read"
    || operation === "media.read"
    || operation === "listings.read"
  ) return "R1";
  if (
    operation === "likes.set"
    || operation === "reactions.set"
    || operation === "content.save"
    || operation === "relationships.follow.set"
    || operation === "communities.membership.set"
  ) return "R2";
  return "R3";
}

const captureRequired = (
  operation: string,
  reason?: string,
  contractVersion = 1,
): MetaWebOperationContract => {
  const risk = riskForOperation(operation);
  return Object.freeze({
    contractVersion,
    effect: risk === "R1" ? "read" : "write",
    risk,
    state: "capture-required",
    evidence: "none",
    reason: reason ?? (
      risk === "R1"
        ? "the exact acknowledgement-free response and target binding still require a reviewed live capture"
        : risk === "R2"
          ? "the exact actor, target, mutation response, and independent desired-state readback require an authorized fixture"
          : "the exact actor, audience, attachment transport, dispatch response, and independent publication readback require an authorized fixture"
    ),
  });
};

function contracts(
  site: MetaWebSite,
  overrides: Readonly<Record<string, MetaWebOperationContract>>,
): Readonly<Record<string, MetaWebOperationContract>> {
  return Object.freeze(Object.fromEntries(
    META_WEB_OPERATION_NAMES[site].map((operation) => [
      operation,
      overrides[operation] ?? captureRequired(operation),
    ]),
  ));
}

export const META_WEB_OPERATIONS = Object.freeze({
  instagram: contracts("instagram", {
    "contacts.list": observed(
      "unique non-viewer participants from one bounded first page of the live direct_v2 inbox summary GET; the contact set and all message statistics retain explicit first-page or unavailable completeness",
      1,
    ),
    "feeds.read": observed(
      "one bounded first page from live direct /api/v1/feed/timeline JSON with viewer binding and no continuation cursor accepted or exposed",
      2,
    ),
    "posts.read": observed("live direct /api/v1/media/{id}/info JSON with exact returned-media binding"),
    "media.read": observed("the target-bound media-info response supplies bounded media metadata without copying credentials"),
    "comments.read": observed(
      "one bounded first page from live direct /api/v1/media/{id}/comments JSON with caption/root binding and no continuation cursor accepted or exposed",
      2,
    ),
    "messaging.list": observed(
      "one bounded first page from the live direct_v2 inbox summary GET, with no continuation cursor accepted or exposed and no seen, ack, or presence endpoint issued",
      2,
    ),
    "messaging.read": captureRequired(
      "messaging.read",
      "Direct thread reads require a reviewed no-seen/no-presence capture; listing evidence does not authorize reading messages",
    ),
    "messaging.send": captureRequired(
      "messaging.send",
      "Instagram messaging is split across Direct, LS/Msys, and E2EE transports; plaintext replay is prohibited",
    ),
  }),
  threads: contracts("threads", {
    "feeds.read": observed(
      "one bounded first page from live direct signed-in Threads Relay preload JSON with exact Barcelona viewer binding and no continuation cursor accepted or exposed",
      2,
    ),
    "posts.publish": observedMutation(
      "R3",
      "reviewed live configure_text_post_app_feed create with optional single-PNG upload, exact minimal created-locator binding, durable response-bound post identity plus completed-upload dimensions when an image is supplied, and independent exact permalink actor/text and optional image readback",
      5,
    ),
    "messaging.list": captureRequired(
      "messaging.list",
      "Threads inbox uses Lightspeed/Msys state and may acknowledge or update presence; Relay setup metadata is not message-list authority",
    ),
    "messaging.read": captureRequired(
      "messaging.read",
      "Threads conversation reads require protocol-correct Lightspeed/Msys acknowledgement analysis",
    ),
    "messaging.send": captureRequired(
      "messaging.send",
      "Threads message send requires protocol-correct Lightspeed/Msys or E2EE implementation",
    ),
  }),
  facebook: contracts("facebook", {
    "contacts.list": captureRequired(
      "contacts.list",
      "personal Facebook contacts require either an exact friends collection or a separately reviewed Messenger-participant transport with actor binding, paging, completeness, and acknowledgement analysis",
    ),
    "feeds.read": observed(
      "live direct signed-in Comet Relay news-feed preload JSON with exact current-user binding",
      2,
    ),
    "messaging.list": captureRequired(
      "messaging.list",
      "a homepage Comet preload does not establish the inbox route or folder, paging or completeness, or acknowledgement/presence behavior; Messenger Msys/E2EE needs its own reviewed transport",
      2,
    ),
    "messaging.read": captureRequired(
      "messaging.read",
      "Messenger conversation reads require protocol-correct Lightspeed/Msys acknowledgement analysis",
    ),
    "messaging.send": captureRequired(
      "messaging.send",
      "Messenger send requires protocol-correct Lightspeed/Msys/E2EE and cannot be represented as a plaintext GraphQL replay",
    ),
  }),
  "facebook-page": contracts("facebook-page", {
    "messaging.list": captureRequired(
      "messaging.list",
      "Page inbox actor switching and Page-vs-person recipient binding require a reviewed business-inbox capture",
    ),
    "messaging.send": captureRequired(
      "messaging.send",
      "Page messaging requires exact Page actor proof plus protocol-correct inbox transport",
    ),
  }),
  "facebook-group": contracts("facebook-group", {
    "feeds.read": observed(
      "live direct signed-in Group HTML bootstrap with exact current-user and numeric Group target binding, complete streamed-fragment assembly, no client-script execution, and no pagination claim",
      2,
    ),
  }),
  "facebook-marketplace": contracts("facebook-marketplace", {
    "feeds.read": observed(
      "live direct signed-in Marketplace HTML bootstrap plus current-bundle-resolved Relay continuation with exact current-user proof binding, complete streamed-page assembly, and no client-script execution",
      2,
    ),
    "listings.read": observed(
      "live direct signed-in Marketplace product-details HTML bootstrap with exact current-user and requested-listing binding; the browser item-seen mutation is not executed",
      2,
    ),
    "messaging.list": captureRequired(
      "messaging.list",
      "Marketplace inbox scope must remain distinct from personal Messenger and requires listing-bound capture",
    ),
    "messaging.send": captureRequired(
      "messaging.send",
      "Marketplace send requires exact listing, seller/buyer, thread, and protocol-correct Messenger binding",
    ),
  }),
} satisfies Readonly<Record<MetaWebSite, Readonly<Record<string, MetaWebOperationContract>>>>);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length < 1)
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, label, maximum);
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

const MAX_JSON_SCRIPTS = 512;
const MAX_TREE_NODES = 250_000;
const MAX_TREE_DEPTH = 40;
const FACEBOOK_HOME_STREAM_KEY_PATTERN =
  /^adp_CometModernHomeFeedQueryRelayPreloader_[A-Za-z0-9_]{1,192}$/u;
const FACEBOOK_GROUP_STREAM_KEY_PATTERN =
  /^adp_CometGroupDiscussionRootSuccessQueryRelayPreloader_[A-Za-z0-9_]{1,192}$/u;
const FACEBOOK_MARKETPLACE_FEED_STREAM_KEY_PATTERN =
  /^adp_MarketplaceCometBrowseFeedLightContainerQueryRelayPreloader_[A-Za-z0-9_]{1,192}$/u;
const FACEBOOK_MARKETPLACE_LISTING_DETAIL_STREAM_KEY_PATTERN =
  /^adp_MarketplacePDPContainerQueryRelayPreloader_[A-Za-z0-9_]{1,192}$/u;
const FACEBOOK_MARKETPLACE_LISTING_MEDIA_STREAM_KEY_PATTERN =
  /^adp_MarketplacePDPC2CMediaViewerWithImagesQueryRelayPreloader_[A-Za-z0-9_]{1,192}$/u;
const FACEBOOK_CURRENT_USER_ASYNC_KEY_PATTERN =
  /^adp_WebWorkerV2HasteResponsePreloader_[A-Za-z0-9_]{1,192}$/u;

export function parseMetaJsonScripts(html: unknown): readonly unknown[] {
  const texts = extractMetaJsonScriptTexts(html);
  if (texts.length > MAX_JSON_SCRIPTS) {
    throw new Error("Meta HTML response contained too many JSON scripts");
  }
  const results = texts.map((text) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Meta bootloader JSON script was malformed");
    }
  });
  return Object.freeze(results);
}

export function parseMetaJsonDocuments(text: unknown): readonly unknown[] {
  if (
    typeof text !== "string"
    || text.length < 1
    || text.length > 16 * 1024 * 1024
    || text.includes("\0")
  ) throw new Error("Meta streamed JSON response must be bounded text");
  let source = text;
  if (source.startsWith("for (;;);")) source = source.slice("for (;;);".length);
  const lines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length < 1 || lines.length > 512) {
    throw new Error("Meta streamed JSON response had an unsupported document count");
  }
  const documents = lines.map((line, index) => {
    if (line.length > 4 * 1024 * 1024) {
      throw new Error(`Meta streamed JSON document[${index}] exceeded its reviewed bound`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Meta streamed JSON document[${index}] was malformed`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`Meta streamed JSON document[${index}] must be an object`);
    }
    return parsed;
  });
  return Object.freeze(documents);
}

function walk(
  roots: readonly unknown[],
  visit: (value: unknown, path: readonly string[]) => void,
): void {
  let nodes = 0;
  const stack: { readonly value: unknown; readonly path: readonly string[]; readonly depth: number }[] =
    roots
      .map((value) => ({ value, path: Object.freeze([]), depth: 0 }))
      .reverse();
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    nodes += 1;
    if (nodes > MAX_TREE_NODES) throw new Error("Meta bootloader JSON exceeded its reviewed structural bound");
    visit(item.value, item.path);
    if (item.depth >= MAX_TREE_DEPTH) {
      if (
        (Array.isArray(item.value) && item.value.length > 0)
        || (isRecord(item.value) && Object.keys(item.value).length > 0)
      ) {
        throw new Error("Meta bootloader JSON exceeded its reviewed depth bound");
      }
      continue;
    }
    if (Array.isArray(item.value)) {
      if (item.value.length > 10_000) throw new Error("Meta bootloader JSON contained an oversized array");
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: item.value[index],
          path: Object.freeze([...item.path, "[]"]),
          depth: item.depth + 1,
        });
      }
    } else if (isRecord(item.value)) {
      const entries = Object.entries(item.value);
      if (entries.length > 10_000) throw new Error("Meta bootloader JSON contained an oversized object");
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        stack.push({
          value: entry[1],
          path: Object.freeze([...item.path, entry[0]]),
          depth: item.depth + 1,
        });
      }
    }
  }
}

function pathEquals(
  value: readonly string[],
  expected: readonly string[],
): boolean {
  return value.length === expected.length
    && value.every((segment, index) => segment === expected[index]);
}

function isReviewedRelayModuleTuple(
  value: unknown,
  name: string,
): value is readonly [string, readonly unknown[], JsonRecord, number] {
  return (
    Array.isArray(value)
    && value.length === 4
    && value[0] === name
    && Array.isArray(value[1])
    && value[1].length === 0
    && isRecord(value[2])
    && Number.isSafeInteger(value[3])
    && (value[3] as number) >= 0
  );
}

function directRelayResultMatches(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return (
    pathEquals(path, ["result"])
    && roots.some((root) =>
      isRecord(root)
      && root.result === value
    )
  );
}

function directRelayDataMatches(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  if (pathEquals(path, ["data"])) {
    return roots.some((root) => isRecord(root) && root.data === value);
  }
  return (
    pathEquals(path, ["result", "data"])
    && roots.some((root) =>
      isRecord(root)
      && isRecord(root.result)
      && root.result.data === value
    )
  );
}

function relayPrefetchResultMatches(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
  selectData: boolean,
): boolean {
  const expectedPath = selectData
    ? ["require", "[]", "[]", "__bbox", "result", "data"]
    : ["require", "[]", "[]", "__bbox", "result"];
  if (!pathEquals(path, expectedPath)) return false;
  for (const root of roots) {
    if (!isRecord(root) || !Array.isArray(root.require)) continue;
    for (const candidate of root.require) {
      if (
        !isReviewedRelayModuleTuple(candidate, "Relay")
        && !isReviewedRelayModuleTuple(candidate, "RelayPrefetch")
      ) continue;
      const bbox = candidate[2].__bbox;
      if (!isRecord(bbox) || !isRecord(bbox.result)) continue;
      const selected = selectData ? bbox.result.data : bbox.result;
      if (selected === value) return true;
    }
  }
  return false;
}

function scheduledServerResultMatches(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
  selectData: boolean,
): boolean {
  const expectedPath = selectData
    ? ["require", "[]", "[]", "[]", "__bbox", "result", "data"]
    : ["require", "[]", "[]", "[]", "__bbox", "result"];
  if (!pathEquals(path, expectedPath)) return false;
  for (const root of roots) {
    if (!isRecord(root) || !Array.isArray(root.require)) continue;
    for (const scheduled of root.require) {
      if (
        !Array.isArray(scheduled)
        || scheduled.length !== 4
        || scheduled[0] !== "ScheduledServerJS"
        || scheduled[1] !== "handle"
        || scheduled[2] !== null
        || !Array.isArray(scheduled[3])
      ) continue;
      for (const payload of scheduled[3]) {
        if (
          !isRecord(payload)
          || !isRecord(payload.__bbox)
          || !isRecord(payload.__bbox.result)
        ) continue;
        const selected = selectData
          ? payload.__bbox.result.data
          : payload.__bbox.result;
        if (selected === value) return true;
      }
    }
  }
  return false;
}

function relayPrefetchedStreamResultMatches(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
  selectData: boolean,
  preloaderKeyPattern: RegExp,
): boolean {
  return relayPrefetchedStreamResultKey(
    roots,
    path,
    value,
    selectData,
    preloaderKeyPattern,
  ) !== null;
}

function relayPrefetchedStreamResultKey(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
  selectData: boolean,
  preloaderKeyPattern: RegExp,
): string | null {
  const expectedPath = selectData
    ? [
      "require",
      "[]",
      "[]",
      "[]",
      "__bbox",
      "require",
      "[]",
      "[]",
      "[]",
      "__bbox",
      "result",
      "data",
    ]
    : [
      "require",
      "[]",
      "[]",
      "[]",
      "__bbox",
      "require",
      "[]",
      "[]",
      "[]",
      "__bbox",
      "result",
    ];
  if (!pathEquals(path, expectedPath)) return null;
  let matchedKey: string | null = null;
  for (const root of roots) {
    if (!isRecord(root) || !isUnknownArray(root.require)) continue;
    for (const scheduled of root.require) {
      if (
        !isUnknownArray(scheduled)
        || scheduled.length !== 4
        || scheduled[0] !== "ScheduledServerJS"
        || scheduled[1] !== "handle"
        || scheduled[2] !== null
        || !isUnknownArray(scheduled[3])
      ) continue;
      for (const scheduledPayload of scheduled[3]) {
        if (
          !isRecord(scheduledPayload)
          || !isRecord(scheduledPayload.__bbox)
          || !isUnknownArray(scheduledPayload.__bbox.require)
        ) continue;
        for (const stream of scheduledPayload.__bbox.require) {
          if (
            !isUnknownArray(stream)
            || stream.length !== 4
            || stream[0] !== "RelayPrefetchedStreamCache"
            || stream[1] !== "next"
            || !isUnknownArray(stream[2])
            || stream[2].length !== 0
            || !isUnknownArray(stream[3])
            || stream[3].length !== 2
            || typeof stream[3][0] !== "string"
            || !preloaderKeyPattern.test(stream[3][0])
          ) continue;
          const streamPayload = stream[3][1];
          if (
            !isRecord(streamPayload)
            || !isRecord(streamPayload.__bbox)
            || !isRecord(streamPayload.__bbox.result)
          ) continue;
          const selected = selectData
            ? streamPayload.__bbox.result.data
            : streamPayload.__bbox.result;
          if (selected !== value) continue;
          const candidateKey = stream[3][0];
          if (matchedKey !== null && matchedKey !== candidateKey) {
            throw new Error("Meta streamed result matched multiple preloader keys");
          }
          matchedKey = candidateKey;
        }
      }
    }
  }
  return matchedKey;
}

export function isReviewedMetaRelayDataEnvelope(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return (
    directRelayDataMatches(roots, path, value)
    || relayPrefetchResultMatches(roots, path, value, true)
    || scheduledServerResultMatches(roots, path, value, true)
  );
}

export function isReviewedMetaRelayResultEnvelope(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return (
    directRelayResultMatches(roots, path, value)
    || relayPrefetchResultMatches(roots, path, value, false)
    || scheduledServerResultMatches(roots, path, value, false)
  );
}

function reviewedFacebookHomeFeedDataEnvelopeKey(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): string | null {
  return relayPrefetchedStreamResultKey(
    roots,
    path,
    value,
    true,
    FACEBOOK_HOME_STREAM_KEY_PATTERN,
  );
}

function isReviewedFacebookHomeFeedResultEnvelope(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return relayPrefetchedStreamResultMatches(
    roots,
    path,
    value,
    false,
    FACEBOOK_HOME_STREAM_KEY_PATTERN,
  );
}

function reviewedFacebookHomeFeedResultEnvelopeKey(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): string | null {
  return relayPrefetchedStreamResultKey(
    roots,
    path,
    value,
    false,
    FACEBOOK_HOME_STREAM_KEY_PATTERN,
  );
}

export function isReviewedFacebookGroupRelayResultEnvelope(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return relayPrefetchedStreamResultMatches(
    roots,
    path,
    value,
    false,
    FACEBOOK_GROUP_STREAM_KEY_PATTERN,
  );
}

function reviewedFacebookMarketplaceFeedDataEnvelopeKey(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): string | null {
  return relayPrefetchedStreamResultKey(
    roots,
    path,
    value,
    true,
    FACEBOOK_MARKETPLACE_FEED_STREAM_KEY_PATTERN,
  );
}

function reviewedFacebookMarketplaceFeedResultEnvelopeKey(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): string | null {
  return relayPrefetchedStreamResultKey(
    roots,
    path,
    value,
    false,
    FACEBOOK_MARKETPLACE_FEED_STREAM_KEY_PATTERN,
  );
}

function isReviewedFacebookMarketplaceListingDetailDataEnvelope(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return relayPrefetchedStreamResultMatches(
    roots,
    path,
    value,
    true,
    FACEBOOK_MARKETPLACE_LISTING_DETAIL_STREAM_KEY_PATTERN,
  );
}

function isReviewedFacebookMarketplaceListingMediaDataEnvelope(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return relayPrefetchedStreamResultMatches(
    roots,
    path,
    value,
    true,
    FACEBOOK_MARKETPLACE_LISTING_MEDIA_STREAM_KEY_PATTERN,
  );
}

function isReviewedFacebookMarketplaceListingResultEnvelope(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): boolean {
  return (
    relayPrefetchedStreamResultMatches(
      roots,
      path,
      value,
      false,
      FACEBOOK_MARKETPLACE_LISTING_DETAIL_STREAM_KEY_PATTERN,
    )
    || relayPrefetchedStreamResultMatches(
      roots,
      path,
      value,
      false,
      FACEBOOK_MARKETPLACE_LISTING_MEDIA_STREAM_KEY_PATTERN,
    )
  );
}

function assertEmptyProviderErrors(
  value: JsonRecord,
  label: string,
): void {
  if (!Object.hasOwn(value, "errors")) return;
  if (!Array.isArray(value.errors)) {
    throw new Error(`${label}.errors must be an array`);
  }
  if (value.errors.length > 0) {
    throw new Error(`${label} contained provider errors`);
  }
}

function directModuleContainerContains(
  roots: readonly unknown[],
  path: readonly string[],
  moduleValue: readonly unknown[],
): boolean {
  if (
    !pathEquals(path, ["require", "[]"])
    && !pathEquals(path, ["define", "[]"])
  ) return false;
  const containerName = path[0];
  if (containerName === undefined) return false;
  return roots.some((root) =>
    isRecord(root)
    && Array.isArray(root[containerName])
    && root[containerName].some((candidate) => candidate === moduleValue)
  );
}

function scheduledServerModuleContainerContains(
  roots: readonly unknown[],
  path: readonly string[],
  moduleValue: readonly unknown[],
): boolean {
  const innerContainerName = path[5];
  if (
    (
      !pathEquals(path, [
        "require",
        "[]",
        "[]",
        "[]",
        "__bbox",
        "define",
        "[]",
      ])
      && !pathEquals(path, [
        "require",
        "[]",
        "[]",
        "[]",
        "__bbox",
        "require",
        "[]",
      ])
    )
    || (innerContainerName !== "define" && innerContainerName !== "require")
  ) return false;
  for (const root of roots) {
    if (!isRecord(root) || !Array.isArray(root.require)) continue;
    for (const scheduledValue of root.require) {
      if (
        !Array.isArray(scheduledValue)
        || scheduledValue.length !== 4
        || scheduledValue[0] !== "ScheduledServerJS"
        || scheduledValue[1] !== "handle"
        || scheduledValue[2] !== null
        || !Array.isArray(scheduledValue[3])
      ) continue;
      for (const payload of scheduledValue[3]) {
        if (!isRecord(payload) || !isRecord(payload.__bbox)) continue;
        const container = payload.__bbox[innerContainerName];
        if (
          Array.isArray(container)
          && container.some((candidate) => candidate === moduleValue)
        ) return true;
      }
    }
  }
  return false;
}

function hydratedAsyncDataModuleContainerContains(
  roots: readonly unknown[],
  path: readonly string[],
  moduleValue: readonly unknown[],
): boolean {
  if (!pathEquals(path, [
    "require",
    "[]",
    "[]",
    "[]",
    "__bbox",
    "require",
    "[]",
    "[]",
    "[]",
    "data",
    "__bbox",
    "hrp",
    "jsmods",
    "define",
    "[]",
  ])) return false;
  for (const root of roots) {
    if (!isRecord(root) || !isUnknownArray(root.require)) continue;
    for (const scheduledValue of root.require) {
      if (
        !isUnknownArray(scheduledValue)
        || scheduledValue.length !== 4
        || scheduledValue[0] !== "ScheduledServerJS"
        || scheduledValue[1] !== "handle"
        || scheduledValue[2] !== null
        || !isUnknownArray(scheduledValue[3])
      ) continue;
      for (const scheduledPayload of scheduledValue[3]) {
        if (
          !isRecord(scheduledPayload)
          || !isRecord(scheduledPayload.__bbox)
          || !isUnknownArray(scheduledPayload.__bbox.require)
        ) continue;
        for (const asyncValue of scheduledPayload.__bbox.require) {
          if (
            !isUnknownArray(asyncValue)
            || asyncValue.length !== 4
            || asyncValue[0] !== "AsyncData"
            || asyncValue[1] !== "resolve"
            || !isUnknownArray(asyncValue[2])
            || asyncValue[2].length !== 0
            || !isUnknownArray(asyncValue[3])
            || asyncValue[3].length !== 2
            || typeof asyncValue[3][0] !== "string"
            || !FACEBOOK_CURRENT_USER_ASYNC_KEY_PATTERN.test(asyncValue[3][0])
          ) continue;
          const asyncPayload = asyncValue[3][1];
          if (!isRecord(asyncPayload) || !isRecord(asyncPayload.data)) continue;
          const dataBbox = asyncPayload.data.__bbox;
          if (!isRecord(dataBbox) || !isRecord(dataBbox.hrp)) continue;
          const jsmods = dataBbox.hrp.jsmods;
          if (
            isRecord(jsmods)
            && isUnknownArray(jsmods.define)
            && jsmods.define.some((candidate) => candidate === moduleValue)
          ) return true;
        }
      }
    }
  }
  return false;
}

function modulePathIsReviewed(
  roots: readonly unknown[],
  path: readonly string[],
  moduleValue: readonly unknown[],
  moduleName: string,
): boolean {
  return (
    directModuleContainerContains(roots, path, moduleValue)
    || scheduledServerModuleContainerContains(roots, path, moduleValue)
    || (
      moduleName === "CurrentUserInitialData"
      && hydratedAsyncDataModuleContainerContains(roots, path, moduleValue)
    )
  );
}

function modulePayloads(roots: readonly unknown[], moduleName: string): readonly JsonRecord[] {
  const results: JsonRecord[] = [];
  walk(roots, (value, path) => {
    if (!Array.isArray(value) || value[0] !== moduleName) return;
    if (!modulePathIsReviewed(roots, path, value, moduleName)) {
      throw new Error(`${moduleName} appeared outside a reviewed module path`);
    }
    if (
      value.length !== 4
      || !Array.isArray(value[1])
      || value[1].length !== 0
      || !isRecord(value[2])
      || !Number.isSafeInteger(value[3])
      || (value[3] as number) < 0
    ) {
      throw new Error(`${moduleName} module was malformed`);
    }
    results.push(value[2]);
  });
  return Object.freeze(results);
}

function oneStableId(values: readonly unknown[], label: string): string {
  const ids = new Set<string>();
  for (const value of values) {
    if (isCanonicalMetaNumericId(value)) ids.add(value);
  }
  if (ids.size !== 1) throw new Error(`${label} did not resolve to exactly one stable account ID`);
  return [...ids][0] as string;
}

export function parseInstagramViewerId(html: unknown): string {
  const roots = parseMetaJsonScripts(html);
  const payloads = modulePayloads(roots, "PolarisViewer");
  return oneStableId(payloads.map((payload) => payload.id), "Instagram Polaris viewer");
}

export function parseFacebookViewerId(html: unknown): string {
  const roots = parseMetaJsonScripts(html);
  const payloads = modulePayloads(roots, "CurrentUserInitialData");
  if (payloads.length < 1) {
    throw new Error("Facebook current user did not resolve to exactly one stable account ID");
  }
  const candidates: string[] = [];
  for (const [index, payload] of payloads.entries()) {
    if (
      !isCanonicalMetaNumericId(payload.ACCOUNT_ID)
      || payload.ACCOUNT_ID !== payload.USER_ID
    ) {
      throw new Error(
        `Facebook CurrentUserInitialData[${index}] contained malformed or conflicting viewer identities`,
      );
    }
    candidates.push(payload.ACCOUNT_ID);
  }
  return oneStableId(candidates, "Facebook current user");
}

export function parseThreadsViewerId(html: unknown): string {
  const roots = parseMetaJsonScripts(html);
  const sessionPayloads = modulePayloads(roots, "BarcelonaSessionInfo");
  if (
    sessionPayloads.length < 1
    || sessionPayloads.some((payload) => payload.is_th_session !== true || payload.is_logged_out !== false)
  ) throw new Error("Threads bootstrap did not prove one signed-in Barcelona session");
  const ids: unknown[] = [];
  walk(roots, (value) => {
    if (!isRecord(value)) return;
    const viewer = isRecord(value.viewer) ? value.viewer : null;
    const user = viewer !== null && isRecord(viewer.user) ? viewer.user : null;
    if (user !== null) ids.push(user.id);
  });
  return oneStableId(ids, "Threads Barcelona viewer");
}

function instagramUser(value: unknown, label: string): Readonly<Record<string, unknown>> | null {
  if (value === undefined || value === null) return null;
  const user = record(value, label);
  const id = optionalString(user.pk ?? user.id, `${label}.id`, 32);
  if (id !== null && !isCanonicalMetaNumericId(id)) {
    throw new Error(`${label}.id must be a canonical decimal account ID`);
  }
  return Object.freeze({
    id,
    username: optionalString(user.username, `${label}.username`, 64),
    full_name: optionalString(user.full_name, `${label}.full_name`, 256),
  });
}

function instagramMedia(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const media = record(value, label);
  const id = boundedString(media.id, `${label}.id`, 80);
  if (!/^[0-9]{1,32}(?:_[0-9]{1,32})?$/u.test(id)) throw new Error(`${label}.id must be an exact Instagram media ID`);
  const caption = media.caption === undefined || media.caption === null
    ? null
    : optionalString(record(media.caption, `${label}.caption`).text, `${label}.caption.text`, 10_000);
  return Object.freeze({
    id,
    pk: optionalString(media.pk, `${label}.pk`, 32),
    code: optionalString(media.code, `${label}.code`, 64),
    media_type: optionalInteger(media.media_type, `${label}.media_type`),
    taken_at: optionalInteger(media.taken_at, `${label}.taken_at`),
    caption,
    user: instagramUser(media.user ?? media.owner, `${label}.user`),
    has_liked: optionalBoolean(media.has_liked, `${label}.has_liked`),
    has_viewer_saved: optionalBoolean(
      media.has_viewer_saved ?? media.has_privately_liked,
      `${label}.has_viewer_saved`,
    ),
    like_count: optionalInteger(media.like_count, `${label}.like_count`),
    comment_count: optionalInteger(media.comment_count, `${label}.comment_count`),
  });
}

function okInstagramEnvelope(value: unknown, label: string): JsonRecord {
  const envelope = record(value, label);
  if (envelope.status !== "ok") throw new Error(`${label}.status must be ok`);
  return envelope;
}

export function normalizeInstagramFeed(value: unknown, limit: number): unknown {
  const envelope = okInstagramEnvelope(value, "Instagram timeline response");
  if (!Array.isArray(envelope.feed_items) || envelope.feed_items.length > 500) {
    throw new Error("Instagram timeline response.feed_items must be a bounded array");
  }
  const items: unknown[] = [];
  for (const [index, itemValue] of envelope.feed_items.entries()) {
    const item = record(itemValue, `Instagram timeline response.feed_items[${index}]`);
    if (item.media_or_ad === undefined) continue;
    items.push(instagramMedia(item.media_or_ad, `Instagram timeline media[${index}]`));
    if (items.length >= limit) break;
  }
  optionalString(envelope.next_max_id, "Instagram timeline response.next_max_id", 4096);
  optionalBoolean(envelope.more_available, "Instagram timeline response.more_available");
  return Object.freeze({
    feed: "home",
    items: Object.freeze(items),
    page_scope: "first-page-only",
    continuation_supported: false,
  });
}

export function normalizeInstagramPost(value: unknown, mediaId: string): unknown {
  const envelope = okInstagramEnvelope(value, "Instagram media-info response");
  if (!Array.isArray(envelope.items) || envelope.items.length !== 1) {
    throw new Error("Instagram media-info response must contain exactly one item");
  }
  const item = instagramMedia(envelope.items[0], "Instagram media-info item");
  if (item.id !== mediaId) throw new Error("Instagram media-info response did not bind the requested media");
  return item;
}

export function normalizeInstagramComments(value: unknown, mediaId: string, limit: number): unknown {
  const envelope = okInstagramEnvelope(value, "Instagram comments response");
  const caption = record(envelope.caption, "Instagram comments response.caption");
  const captionMediaId = boundedString(caption.media_id, "Instagram comments response.caption.media_id", 80);
  const bare = mediaId.split("_", 1)[0] ?? mediaId;
  if (captionMediaId !== mediaId && captionMediaId !== bare) {
    throw new Error("Instagram comments response did not bind the requested media");
  }
  if (!Array.isArray(envelope.comments) || envelope.comments.length > 10_000) {
    throw new Error("Instagram comments response.comments must be a bounded array");
  }
  const comments = envelope.comments.slice(0, limit).map((value, index) => {
    const comment = record(value, `Instagram comments response.comments[${index}]`);
    const id = boundedString(comment.pk ?? comment.id, `Instagram comments response.comments[${index}].id`, 80);
    return Object.freeze({
      id,
      text: boundedString(comment.text, `Instagram comments response.comments[${index}].text`, 10_000, true),
      created_at: optionalInteger(comment.created_at, `Instagram comments response.comments[${index}].created_at`),
      parent_comment_id: optionalString(
        comment.parent_comment_id,
        `Instagram comments response.comments[${index}].parent_comment_id`,
        80,
      ),
      user: instagramUser(comment.user, `Instagram comments response.comments[${index}].user`),
      has_liked_comment: optionalBoolean(
        comment.has_liked_comment,
        `Instagram comments response.comments[${index}].has_liked_comment`,
      ),
      comment_like_count: optionalInteger(
        comment.comment_like_count,
        `Instagram comments response.comments[${index}].comment_like_count`,
      ),
    });
  });
  optionalString(
    envelope.next_min_id ?? envelope.next_max_id,
    "Instagram comments response.next_cursor",
    4096,
  );
  optionalBoolean(
    envelope.has_more_comments ?? envelope.has_more_headload_comments,
    "Instagram comments response.has_more",
  );
  return Object.freeze({
    media_id: mediaId,
    comments: Object.freeze(comments),
    page_scope: "first-page-only",
    continuation_supported: false,
  });
}

export function normalizeInstagramInbox(value: unknown, viewerId: string, limit: number): unknown {
  if (!isCanonicalMetaNumericId(viewerId)) {
    throw new Error("Instagram inbox viewer ID must be a canonical decimal account ID");
  }
  const envelope = okInstagramEnvelope(value, "Instagram inbox response");
  const viewer = record(envelope.viewer, "Instagram inbox response.viewer");
  const responseViewerId = boundedString(viewer.pk ?? viewer.id, "Instagram inbox response.viewer.id", 32);
  if (!isCanonicalMetaNumericId(responseViewerId)) {
    throw new Error("Instagram inbox response.viewer.id must be a canonical decimal account ID");
  }
  if (responseViewerId !== viewerId) {
    throw new Error("Instagram inbox response changed its bound viewer");
  }
  const inbox = record(envelope.inbox, "Instagram inbox response.inbox");
  if (!Array.isArray(inbox.threads) || inbox.threads.length > 1_000) {
    throw new Error("Instagram inbox response.inbox.threads must be a bounded array");
  }
  const rawThreadCount = inbox.threads.length;
  const threads = inbox.threads.slice(0, limit).map((value, index) => {
    const thread = record(value, `Instagram inbox response.inbox.threads[${index}]`);
    if (thread.users !== undefined && !Array.isArray(thread.users)) {
      throw new Error(`Instagram inbox thread[${index}].users must be a bounded array`);
    }
    if (Array.isArray(thread.users) && thread.users.length > 100) {
      throw new Error(`Instagram inbox thread[${index}].users exceeded its reviewed bound`);
    }
    const users = Array.isArray(thread.users)
      ? thread.users.map((user, userIndex) =>
        instagramUser(user, `Instagram inbox thread[${index}].users[${userIndex}]`))
      : [];
    return Object.freeze({
      thread_id: boundedString(thread.thread_id, `Instagram inbox thread[${index}].thread_id`, 512),
      thread_title: optionalString(thread.thread_title, `Instagram inbox thread[${index}].thread_title`, 512),
      users: Object.freeze(users),
      last_activity_at: optionalInteger(thread.last_activity_at, `Instagram inbox thread[${index}].last_activity_at`),
      read_state: optionalInteger(thread.read_state, `Instagram inbox thread[${index}].read_state`),
      pending: optionalBoolean(thread.pending, `Instagram inbox thread[${index}].pending`),
    });
  });
  const providerCursor = optionalString(
    inbox.oldest_cursor ?? inbox.next_cursor,
    "Instagram inbox next cursor",
    4096,
  );
  const providerHasOlder = optionalBoolean(inbox.has_older, "Instagram inbox has_older") ?? false;
  return Object.freeze({
    folder: "inbox",
    threads: Object.freeze(threads),
    page_scope: "first-page-only",
    continuation_supported: false,
    raw_thread_count: rawThreadCount,
    provider_has_older: providerHasOlder,
    provider_cursor_present: providerCursor !== null,
    pending_requests_total: optionalInteger(envelope.pending_requests_total, "Instagram inbox pending_requests_total"),
  });
}

export function normalizeInstagramContacts(
  value: unknown,
  viewerId: string,
  threadLimit: number,
  contactLimit: number,
): unknown {
  const inbox = record(
    normalizeInstagramInbox(value, viewerId, threadLimit),
    "Instagram normalized inbox",
  );
  if (!Array.isArray(inbox.threads)) {
    throw new Error("Instagram normalized inbox omitted its bounded threads");
  }
  const rawThreadCount = optionalInteger(
    inbox.raw_thread_count,
    "Instagram normalized inbox.raw_thread_count",
  );
  const providerHasOlder = optionalBoolean(
    inbox.provider_has_older,
    "Instagram normalized inbox.provider_has_older",
  );
  const providerCursorPresent = optionalBoolean(
    inbox.provider_cursor_present,
    "Instagram normalized inbox.provider_cursor_present",
  );
  if (
    rawThreadCount === null
    || providerHasOlder === null
    || providerCursorPresent === null
  ) {
    throw new Error("Instagram normalized inbox omitted its pagination evidence");
  }
  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [threadIndex, threadValue] of inbox.threads.entries()) {
    const thread = record(
      threadValue,
      `Instagram normalized inbox.threads[${threadIndex}]`,
    );
    if (!Array.isArray(thread.users)) {
      throw new Error(
        `Instagram normalized inbox.threads[${threadIndex}].users must be a bounded array`,
      );
    }
    for (const [userIndex, userValue] of thread.users.entries()) {
      const user = record(
        userValue,
        `Instagram normalized inbox.threads[${threadIndex}].users[${userIndex}]`,
      );
      const id = boundedString(
        user.id,
        `Instagram normalized inbox.threads[${threadIndex}].users[${userIndex}].id`,
        32,
      );
      if (id === viewerId || byId.has(id)) continue;
      byId.set(id, Object.freeze({
        providerId: id,
        displayName: optionalString(
          user.full_name,
          `Instagram normalized inbox.threads[${threadIndex}].users[${userIndex}].full_name`,
          256,
        ),
        handle: optionalString(
          user.username,
          `Instagram normalized inbox.threads[${threadIndex}].users[${userIndex}].username`,
          64,
        ),
        ...unavailableInstagramContactStatsProjection,
      }));
    }
  }
  const allContacts = [...byId.values()];
  const threadLimitReached = rawThreadCount > threadLimit;
  const contactLimitReached = allContacts.length > contactLimit;
  const contactSetIncompleteReasons = [
    "first-inbox-page-only",
    ...(providerHasOlder ? ["provider-has-older"] : []),
    ...(providerCursorPresent ? ["provider-cursor-present"] : []),
    ...(threadLimitReached ? ["thread-limit-reached"] : []),
    ...(contactLimitReached ? ["contact-limit-reached"] : []),
  ] as const;
  const contactTruncated = providerHasOlder
    || providerCursorPresent
    || threadLimitReached
    || contactLimitReached;
  return Object.freeze({
    provider: "instagram",
    operation: "contacts.list",
    accountSubject: `instagram:${viewerId}`,
    contacts: Object.freeze(allContacts.slice(0, contactLimit)),
    metadataScope: "first-page-inbox-participant-summary",
    contactSetCompleteness: "first-page-only",
    contactSetIncompleteReasons: Object.freeze(contactSetIncompleteReasons),
    contactTruncated,
    statsScope: "unavailable-without-acknowledgement-free-message-history",
  });
}

export type ThreadsImageProjection = Readonly<{
  candidateCount: number;
  height: number;
  mediaId: string;
  mediaType: 1;
  width: number;
}>;

export type ThreadsPostProjection = Readonly<{
  id: string;
  code: string | null;
  canonical_url: string | null;
  caption: string | null;
  user: Readonly<Record<string, unknown>> | null;
  taken_at: number | null;
  has_liked: boolean | null;
  has_viewer_saved: boolean | null;
  like_count: number | null;
  image: ThreadsImageProjection | null;
}>;

function positiveThreadsImageDimension(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20_000) {
    throw new Error(`${label} must be an integer between 1 and 20000`);
  }
  return value as number;
}

function threadsImageCandidateUrl(value: unknown, label: string): string {
  const source = boundedString(value, label, 16_384);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${label} must be an exact reviewed HTTPS media URL`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || ![
      "cdninstagram.com",
      "fbcdn.net",
      "instagram.com",
      "threads.com",
    ].some((family) => hostname === family || hostname.endsWith(`.${family}`))
  ) throw new Error(`${label} left the reviewed Threads media host families`);
  return url.href;
}

function threadsImage(
  post: JsonRecord,
  mediaId: string,
  label: string,
): ThreadsImageProjection | null {
  const hasImageFields = post.media_type !== undefined
    || post.original_width !== undefined
    || post.original_height !== undefined
    || post.image_versions2 !== undefined;
  if (!hasImageFields) return null;
  if (post.media_type !== 1) {
    throw new Error(`${label}.media_type must identify one reviewed image`);
  }
  if (post.carousel_media !== undefined && post.carousel_media !== null) {
    throw new Error(`${label} unexpectedly returned carousel media`);
  }
  const width = positiveThreadsImageDimension(
    post.original_width,
    `${label}.original_width`,
  );
  const height = positiveThreadsImageDimension(
    post.original_height,
    `${label}.original_height`,
  );
  const versions = record(post.image_versions2, `${label}.image_versions2`);
  if (
    !Array.isArray(versions.candidates)
    || versions.candidates.length < 1
    || versions.candidates.length > 20
  ) throw new Error(`${label}.image_versions2.candidates must contain 1 to 20 images`);
  let originalCandidateFound = false;
  for (const [index, candidateValue] of versions.candidates.entries()) {
    const candidate = record(
      candidateValue,
      `${label}.image_versions2.candidates[${index}]`,
    );
    const candidateWidth = positiveThreadsImageDimension(
      candidate.width,
      `${label}.image_versions2.candidates[${index}].width`,
    );
    const candidateHeight = positiveThreadsImageDimension(
      candidate.height,
      `${label}.image_versions2.candidates[${index}].height`,
    );
    threadsImageCandidateUrl(
      candidate.url,
      `${label}.image_versions2.candidates[${index}].url`,
    );
    if (candidateWidth === width && candidateHeight === height) {
      originalCandidateFound = true;
    }
  }
  if (!originalCandidateFound) {
    throw new Error(`${label} omitted an exact original-dimension image candidate`);
  }
  return Object.freeze({
    candidateCount: versions.candidates.length,
    height,
    mediaId,
    mediaType: 1,
    width,
  });
}

function threadsPost(value: unknown, label: string): Omit<ThreadsPostProjection, "image"> {
  const post = record(value, label);
  const id = boundedString(post.id ?? post.pk, `${label}.id`, 80);
  if (!/^[0-9]{1,32}(?:_[0-9]{1,32})?$/u.test(id)) throw new Error(`${label}.id must be an exact Threads post ID`);
  const caption = post.caption === undefined || post.caption === null
    ? null
    : optionalString(record(post.caption, `${label}.caption`).text, `${label}.caption.text`, 10_000);
  return Object.freeze({
    id,
    code: optionalString(post.code, `${label}.code`, 64),
    canonical_url: optionalString(post.canonical_url, `${label}.canonical_url`, 2_048),
    caption,
    user: instagramUser(post.user, `${label}.user`),
    taken_at: optionalInteger(post.taken_at, `${label}.taken_at`),
    has_liked: optionalBoolean(post.has_liked, `${label}.has_liked`),
    has_viewer_saved: optionalBoolean(post.has_viewer_saved, `${label}.has_viewer_saved`),
    like_count: optionalInteger(post.like_count, `${label}.like_count`),
  });
}

export function projectThreadsPublishPost(
  value: unknown,
  label: string,
): ThreadsPostProjection {
  const post = record(value, label);
  const projected = threadsPost(post, label);
  return Object.freeze({
    ...projected,
    image: threadsImage(post, projected.id, label),
  });
}

export function normalizeThreadsFeedHtml(html: unknown, viewerId: string, limit: number): unknown {
  const roots = parseMetaJsonScripts(html);
  if (parseThreadsViewerId(html) !== viewerId) throw new Error("Threads feed response changed its bound viewer");
  const posts: Readonly<Record<string, unknown>>[] = [];
  const seen = new Set<string>();
  walk(roots, (value) => {
    if (!isRecord(value) || !Array.isArray(value.edges) || posts.length >= limit) return;
    for (const edgeValue of value.edges) {
      if (posts.length >= limit || !isRecord(edgeValue)) break;
      const node = isRecord(edgeValue.node) ? edgeValue.node : null;
      const thread = node !== null && isRecord(node.text_post_app_thread)
        ? node.text_post_app_thread
        : null;
      if (thread === null || !Array.isArray(thread.thread_items)) continue;
      for (const itemValue of thread.thread_items) {
        if (posts.length >= limit || !isRecord(itemValue) || !isRecord(itemValue.post)) break;
        const projected = threadsPost(itemValue.post, "Threads feed post");
        const id = projected.id;
        if (typeof id !== "string" || seen.has(id)) continue;
        seen.add(id);
        posts.push(projected);
      }
    }
  });
  if (posts.length === 0) throw new Error("Threads Relay preload omitted a bounded feed");
  return Object.freeze({
    feed: "for-you",
    posts: Object.freeze(posts),
    page_scope: "first-page-only",
    continuation_supported: false,
  });
}

export function normalizeThreadsPostHtml(
  html: unknown,
  viewerId: string,
  expectedPostId: string,
  expectedCode: string,
  expectedUrl: string,
  expectedCaption: string,
  expectedImage: Readonly<{ readonly height: number; readonly width: number }> | null,
): ThreadsPostProjection {
  if (!/^[0-9]{1,32}(?:_[0-9]{1,32})?$/u.test(expectedPostId)) {
    throw new Error("Threads readback expected post ID is invalid");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(expectedCode)) {
    throw new Error("Threads readback expected post code is invalid");
  }
  let locator: URL;
  try {
    locator = new URL(expectedUrl);
  } catch {
    throw new Error("Threads readback expected permalink is invalid");
  }
  const locatorPath = locator.pathname.split("/");
  if (
    locator.origin !== "https://www.threads.com"
    || locator.username !== ""
    || locator.password !== ""
    || locator.search !== ""
    || locator.hash !== ""
    || locatorPath.length !== 4
    || !/^@[A-Za-z0-9._]{1,64}$/u.test(locatorPath[1] ?? "")
    || locatorPath[2] !== "post"
    || locatorPath[3] !== expectedCode
  ) throw new Error("Threads readback expected permalink is invalid");
  if (parseThreadsViewerId(html) !== viewerId) {
    throw new Error("Threads post readback changed its bound viewer");
  }
  const matches: Readonly<Record<string, unknown>>[] = [];
  walk(parseMetaJsonScripts(html), (value) => {
    if (
      !isRecord(value)
      || (value.id !== expectedPostId && value.pk !== expectedPostId)
      || value.caption === undefined
      || value.user === undefined
    ) return;
    const projected = projectThreadsPublishPost(value, "Threads post readback");
    const user = isRecord(projected.user) ? projected.user : null;
    const imageMatches = expectedImage === null
      ? projected.image === null
      : projected.image !== null
        && projected.image.mediaId === expectedPostId
        && projected.image.width === expectedImage.width
        && projected.image.height === expectedImage.height;
    if (
      projected.caption === expectedCaption
      && projected.code === expectedCode
      && projected.canonical_url === locator.href
      && user?.id === viewerId
      && imageMatches
    ) {
      matches.push(projected);
    }
  });
  if (matches.length < 1) {
    throw new Error(
      expectedImage === null
        ? "Threads post readback did not bind the confirmed actor, ID, code, permalink, and text"
        : "Threads post readback did not bind the confirmed actor, ID, code, permalink, text, and image",
    );
  }
  if (matches.length !== 1) {
    throw new Error("Threads post readback returned an ambiguous exact post");
  }
  return matches[0] as ThreadsPostProjection;
}

function facebookPost(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const node = record(value, label);
  const id = boundedString(node.post_id ?? node.id, `${label}.id`, 256);
  const actors = Array.isArray(node.actors)
    ? node.actors.slice(0, 20).map((actorValue, index) => {
      const actor = record(actorValue, `${label}.actors[${index}]`);
      return Object.freeze({
        id: optionalString(actor.id, `${label}.actors[${index}].id`, 64),
        name: optionalString(actor.name, `${label}.actors[${index}].name`, 512),
      });
    })
    : [];
  let message: string | null = null;
  const sections = isRecord(node.comet_sections) ? node.comet_sections : null;
  const content = sections !== null && isRecord(sections.content) ? sections.content : null;
  const story = content !== null && isRecord(content.story) ? content.story : null;
  const storyMessage = story !== null && isRecord(story.message) ? story.message : null;
  if (storyMessage !== null) message = optionalString(storyMessage.text, `${label}.message`, 20_000);
  return Object.freeze({
    id,
    permalink_url: optionalString(node.permalink_url, `${label}.permalink_url`, 4_096),
    creation_time: optionalInteger(node.creation_time, `${label}.creation_time`),
    message,
    actors: Object.freeze(actors),
  });
}

export function normalizeFacebookFeedHtml(html: unknown, viewerId: string, limit: number): unknown {
  const roots = parseMetaJsonScripts(html);
  if (parseFacebookViewerId(html) !== viewerId) throw new Error("Facebook feed response changed its bound viewer");
  assertMetaCometReadActor(roots, viewerId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new Error("Facebook feed limit must be an integer between 1 and 30");
  }
  const posts: Readonly<Record<string, unknown>>[] = [];
  const seen = new Set<string>();
  const indexedEdges = new Map<number, {
    readonly edge: JsonRecord;
    readonly label: string;
  }>();
  let rootCount = 0;
  let streamedEdgeCount = 0;
  let finalPageInfoCount = 0;
  let streamPhase: "before-root" | "edges" | "final" = "before-root";
  let streamPreloaderKey: string | null = null;
  const addNode = (node: unknown, label: string): void => {
    if (!isRecord(node)) return;
    const isFeedStory = node.__isFeedUnit === "Story";
    if (
      (node.__typename !== undefined && node.__typename !== "Story" && isFeedStory)
      || (node.__typename === "Story" && !isFeedStory)
    ) {
      throw new Error(`${label} changed its Story type markers`);
    }
    if (!isFeedStory) return;
    const post = facebookPost(node, label);
    const id = post.id;
    if (typeof id !== "string") return;
    if (seen.has(id)) throw new Error("Facebook news feed contained a duplicate Story ID");
    seen.add(id);
    if (posts.length < limit) posts.push(post);
  };
  walk(roots, (value, path) => {
    if (!isRecord(value)) return;
    if (
      path.length === 0
      || isReviewedFacebookHomeFeedResultEnvelope(roots, path, value)
    ) {
      assertEmptyProviderErrors(value, "Facebook news-feed envelope");
    }
    const viewer = isRecord(value.viewer) ? value.viewer : null;
    const feed = viewer !== null && isRecord(viewer.news_feed) ? viewer.news_feed : null;
    if (feed !== null) {
      const feedPreloaderKey = reviewedFacebookHomeFeedDataEnvelopeKey(
        roots,
        path,
        value,
      );
      if (feedPreloaderKey === null) {
        throw new Error("Facebook news feed appeared outside its reviewed Relay data root");
      }
      if (streamPhase !== "before-root") {
        throw new Error("Facebook news feed emitted its initial root out of order");
      }
      streamPhase = "edges";
      streamPreloaderKey = feedPreloaderKey;
      if (!Array.isArray(feed.edges) || feed.edges.length > 500) {
        throw new Error("Facebook news-feed root edges must be a bounded array");
      }
      rootCount += 1;
      for (const [index, edgeValue] of feed.edges.entries()) {
        const edge = record(edgeValue, `Facebook news-feed edge[${index}]`);
        boundedString(edge.cursor, `Facebook news-feed edge[${index}].cursor`, 4_096);
        if (indexedEdges.has(index)) {
          throw new Error("Facebook news feed contained a duplicate edge coordinate");
        }
        indexedEdges.set(index, {
          edge,
          label: `Facebook news-feed edge[${index}]`,
        });
      }
    }
    if (Array.isArray(value.path)) {
      const patch = value.path;
      const patchPreloaderKey = reviewedFacebookHomeFeedResultEnvelopeKey(
        roots,
        path,
        value,
      );
      const reviewedPatchEnvelope = patchPreloaderKey !== null;
      if (
        reviewedPatchEnvelope
        && streamPreloaderKey !== null
        && patchPreloaderKey !== streamPreloaderKey
      ) {
        throw new Error("Facebook news-feed stream changed its bound preloader key");
      }
      if (
        patch.length === 4
        && patch[0] === "viewer"
        && patch[1] === "news_feed"
        && patch[2] === "edges"
        && typeof patch[3] === "number"
      ) {
        if (!reviewedPatchEnvelope || patch[3] < 0 || patch[3] > 499) {
          throw new Error("Facebook news-feed patch used an unreviewed path");
        }
        if (streamPhase !== "edges") {
          throw new Error("Facebook news-feed edge patch appeared outside its reviewed stream order");
        }
        const extensions = record(
          value.extensions,
          `Facebook news-feed patch[${patch[3]}].extensions`,
        );
        if (extensions.is_final !== false) {
          throw new Error("Facebook news-feed edge patch was not explicitly nonfinal");
        }
        const edge = record(value.data, `Facebook news-feed patch[${patch[3]}]`);
        boundedString(edge.cursor, `Facebook news-feed patch[${patch[3]}].cursor`, 4_096);
        if (indexedEdges.has(patch[3])) {
          throw new Error("Facebook news feed contained a duplicate edge coordinate");
        }
        indexedEdges.set(patch[3], {
          edge,
          label: `Facebook news-feed patch[${patch[3]}]`,
        });
        streamedEdgeCount += 1;
      } else if (
        patch.length === 2
        && patch[0] === "viewer"
        && patch[1] === "news_feed"
      ) {
        if (!reviewedPatchEnvelope) {
          throw new Error("Facebook news-feed patch used an unreviewed path");
        }
        if (streamPhase !== "edges") {
          throw new Error("Facebook news-feed final patch appeared outside its reviewed stream order");
        }
        streamPhase = "final";
        const extensions = record(
          value.extensions,
          "Facebook news-feed final patch extensions",
        );
        if (extensions.is_final !== true) {
          throw new Error("Facebook news-feed final patch was not explicitly final");
        }
        const data = record(value.data, "Facebook news-feed final patch data");
        const pageInfo = record(
          data.page_info,
          "Facebook news-feed final patch page_info",
        );
        if (typeof pageInfo.has_next_page !== "boolean") {
          throw new Error("Facebook news-feed final page_info.has_next_page must be boolean");
        }
        if (pageInfo.end_cursor !== null) {
          boundedString(
            pageInfo.end_cursor,
            "Facebook news-feed final page_info.end_cursor",
            4_096,
          );
        }
        finalPageInfoCount += 1;
      } else if (patch[0] === "viewer" && patch[1] === "news_feed") {
        throw new Error("Facebook news-feed patch used an unreviewed path");
      }
    }
  });
  if (rootCount !== 1) {
    throw new Error("Facebook Relay preload did not contain exactly one news-feed root");
  }
  if (
    finalPageInfoCount > 1
    || (streamedEdgeCount > 0 && finalPageInfoCount !== 1)
  ) {
    throw new Error("Facebook news feed did not contain exactly one final page_info fragment");
  }
  const orderedEdges = [...indexedEdges.entries()].sort(
    ([left], [right]) => left - right,
  );
  for (const [expectedIndex, [providerIndex, indexed]] of orderedEdges.entries()) {
    if (providerIndex !== expectedIndex) {
      throw new Error("Facebook news feed used a noncontiguous edge coordinate");
    }
    addNode(indexed.edge.node, `${indexed.label}.node`);
  }
  if (posts.length === 0) throw new Error("Facebook Relay preload omitted a bounded news feed");
  return Object.freeze({
    feed: "home",
    posts: Object.freeze(posts),
    nextCursor: null,
    continuationSupported: false,
    complete: false,
  });
}

function exactDecimalId(value: unknown, label: string): string {
  const id = boundedString(value, label, 32);
  if (!/^[0-9]{1,32}$/u.test(id) || id === "0") throw new Error(`${label} must be a stable decimal ID`);
  return id;
}

function optionalHttpsUrl(value: unknown, label: string, maximum = 4_096): string | null {
  const raw = optionalString(value, label, maximum);
  if (raw === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  return parsed.href;
}

function marketplaceLocation(value: unknown, label: string): Readonly<Record<string, string | null>> {
  if (value === undefined || value === null) {
    return Object.freeze({ city: null, state: null });
  }
  const location = record(value, label);
  const reverseGeocode = record(location.reverse_geocode, `${label}.reverse_geocode`);
  return Object.freeze({
    city: optionalString(reverseGeocode.city, `${label}.reverse_geocode.city`, 256),
    state: optionalString(reverseGeocode.state, `${label}.reverse_geocode.state`, 256),
  });
}

function marketplaceFeedListing(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  const node = record(value, label);
  if (node.__typename === "MarketplaceFeedGeneralListingObject") {
    if (node.__isMarketplaceFeedGeneralListingData !== "MarketplaceFeedGeneralListingObject") {
      throw new Error(`${label} changed its reviewed listing marker`);
    }
    const entity = record(node.entity, `${label}.entity`);
    const listing = record(node.listing, `${label}.listing`);
    const entityId = exactDecimalId(entity.id, `${label}.entity.id`);
    const listingId = exactDecimalId(listing.id, `${label}.listing.id`);
    if (entityId !== listingId) throw new Error(`${label} did not bind one exact Marketplace listing`);
    const data = record(node.data, `${label}.data`);
    const price = record(data.price, `${label}.data.price`);
    const photo = record(node.photo, `${label}.photo`);
    const image = record(photo.default_image, `${label}.photo.default_image`);
    return Object.freeze({
      id: listingId,
      title: boundedString(data.title, `${label}.data.title`, 512),
      amount: boundedString(price.amount_with_offset, `${label}.data.price.amount_with_offset`, 64),
      currency: boundedString(price.currency, `${label}.data.price.currency`, 16),
      formatted_price: null,
      location: marketplaceLocation(entity.location, `${label}.entity.location`),
      image_url: optionalHttpsUrl(image.uri, `${label}.photo.default_image.uri`),
      creation_time: optionalInteger(listing.creation_time, `${label}.listing.creation_time`),
    });
  }
  if (node.__typename === "GroupCommerceProductItem") {
    const id = exactDecimalId(node.id, `${label}.id`);
    const price = record(node.listing_price, `${label}.listing_price`);
    const formattedPrice = record(node.formatted_price, `${label}.formatted_price`);
    const photo = record(node.primary_listing_photo, `${label}.primary_listing_photo`);
    const image = record(photo.image, `${label}.primary_listing_photo.image`);
    return Object.freeze({
      id,
      title: boundedString(node.marketplace_listing_title, `${label}.marketplace_listing_title`, 512),
      amount: boundedString(price.amount, `${label}.listing_price.amount`, 64),
      currency: null,
      formatted_price: boundedString(formattedPrice.text, `${label}.formatted_price.text`, 128),
      location: marketplaceLocation(node.location, `${label}.location`),
      image_url: optionalHttpsUrl(image.uri, `${label}.primary_listing_photo.image.uri`),
      creation_time: optionalInteger(node.creation_time, `${label}.creation_time`),
    });
  }
  throw new Error(`${label} used an unreviewed Marketplace listing variant`);
}

type MarketplaceIndexedEdge = {
  readonly index: number;
  readonly edge: JsonRecord;
};

export type FacebookMarketplaceFeed = {
  readonly feed: "marketplace";
  readonly listings: readonly Readonly<Record<string, unknown>>[];
  readonly sponsored_units: number;
  readonly provider_has_next_page: boolean;
  readonly next_cursor: string | null;
  readonly continuation_supported: boolean;
  readonly truncated: boolean;
  readonly complete: boolean;
};

function marketplaceFeedStream(
  roots: readonly unknown[],
  source: "html" | "documents",
): {
  readonly edges: readonly MarketplaceIndexedEdge[];
  readonly endCursor: string;
  readonly hasNextPage: boolean;
  readonly root: JsonRecord;
} {
  const indexed = new Map<number, JsonRecord>();
  let rootCount = 0;
  let selectedRoot: JsonRecord | null = null;
  const pageInfoCandidates: JsonRecord[] = [];
  let finalPageInfoCount = 0;
  let streamPhase: "before-root" | "edges" | "final" = "before-root";
  let streamPreloaderKey: string | null = null;

  const addEdge = (index: number, value: unknown, label: string): void => {
    if (!Number.isSafeInteger(index) || index < 0 || index > 499) {
      throw new Error(`${label} used an out-of-bounds edge index`);
    }
    if (value === null) return;
    const edge = record(value, label);
    if (indexed.has(index)) throw new Error("Marketplace feed stream contained a duplicate edge index");
    indexed.set(index, edge);
  };

  walk(roots, (value, pathToValue) => {
    if (!isRecord(value)) return;
    const resultPreloaderKey = source === "html"
      ? reviewedFacebookMarketplaceFeedResultEnvelopeKey(
        roots,
        pathToValue,
        value,
      )
      : null;
    const reviewedResultEnvelope = source === "html"
      ? resultPreloaderKey !== null
      : (
        pathToValue.length === 0
        || directRelayResultMatches(roots, pathToValue, value)
      );
    if (
      pathToValue.length === 0
      || reviewedResultEnvelope
    ) {
      assertEmptyProviderErrors(value, "Marketplace feed envelope");
    }
    if (Object.hasOwn(value, "marketplace_home_feed")) {
      const dataPreloaderKey = source === "html"
        ? reviewedFacebookMarketplaceFeedDataEnvelopeKey(
          roots,
          pathToValue,
          value,
        )
        : null;
      const reviewedDataEnvelope = source === "html"
        ? dataPreloaderKey !== null
        : directRelayDataMatches(roots, pathToValue, value);
      if (!reviewedDataEnvelope) {
        throw new Error("Marketplace feed root appeared outside its reviewed Relay data root");
      }
      if (streamPhase !== "before-root") {
        throw new Error("Marketplace feed emitted its initial root out of order");
      }
      streamPhase = "edges";
      if (source === "html") {
        streamPreloaderKey = dataPreloaderKey;
      }
      const feed = record(value.marketplace_home_feed, "Marketplace feed root");
      if (!Array.isArray(feed.edges) || feed.edges.length > 500) {
        throw new Error("Marketplace feed root edges must be a bounded array");
      }
      rootCount += 1;
      selectedRoot = feed;
      for (const [index, edge] of feed.edges.entries()) {
        addEdge(index, edge, `Marketplace feed root edge[${index}]`);
      }
    }
    if (!Array.isArray(value.path)) return;
    const path = value.path;
    const concernsMarketplace =
      path[0] === "marketplace_home_feed";
    const patchPreloaderKey = source === "html"
      ? reviewedFacebookMarketplaceFeedResultEnvelopeKey(
        roots,
        pathToValue,
        value,
      )
      : null;
    if (
      concernsMarketplace
      && (
        source === "html"
          ? patchPreloaderKey === null
          : pathToValue.length !== 0
      )
    ) {
      throw new Error("Marketplace feed patch appeared outside its reviewed streamed envelope");
    }
    if (
      concernsMarketplace
      && source === "html"
      && streamPreloaderKey !== null
      && patchPreloaderKey !== streamPreloaderKey
    ) {
      throw new Error("Marketplace feed stream changed its bound preloader key");
    }
    if (concernsMarketplace && streamPhase !== "edges") {
      throw new Error("Marketplace feed patch appeared outside its reviewed stream order");
    }
    if (
      path.length === 3
      && path[0] === "marketplace_home_feed"
      && path[1] === "edges"
      && typeof path[2] === "number"
    ) {
      const extensions = record(
        value.extensions,
        "Marketplace feed streamed edge extensions",
      );
      if (extensions.is_final !== false) {
        throw new Error("Marketplace feed streamed edge must be explicitly nonfinal");
      }
      addEdge(path[2], value.data, `Marketplace feed streamed edge[${path[2]}]`);
      return;
    }
    if (path.length === 1 && path[0] === "marketplace_home_feed") {
      const extensions = record(
        value.extensions,
        "Marketplace feed streamed page-info extensions",
      );
      if (extensions.is_final !== true) {
        throw new Error("Marketplace feed streamed page-info fragment was not final");
      }
      const data = record(value.data, "Marketplace feed streamed page info");
      pageInfoCandidates.push(record(data.page_info, "Marketplace feed streamed page_info"));
      finalPageInfoCount += 1;
      streamPhase = "final";
      return;
    }
    if (concernsMarketplace) {
      throw new Error("Marketplace feed patch used an unreviewed path");
    }
  });

  if (rootCount !== 1) throw new Error("Marketplace response did not contain exactly one feed root");
  if (selectedRoot === null) {
    throw new Error("Marketplace response did not contain exactly one feed root");
  }
  if (pageInfoCandidates.length !== 1 || finalPageInfoCount !== 1) {
    throw new Error("Marketplace response did not contain one final page-info fragment");
  }
  const ordered = [...indexed.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, edge]) => Object.freeze({ index, edge }));
  if (ordered.length === 0 || ordered.some((entry, index) => entry.index !== index)) {
    throw new Error("Marketplace feed stream did not contain one contiguous provider page");
  }
  const pageInfo = pageInfoCandidates[0];
  if (pageInfo === undefined || typeof pageInfo.has_next_page !== "boolean") {
    throw new Error("Marketplace feed page_info.has_next_page must be boolean");
  }
  return {
    edges: Object.freeze(ordered),
    endCursor: boundedString(pageInfo.end_cursor, "Marketplace feed page_info.end_cursor", 4_096),
    hasNextPage: pageInfo.has_next_page,
    root: selectedRoot,
  };
}

function projectFacebookMarketplaceFeed(
  stream: ReturnType<typeof marketplaceFeedStream>,
  limit: number,
): FacebookMarketplaceFeed {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Marketplace feed limit must be an integer between 1 and 50");
  }
  const allListings: Readonly<Record<string, unknown>>[] = [];
  const seen = new Set<string>();
  let sponsoredUnits = 0;
  for (const { index, edge } of stream.edges) {
    boundedString(edge.cursor, `Marketplace feed edge[${index}].cursor`, 4_096);
    const node = record(edge.node, `Marketplace feed edge[${index}].node`);
    let candidates: readonly unknown[];
    if (node.__typename === "MarketplaceFeedTopPicksUnit") {
      if (!Array.isArray(node.marketplace_listings) || node.marketplace_listings.length > 100) {
        throw new Error(`Marketplace feed edge[${index}] top picks must be a bounded array`);
      }
      candidates = node.marketplace_listings;
    } else if (node.__typename === "MarketplaceFeedAdStory") {
      sponsoredUnits += 1;
      continue;
    } else {
      candidates = [node];
    }
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const listing = marketplaceFeedListing(
        candidate,
        `Marketplace feed edge[${index}] listing[${candidateIndex}]`,
      );
      const id = listing.id;
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      allListings.push(listing);
    }
  }
  if (allListings.length === 0) throw new Error("Marketplace feed contained no reviewed listings");
  const truncated = allListings.length > limit;
  const continuationSupported = !truncated;
  return Object.freeze({
    feed: "marketplace",
    listings: Object.freeze(allListings.slice(0, limit)),
    sponsored_units: sponsoredUnits,
    provider_has_next_page: stream.hasNextPage,
    next_cursor: stream.hasNextPage && continuationSupported ? stream.endCursor : null,
    continuation_supported: continuationSupported,
    truncated,
    complete: !stream.hasNextPage && !truncated,
  });
}

export function normalizeFacebookMarketplaceFeedHtml(
  html: unknown,
  viewerId: string,
  limit: number,
): FacebookMarketplaceFeed {
  const roots = parseMetaJsonScripts(html);
  if (parseFacebookViewerId(html) !== viewerId) {
    throw new Error("Marketplace feed response changed its bound viewer");
  }
  assertMetaCometReadActor(roots, viewerId);
  return projectFacebookMarketplaceFeed(marketplaceFeedStream(roots, "html"), limit);
}

export function normalizeFacebookMarketplaceFeedDocuments(
  text: unknown,
  previousCursor: string,
  limit: number,
): FacebookMarketplaceFeed {
  return normalizeFacebookMarketplaceFeedJsonDocuments(
    parseMetaJsonDocuments(text),
    previousCursor,
    limit,
  );
}

export function normalizeFacebookMarketplaceFeedJsonDocuments(
  documents: readonly unknown[],
  previousCursor: string,
  limit: number,
  expectedRoot?: unknown,
): FacebookMarketplaceFeed {
  for (const [index, value] of documents.entries()) {
    const document = record(value, `Marketplace streamed document[${index}]`);
    if (!Object.hasOwn(document, "errors")) continue;
    if (!Array.isArray(document.errors)) {
      throw new Error(`Marketplace streamed document[${index}].errors must be an array`);
    }
    if (document.errors.length > 0) {
      throw new Error("Marketplace streamed response contained provider errors");
    }
  }
  const stream = marketplaceFeedStream(documents, "documents");
  if (expectedRoot !== undefined && stream.root !== expectedRoot) {
    throw new Error("Marketplace streamed response changed its descriptor-bound root");
  }
  const prior = boundedString(previousCursor, "Marketplace previous cursor", 4_096);
  if (stream.endCursor === prior) {
    throw new Error("Marketplace continuation repeated its prior cursor");
  }
  return projectFacebookMarketplaceFeed(stream, limit);
}

function marketplaceListingPhoto(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  const photo = record(value, label);
  const image = record(photo.image, `${label}.image`);
  return Object.freeze({
    id: exactDecimalId(photo.id, `${label}.id`),
    url: optionalHttpsUrl(image.uri, `${label}.image.uri`),
    width: optionalInteger(image.width, `${label}.image.width`),
    height: optionalInteger(image.height, `${label}.image.height`),
    accessibility_caption: optionalString(
      photo.accessibility_caption,
      `${label}.accessibility_caption`,
      1_024,
    ),
  });
}

export function normalizeFacebookMarketplaceListingHtml(
  html: unknown,
  viewerId: string,
  listingId: string,
): unknown {
  const expectedListingId = exactDecimalId(listingId, "Marketplace requested listing ID");
  const roots = parseMetaJsonScripts(html);
  if (parseFacebookViewerId(html) !== viewerId) {
    throw new Error("Marketplace listing response changed its bound viewer");
  }
  assertMetaCometReadActor(roots, viewerId);
  const detailCandidates: JsonRecord[] = [];
  const mediaCandidates: JsonRecord[] = [];
  walk(roots, (value, path) => {
    if (!isRecord(value)) return;
    if (
      path.length === 0
      || isReviewedFacebookMarketplaceListingResultEnvelope(
        roots,
        path,
        value,
      )
    ) {
      assertEmptyProviderErrors(value, "Marketplace listing envelope");
    }
    const viewer = isRecord(value.viewer) ? value.viewer : null;
    const detailsPage = viewer !== null
      && isRecord(viewer.marketplace_product_details_page)
      ? viewer.marketplace_product_details_page
      : null;
    const reviewedDetailDataRoot =
      isReviewedFacebookMarketplaceListingDetailDataEnvelope(
        roots,
        path,
        value,
      );
    const reviewedMediaDataRoot =
      isReviewedFacebookMarketplaceListingMediaDataEnvelope(
        roots,
        path,
        value,
      );
    const reviewedDataRoot = reviewedDetailDataRoot || reviewedMediaDataRoot;
    const directTarget = reviewedDataRoot && isRecord(value.target)
      ? value.target
      : null;
    if (detailsPage === null && directTarget === null) return;
    if (!reviewedDataRoot) {
      throw new Error(
        "Marketplace product-details root appeared outside its reviewed Relay data root",
      );
    }
    if (detailsPage !== null && directTarget !== null) {
      throw new Error("Marketplace product-details response matched multiple reviewed root variants");
    }
    const target = directTarget ?? record(
      detailsPage?.target,
      "Marketplace product-details target",
    );
    if (
      target.__typename !== "GroupCommerceProductItem"
      || target.id !== expectedListingId
    ) {
      throw new Error("Marketplace product-details root changed its requested listing target");
    }
    const hasDetailProjection = (
      typeof target.marketplace_listing_title === "string"
      && isRecord(target.listing_price)
      && isRecord(target.redacted_description)
    );
    const hasMediaProjection = Array.isArray(target.listing_photos);
    if (
      hasDetailProjection
      && !reviewedDetailDataRoot
    ) {
      throw new Error(
        "Marketplace listing detail came from an unreviewed preloader",
      );
    }
    if (
      hasMediaProjection
      && !reviewedMediaDataRoot
    ) {
      throw new Error(
        "Marketplace listing media came from an unreviewed preloader",
      );
    }
    if (hasDetailProjection) detailCandidates.push(target);
    if (hasMediaProjection) mediaCandidates.push(target);
  });
  if (detailCandidates.length !== 1 || mediaCandidates.length !== 1) {
    throw new Error("Marketplace listing response did not bind one exact detailed listing");
  }
  const detail = detailCandidates[0];
  const media = mediaCandidates[0];
  if (detail === undefined || media === undefined) {
    throw new Error("Marketplace listing response omitted its reviewed target");
  }
  const primary = record(detail.primary_mp_ent, "Marketplace listing primary entity");
  if (exactDecimalId(primary.id, "Marketplace listing primary entity.id") !== expectedListingId) {
    throw new Error("Marketplace listing primary entity changed its requested target");
  }
  const price = record(detail.listing_price, "Marketplace listing price");
  const description = record(detail.redacted_description, "Marketplace listing description");
  const locationText = record(detail.location_text, "Marketplace listing location text");
  const seller = record(detail.marketplace_listing_seller, "Marketplace listing seller");
  const sellerId = exactDecimalId(seller.id, "Marketplace listing seller.id");
  if (seller.user_id !== undefined && seller.user_id !== sellerId) {
    throw new Error("Marketplace listing seller identity was ambiguous");
  }
  if (!Array.isArray(media.listing_photos) || media.listing_photos.length > 100) {
    throw new Error("Marketplace listing photos must be a bounded array");
  }
  if (
    media.pre_recorded_videos !== undefined
    && (
      !Array.isArray(media.pre_recorded_videos)
      || media.pre_recorded_videos.length > 100
    )
  ) {
    throw new Error("Marketplace listing videos must be a bounded array");
  }
  const photos = media.listing_photos.map((photo, index) =>
    marketplaceListingPhoto(photo, `Marketplace listing photo[${index}]`));
  return Object.freeze({
    id: expectedListingId,
    title: boundedString(detail.marketplace_listing_title, "Marketplace listing title", 512),
    description: boundedString(description.text, "Marketplace listing description.text", 100_000, true),
    price: Object.freeze({
      amount: boundedString(price.amount, "Marketplace listing price.amount", 64),
      currency: optionalString(price.currency, "Marketplace listing price.currency", 16),
      formatted: optionalString(
        price.formatted_amount_zeros_stripped,
        "Marketplace listing price.formatted_amount_zeros_stripped",
        128,
      ),
    }),
    location: optionalString(locationText.text, "Marketplace listing location_text.text", 512),
    creation_time: optionalInteger(detail.creation_time, "Marketplace listing creation_time"),
    is_live: optionalBoolean(detail.is_live, "Marketplace listing is_live"),
    is_pending: optionalBoolean(detail.is_pending, "Marketplace listing is_pending"),
    is_sold: optionalBoolean(detail.is_sold, "Marketplace listing is_sold"),
    is_viewer_seller: optionalBoolean(detail.is_viewer_seller, "Marketplace listing is_viewer_seller"),
    seller: Object.freeze({
      id: sellerId,
      name: optionalString(seller.name, "Marketplace listing seller.name", 512),
    }),
    photos: Object.freeze(photos),
    video_count: Array.isArray(media.pre_recorded_videos)
      ? media.pre_recorded_videos.length
      : 0,
  });
}

export function normalizeFacebookInboxHtml(html: unknown, viewerId: string, limit: number): unknown {
  const roots = parseMetaJsonScripts(html);
  if (parseFacebookViewerId(html) !== viewerId) throw new Error("Facebook inbox response changed its bound viewer");
  const candidates: JsonRecord[] = [];
  walk(roots, (value) => {
    if (!isRecord(value)) return;
    const viewer = isRecord(value.viewer) ? value.viewer : null;
    const threads = viewer !== null && isRecord(viewer.message_threads) ? viewer.message_threads : null;
    if (threads !== null) candidates.push(threads);
  });
  if (candidates.length !== 1 || !Array.isArray(candidates[0]?.edges) || (candidates[0]?.edges as unknown[]).length > 1_000) {
    throw new Error("Facebook Relay preload did not contain exactly one bounded message-thread summary list");
  }
  const edges = candidates[0]?.edges as unknown[];
  const threads = edges.slice(0, limit).map((edgeValue, index) => {
    const edge = record(edgeValue, `Facebook message thread edge[${index}]`);
    const node = record(edge.node, `Facebook message thread node[${index}]`);
    const threadKey = record(node.thread_key, `Facebook message thread[${index}].thread_key`);
    const participantsContainer = record(node.all_participants, `Facebook message thread[${index}].all_participants`);
    if (!Array.isArray(participantsContainer.edges) || participantsContainer.edges.length > 100) {
      throw new Error(`Facebook message thread[${index}] participants must be bounded`);
    }
    const participants = participantsContainer.edges.map((participantEdge, participantIndex) => {
      const participantNode = record(
        record(participantEdge, `Facebook participant edge[${participantIndex}]`).node,
        `Facebook participant node[${participantIndex}]`,
      );
      const actor = record(participantNode.messaging_actor, `Facebook participant actor[${participantIndex}]`);
      return Object.freeze({
        id: boundedString(actor.id, `Facebook participant actor[${participantIndex}].id`, 64),
        name: optionalString(actor.name, `Facebook participant actor[${participantIndex}].name`, 512),
      });
    });
    return Object.freeze({
      thread_id: boundedString(
        threadKey.thread_fbid ?? threadKey.other_user_id ?? node.id,
        `Facebook message thread[${index}].thread_id`,
        256,
      ),
      name: optionalString(node.name, `Facebook message thread[${index}].name`, 512),
      updated_time: optionalInteger(node.updated_time, `Facebook message thread[${index}].updated_time`),
      participants: Object.freeze(participants),
    });
  });
  return Object.freeze({ folder: "inbox", threads: Object.freeze(threads) });
}

export const metaWebEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "revision-evidence-only" as const,
  observedOn: "2026-07-23",
  authentication: "browser-cookie-session" as const,
  operations: Object.freeze({
    instagram: Object.freeze({
      viewer: "GET / HTML PolarisViewer, corroborated by ds_user_id",
      feed: "GET /api/v1/feed/timeline/ first page without cursor continuation",
      post: "GET /api/v1/media/{id}/info/",
      comments: "GET /api/v1/media/{id}/comments/ first page without cursor continuation",
      inbox: "GET /api/v1/direct_v2/inbox/ first page without cursor continuation or seen/ack dispatch",
    }),
    threads: Object.freeze({
      viewer: "GET / HTML BarcelonaSessionInfo plus Relay viewer.user.id",
      feed: "GET / signed-in first-page Relay feedData preload without cursor continuation",
      publish: "POST configure_text_post_app_feed with exact actor/text response binding after optional PNG rupload; when an image is supplied, require synchronous 200 upload completion and completed-upload dimensions; then GET the exact returned permalink for independent actor/text and optional image readback",
    }),
    facebook: Object.freeze({
      viewer: "GET / HTML CurrentUserInitialData, corroborated by c_user",
      feed: "GET / signed-in Comet Relay viewer.news_feed preload",
    }),
    "facebook-marketplace": Object.freeze({
      feed: "GET /marketplace/ signed-in Relay bootstrap without script execution",
      listing: "GET /marketplace/item/{id}/ signed-in product-details bootstrap without item-seen dispatch",
    }),
    "facebook-group": Object.freeze({
      feed: "GET /groups/{id}/ signed-in first-page Relay bootstrap without script execution or cursor continuation",
    }),
  }),
});
