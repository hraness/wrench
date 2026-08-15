import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import { cookieSources, type CookieSource } from "@hraness/kb/clip/args";
import { canonicalJson } from "./canonical-json";
import {
  assertLinkedDeviceLifecycleAdmissionHeld,
  linkedDeviceLifecycleAdmissionStore,
  type LinkedDeviceLifecycleAdmission,
} from "./linked-device-lifecycle-admission";
import {
  listLinkedDeviceLifecycleJournalSnapshots,
} from "./linked-device-lifecycle-journal";
import {
  MAX_WRENCH_JSON_BYTES,
  createPrivateJsonIfAbsent,
  readPrivateStateFilesBatched,
  readPrivateStateFileIfPresent,
  removePrivateStateFileIfUnchanged,
  wrenchStateHome,
  snapshotPrivateStateDirectory,
  writePrivateJsonIfUnchanged,
} from "./storage";
import { removeSessionSecretsForAuth } from "./session-secrets";
import {
  removeReadProjectionsForAuth,
  removeReadProjectionAuthIncarnation,
  rotateReadProjectionAuthIncarnation,
  withReadProjectionAuthAdmission,
} from "./read-projections";
import {
  isProviderPluginSurfaceId,
  type ProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";
export {
  isGmailAccountSubject,
  isLinkedInProviderActorSubject,
  isLinkedInWebAccountSubject,
  isXAccountSubject,
} from "./provider-subject";

export type OAuthProvider = ProviderPluginSurfaceId;

export type LinkedDeviceProvider = ProviderPluginSurfaceId;

export type WrenchAuth =
  | {
      readonly schemaVersion: 1;
      readonly id: string;
      readonly kind: "cookie-source";
      readonly source: CookieSource;
      readonly profile?: string;
      readonly subject?: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly id: string;
      readonly kind: "cookies-file";
      readonly path: string;
      readonly subject?: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly id: string;
      readonly kind: "browser-profile";
      readonly profile: string;
      readonly browserExecutable?: string;
      readonly trustUnfilteredEgress: true;
      readonly cookieSource?: CookieSource;
      readonly cookieProfile?: string;
      readonly subject?: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly id: string;
      readonly kind: "oauth-token-file";
      readonly provider: OAuthProvider;
      readonly path: string;
      readonly scopes: readonly string[];
      /** The credential lifecycle and token file are owned by Wrench. */
      readonly managed?: true;
      readonly subject?: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly id: string;
      readonly kind: "linked-device-store";
      readonly provider: LinkedDeviceProvider;
      readonly path: string;
      /** Stable, secret-free lifecycle serialization coordinate. */
      readonly realmKey?: string;
      readonly subject?: string;
    };

export type AuthInput =
  | { readonly source: CookieSource; readonly profile?: string; readonly subject?: string }
  | { readonly cookiesFile: string; readonly subject?: string }
  | {
      readonly browserProfile: string;
      readonly browserExecutable?: string;
      readonly trustUnfilteredEgress: boolean;
      readonly cookieSource?: CookieSource;
      readonly cookieProfile?: string;
      readonly subject?: string;
    }
  | {
      readonly oauthProvider: OAuthProvider;
      readonly tokenFile: string;
      readonly scopes: readonly string[];
      readonly managed?: true;
      readonly subject?: string;
    }
  | {
      readonly linkedDeviceProvider: LinkedDeviceProvider;
      readonly deviceStore: string;
      readonly subject?: string;
    };

export type AuthSnapshot = {
  readonly auth: WrenchAuth;
  /** SHA-256 of the exact canonical file bytes, including the final LF. */
  readonly contentSha256: string;
};

export type AuthReplaceResult =
  | {
      readonly replaced: true;
      readonly snapshot: AuthSnapshot;
    }
  | { readonly replaced: false };

export type AuthReplaceAuthority = {
  readonly lifecycleAdmission: LinkedDeviceLifecycleAdmission;
};

type LinkedDeviceAuth = Extract<
  WrenchAuth,
  { readonly kind: "linked-device-store" }
>;

function authPath(id: string, environment: Readonly<Record<string, string | undefined>>): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(id)) throw new Error("auth ID must be lowercase kebab-case");
  return join(wrenchStateHome(environment), "auth", `${id}.json`);
}

/**
 * Resolve an existing store to its physical path. A store that has not been
 * created yet is bound to the real nearest ancestor plus its missing suffix,
 * so two locator aliases cannot acquire different lifecycle coordinates.
 */
export function canonicalLinkedDeviceStorePath(pathValue: string): string {
  const suffix: string[] = [];
  let ancestor = resolve(pathValue);
  while (!existsSync(ancestor)) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(
          "linked-device store path contains an unresolved symbolic link",
        );
      }
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("linked-device store path has no existing ancestor");
    }
    suffix.unshift(ancestor.slice(parent.length + (
      parent.endsWith("/") ? 0 : 1
    )));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

/**
 * Secret-free, auth-ID-independent serialization identity for one physical
 * linked-device provider realm.
 */
export function linkedDeviceRealmKey(auth: LinkedDeviceAuth): string {
  const canonicalPath = canonicalLinkedDeviceStorePath(auth.path);
  if (
    auth.realmKey !== undefined
    && canonicalPath !== auth.path
  ) {
    throw new Error(
      "linked-device realm key requires a persisted canonical store path",
    );
  }
  const expected = deriveLinkedDeviceRealmKey(
    auth.provider,
    canonicalPath,
  );
  if (auth.realmKey !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(auth.realmKey)) {
      throw new Error("linked-device auth has a malformed stable realm key");
    }
    if (auth.realmKey !== expected) {
      throw new Error(
        "linked-device auth realm key does not match its provider and canonical store path",
      );
    }
  }
  return expected;
}

function deriveLinkedDeviceRealmKey(
  provider: LinkedDeviceProvider,
  canonicalStorePath: string,
): string {
  return createHash("sha256")
    .update("io-linked-device-realm-v1\0", "utf8")
    .update(canonicalJson({
      kind: "linked-device-store",
      provider,
      // Linked-device auth records persist only canonical physical locators.
      // Hashing those stored bytes keeps this coordinate stable even if the
      // named directory is later replaced or an old alias is retargeted.
      storePath: canonicalStorePath,
    }), "utf8")
    .digest("hex");
}

export function createAuth(id: string, input: AuthInput): WrenchAuth {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(id)) throw new Error("auth ID must be lowercase kebab-case");
  const subject = input.subject === undefined ? undefined : normalizeAuthSubject(input.subject);
  if ("linkedDeviceProvider" in input) {
    if (!isProviderPluginSurfaceId(input.linkedDeviceProvider)) {
      throw new Error("linked-device auth has an invalid provider");
    }
    if (!isSafeAuthPath(input.deviceStore)) {
      throw new Error("linked-device auth has an invalid store path");
    }
    const path = canonicalLinkedDeviceStorePath(input.deviceStore);
    return {
      schemaVersion: 1,
      id,
      kind: "linked-device-store",
      provider: input.linkedDeviceProvider,
      path,
      realmKey: deriveLinkedDeviceRealmKey(
        input.linkedDeviceProvider,
        path,
      ),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if ("oauthProvider" in input) {
    if (!isProviderPluginSurfaceId(input.oauthProvider)) {
      throw new Error("OAuth token-file auth has an invalid provider");
    }
    if (!isSafeOAuthTokenPath(input.tokenFile)) throw new Error("OAuth token-file auth has an invalid path");
    return {
      schemaVersion: 1,
      id,
      kind: "oauth-token-file",
      provider: input.oauthProvider,
      path: resolve(input.tokenFile),
      scopes: normalizeOAuthScopes(input.scopes),
      ...(input.managed === true ? { managed: true as const } : {}),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if ("browserProfile" in input) {
    if (!input.trustUnfilteredEgress) {
      throw new Error("browser profiles require --trust-profile-egress because profile sessions cannot use agent-browser domain containment");
    }
    if (!isSafeString(input.browserProfile, 4_096) || !isSafeBrowserProfile(input.browserProfile)) {
      throw new Error("browser profile is invalid or unsafe");
    }
    if (
      input.browserExecutable !== undefined
      && (!isSafeAuthPath(input.browserExecutable) || input.browserExecutable.trim() !== input.browserExecutable)
    ) {
      throw new Error("browser executable is invalid or unsafe");
    }
    if (input.cookieSource !== undefined && !cookieSources.includes(input.cookieSource)) {
      throw new Error("browser-profile auth has an invalid cookie source");
    }
    if (input.cookieProfile !== undefined && (input.cookieSource === undefined || !isSafeString(input.cookieProfile, 4_096))) {
      throw new Error("browser-profile cookie profile requires a valid cookie source");
    }
    return {
      schemaVersion: 1,
      id,
      kind: "browser-profile",
      profile: browserProfileLocator(input.browserProfile),
      ...(input.browserExecutable === undefined
        ? {}
        : { browserExecutable: resolve(input.browserExecutable) }),
      trustUnfilteredEgress: true,
      ...(input.cookieSource === undefined ? {} : { cookieSource: input.cookieSource }),
      ...(input.cookieProfile === undefined ? {} : { cookieProfile: input.cookieProfile }),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if ("source" in input) {
    if (!cookieSources.includes(input.source) || (input.profile !== undefined && !isSafeString(input.profile, 4_096))) {
      throw new Error("cookie-source auth has an invalid source or profile");
    }
    return {
      schemaVersion: 1,
      id,
      kind: "cookie-source",
      source: input.source,
      ...(input.profile === undefined ? {} : { profile: browserProfileLocator(input.profile) }),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if ("cookiesFile" in input) {
    if (!isSafeString(input.cookiesFile, 4_096)) throw new Error("cookies-file auth has an invalid path");
    return {
      schemaVersion: 1,
      id,
      kind: "cookies-file",
      path: resolve(input.cookiesFile),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  throw new Error("auth locator kind is not supported");
}

export function saveAuth(
  authValue: WrenchAuth,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: { readonly force?: boolean } = {},
): string {
  const replacement = canonicalAuthSnapshot(authValue);
  const auth = replacement.auth;
  const path = authPath(auth.id, environment);
  let current: AuthSnapshot | null;
  try {
    current = loadAuthSnapshotIfPresent(auth.id, environment);
  } catch {
    throw new Error(`auth locator ${auth.id} already exists but is invalid; inspect or remove it before replacement`);
  }
  if (
    current !== null
    && options.force !== true
    && current.contentSha256 !== replacement.contentSha256
  ) {
    throw new Error(
      `auth locator ${auth.id} already names a different access realm; use a new ID or repeat with --force after reviewing cache and action identity`,
    );
  }
  if (
    current !== null
    && current.contentSha256 === replacement.contentSha256
  ) return path;

  return withLinkedDeviceAuthMutationAdmissions(
    current?.auth,
    auth,
    environment,
    () => withReadProjectionAuthAdmission(auth.id, environment, () => {
      const observed = loadAuthSnapshotIfPresent(auth.id, environment);
      if (current === null) {
        if (observed !== null) {
          throw new Error(
            `auth locator ${auth.id} changed concurrently before creation`,
          );
        }
        rotateReadProjectionAuthIncarnation(auth.id, environment);
        removePrivateAuthState(auth.id, environment);
        if (!createPrivateJsonIfAbsent(
          path,
          auth,
          { privateParent: true, environment },
        ).created) {
          throw new Error(
            `auth locator ${auth.id} changed concurrently before creation`,
          );
        }
        return path;
      }
      if (
        observed === null
        || observed.contentSha256 !== current.contentSha256
      ) {
        throw new Error(
          `auth locator ${auth.id} changed concurrently before replacement`,
        );
      }
      rotateReadProjectionAuthIncarnation(auth.id, environment);
      removePrivateAuthState(auth.id, environment);
      if (!writePrivateJsonIfUnchanged(
        path,
        auth,
        { expectedCurrentContentSha256: current.contentSha256 },
      )) {
        throw new Error(
          `auth locator ${auth.id} changed concurrently before replacement`,
        );
      }
      return path;
    }),
  );
}

function isSafeString(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function normalizeAuthSubject(value: string): string {
  if (
    !isSafeString(value, 512)
    || value.trim() !== value
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~:@-]{1,512}$/u.test(value)
  ) throw new Error("auth locator has an invalid subject");
  return value;
}

export const normalizeOAuthSubject = normalizeAuthSubject;

function isSafeAuthPath(value: unknown): value is string {
  if (!isSafeString(value, 4_096)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code >= 0x80 && code <= 0x9f)
      || code === 0x061c
      || code === 0x200e
      || code === 0x200f
      || (code >= 0x2028 && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
    ) return false;
  }
  return true;
}

const isSafeOAuthTokenPath = isSafeAuthPath;

function isCanonicalHttpsOAuthScope(value: string): boolean {
  if (value === "https://mail.google.com/") return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && url.port === ""
    && url.search === ""
    && url.hash === ""
    && url.pathname !== "/"
    && url.href === value
    && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(url.hostname)
    && url.hostname.includes(".")
    && /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/u.test(url.pathname);
}

export function normalizeOAuthScopes(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) {
    throw new Error("OAuth token-file auth requires between 1 and 64 scopes");
  }
  const scopes = values.map((value) => {
    if (
      !isSafeString(value, 128)
      || value.trim() !== value
      || (
        !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(value)
        && !isCanonicalHttpsOAuthScope(value)
      )
    ) {
      throw new Error(
        "OAuth scopes must be provider scope names or canonical HTTPS scope URLs without whitespace or control characters",
      );
    }
    return value;
  });
  if (new Set(scopes).size !== scopes.length) throw new Error("OAuth scopes must not contain duplicates");
  return [...scopes].sort();
}

function isSafeBrowserProfile(value: string): boolean {
  const named = !value.includes("/") && !value.includes("\\");
  if (!named) return true;
  if (value.length > 256 || value.trim() !== value || value.startsWith("-") || value === "." || value === "..") return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code >= 0x80 && code <= 0x9f)
      || code === 0x061c
      || code === 0x200e
      || code === 0x200f
      || (code >= 0x2028 && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
    ) return false;
  }
  return true;
}

function browserProfileLocator(value: string): string {
  const pathLike = isAbsolute(value)
    || value.startsWith("./")
    || value.startsWith("../")
    || value.includes("/")
    || value.includes("\\");
  return pathLike ? resolve(value) : value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

export function parseAuth(value: unknown): WrenchAuth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("auth record must be an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !isSafeString(record.id, 48) || !/^[a-z][a-z0-9-]*$/u.test(record.id)) {
    throw new Error("auth record has an invalid schema version or ID");
  }
  if (record.kind === "cookie-source") {
    const expected = ["schemaVersion", "id", "kind", "source"];
    if (record.profile !== undefined) expected.push("profile");
    if (record.subject !== undefined) expected.push("subject");
    if (!exactKeys(record, expected)) throw new Error("auth record has unsupported fields");
    if (typeof record.source !== "string" || !cookieSources.includes(record.source as CookieSource)) {
      throw new Error("auth record has an invalid cookie source");
    }
    if (record.profile !== undefined && !isSafeString(record.profile, 4_096)) throw new Error("auth record has an invalid profile");
    if (
      typeof record.profile === "string"
      && (record.profile.includes("/") || record.profile.includes("\\"))
      && !isAbsolute(record.profile)
    ) throw new Error("auth record cookie profile paths must be absolute");
    if (record.subject !== undefined && typeof record.subject !== "string") {
      throw new Error("auth record has an invalid subject");
    }
    const subject = typeof record.subject === "string" ? normalizeAuthSubject(record.subject) : undefined;
    return {
      schemaVersion: 1,
      id: record.id,
      kind: "cookie-source",
      source: record.source as CookieSource,
      ...(typeof record.profile !== "string" ? {} : { profile: record.profile }),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if (record.kind === "cookies-file") {
    const expected = ["schemaVersion", "id", "kind", "path"];
    if (record.subject !== undefined) expected.push("subject");
    if (!exactKeys(record, expected)) throw new Error("auth record has unsupported fields");
    if (!isSafeString(record.path, 4_096) || !isAbsolute(record.path)) throw new Error("auth record has an invalid or non-absolute cookie file path");
    if (record.subject !== undefined && typeof record.subject !== "string") {
      throw new Error("auth record has an invalid subject");
    }
    const subject = typeof record.subject === "string" ? normalizeAuthSubject(record.subject) : undefined;
    return {
      schemaVersion: 1,
      id: record.id,
      kind: "cookies-file",
      path: record.path,
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if (record.kind === "browser-profile") {
    const expected = ["schemaVersion", "id", "kind", "profile", "trustUnfilteredEgress"];
    if (record.browserExecutable !== undefined) expected.push("browserExecutable");
    if (record.cookieSource !== undefined) expected.push("cookieSource");
    if (record.cookieProfile !== undefined) expected.push("cookieProfile");
    if (record.subject !== undefined) expected.push("subject");
    if (!exactKeys(record, expected)) throw new Error("auth record has unsupported fields");
    if (!isSafeString(record.profile, 4_096) || !isSafeBrowserProfile(record.profile) || record.trustUnfilteredEgress !== true) {
      throw new Error("auth record has an invalid browser profile or trust acknowledgement");
    }
    if ((record.profile.includes("/") || record.profile.includes("\\")) && !isAbsolute(record.profile)) {
      throw new Error("auth record browser profile paths must be absolute");
    }
    if (
      record.browserExecutable !== undefined
      && (
        !isSafeAuthPath(record.browserExecutable)
        || !isAbsolute(record.browserExecutable)
        || record.browserExecutable.trim() !== record.browserExecutable
      )
    ) throw new Error("auth record has an invalid browser executable");
    if (
      record.cookieSource !== undefined
      && (typeof record.cookieSource !== "string" || !cookieSources.includes(record.cookieSource as CookieSource))
    ) throw new Error("auth record has an invalid browser-profile cookie source");
    if (
      record.cookieProfile !== undefined
      && (record.cookieSource === undefined || !isSafeString(record.cookieProfile, 4_096))
    ) throw new Error("auth record has an invalid browser-profile cookie profile");
    if (record.subject !== undefined && typeof record.subject !== "string") {
      throw new Error("auth record has an invalid subject");
    }
    const subject = typeof record.subject === "string" ? normalizeAuthSubject(record.subject) : undefined;
    return {
      schemaVersion: 1,
      id: record.id,
      kind: "browser-profile",
      profile: record.profile,
      ...(typeof record.browserExecutable !== "string"
        ? {}
        : { browserExecutable: record.browserExecutable }),
      trustUnfilteredEgress: true,
      ...(typeof record.cookieSource !== "string" ? {} : { cookieSource: record.cookieSource as CookieSource }),
      ...(typeof record.cookieProfile !== "string" ? {} : { cookieProfile: record.cookieProfile }),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if (record.kind === "oauth-token-file") {
    const expected = ["schemaVersion", "id", "kind", "provider", "path", "scopes"];
    if (record.managed !== undefined) expected.push("managed");
    if (record.subject !== undefined) expected.push("subject");
    if (!exactKeys(record, expected)) throw new Error("auth record has unsupported fields");
    if (!isProviderPluginSurfaceId(record.provider)) {
      throw new Error("auth record has an invalid OAuth provider");
    }
    if (!isSafeOAuthTokenPath(record.path) || !isAbsolute(record.path)) {
      throw new Error("auth record has an invalid or non-absolute OAuth token file path");
    }
    if (record.managed !== undefined && record.managed !== true) {
      throw new Error("auth record has an invalid managed OAuth lifecycle marker");
    }
    const rawScopes = record.scopes;
    if (!Array.isArray(rawScopes) || !rawScopes.every((scope) => typeof scope === "string")) {
      throw new Error("auth record has invalid OAuth scopes");
    }
    const scopes = normalizeOAuthScopes(rawScopes);
    if (scopes.some((scope, index) => scope !== rawScopes[index])) {
      throw new Error("auth record OAuth scopes must be sorted");
    }
    if (record.subject !== undefined && typeof record.subject !== "string") {
      throw new Error("auth record has an invalid OAuth subject");
    }
    const subject = typeof record.subject === "string" ? normalizeAuthSubject(record.subject) : undefined;
    return {
      schemaVersion: 1,
      id: record.id,
      kind: "oauth-token-file",
      provider: record.provider,
      path: record.path,
      scopes,
      ...(record.managed === true ? { managed: true as const } : {}),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  if (record.kind === "linked-device-store") {
    const expected = ["schemaVersion", "id", "kind", "provider", "path"];
    if (record.realmKey !== undefined) expected.push("realmKey");
    if (record.subject !== undefined) expected.push("subject");
    if (!exactKeys(record, expected)) throw new Error("auth record has unsupported fields");
    if (!isProviderPluginSurfaceId(record.provider)) {
      throw new Error("auth record has an invalid linked-device provider");
    }
    if (!isSafeAuthPath(record.path) || !isAbsolute(record.path)) {
      throw new Error("auth record has an invalid or non-absolute linked-device store path");
    }
    const canonicalPath = canonicalLinkedDeviceStorePath(record.path);
    if (
      record.realmKey !== undefined
      && canonicalPath !== record.path
    ) {
      throw new Error(
        "auth record linked-device store path must be canonical",
      );
    }
    if (
      record.realmKey !== undefined
      && (
        typeof record.realmKey !== "string"
        || !/^[a-f0-9]{64}$/u.test(record.realmKey)
      )
    ) {
      throw new Error("auth record has an invalid linked-device realm key");
    }
    const realmKey = deriveLinkedDeviceRealmKey(
      record.provider,
      canonicalPath,
    );
    if (
      typeof record.realmKey === "string"
      && record.realmKey !== realmKey
    ) {
      throw new Error(
        "auth record linked-device realm key does not match its provider and canonical store path",
      );
    }
    if (record.subject !== undefined && typeof record.subject !== "string") {
      throw new Error("auth record has an invalid linked-device subject");
    }
    const subject = typeof record.subject === "string"
      ? normalizeAuthSubject(record.subject)
      : undefined;
    return {
      schemaVersion: 1,
      id: record.id,
      kind: "linked-device-store",
      provider: record.provider,
      path: record.path,
      ...(record.realmKey === undefined ? {} : { realmKey }),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  throw new Error("auth record kind is not supported");
}

function canonicalAuthSnapshot(authValue: unknown): AuthSnapshot {
  const parsed = parseAuth(authValue);
  const auth: WrenchAuth = parsed.kind === "oauth-token-file"
    ? Object.freeze({
        ...parsed,
        scopes: Object.freeze([...parsed.scopes]),
      })
    : Object.freeze({ ...parsed });
  const content = `${canonicalJson(auth)}\n`;
  return Object.freeze({
    auth,
    contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
  });
}

function parseAuthSnapshotText(
  id: string,
  content: string,
): AuthSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error("auth record is malformed JSON");
  }
  const snapshot = canonicalAuthSnapshot(value);
  if (snapshot.auth.id !== id) {
    throw new Error("auth record ID does not match its filename");
  }
  if (content !== `${canonicalJson(snapshot.auth)}\n`) {
    throw new Error("auth record is not canonical JSON");
  }
  return Object.freeze({
    auth: snapshot.auth,
    contentSha256: createHash("sha256")
      .update(content, "utf8")
      .digest("hex"),
  });
}

export function loadAuthSnapshotIfPresent(
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
): AuthSnapshot | null {
  const content = readPrivateStateFileIfPresent(
    authPath(id, environment),
    MAX_WRENCH_JSON_BYTES,
    "auth record",
    environment,
  );
  return content === null ? null : parseAuthSnapshotText(id, content);
}

function linkedDeviceMutationRealms(
  current: WrenchAuth | undefined,
  replacement: WrenchAuth | undefined,
  authIds: ReadonlySet<string>,
  journals: ReturnType<typeof listLinkedDeviceLifecycleJournalSnapshots>,
): readonly {
  readonly key: string;
  readonly authId: string;
}[] {
  const byKey = new Map<string, string>();
  for (const auth of [current, replacement]) {
    if (auth?.kind !== "linked-device-store") continue;
    const key = linkedDeviceRealmKey(auth);
    const existing = byKey.get(key);
    if (existing === undefined || auth.id < existing) {
      byKey.set(key, auth.id);
    }
  }
  for (const entry of journals) {
    if ("invalid" in entry) {
      throw new Error(
        "linked-device lifecycle journals contain invalid state; auth mutation is blocked",
      );
    }
    if (!authIds.has(entry.journal.authId)) continue;
    const existing = byKey.get(entry.journal.authRealmHash);
    if (
      existing === undefined
      || entry.journal.authId < existing
    ) {
      byKey.set(entry.journal.authRealmHash, entry.journal.authId);
    }
  }
  return Object.freeze(
    [...byKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, authIdValue]) =>
        Object.freeze({ key, authId: authIdValue })
      ),
  );
}

function assertLinkedDeviceMutationJournalsSettled(
  realmKeys: ReadonlySet<string>,
  authIds: ReadonlySet<string>,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (realmKeys.size === 0 && authIds.size === 0) return;
  for (const entry of listLinkedDeviceLifecycleJournalSnapshots(environment)) {
    if ("invalid" in entry) {
      throw new Error(
        "linked-device lifecycle journals contain invalid state; auth mutation is blocked",
      );
    }
    const { journal } = entry;
    if (
      !realmKeys.has(journal.authRealmHash)
      && !authIds.has(journal.authId)
    ) continue;
    if (
      journal.phase === "terminal"
      && journal.status !== "indeterminate"
    ) continue;
    throw new Error(
      `auth locator ${journal.authId} has an active or unreconciled linked-device lifecycle`,
    );
  }
}

function withLinkedDeviceAuthMutationAdmissions<T>(
  current: WrenchAuth | undefined,
  replacement: WrenchAuth | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  operation: () => T,
): T {
  const authIds = new Set(
    [current?.id, replacement?.id].filter(
      (id): id is string => id !== undefined,
    ),
  );
  const journals = listLinkedDeviceLifecycleJournalSnapshots(environment);
  const realms = linkedDeviceMutationRealms(
    current,
    replacement,
    authIds,
    journals,
  );
  if (realms.length === 0) return operation();
  const recovery = linkedDeviceLifecycleAdmissionStore.recover(environment);
  if (recovery.issues.length > 0) {
    throw new Error(
      "linked-device lifecycle admissions contain unresolved state; auth mutation is blocked",
    );
  }
  const acquiredAt = new Date().toISOString();
  const admissions: LinkedDeviceLifecycleAdmission[] = [];
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    for (const realm of realms) {
      admissions.push(linkedDeviceLifecycleAdmissionStore.acquire(
        realm.key,
        realm.authId,
        acquiredAt,
        environment,
      ));
    }
    assertLinkedDeviceMutationJournalsSettled(
      new Set(realms.map((realm) => realm.key)),
      authIds,
      environment,
    );
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const releaseErrors: unknown[] = [];
  for (const admission of admissions.reverse()) {
    try {
      admission.release();
    } catch (error) {
      releaseErrors.push(error);
    }
  }
  if (operationFailed) {
    if (releaseErrors.length === 0) throw operationError;
    throw new AggregateError(
      [operationError, ...releaseErrors],
      "linked-device auth mutation failed and its admissions could not be released",
    );
  }
  if (releaseErrors.length > 0) {
    throw new AggregateError(
      releaseErrors,
      "linked-device auth mutation admissions could not be released",
    );
  }
  return result as T;
}

function assertAuthSnapshot(value: AuthSnapshot): AuthSnapshot {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "auth,contentSha256"
    || typeof value.contentSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.contentSha256)
  ) throw new Error("auth snapshot is malformed");
  const canonical = canonicalAuthSnapshot(value.auth);
  if (canonical.contentSha256 !== value.contentSha256) {
    throw new Error("auth snapshot is not content-bound");
  }
  return canonical;
}

export function loadAuthSnapshot(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthSnapshot {
  const snapshot = loadAuthSnapshotIfPresent(id, environment);
  if (snapshot === null) throw new Error(`auth locator ${id} was not found`);
  return snapshot;
}

export function replaceAuthIfUnchanged(
  currentValue: AuthSnapshot,
  replacementValue: WrenchAuth,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  authority?: AuthReplaceAuthority,
): AuthReplaceResult {
  const current = assertAuthSnapshot(currentValue);
  const replacement = canonicalAuthSnapshot(replacementValue);
  if (replacement.auth.id !== current.auth.id) {
    throw new Error("auth replacement ID does not match its snapshot");
  }
  const replace = (): AuthReplaceResult =>
    withReadProjectionAuthAdmission(current.auth.id, environment, () => {
      const observed = loadAuthSnapshotIfPresent(current.auth.id, environment);
      if (
        observed === null
        || observed.contentSha256 !== current.contentSha256
      ) return Object.freeze({ replaced: false as const });
      rotateReadProjectionAuthIncarnation(current.auth.id, environment);
      removePrivateAuthState(current.auth.id, environment);
      const replaced = writePrivateJsonIfUnchanged(
        authPath(current.auth.id, environment),
        replacement.auth,
        { expectedCurrentContentSha256: current.contentSha256 },
      );
      if (!replaced) return Object.freeze({ replaced: false as const });
      return Object.freeze({ replaced: true as const, snapshot: replacement });
    });
  const linkedMutation = current.auth.kind === "linked-device-store"
    || replacement.auth.kind === "linked-device-store";
  if (!linkedMutation) return replace();
  if (authority !== undefined) {
    if (
      current.auth.kind !== "linked-device-store"
      || replacement.auth.kind !== "linked-device-store"
      || current.auth.id !== authority.lifecycleAdmission.authId
      || linkedDeviceRealmKey(current.auth)
        !== authority.lifecycleAdmission.realmKey
      || linkedDeviceRealmKey(replacement.auth)
        !== authority.lifecycleAdmission.realmKey
    ) {
      throw new Error(
        "linked-device auth replacement authority does not match one stable realm",
      );
    }
    assertLinkedDeviceLifecycleAdmissionHeld(
      authority.lifecycleAdmission,
      environment,
    );
    return replace();
  }
  return withLinkedDeviceAuthMutationAdmissions(
    current.auth,
    replacement.auth,
    environment,
    replace,
  );
}

export function loadAuth(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WrenchAuth {
  return loadAuthSnapshot(id, environment).auth;
}

export function listAuth(environment: Readonly<Record<string, string | undefined>> = process.env): readonly WrenchAuth[] {
  const directory = join(wrenchStateHome(environment), "auth");
  const snapshot = snapshotPrivateStateDirectory(directory, environment);
  if (snapshot.identity === null) return [];
  const names = snapshot.entries
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  return readPrivateStateFilesBatched(directory, names, {
    maximumBytesPerFile: MAX_WRENCH_JSON_BYTES,
    environment,
    expectedDirectoryIdentity: snapshot.identity,
  }).flatMap((file) => {
    const id = basename(file.name, ".json");
    if (file.status !== "present") return [];
    try {
      return [parseAuthSnapshotText(id, file.content).auth];
    } catch {
      return [];
    }
  });
}

function managedOAuthCredentialSnapshot(
  auth: WrenchAuth,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{ path: string; contentSha256: string }> | null {
  if (auth.kind !== "oauth-token-file" || auth.managed !== true) return null;
  const expectedDirectory = join(wrenchStateHome(environment), "auth", "oauth-tokens");
  if (
    dirname(auth.path) !== expectedDirectory
    || !new RegExp(`^${auth.id}-[0-9a-f-]{36}\\.json$`, "u").test(basename(auth.path))
  ) throw new Error("managed OAuth credential path does not match its auth locator");
  const content = readPrivateStateFileIfPresent(
    auth.path,
    64 * 1024,
    "managed OAuth credential",
    environment,
  );
  return content === null
    ? null
    : Object.freeze({
        path: auth.path,
        contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
      });
}

export function removeAuth(id: string, environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const path = authPath(id, environment);
  let current: AuthSnapshot | null;
  try {
    current = loadAuthSnapshotIfPresent(id, environment);
  } catch {
    throw new Error(
      `auth locator ${id} is invalid; removal cannot prove that no linked-device lifecycle owns it`,
    );
  }
  if (current === null) {
    return withReadProjectionAuthAdmission(id, environment, () => {
      const observed = loadAuthSnapshotIfPresent(id, environment);
      if (observed !== null) {
        throw new Error(
          `auth locator ${id} changed concurrently before removal`,
        );
      }
      removePrivateAuthState(id, environment);
      removeReadProjectionAuthIncarnation(id, environment);
      return false;
    });
  }
  const managedCredential = managedOAuthCredentialSnapshot(
    current.auth,
    environment,
  );
  return withLinkedDeviceAuthMutationAdmissions(
    current.auth,
    undefined,
    environment,
    () => withReadProjectionAuthAdmission(id, environment, () => {
      const observed = loadAuthSnapshotIfPresent(id, environment);
      if (
        observed === null
        || observed.contentSha256 !== current.contentSha256
      ) {
        throw new Error(
          `auth locator ${id} changed concurrently before removal`,
        );
      }
      rotateReadProjectionAuthIncarnation(id, environment);
      removePrivateAuthState(id, environment);
      removeReadProjectionAuthIncarnation(id, environment);
      const removed = removePrivateStateFileIfUnchanged(
        path,
        { expectedCurrentContentSha256: current.contentSha256 },
        environment,
      );
      if (!removed) {
        throw new Error(
          `auth locator ${id} changed concurrently before removal`,
        );
      }
      if (
        managedCredential !== null
        && !removePrivateStateFileIfUnchanged(
          managedCredential.path,
          { expectedCurrentContentSha256: managedCredential.contentSha256 },
          environment,
        )
      ) {
        throw new Error(
          `managed OAuth credential for ${id} changed concurrently before removal`,
        );
      }
      return true;
    }),
  );
}

function removePrivateAuthState(
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const failures: unknown[] = [];
  try {
    removeSessionSecretsForAuth(id, environment);
  } catch (error) {
    failures.push(error);
  }
  try {
    removeReadProjectionsForAuth(id, environment);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `private state cleanup for auth locator ${id} failed`,
    );
  }
}
