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
  HACKER_NEWS_WEB_OPERATION_NAMES,
  HACKER_NEWS_WEB_OPERATIONS,
  authorizeHackerNewsReadRequest,
  normalizeHackerNewsCommentsHtml,
  normalizeHackerNewsFeedHtml,
  normalizeHackerNewsPostHtml,
  parseHackerNewsViewerHtml,
  type HackerNewsWebOperationName,
} from "./hacker-news-web";

const HN_ORIGIN = "https://news.ycombinator.com";
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_FEED_LIMIT = 30;
const DEFAULT_COMMENT_LIMIT = 100;

export type HackerNewsWebRuntimeDependencies = Partial<WebSessionNetworkDependencies>;

function isHackerNewsOperation(value: string): value is HackerNewsWebOperationName {
  return (HACKER_NEWS_WEB_OPERATION_NAMES as readonly string[]).includes(value);
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

function itemIdInput(input: OperationInput, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) {
    throw new Error(`input.${name} must be a decimal Hacker News item ID`);
  }
  return value;
}

function readHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "text/html",
    referer: `${HN_ORIGIN}/`,
  });
}

async function readNews(
  client: WebSessionClient,
  operation: "viewer.current" | "feeds.read",
  maximumBytes: number,
): Promise<string> {
  const url = new URL("/news", HN_ORIGIN);
  authorizeHackerNewsReadRequest({
    operation,
    url,
    method: "GET",
  });
  return client.requestText({
    url,
    headers: readHeaders(),
    expectedContentTypes: ["text/html"],
    maxBytes: Math.min(maximumBytes, MAX_HTML_BYTES),
  });
}

function assertBoundViewer(auth: WrenchAuth, username: string): string {
  const expected = webSessionAuthSubject(auth);
  if (
    expected === null
    || !/^hacker-news:[A-Za-z0-9_-]{1,64}$/u.test(expected)
  ) {
    throw new Error("Hacker News authenticated operations require an auth locator bound to an exact hacker-news:<username> subject");
  }
  if (`hacker-news:${username}` !== expected) {
    throw new Error("Hacker News browser session viewer no longer matches the confirmed auth subject");
  }
  return expected;
}

export async function probeHackerNewsWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: HackerNewsWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(HN_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const username = parseHackerNewsViewerHtml(await readNews(
    client,
    "viewer.current",
    MAX_HTML_BYTES,
  ));
  return `hacker-news:${username}`;
}

async function readItemPage(
  client: WebSessionClient,
  operation: "posts.read" | "comments.read",
  itemId: string,
  maximumBytes: number,
): Promise<string> {
  const url = new URL("/item", HN_ORIGIN);
  url.searchParams.set("id", itemId);
  authorizeHackerNewsReadRequest({
    operation,
    url,
    method: "GET",
    targetId: itemId,
  });
  return client.requestText({
    url,
    headers: readHeaders(),
    expectedContentTypes: ["text/html"],
    maxBytes: Math.min(maximumBytes, MAX_HTML_BYTES),
  });
}

export async function executeHackerNewsWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: HackerNewsWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "hacker-news"
    || recipe.contractVersion !== 1
    || !isHackerNewsOperation(recipe.action)
  ) throw new Error("Hacker News authenticated web recipe is not installed");
  const contract = HACKER_NEWS_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(`Hacker News authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`);
  }
  if (
    recipe.action !== "feeds.read"
    && recipe.action !== "posts.read"
    && recipe.action !== "comments.read"
  ) throw new Error(`Hacker News authenticated web operation ${recipe.action} has no executable reviewed contract`);

  const client = await createWebSessionClient(HN_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const newsHtml = await readNews(
    client,
    recipe.action === "feeds.read" ? "feeds.read" : "viewer.current",
    recipe.maxOutputBytes,
  );
  assertBoundViewer(auth, parseHackerNewsViewerHtml(newsHtml));
  // R1 operations never enter the mutation dispatch ledger.
  void options.beforeDispatch;
  void options.afterDispatchVerified;

  if (recipe.action === "feeds.read") {
    if (input.feed !== "news") throw new Error("input.feed must be the observed Hacker News news feed");
    const limit = integerInput(input, "limit", DEFAULT_FEED_LIMIT, 1, 30);
    return {
      status: "succeeded",
      output: normalizeHackerNewsFeedHtml(newsHtml, limit),
      finalUrl: `${HN_ORIGIN}/news`,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    };
  }

  const idName = recipe.action === "posts.read" ? "item_id" : "post_id";
  const targetId = itemIdInput(input, idName);
  const itemHtml = await readItemPage(
    client,
    recipe.action,
    targetId,
    recipe.maxOutputBytes,
  );
  const output = recipe.action === "posts.read"
    ? normalizeHackerNewsPostHtml(itemHtml, targetId)
    : normalizeHackerNewsCommentsHtml(
        itemHtml,
        targetId,
        integerInput(input, "limit", DEFAULT_COMMENT_LIMIT, 1, 100),
      );
  return {
    status: "succeeded",
    output,
    finalUrl: `${HN_ORIGIN}/item?id=${targetId}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
