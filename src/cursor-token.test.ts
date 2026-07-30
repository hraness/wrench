import { afterEach, describe, expect, test } from "bun:test";
import {
  createCipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openCursorToken,
  sealCursorToken,
} from "./cursor-token";

const roots: string[] = [];
const scope = "youtube-comments";
const authId = "youtube-main";
const authHash = "a".repeat(64);

type TestState = {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly root: string;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function state(): TestState {
  const root = mkdtempSync(join(tmpdir(), "wrench-cursor-token-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return {
    root,
    environment: { ...process.env, WRENCH_STATE_HOME: root },
  };
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected action to throw");
}

function mutateEnvelopeByte(token: string, index: number): string {
  const envelope = Buffer.from(token.slice("smn1.".length), "base64url");
  const mutated = Buffer.from(envelope);
  const current = mutated[index];
  if (current === undefined) throw new Error("test mutation index is invalid");
  mutated[index] = current ^ 1;
  return `smn1.${mutated.toString("base64url")}`;
}

function encryptionKey(root: string): Buffer {
  const parsed = JSON.parse(
    readFileSync(join(root, ".cursor-encryption-key"), "utf8"),
  ) as unknown;
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("key" in parsed)
    || typeof parsed.key !== "string"
  ) {
    throw new Error("test cursor key is malformed");
  }
  return Buffer.from(parsed.key, "hex");
}

function forgeToken(
  root: string,
  plaintext: Buffer,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(root), iv);
  cipher.setAAD(Buffer.from(
    `io-cursor-token\0smn1\0${scope}\0${authId}\0${authHash}`,
    "utf8",
  ));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `smn1.${Buffer.concat([
    iv,
    ciphertext,
    cipher.getAuthTag(),
  ]).toString("base64url")}`;
}

describe("authenticated opaque cursor tokens", () => {
  test("round-trips canonical payloads without exposing plaintext and keeps state private", () => {
    const testState = state();
    chmodSync(testState.root, 0o755);
    const privateCursor = "private-provider-cursor-marker";
    const payload = {
      cursor: privateCursor,
      nested: { page: 3, done: false },
      values: [null, "snowman-\u2603"],
    };

    const first = sealCursorToken(
      scope,
      authId,
      authHash,
      payload,
      testState.environment,
    );
    const second = sealCursorToken(
      scope,
      authId,
      authHash,
      payload,
      testState.environment,
    );

    expect(first).toMatch(/^smn1\.[A-Za-z0-9_-]+$/u);
    expect(first.length).toBeLessThanOrEqual(8192);
    expect(first).not.toContain(privateCursor);
    expect(first).not.toEqual(second);
    expect(openCursorToken(
      scope,
      authId,
      authHash,
      first,
      testState.environment,
    )).toEqual(payload);

    const keyPath = join(testState.root, ".cursor-encryption-key");
    expect(readFileSync(keyPath, "utf8")).not.toContain(privateCursor);
    expect(lstatSync(testState.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
  });

  test("rejects IV, ciphertext, and authentication-tag tampering", () => {
    const testState = state();
    const token = sealCursorToken(
      scope,
      authId,
      authHash,
      { cursor: "private-cursor" },
      testState.environment,
    );
    const envelopeBytes = Buffer.from(
      token.slice("smn1.".length),
      "base64url",
    ).byteLength;

    for (const index of [0, 12, envelopeBytes - 1]) {
      const tampered = mutateEnvelopeByte(token, index);
      const error = captureError(() => openCursorToken(
        scope,
        authId,
        authHash,
        tampered,
        testState.environment,
      ));
      expect(error.message).toBe("cursor token authentication failed");
      expect(error.message).not.toContain(tampered);
      expect(error.message).not.toContain("private-cursor");
    }
  });

  test("rejects cross-scope, cross-auth, and encryption-key drift", () => {
    const testState = state();
    const token = sealCursorToken(
      scope,
      authId,
      authHash,
      { cursor: "bound-cursor" },
      testState.environment,
    );

    for (const coordinates of [
      ["youtube-replies", authId, authHash],
      [scope, "youtube-secondary", authHash],
      [scope, authId, "b".repeat(64)],
    ] as const) {
      expect(() => openCursorToken(
        coordinates[0],
        coordinates[1],
        coordinates[2],
        token,
        testState.environment,
      )).toThrow("cursor token authentication failed");
    }

    writeFileSync(
      join(testState.root, ".cursor-encryption-key"),
      `${JSON.stringify({ schemaVersion: 1, key: "0".repeat(64) })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    expect(() => openCursorToken(
      scope,
      authId,
      authHash,
      token,
      testState.environment,
    )).toThrow("cursor token authentication failed");
  });

  test("does not create encryption state while opening an untrusted token", () => {
    const testState = state();
    expect(() => openCursorToken(
      scope,
      authId,
      authHash,
      `smn1.${Buffer.concat([
        randomBytes(12),
        Buffer.from("ciphertext"),
        randomBytes(16),
      ]).toString("base64url")}`,
      testState.environment,
    )).toThrow("cursor token authentication failed");
    expect(existsSync(join(testState.root, ".cursor-encryption-key"))).toBe(false);
  });

  test("enforces the exact token-size ceiling and rejects oversized payloads", () => {
    const testState = state();
    const maximumPayload = "x".repeat(6110);
    const token = sealCursorToken(
      scope,
      authId,
      authHash,
      maximumPayload,
      testState.environment,
    );
    expect(token).toHaveLength(8192);
    expect(openCursorToken(
      scope,
      authId,
      authHash,
      token,
      testState.environment,
    )).toBe(maximumPayload);

    const oversizedPayload = "private-oversized-marker".padEnd(6111, "x");
    const sealError = captureError(() => sealCursorToken(
      scope,
      authId,
      authHash,
      oversizedPayload,
      testState.environment,
    ));
    expect(sealError.message).toBe(
      "cursor-token payload exceeds its size bound",
    );
    expect(sealError.message).not.toContain("private-oversized-marker");

    const oversizedToken = `smn1.${"A".repeat(8188)}`;
    const openError = captureError(() => openCursorToken(
      scope,
      authId,
      authHash,
      oversizedToken,
      testState.environment,
    ));
    expect(openError.message).toBe("cursor token is malformed");
    expect(openError.message).not.toContain(oversizedToken);
  });

  test("rejects malformed and noncanonical base64url without echoing input", () => {
    const testState = state();
    const malformed = [
      "",
      "smn1.",
      "smn2.AA",
      "smn1.A",
      "smn1.AA==",
      "smn1.AA+",
      "smn1.AA/",
      "smn1.AA\n",
      "smn1.AA.AA",
      "SMN1.AA",
      " smn1.AA",
    ];
    for (const token of malformed) {
      const error = captureError(() => openCursorToken(
        scope,
        authId,
        authHash,
        token,
        testState.environment,
      ));
      expect(error.message).toBe("cursor token is malformed");
      if (token !== "") expect(error.message).not.toContain(token);
    }
  });

  test("uses fatal UTF-8 and accepts only canonical JSON after authentication", () => {
    const testState = state();
    sealCursorToken(
      scope,
      authId,
      authHash,
      null,
      testState.environment,
    );
    const invalidUtf8 = forgeToken(testState.root, Buffer.from([0xff]));
    const noncanonicalJson = forgeToken(
      testState.root,
      Buffer.from('{ "cursor": "private-noncanonical" }', "utf8"),
    );

    for (const token of [invalidUtf8, noncanonicalJson]) {
      const error = captureError(() => openCursorToken(
        scope,
        authId,
        authHash,
        token,
        testState.environment,
      ));
      expect(error.message).toBe("cursor token is malformed");
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain("private-noncanonical");
    }
  });

  test("validates coordinates and sanitizes payload-conversion failures", () => {
    const testState = state();
    expect(() => sealCursorToken(
      "YouTube",
      authId,
      authHash,
      null,
      testState.environment,
    )).toThrow("scope must be lowercase kebab-case");
    expect(() => sealCursorToken(
      scope,
      "youtube_main",
      authHash,
      null,
      testState.environment,
    )).toThrow("auth ID must be lowercase kebab-case");
    expect(() => sealCursorToken(
      scope,
      authId,
      "A".repeat(64),
      null,
      testState.environment,
    )).toThrow("auth hash is malformed");

    const privateDiagnostic = "private-payload-conversion-diagnostic";
    const hostilePayload = Object.defineProperty({}, "cursor", {
      enumerable: true,
      get: () => {
        throw new Error(privateDiagnostic);
      },
    });
    const error = captureError(() => sealCursorToken(
      scope,
      authId,
      authHash,
      hostilePayload,
      testState.environment,
    ));
    expect(error.message).toBe(
      "cursor-token payload must be JSON-compatible",
    );
    expect(error.message).not.toContain(privateDiagnostic);
  });
});
