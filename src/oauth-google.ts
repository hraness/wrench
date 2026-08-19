import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";

import {
  createAuth,
  loadAuthSnapshotIfPresent,
  saveAuth,
  type WrenchAuth,
} from "./auth";
import { canonicalJson } from "./canonical-json";
import {
  loadOAuthCredential,
  loadOAuthToken,
  ProviderHttpClient,
  type GoogleInstalledAppRefresh,
  type LoadedOAuthToken,
  type OAuthTokenAuth,
  type ProviderFetch,
} from "./provider-http";
import { isGmailAccountSubject } from "./provider-subject";
import { pinnedHttpsFetch, type PinnedHttpsFetch } from "./pinned-https";
import {
  createPrivateJsonIfAbsent,
  readPrivateStateFileIfPresent,
  removePrivateStateFileIfUnchanged,
  wrenchStateHome,
  writePrivateJsonIfUnchanged,
} from "./storage";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress";
const GOOGLE_TOKEN_HOSTS = ["oauth2.googleapis.com"] as const;
const GOOGLE_GMAIL_HOSTS = ["gmail.googleapis.com"] as const;
const GOOGLE_OAUTH_TIMEOUT_MS = 60_000;
const GOOGLE_AUTHORIZATION_TIMEOUT_MS = 10 * 60_000;
const MAX_GOOGLE_CLIENT_FILE_BYTES = 64 * 1024;
const MAX_GOOGLE_RESPONSE_BYTES = 64 * 1024;
const CALLBACK_PATH = "/oauth2/callback";

export const GOOGLE_GMAIL_READ_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
]);

type JsonRecord = Record<string, unknown>;

type GoogleDesktopClient = Readonly<{
  clientId: string;
  clientSecret: string | null;
  projectId: string;
}>;

type GoogleTokenExchange = Readonly<{
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string | null;
  refreshTokenExpiresInSeconds: number | null;
}>;

export type GoogleOAuthCredentialDocument = Readonly<{
  schemaVersion: 2;
  provider: "gmail";
  subject: string;
  scopes: readonly string[];
  accessToken: string;
  expiresAt: string;
  refresh: GoogleInstalledAppRefresh;
}>;

export type GoogleOAuthLoginResult = Readonly<{
  subject: string;
  scopes: readonly string[];
  credential: GoogleOAuthCredentialDocument;
  refreshTokenExpiresAt: string | null;
}>;

export type GoogleOAuthAuthorizationRequest = Readonly<{
  clientId: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  openBrowser: boolean;
  onAuthorizationUrl: (url: string) => void;
  signal?: AbortSignal;
}>;

export type GoogleOAuthLoginDependencies = Readonly<{
  authorize?: (
    request: GoogleOAuthAuthorizationRequest,
  ) => Promise<Readonly<{ code: string; redirectUri: string }>>;
  fetch?: ProviderFetch;
  pinnedFetch?: PinnedHttpsFetch;
  randomBytes?: (size: number) => Uint8Array;
  now?: () => Date;
}>;

function strictRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing field ${key}`);
  }
}

function safeText(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < minimumBytes
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || [...value].some((character) => {
      const code = character.codePointAt(0) ?? -1;
      return code <= 0x20 || code === 0x7f;
    })
  ) throw new Error(`${label} must be bounded text without whitespace or control characters`);
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function exactSortedScopes(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === "string")) {
    throw new Error(`${label} must be a scope list`);
  }
  const actual = [...value].sort();
  if (
    actual.length !== expected.length
    || actual.some((scope, index) => scope !== expected[index])
  ) throw new Error(`${label} does not exactly match the requested Google scopes`);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedGoogleClientFile(pathValue: string): string {
  const path = resolve(pathValue);
  const pathStats = lstatSync(path, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    pathStats.isSymbolicLink()
    || !pathStats.isFile()
    || (uid !== null && pathStats.uid !== uid)
    || pathStats.size < 1n
    || pathStats.size > BigInt(MAX_GOOGLE_CLIENT_FILE_BYTES)
  ) {
    throw new Error("Google OAuth client file must be a current-user-owned regular file of at most 65536 bytes");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!sameFile(pathStats, before) || before.size !== pathStats.size) {
      throw new Error("Google OAuth client file changed while it was opened");
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      offset !== buffer.byteLength
      || !sameFile(before, after)
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error("Google OAuth client file changed while it was read");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(descriptor);
  }
}

export function parseGoogleDesktopClient(value: unknown): GoogleDesktopClient {
  const root = strictRecord(value, "Google OAuth client document");
  exactKeys(root, ["installed"], [], "Google OAuth client document");
  const installed = strictRecord(root.installed, "Google OAuth installed client");
  exactKeys(installed, [
    "client_id",
    "project_id",
    "auth_uri",
    "token_uri",
    "auth_provider_x509_cert_url",
    "redirect_uris",
  ], ["client_secret", "universe_domain"], "Google OAuth installed client");
  const clientId = safeText(installed.client_id, "Google OAuth client_id", 16, 1_024);
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(clientId)) {
    throw new Error("Google OAuth client_id is not a Desktop app client ID");
  }
  const clientSecret = installed.client_secret === undefined
    ? null
    : safeText(installed.client_secret, "Google OAuth client_secret", 1, 4_096);
  const projectId = safeText(installed.project_id, "Google OAuth project_id", 1, 512);
  if (
    installed.auth_uri !== "https://accounts.google.com/o/oauth2/auth"
    && installed.auth_uri !== GOOGLE_AUTHORIZATION_URL
  ) throw new Error("Google OAuth client has an unreviewed authorization endpoint");
  if (installed.token_uri !== GOOGLE_TOKEN_URL) {
    throw new Error("Google OAuth client has an unreviewed token endpoint");
  }
  if (installed.auth_provider_x509_cert_url !== "https://www.googleapis.com/oauth2/v1/certs") {
    throw new Error("Google OAuth client has an unreviewed certificate endpoint");
  }
  if (
    !Array.isArray(installed.redirect_uris)
    || installed.redirect_uris.length < 1
    || installed.redirect_uris.length > 8
    || !installed.redirect_uris.every((uri) => uri === "http://localhost")
  ) throw new Error("Google OAuth Desktop client must declare only the localhost loopback redirect");
  if (installed.universe_domain !== undefined && installed.universe_domain !== "googleapis.com") {
    throw new Error("Google OAuth client has an unreviewed universe domain");
  }
  return Object.freeze({ clientId, clientSecret, projectId });
}

export function loadGoogleDesktopClient(path: string): GoogleDesktopClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedGoogleClientFile(path)) as unknown;
  } catch (error) {
    throw new Error("could not load the Google Desktop OAuth client file", { cause: error });
  }
  return parseGoogleDesktopClient(parsed);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function authorizationUrl(
  request: GoogleOAuthAuthorizationRequest,
  redirectUri: string,
): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", request.scopes.join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  return url.href;
}

async function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/d", "/s", "/c", "start", "", url]
      : ["xdg-open", url];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => reject(new Error("could not open the system browser", { cause: error })));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`system browser opener failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

function callbackHtml(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Wrench Google login</title><style>body{font:18px system-ui;max-width:36rem;margin:15vh auto;padding:2rem;line-height:1.5}</style><p>${message}</p>`);
}

async function defaultAuthorize(
  request: GoogleOAuthAuthorizationRequest,
): Promise<Readonly<{ code: string; redirectUri: string }>> {
  if (request.signal?.aborted === true) throw new Error("Google authorization was cancelled");
  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    let redirectUri = "";
    const finish = (
      error: Error | null,
      value?: Readonly<{ code: string; redirectUri: string }>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      server.close();
      server.closeAllConnections?.();
      if (error !== null) reject(error);
      else if (value !== undefined) resolvePromise(value);
      else reject(new Error("Google authorization ended without a result"));
    };
    const server = createServer((incoming, response) => {
      if (incoming.method !== "GET" || redirectUri === "") {
        callbackHtml(response, 405, "This request is not part of the Wrench login.");
        return;
      }
      let callback: URL;
      try {
        callback = new URL(incoming.url ?? "", redirectUri);
      } catch {
        callbackHtml(response, 400, "Google returned an invalid authorization response.");
        return;
      }
      if (callback.pathname !== CALLBACK_PATH) {
        callbackHtml(response, 404, "This is not the Wrench authorization callback.");
        return;
      }
      const allowed = new Set([
        "authuser",
        "code",
        "error",
        "error_description",
        "error_uri",
        "hd",
        "iss",
        "prompt",
        "scope",
        "state",
      ]);
      if ([...callback.searchParams.keys()].some((key) => !allowed.has(key))) {
        callbackHtml(response, 400, "Google returned an unsupported authorization response.");
        finish(new Error("Google authorization callback contained unsupported fields"));
        return;
      }
      const issuers = callback.searchParams.getAll("iss");
      if (
        issuers.length > 1
        || (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
      ) {
        callbackHtml(response, 400, "The Google authorization issuer did not match. Return to Wrench and try again.");
        finish(new Error("Google authorization callback issuer did not match"));
        return;
      }
      if (callback.searchParams.get("state") !== request.state) {
        callbackHtml(response, 400, "The Google authorization state did not match. Return to Wrench and try again.");
        return;
      }
      const providerError = callback.searchParams.get("error");
      if (providerError !== null) {
        callbackHtml(response, 400, "Google authorization was not granted. You can close this tab.");
        finish(new Error(`Google authorization failed with ${safeText(providerError, "Google OAuth error", 1, 128)}`));
        return;
      }
      const code = callback.searchParams.get("code");
      if (code === null) {
        callbackHtml(response, 400, "Google did not return an authorization code.");
        finish(new Error("Google authorization callback omitted its code"));
        return;
      }
      let validatedCode: string;
      try {
        validatedCode = safeText(code, "Google authorization code", 8, 4_096);
      } catch (error) {
        callbackHtml(response, 400, "Google returned an invalid authorization code.");
        finish(error instanceof Error ? error : new Error("Google returned an invalid authorization code"));
        return;
      }
      callbackHtml(response, 200, "Google is connected. You can close this tab and return to Codex.");
      finish(null, { code: validatedCode, redirectUri });
    });
    const timer = setTimeout(
      () => finish(new Error("Google authorization timed out before consent completed")),
      GOOGLE_AUTHORIZATION_TIMEOUT_MS,
    );
    timer.unref?.();
    const onAbort = (): void => finish(new Error("Google authorization was cancelled"));
    request.signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", (error) => finish(new Error("Google authorization callback could not start", { cause: error })));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        finish(new Error("Google authorization callback did not receive a loopback port"));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const url = authorizationUrl(request, redirectUri);
      request.onAuthorizationUrl(url);
      if (!request.openBrowser) return;
      void openSystemBrowser(url).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error("could not open the system browser"));
      });
    });
  });
}

function scopedFetch(
  injected: ProviderFetch | undefined,
  pinned: PinnedHttpsFetch,
  signal: AbortSignal | undefined,
): ProviderFetch {
  const base: ProviderFetch = injected ?? ((input, init = {}) => {
    const url = input instanceof URL
      ? new URL(input)
      : new URL(typeof input === "string" ? input : input.url);
    return pinned(url, init, GOOGLE_OAUTH_TIMEOUT_MS);
  });
  return (input, init = {}) => {
    if (signal?.aborted === true) return Promise.reject(new Error("Google OAuth request was cancelled"));
    const requestSignal = init.signal;
    const combined = signal === undefined
      ? requestSignal
      : requestSignal === undefined || requestSignal === null
        ? signal
        : AbortSignal.any([signal, requestSignal]);
    return base(input, {
      ...init,
      ...(combined === undefined || combined === null ? {} : { signal: combined }),
    });
  };
}

function parseTokenResponse(
  value: unknown,
  requestedScopes: readonly string[],
  requireRefreshToken: boolean,
): GoogleTokenExchange {
  const response = strictRecord(value, "Google OAuth token response");
  exactKeys(response, ["access_token", "expires_in", "token_type"], [
    "id_token",
    "refresh_token",
    "refresh_token_expires_in",
    "scope",
  ], "Google OAuth token response");
  if (response.token_type !== "Bearer") {
    throw new Error("Google OAuth token response has an unsupported token type");
  }
  const accessToken = safeText(response.access_token, "Google OAuth access token", 8, 16 * 1_024);
  const expiresInSeconds = safeInteger(response.expires_in, "Google OAuth expires_in", 60, 86_400);
  if (response.scope !== undefined) {
    if (
      typeof response.scope !== "string"
      || response.scope.length < 1
      || Buffer.byteLength(response.scope, "utf8") > 16 * 1_024
      || [...response.scope].some((character) => {
        const code = character.codePointAt(0) ?? -1;
        return code < 0x20 || code === 0x7f;
      })
    ) throw new Error("Google OAuth granted scope must be bounded space-delimited text");
    const scopeText = response.scope;
    exactSortedScopes(scopeText.split(" ").filter(Boolean), requestedScopes, "Google OAuth granted scopes");
  } else if (requireRefreshToken) {
    throw new Error("Google OAuth token response omitted the granted scopes");
  }
  const refreshToken = response.refresh_token === undefined
    ? null
    : safeText(response.refresh_token, "Google OAuth refresh token", 8, 16 * 1_024);
  if (requireRefreshToken && refreshToken === null) {
    throw new Error("Google did not issue a refresh token; revoke the prior app grant and repeat login");
  }
  const refreshTokenExpiresInSeconds = response.refresh_token_expires_in === undefined
    ? null
    : safeInteger(
        response.refresh_token_expires_in,
        "Google OAuth refresh_token_expires_in",
        60,
        10 * 365 * 24 * 60 * 60,
      );
  return Object.freeze({
    accessToken,
    expiresInSeconds,
    refreshToken,
    refreshTokenExpiresInSeconds,
  });
}

async function exchangeAuthorizationCode(
  client: GoogleDesktopClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  scopes: readonly string[],
  fetch_: ProviderFetch,
): Promise<GoogleTokenExchange> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (client.clientSecret !== null) body.set("client_secret", client.clientSecret);
  const http = new ProviderHttpClient(fetch_, GOOGLE_OAUTH_TIMEOUT_MS, MAX_GOOGLE_RESPONSE_BYTES);
  const response = await http.request(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    [200],
    GOOGLE_TOKEN_HOSTS,
    MAX_GOOGLE_RESPONSE_BYTES,
    "application/json",
  );
  return parseTokenResponse(response.body, scopes, true);
}

async function authenticatedGmailSubject(
  accessToken: string,
  fetch_: ProviderFetch,
): Promise<string> {
  const http = new ProviderHttpClient(fetch_, GOOGLE_OAUTH_TIMEOUT_MS, MAX_GOOGLE_RESPONSE_BYTES);
  const response = await http.request(
    GOOGLE_PROFILE_URL,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    [200],
    GOOGLE_GMAIL_HOSTS,
    MAX_GOOGLE_RESPONSE_BYTES,
    "application/json",
  );
  const profile = strictRecord(response.body, "Google Gmail profile response");
  exactKeys(profile, ["emailAddress"], [], "Google Gmail profile response");
  if (
    typeof profile.emailAddress !== "string"
    || !isGmailAccountSubject(profile.emailAddress)
  ) {
    throw new Error("Google Gmail profile returned an invalid account email");
  }
  return profile.emailAddress.toLowerCase();
}

function isoAfter(now: Date, seconds: number): string {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Google OAuth reference time is invalid");
  return new Date(nowMs + seconds * 1_000).toISOString();
}

export async function loginGoogleOAuth(
  input: Readonly<{
    clientFile: string;
    scopes?: readonly string[];
    openBrowser?: boolean;
    onAuthorizationUrl?: (url: string) => void;
    signal?: AbortSignal;
  }>,
  dependencies: GoogleOAuthLoginDependencies = {},
): Promise<GoogleOAuthLoginResult> {
  const client = loadGoogleDesktopClient(input.clientFile);
  const scopes = Object.freeze([...(input.scopes ?? GOOGLE_GMAIL_READ_SCOPES)].sort());
  exactSortedScopes(scopes, GOOGLE_GMAIL_READ_SCOPES, "Google OAuth requested scopes");
  const random = dependencies.randomBytes ?? ((size: number) => randomBytes(size));
  const state = base64Url(random(32));
  const codeVerifier = base64Url(random(64));
  if (state.length < 32 || codeVerifier.length < 43 || codeVerifier.length > 128) {
    throw new Error("Google OAuth secure random source returned invalid entropy");
  }
  const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const request: GoogleOAuthAuthorizationRequest = Object.freeze({
    clientId: client.clientId,
    scopes,
    state,
    codeChallenge,
    openBrowser: input.openBrowser ?? true,
    onAuthorizationUrl: input.onAuthorizationUrl ?? (() => undefined),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const authorization = await (dependencies.authorize ?? defaultAuthorize)(request);
  const redirect = new URL(authorization.redirectUri);
  if (
    redirect.protocol !== "http:"
    || redirect.hostname !== "127.0.0.1"
    || redirect.pathname !== CALLBACK_PATH
    || redirect.search !== ""
    || redirect.hash !== ""
    || redirect.username !== ""
    || redirect.password !== ""
    || redirect.port === ""
  ) throw new Error("Google OAuth authorization returned an invalid loopback redirect");
  const code = safeText(authorization.code, "Google authorization code", 8, 4_096);
  const fetch_ = scopedFetch(
    dependencies.fetch,
    dependencies.pinnedFetch ?? pinnedHttpsFetch,
    input.signal,
  );
  const exchange = await exchangeAuthorizationCode(
    client,
    code,
    codeVerifier,
    redirect.href,
    scopes,
    fetch_,
  );
  const subject = await authenticatedGmailSubject(exchange.accessToken, fetch_);
  const now = (dependencies.now ?? (() => new Date()))();
  const expiresAt = isoAfter(now, exchange.expiresInSeconds);
  const refreshTokenExpiresAt = exchange.refreshTokenExpiresInSeconds === null
    ? null
    : isoAfter(now, exchange.refreshTokenExpiresInSeconds);
  if (exchange.refreshToken === null) {
    throw new Error("Google did not issue a refresh token");
  }
  const refresh: GoogleInstalledAppRefresh = Object.freeze({
    kind: "google-installed-app" as const,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken: exchange.refreshToken,
    refreshTokenExpiresAt,
  });
  const credential: GoogleOAuthCredentialDocument = Object.freeze({
    schemaVersion: 2 as const,
    provider: "gmail" as const,
    subject,
    scopes,
    accessToken: exchange.accessToken,
    expiresAt,
    refresh,
  });
  return Object.freeze({ subject, scopes, credential, refreshTokenExpiresAt });
}

function managedTokenDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(wrenchStateHome(environment), "auth", "oauth-tokens");
}

function isManagedTokenPath(
  auth: OAuthTokenAuth,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (auth.managed !== true) return false;
  const path = resolve(auth.path);
  return dirname(path) === managedTokenDirectory(environment)
    && new RegExp(`^${auth.id}-[0-9a-f-]{36}\\.json$`, "u").test(basename(path));
}

function removeManagedTokenIfPresent(
  auth: WrenchAuth | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (auth?.kind !== "oauth-token-file" || !isManagedTokenPath(auth, environment)) return;
  const content = readPrivateStateFileIfPresent(
    auth.path,
    MAX_GOOGLE_CLIENT_FILE_BYTES,
    "managed OAuth credential",
    environment,
  );
  if (content === null) return;
  const removed = removePrivateStateFileIfUnchanged(
    auth.path,
    { expectedCurrentContentSha256: createHash("sha256").update(content, "utf8").digest("hex") },
    environment,
  );
  if (!removed) throw new Error("managed OAuth credential changed before cleanup");
}

export function installManagedGoogleOAuth(
  id: string,
  login: GoogleOAuthLoginResult,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: Readonly<{ force?: boolean }> = {},
): Readonly<{ auth: OAuthTokenAuth; path: string }> {
  const previous = loadAuthSnapshotIfPresent(id, environment)?.auth;
  const tokenPath = join(managedTokenDirectory(environment), `${id}-${randomUUID()}.json`);
  const content = `${canonicalJson(login.credential)}\n`;
  if (!createPrivateJsonIfAbsent(tokenPath, login.credential, {
    environment,
    privateParent: true,
  }).created) throw new Error("managed OAuth credential path already exists");
  const auth = createAuth(id, {
    oauthProvider: "gmail",
    tokenFile: tokenPath,
    scopes: login.scopes,
    subject: login.subject,
    managed: true,
  });
  if (auth.kind !== "oauth-token-file") throw new Error("managed OAuth login created the wrong auth kind");
  let path: string;
  try {
    path = saveAuth(
      auth,
      environment,
      options.force === undefined ? {} : { force: options.force },
    );
  } catch (error) {
    removePrivateStateFileIfUnchanged(
      tokenPath,
      { expectedCurrentContentSha256: createHash("sha256").update(content, "utf8").digest("hex") },
      environment,
    );
    throw error;
  }
  if (
    previous?.kind === "oauth-token-file"
    && previous.path !== tokenPath
  ) removeManagedTokenIfPresent(previous, environment);
  return Object.freeze({ auth, path });
}

function credentialDocument(
  auth: OAuthTokenAuth,
  accessToken: string,
  expiresAt: string,
  refresh: GoogleInstalledAppRefresh,
): GoogleOAuthCredentialDocument {
  if (auth.subject === undefined || !isGmailAccountSubject(auth.subject)) {
    throw new Error("managed Google OAuth auth requires an exact Gmail subject");
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    provider: "gmail" as const,
    subject: auth.subject,
    scopes: auth.scopes,
    accessToken,
    expiresAt,
    refresh,
  });
}

export function resolveOAuthToken(
  auth: OAuthTokenAuth,
  options: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    now?: Date;
    minimumValidityMs?: number;
    fetch?: ProviderFetch;
    pinnedFetch?: PinnedHttpsFetch;
    signal?: AbortSignal;
  }> = {},
): LoadedOAuthToken | Promise<LoadedOAuthToken> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const minimumValidityMs = options.minimumValidityMs ?? 30_000;
  if (
    !Number.isFinite(nowMs)
    || !Number.isSafeInteger(minimumValidityMs)
    || minimumValidityMs < 0
  ) throw new Error("OAuth token refresh validity budget is invalid");
  let credential = loadOAuthCredential(auth);
  if (
    credential.expiresAt === null
    || Date.parse(credential.expiresAt) - nowMs > minimumValidityMs
  ) return Object.freeze({ accessToken: credential.accessToken, expiresAt: credential.expiresAt });
  if (
    credential.schemaVersion !== 2
    || credential.refresh === null
    || !isManagedTokenPath(auth, environment)
  ) {
    return loadOAuthToken(auth, now, minimumValidityMs);
  }
  const refresh = credential.refresh;
  if (
    refresh.refreshTokenExpiresAt !== null
    && Date.parse(refresh.refreshTokenExpiresAt) <= nowMs
  ) throw new Error("the managed Google refresh credential expired; run wrench auth login again");
  return (async (): Promise<LoadedOAuthToken> => {
    const fetch_ = scopedFetch(
      options.fetch,
      options.pinnedFetch ?? pinnedHttpsFetch,
      options.signal,
    );
    const body = new URLSearchParams({
      client_id: refresh.clientId,
      grant_type: "refresh_token",
      refresh_token: refresh.refreshToken,
    });
    if (refresh.clientSecret !== null) {
      body.set("client_secret", refresh.clientSecret);
    }
    const http = new ProviderHttpClient(fetch_, GOOGLE_OAUTH_TIMEOUT_MS, MAX_GOOGLE_RESPONSE_BYTES);
    const response = await http.request(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
      [200],
      GOOGLE_TOKEN_HOSTS,
      MAX_GOOGLE_RESPONSE_BYTES,
      "application/json",
    );
    const refreshed = parseTokenResponse(response.body, auth.scopes, false);
    const expiresAt = isoAfter(now, refreshed.expiresInSeconds);
    const replacement = credentialDocument(
      auth,
      refreshed.accessToken,
      expiresAt,
      refresh,
    );
    if (!writePrivateJsonIfUnchanged(auth.path, replacement, {
      expectedCurrentContentSha256: credential.contentSha256,
    })) {
      credential = loadOAuthCredential(auth);
      if (
        credential.expiresAt !== null
        && Date.parse(credential.expiresAt) - nowMs > minimumValidityMs
      ) return Object.freeze({ accessToken: credential.accessToken, expiresAt: credential.expiresAt });
      throw new Error("managed Google OAuth credential changed concurrently before refresh");
    }
    return Object.freeze({ accessToken: refreshed.accessToken, expiresAt });
  })();
}
