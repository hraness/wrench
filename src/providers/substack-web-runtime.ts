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
  SUBSTACK_WEB_OPERATION_NAMES,
  SUBSTACK_WEB_OPERATIONS,
  authorizeSubstackWebReadRequest,
  normalizeSubstackArticleResponse,
  normalizeSubstackCommentsResponse,
  normalizeSubstackFeedResponse,
  normalizeSubstackMediaResponse,
  normalizeSubstackMessageInbox,
  normalizeSubstackNoteResponse,
  parseSubstackLoggedInResponse,
  parseSubstackPreloadsHtml,
  type SubstackFeedName,
  type SubstackWebOperationName,
  type SubstackWebViewer,
} from "./substack-web";

const SUBSTACK_ORIGIN = "https://substack.com";
const MAX_BOOTSTRAP_BYTES = 8 * 1024 * 1024;
const MAX_LOGIN_BYTES = 256 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 20;

export type SubstackWebRuntimeDependencies = Partial<WebSessionNetworkDependencies>;

function isSubstackOperation(value: string): value is SubstackWebOperationName {
  return (SUBSTACK_WEB_OPERATION_NAMES as readonly string[]).includes(value);
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

function positiveIdInput(input: OperationInput, name: string): number {
  return integerInput(input, name, Number.NaN, 1, Number.MAX_SAFE_INTEGER);
}

function optionalStringInput(
  input: OperationInput,
  name: string,
  maximum: number,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`input.${name} must be bounded text`);
  return value;
}

function jsonHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    referer: `${SUBSTACK_ORIGIN}/`,
  });
}

function htmlHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "text/html",
    referer: `${SUBSTACK_ORIGIN}/`,
  });
}

async function currentViewer(
  client: WebSessionClient,
  maximumBytes = MAX_BOOTSTRAP_BYTES,
): Promise<SubstackWebViewer> {
  const loggedInUrl = new URL("/api/v1/am_i_logged_in", SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: "viewer.logged-in",
    url: loggedInUrl,
    method: "GET",
  });
  parseSubstackLoggedInResponse(await client.requestJson({
    url: loggedInUrl,
    method: "GET",
    headers: jsonHeaders(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_LOGIN_BYTES),
  }));

  const rootUrl = new URL("/", SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: "viewer.root",
    url: rootUrl,
    method: "GET",
  });
  const html = await client.requestText({
    url: rootUrl,
    headers: htmlHeaders(),
    expectedContentTypes: ["text/html"],
    maxBytes: Math.min(maximumBytes, MAX_BOOTSTRAP_BYTES),
  });
  return parseSubstackPreloadsHtml(html);
}

function viewerSubject(viewer: SubstackWebViewer): string {
  return `substack:${viewer.id}`;
}

export async function probeSubstackWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: SubstackWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(SUBSTACK_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return viewerSubject(await currentViewer(client));
}

async function requireBoundViewer(
  client: WebSessionClient,
  auth: WrenchAuth,
  maximumBytes: number,
): Promise<SubstackWebViewer> {
  const expected = webSessionAuthSubject(auth);
  if (expected === null || !/^substack:[0-9]{1,32}$/u.test(expected)) {
    throw new Error(
      "Substack authenticated operations require an auth locator bound to an exact substack:<user-id> subject",
    );
  }
  const viewer = await currentViewer(client, maximumBytes);
  if (viewerSubject(viewer) !== expected) {
    throw new Error("Substack browser session viewer no longer matches the confirmed auth subject");
  }
  return viewer;
}

function boundedMaximum(recipe: WebSessionRecipe): number {
  return Math.min(recipe.maxOutputBytes, MAX_READ_BYTES);
}

function feedName(input: OperationInput): SubstackFeedName {
  const value = input.feed;
  if (value !== "notes" && value !== "inbox" && value !== "reader-posts") {
    throw new Error("input.feed must name notes, inbox, or reader-posts");
  }
  return value;
}

async function readFeed(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const feed = feedName(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const request = {
    notes: {
      operation: "feeds.reader" as const,
      path: "/api/v1/reader/feed",
    },
    inbox: {
      operation: "feeds.inbox" as const,
      path: "/api/v1/inbox/top",
    },
    "reader-posts": {
      operation: "feeds.posts" as const,
      path: "/api/v1/reader/posts",
    },
  }[feed];
  const url = new URL(request.path, SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: request.operation,
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackFeedResponse(response, feed, limit);
}

async function readNote(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const noteId = positiveIdInput(input, "note_id");
  const url = new URL(`/api/v1/reader/comment/${noteId}`, SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: "posts.note",
    url,
    method: "GET",
    targetId: noteId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackNoteResponse(response, noteId);
}

async function articleResponse(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  articleId: number,
  operation: "articles.read" | "media.read",
): Promise<unknown> {
  const url = new URL(`/api/v1/posts/by-id/${articleId}`, SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation,
    url,
    method: "GET",
    targetId: articleId,
  });
  return client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
}

async function readArticle(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  media: boolean,
): Promise<unknown> {
  const articleId = positiveIdInput(input, "article_id");
  const response = await articleResponse(
    client,
    recipe,
    articleId,
    media ? "media.read" : "articles.read",
  );
  return media
    ? normalizeSubstackMediaResponse(response, articleId)
    : normalizeSubstackArticleResponse(response, articleId);
}

async function readComments(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const articleId = positiveIdInput(input, "article_id");
  const publicationId = positiveIdInput(input, "publication_id");
  const limit = integerInput(input, "limit", 50, 1, 100);

  // Bind the caller-supplied publication before requesting its reply tree.
  const article = normalizeSubstackArticleResponse(
    await articleResponse(client, recipe, articleId, "articles.read"),
    articleId,
  ) as {
    readonly post: { readonly publicationId: number };
  };
  if (article.post.publicationId !== publicationId) {
    throw new Error("input.publication_id did not match the requested Substack article");
  }

  const url = new URL(`/api/v1/reader/post/${articleId}/replies`, SUBSTACK_ORIGIN);
  url.searchParams.set("publication_id", String(publicationId));
  const cursor = optionalStringInput(input, "cursor", 4_096);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  authorizeSubstackWebReadRequest({
    operation: "comments.read",
    url,
    method: "GET",
    targetId: articleId,
    publicationId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackCommentsResponse(response, articleId, limit);
}

type MessageFolder = "all" | "people" | "unread";

function messageFolder(input: OperationInput): MessageFolder {
  const value = input.folder;
  if (value !== "all" && value !== "people" && value !== "unread") {
    throw new Error("input.folder must name all, people, or unread");
  }
  return value;
}

async function listMessages(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const folder = messageFolder(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const url = new URL("/api/v1/messages/inbox", SUBSTACK_ORIGIN);
  url.searchParams.set("tab", folder);
  const cursor = optionalStringInput(input, "cursor", 4_096);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  authorizeSubstackWebReadRequest({
    operation: "messages.list",
    url,
    method: "GET",
    folder,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackMessageInbox(response, folder, limit);
}

export async function executeSubstackWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: SubstackWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "substack"
    || recipe.contractVersion !== 1
    || !isSubstackOperation(recipe.action)
  ) throw new Error("Substack authenticated web recipe is not installed");
  const contract = SUBSTACK_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(
      `Substack authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`,
    );
  }
  if (
    recipe.action !== "feeds.read"
    && recipe.action !== "posts.read"
    && recipe.action !== "articles.read"
    && recipe.action !== "comments.read"
    && recipe.action !== "media.read"
    && recipe.action !== "messaging.list"
  ) throw new Error(`Substack authenticated web operation ${recipe.action} has no executable reviewed contract`);

  const client = await createWebSessionClient(SUBSTACK_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  await requireBoundViewer(client, auth, recipe.maxOutputBytes);
  // All executable Substack contracts are R1 reads and never enter the
  // mutation dispatch ledger.
  void options.beforeDispatch;
  void options.afterDispatchVerified;

  let output: unknown;
  switch (recipe.action) {
    case "feeds.read":
      output = await readFeed(client, recipe, input);
      break;
    case "posts.read":
      output = await readNote(client, recipe, input);
      break;
    case "articles.read":
      output = await readArticle(client, recipe, input, false);
      break;
    case "comments.read":
      output = await readComments(client, recipe, input);
      break;
    case "media.read":
      output = await readArticle(client, recipe, input, true);
      break;
    case "messaging.list":
      output = await listMessages(client, recipe, input);
      break;
  }
  return {
    status: "succeeded",
    output,
    finalUrl: SUBSTACK_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
