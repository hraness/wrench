import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  listPrivateStateDirectory,
  readPrivateStateFileIfPresent,
  readRegularFile,
  removePrivateStateFile,
  wrenchStateHome,
  writePrivateJson,
  writePrivateJsonIfUnchanged,
} from "./storage";

const SESSION_SECRET_DIRECTORY = "session-secrets";
const SESSION_SECRET_KEY = ".session-encryption-key";
const MAX_KEY_BYTES = 512;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_ENCRYPTED_BYTES = 128 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

type SessionKey = {
  readonly id: string;
  readonly value: Buffer;
};

type EncryptedSessionSecretV1 = {
  readonly schemaVersion: 1;
  readonly encryption: "aes-256-gcm";
  readonly namespace: string;
  readonly authId: string;
  readonly authHash: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type EncryptedSessionSecretV2 = {
  readonly schemaVersion: 2;
  readonly encryption: "aes-256-gcm";
  readonly keyId: string;
  readonly namespace: string;
  readonly authId: string;
  readonly authHash: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type EncryptedSessionSecret =
  | EncryptedSessionSecretV1
  | EncryptedSessionSecretV2;

export type SessionSecretSnapshot = {
  readonly value: unknown;
  /**
   * SHA-256 of the exact encrypted file bytes, including the canonical
   * trailing newline. Null means the coordinate did not exist.
   */
  readonly contentSha256: string | null;
};

export type SessionSecretWriteResult =
  | {
    readonly written: true;
    readonly contentSha256: string;
  }
  | {
    readonly written: false;
  };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function validateCoordinate(namespace: string, authId: string, authHash: string): void {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(namespace)) {
    throw new Error("session-secret namespace must be lowercase kebab-case");
  }
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(authId)) {
    throw new Error("session-secret auth ID must be lowercase kebab-case");
  }
  if (!/^[a-f0-9]{64}$/u.test(authHash)) {
    throw new Error("session-secret auth hash is malformed");
  }
}

function directory(environment: Environment): string {
  return join(wrenchStateHome(environment), SESSION_SECRET_DIRECTORY);
}

function secretPath(
  namespace: string,
  authId: string,
  environment: Environment,
): string {
  return join(directory(environment), `${namespace}--${authId}.json`);
}

function keyPath(environment: Environment): string {
  return join(wrenchStateHome(environment), SESSION_SECRET_KEY);
}

function sessionKeyId(key: Uint8Array): string {
  return createHash("sha256")
    .update("io-session-key-id-v1\0", "utf8")
    .update(key)
    .digest("hex");
}

function newSessionKeyRecord(): Readonly<{
  schemaVersion: 2;
  keyId: string;
  key: string;
}> {
  const key = randomBytes(32);
  return Object.freeze({
    schemaVersion: 2,
    keyId: sessionKeyId(key),
    key: key.toString("hex"),
  });
}

function encryptedStoreHasState(environment: Environment): boolean {
  const sessionDirectory = directory(environment);
  const identity = ensurePrivateStateDirectory(sessionDirectory, environment);
  return listPrivateStateDirectory(
    sessionDirectory,
    environment,
    identity,
  ).length > 0;
}

function parseSessionKey(text: string): SessionKey {
  try {
    const parsed: unknown = JSON.parse(text);
    const value = record(parsed, "session encryption key");
    if (value.schemaVersion === 1) {
      exactKeys(value, ["schemaVersion", "key"], "session encryption key");
    } else if (value.schemaVersion === 2) {
      exactKeys(
        value,
        ["schemaVersion", "keyId", "key"],
        "session encryption key",
      );
    } else {
      throw new Error("unsupported session encryption-key schema");
    }
    if (
      typeof value.key !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.key)
    ) throw new Error("invalid session encryption-key bytes");
    const key = Buffer.from(value.key, "hex");
    const derivedId = sessionKeyId(key);
    if (
      value.schemaVersion === 2
      && (
        typeof value.keyId !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.keyId)
        || value.keyId !== derivedId
      )
    ) throw new Error("invalid session encryption-key identity");
    return Object.freeze({ id: derivedId, value: key });
  } catch {
    throw new Error("session encryption key is malformed");
  }
}

function sessionKey(environment: Environment): SessionKey {
  const path = keyPath(environment);
  try {
    return parseSessionKey(
      readRegularFile(path, MAX_KEY_BYTES, "session encryption key").trim(),
    );
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "session encryption key is malformed"
    ) throw error;
    if (encryptedStoreHasState(environment)) {
      throw new Error(
        "session encryption key is unavailable while encrypted session state exists",
      );
    }
  }

  createPrivateJsonIfAbsent(path, newSessionKeyRecord(), {
    environment,
    privateParent: true,
  });
  try {
    return parseSessionKey(
      readRegularFile(path, MAX_KEY_BYTES, "session encryption key").trim(),
    );
  } catch {
    throw new Error("session encryption key is unavailable");
  }
}

function additionalData(
  schemaVersion: 1 | 2,
  keyId: string | null,
  namespace: string,
  authId: string,
  authHash: string,
): Buffer {
  return Buffer.from(
    schemaVersion === 1
      ? `io-session-secret-v1\0${namespace}\0${authId}\0${authHash}`
      : `io-session-secret-v2\0${keyId ?? ""}\0${namespace}\0${authId}\0${authHash}`,
    "utf8",
  );
}

function boundedBase64(value: unknown, label: string, maximumBytes: number): Buffer {
  if (
    typeof value !== "string"
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) throw new Error(`${label} is malformed`);
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength > maximumBytes
    || bytes.toString("base64") !== value
  ) throw new Error(`${label} is malformed`);
  return bytes;
}

function encryptedSessionSecret(
  namespace: string,
  authId: string,
  authHash: string,
  value: unknown,
  environment: Environment = process.env,
): EncryptedSessionSecretV2 {
  validateCoordinate(namespace, authId, authHash);
  const plaintext = Buffer.from(canonicalJson(value), "utf8");
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("session secret exceeded its plaintext byte bound");
  }
  ensurePrivateStateDirectory(directory(environment), environment);
  const iv = randomBytes(12);
  const key = sessionKey(environment);
  assertSessionKeyOwnsEncryptedStore(key, environment);
  const cipher = createCipheriv("aes-256-gcm", key.value, iv);
  cipher.setAAD(additionalData(2, key.id, namespace, authId, authHash));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    schemaVersion: 2,
    encryption: "aes-256-gcm",
    keyId: key.id,
    namespace,
    authId,
    authHash,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  });
}

function encryptedContentSha256(encrypted: EncryptedSessionSecret): string {
  return createHash("sha256")
    .update(`${canonicalJson(encrypted)}\n`, "utf8")
    .digest("hex");
}

export function writeSessionSecret(
  namespace: string,
  authId: string,
  authHash: string,
  value: unknown,
  environment: Environment = process.env,
): void {
  const encrypted = encryptedSessionSecret(
    namespace,
    authId,
    authHash,
    value,
    environment,
  );
  writePrivateJson(secretPath(namespace, authId, environment), encrypted);
}

/**
 * Atomically publish rotating session state only when the encrypted file still
 * matches the snapshot that produced the new value.
 *
 * A null expected hash means the coordinate was absent. This creates the file
 * exclusively, so a concurrent first writer wins without being overwritten.
 */
export function writeSessionSecretIfUnchanged(
  namespace: string,
  authId: string,
  authHash: string,
  value: unknown,
  expectedContentSha256: string | null,
  environment: Environment = process.env,
): SessionSecretWriteResult {
  if (
    expectedContentSha256 !== null
    && !/^[a-f0-9]{64}$/u.test(expectedContentSha256)
  ) throw new Error("expected session-secret content hash is malformed");
  const encrypted = encryptedSessionSecret(
    namespace,
    authId,
    authHash,
    value,
    environment,
  );
  const path = secretPath(namespace, authId, environment);
  const written = expectedContentSha256 === null
    ? createPrivateJsonIfAbsent(path, encrypted, { environment }).created
    : writePrivateJsonIfUnchanged(path, encrypted, {
      expectedCurrentContentSha256: expectedContentSha256,
    });
  return written
    ? Object.freeze({
      written: true,
      contentSha256: encryptedContentSha256(encrypted),
    })
    : Object.freeze({ written: false });
}

function parseEncryptedSessionSecret(
  text: string,
): EncryptedSessionSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("encrypted session secret is malformed");
  }
  const encrypted = record(parsed, "encrypted session secret");
  if (encrypted.schemaVersion === 1) {
    exactKeys(
      encrypted,
      [
        "schemaVersion",
        "encryption",
        "namespace",
        "authId",
        "authHash",
        "iv",
        "ciphertext",
        "tag",
      ],
      "encrypted session secret",
    );
  } else if (encrypted.schemaVersion === 2) {
    exactKeys(
      encrypted,
      [
        "schemaVersion",
        "encryption",
        "keyId",
        "namespace",
        "authId",
        "authHash",
        "iv",
        "ciphertext",
        "tag",
      ],
      "encrypted session secret",
    );
  } else {
    throw new Error("encrypted session secret is malformed");
  }
  if (
    encrypted.encryption !== "aes-256-gcm"
    || typeof encrypted.namespace !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(encrypted.namespace)
    || typeof encrypted.authId !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(encrypted.authId)
    || typeof encrypted.authHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(encrypted.authHash)
    || typeof encrypted.iv !== "string"
    || typeof encrypted.ciphertext !== "string"
    || typeof encrypted.tag !== "string"
    || (
      encrypted.schemaVersion === 2
      && (
        typeof encrypted.keyId !== "string"
        || !/^[a-f0-9]{64}$/u.test(encrypted.keyId)
      )
    )
  ) throw new Error("encrypted session secret is malformed");
  if (encrypted.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      encryption: "aes-256-gcm",
      namespace: encrypted.namespace,
      authId: encrypted.authId,
      authHash: encrypted.authHash,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      tag: encrypted.tag,
    };
  }
  const keyId = encrypted.keyId;
  if (typeof keyId !== "string") {
    throw new Error("encrypted session secret is malformed");
  }
  return {
    schemaVersion: 2,
    encryption: "aes-256-gcm",
    keyId,
    namespace: encrypted.namespace,
    authId: encrypted.authId,
    authHash: encrypted.authHash,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    tag: encrypted.tag,
  };
}

function decryptSessionSecret(
  encrypted: EncryptedSessionSecret,
  key: SessionKey,
): Buffer {
  const iv = boundedBase64(encrypted.iv, "session-secret IV", 12);
  const ciphertext = boundedBase64(
    encrypted.ciphertext,
    "session-secret ciphertext",
    MAX_PLAINTEXT_BYTES + 16,
  );
  const tag = boundedBase64(
    encrypted.tag,
    "session-secret authentication tag",
    16,
  );
  if (iv.byteLength !== 12 || tag.byteLength !== 16) {
    throw new Error("encrypted session secret is malformed");
  }
  if (encrypted.schemaVersion === 2 && encrypted.keyId !== key.id) {
    throw new Error(
      "encrypted session state belongs to a different encryption key",
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.value, iv);
    decipher.setAAD(additionalData(
      encrypted.schemaVersion,
      encrypted.schemaVersion === 2 ? encrypted.keyId : null,
      encrypted.namespace,
      encrypted.authId,
      encrypted.authHash,
    ));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error("decrypted session secret exceeded its byte bound");
    }
    return plaintext;
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "decrypted session secret exceeded its byte bound"
    ) throw error;
    throw new Error("encrypted session secret failed authentication");
  }
}

function parsedPlaintext(plaintext: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    return value;
  } catch {
    throw new Error("decrypted session secret is malformed");
  }
}

function assertSessionKeyOwnsEncryptedStore(
  key: SessionKey,
  environment: Environment,
): void {
  const sessionDirectory = directory(environment);
  const identity = ensurePrivateStateDirectory(sessionDirectory, environment);
  for (const entry of listPrivateStateDirectory(
    sessionDirectory,
    environment,
    identity,
  )) {
    if (entry.kind !== "file") {
      throw new Error("encrypted session store is malformed");
    }
    const text = readPrivateStateFileIfPresent(
      join(sessionDirectory, entry.name),
      MAX_ENCRYPTED_BYTES,
      "encrypted session secret",
      environment,
      [identity],
    );
    if (text === null) {
      throw new Error("encrypted session store changed while validating its key");
    }
    const encrypted = parseEncryptedSessionSecret(text);
    if (entry.name !== `${encrypted.namespace}--${encrypted.authId}.json`) {
      throw new Error("encrypted session store is malformed");
    }
    parsedPlaintext(decryptSessionSecret(encrypted, key));
  }
}

export function readSessionSecretSnapshot(
  namespace: string,
  authId: string,
  authHash: string,
  environment: Environment = process.env,
): SessionSecretSnapshot {
  validateCoordinate(namespace, authId, authHash);
  ensurePrivateStateDirectory(directory(environment), environment);
  const text = readPrivateStateFileIfPresent(
    secretPath(namespace, authId, environment),
    MAX_ENCRYPTED_BYTES,
    "encrypted session secret",
    environment,
  );
  if (text === null) {
    return Object.freeze({ value: null, contentSha256: null });
  }
  const contentSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const encrypted = parseEncryptedSessionSecret(text);
  if (encrypted.namespace !== namespace || encrypted.authId !== authId) {
    throw new Error("encrypted session secret is malformed");
  }
  const value = parsedPlaintext(
    decryptSessionSecret(encrypted, sessionKey(environment)),
  );
  if (encrypted.authHash !== authHash) {
    return Object.freeze({ value: null, contentSha256 });
  }
  return Object.freeze({ value, contentSha256 });
}

export function readSessionSecret(
  namespace: string,
  authId: string,
  authHash: string,
  environment: Environment = process.env,
): unknown {
  return readSessionSecretSnapshot(
    namespace,
    authId,
    authHash,
    environment,
  ).value;
}

export function removeSessionSecret(
  namespace: string,
  authId: string,
  environment: Environment = process.env,
): boolean {
  validateCoordinate(namespace, authId, "0".repeat(64));
  return removePrivateStateFile(secretPath(namespace, authId, environment), environment);
}

/**
 * Remove every plugin-owned rotating secret for one auth realm.
 *
 * Session-secret filenames end in the validated auth ID, so cleanup can stay
 * provider-neutral without parsing or decrypting secret material. Directory
 * identity is held across the bounded listing and each removal.
 */
export function removeSessionSecretsForAuth(
  authId: string,
  environment: Environment = process.env,
): number {
  validateCoordinate("plugin", authId, "0".repeat(64));
  const sessionDirectory = directory(environment);
  const directoryIdentity = ensurePrivateStateDirectory(
    sessionDirectory,
    environment,
  );
  const suffix = `--${authId}.json`;
  let removed = 0;
  for (const entry of listPrivateStateDirectory(
    sessionDirectory,
    environment,
    directoryIdentity,
  )) {
    if (entry.kind !== "file" || !entry.name.endsWith(suffix)) continue;
    const namespace = entry.name.slice(0, -suffix.length);
    if (!/^[a-z][a-z0-9-]{0,47}$/u.test(namespace)) continue;
    if (removePrivateStateFile(
      join(sessionDirectory, entry.name),
      environment,
      directoryIdentity,
    )) {
      removed += 1;
    }
  }
  return removed;
}
