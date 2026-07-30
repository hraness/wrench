import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
  createPrivateJsonIfAbsent,
  readRegularFile,
  wrenchStateHome,
} from "./storage";

const TOKEN_VERSION = "smn1";
const TOKEN_PREFIX = `${TOKEN_VERSION}.`;
const KEY_FILE_NAME = ".cursor-encryption-key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_KEY_FILE_BYTES = 128;
const MAX_TOKEN_CHARACTERS = 8192;
const MAX_ENVELOPE_BYTES = Math.floor(
  ((MAX_TOKEN_CHARACTERS - TOKEN_PREFIX.length) * 3) / 4,
);
const MAX_PLAINTEXT_BYTES = MAX_ENVELOPE_BYTES - IV_BYTES - AUTH_TAG_BYTES;

type Environment = Readonly<Record<string, string | undefined>>;

function invalidToken(message: "authentication failed" | "is malformed"): Error {
  return new Error(`cursor token ${message}`);
}

function validateCoordinates(
  scope: string,
  authId: string,
  authHash: string,
): void {
  if (
    typeof scope !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(scope)
  ) {
    throw new Error("cursor-token scope must be lowercase kebab-case");
  }
  if (
    typeof authId !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(authId)
  ) {
    throw new Error("cursor-token auth ID must be lowercase kebab-case");
  }
  if (
    typeof authHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(authHash)
  ) {
    throw new Error("cursor-token auth hash is malformed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyPath(environment: Environment): string {
  return join(wrenchStateHome(environment), KEY_FILE_NAME);
}

function cursorEncryptionKey(
  environment: Environment,
  createIfMissing: boolean,
): Buffer {
  const path = keyPath(environment);
  if (createIfMissing) {
    createPrivateJsonIfAbsent(path, {
      schemaVersion: 1,
      key: randomBytes(KEY_BYTES).toString("hex"),
    }, {
      environment,
      privateParent: true,
    });
  }
  const text = readRegularFile(path, MAX_KEY_FILE_BYTES, "cursor encryption key");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("cursor encryption key is malformed");
  }
  if (
    !isRecord(parsed)
    || Object.keys(parsed).sort().join(",") !== "key,schemaVersion"
    || parsed.schemaVersion !== 1
    || typeof parsed.key !== "string"
    || !/^[a-f0-9]{64}$/u.test(parsed.key)
  ) {
    throw new Error("cursor encryption key is malformed");
  }
  return Buffer.from(parsed.key, "hex");
}

function additionalData(
  scope: string,
  authId: string,
  authHash: string,
): Buffer {
  return Buffer.from(
    `io-cursor-token\0${TOKEN_VERSION}\0${scope}\0${authId}\0${authHash}`,
    "utf8",
  );
}

function canonicalPayload(payload: unknown): Buffer {
  let encoded: string;
  try {
    encoded = canonicalJson(payload);
  } catch {
    throw new Error("cursor-token payload must be JSON-compatible");
  }
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("cursor-token payload exceeds its size bound");
  }
  return bytes;
}

function decodeEnvelope(token: string): {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
} {
  if (
    typeof token !== "string"
    || token.length > MAX_TOKEN_CHARACTERS
    || !token.startsWith(TOKEN_PREFIX)
  ) {
    throw invalidToken("is malformed");
  }
  const encoded = token.slice(TOKEN_PREFIX.length);
  if (encoded === "" || /[^A-Za-z0-9_-]/u.test(encoded)) {
    throw invalidToken("is malformed");
  }
  let envelope: Buffer;
  try {
    envelope = Buffer.from(encoded, "base64url");
  } catch {
    throw invalidToken("is malformed");
  }
  if (
    envelope.toString("base64url") !== encoded
    || envelope.byteLength <= IV_BYTES + AUTH_TAG_BYTES
    || envelope.byteLength > MAX_ENVELOPE_BYTES
  ) {
    throw invalidToken("is malformed");
  }
  return {
    iv: envelope.subarray(0, IV_BYTES),
    ciphertext: envelope.subarray(IV_BYTES, -AUTH_TAG_BYTES),
    tag: envelope.subarray(-AUTH_TAG_BYTES),
  };
}

export function sealCursorToken(
  scope: string,
  authId: string,
  authHash: string,
  payload: unknown,
  environment: Environment = process.env,
): string {
  validateCoordinates(scope, authId, authHash);
  const plaintext = canonicalPayload(payload);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    cursorEncryptionKey(environment, true),
    iv,
  );
  cipher.setAAD(additionalData(scope, authId, authHash));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
  const token = `${TOKEN_PREFIX}${envelope.toString("base64url")}`;
  if (token.length > MAX_TOKEN_CHARACTERS) {
    throw new Error("cursor-token payload exceeds its size bound");
  }
  return token;
}

export function openCursorToken(
  scope: string,
  authId: string,
  authHash: string,
  token: string,
  environment: Environment = process.env,
): unknown {
  validateCoordinates(scope, authId, authHash);
  const { ciphertext, iv, tag } = decodeEnvelope(token);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cursorEncryptionKey(environment, false),
      iv,
    );
    decipher.setAAD(additionalData(scope, authId, authHash));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw invalidToken("authentication failed");
  }
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw invalidToken("is malformed");
  }
  let text: string;
  let payload: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    payload = JSON.parse(text) as unknown;
  } catch {
    throw invalidToken("is malformed");
  }
  try {
    if (canonicalJson(payload) !== text) throw invalidToken("is malformed");
  } catch {
    throw invalidToken("is malformed");
  }
  return payload;
}
