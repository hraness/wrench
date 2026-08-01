import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
  projectionAuthIdentityHash,
  withReadProjectionAuthAdmission,
} from "./read-projection-admission";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  listPrivateStateDirectory,
  readPrivateStateFileIfPresent,
  readRegularFile,
  removePrivateStateFile,
  removePrivateStateFileIfUnchanged,
  wrenchStateHome,
  writePrivateJson,
  writePrivateJsonIfUnchanged,
} from "./storage";

const SESSION_SECRET_DIRECTORY = "session-secrets";
const SESSION_SECRET_COORDINATE_DIRECTORY = "coordinates";
const SESSION_SECRET_KEY = ".session-encryption-key";
const MAX_KEY_BYTES = 512;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_ENCRYPTED_BYTES = 128 * 1024;
const MAX_COORDINATE_BYTES = 4 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

type SessionKey = {
  readonly id: string;
  readonly value: Buffer;
};

type SessionSecretCoordinateState = {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly authId: string;
  readonly authIdentityHash: string;
  readonly generation: string;
};

type SessionSecretCoordinateSnapshot = {
  readonly value: SessionSecretCoordinateState;
  readonly contentSha256: string;
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

type EncryptedSessionSecretV3 = {
  readonly schemaVersion: 3;
  readonly encryption: "aes-256-gcm";
  readonly keyId: string;
  readonly namespace: string;
  readonly authId: string;
  readonly authIdentityHash: string;
  readonly generation: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type EncryptedSessionSecret =
  | EncryptedSessionSecretV1
  | EncryptedSessionSecretV2
  | EncryptedSessionSecretV3;

export type SessionSecretSnapshot = {
  readonly value: unknown;
  /**
   * An opaque compare-and-swap revision. Present files use the SHA-256 of the
   * exact encrypted bytes; absent files use an auth-incarnation- and
   * coordinate-generation-bound digest.
   * Injected stores may still use null for an unversioned absent coordinate.
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

function coordinateDirectory(environment: Environment): string {
  return join(directory(environment), SESSION_SECRET_COORDINATE_DIRECTORY);
}

function coordinatePath(
  namespace: string,
  authId: string,
  environment: Environment,
): string {
  return join(
    coordinateDirectory(environment),
    `${namespace}--${authId}.json`,
  );
}

function coordinateSnapshot(
  value: SessionSecretCoordinateState,
): SessionSecretCoordinateSnapshot {
  return Object.freeze({
    value,
    contentSha256: createHash("sha256")
      .update(`${canonicalJson(value)}\n`, "utf8")
      .digest("hex"),
  });
}

function parseCoordinateState(
  text: string,
  namespace: string,
  authId: string,
): SessionSecretCoordinateSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("session-secret coordinate state is malformed JSON");
  }
  const value = record(parsed, "session-secret coordinate state");
  exactKeys(
    value,
    [
      "schemaVersion",
      "namespace",
      "authId",
      "authIdentityHash",
      "generation",
    ],
    "session-secret coordinate state",
  );
  if (
    value.schemaVersion !== 1
    || value.namespace !== namespace
    || value.authId !== authId
    || typeof value.authIdentityHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.authIdentityHash)
    || typeof value.generation !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.generation)
  ) throw new Error("session-secret coordinate state is malformed");
  const normalized: SessionSecretCoordinateState = Object.freeze({
    schemaVersion: 1,
    namespace,
    authId,
    authIdentityHash: value.authIdentityHash,
    generation: value.generation,
  });
  if (text !== `${canonicalJson(normalized)}\n`) {
    throw new Error("session-secret coordinate state is not canonical JSON");
  }
  return coordinateSnapshot(normalized);
}

function readCoordinateState(
  namespace: string,
  authId: string,
  environment: Environment,
): SessionSecretCoordinateSnapshot | null {
  ensurePrivateStateDirectory(coordinateDirectory(environment), environment);
  const text = readPrivateStateFileIfPresent(
    coordinatePath(namespace, authId, environment),
    MAX_COORDINATE_BYTES,
    "session-secret coordinate state",
    environment,
  );
  return text === null
    ? null
    : parseCoordinateState(text, namespace, authId);
}

function newCoordinateState(
  namespace: string,
  authId: string,
  authIdentityHash: string,
  previousGeneration: string | null = null,
): SessionSecretCoordinateState {
  let generation: string;
  do {
    generation = randomBytes(32).toString("hex");
  } while (generation === previousGeneration);
  return Object.freeze({
    schemaVersion: 1,
    namespace,
    authId,
    authIdentityHash,
    generation,
  });
}

function replaceCoordinateState(
  current: SessionSecretCoordinateSnapshot | null,
  namespace: string,
  authId: string,
  authIdentityHash: string,
  environment: Environment,
): SessionSecretCoordinateSnapshot {
  const replacement = newCoordinateState(
    namespace,
    authId,
    authIdentityHash,
    current?.value.generation ?? null,
  );
  const path = coordinatePath(namespace, authId, environment);
  const written = current === null
    ? createPrivateJsonIfAbsent(path, replacement, { environment }).created
    : writePrivateJsonIfUnchanged(path, replacement, {
      expectedCurrentContentSha256: current.contentSha256,
    });
  if (!written) {
    throw new Error("session-secret coordinate generation changed concurrently");
  }
  return coordinateSnapshot(replacement);
}

function ensureCoordinateState(
  namespace: string,
  authId: string,
  authIdentityHash: string,
  environment: Environment,
): SessionSecretCoordinateSnapshot {
  const current = readCoordinateState(namespace, authId, environment);
  if (current !== null) return current;
  return replaceCoordinateState(
    null,
    namespace,
    authId,
    authIdentityHash,
    environment,
  );
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
  ).some((entry) =>
    entry.name !== SESSION_SECRET_COORDINATE_DIRECTORY
    || entry.kind !== "directory");
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
  schemaVersion: 1 | 2 | 3,
  keyId: string | null,
  namespace: string,
  authId: string,
  authIdentityHash: string,
  generation: string | null,
): Buffer {
  return Buffer.from(
    schemaVersion === 1
      ? `io-session-secret-v1\0${namespace}\0${authId}\0${authIdentityHash}`
      : schemaVersion === 2
        ? `io-session-secret-v2\0${keyId ?? ""}\0${namespace}\0${authId}\0${authIdentityHash}`
        : `io-session-secret-v3\0${keyId ?? ""}\0${namespace}\0${authId}\0${authIdentityHash}\0${generation ?? ""}`,
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
  authIdentityHash: string,
  generation: string,
  value: unknown,
  environment: Environment = process.env,
): EncryptedSessionSecretV3 {
  validateCoordinate(namespace, authId, authIdentityHash);
  if (!/^[a-f0-9]{64}$/u.test(generation)) {
    throw new Error("session-secret coordinate generation is malformed");
  }
  const plaintext = Buffer.from(canonicalJson(value), "utf8");
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("session secret exceeded its plaintext byte bound");
  }
  ensurePrivateStateDirectory(directory(environment), environment);
  const iv = randomBytes(12);
  const key = sessionKey(environment);
  assertSessionKeyOwnsEncryptedStore(key, environment);
  const cipher = createCipheriv("aes-256-gcm", key.value, iv);
  cipher.setAAD(additionalData(
    3,
    key.id,
    namespace,
    authId,
    authIdentityHash,
    generation,
  ));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    schemaVersion: 3,
    encryption: "aes-256-gcm",
    keyId: key.id,
    namespace,
    authId,
    authIdentityHash,
    generation,
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

function absentContentSha256(
  namespace: string,
  authId: string,
  authIdentityHash: string,
  generation: string,
): string {
  return createHash("sha256")
    .update(
      `io-session-secret-absent-revision-v2\0${namespace}\0${authId}\0${authIdentityHash}\0${generation}`,
      "utf8",
    )
    .digest("hex");
}

export function writeSessionSecret(
  namespace: string,
  authId: string,
  authHash: string,
  value: unknown,
  environment: Environment = process.env,
): void {
  validateCoordinate(namespace, authId, authHash);
  withReadProjectionAuthAdmission(authId, environment, () => {
    const authIdentityHash = projectionAuthIdentityHash(
      authId,
      authHash,
      environment,
    );
    const coordinate = replaceCoordinateState(
      readCoordinateState(namespace, authId, environment),
      namespace,
      authId,
      authIdentityHash,
      environment,
    );
    const encrypted = encryptedSessionSecret(
      namespace,
      authId,
      authIdentityHash,
      coordinate.value.generation,
      value,
      environment,
    );
    writePrivateJson(secretPath(namespace, authId, environment), encrypted);
  });
}

/**
 * Atomically publish rotating session state only when the encrypted file still
 * matches the snapshot that produced the new value.
 *
 * Default store snapshots return a durable generation-bound absent revision,
 * so a writer that started before auth rotation or a create/delete cycle
 * cannot create state afterward. Null is never accepted by the durable store.
 */
export function writeSessionSecretIfUnchanged(
  namespace: string,
  authId: string,
  authHash: string,
  value: unknown,
  expectedContentSha256: string | null,
  environment: Environment = process.env,
): SessionSecretWriteResult {
  validateCoordinate(namespace, authId, authHash);
  if (
    expectedContentSha256 !== null
    && !/^[a-f0-9]{64}$/u.test(expectedContentSha256)
  ) throw new Error("expected session-secret content hash is malformed");
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const authIdentityHash = projectionAuthIdentityHash(
      authId,
      authHash,
      environment,
    );
    if (expectedContentSha256 === null) {
      return Object.freeze({ written: false });
    }
    const coordinate = ensureCoordinateState(
      namespace,
      authId,
      authIdentityHash,
      environment,
    );
    let publicationCoordinate = coordinate;
    const path = secretPath(namespace, authId, environment);
    const currentText = readPrivateStateFileIfPresent(
      path,
      MAX_ENCRYPTED_BYTES,
      "encrypted session secret",
      environment,
    );
    if (currentText === null) {
      if (coordinate.value.authIdentityHash !== authIdentityHash) {
        publicationCoordinate = replaceCoordinateState(
          coordinate,
          namespace,
          authId,
          authIdentityHash,
          environment,
        );
      }
      if (
        expectedContentSha256 !== absentContentSha256(
          namespace,
          authId,
          authIdentityHash,
          publicationCoordinate.value.generation,
        )
      ) return Object.freeze({ written: false });
      publicationCoordinate = replaceCoordinateState(
        publicationCoordinate,
        namespace,
        authId,
        authIdentityHash,
        environment,
      );
    } else {
      const currentContentSha256 = createHash("sha256")
        .update(currentText, "utf8")
        .digest("hex");
      if (currentContentSha256 !== expectedContentSha256) {
        return Object.freeze({ written: false });
      }
      const current = parseEncryptedSessionSecret(currentText);
      if (
        current.namespace !== namespace
        || current.authId !== authId
      ) throw new Error("encrypted session secret is malformed");
      parsedPlaintext(decryptSessionSecret(current, sessionKey(environment)));
      if (
        encryptedCoordinateGeneration(current)
          !== coordinate.value.generation
      ) {
        reclaimStaleEncryptedCoordinate(
          coordinate,
          namespace,
          authId,
          currentContentSha256,
          environment,
        );
        return Object.freeze({ written: false });
      }
      if (coordinate.value.authIdentityHash !== authIdentityHash) {
        return Object.freeze({ written: false });
      }
      if (
        encryptedAuthIdentityHash(current) !== authIdentityHash
      ) {
        reclaimStaleEncryptedCoordinate(
          coordinate,
          namespace,
          authId,
          currentContentSha256,
          environment,
        );
        return Object.freeze({ written: false });
      }
    }
    const encrypted = encryptedSessionSecret(
      namespace,
      authId,
      authIdentityHash,
      publicationCoordinate.value.generation,
      value,
      environment,
    );
    let written: boolean;
    if (currentText === null) {
      written = createPrivateJsonIfAbsent(
        path,
        encrypted,
        { environment },
      ).created;
    } else {
      written = writePrivateJsonIfUnchanged(path, encrypted, {
        expectedCurrentContentSha256: expectedContentSha256,
      });
    }
    return written
      ? Object.freeze({
        written: true,
        contentSha256: encryptedContentSha256(encrypted),
      })
      : Object.freeze({ written: false });
  });
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
  } else if (encrypted.schemaVersion === 3) {
    exactKeys(
      encrypted,
      [
        "schemaVersion",
        "encryption",
        "keyId",
        "namespace",
        "authId",
        "authIdentityHash",
        "generation",
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
    || typeof encrypted.iv !== "string"
    || typeof encrypted.ciphertext !== "string"
    || typeof encrypted.tag !== "string"
    || (
      (encrypted.schemaVersion === 2 || encrypted.schemaVersion === 3)
      && (
        typeof encrypted.keyId !== "string"
        || !/^[a-f0-9]{64}$/u.test(encrypted.keyId)
      )
    )
  ) throw new Error("encrypted session secret is malformed");
  if (
    encrypted.schemaVersion === 3
    && (
      typeof encrypted.authIdentityHash !== "string"
      || !/^[a-f0-9]{64}$/u.test(encrypted.authIdentityHash)
      || typeof encrypted.generation !== "string"
      || !/^[a-f0-9]{64}$/u.test(encrypted.generation)
    )
  ) throw new Error("encrypted session secret is malformed");
  if (
    (encrypted.schemaVersion === 1 || encrypted.schemaVersion === 2)
    && (
      typeof encrypted.authHash !== "string"
      || !/^[a-f0-9]{64}$/u.test(encrypted.authHash)
    )
  ) throw new Error("encrypted session secret is malformed");
  if (encrypted.schemaVersion === 1) {
    const authHash = encrypted.authHash;
    if (typeof authHash !== "string") {
      throw new Error("encrypted session secret is malformed");
    }
    return {
      schemaVersion: 1,
      encryption: "aes-256-gcm",
      namespace: encrypted.namespace,
      authId: encrypted.authId,
      authHash,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      tag: encrypted.tag,
    };
  }
  const keyId = encrypted.keyId;
  if (typeof keyId !== "string") {
    throw new Error("encrypted session secret is malformed");
  }
  if (encrypted.schemaVersion === 2) {
    const authHash = encrypted.authHash;
    if (typeof authHash !== "string") {
      throw new Error("encrypted session secret is malformed");
    }
    return {
      schemaVersion: 2,
      encryption: "aes-256-gcm",
      keyId,
      namespace: encrypted.namespace,
      authId: encrypted.authId,
      authHash,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      tag: encrypted.tag,
    };
  }
  const authIdentityHash = encrypted.authIdentityHash;
  const generation = encrypted.generation;
  if (
    typeof authIdentityHash !== "string"
    || typeof generation !== "string"
  ) {
    throw new Error("encrypted session secret is malformed");
  }
  return {
    schemaVersion: 3,
    encryption: "aes-256-gcm",
    keyId,
    namespace: encrypted.namespace,
    authId: encrypted.authId,
    authIdentityHash,
    generation,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    tag: encrypted.tag,
  };
}

function encryptedAuthIdentityHash(encrypted: EncryptedSessionSecret): string {
  return encrypted.schemaVersion === 3
    ? encrypted.authIdentityHash
    : encrypted.authHash;
}

function encryptedCoordinateGeneration(
  encrypted: EncryptedSessionSecret,
): string | null {
  return encrypted.schemaVersion === 3 ? encrypted.generation : null;
}

function reclaimStaleEncryptedCoordinate(
  coordinate: SessionSecretCoordinateSnapshot,
  namespace: string,
  authId: string,
  expectedContentSha256: string,
  environment: Environment,
): SessionSecretCoordinateSnapshot {
  const advanced = replaceCoordinateState(
    coordinate,
    namespace,
    authId,
    coordinate.value.authIdentityHash,
    environment,
  );
  if (!removePrivateStateFileIfUnchanged(
    secretPath(namespace, authId, environment),
    { expectedCurrentContentSha256: expectedContentSha256 },
    environment,
  )) {
    throw new Error(
      "stale encrypted session secret changed during generation recovery",
    );
  }
  return advanced;
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
  if (encrypted.schemaVersion !== 1 && encrypted.keyId !== key.id) {
    throw new Error(
      "encrypted session state belongs to a different encryption key",
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.value, iv);
    decipher.setAAD(additionalData(
      encrypted.schemaVersion,
      encrypted.schemaVersion === 1 ? null : encrypted.keyId,
      encrypted.namespace,
      encrypted.authId,
      encryptedAuthIdentityHash(encrypted),
      encrypted.schemaVersion === 3 ? encrypted.generation : null,
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
    if (
      entry.name === SESSION_SECRET_COORDINATE_DIRECTORY
      && entry.kind === "directory"
    ) continue;
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
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const authIdentityHash = projectionAuthIdentityHash(
      authId,
      authHash,
      environment,
    );
    let coordinate = ensureCoordinateState(
      namespace,
      authId,
      authIdentityHash,
      environment,
    );
    ensurePrivateStateDirectory(directory(environment), environment);
    const text = readPrivateStateFileIfPresent(
      secretPath(namespace, authId, environment),
      MAX_ENCRYPTED_BYTES,
      "encrypted session secret",
      environment,
    );
    if (text === null) {
      if (coordinate.value.authIdentityHash !== authIdentityHash) {
        coordinate = replaceCoordinateState(
          coordinate,
          namespace,
          authId,
          authIdentityHash,
          environment,
        );
      }
      return Object.freeze({
        value: null,
        contentSha256: absentContentSha256(
          namespace,
          authId,
          authIdentityHash,
          coordinate.value.generation,
        ),
      });
    }
    const contentSha256 = createHash("sha256")
      .update(text, "utf8")
      .digest("hex");
    const encrypted = parseEncryptedSessionSecret(text);
    if (encrypted.namespace !== namespace || encrypted.authId !== authId) {
      throw new Error("encrypted session secret is malformed");
    }
    const value = parsedPlaintext(
      decryptSessionSecret(encrypted, sessionKey(environment)),
    );
    if (
      encryptedCoordinateGeneration(encrypted)
        !== coordinate.value.generation
      || (
        coordinate.value.authIdentityHash === authIdentityHash
        && encryptedAuthIdentityHash(encrypted) !== authIdentityHash
      )
    ) {
      const recovered = reclaimStaleEncryptedCoordinate(
        coordinate,
        namespace,
        authId,
        contentSha256,
        environment,
      );
      return Object.freeze({
        value: null,
        contentSha256: absentContentSha256(
          namespace,
          authId,
          recovered.value.authIdentityHash,
          recovered.value.generation,
        ),
      });
    }
    if (coordinate.value.authIdentityHash !== authIdentityHash) {
      return Object.freeze({ value: null, contentSha256 });
    }
    return Object.freeze({ value, contentSha256 });
  });
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
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const coordinate = readCoordinateState(namespace, authId, environment);
    if (coordinate !== null) {
      replaceCoordinateState(
        coordinate,
        namespace,
        authId,
        coordinate.value.authIdentityHash,
        environment,
      );
    }
    return removePrivateStateFile(
      secretPath(namespace, authId, environment),
      environment,
    );
  });
}

function coordinateStatesForAuth(
  authId: string,
  environment: Environment,
): readonly SessionSecretCoordinateSnapshot[] {
  const sessionIdentity = ensurePrivateStateDirectory(
    directory(environment),
    environment,
  );
  const controlDirectory = coordinateDirectory(environment);
  const controlIdentity = ensurePrivateStateDirectory(
    controlDirectory,
    environment,
  );
  const suffix = `--${authId}.json`;
  const snapshots: SessionSecretCoordinateSnapshot[] = [];
  for (const entry of listPrivateStateDirectory(
    controlDirectory,
    environment,
    controlIdentity,
  )) {
    if (!entry.name.endsWith(suffix)) continue;
    const namespace = entry.name.slice(0, -suffix.length);
    if (
      entry.kind !== "file"
      || !/^[a-z][a-z0-9-]{0,47}$/u.test(namespace)
    ) throw new Error("session-secret coordinate store is malformed");
    const text = readPrivateStateFileIfPresent(
      join(controlDirectory, entry.name),
      MAX_COORDINATE_BYTES,
      "session-secret coordinate state",
      environment,
      [sessionIdentity, controlIdentity],
    );
    if (text === null) {
      throw new Error(
        "session-secret coordinate store changed during auth cleanup",
      );
    }
    snapshots.push(parseCoordinateState(text, namespace, authId));
  }
  return Object.freeze(snapshots);
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
  return withReadProjectionAuthAdmission(authId, environment, () => {
    for (const coordinate of coordinateStatesForAuth(authId, environment)) {
      replaceCoordinateState(
        coordinate,
        coordinate.value.namespace,
        authId,
        coordinate.value.authIdentityHash,
        environment,
      );
    }
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
  });
}
