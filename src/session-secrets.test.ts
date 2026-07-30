import { afterEach, describe, expect, test } from "bun:test";
import {
  createCipheriv,
  createHash,
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

import { canonicalJson } from "./model";
import {
  readSessionSecret,
  readSessionSecretSnapshot,
  removeSessionSecret,
  removeSessionSecretsForAuth,
  writeSessionSecret,
  writeSessionSecretIfUnchanged,
} from "./session-secrets";

const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function environment(): {
  readonly root: string;
  readonly value: Readonly<Record<string, string | undefined>>;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-session-secret-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return {
    root,
    value: { ...process.env, WRENCH_STATE_HOME: root },
  };
}

function jsonRecord(text: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for test worker file: ${path}`);
    }
    await Bun.sleep(10);
  }
}

describe("encrypted provider-session cache", () => {
  test("round-trips private material without plaintext, broad modes, or auth-realm drift", () => {
    const state = environment();
    const authHash = "a".repeat(64);
    const secret = {
      accessJwt: "access-secret-that-must-not-be-plaintext",
      refreshJwt: "refresh-secret-that-must-not-be-plaintext",
    };
    writeSessionSecret("bluesky", "bluesky-main", authHash, secret, state.value);
    const path = join(
      state.root,
      "session-secrets",
      "bluesky--bluesky-main.json",
    );
    const raw = readFileSync(path, "utf8");
    const encrypted = jsonRecord(raw, "encrypted session secret");
    expect(raw).not.toContain(secret.accessJwt);
    expect(raw).not.toContain(secret.refreshJwt);
    expect(encrypted.schemaVersion).toBe(2);
    expect(encrypted.keyId).toMatch(/^[a-f0-9]{64}$/u);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(state.root, "session-secrets")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(state.root, ".session-encryption-key")).mode & 0o777)
      .toBe(0o600);
    const snapshot = readSessionSecretSnapshot(
      "bluesky",
      "bluesky-main",
      authHash,
      state.value,
    );
    expect(snapshot).toEqual({
      value: secret,
      contentSha256: sha256(raw),
    });
    const paddedRaw = ` \n\t${raw}`;
    writeFileSync(path, paddedRaw, { mode: 0o600 });
    const byteExactSnapshot = readSessionSecretSnapshot(
      "bluesky",
      "bluesky-main",
      authHash,
      state.value,
    );
    expect(byteExactSnapshot).toEqual({
      value: secret,
      contentSha256: sha256(paddedRaw),
    });
    expect(byteExactSnapshot.contentSha256).not.toBe(snapshot.contentSha256);
    expect(readSessionSecret("bluesky", "bluesky-main", authHash, state.value))
      .toEqual(secret);
    expect(readSessionSecret(
      "bluesky",
      "bluesky-main",
      "b".repeat(64),
      state.value,
    )).toBeNull();
    expect(removeSessionSecret("bluesky", "bluesky-main", state.value)).toBeTrue();
    expect(readSessionSecret("bluesky", "bluesky-main", authHash, state.value))
      .toBeNull();
  });

  test("rejects authenticated-ciphertext tampering", () => {
    const state = environment();
    const authHash = "c".repeat(64);
    writeSessionSecret(
      "bluesky",
      "bluesky-main",
      authHash,
      { refreshJwt: "private-refresh-token" },
      state.value,
    );
    const path = join(
      state.root,
      "session-secrets",
      "bluesky--bluesky-main.json",
    );
    const encrypted = jsonRecord(
      readFileSync(path, "utf8"),
      "encrypted session secret",
    );
    if (typeof encrypted.ciphertext !== "string") {
      throw new Error("encrypted session-secret fixture omitted ciphertext");
    }
    encrypted.ciphertext = `${
      encrypted.ciphertext.startsWith("A") ? "B" : "A"
    }${encrypted.ciphertext.slice(1)}`;
    writeFileSync(path, `${JSON.stringify(encrypted)}\n`, { mode: 0o600 });
    expect(() =>
      readSessionSecret("bluesky", "bluesky-main", authHash, state.value)
    ).toThrow("failed authentication");
  });

  test("removes every plugin namespace for one auth realm without touching another", () => {
    const state = environment();
    const authHash = "d".repeat(64);
    writeSessionSecret("bluesky", "shared-main", authHash, { value: "one" }, state.value);
    writeSessionSecret("future-plugin", "shared-main", authHash, { value: "two" }, state.value);
    writeSessionSecret("future-plugin", "other-main", authHash, { value: "three" }, state.value);

    expect(removeSessionSecretsForAuth("shared-main", state.value)).toBe(2);
    expect(readSessionSecret("bluesky", "shared-main", authHash, state.value)).toBeNull();
    expect(readSessionSecret("future-plugin", "shared-main", authHash, state.value)).toBeNull();
    expect(readSessionSecret("future-plugin", "other-main", authHash, state.value))
      .toEqual({ value: "three" });
    expect(removeSessionSecretsForAuth("shared-main", state.value)).toBe(0);
  });

  test("does not create a replacement key beside ciphertext when the key is missing", () => {
    const state = environment();
    const authHash = "e".repeat(64);
    writeSessionSecret(
      "bluesky",
      "bluesky-main",
      authHash,
      { refreshJwt: "private-refresh-token" },
      state.value,
    );
    const key = join(state.root, ".session-encryption-key");
    const ciphertext = join(
      state.root,
      "session-secrets",
      "bluesky--bluesky-main.json",
    );
    const encryptedBefore = readFileSync(ciphertext, "utf8");
    rmSync(key);

    expect(() =>
      readSessionSecret("bluesky", "bluesky-main", authHash, state.value)
    ).toThrow(
      "session encryption key is unavailable while encrypted session state exists",
    );
    expect(() =>
      writeSessionSecret(
        "bluesky",
        "bluesky-main",
        authHash,
        { refreshJwt: "replacement-must-not-be-written" },
        state.value,
      )
    ).toThrow(
      "session encryption key is unavailable while encrypted session state exists",
    );
    expect(existsSync(key)).toBeFalse();
    expect(readFileSync(ciphertext, "utf8")).toBe(encryptedBefore);
  });

  test("does not replace a malformed key or overwrite its ciphertext", () => {
    const state = environment();
    const authHash = "f".repeat(64);
    writeSessionSecret(
      "bluesky",
      "bluesky-main",
      authHash,
      { refreshJwt: "private-refresh-token" },
      state.value,
    );
    const key = join(state.root, ".session-encryption-key");
    const ciphertext = join(
      state.root,
      "session-secrets",
      "bluesky--bluesky-main.json",
    );
    const encryptedBefore = readFileSync(ciphertext, "utf8");
    writeFileSync(key, '{"schemaVersion":2,"key":"not-a-key"}\n', {
      mode: 0o600,
    });
    const malformedKey = readFileSync(key, "utf8");

    expect(() =>
      readSessionSecret("bluesky", "bluesky-main", authHash, state.value)
    ).toThrow("session encryption key is malformed");
    expect(() =>
      writeSessionSecret(
        "bluesky",
        "bluesky-main",
        authHash,
        { refreshJwt: "replacement-must-not-be-written" },
        state.value,
      )
    ).toThrow("session encryption key is malformed");
    expect(readFileSync(key, "utf8")).toBe(malformedKey);
    expect(readFileSync(ciphertext, "utf8")).toBe(encryptedBefore);
  });

  test("detects a valid but replaced key before reading or overwriting ciphertext", () => {
    const state = environment();
    const authHash = "1".repeat(64);
    writeSessionSecret(
      "bluesky",
      "bluesky-main",
      authHash,
      { refreshJwt: "private-refresh-token" },
      state.value,
    );
    const keyPath = join(state.root, ".session-encryption-key");
    const ciphertextPath = join(
      state.root,
      "session-secrets",
      "bluesky--bluesky-main.json",
    );
    const encryptedBefore = readFileSync(ciphertextPath, "utf8");
    const replacementKey = randomBytes(32);
    const replacementKeyId = createHash("sha256")
      .update("io-session-key-id-v1\0", "utf8")
      .update(replacementKey)
      .digest("hex");
    writeFileSync(
      keyPath,
      `${canonicalJson({
        schemaVersion: 2,
        keyId: replacementKeyId,
        key: replacementKey.toString("hex"),
      })}\n`,
      { mode: 0o600 },
    );

    expect(() =>
      readSessionSecret("bluesky", "bluesky-main", authHash, state.value)
    ).toThrow("belongs to a different encryption key");
    expect(() =>
      writeSessionSecret(
        "bluesky",
        "bluesky-main",
        authHash,
        { refreshJwt: "replacement-must-not-be-written" },
        state.value,
      )
    ).toThrow("belongs to a different encryption key");
    expect(readFileSync(ciphertextPath, "utf8")).toBe(encryptedBefore);
  });

  test("uses compare-and-swap revisions so a stale writer cannot roll state backward", () => {
    const state = environment();
    const authHash = "2".repeat(64);
    writeSessionSecret(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 1, tombstones: [] },
      state.value,
    );
    const slower = readSessionSecretSnapshot(
      "linkedin",
      "linkedin-main",
      authHash,
      state.value,
    );
    const faster = readSessionSecretSnapshot(
      "linkedin",
      "linkedin-main",
      authHash,
      state.value,
    );
    expect(slower.contentSha256).toBe(faster.contentSha256);

    const accepted = writeSessionSecretIfUnchanged(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 2, tombstones: ["li_at"] },
      faster.contentSha256,
      state.value,
    );
    expect(accepted.written).toBeTrue();
    if (!accepted.written) throw new Error("fixture CAS unexpectedly failed");
    expect(accepted.contentSha256).toMatch(/^[a-f0-9]{64}$/u);

    const stale = writeSessionSecretIfUnchanged(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 1, cookies: ["li_at"] },
      slower.contentSha256,
      state.value,
    );
    expect(stale).toEqual({ written: false });
    expect(readSessionSecret(
      "linkedin",
      "linkedin-main",
      authHash,
      state.value,
    )).toEqual({ generation: 2, tombstones: ["li_at"] });

    const next = writeSessionSecretIfUnchanged(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 3, tombstones: ["li_at"] },
      accepted.contentSha256,
      state.value,
    );
    expect(next.written).toBeTrue();
  });

  test("serializes the same stale revision across separate processes", async () => {
    const state = environment();
    const authHash = "5".repeat(64);
    writeSessionSecret(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 1, tombstones: [] },
      state.value,
    );
    const workerModule = new URL("./session-secrets.ts", import.meta.url).href;
    const workerSource = `
      import { existsSync, writeFileSync } from "node:fs";
      const {
        readSessionSecretSnapshot,
        writeSessionSecretIfUnchanged,
      } = await import(${JSON.stringify(workerModule)});
      const required = (name) => {
        const value = process.env[name];
        if (value === undefined) throw new Error("missing worker setting");
        return value;
      };
      const environment = { ...process.env, WRENCH_STATE_HOME: required("WRENCH_TEST_HOME") };
      const snapshot = readSessionSecretSnapshot(
        "linkedin",
        "linkedin-main",
        ${JSON.stringify(authHash)},
        environment,
      );
      writeFileSync(required("WRENCH_TEST_READY"), "ready\\n");
      while (!existsSync(required("WRENCH_TEST_GATE"))) await Bun.sleep(5);
      const result = writeSessionSecretIfUnchanged(
        "linkedin",
        "linkedin-main",
        ${JSON.stringify(authHash)},
        {
          generation: Number(required("WRENCH_TEST_GENERATION")),
          tombstones: [required("WRENCH_TEST_TOMBSTONE")],
        },
        snapshot.contentSha256,
        environment,
      );
      writeFileSync(
        required("WRENCH_TEST_RESULT"),
        JSON.stringify(result) + "\\n",
      );
    `;
    const worker = (
      name: string,
      generation: number,
      tombstone: string,
    ) => {
      const ready = join(state.root, `${name}.ready`);
      const gate = join(state.root, `${name}.gate`);
      const result = join(state.root, `${name}.result`);
      return {
        ready,
        gate,
        result,
        child: Bun.spawn(
          [process.execPath, "--no-env-file", "--eval", workerSource],
          {
            env: {
              ...process.env,
              WRENCH_TEST_HOME: state.root,
              WRENCH_TEST_READY: ready,
              WRENCH_TEST_GATE: gate,
              WRENCH_TEST_RESULT: result,
              WRENCH_TEST_GENERATION: String(generation),
              WRENCH_TEST_TOMBSTONE: tombstone,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
      };
    };
    const slower = worker("slower", 2, "stale-cookie");
    const faster = worker("faster", 3, "deleted-cookie");
    try {
      await Promise.all([
        waitForFile(slower.ready),
        waitForFile(faster.ready),
      ]);

      writeFileSync(faster.gate, "go\n");
      await waitForFile(faster.result);
      writeFileSync(slower.gate, "go\n");
      await waitForFile(slower.result);
      const [fasterExit, slowerExit] = await Promise.all([
        faster.child.exited,
        slower.child.exited,
      ]);
      if (fasterExit !== 0 || slowerExit !== 0) {
        const [fasterError, slowerError] = await Promise.all([
          new Response(faster.child.stderr).text(),
          new Response(slower.child.stderr).text(),
        ]);
        throw new Error(
          `CAS worker failed: ${fasterError.slice(0, 256)} ${slowerError.slice(0, 256)}`,
        );
      }

      expect(jsonRecord(
        readFileSync(faster.result, "utf8"),
        "faster CAS result",
      ).written).toBeTrue();
      expect(jsonRecord(
        readFileSync(slower.result, "utf8"),
        "slower CAS result",
      )).toEqual({ written: false });
      expect(readSessionSecret(
        "linkedin",
        "linkedin-main",
        authHash,
        state.value,
      )).toEqual({ generation: 3, tombstones: ["deleted-cookie"] });
    } finally {
      faster.child.kill("SIGKILL");
      slower.child.kill("SIGKILL");
      await Promise.all([
        faster.child.exited,
        slower.child.exited,
      ]);
    }
  });

  test("creates an absent coordinate exclusively and never resurrects a removed file", () => {
    const state = environment();
    const authHash = "3".repeat(64);
    const absent = readSessionSecretSnapshot(
      "linkedin",
      "linkedin-main",
      authHash,
      state.value,
    );
    expect(absent).toEqual({ value: null, contentSha256: null });

    const winner = writeSessionSecretIfUnchanged(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 2, tombstones: ["li_at"] },
      absent.contentSha256,
      state.value,
    );
    expect(winner.written).toBeTrue();
    const losingFirstWriter = writeSessionSecretIfUnchanged(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 1, cookies: ["li_at"] },
      absent.contentSha256,
      state.value,
    );
    expect(losingFirstWriter).toEqual({ written: false });

    const current = readSessionSecretSnapshot(
      "linkedin",
      "linkedin-main",
      authHash,
      state.value,
    );
    expect(removeSessionSecret(
      "linkedin",
      "linkedin-main",
      state.value,
    )).toBeTrue();
    const staleAfterRemoval = writeSessionSecretIfUnchanged(
      "linkedin",
      "linkedin-main",
      authHash,
      { generation: 2, cookies: ["li_at"] },
      current.contentSha256,
      state.value,
    );
    expect(staleAfterRemoval).toEqual({ written: false });
    expect(readSessionSecret(
      "linkedin",
      "linkedin-main",
      authHash,
      state.value,
    )).toBeNull();
  });

  test("reads historical schema-v1 keys and envelopes, then writes schema v2", () => {
    const state = environment();
    const authHash = "4".repeat(64);
    const secret = { refreshJwt: "historical-private-refresh-token" };
    writeSessionSecret(
      "bluesky",
      "bluesky-main",
      authHash,
      { temporary: true },
      state.value,
    );
    const keyPath = join(state.root, ".session-encryption-key");
    const keyRecord = jsonRecord(
      readFileSync(keyPath, "utf8"),
      "session encryption key",
    );
    if (
      typeof keyRecord.key !== "string"
      || !/^[a-f0-9]{64}$/u.test(keyRecord.key)
    ) throw new Error("session encryption-key fixture is malformed");
    writeFileSync(
      keyPath,
      `${canonicalJson({ schemaVersion: 1, key: keyRecord.key })}\n`,
      { mode: 0o600 },
    );

    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(keyRecord.key, "hex"),
      iv,
    );
    cipher.setAAD(Buffer.from(
      `io-session-secret-v1\0bluesky\0bluesky-main\0${authHash}`,
      "utf8",
    ));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(secret), "utf8")),
      cipher.final(),
    ]);
    const secretPath = join(
      state.root,
      "session-secrets",
      "bluesky--bluesky-main.json",
    );
    writeFileSync(
      secretPath,
      `${canonicalJson({
        schemaVersion: 1,
        encryption: "aes-256-gcm",
        namespace: "bluesky",
        authId: "bluesky-main",
        authHash,
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      })}\n`,
      { mode: 0o600 },
    );

    const historical = readSessionSecretSnapshot(
      "bluesky",
      "bluesky-main",
      authHash,
      state.value,
    );
    expect(historical.value).toEqual(secret);
    const migrated = writeSessionSecretIfUnchanged(
      "bluesky",
      "bluesky-main",
      authHash,
      { refreshJwt: "new-private-refresh-token" },
      historical.contentSha256,
      state.value,
    );
    expect(migrated.written).toBeTrue();
    const migratedEnvelope = jsonRecord(
      readFileSync(secretPath, "utf8"),
      "migrated encrypted session secret",
    );
    expect(migratedEnvelope.schemaVersion).toBe(2);
    expect(migratedEnvelope.keyId).toMatch(/^[a-f0-9]{64}$/u);
    expect(readSessionSecret(
      "bluesky",
      "bluesky-main",
      authHash,
      state.value,
    )).toEqual({ refreshJwt: "new-private-refresh-token" });
  });
});
