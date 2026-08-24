import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import type { ProcessOwnerIdentity } from "./process-identity";

export const DERIVATION_GUARD_EXTENSION_DIRECTORY = "network-guard-extension";
export const DERIVATION_GUARD_PROXY_CONFIG = "network-proxy.json";
export const DERIVATION_GUARD_PROXY_READY = "network-proxy-ready.json";
/** Legacy schema-v1 location inside AGENT_BROWSER_SOCKET_DIR. */
export const DERIVATION_GUARD_CONTROL_SOCKET = "network-proxy-control.sock";

export const derivationGuardResourceTypes = Object.freeze([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
] as const);

const extensionPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8IQKI/uEK3ld2F8VY/ijbVaaT9uIILnZWiqOpI8K/n6/I6RKAm+QgBDjfq+mnvArr4uIFdkNm60utfLZ+bc6iFs3W62og1O7kTqohzkWc8VLwCIXJ4rMfQN2GFh+CSYu122uteGau87T1iUZtIc+k5oocpXiFlKDO39ZacV5v2zZLwu6ifz8r3XmWo1Knhhez0TzlsMpgHY6O7oQb3UFzjU4loZo+LpBTzObov05czdXAVHoVWE7rdRUxNeVHQrla0oY/MBh87bpd2rrEqG8K/RgkXE3LOZrdGRK2mqYNQC0eJgwIRxnpyD7QxAifs2r1KAPQeCjmgkscAR6T8m6gwIDAQAB";
export const DERIVATION_GUARD_EXTENSION_ID = "gjhalpeeegljfdmfkoilmojkfehhpgbm";
const extensionFileNames = Object.freeze([
  "manifest.json",
  "rules.json",
  "readiness.js",
] as const);
const digestPattern = /^[a-f0-9]{64}$/u;
const unsignedIntegerPattern = /^\d{1,40}$/u;
const derivationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Keep Wrench's authenticated proxy control endpoint outside agent-browser's
 * disposable socket namespace. The UUID-bounded name also stays below Unix
 * domain socket path limits on the supported macOS and Linux hosts.
 */
export function derivationGuardControlSocketPath(derivationId: string): string {
  if (!derivationIdPattern.test(derivationId)) {
    throw new Error("derivation proxy control identity is malformed");
  }
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  // Do not use a `.sock` suffix: agent-browser treats orphan `*.sock` files
  // in its configured socket root as disposable daemon endpoints.
  return join(root, `io-wrench-dp-${derivationId}.ctl`);
}

export type GuardDirectoryIdentity = {
  readonly device: string;
  readonly inode: string;
};

export type GuardPrivateFileEvidence = GuardDirectoryIdentity & {
  readonly byteLength: number;
  readonly sha256: string;
};

export type DerivationGuardExtension = {
  readonly id: typeof DERIVATION_GUARD_EXTENSION_ID;
  readonly directoryIdentity: GuardDirectoryIdentity;
  readonly files: Readonly<Record<(typeof extensionFileNames)[number], GuardPrivateFileEvidence>>;
};

export type DerivationProxyHelperConfig = {
  readonly schemaVersion: 1;
  readonly kind: "wrench-derivation-proxy-config";
  readonly derivationId: string;
  readonly directoryIdentity: GuardDirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: GuardDirectoryIdentity;
  readonly browserDomains: readonly string[];
  readonly parentOwner: ProcessOwnerIdentity;
  readonly controlNonce: string;
  readonly policySha256: string;
};

export type DerivationProxyHelperReady = {
  readonly schemaVersion: 1;
  readonly kind: "wrench-derivation-proxy-ready";
  readonly derivationId: string;
  readonly policySha256: string;
  readonly port: number;
  readonly owner: ProcessOwnerIdentity;
};

export type DerivationNetworkGuard = {
  readonly schemaVersion: 1;
  readonly kind: "contained-mv3-dnr-proxy";
  readonly extension: DerivationGuardExtension;
  readonly proxy: {
    readonly policySha256: string;
    readonly controlNonce: string;
    readonly port: number;
    readonly owner: ProcessOwnerIdentity;
    readonly parentOwner: ProcessOwnerIdentity;
    readonly configFile: GuardPrivateFileEvidence;
    readonly readyFile: GuardPrivateFileEvidence;
  };
};

type DnrRule = {
  readonly id: number;
  readonly priority: number;
  readonly action: { readonly type: "allow" | "block" };
  readonly condition: {
    readonly regexFilter: string;
    readonly isUrlFilterCaseSensitive: false;
    readonly resourceTypes: typeof derivationGuardResourceTypes;
  };
};

type GuardRuntimeCase = {
  readonly label: string;
  readonly url: string;
  readonly type: (typeof derivationGuardResourceTypes)[number];
  readonly ruleId: number;
};

function currentUserOwns(uid: number | bigint): boolean {
  const current = typeof process.getuid === "function" ? process.getuid() : undefined;
  return current === undefined || uid === (typeof uid === "bigint" ? BigInt(current) : current);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function domainAllowRegex(domain: string): string {
  const wildcard = domain.startsWith("*.");
  const base = wildcard ? domain.slice(2) : domain;
  const host = wildcard
    ? `(?:[a-z0-9-]+\\.)*${escapeRegex(base)}`
    : escapeRegex(base);
  return `^(?:https|wss)://${host}(?::[0-9]{1,5})?(?:[/?]|$)`;
}

function domainRuleId(index: number): number {
  return 100 + index;
}

export function derivationGuardRules(browserDomains: readonly string[]): readonly DnrRule[] {
  return Object.freeze([
    {
      id: 1,
      priority: 1,
      action: { type: "block" },
      condition: {
        regexFilter: "^(?:http|https|ws|wss)://",
        isUrlFilterCaseSensitive: false,
        resourceTypes: derivationGuardResourceTypes,
      },
    },
    ...browserDomains.map((domain, index): DnrRule => ({
      id: domainRuleId(index),
      priority: 2,
      action: { type: "allow" },
      condition: {
        regexFilter: domainAllowRegex(domain),
        isUrlFilterCaseSensitive: false,
        resourceTypes: derivationGuardResourceTypes,
      },
    })),
  ]);
}

function runtimeCases(browserDomains: readonly string[]): readonly GuardRuntimeCase[] {
  const cases: GuardRuntimeCase[] = [];
  for (const [index, domain] of browserDomains.entries()) {
    const base = domain.startsWith("*.") ? domain.slice(2) : domain;
    const host = domain.startsWith("*.") ? `wrench-check.${base}` : base;
    const ruleId = domainRuleId(index);
    cases.push(
      { label: `allow-${index}-https`, url: `https://${host}/wrench-check`, type: "xmlhttprequest", ruleId },
      { label: `allow-${index}-wss`, url: `wss://${host}/wrench-check`, type: "websocket", ruleId },
      { label: `allow-${index}-uppercase`, url: `https://${host.toUpperCase()}/wrench-check`, type: "main_frame", ruleId },
      { label: `allow-${index}-port`, url: `https://${host}:8443/wrench-check`, type: "sub_frame", ruleId },
      { label: `block-${index}-http`, url: `http://${host}/wrench-check`, type: "xmlhttprequest", ruleId: 1 },
      { label: `block-${index}-ws`, url: `ws://${host}/wrench-check`, type: "websocket", ruleId: 1 },
      { label: `block-${index}-trailing-dot`, url: `https://${host}./wrench-check`, type: "main_frame", ruleId: 1 },
      { label: `block-${index}-suffix`, url: `https://${host}.invalid/wrench-check`, type: "main_frame", ruleId: 1 },
      { label: `block-${index}-sibling`, url: `https://not-${host}/wrench-check`, type: "main_frame", ruleId: 1 },
    );
    if (domain.startsWith("*.")) {
      cases.push({
        label: `allow-${index}-wildcard-base`,
        url: `https://${base}/wrench-check`,
        type: "main_frame",
        ruleId,
      });
    }
  }
  const first = browserDomains[0];
  if (first !== undefined) {
    const base = first.startsWith("*.") ? first.slice(2) : first;
    const host = first.startsWith("*.") ? `wrench-check.${base}` : base;
    for (const type of derivationGuardResourceTypes) {
      cases.push({
        label: `resource-${type}`,
        url: `${type === "websocket" ? "wss" : "https"}://${host}/resource-${type}`,
        type,
        ruleId: domainRuleId(0),
      });
    }
  }
  cases.push({
    label: "block-unallowed-punycode",
    url: "https://xn--wrench-unallowed-9d0b.invalid/wrench-check",
    type: "main_frame",
    ruleId: 1,
  });
  return Object.freeze(cases);
}

export function derivationGuardReadinessCheckCount(
  browserDomains: readonly string[],
): number {
  return 3 + derivationGuardRules(browserDomains).length + runtimeCases(browserDomains).length;
}

function readinessPolicySha256(
  rules: readonly DnrRule[],
  cases: readonly GuardRuntimeCase[],
): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    extensionId: DERIVATION_GUARD_EXTENSION_ID,
    rules,
    cases,
  }));
}

export function derivationGuardReadinessPolicySha256(
  browserDomains: readonly string[],
): string {
  return readinessPolicySha256(
    derivationGuardRules(browserDomains),
    runtimeCases(browserDomains),
  );
}

function readinessScript(
  rules: readonly DnrRule[],
  cases: readonly GuardRuntimeCase[],
): string {
  const regexes = rules.map((rule) => ({
    id: rule.id,
    regex: rule.condition.regexFilter,
  }));
  const policySha256 = readinessPolicySha256(rules, cases);
  return `"use strict";\nconst extensionId=${JSON.stringify(DERIVATION_GUARD_EXTENSION_ID)};\nconst policySha256=${JSON.stringify(policySha256)};\nconst regexes=${JSON.stringify(regexes)};\nconst cases=${JSON.stringify(cases)};\nglobalThis.__wrenchCheckGuard=async()=>{let checks=0;try{if(chrome.runtime.id!==extensionId)throw new Error("id");checks+=1;const enabled=await chrome.declarativeNetRequest.getEnabledRulesets();if(!Array.isArray(enabled)||enabled.length!==1||enabled[0]!=="rules")throw new Error("ruleset");checks+=1;const disabled=await chrome.declarativeNetRequest.getDisabledRuleIds({rulesetId:"rules"});if(!Array.isArray(disabled)||disabled.length!==0)throw new Error("disabled");checks+=1;for(const item of regexes){const support=await chrome.declarativeNetRequest.isRegexSupported({isCaseSensitive:false,regex:item.regex});if(!support||support.isSupported!==true)throw new Error("regex");checks+=1}for(const item of cases){const result=await chrome.declarativeNetRequest.testMatchOutcome({type:item.type,url:item.url});if(!result||!Array.isArray(result.matchedRules)||result.matchedRules.length!==1)throw new Error("outcome");const match=result.matchedRules[0];if(!match||match.ruleId!==item.ruleId||match.rulesetId!=="rules")throw new Error("rule");checks+=1}return{schemaVersion:1,ok:true,extensionId,policySha256,checks}}catch{return{schemaVersion:1,ok:false,extensionId:"",policySha256:"",checks:0}}};\n`;
}

export function derivationGuardExtensionFiles(
  browserDomains: readonly string[],
): Readonly<Record<(typeof extensionFileNames)[number], string>> {
  const rules = derivationGuardRules(browserDomains);
  const manifest = {
    manifest_version: 3,
    name: "Wrench Derivation Network Guard",
    version: "1.0.0",
    key: extensionPublicKey,
    background: { service_worker: "readiness.js" },
    permissions: ["declarativeNetRequest", "declarativeNetRequestFeedback"],
    declarative_net_request: {
      rule_resources: [{ id: "rules", enabled: true, path: "rules.json" }],
    },
  };
  return Object.freeze({
    "manifest.json": `${JSON.stringify(manifest)}\n`,
    "rules.json": `${JSON.stringify(rules)}\n`,
    "readiness.js": readinessScript(rules, runtimeCases(browserDomains)),
  });
}

function extensionIdFromKey(): string {
  const digest = createHash("sha256")
    .update(Buffer.from(extensionPublicKey, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...digest].map((value) => "abcdefghijklmnop"[Number.parseInt(value, 16)]).join("");
}

function inspectDirectory(path: string): GuardDirectoryIdentity {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || !currentUserOwns(stats.uid)
      || (stats.mode & 0o777n) !== 0o700n
    ) throw new Error("unsafe");
    return { device: stats.dev.toString(), inode: stats.ino.toString() };
  } catch {
    throw new Error("derivation network guard directory is unavailable or unsafe");
  }
}

function sameIdentity(left: GuardDirectoryIdentity, right: GuardDirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function writeGuardPrivateFile(path: string, content: string): GuardPrivateFileEvidence {
  let descriptor: number | null = null;
  let openedIdentity: GuardDirectoryIdentity | null = null;
  let completed = false;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      0o600,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    openedIdentity = { device: opened.dev.toString(), inode: opened.ino.toString() };
    fchmodSync(descriptor, 0o600);
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(descriptor);
    const stats = fstatSync(descriptor, { bigint: true });
    if (
      !stats.isFile()
      || !currentUserOwns(stats.uid)
      || (stats.mode & 0o777n) !== 0o600n
      || stats.size !== BigInt(bytes.byteLength)
    ) throw new Error("derivation network guard file could not be secured");
    const evidence = {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      byteLength: bytes.byteLength,
      sha256: sha256(content),
    };
    completed = true;
    return evidence;
  } catch {
    throw new Error("derivation network guard file could not be secured");
  } finally {
    if (descriptor !== null) {
      if (!completed && openedIdentity === null) {
        try {
          const stats = fstatSync(descriptor, { bigint: true });
          openedIdentity = { device: stats.dev.toString(), inode: stats.ino.toString() };
        } catch {
          // Without an exact identity, preserve the path instead of unlinking.
        }
      }
      try {
        closeSync(descriptor);
      } catch {
        // The categorical write failure below must not expose a local path.
      }
    }
    if (!completed && openedIdentity !== null) {
      try {
        const current = lstatSync(path, { bigint: true });
        if (
          current.dev.toString() === openedIdentity.device
          && current.ino.toString() === openedIdentity.inode
        ) unlinkSync(path);
      } catch {
        // A changed path is intentionally preserved.
      }
    }
  }
}

export function readGuardPrivateFile(
  path: string,
  maximumBytes = 4 * 1024 * 1024,
): { readonly content: string; readonly evidence: GuardPrivateFileEvidence } {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || !currentUserOwns(before.uid)
      || (before.mode & 0o777n) !== 0o600n
      || before.size < 1n
      || before.size > BigInt(maximumBytes)
    ) throw new Error("derivation network guard file is unavailable or unsafe");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) throw new Error("derivation network guard file changed size");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error("derivation network guard file changed while reading");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      content,
      evidence: {
        device: before.dev.toString(),
        inode: before.ino.toString(),
        byteLength: bytes.byteLength,
        sha256: sha256(content),
      },
    };
  } catch {
    throw new Error("derivation network guard file is unavailable or unsafe");
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Keep diagnostics categorical and path-free.
      }
    }
  }
}

export function createDerivationGuardExtension(
  directory: string,
  browserDomains: readonly string[],
): DerivationGuardExtension {
  if (extensionIdFromKey() !== DERIVATION_GUARD_EXTENSION_ID) {
    throw new Error("derivation network guard extension identity changed");
  }
  const extensionDirectory = join(directory, DERIVATION_GUARD_EXTENSION_DIRECTORY);
  try {
    mkdirSync(extensionDirectory, { mode: 0o700 });
    chmodSync(extensionDirectory, 0o700);
  } catch {
    throw new Error("derivation network guard extension could not be created");
  }
  const directoryIdentity = inspectDirectory(extensionDirectory);
  const contents = derivationGuardExtensionFiles(browserDomains);
  const files = Object.fromEntries(extensionFileNames.map((name) => [
    name,
    writeGuardPrivateFile(join(extensionDirectory, name), contents[name]),
  ])) as Record<(typeof extensionFileNames)[number], GuardPrivateFileEvidence>;
  if (!sameIdentity(inspectDirectory(extensionDirectory), directoryIdentity)) {
    throw new Error("derivation network guard directory changed during creation");
  }
  return Object.freeze({
    id: DERIVATION_GUARD_EXTENSION_ID,
    directoryIdentity,
    files: Object.freeze(files),
  });
}

export function verifyGuardPrivateFile(
  path: string,
  expected: GuardPrivateFileEvidence,
  expectedContent: string,
): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || !currentUserOwns(before.uid)
      || (before.mode & 0o777n) !== 0o600n
      || before.dev.toString() !== expected.device
      || before.ino.toString() !== expected.inode
      || before.size !== BigInt(expected.byteLength)
    ) throw new Error("derivation network guard file changed identity");
    const bytes = Buffer.alloc(expected.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) throw new Error("derivation network guard file changed size");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || bytes.toString("utf8") !== expectedContent
      || sha256(expectedContent) !== expected.sha256
    ) throw new Error("derivation network guard file changed content");
  } catch {
    throw new Error("derivation network guard file changed or is unavailable");
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Keep diagnostics categorical and path-free.
      }
    }
  }
}

export function verifyDerivationGuardExtension(
  directory: string,
  browserDomains: readonly string[],
  extension: DerivationGuardExtension,
): void {
  if (extension.id !== DERIVATION_GUARD_EXTENSION_ID || extensionIdFromKey() !== extension.id) {
    throw new Error("derivation network guard extension identity changed");
  }
  const extensionDirectory = join(directory, DERIVATION_GUARD_EXTENSION_DIRECTORY);
  if (!sameIdentity(inspectDirectory(extensionDirectory), extension.directoryIdentity)) {
    throw new Error("derivation network guard directory changed identity");
  }
  const contents = derivationGuardExtensionFiles(browserDomains);
  for (const name of extensionFileNames) {
    verifyGuardPrivateFile(join(extensionDirectory, name), extension.files[name], contents[name]);
  }
}

export function derivationProxyPolicySha256(browserDomains: readonly string[]): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    kind: "wrench-derivation-connect-policy",
    browserDomains,
    allowPrivateNetwork: false,
    transport: "connect-tls-tunnel",
  }));
}

export function proxyHelperConfigContent(config: DerivationProxyHelperConfig): string {
  return `${JSON.stringify(config)}\n`;
}

export function proxyHelperReadyContent(ready: DerivationProxyHelperReady): string {
  return `${JSON.stringify(ready)}\n`;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

export function parseGuardDirectoryIdentity(value: unknown): GuardDirectoryIdentity {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["device", "inode"])
  ) throw new Error("derivation network guard identity is malformed");
  const record = value as Record<string, unknown>;
  if (
    typeof record.device !== "string"
    || !unsignedIntegerPattern.test(record.device)
    || typeof record.inode !== "string"
    || !unsignedIntegerPattern.test(record.inode)
  ) throw new Error("derivation network guard identity is malformed");
  return { device: record.device, inode: record.inode };
}

export function parseGuardFileEvidence(value: unknown): GuardPrivateFileEvidence {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["device", "inode", "byteLength", "sha256"])
  ) throw new Error("derivation network guard file evidence is malformed");
  const record = value as Record<string, unknown>;
  const identity = parseGuardDirectoryIdentity({ device: record.device, inode: record.inode });
  if (
    !Number.isSafeInteger(record.byteLength)
    || (record.byteLength as number) < 1
    || (record.byteLength as number) > 4 * 1024 * 1024
    || typeof record.sha256 !== "string"
    || !digestPattern.test(record.sha256)
  ) throw new Error("derivation network guard file evidence is malformed");
  return {
    ...identity,
    byteLength: record.byteLength as number,
    sha256: record.sha256,
  };
}

function parseOwner(value: unknown): ProcessOwnerIdentity {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["pid", "bootId", "processStartId"])
  ) throw new Error("derivation proxy owner is malformed");
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || typeof record.bootId !== "string"
    || !digestPattern.test(record.bootId)
    || typeof record.processStartId !== "string"
    || !digestPattern.test(record.processStartId)
  ) throw new Error("derivation proxy owner is malformed");
  return {
    pid: record.pid as number,
    bootId: record.bootId,
    processStartId: record.processStartId,
  };
}

export function parseDerivationNetworkGuard(value: unknown): DerivationNetworkGuard {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["schemaVersion", "kind", "extension", "proxy"])
  ) throw new Error("derivation network guard metadata is malformed");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "contained-mv3-dnr-proxy") {
    throw new Error("derivation network guard metadata is malformed");
  }
  if (
    typeof record.extension !== "object"
    || record.extension === null
    || Array.isArray(record.extension)
    || !exactKeys(record.extension as Record<string, unknown>, ["id", "directoryIdentity", "files"])
  ) throw new Error("derivation network guard extension metadata is malformed");
  const extensionRecord = record.extension as Record<string, unknown>;
  if (
    extensionRecord.id !== DERIVATION_GUARD_EXTENSION_ID
    || typeof extensionRecord.files !== "object"
    || extensionRecord.files === null
    || Array.isArray(extensionRecord.files)
    || !exactKeys(extensionRecord.files as Record<string, unknown>, extensionFileNames)
  ) throw new Error("derivation network guard extension metadata is malformed");
  const fileRecord = extensionRecord.files as Record<string, unknown>;
  const files = Object.fromEntries(extensionFileNames.map((name) => [
    name,
    parseGuardFileEvidence(fileRecord[name]),
  ])) as Record<(typeof extensionFileNames)[number], GuardPrivateFileEvidence>;
  if (
    typeof record.proxy !== "object"
    || record.proxy === null
    || Array.isArray(record.proxy)
    || !exactKeys(record.proxy as Record<string, unknown>, [
      "policySha256", "controlNonce", "port", "owner", "parentOwner", "configFile", "readyFile",
    ])
  ) throw new Error("derivation network proxy metadata is malformed");
  const proxy = record.proxy as Record<string, unknown>;
  if (
    typeof proxy.policySha256 !== "string"
    || !digestPattern.test(proxy.policySha256)
    || typeof proxy.controlNonce !== "string"
    || !/^[a-f0-9]{64}$/u.test(proxy.controlNonce)
    || !Number.isSafeInteger(proxy.port)
    || (proxy.port as number) < 1
    || (proxy.port as number) > 65_535
  ) throw new Error("derivation network proxy metadata is malformed");
  return Object.freeze({
    schemaVersion: 1,
    kind: "contained-mv3-dnr-proxy",
    extension: Object.freeze({
      id: DERIVATION_GUARD_EXTENSION_ID,
      directoryIdentity: parseGuardDirectoryIdentity(extensionRecord.directoryIdentity),
      files: Object.freeze(files),
    }),
    proxy: Object.freeze({
      policySha256: proxy.policySha256,
      controlNonce: proxy.controlNonce,
      port: proxy.port as number,
      owner: parseOwner(proxy.owner),
      parentOwner: parseOwner(proxy.parentOwner),
      configFile: parseGuardFileEvidence(proxy.configFile),
      readyFile: parseGuardFileEvidence(proxy.readyFile),
    }),
  });
}

export function parseProxyHelperConfig(value: unknown): DerivationProxyHelperConfig {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, [
      "schemaVersion", "kind", "derivationId", "directoryIdentity", "socketDirectory",
      "socketIdentity", "browserDomains", "parentOwner", "controlNonce", "policySha256",
    ])
  ) throw new Error("derivation proxy helper config is malformed");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || record.kind !== "wrench-derivation-proxy-config"
    || typeof record.derivationId !== "string"
    || !derivationIdPattern.test(record.derivationId)
    || typeof record.socketDirectory !== "string"
    || record.socketDirectory.length < 1
    || record.socketDirectory.length > 4_096
    || record.socketDirectory.includes("\0")
    || !Array.isArray(record.browserDomains)
    || record.browserDomains.length < 1
    || record.browserDomains.length > 100
    || record.browserDomains.some((domain) => typeof domain !== "string")
    || typeof record.controlNonce !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.controlNonce)
    || typeof record.policySha256 !== "string"
    || !digestPattern.test(record.policySha256)
  ) throw new Error("derivation proxy helper config is malformed");
  const browserDomains = record.browserDomains.map((domain) => String(domain));
  if (derivationProxyPolicySha256(browserDomains) !== record.policySha256) {
    throw new Error("derivation proxy helper policy changed");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "wrench-derivation-proxy-config",
    derivationId: record.derivationId,
    directoryIdentity: parseGuardDirectoryIdentity(record.directoryIdentity),
    socketDirectory: record.socketDirectory,
    socketIdentity: parseGuardDirectoryIdentity(record.socketIdentity),
    browserDomains: Object.freeze(browserDomains),
    parentOwner: parseOwner(record.parentOwner),
    controlNonce: record.controlNonce,
    policySha256: record.policySha256,
  });
}

export function parseProxyHelperReady(value: unknown): DerivationProxyHelperReady {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, [
      "schemaVersion", "kind", "derivationId", "policySha256", "port", "owner",
    ])
  ) throw new Error("derivation proxy helper readiness is malformed");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || record.kind !== "wrench-derivation-proxy-ready"
    || typeof record.derivationId !== "string"
    || !derivationIdPattern.test(record.derivationId)
    || typeof record.policySha256 !== "string"
    || !digestPattern.test(record.policySha256)
    || !Number.isSafeInteger(record.port)
    || (record.port as number) < 1
    || (record.port as number) > 65_535
  ) throw new Error("derivation proxy helper readiness is malformed");
  return Object.freeze({
    schemaVersion: 1,
    kind: "wrench-derivation-proxy-ready",
    derivationId: record.derivationId,
    policySha256: record.policySha256,
    port: record.port as number,
    owner: parseOwner(record.owner),
  });
}
