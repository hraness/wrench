/**
 * Twitch authenticated-web profile statistics contract.
 *
 * This module owns the two fixed registered GraphQL operations and their
 * bounded projections. It has no network access and never accepts an origin,
 * path, header, raw GraphQL document, revision, or response selector from a
 * caller.
 */

export const TWITCH_APP_ORIGIN = "https://www.twitch.tv";
export const TWITCH_GQL_ORIGIN = "https://gql.twitch.tv";
export const TWITCH_GQL_PATH = "/gql";

export const TWITCH_WEB_OPERATION_NAMES = Object.freeze([
  "profiles.read",
] as const);

export type TwitchWebOperationName =
  (typeof TWITCH_WEB_OPERATION_NAMES)[number];

export const TWITCH_WEB_OPERATIONS = Object.freeze({
  "profiles.read": Object.freeze({
    effect: "read" as const,
    risk: "R1" as const,
    state: "observed" as const,
    reason:
      "fixed authenticated current-viewer and target-bound About-panel registered queries project one exact follower count without acknowledgement side effects",
  }),
});

// These fixed public web-client contract values come from the reviewed
// first-party operations, never from caller input or runtime discovery.
export const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
export const TWITCH_CURRENT_VIEWER_REVISION =
  "6c870de60372d53089341c8af304c35c541754b72550eb2672224b017a39512e";
export const TWITCH_ABOUT_PANEL_REVISION =
  "3b9cd4edd28e8e6f7ba6152a56157bc2b1c1a8f6e81d70808ad1b85250e5288f";

type JsonRecord = Record<string, unknown>;

export type TwitchViewer = Readonly<{
  id: string;
}>;

export type TwitchProfile = Readonly<{
  id: string;
  login: string;
  followers: number;
}>;

type ExactCountMetric = Readonly<{
  status: "available";
  value: number;
  precision: "exact";
  unit: "count";
}>;

export type TwitchProfileStats = Readonly<{
  schemaVersion: 1;
  provider: "twitch";
  target: Readonly<{
    kind: "profile";
    id: string;
    url: string;
  }>;
  observedAt: string;
  completeness: "complete";
  metrics: Readonly<{
    followers: ExactCountMetric;
  }>;
  metadata: Readonly<{
    login: string;
  }>;
}>;

export type TwitchPersistedQueryRequest = Readonly<{
  operationName: "TopNav_CurrentUser" | "ChannelRoot_AboutPanel";
  variables: Readonly<Record<string, string | boolean>>;
  extensions: Readonly<{
    persistedQuery: Readonly<{
      version: 1;
      sha256Hash: string;
    }>;
  }>;
}>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactGraphQlResult(value: unknown, label: string): JsonRecord {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${label} must be one exact GraphQL batch result`);
  }
  const result = record(value[0], `${label}[0]`);
  if (Object.hasOwn(result, "errors")) {
    throw new Error(`${label} returned GraphQL errors`);
  }
  return record(result.data, `${label}[0].data`);
}

function twitchUserId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]{0,31}$/u.test(value)
  ) {
    throw new Error(`${label} must be one exact Twitch user ID`);
  }
  return value;
}

export function twitchLogin(
  value: unknown,
  label = "Twitch login",
): string {
  if (
    typeof value !== "string"
    || !/^[a-z0-9_]{4,25}$/u.test(value)
  ) {
    throw new Error(`${label} must be one exact lowercase Twitch login`);
  }
  return value;
}

function exactFollowerCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Twitch follower count must be an exact nonnegative safe integer");
  }
  return value as number;
}

function persistedQuery(
  operationName: TwitchPersistedQueryRequest["operationName"],
  variables: Readonly<Record<string, string | boolean>>,
  revision: string,
): TwitchPersistedQueryRequest {
  if (!/^[a-f0-9]{64}$/u.test(revision)) {
    throw new Error(`Twitch ${operationName} revision is not reviewed`);
  }
  return Object.freeze({
    operationName,
    variables,
    extensions: Object.freeze({
      persistedQuery: Object.freeze({ version: 1 as const, sha256Hash: revision }),
    }),
  });
}

/** Build the fixed one-entry current-viewer GraphQL batch. */
export function twitchCurrentViewerRequest(): readonly TwitchPersistedQueryRequest[] {
  return Object.freeze([
    persistedQuery(
      "TopNav_CurrentUser",
      Object.freeze({}),
      TWITCH_CURRENT_VIEWER_REVISION,
    ),
  ]);
}

/** Build the fixed one-entry About-panel GraphQL batch for one exact login. */
export function twitchProfileRequest(
  requestedLogin: unknown,
): readonly TwitchPersistedQueryRequest[] {
  const channelLogin = twitchLogin(requestedLogin, "requested Twitch login");
  return Object.freeze([
    persistedQuery(
      "ChannelRoot_AboutPanel",
      Object.freeze({ channelLogin, skipSchedule: true }),
      TWITCH_ABOUT_PANEL_REVISION,
    ),
  ]);
}

/** Parse exactly one authenticated current-viewer result. */
export function parseTwitchCurrentViewerResponse(value: unknown): TwitchViewer {
  const data = exactGraphQlResult(value, "Twitch current-viewer response");
  const currentUser = record(
    data.currentUser,
    "Twitch current-viewer response[0].data.currentUser",
  );
  return Object.freeze({
    id: twitchUserId(
      currentUser.id,
      "Twitch current-viewer response[0].data.currentUser.id",
    ),
  });
}

/**
 * Parse the fixed login-parameterized target response only after binding its
 * immutable account ID to the already-probed viewer.
 */
export function parseTwitchProfileResponse(
  value: unknown,
  requestedLogin: unknown,
  viewer: TwitchViewer,
): TwitchProfile {
  const login = twitchLogin(requestedLogin, "requested Twitch login");
  const data = exactGraphQlResult(value, "Twitch profile response");
  const user = record(data.user, "Twitch profile response[0].data.user");
  const responseId = twitchUserId(user.id, "Twitch profile response[0].data.user.id");
  if (responseId !== viewer.id) {
    throw new Error("Twitch profile response did not bind the current viewer ID");
  }
  const followers = record(
    user.followers,
    "Twitch profile response[0].data.user.followers",
  );
  return Object.freeze({
    id: responseId,
    login,
    followers: exactFollowerCount(followers.totalCount),
  });
}

function exactObservedAt(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Twitch statistics observedAt must be an exact UTC observation time");
  }
  return value;
}

/** Project only public target metadata and the exact target-bound count. */
export function projectTwitchProfileStats(
  profile: TwitchProfile,
  observedAt: string,
): TwitchProfileStats {
  const login = twitchLogin(profile.login);
  const followers = exactFollowerCount(profile.followers);
  return Object.freeze({
    schemaVersion: 1,
    provider: "twitch",
    target: Object.freeze({
      kind: "profile",
      id: twitchUserId(profile.id, "Twitch profile ID"),
      url: `${TWITCH_APP_ORIGIN}/${login}`,
    }),
    observedAt: exactObservedAt(observedAt),
    completeness: "complete",
    metrics: Object.freeze({
      followers: Object.freeze({
        status: "available",
        value: followers,
        precision: "exact",
        unit: "count",
      }),
    }),
    metadata: Object.freeze({ login }),
  });
}
