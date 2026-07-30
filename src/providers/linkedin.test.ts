import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OAuthTokenAuth } from "../provider-http";
import { ProviderHttpClient, requireOAuthScopes, type ProviderFetch } from "../provider-http";
import { getProviderContract as getProviderContractWithRegistry } from "../provider-contracts";
import { providerPluginRegistry } from "../provider-plugins";
import type { ProviderActionContext, ProviderFile } from "../provider";
import type {
  OperationInput,
  ProviderRecipe,
  WrenchManifest,
} from "../model";
import { executeLinkedInProvider } from "./linkedin";

const getProviderContract = (
  recipe: Parameters<typeof getProviderContractWithRegistry>[0],
) => getProviderContractWithRegistry(recipe, providerPluginRegistry);

const ACCESS_TOKEN = "linkedin-secret-access-token";
const MEMBER = "urn:li:person:member_123";
const ORGANIZATION = "urn:li:organization:12345";
const POST = "urn:li:ugcPost:7000000000000000001";
const SHARE = "urn:li:share:7000000000000000002";
const ACTIVITY = "urn:li:activity:7000000000000000003";
const COMMENT = `urn:li:comment:(${ACTIVITY},7000000000000000004)`;
const CHILD_COMMENT = `urn:li:comment:(${ACTIVITY},7000000000000000005)`;

function reactionUrn(actor: string, target: string): string {
  return `urn:li:reaction:(${actor},${target})`;
}

type LinkedInAction =
  | "posts.read"
  | "posts.publish"
  | "posts.repost"
  | "comments.read"
  | "comments.create"
  | "replies.create"
  | "reactions.set";

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly textBody: string | null;
  readonly byteBody: Uint8Array | null;
};

type QueuedResponse = {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function response(entry: QueuedResponse): Response {
  return new Response(entry.body === undefined ? null : JSON.stringify(entry.body), {
    status: entry.status,
    ...(entry.headers === undefined ? {} : { headers: entry.headers }),
  });
}

function captureBody(body: RequestInit["body"] | null | undefined): {
  readonly textBody: string | null;
  readonly byteBody: Uint8Array | null;
} {
  if (body === null || body === undefined) return { textBody: null, byteBody: null };
  if (typeof body === "string") return { textBody: body, byteBody: null };
  if (body instanceof ArrayBuffer) {
    return { textBody: null, byteBody: new Uint8Array(body.slice(0)) };
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { textBody: null, byteBody: Uint8Array.from(bytes) };
  }
  throw new Error("test fetch received an unsupported request body");
}

function fakeFetch(entries: readonly QueuedResponse[]): {
  readonly fetch: ProviderFetch;
  readonly requests: CapturedRequest[];
} {
  const queue = [...entries];
  const requests: CapturedRequest[] = [];
  const fetch_: ProviderFetch = (input, init = {}) => {
    const captured = captureBody(init.body);
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      ...captured,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error("test fetch response queue is empty");
    return Promise.resolve(response(next));
  };
  return { fetch: fetch_, requests };
}

function manifest(): WrenchManifest {
  return {
    schemaVersion: 3,
    id: "linkedin-official",
    version: "1.0.0",
    displayName: "LinkedIn official API",
    surfaceId: "linkedin",
    origins: ["https://www.linkedin.com"],
    browserDomains: ["www.linkedin.com"],
    operations: {},
  };
}

function harness(
  action: LinkedInAction,
  input: OperationInput,
  fetch_: ProviderFetch,
  options: {
    readonly scopes: readonly string[];
    readonly subject?: string;
    readonly files?: readonly ProviderFile[];
    readonly beforeDispatch?: () => void | Promise<void>;
    readonly timeoutMs?: number;
  },
): {
  readonly context: ProviderActionContext;
  readonly output: () => unknown;
  readonly finalUrl: () => string | null;
  readonly dispatches: () => number;
} {
  const recipe: ProviderRecipe = {
    provider: "linkedin",
    action,
    contractVersion: 1,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: 1024 * 1024,
  };
  const contract = getProviderContract(recipe);
  const auth: OAuthTokenAuth = {
    schemaVersion: 1,
    id: "linkedin-test",
    kind: "oauth-token-file",
    provider: "linkedin",
    path: "/private/linkedin-token.json",
    scopes: [...options.scopes].sort(),
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  };
  let output: unknown = null;
  let finalUrl: string | null = null;
  let dispatches = 0;
  const beginDispatch = async (): Promise<{
    readonly verify: () => Promise<void>;
  }> => {
    await options.beforeDispatch?.();
    dispatches += 1;
    let verified = false;
    return {
      verify: () => {
        if (verified) throw new Error("test dispatch was verified twice");
        verified = true;
        return Promise.resolve();
      },
    };
  };
  const context: ProviderActionContext = {
    manifest: manifest(),
    recipe,
    contract,
    input,
    auth,
    token: { accessToken: ACCESS_TOKEN, expiresAt: null },
    http: new ProviderHttpClient(fetch_, recipe.timeoutMs, recipe.maxOutputBytes),
    environment: {},
    signal: new AbortController().signal,
    remainingTimeMs: () => recipe.timeoutMs,
    resolveFiles: (inputName) => {
      if (inputName !== "media") throw new Error("test received an unexpected file input name");
      return Promise.resolve(options.files ?? []);
    },
    beginDispatch,
    dispatch: async (action_) => {
      const boundary = await beginDispatch();
      const result = await action_();
      await boundary.verify();
      return result;
    },
    addRequiredScopes: (scopes) => requireOAuthScopes(auth, contract.requiredScopeSets, scopes),
    setOutput: (value) => { output = value; },
    setFinalUrl: (value) => { finalUrl = value; },
  };
  return {
    context,
    output: () => output,
    finalUrl: () => finalUrl,
    dispatches: () => dispatches,
  };
}

function jsonRequestBody(request: CapturedRequest): unknown {
  if (request.textBody === null) throw new Error("expected a JSON request body");
  return JSON.parse(request.textBody) as unknown;
}

function privateFile(bytes: Uint8Array, mediaType: string): ProviderFile {
  const directory = mkdtempSync(join(tmpdir(), "wrench-linkedin-provider-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "asset");
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    value: { kind: "file", reference: "sf1:test" },
    path,
    bytes: bytes.byteLength,
    mediaType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validVideoBytes(): Uint8Array {
  return Uint8Array.from({ length: 75_000 }, (_value, index) => index % 251);
}

function assertLinkedInApiHeaders(request: CapturedRequest): void {
  expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request.headers.get("linkedin-version")).toBe("202606");
  expect(request.headers.get("x-restli-protocol-version")).toBe("2.0.0");
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

describe("official LinkedIn provider reads", () => {
  test("reads one encoded post with fixed 202606 headers and a normalized result", async () => {
    const fake = fakeFetch([{
      status: 200,
      body: {
        id: POST,
        author: MEMBER,
        commentary: "Hello",
        visibility: "PUBLIC",
        lifecycleState: "PUBLISHED",
        createdAt: 100,
        content: { article: { source: "https://example.com" } },
      },
    }]);
    const run = harness("posts.read", {
      mode: "one",
      post_urn: POST,
      view: "AUTHOR",
    }, fake.fetch, { scopes: ["r_member_social"] });

    await executeLinkedInProvider(run.context);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe(
      "https://api.linkedin.com/rest/posts/urn%3Ali%3AugcPost%3A7000000000000000001?viewContext=AUTHOR",
    );
    expect(fake.requests[0]?.method).toBe("GET");
    assertLinkedInApiHeaders(fake.requests[0] as CapturedRequest);
    expect(run.output()).toMatchObject({
      provider: "linkedin",
      operation: "posts.read",
      coverage: "post",
      completeness: "complete",
      cursor: null,
      item: { id: POST, author: MEMBER, commentary: "Hello" },
    });
    expect(run.finalUrl()).toBe(`https://www.linkedin.com/feed/update/${POST}/`);
    expect(run.dispatches()).toBe(0);
    expect(JSON.stringify(run.output())).not.toContain(ACCESS_TOKEN);
  });

  test("lists one bounded author page with an explicit offset cursor and finder scope", async () => {
    const fake = fakeFetch([{
      status: 200,
      body: {
        paging: {
          start: 20,
          count: 2,
          links: [{
            rel: "next",
            href: "https://api.linkedin.com/rest/posts?author=urn%3Ali%3Aorganization%3A12345&q=author&start=22&count=2&sortBy=CREATED&viewContext=READER",
          }],
        },
        elements: [
          { id: SHARE, author: ORGANIZATION, commentary: "One" },
          { id: POST, author: ORGANIZATION, commentary: "Two" },
        ],
      },
    }]);
    const run = harness("posts.read", {
      mode: "author",
      author: ORGANIZATION,
      start: 20,
      count: 2,
      sort: "CREATED",
      view: "READER",
    }, fake.fetch, { scopes: ["r_organization_social"] });

    await executeLinkedInProvider(run.context);

    const request = fake.requests[0] as CapturedRequest;
    expect(request.url).toBe(
      "https://api.linkedin.com/rest/posts?author=urn%3Ali%3Aorganization%3A12345&q=author&start=20&count=2&sortBy=CREATED&viewContext=READER",
    );
    expect(request.headers.get("x-restli-method")).toBe("FINDER");
    expect(run.output()).toMatchObject({
      coverage: "author-posts",
      completeness: "page",
      cursor: { kind: "offset", start: 22 },
      items: [{ id: SHARE }, { id: POST }],
    });
    expect(run.finalUrl()).toBeNull();
  });

  test("lists comments or replies one level at a time and labels a terminal page", async () => {
    const fake = fakeFetch([{
      status: 200,
      body: {
        paging: { start: 0, count: 10, links: [] },
        elements: [{
          id: "7000000000000000005",
          commentUrn: CHILD_COMMENT,
          actor: MEMBER,
          object: ACTIVITY,
          parentComment: COMMENT,
          message: { text: "A reply" },
          created: { time: 123 },
        }],
      },
    }]);
    const run = harness("comments.read", {
      target_urn: COMMENT,
      start: 0,
      count: 10,
    }, fake.fetch, { scopes: ["r_member_social_feed"] });

    await executeLinkedInProvider(run.context);

    expect(fake.requests[0]?.url).toBe(
      "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A7000000000000000003%2C7000000000000000004%29/comments?start=0&count=10",
    );
    expect(run.output()).toMatchObject({
      coverage: "comments",
      completeness: "complete",
      cursor: null,
      items: [{ commentUrn: CHILD_COMMENT, requestedTarget: COMMENT, text: "A reply", createdAt: 123 }],
    });
  });

  test("fails closed when exact-post, author-finder, or nested-reply rows are not request-bound", async () => {
    const wrongPost = fakeFetch([{ status: 200, body: { id: SHARE, author: MEMBER } }]);
    const postRun = harness("posts.read", {
      mode: "one",
      post_urn: POST,
    }, wrongPost.fetch, { scopes: ["r_member_social"] });
    expect(await rejectionMessage(executeLinkedInProvider(postRun.context))).toContain("requested post URN");

    const wrongAuthor = fakeFetch([{
      status: 200,
      body: {
        paging: { start: 0, count: 10, links: [] },
        elements: [{ id: POST, author: MEMBER }],
      },
    }]);
    const authorRun = harness("posts.read", {
      mode: "author",
      author: ORGANIZATION,
    }, wrongAuthor.fetch, { scopes: ["r_organization_social"] });
    expect(await rejectionMessage(executeLinkedInProvider(authorRun.context))).toContain("different author");

    const wrongParent = fakeFetch([{
      status: 200,
      body: {
        paging: { start: 0, count: 10, links: [] },
        elements: [{
          id: "7000000000000000005",
          commentUrn: CHILD_COMMENT,
          actor: MEMBER,
          object: ACTIVITY,
          parentComment: `urn:li:comment:(${ACTIVITY},7000000000000000006)`,
        }],
      },
    }]);
    const replyRun = harness("comments.read", {
      target_urn: COMMENT,
    }, wrongParent.fetch, { scopes: ["r_member_social_feed"] });
    expect(await rejectionMessage(executeLinkedInProvider(replyRun.context))).toContain("different parent");

    const inconsistentRootRow = fakeFetch([{
      status: 200,
      body: {
        paging: { start: 0, count: 10, links: [] },
        elements: [{
          id: "7000000000000000005",
          commentUrn: COMMENT,
          actor: MEMBER,
          object: ACTIVITY,
        }],
      },
    }]);
    const rootRun = harness("comments.read", {
      target_urn: POST,
    }, inconsistentRootRow.fetch, { scopes: ["r_member_social_feed"] });
    expect(await rejectionMessage(executeLinkedInProvider(rootRun.context))).toContain("inconsistent comment ID and URN");
  });

  test("rejects paging metadata and next links that could repeat or skip rows", async () => {
    const validElements = [
      { id: SHARE, author: ORGANIZATION },
      { id: POST, author: ORGANIZATION },
    ];
    const fixedQuery = "author=urn%3Ali%3Aorganization%3A12345&q=author";
    const suffix = "count=2&sortBy=LAST_MODIFIED&viewContext=READER";
    for (const [paging, message] of [
      [{ start: 19, count: 2, links: [] }, "paging start"],
      [{ start: 20, count: 1, links: [] }, "paging count"],
      [{
        start: 20,
        count: 2,
        links: [{ rel: "next", href: `https://api.linkedin.com/rest/posts?${fixedQuery}&start=20&${suffix}` }],
      }, "skip or repeat"],
      [{
        start: 20,
        count: 2,
        links: [{ rel: "next", href: `https://api.linkedin.com/rest/posts?${fixedQuery}&start=23&${suffix}` }],
      }, "skip or repeat"],
    ] as const) {
      const fake = fakeFetch([{ status: 200, body: { paging, elements: validElements } }]);
      const run = harness("posts.read", {
        mode: "author",
        author: ORGANIZATION,
        start: 20,
        count: 2,
      }, fake.fetch, { scopes: ["r_organization_social"] });
      expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain(message);
      expect(run.output()).toBeNull();
    }
  });

  test("never synthesizes a continuation when LinkedIn omits a validated next link", async () => {
    const elements = [
      { id: SHARE, author: ORGANIZATION },
      { id: POST, author: ORGANIZATION },
    ];
    for (const [paging, completeness] of [
      [{ start: 0, count: 2, links: [] }, "complete"],
      [{ start: 0, count: 2 }, "unknown"],
    ] as const) {
      const fake = fakeFetch([{ status: 200, body: { paging, elements } }]);
      const run = harness("posts.read", {
        mode: "author",
        author: ORGANIZATION,
        count: 2,
      }, fake.fetch, { scopes: ["r_organization_social"] });
      await executeLinkedInProvider(run.context);
      expect(run.output()).toMatchObject({ completeness, cursor: null });
    }
  });

  test("rejects an activity URN as a comments collection target before network access", async () => {
    const fake = fakeFetch([]);
    const run = harness("comments.read", {
      target_urn: ACTIVITY,
    }, fake.fetch, { scopes: ["r_member_social_feed"] });

    expect(await rejectionMessage(executeLinkedInProvider(run.context)))
      .toContain("exact share, UGC Post, or composite comment URN");
    expect(fake.requests).toHaveLength(0);
    expect(run.dispatches()).toBe(0);
  });
});

describe("official LinkedIn provider social writes", () => {
  test("creates a comment with an exact actor, object, and encoded post target", async () => {
    const createdUrn = `urn:li:comment:(${ACTIVITY},7000000000000000010)`;
    const fake = fakeFetch([{
      status: 201,
      headers: { "x-restli-id": "7000000000000000010" },
      body: {
        id: "7000000000000000010",
        commentUrn: createdUrn,
        actor: MEMBER,
        object: ACTIVITY,
        message: { text: "Thoughtful follow-up" },
      },
    }]);
    const run = harness("comments.create", {
      actor: MEMBER,
      target_urn: POST,
      object_urn: ACTIVITY,
      body: "Thoughtful follow-up",
    }, fake.fetch, {
      scopes: ["w_member_social_feed"],
      subject: MEMBER,
    });

    await executeLinkedInProvider(run.context);

    const request = fake.requests[0] as CapturedRequest;
    expect(request.url).toBe(
      "https://api.linkedin.com/rest/socialActions/urn%3Ali%3AugcPost%3A7000000000000000001/comments",
    );
    expect(request.method).toBe("POST");
    assertLinkedInApiHeaders(request);
    expect(jsonRequestBody(request)).toEqual({
      actor: MEMBER,
      object: ACTIVITY,
      message: { text: "Thoughtful follow-up" },
    });
    expect(run.dispatches()).toBe(1);
    expect(run.output()).toMatchObject({
      operation: "comments.create",
      completeness: "confirmed",
      result: { id: "7000000000000000010", commentUrn: createdUrn },
    });
    expect(new URL(run.finalUrl() as string).searchParams.get("commentUrn")).toBe(createdUrn);
  });

  test("creates a nested reply through the composite parent target", async () => {
    const childUrn = `urn:li:comment:(${ACTIVITY},7000000000000000011)`;
    const fake = fakeFetch([{
      status: 201,
      headers: { "x-restli-id": "7000000000000000011" },
      body: {
        id: "7000000000000000011",
        commentUrn: childUrn,
        actor: ORGANIZATION,
        object: SHARE,
        parentComment: COMMENT,
        message: { text: "Reply" },
      },
    }]);
    const run = harness("replies.create", {
      actor: ORGANIZATION,
      parent_comment_urn: COMMENT,
      object_urn: SHARE,
      body: "Reply",
    }, fake.fetch, {
      scopes: ["w_organization_social_feed"],
      subject: ORGANIZATION,
    });

    await executeLinkedInProvider(run.context);

    const request = fake.requests[0] as CapturedRequest;
    expect(request.url).toContain("/rest/socialActions/urn%3Ali%3Acomment%3A%28");
    expect(jsonRequestBody(request)).toEqual({
      actor: ORGANIZATION,
      object: SHARE,
      message: { text: "Reply" },
      parentComment: COMMENT,
    });
    expect(run.finalUrl()).toContain(`/feed/update/${SHARE}/`);
  });

  test("rejects created-comment responses that disagree with the confirmed effect", async () => {
    const validBody = {
      id: "7000000000000000010",
      commentUrn: `urn:li:comment:(${ACTIVITY},7000000000000000010)`,
      actor: MEMBER,
      object: ACTIVITY,
      message: { text: "Bound comment" },
    };
    for (const [headers, body, message] of [
      [{ "x-restli-id": "7000000000000000011" }, validBody, "header and body IDs disagreed"],
      [{ "x-restli-id": "7000000000000000010" }, { ...validBody, actor: ORGANIZATION }, "actor disagreed"],
      [{ "x-restli-id": "7000000000000000010" }, { ...validBody, object: SHARE }, "object disagreed"],
    ] as const) {
      const fake = fakeFetch([{ status: 201, headers, body }]);
      const run = harness("comments.create", {
        actor: MEMBER,
        target_urn: POST,
        object_urn: ACTIVITY,
        body: "Bound comment",
      }, fake.fetch, {
        scopes: ["w_member_social_feed"],
        subject: MEMBER,
      });
      expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain(message);
      expect(run.dispatches()).toBe(1);
      expect(run.output()).toBeNull();
    }

    const wrongParentFetch = fakeFetch([{
      status: 201,
      headers: { "x-restli-id": "7000000000000000010" },
      body: {
        ...validBody,
        parentComment: `urn:li:comment:(${ACTIVITY},7000000000000000006)`,
      },
    }]);
    const wrongParent = harness("replies.create", {
      actor: MEMBER,
      parent_comment_urn: COMMENT,
      object_urn: ACTIVITY,
      body: "Bound comment",
    }, wrongParentFetch.fetch, {
      scopes: ["w_member_social_feed"],
      subject: MEMBER,
    });
    expect(await rejectionMessage(executeLinkedInProvider(wrongParent.context))).toContain("parent disagreed");
    expect(wrongParent.output()).toBeNull();
  });

  test("creates a named reaction and truthfully clears any current reaction", async () => {
    const createFetch = fakeFetch([{
      status: 201,
      body: {
        id: reactionUrn(MEMBER, POST),
        root: POST,
        reactionType: "PRAISE",
        created: { actor: MEMBER, time: 123 },
        lastModified: { actor: MEMBER, time: 123 },
      },
    }]);
    const create = harness("reactions.set", {
      actor: MEMBER,
      target_urn: POST,
      reaction: "PRAISE",
      enabled: true,
    }, createFetch.fetch, {
      scopes: ["w_member_social_feed"],
      subject: MEMBER,
    });
    await executeLinkedInProvider(create.context);
    expect(createFetch.requests[0]?.url).toBe(
      "https://api.linkedin.com/rest/reactions?actor=urn%3Ali%3Aperson%3Amember_123",
    );
    expect(jsonRequestBody(createFetch.requests[0] as CapturedRequest)).toEqual({
      root: POST,
      reactionType: "PRAISE",
    });

    const deleteFetch = fakeFetch([{ status: 204 }]);
    const remove = harness("reactions.set", {
      actor: MEMBER,
      target_urn: POST,
      enabled: false,
    }, deleteFetch.fetch, {
      scopes: ["w_member_social_feed"],
      subject: MEMBER,
    });
    await executeLinkedInProvider(remove.context);
    expect(deleteFetch.requests[0]?.method).toBe("DELETE");
    expect(deleteFetch.requests[0]?.url).toBe(
      "https://api.linkedin.com/rest/reactions/(actor:urn%3Ali%3Aperson%3Amember_123,entity:urn%3Ali%3AugcPost%3A7000000000000000001)",
    );
    expect(remove.output()).toMatchObject({
      result: {
        enabled: false,
        reaction: null,
        effect: "clear-any-current-reaction",
      },
    });
  });

  test("rejects reaction responses whose canonical identity, root, type, or actor disagree", async () => {
    const validBody = {
      id: reactionUrn(MEMBER, POST),
      root: POST,
      reactionType: "PRAISE",
      created: { actor: MEMBER, time: 123 },
    };
    for (const [body, message] of [
      [{ ...validBody, id: reactionUrn(ORGANIZATION, POST) }, "canonically bind"],
      [{ ...validBody, root: SHARE }, "root disagreed"],
      [{ ...validBody, reactionType: "LIKE" }, "type disagreed"],
      [{ ...validBody, created: { actor: ORGANIZATION, time: 123 } }, "audit actor disagreed"],
    ] as const) {
      const fake = fakeFetch([{ status: 201, body }]);
      const run = harness("reactions.set", {
        actor: MEMBER,
        target_urn: POST,
        reaction: "PRAISE",
        enabled: true,
      }, fake.fetch, {
        scopes: ["w_member_social_feed"],
        subject: MEMBER,
      });
      expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain(message);
      expect(run.dispatches()).toBe(1);
      expect(run.output()).toBeNull();
    }
  });

  test("enforces the conditional reaction input even when runtime validation is called directly", async () => {
    const fake = fakeFetch([]);
    const missing = harness("reactions.set", {
      actor: MEMBER,
      target_urn: POST,
      enabled: true,
    }, fake.fetch, {
      scopes: ["w_member_social_feed"],
      subject: MEMBER,
    });
    expect(await rejectionMessage(executeLinkedInProvider(missing.context)))
      .toContain("input.reaction");

    const misleading = harness("reactions.set", {
      actor: MEMBER,
      target_urn: POST,
      reaction: "LIKE",
      enabled: false,
    }, fake.fetch, {
      scopes: ["w_member_social_feed"],
      subject: MEMBER,
    });
    expect(await rejectionMessage(executeLinkedInProvider(misleading.context)))
      .toContain("clears any current reaction");
    expect(fake.requests).toHaveLength(0);
    expect(missing.dispatches()).toBe(0);
    expect(misleading.dispatches()).toBe(0);
  });

  test("rejects a missing or mismatched write subject and actor-specific scope before dispatch", async () => {
    const fake = fakeFetch([]);
    const missing = harness("comments.create", {
      actor: MEMBER,
      target_urn: POST,
      object_urn: ACTIVITY,
      body: "Nope",
    }, fake.fetch, { scopes: ["w_member_social_feed"] });
    expect(await rejectionMessage(executeLinkedInProvider(missing.context))).toContain("exact subject URN");

    const mismatch = harness("comments.create", {
      actor: MEMBER,
      target_urn: POST,
      object_urn: ACTIVITY,
      body: "Nope",
    }, fake.fetch, {
      scopes: ["w_member_social_feed"],
      subject: "urn:li:person:someone_else",
    });
    expect(await rejectionMessage(executeLinkedInProvider(mismatch.context))).toContain("does not match");

    const wrongScope = harness("comments.create", {
      actor: ORGANIZATION,
      target_urn: POST,
      object_urn: ACTIVITY,
      body: "Nope",
    }, fake.fetch, {
      scopes: ["w_member_social_feed"],
      subject: ORGANIZATION,
    });
    expect(await rejectionMessage(executeLinkedInProvider(wrongScope.context))).toContain("lacks required scope");
    expect(fake.requests).toHaveLength(0);
    expect(missing.dispatches()).toBe(0);
    expect(mismatch.dispatches()).toBe(0);
    expect(wrongScope.dispatches()).toBe(0);
  });
});

describe("official LinkedIn Posts API publishing", () => {
  test("publishes an exact text post and external article card", async () => {
    const textFetch = fakeFetch([{
      status: 201,
      headers: { "x-restli-id": POST },
    }]);
    const text = harness("posts.publish", {
      author: MEMBER,
      body: "A plain text post",
      visibility: "CONNECTIONS",
    }, textFetch.fetch, {
      scopes: ["w_member_social"],
      subject: MEMBER,
    });
    await executeLinkedInProvider(text.context);
    expect(jsonRequestBody(textFetch.requests[0] as CapturedRequest)).toEqual({
      author: MEMBER,
      commentary: "A plain text post",
      visibility: "CONNECTIONS",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
    expect(text.output()).toMatchObject({ result: { id: POST, contentKind: "none" } });

    const articleFetch = fakeFetch([{
      status: 201,
      headers: { "x-restli-id": SHARE },
    }]);
    const article = harness("posts.publish", {
      author: ORGANIZATION,
      body: "Read this",
      visibility: "PUBLIC",
      article_url: "https://example.com/article?q=1",
      article_title: "A deterministic card",
      article_description: "No URL scraping is used.",
    }, articleFetch.fetch, {
      scopes: ["w_organization_social"],
      subject: ORGANIZATION,
    });
    await executeLinkedInProvider(article.context);
    expect(jsonRequestBody(articleFetch.requests[0] as CapturedRequest)).toMatchObject({
      content: {
        article: {
          source: "https://example.com/article?q=1",
          title: "A deterministic card",
          description: "No URL scraping is used.",
        },
      },
    });
    expect(article.output()).toMatchObject({ result: { id: SHARE, contentKind: "article" } });
  });

  test("reshares one exact post with actor-bound commentary", async () => {
    const fake = fakeFetch([{
      status: 201,
      headers: { "x-restli-id": SHARE },
    }]);
    const run = harness("posts.repost", {
      author: MEMBER,
      target_urn: POST,
      body: "Worth resharing",
      visibility: "CONNECTIONS",
    }, fake.fetch, {
      scopes: ["w_member_social"],
      subject: MEMBER,
    });

    await executeLinkedInProvider(run.context);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe("https://api.linkedin.com/rest/posts");
    expect(jsonRequestBody(fake.requests[0] as CapturedRequest)).toEqual({
      author: MEMBER,
      commentary: "Worth resharing",
      visibility: "CONNECTIONS",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      reshareContext: { parent: POST },
    });
    expect(run.output()).toMatchObject({
      operation: "posts.repost",
      result: { id: SHARE, target: POST, author: MEMBER },
    });
    expect(run.finalUrl()).toBe(`https://www.linkedin.com/feed/update/${SHARE}/`);
    expect(run.dispatches()).toBe(1);
  });

  test("enforces the external article-card title's strict 399-character maximum", async () => {
    const fake = fakeFetch([]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Card",
      article_url: "https://example.com/article",
      article_title: "a".repeat(400),
    }, fake.fetch, {
      scopes: ["w_member_social"],
      subject: MEMBER,
    });

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("bounded string");
    expect(fake.requests).toHaveLength(0);
    expect(run.dispatches()).toBe(0);
  });

  test("requires the actor-appropriate asset read scope before resolving or dispatching media", async () => {
    const image = privateFile(Uint8Array.from([1, 2, 3, 4]), "image/png");
    const fake = fakeFetch([]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Missing read scope",
      media: [{ kind: "file", reference: "sf1:test" }],
    }, fake.fetch, {
      scopes: ["w_member_social"],
      subject: MEMBER,
      files: [image],
    });

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("r_member_social");
    expect(fake.requests).toHaveLength(0);
    expect(run.dispatches()).toBe(0);
  });

  test("accepts only MP4 video at the documented inclusive 75,000-byte floor", async () => {
    const fake = fakeFetch([]);
    const quickTime = privateFile(validVideoBytes(), "video/quicktime");
    const unsupported = harness("posts.publish", {
      author: MEMBER,
      body: "MOV",
      media: [{ kind: "file", reference: "sf1:mov" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [quickTime],
    });
    expect(await rejectionMessage(executeLinkedInProvider(unsupported.context))).toContain("media type is not supported");

    const tiny = privateFile(new Uint8Array(74_999), "video/mp4");
    const undersized = harness("posts.publish", {
      author: MEMBER,
      body: "Too small",
      media: [{ kind: "file", reference: "sf1:tiny" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [tiny],
    });
    expect(await rejectionMessage(executeLinkedInProvider(undersized.context)))
      .toContain("between 75000 and 524288000 bytes");
    expect(fake.requests).toHaveLength(0);
    expect(unsupported.dispatches()).toBe(0);
    expect(undersized.dispatches()).toBe(0);
  });

  test("initializes, uploads, waits for AVAILABLE, and publishes image media inside one semantic dispatch", async () => {
    const image = privateFile(Uint8Array.from([1, 2, 3, 4]), "image/png");
    const imageUrn = "urn:li:image:image_123";
    const fake = fakeFetch([
      {
        status: 200,
        body: {
          value: {
            image: imageUrn,
            uploadUrl: "https://www.linkedin.com/dms-uploads/image/upload?sig=private",
          },
        },
      },
      { status: 201 },
      { status: 200, body: { id: imageUrn, status: "PROCESSING" }, headers: { "retry-after": "0" } },
      { status: 200, body: { id: imageUrn, status: "AVAILABLE" } },
      { status: 201, headers: { "x-restli-id": POST } },
    ]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Image post",
      visibility: "PUBLIC",
      media: [{ kind: "file", reference: "sf1:test" }],
      alt_text: "Four sample bytes",
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [image],
    });

    await executeLinkedInProvider(run.context);

    expect(fake.requests).toHaveLength(5);
    expect(fake.requests[0]?.url).toBe("https://api.linkedin.com/rest/images?action=initializeUpload");
    expect(jsonRequestBody(fake.requests[0] as CapturedRequest)).toEqual({
      initializeUploadRequest: { owner: MEMBER },
    });
    expect(fake.requests[1]?.url).toBe(
      "https://www.linkedin.com/dms-uploads/image/upload?sig=private",
    );
    expect(fake.requests[1]?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(Array.from(fake.requests[1]?.byteBody ?? [])).toEqual([1, 2, 3, 4]);
    expect(fake.requests[2]?.url).toBe(
      "https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3Aimage_123",
    );
    expect(fake.requests[2]?.method).toBe("GET");
    expect(fake.requests[3]?.url).toBe(fake.requests[2]?.url);
    assertLinkedInApiHeaders(fake.requests[2] as CapturedRequest);
    expect(jsonRequestBody(fake.requests[4] as CapturedRequest)).toMatchObject({
      content: { media: { id: imageUrn, altText: "Four sample bytes" } },
    });
    expect(run.dispatches()).toBe(1);
    expect(run.output()).toMatchObject({
      result: { contentKind: "images", mediaIds: [imageUrn] },
      limitations: [],
    });
  });

  test("does not sleep past the provider deadline while LinkedIn media is processing", async () => {
    const image = privateFile(Uint8Array.from([1, 2, 3, 4]), "image/png");
    const imageUrn = "urn:li:image:image_deadline";
    const fake = fakeFetch([
      {
        status: 200,
        body: {
          value: {
            image: imageUrn,
            uploadUrl: "https://www.linkedin.com/dms-uploads/image/upload?sig=private",
          },
        },
      },
      { status: 201 },
      { status: 200, body: { id: imageUrn, status: "PROCESSING" }, headers: { "retry-after": "60" } },
    ]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Bounded media processing",
      media: [{ kind: "file", reference: "sf1:test" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [image],
      timeoutMs: 500,
    });
    const startedAt = Date.now();

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("bounded polling window");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fake.requests).toHaveLength(3);
    expect(run.dispatches()).toBe(1);
  });

  test("uses authoritative video ranges without OAuth, normalizes ETags, finalizes, waits, then posts", async () => {
    const videoBytes = validVideoBytes();
    const video = privateFile(videoBytes, "video/mp4");
    const videoUrn = "urn:li:video:video_123";
    const fake = fakeFetch([
      {
        status: 200,
        body: {
          value: {
            video: videoUrn,
            uploadToken: "upload-session",
            uploadInstructions: [
              {
                firstByte: 0,
                lastByte: 41_999,
                uploadUrl: "https://www.linkedin.com/dms-uploads/video/part-1?sig=one",
              },
              {
                firstByte: 42_000,
                lastByte: 74_999,
                uploadUrl: "https://www.linkedin.com/dms-uploads/video/part-2?sig=two",
              },
            ],
          },
        },
      },
      { status: 200, headers: { etag: '"part-one-etag"' } },
      { status: 200, headers: { etag: "part-two-etag" } },
      { status: 200 },
      { status: 200, body: { id: videoUrn, status: "AVAILABLE" } },
      { status: 201, headers: { "x-restli-id": SHARE } },
    ]);
    const run = harness("posts.publish", {
      author: ORGANIZATION,
      body: "Video post",
      media: [{ kind: "file", reference: "sf1:test" }],
      media_title: "Short clip",
    }, fake.fetch, {
      scopes: ["r_organization_social", "w_organization_social"],
      subject: ORGANIZATION,
      files: [video],
    });

    await executeLinkedInProvider(run.context);

    expect(fake.requests).toHaveLength(6);
    expect(fake.requests[1]?.byteBody?.byteLength).toBe(42_000);
    expect(fake.requests[2]?.byteBody?.byteLength).toBe(33_000);
    expect(fake.requests[1]?.byteBody?.[0]).toBe(videoBytes[0]);
    expect(fake.requests[1]?.byteBody?.[41_999]).toBe(videoBytes[41_999]);
    expect(fake.requests[2]?.byteBody?.[0]).toBe(videoBytes[42_000]);
    expect(fake.requests[2]?.byteBody?.[32_999]).toBe(videoBytes[74_999]);
    expect(fake.requests[1]?.headers.get("authorization")).toBeNull();
    expect(fake.requests[2]?.headers.get("authorization")).toBeNull();
    expect(fake.requests[1]?.headers.get("content-type")).toBe("application/octet-stream");
    expect(fake.requests[3]?.url).toBe("https://api.linkedin.com/rest/videos?action=finalizeUpload");
    expect(jsonRequestBody(fake.requests[3] as CapturedRequest)).toEqual({
      finalizeUploadRequest: {
        video: videoUrn,
        uploadToken: "upload-session",
        uploadedPartIds: ["part-one-etag", "part-two-etag"],
      },
    });
    expect(fake.requests[4]?.url).toBe(
      "https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3Avideo_123",
    );
    expect(jsonRequestBody(fake.requests[5] as CapturedRequest)).toMatchObject({
      content: { media: { id: videoUrn, title: "Short clip" } },
    });
    expect(run.dispatches()).toBe(1);
    expect(run.output()).toMatchObject({
      limitations: [expect.stringContaining("3-second to 30-minute duration")],
    });
  });

  test("rejects weak and malformed video ETags before finalization", async () => {
    const video = privateFile(validVideoBytes(), "video/mp4");
    for (const etag of ['W/"weak"', '"unterminated', 'part"quote']) {
      const fake = fakeFetch([
        {
          status: 200,
          body: {
            value: {
              video: "urn:li:video:etag_test",
              uploadToken: "upload-session",
              uploadInstructions: [{
                firstByte: 0,
                lastByte: 74_999,
                uploadUrl: "https://www.linkedin.com/dms-uploads/video/part?sig=one",
              }],
            },
          },
        },
        { status: 200, headers: { etag } },
      ]);
      const run = harness("posts.publish", {
        author: MEMBER,
        body: "Bad ETag",
        media: [{ kind: "file", reference: "sf1:test" }],
      }, fake.fetch, {
        scopes: ["r_member_social", "w_member_social"],
        subject: MEMBER,
        files: [video],
      });

      expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("usable ETag");
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[1]?.headers.get("authorization")).toBeNull();
    }
  });

  test("rejects a non-default port in a signed upload URL before sending bytes", async () => {
    const image = privateFile(Uint8Array.from([1, 2, 3, 4]), "image/png");
    const fake = fakeFetch([{
      status: 200,
      body: {
        value: {
          image: "urn:li:image:port_test",
          uploadUrl: "https://www.linkedin.com:444/dms-uploads/image/upload?sig=private",
        },
      },
    }]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Bad destination",
      media: [{ kind: "file", reference: "sf1:test" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [image],
    });

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("unapproved media upload destination");
    expect(fake.requests).toHaveLength(1);
  });

  test("binds the preflight video identity before any provider request or remote byte", async () => {
    const bytes = validVideoBytes();
    const video = privateFile(bytes, "video/mp4");
    const fake = fakeFetch([]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Replaced after preview",
      media: [{ kind: "file", reference: "sf1:test" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [video],
      beforeDispatch: () => {
        renameSync(video.path, `${video.path}.preflight`);
        writeFileSync(video.path, bytes, { mode: 0o600 });
        chmodSync(video.path, 0o600);
      },
    });

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("identity changed after its confirmed preflight");
    expect(fake.requests).toHaveLength(0);
    expect(run.dispatches()).toBe(1);
  });

  test.skipIf(process.platform === "win32")("rejects a FIFO replacement after video preflight without blocking", async () => {
    const bytes = validVideoBytes();
    const video = privateFile(bytes, "video/mp4");
    const fake = fakeFetch([]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "FIFO replacement",
      media: [{ kind: "file", reference: "sf1:test" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [video],
      beforeDispatch: () => {
        renameSync(video.path, `${video.path}.preflight`);
        expect(spawnSync("mkfifo", [video.path]).status).toBe(0);
        chmodSync(video.path, 0o600);
      },
    });

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("mode-0600 regular file");
    expect(fake.requests).toHaveLength(0);
    expect(run.dispatches()).toBe(1);
  });

  test("uploads DOCX and PPTX-compatible document media through the Documents API", async () => {
    const document = privateFile(
      Uint8Array.from([80, 75, 3, 4, 1, 2]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const documentUrn = "urn:li:document:document_123";
    const fake = fakeFetch([
      {
        status: 200,
        body: {
          value: {
            document: documentUrn,
            uploadUrl: "https://www.linkedin.com/dms-uploads/document/upload?sig=private",
          },
        },
      },
      { status: 201 },
      { status: 200, body: { id: documentUrn, status: "AVAILABLE" } },
      { status: 201, headers: { "x-restli-id": POST } },
    ]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Document post",
      media: [{ kind: "file", reference: "sf1:test" }],
      media_title: "Reviewed document.docx",
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [document],
    });

    await executeLinkedInProvider(run.context);

    expect(fake.requests[0]?.url).toBe("https://api.linkedin.com/rest/documents?action=initializeUpload");
    expect(fake.requests[2]?.url).toBe(
      "https://api.linkedin.com/rest/documents/urn%3Ali%3Adocument%3Adocument_123",
    );
    expect(jsonRequestBody(fake.requests[3] as CapturedRequest)).toMatchObject({
      content: { media: { id: documentUrn, title: "Reviewed document.docx" } },
    });
    expect(run.output()).toMatchObject({ result: { contentKind: "document", mediaIds: [documentUrn] } });
  });

  test("stops before post creation when LinkedIn reports media processing failure", async () => {
    const image = privateFile(Uint8Array.from([1, 2, 3, 4]), "image/png");
    const imageUrn = "urn:li:image:failed_image";
    const fake = fakeFetch([
      {
        status: 200,
        body: {
          value: {
            image: imageUrn,
            uploadUrl: "https://www.linkedin.com/dms-uploads/image/upload?sig=private",
          },
        },
      },
      { status: 201 },
      { status: 200, body: { id: imageUrn, status: "PROCESSING_FAILED" } },
    ]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Failed image",
      media: [{ kind: "file", reference: "sf1:test" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [image],
    });

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("image processing failed");
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.some((request) => request.url === "https://api.linkedin.com/rest/posts")).toBeFalse();
    expect(run.output()).toBeNull();
  });

  test("bounds media processing polls and times out without creating a post", async () => {
    const image = privateFile(Uint8Array.from([1, 2, 3, 4]), "image/png");
    const imageUrn = "urn:li:image:slow_image";
    const fake = fakeFetch([
      {
        status: 200,
        body: {
          value: {
            image: imageUrn,
            uploadUrl: "https://www.linkedin.com/dms-uploads/image/upload?sig=private",
          },
        },
      },
      { status: 201 },
      ...Array.from({ length: 100 }, () => ({
        status: 200,
        body: { id: imageUrn, status: "PROCESSING" },
        headers: { "retry-after": "0" },
      })),
    ]);
    const run = harness("posts.publish", {
      author: MEMBER,
      body: "Slow image",
      media: [{ kind: "file", reference: "sf1:test" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [image],
    });

    expect(await rejectionMessage(executeLinkedInProvider(run.context))).toContain("bounded polling window");
    expect(fake.requests).toHaveLength(102);
    expect(fake.requests.slice(2).every((request) => request.method === "GET")).toBeTrue();
    expect(fake.requests.some((request) => request.url === "https://api.linkedin.com/rest/posts")).toBeFalse();
  });

  test("rejects mixed media and a changed attachment digest before dispatch", async () => {
    const image = privateFile(Uint8Array.from([1]), "image/png");
    const video = privateFile(Uint8Array.from([2]), "video/mp4");
    const fake = fakeFetch([]);
    const mixed = harness("posts.publish", {
      author: MEMBER,
      body: "Mixed",
      media: [
        { kind: "file", reference: "sf1:one" },
        { kind: "file", reference: "sf1:two" },
      ],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [image, video],
    });
    expect(await rejectionMessage(executeLinkedInProvider(mixed.context)))
      .toContain("all images, one supported document, or one video");

    const changed = { ...image, sha256: "0".repeat(64) };
    const stale = harness("posts.publish", {
      author: MEMBER,
      body: "Stale",
      media: [{ kind: "file", reference: "sf1:stale" }],
    }, fake.fetch, {
      scopes: ["r_member_social", "w_member_social"],
      subject: MEMBER,
      files: [changed],
    });
    expect(await rejectionMessage(executeLinkedInProvider(stale.context))).toContain("digest");
    expect(fake.requests).toHaveLength(0);
    expect(mixed.dispatches()).toBe(0);
    expect(stale.dispatches()).toBe(0);
  });
});

describe("official LinkedIn provider failures", () => {
  test("redacts access tokens and response bodies from non-2xx diagnostics", async () => {
    const fake = fakeFetch([{
      status: 403,
      body: { message: `provider echoed ${ACCESS_TOKEN}` },
    }]);
    const run = harness("posts.read", {
      mode: "one",
      post_urn: POST,
    }, fake.fetch, { scopes: ["r_member_social"] });

    let diagnostic = "";
    try {
      await executeLinkedInProvider(run.context);
      throw new Error("expected provider call to fail");
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    expect(diagnostic).toContain("HTTP 403");
    expect(diagnostic).not.toContain(ACCESS_TOKEN);
    expect(diagnostic).not.toContain("provider echoed");
    expect(diagnostic).not.toContain("Authorization");
    expect(fake.requests[0]?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(run.output()).toBeNull();
  });
});
