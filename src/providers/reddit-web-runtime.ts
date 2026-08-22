import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  createWebSessionClient,
  webSessionAuthSubject,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  REDDIT_WEB_OPERATION_NAMES,
  REDDIT_WEB_OPERATIONS,
  assertRedditMutationSuccess,
  authorizeRedditWebRequest,
  normalizeRedditCommentsResponse,
  normalizeRedditFeedResponse,
  normalizeRedditMessageListing,
  normalizeRedditPostResponse,
  parseRedditProfileContributionPage,
  parseRedditThingState,
  parseRedditWebProfileResponse,
  parseRedditWebViewerResponse,
  redditFullname,
  redditPostId,
  type RedditWebOperationName,
  type RedditWebViewer,
} from "./reddit-web";

const REDDIT_ORIGIN = "https://www.reddit.com";
const REDDIT_USER_AGENT = "wrench/1.0 (local authenticated web client)";
const MAX_VIEWER_BYTES = 512 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMIT = 25;
const MAX_PROFILE_OVERVIEW_PAGES = 10;

export type RedditWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly now?: () => number;
};

export type RedditWebDesiredStatePreparation =
  | {
      readonly operation: "content.save";
      readonly thingId: string;
      readonly desiredState: boolean;
      readonly actualState: boolean;
      readonly alreadyDesired: boolean;
    }
  | {
      readonly operation: "reactions.set";
      readonly thingId: string;
      readonly desiredState: boolean | null;
      readonly actualState: boolean | null;
      readonly alreadyDesired: boolean;
    };

export type RedditWebDesiredStateReadback = {
  readonly kind: "saved";
  readonly enabled: boolean;
  readonly thingId: string;
};

function isRedditOperation(value: string): value is RedditWebOperationName {
  return (REDDIT_WEB_OPERATION_NAMES as readonly string[]).includes(value);
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

function stringInput(
  input: OperationInput,
  name: string,
  maximum: number,
): string {
  const value = input[name];
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`input.${name} must be a bounded string`);
  return value;
}

function booleanInput(input: OperationInput, name: string): boolean {
  const value = input[name];
  if (typeof value !== "boolean") throw new Error(`input.${name} must be boolean`);
  return value;
}

function optionalStringInput(
  input: OperationInput,
  name: string,
  maximum: number,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  return stringInput(input, name, maximum);
}

function exactReadHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    referer: `${REDDIT_ORIGIN}/`,
    "user-agent": REDDIT_USER_AGENT,
  });
}

function exactMutationHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    origin: REDDIT_ORIGIN,
    referer: `${REDDIT_ORIGIN}/`,
    "user-agent": REDDIT_USER_AGENT,
  });
}

async function currentViewer(
  client: WebSessionClient,
  maximumBytes = MAX_VIEWER_BYTES,
): Promise<RedditWebViewer> {
  const url = new URL("/api/me.json", REDDIT_ORIGIN);
  authorizeRedditWebRequest({
    operation: "viewer.current",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_VIEWER_BYTES),
  });
  return parseRedditWebViewerResponse(response);
}

function expectedSubject(auth: WrenchAuth): string {
  const subject = webSessionAuthSubject(auth);
  if (subject === null || !/^reddit:t2_[a-z0-9]{1,32}$/u.test(subject)) {
    throw new Error("Reddit authenticated operations require an auth locator bound to an exact reddit:t2_<id> subject");
  }
  return subject;
}

function assertBoundViewer(auth: WrenchAuth, viewer: RedditWebViewer): string {
  const expected = expectedSubject(auth);
  if (`reddit:${viewer.id}` !== expected) {
    throw new Error("Reddit browser session viewer no longer matches the confirmed auth subject");
  }
  return expected;
}

async function requireBoundViewer(
  client: WebSessionClient,
  auth: WrenchAuth,
): Promise<RedditWebViewer> {
  const viewer = await currentViewer(client);
  assertBoundViewer(auth, viewer);
  return viewer;
}

export async function probeRedditWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: RedditWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await currentViewer(client);
  return `reddit:${viewer.id}`;
}

function boundedMaximum(recipe: WebSessionRecipe): number {
  return Math.min(recipe.maxOutputBytes, MAX_READ_BYTES);
}

function profileInput(input: OperationInput): string {
  const value = stringInput(input, "profile", 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error("input.profile must be an exact Reddit profile handle");
  }
  return value;
}

function observedAt(dependencies: RedditWebRuntimeDependencies | undefined): string {
  const now = dependencies?.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    throw new Error("Reddit profile observation time is invalid");
  }
  return new Date(now).toISOString();
}

function exactCount(value: number, window?: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: "available",
    value,
    precision: "exact",
    unit: "count",
    ...(window === undefined ? {} : { window }),
  });
}

const contributionUnavailable = Object.freeze({
  status: "unavailable",
  reason: "not-exposed",
});

async function readProfileAbout(
  client: WebSessionClient,
  profile: string,
  maximumBytes: number,
): Promise<ReturnType<typeof parseRedditWebProfileResponse>> {
  const url = new URL(`/user/${encodeURIComponent(profile)}/about.json`, REDDIT_ORIGIN);
  url.searchParams.set("raw_json", "1");
  authorizeRedditWebRequest({
    operation: "profiles.about",
    url,
    method: "GET",
    profile,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return parseRedditWebProfileResponse(response, profile);
}

async function readVisibleContributionCount(
  client: WebSessionClient,
  profile: string,
  maximumBytes: number,
): Promise<number | null> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PROFILE_OVERVIEW_PAGES; pageNumber += 1) {
    const url = new URL(`/user/${encodeURIComponent(profile)}/overview.json`, REDDIT_ORIGIN);
    url.searchParams.set("limit", "100");
    url.searchParams.set("raw_json", "1");
    if (after !== null) url.searchParams.set("after", after);
    authorizeRedditWebRequest({
      operation: "profiles.overview",
      url,
      method: "GET",
      profile,
    });
    const response = await client.requestJson({
      url,
      method: "GET",
      headers: exactReadHeaders(),
      expectedStatuses: [200],
      expectedContentTypes: ["application/json"],
      maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
    });
    const page = parseRedditProfileContributionPage(response, profile);
    for (const id of page.ids) {
      if (ids.has(id)) throw new Error("Reddit profile overview pagination repeated a contribution");
      ids.add(id);
    }
    if (page.after === null) return ids.size;
    if (cursors.has(page.after)) throw new Error("Reddit profile overview pagination repeated a cursor");
    cursors.add(page.after);
    after = page.after;
  }
  return null;
}

async function readProfile(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  viewer: RedditWebViewer,
  dependencies: RedditWebRuntimeDependencies | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const requestedProfile = profileInput(input);
  if (requestedProfile.toLocaleLowerCase("en-US") !== viewer.username.toLocaleLowerCase("en-US")) {
    throw new Error("Reddit requested profile did not match the bound current account");
  }
  const profile = await readProfileAbout(client, requestedProfile, recipe.maxOutputBytes);
  const contributions = await readVisibleContributionCount(
    client,
    requestedProfile,
    recipe.maxOutputBytes,
  );
  return Object.freeze({
    schemaVersion: 1,
    provider: "reddit",
    target: Object.freeze({
      kind: "profile",
      id: profile.username,
      url: `${REDDIT_ORIGIN}/user/${encodeURIComponent(profile.username)}/`,
    }),
    observedAt: observedAt(dependencies),
    completeness: contributions === null ? "partial" : "complete",
    metrics: Object.freeze({
      followers: exactCount(profile.followers),
      karma: exactCount(profile.karma),
      contributions: contributions === null
        ? contributionUnavailable
        : exactCount(contributions, "visible-overview"),
    }),
    metadata: Object.freeze({
      handle: profile.username,
      ...(profile.displayName === null ? {} : { displayName: profile.displayName }),
      ...(profile.bio === null ? {} : { bio: profile.bio }),
      contributionDefinition:
        "Distinct post and comment IDs in the complete authenticated profile overview listing.",
    }),
  });
}

function afterQuery(input: OperationInput): string | undefined {
  const after = optionalStringInput(input, "after", 40);
  if (after === undefined) return undefined;
  return redditFullname(after, "input.after", ["t1", "t3", "t4"]);
}

async function readFeed(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  if (input.feed !== "home") throw new Error("input.feed must be the observed Reddit home feed");
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const url = new URL("/.json", REDDIT_ORIGIN);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("raw_json", "1");
  const after = afterQuery(input);
  if (after !== undefined) url.searchParams.set("after", after);
  authorizeRedditWebRequest({
    operation: "feeds.home",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeRedditFeedResponse(response, limit);
}

function postInput(input: OperationInput): string {
  return redditPostId(stringInput(input, "post_id", 40), "input.post_id");
}

async function readPostOrComments(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  comments: boolean,
): Promise<unknown> {
  const postId = postInput(input);
  const bare = postId.slice(3);
  const url = new URL(`/comments/${encodeURIComponent(bare)}.json`, REDDIT_ORIGIN);
  let limit = 1;
  if (comments) {
    limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
    url.searchParams.set("depth", "10");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("raw_json", "1");
    url.searchParams.set("sort", "confidence");
  } else {
    url.searchParams.set("limit", "1");
    url.searchParams.set("raw_json", "1");
  }
  authorizeRedditWebRequest({
    operation: comments ? "comments.read" : "posts.read",
    url,
    method: "GET",
    targetId: postId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return comments
    ? normalizeRedditCommentsResponse(response, postId, limit)
    : normalizeRedditPostResponse(response, postId);
}

type RedditMessageFolder = "inbox" | "unread" | "sent";

function messageFolder(input: OperationInput): RedditMessageFolder {
  const value = stringInput(input, "folder", 16);
  if (value !== "inbox" && value !== "unread" && value !== "sent") {
    throw new Error("input.folder must name inbox, unread, or sent");
  }
  return value;
}

async function readMessages(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  single: boolean,
): Promise<unknown> {
  const folder = messageFolder(input);
  const url = new URL(`/message/${folder}.json`, REDDIT_ORIGIN);
  let limit = 1;
  let messageId: string | null = null;
  if (single) {
    messageId = redditFullname(
      stringInput(input, "message_id", 40),
      "input.message_id",
      ["t4"],
    );
    url.searchParams.set("limit", "1");
    url.searchParams.set("mark", "false");
    url.searchParams.set("max_replies", "100");
    url.searchParams.set("mid", messageId);
    url.searchParams.set("raw_json", "1");
  } else {
    limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("mark", "false");
    url.searchParams.set("max_replies", "0");
    url.searchParams.set("raw_json", "1");
    const after = afterQuery(input);
    if (after !== undefined) url.searchParams.set("after", after);
  }
  authorizeRedditWebRequest({
    operation: single ? "messages.read" : "messages.list",
    url,
    method: "GET",
    folder,
    ...(messageId === null ? {} : { targetId: messageId }),
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeRedditMessageListing(response, limit, messageId);
}

async function readThingState(
  client: WebSessionClient,
  targetId: string,
  maximumBytes: number,
) {
  const url = new URL("/api/info.json", REDDIT_ORIGIN);
  url.searchParams.set("id", targetId);
  url.searchParams.set("raw_json", "1");
  authorizeRedditWebRequest({
    operation: "state.readback",
    url,
    method: "GET",
    targetId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return parseRedditThingState(response, targetId);
}

function dispatchEvent(
  id: string,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return {
    id,
    index: 1,
    progress: { planned: 1, started, verified },
  };
}

function desiredReaction(input: OperationInput): -1 | 0 | 1 {
  const value = input.direction;
  if (!Number.isSafeInteger(value)) {
    throw new Error("input.direction must be -1, 0, or 1");
  }
  if (value !== -1 && value !== 0 && value !== 1) {
    throw new Error("input.direction must be -1, 0, or 1");
  }
  return value;
}

function desiredLikedState(direction: -1 | 0 | 1): boolean | null {
  return direction === 1 ? true : direction === -1 ? false : null;
}

async function prepareDesiredStateWithClient(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
): Promise<{
  readonly viewer: RedditWebViewer;
  readonly preparation: RedditWebDesiredStatePreparation;
}> {
  if (
    recipe.site !== "reddit"
    || recipe.contractVersion !== 1
    || (recipe.action !== "content.save" && recipe.action !== "reactions.set")
  ) {
    throw new Error(
      "Reddit desired-state preparation supports only content.save and reactions.set",
    );
  }
  const viewer = await requireBoundViewer(client, auth);
  const thingId = redditFullname(
    stringInput(input, "thing_id", 40),
    "input.thing_id",
    ["t1", "t3"],
  );
  const before = await readThingState(client, thingId, recipe.maxOutputBytes);
  if (recipe.action === "content.save") {
    const desiredState = booleanInput(input, "saved");
    return Object.freeze({
      viewer,
      preparation: Object.freeze({
        operation: "content.save",
        thingId,
        desiredState,
        actualState: before.saved,
        alreadyDesired: before.saved === desiredState,
      }),
    });
  }
  const direction = desiredReaction(input);
  const desiredState = desiredLikedState(direction);
  return Object.freeze({
    viewer,
    preparation: Object.freeze({
      operation: "reactions.set",
      thingId,
      desiredState,
      actualState: before.liked,
      alreadyDesired: before.liked === desiredState,
    }),
  });
}

/**
 * Perform only the account and exact-target reads that precede a Reddit
 * desired-state write. The helper never constructs a mutation request or
 * enters the dispatch boundary, so capture-required execution stays inert.
 */
export async function prepareRedditWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<RedditWebDesiredStatePreparation> {
  if (
    recipe.site !== "reddit"
    || recipe.contractVersion !== 1
    || (recipe.action !== "content.save" && recipe.action !== "reactions.set")
  ) {
    throw new Error(
      "Reddit desired-state preparation supports only content.save and reactions.set",
    );
  }
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return (await prepareDesiredStateWithClient(
    client,
    recipe,
    input,
    auth,
  )).preparation;
}

/** Independently read one exact Reddit saved state for reconciliation. */
export async function readRedditWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<RedditWebDesiredStateReadback> {
  if (
    recipe.site !== "reddit"
    || recipe.contractVersion !== 1
    || recipe.action !== "content.save"
  ) {
    throw new Error("Reddit recovery readback supports only content.save");
  }
  const preparation = await prepareRedditWebDesiredState(
    recipe,
    input,
    auth,
    options,
  );
  if (preparation.operation !== "content.save") {
    throw new Error("Reddit saved-state readback changed operation kind");
  }
  return Object.freeze({
    kind: "saved",
    enabled: preparation.actualState,
    thingId: preparation.thingId,
  });
}

function desiredStateNoOp(
  preparation: RedditWebDesiredStatePreparation,
): WebSessionExecution {
  const desired = preparation.operation === "content.save"
    ? { saved: preparation.desiredState }
    : {
      direction: preparation.desiredState === true
        ? 1
        : preparation.desiredState === false ? -1 : 0,
    };
  return {
    status: "succeeded",
    output: Object.freeze({
      thingId: preparation.thingId,
      desired: Object.freeze(desired),
      noOp: true,
      effect: "already-satisfied",
    }),
    finalUrl: REDDIT_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 1, started: 0, verified: 0 },
  };
}

async function executeDesiredState(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  const prepared = await prepareDesiredStateWithClient(client, recipe, input, auth);
  const initialViewer = prepared.viewer;
  const targetId = prepared.preparation.thingId;
  const save = recipe.action === "content.save";
  const direction = save ? null : desiredReaction(input);
  const saved = save ? booleanInput(input, "saved") : null;
  if (prepared.preparation.alreadyDesired) {
    return desiredStateNoOp(prepared.preparation);
  }

  let started = 0;
  let verified = 0;
  try {
    // Fetch a second, immediately pre-dispatch account record. This both
    // re-binds the actor and prevents reuse of a stale listing modhash.
    const freshViewer = await currentViewer(client);
    assertBoundViewer(auth, freshViewer);
    if (freshViewer.id !== initialViewer.id) {
      throw new Error("Reddit viewer changed during desired-state preparation");
    }
    const url = new URL(
      save ? (saved ? "/api/save" : "/api/unsave") : "/api/vote",
      REDDIT_ORIGIN,
    );
    const form = new URLSearchParams();
    if (!save) form.set("dir", String(direction));
    form.set("id", targetId);
    form.set("uh", freshViewer.modhash);
    const body = form.toString();
    authorizeRedditWebRequest({
      operation: save ? "content.save" : "reactions.set",
      url,
      method: "POST",
      body,
      targetId,
      ...(save ? { saved: saved! } : { direction: direction! }),
    });
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
    started = 1;
    const mutation = await client.requestJson({
      url,
      method: "POST",
      headers: exactMutationHeaders(),
      body,
      expectedStatuses: [200],
      expectedContentTypes: ["application/json"],
      maxBytes: Math.min(recipe.maxOutputBytes, 512 * 1024),
    });
    assertRedditMutationSuccess(mutation);
    const after = await readThingState(client, targetId, recipe.maxOutputBytes);
    if (save ? after.saved !== saved : after.liked !== desiredLikedState(direction!)) {
      throw new Error("Reddit desired-state readback did not match the confirmed state");
    }
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1));
    return {
      status: "succeeded",
      output: Object.freeze({
        thingId: targetId,
        desired: save ? { saved } : { direction },
        noOp: false,
        previouslyDesired: false,
      }),
      finalUrl: REDDIT_ORIGIN,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: REDDIT_ORIGIN,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "Reddit may have changed the requested state but exact readback was not verified; reconcile before retrying"
        : "Reddit desired-state dispatch failed before submission",
    };
  }
}

export async function executeRedditWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (recipe.site !== "reddit" || recipe.contractVersion !== 1 || !isRedditOperation(recipe.action)) {
    throw new Error("Reddit authenticated web recipe is not installed");
  }
  const contract = REDDIT_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(`Reddit authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`);
  }
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  if (recipe.action === "reactions.set" || recipe.action === "content.save") {
    return executeDesiredState(client, recipe, input, auth, options);
  }

  const viewer = await requireBoundViewer(client, auth);
  // R1 operations never enter the mutation dispatch ledger.
  void options.beforeDispatch;
  void options.afterDispatchVerified;
  const output = recipe.action === "profiles.read"
    ? await readProfile(client, recipe, input, viewer, options.dependencies)
    : recipe.action === "feeds.read"
      ? await readFeed(client, recipe, input)
    : recipe.action === "posts.read"
      ? await readPostOrComments(client, recipe, input, false)
      : recipe.action === "comments.read"
        ? await readPostOrComments(client, recipe, input, true)
        : recipe.action === "messaging.list"
          ? await readMessages(client, recipe, input, false)
          : recipe.action === "messaging.read"
            ? await readMessages(client, recipe, input, true)
            : (() => {
                throw new Error(`Reddit authenticated web operation ${recipe.action} has no executable reviewed contract`);
              })();
  return {
    status: "succeeded",
    output,
    finalUrl: recipe.action === "profiles.read"
      ? `${REDDIT_ORIGIN}/user/${encodeURIComponent(profileInput(input))}/`
      : recipe.action === "feeds.read"
      ? REDDIT_ORIGIN
      : recipe.action === "posts.read" || recipe.action === "comments.read"
        ? `${REDDIT_ORIGIN}/comments/${postInput(input).slice(3)}/`
        : `${REDDIT_ORIGIN}/message/${messageFolder(input)}/`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
