import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  createWebSessionClient,
  webSessionAuthSubject,
  webSessionCookie,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  assertYouTubeResponseSuccess,
  assertYouTubeVideoBinding,
  createYouTubeSapisidAuthorization,
  findYouTubeCommentsContinuation,
  parseYouTubeInitialDataHtml,
  parseYouTubeBootstrapHtml,
  projectYouTubeProfile,
  projectYouTubeComments,
  projectYouTubeItems,
  projectYouTubeMedia,
  projectYouTubePost,
  youtubePostBrowseRequest,
  youtubeProfileBrowseRequest,
  youtubeProfileTarget,
  youtubeCurrentSubject,
  youtubeLikeMutationRequest,
  youtubeLikeState,
  youtubeSubscriptionMutationRequest,
  youtubeSubscriptionState,
  youtubeWatchLaterState,
  type YouTubeBootstrapConfig,
} from "./youtube-web";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMIT = 20;

type InnertubeEndpoint =
  | "account/account_menu"
  | "account/accounts_list"
  | "browse"
  | "like/like"
  | "like/removelike"
  | "navigation/resolve_url"
  | "next"
  | "player"
  | "playlist/edit"
  | "subscription/subscribe"
  | "subscription/unsubscribe";

export type YouTubeWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly now?: () => number;
};

export type YouTubeWebDesiredStateKind =
  | "like"
  | "subscription"
  | "watch-later";

export type YouTubeWebDesiredStatePreparation = {
  readonly kind: YouTubeWebDesiredStateKind;
  readonly targetId: string;
  readonly desiredState: boolean;
  readonly actualState: boolean;
  readonly alreadyDesired: boolean;
};

export type YouTubeWebDesiredStateReadback = {
  readonly kind: YouTubeWebDesiredStateKind;
  readonly targetId: string;
  readonly enabled: boolean;
};

type YouTubeBootstrap = {
  readonly auth: WrenchAuth;
  readonly client: WebSessionClient;
  readonly config: YouTubeBootstrapConfig;
  readonly sapisid: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly now: () => number;
  readonly subject: string;
};

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function stringInput(input: OperationInput, name: string, maximum: number): string {
  return boundedString(input[name], `input.${name}`, maximum);
}

function booleanInput(input: OperationInput, name: string): boolean {
  const value = input[name];
  if (typeof value !== "boolean") throw new Error(`input.${name} must be boolean`);
  return value;
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

function videoIdInput(input: OperationInput): string {
  const value = stringInput(input, "video_id", 11);
  if (!/^[A-Za-z0-9_-]{11}$/u.test(value)) throw new Error("input.video_id must be an exact YouTube video ID");
  return value;
}

function postIdInput(input: OperationInput): string {
  const value = stringInput(input, "post_id", 256);
  if (!/^[A-Za-z0-9_-]{10,256}$/u.test(value)) {
    throw new Error("input.post_id must be an exact YouTube Community post ID");
  }
  return value;
}

function channelIdInput(input: OperationInput): string {
  const value = stringInput(input, "channel_id", 24);
  if (!/^UC[A-Za-z0-9_-]{22}$/u.test(value)) {
    throw new Error("input.channel_id must be an exact YouTube channel ID");
  }
  return value;
}

function sapisidCookie(client: WebSessionClient): string {
  for (const name of ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"] as const) {
    if (client.cookies.some((cookie) => cookie.name === name)) return webSessionCookie(client.cookies, name);
  }
  throw new Error("YouTube signed-in session omitted its SAPISID cookie");
}

function requestHeaders(bootstrap: Omit<YouTubeBootstrap, "subject">): Readonly<Record<string, string>> {
  const authorization = createYouTubeSapisidAuthorization(
    bootstrap.sapisid,
    bootstrap.now(),
  );
  return {
    accept: "application/json",
    authorization,
    "content-type": "application/json",
    origin: YOUTUBE_ORIGIN,
    referer: `${YOUTUBE_ORIGIN}/`,
    "x-goog-authuser": bootstrap.config.sessionIndex,
    ...(bootstrap.config.delegatedSessionId === null
      ? {}
      : { "x-goog-pageid": bootstrap.config.delegatedSessionId }),
    ...(bootstrap.config.visitorData === null
      ? {}
      : { "x-goog-visitor-id": bootstrap.config.visitorData }),
    "x-origin": YOUTUBE_ORIGIN,
    "x-youtube-bootstrap-logged-in": String(bootstrap.config.bootstrapLoggedIn),
    "x-youtube-client-name": bootstrap.config.clientNameHeader,
    "x-youtube-client-version": bootstrap.config.clientVersion,
  };
}

function endpointUrl(endpoint: InnertubeEndpoint, apiKey: string): URL {
  const url = new URL(`/youtubei/v1/${endpoint}`, YOUTUBE_ORIGIN);
  url.searchParams.set("prettyPrint", "false");
  url.searchParams.set("key", apiKey);
  return url;
}

async function innertube(
  bootstrap: Omit<YouTubeBootstrap, "subject">,
  endpoint: InnertubeEndpoint,
  body: Readonly<Record<string, unknown>>,
  label: string,
): Promise<unknown> {
  const response = await bootstrap.client.requestJson({
    url: endpointUrl(endpoint, bootstrap.config.apiKey),
    method: "POST",
    headers: requestHeaders(bootstrap),
    body: JSON.stringify({ context: bootstrap.config.context, ...body }),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: bootstrap.maxOutputBytes,
  });
  assertYouTubeResponseSuccess(response, label);
  return response;
}

async function currentSubject(bootstrap: Omit<YouTubeBootstrap, "subject">): Promise<string> {
  const accountMenu = await innertube(bootstrap, "account/account_menu", {}, "YouTube account menu");
  const accountsList = await innertube(bootstrap, "account/accounts_list", {}, "YouTube accounts list");
  return youtubeCurrentSubject(
    accountMenu,
    accountsList,
    bootstrap.config.delegatedSessionId,
  );
}

async function bootstrapYouTube(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  },
): Promise<YouTubeBootstrap> {
  const client = await createWebSessionClient(YOUTUBE_ORIGIN, auth, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const html = await client.requestText({
    url: new URL("/", YOUTUBE_ORIGIN),
    headers: { accept: "text/html" },
    expectedContentTypes: ["text/html"],
    maxBytes: MAX_BOOTSTRAP_BYTES,
  });
  const config = parseYouTubeBootstrapHtml(html);
  const partial = {
    auth,
    client,
    config,
    sapisid: sapisidCookie(client),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    now: options.dependencies?.now ?? Date.now,
  };
  const subject = await currentSubject(partial);
  return Object.freeze({ ...partial, subject });
}

function requireBoundSubject(bootstrap: YouTubeBootstrap): string {
  const expected = webSessionAuthSubject(bootstrap.auth);
  if (expected === null) {
    throw new Error("YouTube authenticated operations require a bound auth subject");
  }
  if (expected !== bootstrap.subject) {
    throw new Error("YouTube current account did not match the bound auth subject");
  }
  return expected;
}

export async function probeYouTubeWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const bootstrap = await bootstrapYouTube(auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return bootstrap.subject;
}

const feedBrowseIds = Object.freeze({
  home: "FEwhat_to_watch",
  subscriptions: "FEsubscriptions",
  library: "FElibrary",
  history: "FEhistory",
  playlists: "FEplaylist_aggregation",
  "watch-later": "VLWL",
  liked: "VLLL",
} as const);

type FeedName = keyof typeof feedBrowseIds;

function feedName(input: OperationInput): FeedName {
  const value = stringInput(input, "feed", 32);
  if (!Object.hasOwn(feedBrowseIds, value)) throw new Error("input.feed must name a reviewed YouTube feed");
  return value as FeedName;
}

async function executeFeed(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const feed = feedName(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const response = await innertube(
    bootstrap,
    "browse",
    { browseId: feedBrowseIds[feed] },
    "YouTube feed",
  );
  return {
    status: "succeeded",
    output: { feed, ...projectYouTubeItems(response, limit) },
    finalUrl: feed === "home"
      ? `${YOUTUBE_ORIGIN}/`
      : feed === "subscriptions"
        ? `${YOUTUBE_ORIGIN}/feed/subscriptions`
        : feed === "history"
          ? `${YOUTUBE_ORIGIN}/feed/history`
          : feed === "watch-later"
            ? `${YOUTUBE_ORIGIN}/playlist?list=WL`
            : feed === "liked"
              ? `${YOUTUBE_ORIGIN}/playlist?list=LL`
              : `${YOUTUBE_ORIGIN}/feed/you`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executeMediaRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const videoId = videoIdInput(input);
  const response = await innertube(
    bootstrap,
    "player",
    { videoId, contentCheckOk: true, racyCheckOk: true },
    "YouTube player",
  );
  return {
    status: "succeeded",
    output: projectYouTubeMedia(response, videoId),
    finalUrl: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executePostRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const postId = postIdInput(input);
  const resolved = await innertube(
    bootstrap,
    "navigation/resolve_url",
    { url: `${YOUTUBE_ORIGIN}/post/${postId}` },
    "YouTube Community URL resolution",
  );
  const browse = youtubePostBrowseRequest(resolved, postId);
  const response = await innertube(
    bootstrap,
    "browse",
    browse,
    "YouTube Community post",
  );
  return {
    status: "succeeded",
    output: projectYouTubePost(response, postId),
    finalUrl: `${YOUTUBE_ORIGIN}/post/${postId}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executeCommentsRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const videoId = videoIdInput(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const initial = await innertube(
    bootstrap,
    "next",
    { videoId },
    "YouTube video comments bootstrap",
  );
  assertYouTubeVideoBinding(initial, videoId, "YouTube video comments bootstrap");
  const continuation = findYouTubeCommentsContinuation(initial);
  const response = continuation === null
    ? initial
    : await innertube(
      bootstrap,
      "next",
      { continuation },
      "YouTube comments",
    );
  return {
    status: "succeeded",
    output: { videoId, ...projectYouTubeComments(response, limit) },
    finalUrl: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

function exactProfileCount(value: number | null): Readonly<Record<string, unknown>> {
  return value === null
    ? Object.freeze({ status: "unavailable", reason: "not-exposed" })
    : Object.freeze({
      status: "available",
      value,
      precision: "exact",
      unit: "count",
    });
}

async function executeProfileRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const target = youtubeProfileTarget(input.profile);
  const resolved = await innertube(
    bootstrap,
    "navigation/resolve_url",
    { url: target.url },
    "YouTube profile URL resolution",
  );
  const browse = youtubeProfileBrowseRequest(resolved, target);
  const html = await bootstrap.client.requestText({
    url: new URL(`${target.url}/about`),
    headers: { accept: "text/html" },
    expectedContentTypes: ["text/html"],
    maxBytes: Math.min(bootstrap.maxOutputBytes, MAX_PROFILE_PAGE_BYTES),
  });
  const response = parseYouTubeInitialDataHtml(html);
  const profile = projectYouTubeProfile(response, browse.browseId, target.handle);
  if (
    target.handle !== null
    && profile.handle?.toLocaleLowerCase("en-US") !== target.handle.toLocaleLowerCase("en-US")
  ) throw new Error("YouTube profile response did not bind the requested handle");
  const observationTime = bootstrap.now();
  if (
    !Number.isSafeInteger(observationTime)
    || observationTime < 0
    || observationTime > 8_640_000_000_000_000
  ) throw new Error("YouTube profile observation time is invalid");
  const complete = profile.subscribers !== null
    && profile.videos !== null
    && profile.views !== null;
  return {
    status: "succeeded",
    output: Object.freeze({
      schemaVersion: 1,
      provider: "youtube",
      target: Object.freeze({
        kind: "profile",
        id: profile.channelId,
        url: profile.canonicalUrl,
      }),
      observedAt: new Date(observationTime).toISOString(),
      completeness: complete ? "complete" : "partial",
      metrics: Object.freeze({
        subscribers: exactProfileCount(profile.subscribers),
        videos: exactProfileCount(profile.videos),
        views: exactProfileCount(profile.views),
      }),
      metadata: Object.freeze({
        ...(profile.handle === null ? {} : { handle: profile.handle }),
        displayName: profile.displayName,
        ...(profile.bio === null ? {} : { bio: profile.bio }),
      }),
    }),
    finalUrl: profile.canonicalUrl,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

function dispatchEvent(
  action: string,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return { id: action, index: 1, progress: { planned: 1, started, verified } };
}

async function likeReadback(bootstrap: YouTubeBootstrap, videoId: string): Promise<boolean> {
  const response = await innertube(
    bootstrap,
    "next",
    { videoId },
    "YouTube like readback",
  );
  return youtubeLikeState(response, videoId);
}

async function saveReadback(bootstrap: YouTubeBootstrap, videoId: string): Promise<boolean> {
  const response = await innertube(
    bootstrap,
    "next",
    { videoId },
    "YouTube save readback",
  );
  return youtubeWatchLaterState(response, videoId);
}

async function followReadback(bootstrap: YouTubeBootstrap, channelId: string): Promise<boolean> {
  const response = await innertube(
    bootstrap,
    "browse",
    { browseId: channelId },
    "YouTube subscription readback",
  );
  return youtubeSubscriptionState(response, channelId);
}

function isYouTubeDesiredStateRecipe(recipe: WebSessionRecipe): boolean {
  return recipe.site === "youtube"
    && recipe.contractVersion === 1
    && (
      recipe.action === "likes.set"
      || recipe.action === "content.save"
      || recipe.action === "relationships.follow.set"
    );
}

async function prepareDesiredStateWithBootstrap(
  bootstrap: YouTubeBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<{
  readonly preparation: YouTubeWebDesiredStatePreparation;
  readonly commandSource: unknown;
}> {
  if (!isYouTubeDesiredStateRecipe(recipe)) {
    throw new Error(
      "YouTube desired-state preparation supports only likes.set, content.save, and relationships.follow.set",
    );
  }
  requireBoundSubject(bootstrap);
  const kind: YouTubeWebDesiredStateKind = recipe.action === "likes.set"
    ? "like"
    : recipe.action === "content.save"
      ? "watch-later"
      : "subscription";
  const targetId = kind === "subscription" ? channelIdInput(input) : videoIdInput(input);
  const desiredState = kind === "like"
    ? booleanInput(input, "liked")
    : kind === "watch-later"
      ? booleanInput(input, "saved")
      : booleanInput(input, "followed");
  const commandSource = kind === "subscription"
    ? await innertube(
      bootstrap,
      "browse",
      { browseId: targetId },
      "YouTube subscription command discovery",
    )
    : await innertube(
      bootstrap,
      "next",
      { videoId: targetId },
      kind === "like"
        ? "YouTube like command discovery"
        : "YouTube save readback",
    );
  const actualState = kind === "like"
    ? youtubeLikeState(commandSource, targetId)
    : kind === "watch-later"
      ? youtubeWatchLaterState(commandSource, targetId)
      : youtubeSubscriptionState(commandSource, targetId);
  return Object.freeze({
    preparation: Object.freeze({
      kind,
      targetId,
      desiredState,
      actualState,
      alreadyDesired: actualState === desiredState,
    }),
    commandSource: kind === "watch-later" ? null : commandSource,
  });
}

/**
 * Perform only the account and exact-target reads that precede a YouTube
 * desired-state write. Capture-required execution remains network-inert; this
 * read-only seam exists for reconciliation and deterministic preparation tests.
 */
export async function prepareYouTubeWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  } = {},
): Promise<YouTubeWebDesiredStatePreparation> {
  if (!isYouTubeDesiredStateRecipe(recipe)) {
    throw new Error(
      "YouTube desired-state preparation supports only likes.set, content.save, and relationships.follow.set",
    );
  }
  const bootstrap = await bootstrapYouTube(auth, {
    timeoutMs: recipe.timeoutMs,
    maxOutputBytes: recipe.maxOutputBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return (await prepareDesiredStateWithBootstrap(
    bootstrap,
    recipe,
    input,
  )).preparation;
}

/** Independently observe one exact YouTube desired state for reconciliation. */
export async function readYouTubeWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  } = {},
): Promise<YouTubeWebDesiredStateReadback> {
  const preparation = await prepareYouTubeWebDesiredState(
    recipe,
    input,
    auth,
    options,
  );
  return Object.freeze({
    kind: preparation.kind,
    targetId: preparation.targetId,
    enabled: preparation.actualState,
  });
}

function desiredStateNoOp(
  preparation: YouTubeWebDesiredStatePreparation,
): WebSessionExecution {
  return {
    status: "succeeded",
    output: Object.freeze({
      kind: preparation.kind,
      targetId: preparation.targetId,
      enabled: preparation.desiredState,
      noOp: true,
      effect: "already-satisfied",
    }),
    finalUrl: preparation.kind === "subscription"
      ? `${YOUTUBE_ORIGIN}/channel/${preparation.targetId}`
      : `${YOUTUBE_ORIGIN}/watch?v=${preparation.targetId}`,
    dispatchStarted: false,
    dispatch: { planned: 1, started: 0, verified: 0 },
  };
}

async function executeDesiredState(
  bootstrap: YouTubeBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  const prepared = await prepareDesiredStateWithBootstrap(bootstrap, recipe, input);
  const { kind, targetId, desiredState: desired } = prepared.preparation;
  if (prepared.preparation.alreadyDesired) {
    return desiredStateNoOp(prepared.preparation);
  }
  let started = 0;
  let verified = 0;
  try {
    if (kind === "like") {
      const mutation = youtubeLikeMutationRequest(
        prepared.commandSource,
        targetId,
        desired,
      );
      await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
      started = 1;
      await innertube(
        bootstrap,
        mutation.endpoint,
        mutation.body,
        "YouTube like mutation",
      );
    } else if (kind === "watch-later") {
      await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
      started = 1;
      await innertube(
        bootstrap,
        "playlist/edit",
        {
          playlistId: "WL",
          actions: [{
            action: desired ? "ACTION_ADD_VIDEO" : "ACTION_REMOVE_VIDEO",
            ...(desired ? { addedVideoId: targetId } : { removedVideoId: targetId }),
          }],
        },
        "YouTube Watch Later mutation",
      );
    } else {
      const mutation = youtubeSubscriptionMutationRequest(
        prepared.commandSource,
        targetId,
        desired,
      );
      await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
      started = 1;
      await innertube(
        bootstrap,
        mutation.endpoint,
        mutation.body,
        "YouTube subscription mutation",
      );
    }
    const actual = kind === "like"
      ? await likeReadback(bootstrap, targetId)
      : kind === "watch-later"
        ? await saveReadback(bootstrap, targetId)
        : await followReadback(bootstrap, targetId);
    if (actual !== desired) throw new Error("YouTube desired-state readback did not match the confirmed state");
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, started, verified));
    return {
      status: "succeeded",
      output: { kind, targetId, enabled: desired },
      finalUrl: kind === "subscription"
        ? `${YOUTUBE_ORIGIN}/channel/${targetId}`
        : `${YOUTUBE_ORIGIN}/watch?v=${targetId}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: kind === "subscription"
        ? `${YOUTUBE_ORIGIN}/channel/${targetId}`
        : `${YOUTUBE_ORIGIN}/watch?v=${targetId}`,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "YouTube may have changed the requested state but exact readback was not verified; reconcile before retrying"
        : "YouTube desired-state dispatch failed before submission",
    };
  }
}

export async function executeYouTubeWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site === "youtube"
    && recipe.contractVersion === 1
    && [
      "content.save",
      "likes.set",
      "relationships.follow.set",
    ].includes(recipe.action)
  ) {
    throw new Error(
      `YouTube authenticated web operation ${recipe.action} is capture-required until an authorized low-stakes live fixture passes`,
    );
  }
  if (
    recipe.site !== "youtube"
    || recipe.contractVersion !== 1
    || ![
      "comments.read",
      "content.save",
      "feeds.read",
      "likes.set",
      "media.read",
      "posts.read",
      "profiles.read",
      "relationships.follow.set",
    ].includes(recipe.action)
  ) {
    throw new Error(`YouTube authenticated web operation ${recipe.action} has no executable reviewed contract`);
  }
  const bootstrap = await bootstrapYouTube(auth, {
    timeoutMs: recipe.timeoutMs,
    maxOutputBytes: recipe.maxOutputBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  if (recipe.action === "feeds.read") return executeFeed(bootstrap, input);
  if (recipe.action === "media.read") return executeMediaRead(bootstrap, input);
  if (recipe.action === "posts.read") return executePostRead(bootstrap, input);
  if (recipe.action === "profiles.read") return executeProfileRead(bootstrap, input);
  if (recipe.action === "comments.read") return executeCommentsRead(bootstrap, input);
  if (
    recipe.action === "likes.set"
    || recipe.action === "content.save"
    || recipe.action === "relationships.follow.set"
  ) return executeDesiredState(bootstrap, recipe, input, options);
  throw new Error(`YouTube authenticated web operation ${recipe.action} has no executable reviewed contract`);
}
