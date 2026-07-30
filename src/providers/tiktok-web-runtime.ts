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
  TIKTOK_WEB_OPERATION_NAMES,
  TIKTOK_WEB_OPERATIONS,
  authorizeTikTokWebR1Request,
  enforceTikTokWebHeaderSinkPolicy,
  normalizeTikTokWebCommentsResponse,
  normalizeTikTokWebFeedResponse,
  parseTikTokWebViewerResponse,
  type TikTokWebOperationName,
  type TikTokWebViewer,
} from "./tiktok-web";

const TIKTOK_ORIGIN = "https://www.tiktok.com";
const MAX_VIEWER_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_FEED_LIMIT = 20;
const DEFAULT_COMMENT_LIMIT = 20;

export type TikTokWebRuntimeDependencies = Partial<WebSessionNetworkDependencies>;

function isTikTokOperation(value: string): value is TikTokWebOperationName {
  return (TIKTOK_WEB_OPERATION_NAMES as readonly string[]).includes(value);
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

function stringInput(input: OperationInput, name: string, pattern: RegExp, label: string): string {
  const value = input[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`input.${name} must be ${label}`);
  return value;
}

function exactReadHeaders(referer: "https://www.tiktok.com/" | "https://www.tiktok.com/foryou"): Readonly<Record<string, string>> {
  return enforceTikTokWebHeaderSinkPolicy({
    source: "code",
    sink: "network-request",
    headers: {
      accept: "application/json, text/plain, */*",
      referer,
    },
  });
}

async function currentViewer(
  client: WebSessionClient,
  maximumBytes = MAX_VIEWER_BYTES,
): Promise<TikTokWebViewer> {
  const url = new URL("/api/user/detail/self/", TIKTOK_ORIGIN);
  authorizeTikTokWebR1Request({
    operation: "viewer.current",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders("https://www.tiktok.com/"),
    maxBytes: Math.min(maximumBytes, MAX_VIEWER_BYTES),
  });
  return parseTikTokWebViewerResponse(response);
}

function viewerSubject(viewer: TikTokWebViewer): string {
  return `tiktok:uid:${viewer.id}/sec:${viewer.secUid}`;
}

export async function probeTikTokWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: TikTokWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(TIKTOK_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await currentViewer(client);
  return viewerSubject(viewer);
}

async function requireBoundViewer(
  client: WebSessionClient,
  auth: WrenchAuth,
): Promise<TikTokWebViewer> {
  const expected = webSessionAuthSubject(auth);
  if (expected === null || !/^tiktok:uid:[0-9]{1,32}\/sec:[A-Za-z0-9._-]{16,256}$/u.test(expected)) {
    throw new Error("TikTok personalized operations require an auth locator bound to the exact viewer subject");
  }
  const viewer = await currentViewer(client);
  if (viewerSubject(viewer) !== expected) {
    throw new Error("TikTok browser session viewer no longer matches the confirmed auth subject");
  }
  return viewer;
}

async function readForYou(
  client: WebSessionClient,
  input: OperationInput,
  maximumBytes: number,
): Promise<unknown> {
  if (input.feed !== "for-you") {
    throw new Error("input.feed must be the observed signer-free for-you feed");
  }
  const limit = integerInput(input, "limit", DEFAULT_FEED_LIMIT, 1, 30);
  const url = new URL("/api/recommend/item_list/", TIKTOK_ORIGIN);
  url.searchParams.set("aid", "1988");
  url.searchParams.set("count", String(limit));
  authorizeTikTokWebR1Request({
    operation: "feeds.for-you",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders("https://www.tiktok.com/foryou"),
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return normalizeTikTokWebFeedResponse(response, limit);
}

async function readComments(
  client: WebSessionClient,
  input: OperationInput,
  maximumBytes: number,
): Promise<unknown> {
  const postId = stringInput(input, "post_id", /^[0-9]{1,32}$/u, "a decimal TikTok post ID");
  const cursor = integerInput(input, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerInput(input, "limit", DEFAULT_COMMENT_LIMIT, 1, 50);
  const url = new URL("/api/comment/list/", TIKTOK_ORIGIN);
  url.searchParams.set("aid", "1988");
  url.searchParams.set("aweme_id", postId);
  url.searchParams.set("count", String(limit));
  url.searchParams.set("cursor", String(cursor));
  authorizeTikTokWebR1Request({
    operation: "comments.list",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders("https://www.tiktok.com/foryou"),
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return normalizeTikTokWebCommentsResponse(response, postId, limit);
}

export async function executeTikTokWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: TikTokWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (recipe.site !== "tiktok" || recipe.contractVersion !== 1 || !isTikTokOperation(recipe.action)) {
    throw new Error("TikTok authenticated web recipe is not installed");
  }
  const contract = TIKTOK_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(`TikTok authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`);
  }
  if (recipe.action !== "feeds.read" && recipe.action !== "comments.read") {
    throw new Error(`TikTok authenticated web operation ${recipe.action} has no executable reviewed contract`);
  }
  // R1 operations never enter a dispatch ledger or invoke mutation callbacks.
  void options.beforeDispatch;
  void options.afterDispatchVerified;
  const client = await createWebSessionClient(TIKTOK_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  await requireBoundViewer(client, auth);
  const output = recipe.action === "feeds.read"
    ? await readForYou(client, input, recipe.maxOutputBytes)
    : await readComments(client, input, recipe.maxOutputBytes);
  return {
    status: "succeeded",
    output,
    finalUrl: recipe.action === "feeds.read"
      ? `${TIKTOK_ORIGIN}/foryou`
      : TIKTOK_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
