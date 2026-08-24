import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import { pinnedHttpsFetch, type PinnedHttpsFetch } from "../pinned-https";
import type {
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  GITHUB_API_ORIGIN,
  GITHUB_WEB_OPERATIONS,
  githubUsername,
  projectGitHubProfileStats,
} from "./github-web";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const OPERATION_LABEL = "GitHub public profile read deadline";

export type GitHubWebRuntimeDependencies = {
  readonly fetch?: PinnedHttpsFetch;
  readonly now?: () => number;
};

function remainingTimeoutMs(
  timeoutMs: number,
  deadline: WebSessionOperationDeadline | undefined,
): number {
  deadline?.throwIfUnavailable(OPERATION_LABEL);
  const remaining = Math.min(
    timeoutMs,
    deadline?.remainingTimeMs() ?? timeoutMs,
  );
  if (remaining < 1_000) {
    throw new Error("GitHub public profile read timed out");
  }
  return remaining;
}

function exactInput(input: OperationInput): string {
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "username") {
    throw new Error("GitHub profiles.read accepts only input.username");
  }
  return githubUsername(input.username, "input.username");
}

function jsonContentType(response: Response): boolean {
  const raw = response.headers.get("content-type");
  if (raw === null) return false;
  const type = raw.split(";", 1)[0]?.trim().toLowerCase();
  return type === "application/json" || type?.endsWith("+json") === true;
}

async function boundedBytes(
  response: Response,
  maximum: number,
  deadline: WebSessionOperationDeadline | undefined,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("GitHub profile response exceeded its reviewed byte limit");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = deadline === undefined
        ? await reader.read()
        : await deadline.run(() => reader.read(), OPERATION_LABEL);
      if (item.done) break;
      if (
        !(item.value instanceof Uint8Array)
        || item.value.byteLength > maximum - length
      ) {
        void reader.cancel().catch(() => undefined);
        throw new Error("GitHub profile response exceeded its reviewed byte limit");
      }
      chunks.push(item.value);
      length += item.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) {
    throw new Error("GitHub profile response was empty");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("GitHub profile response was not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("GitHub profile response was not valid JSON");
  }
}

export async function executeGitHubPublicProfileRead(
  recipe: WebSessionRecipe,
  input: OperationInput,
  dependencies: GitHubWebRuntimeDependencies | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "github"
    || recipe.action !== "profiles.read"
    || recipe.contractVersion !== 1
    || GITHUB_WEB_OPERATIONS["profiles.read"].state !== "observed"
  ) {
    throw new Error("GitHub public profiles.read contract is not installed");
  }
  const username = exactInput(input);
  const url = new URL(`/users/${username}`, GITHUB_API_ORIGIN);
  const fetch = dependencies?.fetch ?? pinnedHttpsFetch;
  const controller = operationDeadline === undefined
    ? new AbortController()
    : null;
  const timeout = controller === null
    ? null
    : setTimeout(() => controller.abort(), recipe.timeoutMs);
  const signal = operationDeadline?.signal ?? controller?.signal;
  if (signal === undefined) {
    throw new Error("GitHub public profile read has no operation signal");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "wrench-github-profile-stats/1.0.0",
        "x-github-api-version": "2026-03-10",
      },
      redirect: "error",
      signal,
    }, remainingTimeoutMs(recipe.timeoutMs, operationDeadline));
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      `GitHub public profile API returned unreviewed status ${response.status}`,
    );
  }
  if (!jsonContentType(response)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("GitHub public profile API returned an unreviewed content type");
  }
  const output = projectGitHubProfileStats(
    parseJson(await boundedBytes(
      response,
      Math.min(recipe.maxOutputBytes, MAX_RESPONSE_BYTES),
      operationDeadline,
    )),
    username,
    new Date(dependencies?.now?.() ?? Date.now()).toISOString(),
  );
  return {
    status: "succeeded",
    output,
    finalUrl: output.target.url,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

export function probeGitHubWebSubject(_auth: WrenchAuth): Promise<string> {
  return Promise.reject(
    new Error("GitHub profiles.read is public and does not use an auth realm"),
  );
}

export function executeGitHubAuthenticatedOperation(): Promise<WebSessionExecution> {
  return Promise.reject(
    new Error("GitHub has no installed authenticated web operations"),
  );
}
