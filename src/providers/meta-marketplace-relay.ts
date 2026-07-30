import {
  META_RELAY_ORIGINS,
  assertMetaPaginationCursorBinding,
  bindMetaAccessContext,
  bindMetaPaginationCursor,
  buildMetaRelayRequest,
  defineMetaOperationDescriptor,
  metaOperationDescriptorKey,
  type MetaAccessContext,
  type MetaBootstrapProofDeclaration,
  type MetaPaginationCursor,
  type MetaRelayRequest,
  type MetaVariableField,
  type MetaVariableSchema,
} from "./meta-web-descriptors";
import { canonicalJson, sha256 } from "../canonical-json";
import { parseFacebookViewerId, parseMetaJsonScripts } from "./meta-web";

const FRIENDLY_NAME = "MarketplaceCometBrowseFeedLightPaginationQuery";
const REVIEWED_PAGINATION_DOC_ID = "27448592924790037";
const REVIEWED_CONTAINER_DOC_ID = "28097605446510041";
const TARGET_ID = "marketplace_home_feed";
const MAX_TREE_NODES = 250_000;
const MAX_TREE_DEPTH = 40;
const MAX_CURSOR_HISTORY = 48;

const SHIPPING_ICON =
  "__relay_internal__pv__CometMarketplaceShouldShowFeedShippingIconrelayprovider";
const TOP_PICKS_STRIKETHROUGH =
  "__relay_internal__pv__CometMarketplaceShouldShowTopPicksStrikethroughrelayprovider";
const SPONSORED_FIELD_NAME =
  "__relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider";
const AD_MODULE =
  "__relay_internal__pv__MarketplaceCometAdmodulerelayprovider";

const PRELOADER_VARIABLE_FIELDS = Object.freeze([
  SHIPPING_ICON,
  TOP_PICKS_STRIKETHROUGH,
  SPONSORED_FIELD_NAME,
  AD_MODULE,
  "buyLocation",
  "count",
  "cursor",
  "imageWidth",
  "mediaType",
  "radius",
  "scale",
  "sizing",
  "useSDFPath",
] as const);

type PaginationInputField = Exclude<
  (typeof PRELOADER_VARIABLE_FIELDS)[number],
  "count" | "cursor"
>;

type JsonRecord = Record<string, unknown>;

export type FacebookMarketplacePaginationCursor = {
  readonly schemaVersion: 1;
  readonly inputHash: string;
  readonly descriptorKey: string;
  readonly actorId: string;
  readonly targetId: string;
  readonly cursor: string;
  readonly cursorHistory: readonly string[];
};

const marketplacePaginationBindings =
  new WeakMap<object, MetaPaginationCursor>();

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

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const observed = Object.keys(value);
  const expected = new Set(keys);
  if (
    observed.length !== expected.size
    || observed.some((key) => !expected.has(key))
  ) throw new Error(`${label} changed its reviewed fields`);
}

function boundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) throw new Error(`${label} must be a bounded integer`);
  return value as number;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) throw new Error(`${label} must be a bounded finite number`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function isReviewedCometPlatformPreloaderPath(
  roots: readonly unknown[],
  path: readonly (string | number)[],
  candidate: JsonRecord,
): boolean {
  if (
    path.length !== 12
    || typeof path[0] !== "number"
    || path[1] !== "require"
    || typeof path[2] !== "number"
    || path[3] !== 3
    || typeof path[4] !== "number"
    || path[5] !== "__bbox"
    || path[6] !== "require"
    || typeof path[7] !== "number"
    || path[8] !== 3
    || path[9] !== 0
    || path[10] !== "expectedPreloaders"
    || typeof path[11] !== "number"
  ) return false;
  const root = roots[path[0]];
  if (!isRecord(root) || !isUnknownArray(root.require)) return false;
  const scheduled = root.require[path[2]];
  if (
    !isUnknownArray(scheduled)
    || scheduled.length !== 4
    || scheduled[0] !== "ScheduledServerJS"
    || scheduled[1] !== "handle"
    || scheduled[2] !== null
    || !isUnknownArray(scheduled[3])
  ) return false;
  const scheduledPayload = scheduled[3][path[4]];
  if (
    !isRecord(scheduledPayload)
    || !isRecord(scheduledPayload.__bbox)
    || !isUnknownArray(scheduledPayload.__bbox.require)
  ) return false;
  const platformRoot = scheduledPayload.__bbox.require[path[7]];
  if (
    !isUnknownArray(platformRoot)
    || platformRoot.length !== 4
    || platformRoot[0] !== "CometPlatformRootClient"
    || platformRoot[1] !== "initialize"
    || !isUnknownArray(platformRoot[2])
    || platformRoot[2].length !== 2
    || platformRoot[2][0] !== "CometFBLoggedInRootConfig"
    || platformRoot[2][1] !== "RequireDeferredReference"
    || !isUnknownArray(platformRoot[3])
    || platformRoot[3].length !== 1
  ) return false;
  const configuration = platformRoot[3][0];
  return (
    isRecord(configuration)
    && isUnknownArray(configuration.expectedPreloaders)
    && configuration.expectedPreloaders[path[11]] === candidate
  );
}

function inputVariable(
  name: string,
  schema: MetaVariableSchema,
): MetaVariableField {
  return Object.freeze({
    name,
    optional: false,
    source: Object.freeze({ kind: "input", key: name }),
    schema: Object.freeze(schema),
  });
}

const ALL_PROOFS: readonly MetaBootstrapProofDeclaration[] = Object.freeze([
  Object.freeze({
    kind: "viewer",
    source: "bootstrap.viewer",
    sinks: Object.freeze(["access.viewer-id", "form.__user"] as const),
  }),
  Object.freeze({
    kind: "actor",
    source: "bootstrap.actor",
    sinks: Object.freeze(["access.actor-id", "form.av"] as const),
  }),
  Object.freeze({
    kind: "fb_dtsg",
    source: "bootstrap.fb_dtsg",
    sinks: Object.freeze(["form.fb_dtsg"] as const),
  }),
  Object.freeze({
    kind: "jazoest",
    source: "derived.fb_dtsg-jazoest",
    sinks: Object.freeze(["form.jazoest"] as const),
  }),
  Object.freeze({
    kind: "lsd",
    source: "bootstrap.lsd",
    sinks: Object.freeze(["form.lsd"] as const),
  }),
  Object.freeze({
    kind: "client-revision",
    source: "bootstrap.client-revision",
    sinks: Object.freeze(["form.__rev"] as const),
  }),
  Object.freeze({
    kind: "hsi",
    source: "bootstrap.hsi",
    sinks: Object.freeze(["form.__hsi"] as const),
  }),
  Object.freeze({
    kind: "comet-environment",
    source: "bootstrap.comet-environment",
    sinks: Object.freeze(["form.__comet_req"] as const),
  }),
  Object.freeze({
    kind: "request-counter",
    source: "session.request-counter",
    sinks: Object.freeze(["form.__req"] as const),
  }),
] as const);

const BOOLEAN_SCHEMA = Object.freeze({ kind: "boolean" } as const);

export const FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR =
  defineMetaOperationDescriptor(Object.freeze({
    schemaVersion: 1,
    id: "facebook-marketplace.feeds-read-pagination",
    platform: "facebook",
    kind: "query",
    operationType: "query",
    friendlyName: FRIENDLY_NAME,
    docId: REVIEWED_PAGINATION_DOC_ID,
    origin: META_RELAY_ORIGINS.facebook,
    method: "POST",
    path: "/api/graphql/",
    contract: Object.freeze({
      state: "observed",
      contractVersion: 1,
      evidenceId: "facebook-marketplace-pagination-2026-07-23",
    }),
    access: Object.freeze({ kind: "marketplace", actorBinding: "viewer" }),
    proofs: ALL_PROOFS,
    variables: Object.freeze({
      fields: Object.freeze([
        inputVariable(SHIPPING_ICON, BOOLEAN_SCHEMA),
        inputVariable(TOP_PICKS_STRIKETHROUGH, BOOLEAN_SCHEMA),
        inputVariable(SPONSORED_FIELD_NAME, BOOLEAN_SCHEMA),
        inputVariable(AD_MODULE, BOOLEAN_SCHEMA),
        inputVariable("buyLocation", Object.freeze({
          kind: "object",
          fields: Object.freeze([
            Object.freeze({
              name: "latitude",
              optional: false,
              schema: Object.freeze({ kind: "number", minimum: -90, maximum: 90 }),
            }),
            Object.freeze({
              name: "longitude",
              optional: false,
              schema: Object.freeze({ kind: "number", minimum: -180, maximum: 180 }),
            }),
          ]),
        })),
        Object.freeze({
          name: "count",
          optional: false,
          source: Object.freeze({ kind: "literal", value: 5 }),
          schema: Object.freeze({ kind: "literal", value: 5 }),
        }),
        Object.freeze({
          name: "cursor",
          optional: true,
          source: Object.freeze({ kind: "pagination" }),
          schema: Object.freeze({ kind: "cursor" }),
        }),
        inputVariable("imageWidth", Object.freeze({
          kind: "integer",
          minimum: 1,
          maximum: 4_096,
        })),
        Object.freeze({
          name: "includePDPRelevantListings",
          optional: false,
          source: Object.freeze({ kind: "literal", value: false }),
          schema: Object.freeze({ kind: "literal", value: false }),
        }),
        inputVariable("mediaType", Object.freeze({
          kind: "enum",
          values: Object.freeze(["image/jpeg"]),
        })),
        Object.freeze({
          name: "pdpListingId",
          optional: false,
          source: Object.freeze({ kind: "literal", value: "" }),
          schema: Object.freeze({ kind: "literal", value: "" }),
        }),
        inputVariable("radius", Object.freeze({
          kind: "integer",
          minimum: 1,
          maximum: 10_000_000,
        })),
        Object.freeze({
          name: "refinement",
          optional: false,
          source: Object.freeze({ kind: "literal", value: null }),
          schema: Object.freeze({ kind: "literal", value: null }),
        }),
        inputVariable("scale", Object.freeze({
          kind: "integer",
          minimum: 1,
          maximum: 4,
        })),
        inputVariable("sizing", Object.freeze({
          kind: "enum",
          values: Object.freeze(["cover-fill-cropped"]),
        })),
        inputVariable("useSDFPath", BOOLEAN_SCHEMA),
      ]),
    }),
    pagination: Object.freeze({ kind: "cursor", variableName: "cursor" }),
    responseRoots: Object.freeze([
      Object.freeze({
        kind: "query-data",
        path: Object.freeze(["data", "marketplace_home_feed"]),
      }),
    ]),
  }));

function candidatePreloaders(roots: readonly unknown[]): readonly JsonRecord[] {
  const candidates: JsonRecord[] = [];
  for (const [index, value] of roots.entries()) {
    if (!isRecord(value)) continue;
    const root = value;
    if (!Object.hasOwn(root, "errors")) continue;
    if (!Array.isArray(root.errors)) {
      throw new Error(`Marketplace Relay root[${index}].errors must be an array`);
    }
    if (root.errors.length > 0) {
      throw new Error("Marketplace Relay preloader contained provider errors");
    }
  }
  const seen = new WeakSet<object>();
  const stack: {
    readonly value: unknown;
    readonly path: readonly (string | number)[];
    readonly depth: number;
  }[] = roots.map((value, index) => ({
    value,
    path: Object.freeze([index]),
    depth: 0,
  }));
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_TREE_NODES || current.depth > MAX_TREE_DEPTH) {
      throw new Error("Marketplace Relay preloader exceeded its reviewed structural bound");
    }
    const value = current.value;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      continue;
    }
    if (typeof value !== "object" || seen.has(value)) {
      throw new Error("Marketplace Relay preloader was not plain acyclic JSON");
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 10_000) throw new Error("Marketplace Relay preloader array exceeded its reviewed bound");
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: value[index],
          path: Object.freeze([...current.path, index]),
          depth: current.depth + 1,
        });
      }
      continue;
    }
    const source = record(value, "Marketplace Relay preloader object");
    if (source.queryName === "MarketplaceCometBrowseFeedLightContainerQuery") {
      if (
        !isReviewedCometPlatformPreloaderPath(
          roots,
          current.path,
          source,
        )
      ) {
        throw new Error("Marketplace Relay preloader appeared outside its reviewed root");
      }
      candidates.push(source);
    }
    const entries = Object.entries(source);
    if (entries.length > 10_000) throw new Error("Marketplace Relay preloader object exceeded its reviewed bound");
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      stack.push({
        value: entry[1],
        path: Object.freeze([...current.path, entry[0]]),
        depth: current.depth + 1,
      });
    }
  }
  return Object.freeze(candidates);
}

export function extractFacebookMarketplacePaginationInput(
  html: unknown,
  expectedViewerId: string,
): Readonly<Record<string, unknown>> {
  if (parseFacebookViewerId(html) !== expectedViewerId) {
    throw new Error("Marketplace Relay preloader changed its bound viewer");
  }
  const candidates = candidatePreloaders(parseMetaJsonScripts(html));
  if (candidates.length !== 1) {
    throw new Error("Marketplace Relay preloader was missing or ambiguous");
  }
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error("Marketplace Relay preloader was missing");
  exactKeys(
    candidate,
    ["actorID", "preloaderID", "queryID", "queryName", "variables"],
    "Marketplace Relay preloader",
  );
  if (candidate.actorID !== expectedViewerId) {
    throw new Error("Marketplace Relay preloader actor changed its bound viewer");
  }
  // This loader-local label is not a Relay variable or request parameter. Its
  // only role here is to prove the exact observed preloader record shape.
  boundedString(candidate.preloaderID, "Marketplace Relay preloader ID", 1, 512);
  if (
    typeof candidate.queryID !== "string"
    || !/^[1-9][0-9]{9,23}$/u.test(candidate.queryID)
  ) throw new Error("Marketplace Relay preloader query ID was malformed");
  if (candidate.queryID !== REVIEWED_CONTAINER_DOC_ID) {
    throw new Error("Marketplace Relay preloader query ID drifted from reviewed evidence");
  }
  if (candidate.queryName !== "MarketplaceCometBrowseFeedLightContainerQuery") {
    throw new Error("Marketplace Relay preloader query name drifted");
  }
  const variables = record(candidate.variables, "Marketplace Relay preloader variables");
  exactKeys(variables, PRELOADER_VARIABLE_FIELDS, "Marketplace Relay preloader variables");
  boundedInteger(variables.count, "Marketplace Relay preloader count", 1, 100);
  if (variables.cursor !== null) {
    throw new Error("Marketplace Relay initial preloader unexpectedly contained a cursor");
  }
  const location = record(variables.buyLocation, "Marketplace Relay buy location");
  exactKeys(location, ["latitude", "longitude"], "Marketplace Relay buy location");

  return Object.freeze({
    [SHIPPING_ICON]: boolean(variables[SHIPPING_ICON], `Marketplace Relay ${SHIPPING_ICON}`),
    [TOP_PICKS_STRIKETHROUGH]: boolean(
      variables[TOP_PICKS_STRIKETHROUGH],
      `Marketplace Relay ${TOP_PICKS_STRIKETHROUGH}`,
    ),
    [SPONSORED_FIELD_NAME]: boolean(
      variables[SPONSORED_FIELD_NAME],
      `Marketplace Relay ${SPONSORED_FIELD_NAME}`,
    ),
    [AD_MODULE]: boolean(variables[AD_MODULE], `Marketplace Relay ${AD_MODULE}`),
    buyLocation: Object.freeze({
      latitude: boundedNumber(location.latitude, "Marketplace Relay latitude", -90, 90),
      longitude: boundedNumber(location.longitude, "Marketplace Relay longitude", -180, 180),
    }),
    imageWidth: boundedInteger(variables.imageWidth, "Marketplace Relay image width", 1, 4_096),
    mediaType: boundedString(variables.mediaType, "Marketplace Relay media type", 1, 64),
    radius: boundedInteger(variables.radius, "Marketplace Relay radius", 1, 10_000_000),
    scale: boundedInteger(variables.scale, "Marketplace Relay scale", 1, 4),
    sizing: boundedString(variables.sizing, "Marketplace Relay sizing", 1, 64),
    useSDFPath: boolean(variables.useSDFPath, "Marketplace Relay SDF path flag"),
  } satisfies Readonly<Record<PaginationInputField, unknown>>);
}

function facebookMarketplaceAccess(viewerId: string): MetaAccessContext {
  return bindMetaAccessContext(
    FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
    Object.freeze({
      kind: "marketplace",
      platform: "facebook",
      viewerId,
      actorId: viewerId,
      targetId: TARGET_ID,
    } satisfies MetaAccessContext),
  );
}

function marketplacePaginationInputHash(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{64}$/u.test(value)
  ) {
    throw new Error("Marketplace pagination input hash was malformed");
  }
  return value;
}

function marketplaceProviderCursor(value: unknown, label: string): string {
  const cursor = boundedString(value, label, 1, 4_096);
  if (!/^[\x20-\x7e]+$/u.test(cursor)) {
    throw new Error(`${label} must use the reviewed printable-ASCII cursor alphabet`);
  }
  return cursor;
}

function marketplaceCursorHash(cursor: string): string {
  return Buffer.from(sha256(cursor), "hex")
    .subarray(0, 16)
    .toString("base64url");
}

function marketplaceCursorHistory(
  value: unknown,
  cursor: string,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_CURSOR_HISTORY
    || value.some((item) =>
      typeof item !== "string"
      || !/^[A-Za-z0-9_-]{22}$/u.test(item))
  ) {
    throw new Error("Marketplace sealed cursor history was malformed");
  }
  const history = value as readonly string[];
  if (
    new Set(history).size !== history.length
    || history.at(-1) !== marketplaceCursorHash(cursor)
  ) {
    throw new Error("Marketplace sealed cursor history changed its chain");
  }
  return Object.freeze([...history]);
}

function reviewedMarketplacePaginationInputHash(
  input: Readonly<Record<string, unknown>>,
): string {
  if (input.mediaType !== "image/jpeg") {
    throw new Error("Marketplace Relay media type drifted from reviewed evidence");
  }
  if (input.sizing !== "cover-fill-cropped") {
    throw new Error("Marketplace Relay sizing drifted from reviewed evidence");
  }
  return sha256(canonicalJson(input));
}

export function facebookMarketplacePaginationInputHash(
  html: unknown,
  viewerId: string,
): string {
  return reviewedMarketplacePaginationInputHash(
    extractFacebookMarketplacePaginationInput(html, viewerId),
  );
}

export function bindFacebookMarketplacePaginationCursor(
  viewerId: string,
  cursor: string,
  inputHashValue: string,
  previous: FacebookMarketplacePaginationCursor | null = null,
): FacebookMarketplacePaginationCursor {
  const access = facebookMarketplaceAccess(viewerId);
  const inputHash = marketplacePaginationInputHash(inputHashValue);
  const providerCursor = marketplaceProviderCursor(
    cursor,
    "Marketplace provider cursor",
  );
  if (previous !== null) {
    if (
      !marketplacePaginationBindings.has(previous)
      || previous.inputHash !== inputHash
    ) {
      throw new Error("Marketplace pagination cursor changed its feed input context");
    }
    if (previous.cursorHistory.length >= MAX_CURSOR_HISTORY) {
      throw new Error("Marketplace pagination cursor reached its reviewed chain bound");
    }
    if (previous.cursorHistory.includes(marketplaceCursorHash(providerCursor))) {
      throw new Error("Marketplace pagination cursor repeated an earlier page");
    }
  }
  const previousBinding = previous === null
    ? null
    : marketplacePaginationBindings.get(previous);
  if (previous !== null && previousBinding === undefined) {
    throw new Error("Marketplace pagination cursor was not issued by its feed binding policy");
  }
  const binding = bindMetaPaginationCursor(
    FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
    access,
    providerCursor,
    previousBinding ?? null,
  );
  const result: FacebookMarketplacePaginationCursor = Object.freeze({
    schemaVersion: 1,
    inputHash,
    descriptorKey: binding.descriptorKey,
    actorId: binding.actorId,
    targetId: binding.targetId,
    cursor: binding.cursor,
    cursorHistory: Object.freeze([
      ...(previous?.cursorHistory ?? []),
      marketplaceCursorHash(binding.cursor),
    ]),
  });
  marketplacePaginationBindings.set(result, binding);
  return result;
}

export function reconstructFacebookMarketplacePaginationCursor(
  viewerId: string,
  value: unknown,
): FacebookMarketplacePaginationCursor {
  const candidate = record(value, "Marketplace sealed pagination payload");
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "inputHash",
      "descriptorKey",
      "actorId",
      "targetId",
      "cursor",
      "cursorHistory",
    ],
    "Marketplace sealed pagination payload",
  );
  if (candidate.schemaVersion !== 1) {
    throw new Error("Marketplace sealed pagination payload changed its schema");
  }
  const inputHash = marketplacePaginationInputHash(candidate.inputHash);
  if (
    candidate.descriptorKey !== metaOperationDescriptorKey(
      FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
    )
    || candidate.actorId !== viewerId
    || candidate.targetId !== TARGET_ID
  ) {
    throw new Error("Marketplace sealed pagination payload changed its bound coordinates");
  }
  const cursor = marketplaceProviderCursor(
    candidate.cursor,
    "Marketplace sealed cursor",
  );
  const cursorHistory = marketplaceCursorHistory(
    candidate.cursorHistory,
    cursor,
  );
  const binding = bindMetaPaginationCursor(
    FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
    facebookMarketplaceAccess(viewerId),
    cursor,
  );
  const current: FacebookMarketplacePaginationCursor = Object.freeze({
    schemaVersion: 1,
    inputHash,
    descriptorKey: binding.descriptorKey,
    actorId: binding.actorId,
    targetId: binding.targetId,
    cursor: binding.cursor,
    cursorHistory,
  });
  if (
    current.descriptorKey !== candidate.descriptorKey
    || current.actorId !== candidate.actorId
    || current.targetId !== candidate.targetId
  ) {
    throw new Error("Marketplace sealed pagination payload failed reconstruction");
  }
  marketplacePaginationBindings.set(current, binding);
  return current;
}

export function facebookMarketplacePaginationCursorExhausted(
  value: FacebookMarketplacePaginationCursor,
): boolean {
  if (!marketplacePaginationBindings.has(value)) {
    throw new Error("Marketplace pagination cursor was not issued by its feed binding policy");
  }
  return value.cursorHistory.length >= MAX_CURSOR_HISTORY;
}

export function buildFacebookMarketplacePaginationRequest(
  html: unknown,
  viewerId: string,
  paginationValue: FacebookMarketplacePaginationCursor,
): MetaRelayRequest {
  const access = facebookMarketplaceAccess(viewerId);
  const boundPagination = marketplacePaginationBindings.get(paginationValue);
  if (boundPagination === undefined) {
    throw new Error("Marketplace pagination cursor was not issued by its feed binding policy");
  }
  const input = extractFacebookMarketplacePaginationInput(html, viewerId);
  const currentInputHash = reviewedMarketplacePaginationInputHash(input);
  if (paginationValue.inputHash !== currentInputHash) {
    throw new Error("Marketplace pagination cursor changed its feed input context");
  }
  const pagination = assertMetaPaginationCursorBinding(
    FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
    access,
    boundPagination,
  );
  return buildMetaRelayRequest(FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR, {
    input,
    access,
    pagination,
  });
}
