import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDerivationGuardExtension,
  DERIVATION_GUARD_EXTENSION_DIRECTORY,
  DERIVATION_GUARD_EXTENSION_ID,
  derivationGuardExtensionFiles,
  derivationGuardControlSocketPath,
  derivationGuardReadinessCheckCount,
  derivationGuardReadinessPolicySha256,
  derivationGuardResourceTypes,
  derivationGuardRules,
  derivationProxyPolicySha256,
  parseDerivationNetworkGuard,
  parseProxyHelperConfig,
  verifyDerivationGuardExtension,
} from "./derivation-network-guard";

describe("contained derivation MV3 guard", () => {
  test("derives a bounded standalone control path outside agent-browser socket cleanup", () => {
    const id = "12345678-1234-4123-8123-123456789abc";
    const path = derivationGuardControlSocketPath(id);
    expect(path).toEndWith(`/io-wrench-dp-${id}.ctl`);
    expect(path).not.toEndWith(".sock");
    expect(() => derivationGuardControlSocketPath("not-a-derivation-id")).toThrow("malformed");
  });

  test("emits deterministic least-privilege extension bytes and every explicit resource type", () => {
    const domains = ["studio.example.com", "*.upload.example.com"];
    const first = derivationGuardExtensionFiles(domains);
    const second = derivationGuardExtensionFiles(domains);
    expect(first).toEqual(second);
    const manifest = JSON.parse(first["manifest.json"]) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "readiness.js" });
    expect(first).not.toHaveProperty("readiness.html");
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest.permissions).toEqual([
      "declarativeNetRequest",
      "declarativeNetRequestFeedback",
    ]);
    expect(first["readiness.js"]).toContain(DERIVATION_GUARD_EXTENSION_ID);
    expect(first["readiness.js"]).toContain(
      derivationGuardReadinessPolicySha256(domains),
    );
    expect(first["readiness.js"]).not.toContain("fetch(");

    const rules = derivationGuardRules(domains);
    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      expect(rule.condition.resourceTypes).toEqual(derivationGuardResourceTypes);
      expect(rule.condition.isUrlFilterCaseSensitive).toBeFalse();
    }
    expect(rules[0]?.action.type).toBe("block");
    expect(rules[0]?.condition.regexFilter).toBe("^(?:http|https|ws|wss)://");
    expect(rules.slice(1).every((rule) => rule.action.type === "allow" && rule.priority > 1))
      .toBeTrue();
    expect(derivationGuardReadinessCheckCount(domains)).toBeGreaterThan(
      derivationGuardResourceTypes.length + rules.length,
    );
    const policySha256 = derivationGuardReadinessPolicySha256(domains);
    expect(policySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(derivationGuardReadinessPolicySha256([...domains])).toBe(policySha256);
    expect(derivationGuardReadinessPolicySha256([
      "different.example.com",
      "*.upload.example.com",
    ])).not.toBe(policySha256);
    expect(derivationGuardReadinessCheckCount([
      "different.example.com",
      "*.upload.example.com",
    ])).toBe(derivationGuardReadinessCheckCount(domains));
  });

  test("allow expressions cover only HTTPS/WSS exact and wildcard hosts", () => {
    const [block, exact, wildcard] = derivationGuardRules([
      "studio.example.com",
      "*.upload.example.com",
    ]);
    expect(block).toBeDefined();
    const exactRegex = new RegExp(exact?.condition.regexFilter ?? "", "iu");
    const wildcardRegex = new RegExp(wildcard?.condition.regexFilter ?? "", "iu");
    for (const value of [
      "https://studio.example.com/",
      "wss://studio.example.com/socket",
      "https://STUDIO.EXAMPLE.COM:8443/path",
    ]) expect(exactRegex.test(value)).toBeTrue();
    for (const value of [
      "http://studio.example.com/",
      "ws://studio.example.com/socket",
      "https://studio.example.com./",
      "https://notstudio.example.com/",
      "https://studio.example.com.invalid/",
    ]) expect(exactRegex.test(value)).toBeFalse();
    for (const value of [
      "https://upload.example.com/",
      "https://a.upload.example.com/",
      "wss://a.b.upload.example.com/socket",
    ]) expect(wildcardRegex.test(value)).toBeTrue();
    for (const value of [
      "https://notupload.example.com/",
      "https://upload.example.com.invalid/",
      "https://upload.example.com./",
    ]) expect(wildcardRegex.test(value)).toBeFalse();
  });

  test("binds exact private extension identities and detects byte, mode, and inode drift", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-guard-files-test-"));
    chmodSync(root, 0o700);
    const domains = ["example.com"];
    try {
      const extension = createDerivationGuardExtension(root, domains);
      expect(() => verifyDerivationGuardExtension(root, domains, extension)).not.toThrow();
      const rulesPath = join(root, DERIVATION_GUARD_EXTENSION_DIRECTORY, "rules.json");
      const original = readFileSync(rulesPath, "utf8");
      writeFileSync(rulesPath, original.replace("https", "httpx"), { mode: 0o600 });
      expect(() => verifyDerivationGuardExtension(root, domains, extension)).toThrow("changed");
      rmSync(rulesPath);
      let failure: unknown = null;
      try {
        verifyDerivationGuardExtension(root, domains, extension);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const diagnostic = failure instanceof Error ? failure.message : "";
      expect(diagnostic).toBe("derivation network guard file changed or is unavailable");
      expect(diagnostic).not.toContain(root);
      expect(diagnostic).not.toContain(domains[0] as string);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strict parsers reject metadata drift and policy changes", () => {
    const hash = "a".repeat(64);
    const evidence = { device: "1", inode: "2", byteLength: 10, sha256: hash };
    const guard = {
      schemaVersion: 1,
      kind: "contained-mv3-dnr-proxy",
      extension: {
        id: DERIVATION_GUARD_EXTENSION_ID,
        directoryIdentity: { device: "1", inode: "3" },
        files: {
          "manifest.json": evidence,
          "rules.json": evidence,
          "readiness.js": evidence,
        },
      },
      proxy: {
        policySha256: hash,
        controlNonce: "b".repeat(64),
        port: 43123,
        owner: { pid: 123, bootId: hash, processStartId: "c".repeat(64) },
        parentOwner: { pid: 122, bootId: hash, processStartId: "e".repeat(64) },
        configFile: evidence,
        readyFile: evidence,
      },
    } as const;
    expect(parseDerivationNetworkGuard(guard)).toEqual(guard);
    expect(() => parseDerivationNetworkGuard({ ...guard, extra: true })).toThrow("malformed");

    const domains = ["example.com"];
    const config = {
      schemaVersion: 1,
      kind: "wrench-derivation-proxy-config",
      derivationId: "12345678-1234-4123-8123-123456789abc",
      directoryIdentity: { device: "1", inode: "2" },
      socketDirectory: "/tmp/io-derive-ab-test",
      socketIdentity: { device: "1", inode: "3" },
      browserDomains: domains,
      parentOwner: { pid: 122, bootId: hash, processStartId: "e".repeat(64) },
      controlNonce: "d".repeat(64),
      policySha256: derivationProxyPolicySha256(domains),
    } as const;
    expect(parseProxyHelperConfig(config)).toEqual(config);
    expect(() => parseProxyHelperConfig({
      ...config,
      browserDomains: ["different.example.com"],
    })).toThrow("policy changed");
  });
});
