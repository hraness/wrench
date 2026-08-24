#!/usr/bin/env bun
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import {
  agentBrowserCommand,
  isolatedEnvironment,
  parseLastJsonWithExactLaunchHashes,
  runCommand,
} from "./browser";
import {
  derivationActionPolicy,
  derivationBrowserConfig,
  derivationConfirmedPolicyActions,
} from "./derive";
import {
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const maximumU64 = (1n << 64n) - 1n;

type Identity = { readonly device: string; readonly inode: string };
export type BrowserIdentity = {
  readonly engine: "chrome";
  readonly launchHash: string;
};

export type BrowserPin = {
  readonly sessionName: string;
  readonly cdpUrl: string;
  readonly browserIdentity: BrowserIdentity | null;
  readonly confirmationAction: string | null;
  readonly daemonOwner: ProcessOwnerIdentity | null;
};

type CodeOwnedBrowserRequest =
  | "none"
  | "initial-contained-launch"
  | "readiness-context"
  | "pin-context"
  | "pinned-batch"
  | "pinned-confirm"
  | "profile-confirm";

type Request = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expectedDirectory: Identity;
  readonly socketDirectory: string;
  readonly expectedSocketDirectory: Identity;
  readonly ownerSessionName: string;
  readonly allowRemoteActions: boolean;
  readonly allowFixtureUpload: boolean;
  readonly guardedBrowserConfig: boolean;
  readonly codeOwnedBrowserRequest: CodeOwnedBrowserRequest;
  readonly browserPin: BrowserPin | null;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly arguments: readonly string[];
  readonly browserStdin: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseIdentity(value: unknown): Identity {
  if (
    !isRecord(value)
    || !exactKeys(value, ["device", "inode"])
    || typeof value.device !== "string"
    || !/^\d{1,40}$/u.test(value.device)
    || typeof value.inode !== "string"
    || !/^\d{1,40}$/u.test(value.inode)
  ) throw new Error("expected derivation directory identity is invalid");
  return { device: value.device, inode: value.inode };
}

function parseBrowserIdentity(value: unknown): BrowserIdentity {
  if (
    !isRecord(value)
    || !exactKeys(value, ["engine", "launchHash"])
    || value.engine !== "chrome"
    || typeof value.launchHash !== "string"
    || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.launchHash)
    || BigInt(value.launchHash) > maximumU64
  ) throw new Error("pinned derivation browser identity is invalid");
  return { engine: "chrome", launchHash: value.launchHash };
}

function parseDaemonOwner(value: unknown): ProcessOwnerIdentity {
  if (
    !isRecord(value)
    || !exactKeys(value, ["bootId", "pid", "processStartId"])
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.bootId !== "string"
    || value.bootId.length < 1
    || value.bootId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value.bootId)
    || typeof value.processStartId !== "string"
    || value.processStartId.length < 1
    || value.processStartId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value.processStartId)
  ) throw new Error("pinned derivation daemon owner is invalid");
  return {
    pid: value.pid as number,
    bootId: value.bootId,
    processStartId: value.processStartId,
  };
}

function parseBrowserPin(value: unknown): BrowserPin {
  if (
    !isRecord(value)
    || !exactKeys(value, ["browserIdentity", "cdpUrl", "confirmationAction", "daemonOwner", "sessionName"])
    || typeof value.sessionName !== "string"
    || !/^io-derive-pin-[0-9a-f]{12}$/u.test(value.sessionName)
    || typeof value.cdpUrl !== "string"
    || value.cdpUrl.length > 4_096
  ) throw new Error("pinned derivation browser descriptor is invalid");
  let cdpUrl: URL;
  try {
    cdpUrl = new URL(value.cdpUrl);
  } catch {
    throw new Error("pinned derivation browser descriptor is invalid");
  }
  if (
    cdpUrl.protocol !== "ws:"
    || (cdpUrl.hostname !== "127.0.0.1" && cdpUrl.hostname !== "[::1]" && cdpUrl.hostname !== "localhost")
    || cdpUrl.port === ""
    || cdpUrl.username !== ""
    || cdpUrl.password !== ""
    || cdpUrl.search !== ""
    || cdpUrl.hash !== ""
    || !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/u.test(cdpUrl.pathname)
  ) throw new Error("pinned derivation browser descriptor is invalid");
  return {
    sessionName: value.sessionName,
    cdpUrl: cdpUrl.href,
    browserIdentity: value.browserIdentity === null ? null : parseBrowserIdentity(value.browserIdentity),
    confirmationAction: value.confirmationAction === null
      ? null
      : typeof value.confirmationAction === "string"
          && derivationConfirmedPolicyActions.includes(
            value.confirmationAction as (typeof derivationConfirmedPolicyActions)[number],
          )
        ? value.confirmationAction
        : (() => { throw new Error("pinned derivation confirmation action is invalid"); })(),
    daemonOwner: value.daemonOwner === null ? null : parseDaemonOwner(value.daemonOwner),
  };
}

function pinnedBrowserStdin(kind: CodeOwnedBrowserRequest): string | null {
  if (kind === "none") return null;
  if (kind === "initial-contained-launch") return JSON.stringify([["open", "about:blank"]]);
  if (kind === "readiness-context") return JSON.stringify([["get", "cdp-url"], ["get", "url"]]);
  if (kind === "pin-context") return JSON.stringify([["get", "cdp-url"], ["get", "url"]]);
  return null;
}

function parsePinnedCommands(value: string | null): readonly (readonly string[])[] {
  if (value === null) throw new Error("pinned derivation browser commands are invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("pinned derivation browser commands are invalid");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 500
    || parsed.some((command) => (
      !Array.isArray(command)
      || command.length < 1
      || command.length > 100
      || command.some((argument) => typeof argument !== "string")
    ))
  ) throw new Error("pinned derivation browser commands are invalid");
  return parsed as readonly (readonly string[])[];
}

function parseRequest(value: unknown): Request {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "requestId",
      "expectedDirectory",
      "socketDirectory",
      "expectedSocketDirectory",
      "ownerSessionName",
      "allowRemoteActions",
      "allowFixtureUpload",
      "guardedBrowserConfig",
      "codeOwnedBrowserRequest",
      "browserPin",
      "timeoutMs",
      "maxOutputBytes",
      "arguments",
      "browserStdin",
    ])
    || value.schemaVersion !== 1
    || typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.requestId)
    || typeof value.socketDirectory !== "string"
    || !isAbsolute(value.socketDirectory)
    || value.socketDirectory.length > 4_096
    || value.socketDirectory.includes("\u0000")
    || typeof value.ownerSessionName !== "string"
    || !/^io-derive-[a-f0-9]{12}$/u.test(value.ownerSessionName)
    || typeof value.allowRemoteActions !== "boolean"
    || typeof value.allowFixtureUpload !== "boolean"
    || typeof value.guardedBrowserConfig !== "boolean"
    || (value.allowFixtureUpload && !value.allowRemoteActions)
    || !["none", "initial-contained-launch", "readiness-context", "pin-context", "pinned-batch", "pinned-confirm", "profile-confirm"].includes(
      typeof value.codeOwnedBrowserRequest === "string" ? value.codeOwnedBrowserRequest : "",
    )
    || typeof value.timeoutMs !== "number"
    || !Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < 1
    || value.timeoutMs > 120_000
    || typeof value.maxOutputBytes !== "number"
    || !Number.isSafeInteger(value.maxOutputBytes)
    || value.maxOutputBytes < 1
    || value.maxOutputBytes > 10 * 1024 * 1024
    || !Array.isArray(value.arguments)
    || value.arguments.length < 1
    || value.arguments.length > 200
    || value.arguments.some((argument) => (
      typeof argument !== "string"
      || argument.length > 64 * 1024
      || argument.includes("\u0000")
      || argument === "--config"
      || argument.startsWith("--config=")
      || argument === "--action-policy"
      || argument.startsWith("--action-policy=")
    ))
    || (value.browserStdin !== null && (typeof value.browserStdin !== "string" || Buffer.byteLength(value.browserStdin, "utf8") > 5 * 1024 * 1024))
    || (
      value.codeOwnedBrowserRequest !== "none"
      && value.codeOwnedBrowserRequest !== "pinned-confirm"
      && value.codeOwnedBrowserRequest !== "profile-confirm"
      && (
        (
          value.codeOwnedBrowserRequest !== "pinned-batch"
          && value.browserStdin !== pinnedBrowserStdin(value.codeOwnedBrowserRequest as CodeOwnedBrowserRequest)
        )
        || value.arguments.length < 3
        || value.arguments.at(-3) !== "batch"
        || value.arguments.at(-2) !== "--bail"
        || value.arguments.at(-1) !== "--json"
      )
    )
  ) throw new Error("derivation command request is invalid");
  const codeOwnedBrowserRequest = value.codeOwnedBrowserRequest as CodeOwnedBrowserRequest;
  const browserPin = value.browserPin === null ? null : parseBrowserPin(value.browserPin);
  if (
    (codeOwnedBrowserRequest === "initial-contained-launch" && value.guardedBrowserConfig)
    || (["readiness-context", "pin-context", "pinned-batch", "pinned-confirm"].includes(codeOwnedBrowserRequest) && !value.guardedBrowserConfig)
    || (codeOwnedBrowserRequest === "profile-confirm" && value.guardedBrowserConfig)
    || (
      codeOwnedBrowserRequest === "readiness-context"
      && JSON.stringify(value.arguments) !== JSON.stringify([
        "--session",
        value.ownerSessionName,
        "--content-boundaries",
        "--max-output",
        String(5 * 1024 * 1024),
        "batch",
        "--bail",
        "--json",
      ])
    )
    || (["pin-context", "pinned-batch", "pinned-confirm"].includes(codeOwnedBrowserRequest)) !== (browserPin !== null)
    || (
      browserPin !== null
      && browserPin.sessionName !== value.ownerSessionName.replace(
        /^io-derive-/u,
        "io-derive-pin-",
      )
    )
    || (codeOwnedBrowserRequest === "pin-context" && (browserPin === null || browserPin.browserIdentity !== null || browserPin.confirmationAction !== null || browserPin.daemonOwner !== null))
    || (codeOwnedBrowserRequest === "pinned-batch" && (browserPin === null || browserPin.browserIdentity === null || browserPin.confirmationAction !== null || browserPin.daemonOwner !== null))
    || (codeOwnedBrowserRequest === "pinned-batch" && value.browserStdin === null)
    || (codeOwnedBrowserRequest === "pinned-batch" && parsePinnedCommands(value.browserStdin).length !== 1)
    || (codeOwnedBrowserRequest === "pinned-confirm" && (browserPin === null || browserPin.browserIdentity === null || browserPin.confirmationAction === null || browserPin.daemonOwner === null))
    || (
      codeOwnedBrowserRequest === "profile-confirm"
      && (
        browserPin !== null
        || !value.allowRemoteActions
        || value.browserStdin !== null
        || value.arguments.length !== 3
        || value.arguments[0] !== "confirm"
        || typeof value.arguments[1] !== "string"
        || !/^r\d{1,6}$/u.test(value.arguments[1])
        || value.arguments[2] !== "--json"
      )
    )
    || (
      codeOwnedBrowserRequest === "pinned-confirm"
      && (
        value.browserStdin !== null
        || value.arguments.length !== 3
        || value.arguments[0] !== "confirm"
        || typeof value.arguments[1] !== "string"
        || !/^r\d{1,6}$/u.test(value.arguments[1])
        || value.arguments[2] !== "--json"
      )
    )
    || (
      browserPin !== null
      && codeOwnedBrowserRequest !== "pinned-confirm"
      && (
        value.arguments.length !== 3
        || value.arguments[0] !== "batch"
        || value.arguments[1] !== "--bail"
        || value.arguments[2] !== "--json"
      )
    )
  ) throw new Error("derivation command request is invalid");
  return {
    schemaVersion: 1,
    requestId: value.requestId,
    expectedDirectory: parseIdentity(value.expectedDirectory),
    socketDirectory: value.socketDirectory,
    expectedSocketDirectory: parseIdentity(value.expectedSocketDirectory),
    ownerSessionName: value.ownerSessionName,
    allowRemoteActions: value.allowRemoteActions,
    allowFixtureUpload: value.allowFixtureUpload,
    guardedBrowserConfig: value.guardedBrowserConfig,
    codeOwnedBrowserRequest,
    browserPin,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes,
    arguments: value.arguments.map((argument) => String(argument)),
    browserStdin: value.browserStdin,
  };
}

function pinnedLifecycle(
  value: unknown,
  expected: BrowserIdentity | null,
): BrowserIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "effectiveLaunch",
    "launched",
    "relaunchedBrowser",
    "restartedBackground",
    "restoreStatus",
    "reused",
    "saveStatus",
  ])) throw new Error("pinned derivation browser lifecycle changed shape");
  const effectiveLaunch = value.effectiveLaunch;
  if (
    !isRecord(effectiveLaunch)
    || !exactKeys(effectiveLaunch, ["browserLaunched", "engine", "launchHash"])
  ) throw new Error("pinned derivation browser lifecycle changed shape");
  const identity = parseBrowserIdentity({
    engine: effectiveLaunch.engine,
    launchHash: effectiveLaunch.launchHash,
  });
  if (
    effectiveLaunch.browserLaunched !== true
    || value.launched !== false
    || value.relaunchedBrowser !== false
    || value.restartedBackground !== false
    || value.restoreStatus !== "not_configured"
    || typeof value.reused !== "boolean"
    || value.saveStatus !== "not_attempted"
    || (
      expected !== null
      && (identity.engine !== expected.engine || identity.launchHash !== expected.launchHash)
    )
  ) throw new Error("pinned derivation browser lifecycle changed identity or was relaunched");
  return identity;
}

export function validatePinnedDerivationBrowserOutput(
  value: unknown,
  commands: readonly (readonly string[])[],
  pin: BrowserPin,
): BrowserIdentity {
  if (!Array.isArray(value) || value.length !== commands.length) {
    throw new Error("pinned derivation browser result changed shape");
  }
  let observed: BrowserIdentity | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const command = commands[index];
    if (
      !isRecord(entry)
      || !exactKeys(entry, ["command", "error", "result", "success"])
      || JSON.stringify(entry.command) !== JSON.stringify(command)
      || entry.success !== true
      || entry.error !== null
      || !isRecord(entry.result)
      || !("lifecycle" in entry.result)
    ) throw new Error("pinned derivation browser result changed shape");
    const identity = pinnedLifecycle(entry.result.lifecycle, pin.browserIdentity);
    if (
      observed !== null
      && (observed.engine !== identity.engine || observed.launchHash !== identity.launchHash)
    ) throw new Error("pinned derivation browser lifecycle changed within its batch");
    observed = identity;
    if (
      command?.length === 2
      && command[0] === "get"
      && command[1] === "cdp-url"
      && entry.result.cdpUrl !== pin.cdpUrl
    ) throw new Error("pinned derivation browser returned a different private CDP URL");
  }
  if (observed === null) throw new Error("pinned derivation browser result changed shape");
  return observed;
}

export type PinnedDerivationConfirmation = {
  readonly action: string;
  readonly confirmationId: string;
};

export function parsePinnedDerivationConfirmation(
  value: unknown,
  command: readonly string[],
): PinnedDerivationConfirmation | null {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("pinned derivation browser result changed shape");
  }
  const entry = value[0];
  if (
    !isRecord(entry)
    || !exactKeys(entry, ["command", "error", "result", "success"])
    || JSON.stringify(entry.command) !== JSON.stringify(command)
    || entry.success !== true
    || entry.error !== null
    || !isRecord(entry.result)
  ) throw new Error("pinned derivation browser result changed shape");
  if ("lifecycle" in entry.result) return null;
  if (
    !exactKeys(entry.result, ["action", "confirmation_id", "confirmation_required"])
    || entry.result.confirmation_required !== true
    || typeof entry.result.confirmation_id !== "string"
    || !/^r\d{1,6}$/u.test(entry.result.confirmation_id)
    || typeof entry.result.action !== "string"
    || !derivationConfirmedPolicyActions.includes(
      entry.result.action as (typeof derivationConfirmedPolicyActions)[number],
    )
  ) throw new Error("pinned derivation browser confirmation changed shape");
  return {
    action: entry.result.action,
    confirmationId: entry.result.confirmation_id,
  };
}

export function parsePinnedDerivationConfirmationResult(
  value: unknown,
  confirmation: PinnedDerivationConfirmation,
  pin: BrowserPin & {
    readonly browserIdentity: BrowserIdentity;
    readonly daemonOwner: ProcessOwnerIdentity;
  },
): Record<string, unknown> {
  if (
    !isRecord(value)
    || !exactKeys(value, ["_boundary", "data", "error", "success"])
    || value.success !== true
    || value.error !== null
    || !isRecord(value._boundary)
    || !exactKeys(value._boundary, ["nonce", "origin"])
    || typeof value._boundary.nonce !== "string"
    || !/^[a-f0-9]{32}$/u.test(value._boundary.nonce)
    || value._boundary.origin !== "unknown"
    || !isRecord(value.data)
    || !exactKeys(value.data, ["action", "confirmed", "lifecycle", "result"])
    || value.data.confirmed !== true
    || value.data.action !== confirmation.action
    || !isRecord(value.data.result)
    || !exactKeys(value.data.result, ["data", "id", "success"])
    || value.data.result.id !== confirmation.confirmationId
    || value.data.result.success !== true
    || !isRecord(value.data.result.data)
  ) throw new Error("pinned derivation browser confirmation result changed shape");
  const confirmedData = value.data.result.data;
  if (
    !("lifecycle" in confirmedData)
    || ["confirmation_required", "confirmation_id", "confirmed", "denied"].some(
      (key) => key in confirmedData,
    )
  ) throw new Error("pinned derivation browser confirmation result changed shape");
  pinnedLifecycle(value.data.lifecycle, pin.browserIdentity);
  pinnedLifecycle(confirmedData.lifecycle, pin.browserIdentity);
  return confirmedData;
}

function readBoundedStdin(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_REQUEST_BYTES) throw new Error("derivation command request exceeds its byte bound");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
}

function assertBoundDirectory(expected: Identity): void {
  const descriptor = openSync(
    ".",
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
  );
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stats.uid;
    if (
      !stats.isDirectory()
      || stats.uid !== currentUid
      || (stats.mode & 0o777n) !== 0o700n
      || stats.dev.toString() !== expected.device
      || stats.ino.toString() !== expected.inode
    ) throw new Error("bound derivation directory no longer matches its private identity");
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateDirectoryPath(path: string, expected: Identity): void {
  const stats = lstatSync(path, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stats.uid;
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== currentUid
    || (stats.mode & 0o777n) !== 0o700n
    || stats.dev.toString() !== expected.device
    || stats.ino.toString() !== expected.inode
  ) throw new Error("derivation socket directory no longer matches its private identity");
}

function assertPrivateFile(path: string, expected: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stats.uid;
    const expectedBytes = Buffer.from(expected, "utf8");
    if (
      !stats.isFile()
      || stats.uid !== currentUid
      || (stats.mode & 0o777n) !== 0o600n
      || stats.size !== BigInt(expectedBytes.byteLength)
    ) throw new Error(`bound derivation ${path} is unavailable or unsafe`);
    const actual = Buffer.alloc(expectedBytes.byteLength);
    let offset = 0;
    while (offset < actual.byteLength) {
      const count = readSync(descriptor, actual, offset, actual.byteLength - offset, null);
      if (count === 0) throw new Error(`bound derivation ${path} changed while reading`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== stats.dev
      || after.ino !== stats.ino
      || after.size !== stats.size
      || after.mtimeNs !== stats.mtimeNs
      || after.ctimeNs !== stats.ctimeNs
      || !actual.equals(expectedBytes)
    ) throw new Error(`bound derivation ${path} changed or is invalid`);
  } finally {
    closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const request = parseRequest(JSON.parse(readBoundedStdin()) as unknown);
  process.umask(0o077);
  assertBoundDirectory(request.expectedDirectory);
  const config = "agent-browser.json";
  const policy = "action-policy.json";
  assertPrivateFile(
    config,
    `${JSON.stringify(derivationBrowserConfig(request.guardedBrowserConfig))}\n`,
  );
  assertPrivateFile(
    policy,
    `${JSON.stringify(derivationActionPolicy(
      request.allowRemoteActions,
      request.allowFixtureUpload,
    ))}\n`,
  );
  assertBoundDirectory(request.expectedDirectory);
  assertPrivateDirectoryPath(request.socketDirectory, request.expectedSocketDirectory);
  const arguments_ = request.codeOwnedBrowserRequest === "profile-confirm"
    ? [
        "--session",
        request.ownerSessionName,
        "--content-boundaries",
        "--max-output",
        String(5 * 1024 * 1024),
        ...request.arguments,
      ]
    : request.browserPin === null
    ? request.arguments
    : request.codeOwnedBrowserRequest === "pinned-confirm"
      ? [
          "--session",
          request.browserPin.sessionName,
          "--content-boundaries",
          "--max-output",
          String(5 * 1024 * 1024),
          ...request.arguments,
        ]
    : [
        "--session",
        request.browserPin.sessionName,
        "--cdp",
        request.browserPin.cdpUrl,
        "--content-boundaries",
        "--max-output",
        String(5 * 1024 * 1024),
        ...request.arguments,
      ];
  if (
    request.codeOwnedBrowserRequest === "pinned-confirm"
    && processOwnerStatus(request.browserPin?.daemonOwner as ProcessOwnerIdentity) !== "exact-live-owner"
  ) throw new Error("pinned derivation daemon changed before confirmation");
  const result = await runCommand(
    [...agentBrowserCommand(), "--config", config, "--action-policy", policy, ...arguments_],
    {
      cwd: ".",
      environment: isolatedEnvironment(request.socketDirectory),
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      ...(request.browserStdin === null ? {} : { stdin: request.browserStdin }),
    },
  );
  if (
    request.codeOwnedBrowserRequest === "pinned-confirm"
    && processOwnerStatus(request.browserPin?.daemonOwner as ProcessOwnerIdentity) !== "exact-live-owner"
  ) throw new Error("pinned derivation daemon changed during confirmation");
  if (request.browserPin !== null && result.exitCode === 0) {
    const parsed = parseLastJsonWithExactLaunchHashes(result.stdout);
    if (request.codeOwnedBrowserRequest === "pinned-confirm") {
      parsePinnedDerivationConfirmationResult(
        parsed,
        {
          action: request.browserPin.confirmationAction as string,
          confirmationId: request.arguments[1] as string,
        },
        request.browserPin as BrowserPin & {
          readonly browserIdentity: BrowserIdentity;
          readonly daemonOwner: ProcessOwnerIdentity;
        },
      );
    } else {
      const commands = parsePinnedCommands(request.browserStdin);
      if (
        request.codeOwnedBrowserRequest !== "pinned-batch"
        || parsePinnedDerivationConfirmation(parsed, commands[0] ?? []) === null
      ) validatePinnedDerivationBrowserOutput(parsed, commands, request.browserPin);
    }
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`derivation command helper: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  });
}
