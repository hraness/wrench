import { types as nodeTypes } from "node:util";

type JsonRecord = Record<string, unknown>;

type SnapshotJson = null | boolean | number | string | SnapshotJsonArray | SnapshotJsonObject;

interface SnapshotJsonArray extends ReadonlyArray<SnapshotJson> {}

interface SnapshotJsonObject {
  readonly [key: string]: SnapshotJson;
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_BYTES = 1_048_576;
const MAX_JSON_KEY_BYTES = 256;
const MAX_JSON_STRING_BYTES = 131_072;

const COMMON_QUERY_KEYS = Object.freeze([
  "aid",
  "app_language",
  "app_name",
  "browser_language",
  "browser_name",
  "browser_platform",
  "browser_version",
  "channel",
  "device_id",
  "device_platform",
  "locale",
  "msToken",
  "os",
  "priority_region",
  "region",
  "screen_height",
  "screen_width",
  "tz_name",
] as const);

const NORMAL_ITEM_KEYS = Object.freeze([
  "comment_count",
  "cover_url",
  "create_time",
  "desc",
  "download_info",
  "duration",
  "favorite_count",
  "in_review",
  "is_pinned",
  "item_id",
  "item_type",
  "like_count",
  "permissions",
  "play_addr",
  "play_count",
  "post_time",
  "schedule_time",
  "share_count",
  "status",
  "vid",
  "visibility",
] as const);

const ACTION_PERMISSION_KEYS = Object.freeze([
  "can_add_to_playlist",
  "can_change_privacy",
  "can_delete",
  "can_edit",
  "can_edit_cover",
  "can_pin",
] as const);

const VISIBILITY_OPTION_KEYS = Object.freeze([
  "visibility_available_for_ads",
  "visibility_everyone",
  "visibility_followers",
  "visibility_friends",
  "visibility_only_you",
] as const);

const SORT_FIELDS = new Set([
  "comment_count",
  "like_count",
  "play_count",
  "post_time",
]);

const CONDITION_FIELDS = new Set([
  "comment_count",
  "desc",
  "like_count",
  "play_count",
  "visibility",
]);

/**
 * Secret-free structural facts retained from one authenticated, read-only
 * TikTok Studio content-list exchange. Values for cookies, signed URLs,
 * account content, device_id, msToken, log IDs, and account identifiers are
 * deliberately absent.
 */
export const tiktokStudioContentListLiveEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "live-read-only-exact-structure" as const,
  observedOn: "2026-08-24",
  origin: "https://www.tiktok.com",
  request: Object.freeze({
    method: "POST" as const,
    path: "/tiktok/creator/manage/item_list/v1/",
    commonQueryKeys: COMMON_QUERY_KEYS,
    opaqueCredentialSinkKeys: Object.freeze(["device_id", "msToken"] as const),
    bodyKeys: Object.freeze(["cursor", "query", "size"] as const),
  }),
  response: Object.freeze({
    status: 200,
    contentType: "application/json; charset=utf-8",
    envelopeKeys: Object.freeze([
      "cursor",
      "enable_query",
      "extra",
      "has_more",
      "is_limited",
      "item_list",
      "log_pb",
      "status_code",
      "status_msg",
    ] as const),
    normalItemKeys: NORMAL_ITEM_KEYS,
  }),
  binding: Object.freeze({
    presentTargetFields: Object.freeze(["item_list[].item_id", "item_list[].desc"]),
    absentFields: Object.freeze(["actor", "project_id"]),
    accountRequirement: "separate exact current-account realm probe",
    absencePolicy: "content-list nonappearance never proves a deletion tombstone",
  }),
});

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function addBytes(state: { bytes: number }, amount: number, label: string): void {
  state.bytes += amount;
  if (state.bytes > MAX_JSON_BYTES) {
    throw new Error(`${label} exceeds its JSON byte bound`);
  }
}

/** Snapshot untrusted JSON without executing accessors or retaining aliases. */
function snapshotJson(value: unknown, label: string): SnapshotJson {
  const active = new Set<object>();
  const state = { bytes: 0, nodes: 0 };

  const visit = (candidate: unknown, depth: number): SnapshotJson => {
    if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds its JSON depth bound`);
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES) throw new Error(`${label} exceeds its JSON node bound`);

    if (candidate === null) {
      addBytes(state, 4, label);
      return null;
    }
    if (typeof candidate === "boolean") {
      addBytes(state, candidate ? 4 : 5, label);
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new Error(`${label} numbers must be finite canonical JSON numbers`);
      }
      addBytes(state, String(candidate).length, label);
      return candidate;
    }
    if (typeof candidate === "string") {
      const bytes = byteLength(candidate);
      if (bytes > MAX_JSON_STRING_BYTES) {
        throw new Error(`${label} contains an oversized JSON string`);
      }
      addBytes(state, byteLength(JSON.stringify(candidate)), label);
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new Error(`${label} must contain only JSON data`);
    }
    if (nodeTypes.isProxy(candidate)) {
      throw new Error(`${label} must not contain proxies`);
    }
    if (active.has(candidate)) throw new Error(`${label} must not contain cycles`);
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const ownKeys = Reflect.ownKeys(candidate);
        if (ownKeys.some((key) => {
          if (key === "length") return false;
          if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)) return true;
          const index = Number(key);
          return !Number.isSafeInteger(index) || index < 0 || index >= candidate.length;
        })) throw new Error(`${label} arrays must not contain extra fields`);
        addBytes(state, 2 + Math.max(0, candidate.length - 1), label);
        const cloned: SnapshotJson[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (
            descriptor === undefined
            || !descriptor.enumerable
            || !("value" in descriptor)
          ) throw new Error(`${label} arrays must contain only enumerable data elements`);
          cloned.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(cloned);
      }

      const prototype: unknown = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} objects must use a plain prototype`);
      }
      const ownKeys = Reflect.ownKeys(candidate);
      if (ownKeys.some((key) => typeof key !== "string")) {
        throw new Error(`${label} objects must not contain symbol fields`);
      }
      const keys = ownKeys as string[];
      addBytes(state, 2 + Math.max(0, keys.length - 1), label);
      const cloned = Object.create(null) as Record<string, SnapshotJson>;
      for (const key of keys.sort((left, right) => left.localeCompare(right))) {
        if (byteLength(key) > MAX_JSON_KEY_BYTES) {
          throw new Error(`${label} contains an oversized property name`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !("value" in descriptor)
        ) throw new Error(`${label} objects must contain only enumerable data properties`);
        addBytes(state, byteLength(JSON.stringify(key)) + 1, label);
        cloned[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(cloned);
    } finally {
      active.delete(candidate);
    }
  };

  return visit(value, 0);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactObjectKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw new Error(`${label} changed its reviewed fields`);
}

function boundedString(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const bytes = byteLength(value);
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new Error(`${label} is outside its byte bound`);
  }
  return value;
}

function printableString(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  const text = boundedString(value, label, minimumBytes, maximumBytes);
  if (/\p{Cc}/u.test(text)) throw new Error(`${label} must not contain control characters`);
  return text;
}

function captionString(
  value: unknown,
  label: string,
  minimumBytes: number,
): string {
  const text = boundedString(value, label, minimumBytes, 16_384);
  if (text.includes("\0") || text.includes("\r")) {
    throw new Error(`${label} must not contain NUL or carriage return`);
  }
  return text;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded integer`);
  }
  return value as number;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function decimalString(value: unknown, label: string, maximumDigits = 32): string {
  const text = boundedString(value, label, 1, maximumDigits);
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    throw new Error(`${label} must be a canonical decimal string`);
  }
  return text;
}

function decimalId(value: unknown, label: string): string {
  const text = boundedString(value, label, 1, 32);
  if (!/^[1-9]\d*$/u.test(text)) throw new Error(`${label} must be a decimal identifier`);
  return text;
}

function plainCode(value: unknown, label: string, maximumBytes = 64): string {
  const text = boundedString(value, label, 1, maximumBytes);
  if (!/^[A-Za-z0-9._-]+$/u.test(text)) {
    throw new Error(`${label} must be a bounded provider code`);
  }
  return text;
}

function languageTag(value: unknown, label: string): string {
  const text = boundedString(value, label, 2, 35);
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(text)) {
    throw new Error(`${label} must be a bounded language tag`);
  }
  return text;
}

function screenDimension(value: unknown, label: string): string {
  const text = decimalString(value, label, 5);
  const numeric = Number(text);
  if (numeric < 1 || numeric > 32_768) {
    throw new Error(`${label} must be a bounded screen dimension`);
  }
  return text;
}

function runtimeTimeZone(value: unknown, label: string): string {
  const text = boundedString(value, label, 1, 128);
  if (!/^[A-Za-z0-9_+./-]+$/u.test(text) || text.includes("..")) {
    throw new Error(`${label} must be a bounded IANA name`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: text }).format(0);
  } catch {
    throw new Error(`${label} must be a recognized IANA name`);
  }
  return text;
}

function opaqueDeviceId(value: unknown): string {
  const text = boundedString(value, "TikTok Studio content-list device_id sink", 10, 32);
  if (!/^\d+$/u.test(text)) {
    throw new Error("TikTok Studio content-list device_id sink changed its opaque format");
  }
  return text;
}

function opaqueMsToken(value: unknown): string {
  const text = boundedString(value, "TikTok Studio content-list msToken sink", 8, 4_096);
  if (/\s|\p{Cc}/u.test(text)) {
    throw new Error("TikTok Studio content-list msToken sink changed its opaque format");
  }
  return text;
}

export type TikTokStudioContentListCommonQuery = Readonly<{
  aid: "1988";
  app_language: string;
  app_name: "tiktok_web";
  browser_language: string;
  browser_name: string;
  browser_platform: string;
  browser_version: string;
  channel: "tiktok_web";
  device_id: string;
  device_platform: "web_pc";
  locale: string;
  msToken: string;
  os: string;
  priority_region: string;
  region: string;
  screen_height: string;
  screen_width: string;
  tz_name: string;
}>;

/**
 * Validate the exact common-query projection supplied by provider-owned
 * browser state. device_id and msToken remain opaque sinks; this parser does
 * not interpret, derive, persist, or expose their meaning.
 */
export function parseTikTokStudioContentListCommonQuery(
  value: unknown,
): TikTokStudioContentListCommonQuery {
  const root = record(snapshotJson(value, "TikTok Studio content-list common query"),
    "TikTok Studio content-list common query");
  exactObjectKeys(root, COMMON_QUERY_KEYS, [], "TikTok Studio content-list common query");
  if (root.aid !== "1988") throw new Error("TikTok Studio content-list aid changed");
  if (root.app_name !== "tiktok_web" || root.channel !== "tiktok_web") {
    throw new Error("TikTok Studio content-list web surface changed");
  }
  if (root.device_platform !== "web_pc") {
    throw new Error("TikTok Studio content-list device platform changed");
  }
  return Object.freeze({
    aid: "1988",
    app_language: languageTag(root.app_language, "TikTok Studio content-list app_language"),
    app_name: "tiktok_web",
    browser_language: languageTag(
      root.browser_language,
      "TikTok Studio content-list browser_language",
    ),
    browser_name: plainCode(root.browser_name, "TikTok Studio content-list browser_name"),
    browser_platform: plainCode(
      root.browser_platform,
      "TikTok Studio content-list browser_platform",
    ),
    browser_version: printableString(
      root.browser_version,
      "TikTok Studio content-list browser_version",
      1,
      1_024,
    ),
    channel: "tiktok_web",
    device_id: opaqueDeviceId(root.device_id),
    device_platform: "web_pc",
    locale: languageTag(root.locale, "TikTok Studio content-list locale"),
    msToken: opaqueMsToken(root.msToken),
    os: plainCode(root.os, "TikTok Studio content-list os"),
    priority_region: plainCode(
      root.priority_region,
      "TikTok Studio content-list priority_region",
      16,
    ),
    region: plainCode(root.region, "TikTok Studio content-list region", 16),
    screen_height: screenDimension(
      root.screen_height,
      "TikTok Studio content-list screen_height",
    ),
    screen_width: screenDimension(
      root.screen_width,
      "TikTok Studio content-list screen_width",
    ),
    tz_name: runtimeTimeZone(root.tz_name, "TikTok Studio content-list tz_name"),
  });
}

export type TikTokStudioContentListSort = Readonly<{
  field_name: "comment_count" | "like_count" | "play_count" | "post_time";
  order: 1 | 2;
}>;

export type TikTokStudioContentListCondition = Readonly<{
  field_name: "comment_count" | "desc" | "like_count" | "play_count" | "visibility";
  field_values: readonly string[];
  op: 1 | 4 | 6 | 7;
}>;

export type TikTokStudioContentListBody = Readonly<{
  cursor: number;
  query: Readonly<{
    conditions?: readonly TikTokStudioContentListCondition[];
    is_recent_posts?: boolean;
    sort_orders: readonly TikTokStudioContentListSort[];
  }>;
  size: 1 | 10 | 50;
}>;

function parseSort(value: unknown, label: string): TikTokStudioContentListSort {
  const sort = record(value, label);
  exactObjectKeys(sort, ["field_name", "order"], [], label);
  if (typeof sort.field_name !== "string" || !SORT_FIELDS.has(sort.field_name)) {
    throw new Error(`${label}.field_name changed its reviewed enum`);
  }
  if (sort.order !== 1 && sort.order !== 2) {
    throw new Error(`${label}.order changed its reviewed enum`);
  }
  return Object.freeze({
    field_name: sort.field_name as TikTokStudioContentListSort["field_name"],
    order: sort.order,
  });
}

function exactConditionValues(
  fieldName: TikTokStudioContentListCondition["field_name"],
  values: readonly string[],
  operation: number,
  label: string,
): void {
  if (fieldName === "desc") {
    if (operation !== 1 || values.length !== 1) {
      throw new Error(`${label} changed its exact-description query shape`);
    }
    captionString(values[0], `${label}.field_values[0]`, 1);
    return;
  }
  if (fieldName === "visibility") {
    if (operation !== 1 || values.length !== 1 || !["1", "2", "3"].includes(values[0]!)) {
      throw new Error(`${label} changed its reviewed visibility condition`);
    }
    return;
  }
  const signature = `${operation}:${values.join(",")}`;
  if (!["6:1000", "7:1000,10000", "7:10000,100000", "4:100000"].includes(signature)) {
    throw new Error(`${label} changed its reviewed count condition`);
  }
}

function parseCondition(value: unknown, label: string): TikTokStudioContentListCondition {
  const condition = record(value, label);
  exactObjectKeys(condition, ["field_name", "field_values", "op"], [], label);
  if (typeof condition.field_name !== "string" || !CONDITION_FIELDS.has(condition.field_name)) {
    throw new Error(`${label}.field_name changed its reviewed enum`);
  }
  if (!Array.isArray(condition.field_values) || condition.field_values.length > 2) {
    throw new Error(`${label}.field_values changed its reviewed bound`);
  }
  const fieldValues = condition.field_values.map((entry, index) =>
    boundedString(entry, `${label}.field_values[${index}]`, 1, 16_384)
  );
  if (![1, 4, 6, 7].includes(condition.op as number)) {
    throw new Error(`${label}.op changed its reviewed enum`);
  }
  const fieldName = condition.field_name as TikTokStudioContentListCondition["field_name"];
  exactConditionValues(fieldName, fieldValues, condition.op as number, label);
  return Object.freeze({
    field_name: fieldName,
    field_values: Object.freeze(fieldValues),
    op: condition.op as TikTokStudioContentListCondition["op"],
  });
}

/** Parse only bundle-proven and live-observed content-list body variants. */
export function parseTikTokStudioContentListBody(value: unknown): TikTokStudioContentListBody {
  const root = record(snapshotJson(value, "TikTok Studio content-list body"),
    "TikTok Studio content-list body");
  exactObjectKeys(root, ["cursor", "query", "size"], [], "TikTok Studio content-list body");
  const cursor = boundedInteger(root.cursor, "TikTok Studio content-list cursor");
  if (root.size !== 1 && root.size !== 10 && root.size !== 50) {
    throw new Error("TikTok Studio content-list size changed its reviewed page bound");
  }
  if (
    (root.size === 1 && cursor !== 0)
    || (root.size === 50 && cursor !== 0)
    || (root.size === 10 && cursor === 0)
  ) throw new Error("TikTok Studio content-list cursor and size changed their reviewed pairing");

  const query = record(root.query, "TikTok Studio content-list query");
  exactObjectKeys(
    query,
    ["sort_orders"],
    ["conditions", "is_recent_posts"],
    "TikTok Studio content-list query",
  );
  if (
    !Array.isArray(query.sort_orders)
    || query.sort_orders.length < 1
    || query.sort_orders.length > 2
  ) throw new Error("TikTok Studio content-list sort_orders changed its reviewed bound");
  const sortOrders = query.sort_orders.map((sort, index) =>
    parseSort(sort, `TikTok Studio content-list sort_orders[${index}]`)
  );
  if (
    (sortOrders.length === 1 && sortOrders[0]!.field_name !== "post_time")
    || (
      sortOrders.length === 2
      && (
        sortOrders[0]!.field_name === "post_time"
        || sortOrders[1]!.field_name !== "post_time"
        || sortOrders[1]!.order !== 2
      )
    )
  ) throw new Error("TikTok Studio content-list sort order changed its reviewed tie-breaker");

  let conditions: readonly TikTokStudioContentListCondition[] | undefined;
  if (Object.hasOwn(query, "conditions")) {
    if (!Array.isArray(query.conditions) || query.conditions.length > 33) {
      throw new Error("TikTok Studio content-list conditions changed their reviewed bound");
    }
    const parsed = query.conditions.map((condition, index) =>
      parseCondition(condition, `TikTok Studio content-list conditions[${index}]`)
    );
    const signatures = parsed.map((condition) => JSON.stringify(condition));
    if (new Set(signatures).size !== signatures.length) {
      throw new Error("TikTok Studio content-list conditions must be unique");
    }
    if (parsed.filter((condition) => condition.field_name === "desc").length > 1) {
      throw new Error("TikTok Studio content-list query must contain at most one description");
    }
    conditions = Object.freeze(parsed);
  }
  let isRecentPosts: boolean | undefined;
  if (Object.hasOwn(query, "is_recent_posts")) {
    isRecentPosts = exactBoolean(
      query.is_recent_posts,
      "TikTok Studio content-list is_recent_posts",
    );
  }
  if (root.size === 1) {
    if (conditions === undefined || conditions.length !== 0 || isRecentPosts !== undefined) {
      throw new Error("TikTok Studio content-list feature probe changed its reviewed query");
    }
    if (sortOrders.length !== 1 || sortOrders[0]!.order !== 2) {
      throw new Error("TikTok Studio content-list feature probe changed its reviewed sort");
    }
  } else if ((conditions === undefined) !== (isRecentPosts === undefined)) {
    throw new Error("TikTok Studio content-list query changed its hook field pairing");
  }

  const parsedQuery = Object.freeze({
    ...(conditions === undefined ? {} : { conditions }),
    ...(isRecentPosts === undefined ? {} : { is_recent_posts: isRecentPosts }),
    sort_orders: Object.freeze(sortOrders),
  });
  return Object.freeze({ cursor, query: parsedQuery, size: root.size });
}

/** Build the bounded exact-caption query used for account-bound readback. */
export function buildTikTokStudioExactCaptionListBody(input: {
  readonly cursor: unknown;
  readonly description: unknown;
}): TikTokStudioContentListBody {
  const cursor = boundedInteger(input.cursor, "TikTok Studio content-list cursor");
  const description = captionString(
    input.description,
    "TikTok Studio exact description",
    1,
  );
  return parseTikTokStudioContentListBody({
    cursor,
    size: cursor === 0 ? 50 : 10,
    query: {
      conditions: [{ field_name: "desc", field_values: [description], op: 1 }],
      is_recent_posts: false,
      sort_orders: [{ field_name: "post_time", order: 2 }],
    },
  });
}

export type TikTokStudioContentListRequest = Readonly<{
  body: TikTokStudioContentListBody;
  method: "POST";
  path: "/tiktok/creator/manage/item_list/v1/";
  query: TikTokStudioContentListCommonQuery;
}>;

/** Build the exact route around already-provider-owned query and body state. */
export function buildTikTokStudioContentListRequest(input: {
  readonly body: unknown;
  readonly commonQuery: unknown;
}): TikTokStudioContentListRequest {
  return Object.freeze({
    body: parseTikTokStudioContentListBody(input.body),
    method: "POST",
    path: "/tiktok/creator/manage/item_list/v1/",
    query: parseTikTokStudioContentListCommonQuery(input.commonQuery),
  });
}

export type TikTokStudioActionPermission = Readonly<{
  reason: string;
  showType: number;
}>;

export type TikTokStudioVisibilityPermission = Readonly<{
  reason: string;
  visibilityStatus: number;
}>;

export type TikTokStudioContentListPermissions = Readonly<{
  canAddToPlaylist: TikTokStudioActionPermission;
  canChangePrivacy: Readonly<{
    reason: string;
    showType: number;
    visibilityOptions: Readonly<{
      availableForAds: TikTokStudioVisibilityPermission;
      everyone: TikTokStudioVisibilityPermission;
      followers: TikTokStudioVisibilityPermission;
      friends: TikTokStudioVisibilityPermission;
      onlyYou: TikTokStudioVisibilityPermission;
    }>;
  }>;
  canDelete: TikTokStudioActionPermission;
  canEdit: TikTokStudioActionPermission;
  canEditCover: TikTokStudioActionPermission;
  canPin: TikTokStudioActionPermission;
}>;

export type TikTokStudioNormalItem = Readonly<{
  commentCount: string;
  coverUrlCount: number;
  createTime: string;
  description: string;
  downloadAllowed: boolean;
  downloadUrlCount: number;
  duration: number;
  favoriteCount: string;
  inReview: boolean;
  isPinned: boolean;
  itemId: string;
  itemType: number;
  likeCount: string;
  permissions: TikTokStudioContentListPermissions;
  playAddressCount: number;
  playCount: string;
  postTime: string;
  scheduleTime: string;
  shareCount: string;
  status: number;
  videoId: string;
  visibility: number;
}>;

function parseActionPermission(value: unknown, label: string): TikTokStudioActionPermission {
  const permission = record(value, label);
  exactObjectKeys(permission, ["reason", "show_type"], [], label);
  return Object.freeze({
    reason: printableString(permission.reason, `${label}.reason`, 0, 4_096),
    showType: boundedInteger(permission.show_type, `${label}.show_type`, 0, 64),
  });
}

function parseVisibilityPermission(
  value: unknown,
  label: string,
): TikTokStudioVisibilityPermission {
  const permission = record(value, label);
  exactObjectKeys(permission, ["reason", "visibility_status"], [], label);
  return Object.freeze({
    reason: printableString(permission.reason, `${label}.reason`, 0, 4_096),
    visibilityStatus: boundedInteger(
      permission.visibility_status,
      `${label}.visibility_status`,
      0,
      64,
    ),
  });
}

function parsePermissions(value: unknown): TikTokStudioContentListPermissions {
  const permissions = record(value, "TikTok Studio content-list permissions");
  exactObjectKeys(
    permissions,
    ACTION_PERMISSION_KEYS,
    [],
    "TikTok Studio content-list permissions",
  );
  const changePrivacy = record(
    permissions.can_change_privacy,
    "TikTok Studio content-list permissions.can_change_privacy",
  );
  exactObjectKeys(
    changePrivacy,
    ["reason", "show_type", "visibility_options"],
    [],
    "TikTok Studio content-list permissions.can_change_privacy",
  );
  const visibilityOptions = record(
    changePrivacy.visibility_options,
    "TikTok Studio content-list permissions.can_change_privacy.visibility_options",
  );
  exactObjectKeys(
    visibilityOptions,
    VISIBILITY_OPTION_KEYS,
    [],
    "TikTok Studio content-list permissions.can_change_privacy.visibility_options",
  );
  return Object.freeze({
    canAddToPlaylist: parseActionPermission(
      permissions.can_add_to_playlist,
      "TikTok Studio content-list permissions.can_add_to_playlist",
    ),
    canChangePrivacy: Object.freeze({
      reason: printableString(
        changePrivacy.reason,
        "TikTok Studio content-list permissions.can_change_privacy.reason",
        0,
        4_096,
      ),
      showType: boundedInteger(
        changePrivacy.show_type,
        "TikTok Studio content-list permissions.can_change_privacy.show_type",
        0,
        64,
      ),
      visibilityOptions: Object.freeze({
        availableForAds: parseVisibilityPermission(
          visibilityOptions.visibility_available_for_ads,
          "TikTok Studio content-list visibility_available_for_ads",
        ),
        everyone: parseVisibilityPermission(
          visibilityOptions.visibility_everyone,
          "TikTok Studio content-list visibility_everyone",
        ),
        followers: parseVisibilityPermission(
          visibilityOptions.visibility_followers,
          "TikTok Studio content-list visibility_followers",
        ),
        friends: parseVisibilityPermission(
          visibilityOptions.visibility_friends,
          "TikTok Studio content-list visibility_friends",
        ),
        onlyYou: parseVisibilityPermission(
          visibilityOptions.visibility_only_you,
          "TikTok Studio content-list visibility_only_you",
        ),
      }),
    }),
    canDelete: parseActionPermission(
      permissions.can_delete,
      "TikTok Studio content-list permissions.can_delete",
    ),
    canEdit: parseActionPermission(
      permissions.can_edit,
      "TikTok Studio content-list permissions.can_edit",
    ),
    canEditCover: parseActionPermission(
      permissions.can_edit_cover,
      "TikTok Studio content-list permissions.can_edit_cover",
    ),
    canPin: parseActionPermission(
      permissions.can_pin,
      "TikTok Studio content-list permissions.can_pin",
    ),
  });
}

function validateHttpsUrlList(value: unknown, label: string): number {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error(`${label} changed its reviewed array bound`);
  }
  for (const [index, rawUrl] of value.entries()) {
    const text = boundedString(rawUrl, `${label}[${index}]`, 1, 16_384);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`${label}[${index}] must be an absolute HTTPS URL`);
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new Error(`${label}[${index}] must be an absolute HTTPS URL`);
    }
  }
  return value.length;
}

function parseNormalItemSnapshot(value: unknown, label: string): TikTokStudioNormalItem {
  const item = record(value, label);
  exactObjectKeys(item, NORMAL_ITEM_KEYS, [], label);
  const downloadInfo = record(item.download_info, `${label}.download_info`);
  exactObjectKeys(
    downloadInfo,
    ["allow_download", "download_urls"],
    [],
    `${label}.download_info`,
  );
  return Object.freeze({
    commentCount: decimalString(item.comment_count, `${label}.comment_count`),
    coverUrlCount: validateHttpsUrlList(item.cover_url, `${label}.cover_url`),
    createTime: decimalString(item.create_time, `${label}.create_time`),
    description: captionString(item.desc, `${label}.desc`, 0),
    downloadAllowed: exactBoolean(
      downloadInfo.allow_download,
      `${label}.download_info.allow_download`,
    ),
    downloadUrlCount: validateHttpsUrlList(
      downloadInfo.download_urls,
      `${label}.download_info.download_urls`,
    ),
    duration: boundedInteger(item.duration, `${label}.duration`, 1, 86_400_000),
    favoriteCount: decimalString(item.favorite_count, `${label}.favorite_count`),
    inReview: exactBoolean(item.in_review, `${label}.in_review`),
    isPinned: exactBoolean(item.is_pinned, `${label}.is_pinned`),
    itemId: decimalId(item.item_id, `${label}.item_id`),
    itemType: boundedInteger(item.item_type, `${label}.item_type`, 0, 64),
    likeCount: decimalString(item.like_count, `${label}.like_count`),
    permissions: parsePermissions(item.permissions),
    playAddressCount: validateHttpsUrlList(item.play_addr, `${label}.play_addr`),
    playCount: decimalString(item.play_count, `${label}.play_count`),
    postTime: decimalString(item.post_time, `${label}.post_time`),
    scheduleTime: decimalString(item.schedule_time, `${label}.schedule_time`),
    shareCount: decimalString(item.share_count, `${label}.share_count`),
    status: boundedInteger(item.status, `${label}.status`, 0, 1_024),
    videoId: plainCode(item.vid, `${label}.vid`, 512),
    visibility: boundedInteger(item.visibility, `${label}.visibility`, 0, 64),
  });
}

/** Parse one exact normal-item wire object and discard all signed URL values. */
export function parseTikTokStudioNormalItem(value: unknown): TikTokStudioNormalItem {
  return parseNormalItemSnapshot(
    snapshotJson(value, "TikTok Studio normal item"),
    "TikTok Studio normal item",
  );
}

export type TikTokStudioContentListPage = Readonly<{
  cursor: number;
  enableQuery: boolean;
  hasMore: boolean;
  isLimited: boolean;
  items: readonly TikTokStudioNormalItem[];
  /** Always false: this list contract is not an independent tombstone read. */
  canProveAbsence: false;
}>;

/** Parse the exact successful envelope while dropping log IDs and signed URLs. */
export function parseTikTokStudioContentListEnvelope(
  value: unknown,
): TikTokStudioContentListPage {
  const root = record(
    snapshotJson(value, "TikTok Studio content-list response"),
    "TikTok Studio content-list response",
  );
  exactObjectKeys(root, [
    "cursor",
    "enable_query",
    "extra",
    "has_more",
    "is_limited",
    "item_list",
    "log_pb",
    "status_code",
    "status_msg",
  ], [], "TikTok Studio content-list response");
  if (root.status_code !== 0 || root.status_msg !== "") {
    throw new Error("TikTok Studio content-list response did not report exact success");
  }
  const extra = record(root.extra, "TikTok Studio content-list response.extra");
  exactObjectKeys(
    extra,
    ["fatal_item_ids", "logid", "now"],
    [],
    "TikTok Studio content-list response.extra",
  );
  if (!Array.isArray(extra.fatal_item_ids) || extra.fatal_item_ids.length !== 0) {
    throw new Error("TikTok Studio content-list response contains fatal item IDs");
  }
  printableString(extra.logid, "TikTok Studio content-list response.extra.logid", 1, 256);
  boundedInteger(
    extra.now,
    "TikTok Studio content-list response.extra.now",
    1_000_000_000_000,
    9_999_999_999_999,
  );
  const logPb = record(root.log_pb, "TikTok Studio content-list response.log_pb");
  exactObjectKeys(logPb, ["impr_id"], [], "TikTok Studio content-list response.log_pb");
  printableString(logPb.impr_id, "TikTok Studio content-list response.log_pb.impr_id", 1, 256);
  if (!Array.isArray(root.item_list) || root.item_list.length > 50) {
    throw new Error("TikTok Studio content-list response item_list changed its reviewed bound");
  }
  const items = root.item_list.map((item, index) =>
    parseNormalItemSnapshot(item, `TikTok Studio content-list response.item_list[${index}]`)
  );
  const itemIds = items.map((item) => item.itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error("TikTok Studio content-list response contains duplicate item IDs");
  }
  return Object.freeze({
    canProveAbsence: false,
    cursor: boundedInteger(root.cursor, "TikTok Studio content-list response.cursor"),
    enableQuery: exactBoolean(
      root.enable_query,
      "TikTok Studio content-list response.enable_query",
    ),
    hasMore: exactBoolean(root.has_more, "TikTok Studio content-list response.has_more"),
    isLimited: exactBoolean(root.is_limited, "TikTok Studio content-list response.is_limited"),
    items: Object.freeze(items),
  });
}

export type TikTokStudioContentListTargetObservation =
  | Readonly<{
    kind: "present";
    item: TikTokStudioNormalItem;
  }>
  | Readonly<{
    absenceProven: false;
    kind: "absence-unproven";
    reason: "additional-page-required" | "limited-response" | "list-is-not-a-tombstone";
  }>
  | Readonly<{
    kind: "binding-mismatch";
    observedDescription: string;
  }>;

/**
 * Bind presence by item_id plus exact desc. Nonappearance is deliberately
 * never promoted to deletion evidence, including an unpaginated, non-limited
 * result; an independent exact target/tombstone read remains required.
 */
export function observeTikTokStudioContentListTarget(
  page: TikTokStudioContentListPage,
  target: { readonly description: unknown; readonly itemId: unknown },
): TikTokStudioContentListTargetObservation {
  const itemId = decimalId(target.itemId, "TikTok Studio observed item ID");
  const description = captionString(
    target.description,
    "TikTok Studio observed description",
    0,
  );
  const item = page.items.find((candidate) => candidate.itemId === itemId);
  if (item !== undefined) {
    if (item.description !== description) {
      return Object.freeze({
        kind: "binding-mismatch",
        observedDescription: item.description,
      });
    }
    return Object.freeze({ kind: "present", item });
  }
  return Object.freeze({
    absenceProven: false,
    kind: "absence-unproven",
    reason: page.isLimited
      ? "limited-response"
      : page.hasMore
      ? "additional-page-required"
      : "list-is-not-a-tombstone",
  });
}
