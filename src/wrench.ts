#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";
import {
  clipMain,
  inspectClipEnvironment,
  parseCaptureArguments,
  renderDoctorReport,
  type ClipRuntimeOptions,
} from "@hraness/kb/capture";
import { redactSensitiveText } from "@hraness/kb/clip/persist";
import { sanitizeTerminalLine, sanitizeTerminalText } from "@hraness/kb/clip/terminal";
import {
  createAuth,
  listAuth,
  loadAuth,
  loadAuthSnapshot,
  removeAuth,
  replaceAuthIfUnchanged,
  saveAuth,
  type WrenchAuth,
} from "./auth";
import {
  isPublicWebSessionInvocationAuthority,
  type InvocationAuthority,
} from "./web-session-authentication-policy";
import { parseWrenchArguments, wrenchUsage, type WrenchArguments } from "./args";
import type * as BeeperMessageLikeMeCliRuntimeModule from "./beeper-message-like-me-cli";
import type { BeeperMessageLikeMeProgress } from "./beeper-message-like-me-source";
import type { GmailCaptureRunner } from "./gmail-capture";
import type * as MediaRuntimeModule from "./media";
import {
  cloneBrowserProfile,
  PreservedBrowserArtifactsError,
  profilePath,
} from "./browser";
import { runCaptureWithBrowserAdmission } from "./browser-admission";
import {
  createBrowserSnapshotDirectory,
  purgeOrphanedBrowserSnapshots,
  removeBrowserSnapshotDirectory,
} from "./browser-snapshots";
import {
  runCapabilities,
  runPluginList,
  runPluginShow,
} from "./catalog-cli";
import {
  discardDerivation,
  finishDerivation,
  listDerivations,
  reviewDerivation,
  runDerivationBrowserCommand,
  startDerivation,
} from "./derive";
import {
  parseDerivationReviewFixtures,
  type DerivationReviewFixtures,
  type DerivationReviewSelection,
} from "./derive-review";
import { derivationFixtureSummaries } from "./derive-fixtures";
import { analyzeHarFile, emptyManifest, writeDerivationScaffold } from "./har";
import {
  canonicalJson,
  DOM_ACTION_TRANSPORT_DISABLED_MESSAGE,
  isProviderOperation,
  isReviewedTemplateOperation,
  isWebSessionOperation,
  manifestHash,
  sha256,
  WRENCH_LEGACY_LINKEDIN_MANIFEST_HASH,
  type OperationInput,
  type WrenchOperation,
} from "./model";
import { getProviderContract, providerContractHash } from "./provider-contracts";
import {
  portableProviderPluginSubjectProbeIdentity,
  type LinkedDevicePluginBindingV1,
  type ProviderPluginBindingV1,
  type ProviderPluginLinkedDeviceAttemptBoundaryV1,
} from "./provider-plugin";
import {
  LEGACY_PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
  PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
} from "./provider-plugin-package";
import {
  acquirePortableProviderPluginInvocationLease,
  createPortableProviderPluginInvocationLeaseContainmentController,
  releasePortableProviderPluginInvocationLease,
} from "./provider-plugin-invocation-lease";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import { acquireReadProjectionAuthAdmission } from "./read-projection-admission";
import {
  recoverLinkedDeviceLifecycleAdmissions,
} from "./linked-device-lifecycle-admission";
import {
  readLinkedDeviceLifecycleJournal,
} from "./linked-device-lifecycle-journal";
import {
  LinkedDeviceLifecycleIndeterminateError,
  reconcileLinkedDeviceLifecycleJournal,
  recoverLinkedDeviceLifecycleJournals,
  runLinkedDevicePairLifecycle,
  runLinkedDeviceSyncOnceLifecycle,
} from "./linked-device-lifecycle-runtime";
import {
  checkPortableProviderPlugin,
  disablePortableProviderPlugin,
  doctorPortableProviderPlugins,
  initPortableProviderPlugin,
  installPortableProviderPlugin,
  packPortableProviderPlugin,
  portableProviderPluginStoreRoot,
  removePortableProviderPlugin,
  showPortableProviderPlugin,
  testPortableProviderPlugin,
} from "./provider-plugin-lifecycle";
import {
  assertPortableProviderPluginActivatable,
  assertPortableProviderPluginQuiescent,
} from "./provider-plugin-lifecycle-kernel";
import { createPortableProviderPluginCatalog } from "./provider-plugin-portable-catalog";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { withPortableProviderPluginCatalogLock } from "./provider-plugin-store";
import { providerPluginRegistry } from "./provider-plugins";
import { reconcilePortableProviderPluginRun } from "./portable-run-recovery";
import { getWebSessionContract, webSessionContractHash } from "./web-session-contracts";
import { isCookieCapableWebAuth, reviewedTemplateHash } from "./reviewed-template";
import {
  recoverWebSessionCleanupAdmissions,
} from "./web-session-cleanup-admission";
import {
  WEB_SESSION_CLEANUP_JOIN_TIMEOUT_MS,
} from "./web-session-execution";
import { reconcileWebSessionRun } from "./web-session-recovery";
import { loadOAuthToken, requireOAuthScopes } from "./provider-http";
import {
  installManagedGoogleOAuth,
  loginGoogleOAuth,
} from "./oauth-google";
import {
  compositionNames,
  platformSurfaceIds,
  semanticOperationNames,
  socialPlatformCatalog,
  splitWeightedThread,
  textWeightPolicies,
  weightedTextLength,
  type PlatformSurfaceCatalogEntry,
  type PlatformSurfaceId,
} from "./platform-catalog";
import { isPlanBoundFile, summarizePlanFile } from "./plan-assets";
import {
  cancelInvocationPlan,
  confirmInvocation,
  createAndSaveInvocationPlan,
  createReadProjectionQueryForInvocation,
  type createInvocationPlan,
  type executeReadInvocation,
  listInvocationPlans,
  listRunReceipts,
  prepareInvocation,
  purgeExpiredPlans,
  readRunReceipt,
  repairInterruptedConfirmationClaims,
  repairInterruptedRunJournals,
} from "./runtime";
import {
  readCachedPreparedCapability,
  revalidatePreparedCapability,
  type RevalidatedCapability,
} from "./read-client";
import type { ReadProjectionCacheResult } from "./read-projections";
import {
  identifyOmniView,
  readCachedOmniViewInternal,
  rebuildOmniViewFromExactCache,
  revalidateOmniViewInternal,
} from "./omni-runtime";
import {
  checkSourceProviderPluginDirectory,
  scaffoldWebProvider,
} from "./scripts/scaffold-web-provider";
import {
  createPrivateJsonIfAbsent,
  installManifest,
  listInstalledManifests,
  loadInstalledDiagnosticManifestSnapshot,
  readDiagnosticManifestFile,
  readManifestFile,
  readRegularFile,
  removeInstalledManifest,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  writePrivateJson,
} from "./storage";

type Output = {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

type MediaRuntime = typeof MediaRuntimeModule;
type BeeperMessageLikeMeCliRuntime = typeof BeeperMessageLikeMeCliRuntimeModule;

/**
 * Wrench's stable boundary around the independently versioned KB doctor.
 *
 * The default adapter preserves the complete KB report for JSON output while
 * keeping its concrete schema and terminal renderer out of Wrench's dependency
 * and test contracts.
 */
export type WrenchClipEnvironmentInspection = {
  readonly report: unknown;
  readonly renderReport: () => string;
  readonly browserCaptureBootstrapReady: boolean;
};

const defaultOutput: Output = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const loadMediaRuntime = (): Promise<MediaRuntime> => import("./media");
const loadBeeperMessageLikeMeCliRuntime = (): Promise<BeeperMessageLikeMeCliRuntime> =>
  import("./beeper-message-like-me-cli");

const runDefaultGmailCapture: GmailCaptureRunner = async (...arguments_) => {
  const { runGmailCapture } = await import("./gmail-capture");
  return runGmailCapture(...arguments_);
};

const inspectDefaultClipEnvironment = async (): Promise<WrenchClipEnvironmentInspection> => {
  const report = await inspectClipEnvironment();
  return {
    report,
    renderReport: () => renderDoctorReport(report),
    browserCaptureBootstrapReady: report.deriveClient.status === "ready"
      && report.dependencies.find(
        (dependency) => dependency.name === "agent-browser",
      )?.status === "ready"
      && report.dependencies.find(
        (dependency) => dependency.name === "@steipete/sweet-cookie",
      )?.status === "ready",
  };
};

export function renderWrenchUsage(): string {
  return wrenchUsage;
}

export type WrenchDependencies = {
  readonly clipMain: typeof clipMain;
  readonly runCapture: typeof runCaptureWithBrowserAdmission;
  readonly gmailCaptureMain: GmailCaptureRunner;
  readonly inspectClipEnvironment: () => Promise<WrenchClipEnvironmentInspection>;
  readonly loadMediaRuntime: () => Promise<MediaRuntime>;
  readonly loadBeeperMessageLikeMeCliRuntime:
    () => Promise<BeeperMessageLikeMeCliRuntime>;
  readonly providerPluginRegistry: ProviderPluginRegistry;
  readonly probePluginSubject: (
    binding: ProviderPluginBindingV1,
    auth: WrenchAuth,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Test seam after subject validation and before the auth snapshot CAS. */
  readonly beforeAuthBindCommit: () => void | Promise<void>;
  readonly pairLinkedDeviceAuth: (
    binding: LinkedDevicePluginBindingV1,
    auth: WrenchAuth,
    options: {
      readonly phone?: string;
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    },
  ) => Promise<string>;
  readonly syncLinkedDeviceAuthOnce: (
    binding: LinkedDevicePluginBindingV1,
    auth: WrenchAuth,
    options: {
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    },
  ) => Promise<{
    readonly itemsStored: number;
    readonly projection: string;
    readonly emitsProtocolAcknowledgements: boolean;
  }>;
  readonly reconcileWebSessionRun: typeof reconcileWebSessionRun;
  readonly reconcileLinkedDeviceLifecycleJournal:
    typeof reconcileLinkedDeviceLifecycleJournal;
  readonly reconcilePortableProviderPluginRun:
    typeof reconcilePortableProviderPluginRun;
  readonly createPortableProviderPluginCatalog:
    typeof createPortableProviderPluginCatalog;
  readonly readCachedPreparedCapability:
    typeof readCachedPreparedCapability;
  readonly revalidatePreparedCapability:
    typeof revalidatePreparedCapability;
  readonly identifyOmniView: typeof identifyOmniView;
  readonly readCachedOmniViewInternal: typeof readCachedOmniViewInternal;
  readonly rebuildOmniViewFromExactCache: typeof rebuildOmniViewFromExactCache;
  readonly revalidateOmniViewInternal: typeof revalidateOmniViewInternal;
};

const defaultDependencies: WrenchDependencies = {
  clipMain,
  runCapture: runCaptureWithBrowserAdmission,
  gmailCaptureMain: runDefaultGmailCapture,
  inspectClipEnvironment: inspectDefaultClipEnvironment,
  loadMediaRuntime,
  loadBeeperMessageLikeMeCliRuntime,
  providerPluginRegistry,
  probePluginSubject: async (binding, auth, signal) => {
    requireProviderPluginAuth(binding, auth);
    const probe = binding.subject.probe;
    if (probe === undefined) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} has no current-account probe`,
      );
    }
    const subject = await probe(
      auth,
      signal === undefined ? undefined : { signal },
    );
    if (!binding.subject.matches(subject)) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} returned a subject outside ${binding.subject.format}`,
      );
    }
    return subject;
  },
  beforeAuthBindCommit: () => undefined,
  pairLinkedDeviceAuth: async (binding, auth, options) => {
    const lifecycle = binding.linkedDeviceLifecycle;
    if (lifecycle === undefined) {
      throw new Error(
        `linked-device plugin surface ${binding.surfaceId} does not declare pairing`,
      );
    }
    return lifecycle.pair(auth, options);
  },
  syncLinkedDeviceAuthOnce: async (binding, auth, options) => {
    const lifecycle = binding.linkedDeviceLifecycle;
    if (lifecycle === undefined) {
      throw new Error(
        `linked-device plugin surface ${binding.surfaceId} does not declare one-shot sync`,
      );
    }
    return lifecycle.syncOnce(auth, options);
  },
  reconcileWebSessionRun,
  reconcileLinkedDeviceLifecycleJournal,
  reconcilePortableProviderPluginRun,
  createPortableProviderPluginCatalog,
  readCachedPreparedCapability,
  revalidatePreparedCapability,
  identifyOmniView,
  readCachedOmniViewInternal,
  rebuildOmniViewFromExactCache,
  revalidateOmniViewInternal,
};

function resolveDependencies(overrides: Partial<WrenchDependencies>): WrenchDependencies {
  return {
    clipMain: overrides.clipMain ?? defaultDependencies.clipMain,
    runCapture: overrides.runCapture ?? defaultDependencies.runCapture,
    gmailCaptureMain:
      overrides.gmailCaptureMain ?? defaultDependencies.gmailCaptureMain,
    inspectClipEnvironment: overrides.inspectClipEnvironment ?? defaultDependencies.inspectClipEnvironment,
    loadMediaRuntime: overrides.loadMediaRuntime ?? defaultDependencies.loadMediaRuntime,
    loadBeeperMessageLikeMeCliRuntime:
      overrides.loadBeeperMessageLikeMeCliRuntime
      ?? defaultDependencies.loadBeeperMessageLikeMeCliRuntime,
    providerPluginRegistry: overrides.providerPluginRegistry
      ?? defaultDependencies.providerPluginRegistry,
    probePluginSubject: overrides.probePluginSubject
      ?? defaultDependencies.probePluginSubject,
    beforeAuthBindCommit: overrides.beforeAuthBindCommit
      ?? defaultDependencies.beforeAuthBindCommit,
    pairLinkedDeviceAuth: overrides.pairLinkedDeviceAuth
      ?? defaultDependencies.pairLinkedDeviceAuth,
    syncLinkedDeviceAuthOnce: overrides.syncLinkedDeviceAuthOnce
      ?? defaultDependencies.syncLinkedDeviceAuthOnce,
    reconcileWebSessionRun: overrides.reconcileWebSessionRun ?? defaultDependencies.reconcileWebSessionRun,
    reconcileLinkedDeviceLifecycleJournal:
      overrides.reconcileLinkedDeviceLifecycleJournal
      ?? defaultDependencies.reconcileLinkedDeviceLifecycleJournal,
    reconcilePortableProviderPluginRun:
      overrides.reconcilePortableProviderPluginRun
      ?? defaultDependencies.reconcilePortableProviderPluginRun,
    createPortableProviderPluginCatalog:
      overrides.createPortableProviderPluginCatalog
      ?? defaultDependencies.createPortableProviderPluginCatalog,
    readCachedPreparedCapability:
      overrides.readCachedPreparedCapability
      ?? defaultDependencies.readCachedPreparedCapability,
    revalidatePreparedCapability:
      overrides.revalidatePreparedCapability
      ?? defaultDependencies.revalidatePreparedCapability,
    identifyOmniView:
      overrides.identifyOmniView ?? defaultDependencies.identifyOmniView,
    readCachedOmniViewInternal:
      overrides.readCachedOmniViewInternal
      ?? defaultDependencies.readCachedOmniViewInternal,
    rebuildOmniViewFromExactCache:
      overrides.rebuildOmniViewFromExactCache
      ?? defaultDependencies.rebuildOmniViewFromExactCache,
    revalidateOmniViewInternal:
      overrides.revalidateOmniViewInternal
      ?? defaultDependencies.revalidateOmniViewInternal,
  };
}

function safe(value: string): string {
  return sanitizeTerminalLine(redactSensitiveText(value));
}

function safeJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "string" ? sanitizeTerminalText(redactSensitiveText(candidate)) : candidate, 2)}\n`;
}

const MAX_CLI_RECOVERY_HANDLE_BYTES = 8 * 1024;

function boundedCliRecoveryHandle(value: string): string | null {
  if (
    value.length < 1
    || Buffer.byteLength(value, "utf8") > MAX_CLI_RECOVERY_HANDLE_BYTES
  ) return null;
  return /^[A-Za-z0-9_./:;=+-]+$/u.test(value) ? value : null;
}

function exactTerminalJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  // JSON escapes preserve the exact value when the document is parsed,
  // while keeping terminal-control and bidi characters inert on screen.
  return `${json.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

function print(output: Output, value: unknown, json: boolean): void {
  output.stdout(json ? safeJson(value) : `${safe(typeof value === "string" ? value : JSON.stringify(value, null, 2))}\n`);
}

function beeperProgressInteger(value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error("Beeper export progress was invalid");
  }
  return value;
}

function beeperProgressPosition(
  progress: Readonly<{ account: number; accounts: number }>,
): string {
  const account = beeperProgressInteger(progress.account, 1);
  const accounts = beeperProgressInteger(progress.accounts, 1);
  if (account > accounts) throw new Error("Beeper export progress was invalid");
  return `${account}/${accounts}`;
}

function plural(count: number, singular: string, plural_: string): string {
  return count === 1 ? singular : plural_;
}

function renderBeeperMessageLikeMeProgress(
  progress: BeeperMessageLikeMeProgress,
): string {
  if (progress.phase === "recovery-started") {
    return "wrench: Beeper export: checking prior private export state\n";
  }
  if (progress.phase === "recovery-completed") {
    const recovered = beeperProgressInteger(progress.recovered, 0);
    const published = beeperProgressInteger(progress.published, 0);
    return `wrench: Beeper export: private recovery complete; ${recovered} ${plural(recovered, "directory", "directories")} reclaimed, ${published} published ${plural(published, "bundle", "bundles")} preserved\n`;
  }
  if (progress.phase === "preparing") {
    return "wrench: Beeper export: preparing pinned official CLI\n";
  }
  if (progress.phase === "accounts-discovered") {
    const accounts = beeperProgressInteger(progress.accounts, 1);
    return `wrench: Beeper export: ${accounts} ${plural(accounts, "account", "accounts")} discovered\n`;
  }
  if (progress.phase === "accounts-progress") {
    if (progress.stage !== "discovering" && progress.stage !== "verifying") {
      throw new Error("Beeper export progress was invalid");
    }
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    const action = progress.stage === "discovering"
      ? "discovering accounts"
      : "verifying connected accounts";
    return `wrench: Beeper export: ${action}; ${elapsedSeconds}s elapsed\n`;
  }
  if (progress.phase === "account-started") {
    return `wrench: Beeper export: account ${beeperProgressPosition(progress)} started\n`;
  }
  if (progress.phase === "account-validating") {
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    return `wrench: Beeper export: account ${beeperProgressPosition(progress)} validating; ${elapsedSeconds}s elapsed\n`;
  }
  if (progress.phase === "account-progress") {
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    return `wrench: Beeper export: account ${beeperProgressPosition(progress)} running; ${elapsedSeconds}s elapsed\n`;
  }
  if (progress.phase === "account-skipped") {
    if (progress.reason !== "chat-limit-reached") {
      throw new Error("Beeper export progress was invalid");
    }
    return `wrench: Beeper export: account ${beeperProgressPosition(progress)} skipped; chat limit reached\n`;
  }
  if (progress.phase === "account-completed") {
    const chats = beeperProgressInteger(progress.chats, 0);
    const messages = beeperProgressInteger(progress.messages, 0);
    return `wrench: Beeper export: account ${beeperProgressPosition(progress)} complete; ${chats} ${plural(chats, "chat", "chats")}, ${messages} ${plural(messages, "message", "messages")} total\n`;
  }
  if (progress.phase === "accounts-verifying") {
    const accounts = beeperProgressInteger(progress.accounts, 1);
    return `wrench: Beeper export: verifying ${accounts} connected ${plural(accounts, "account", "accounts")}\n`;
  }
  if (progress.phase === "conversion-started") {
    const accounts = beeperProgressInteger(progress.accounts, 1);
    const chats = beeperProgressInteger(progress.chats, 0);
    const messages = beeperProgressInteger(progress.messages, 0);
    return `wrench: Beeper export: converting ${accounts} ${plural(accounts, "account", "accounts")}; ${chats} ${plural(chats, "chat", "chats")}, ${messages} ${plural(messages, "message", "messages")} total\n`;
  }
  if (progress.phase === "conversion-progress") {
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    return `wrench: Beeper export: converting local bundle; ${elapsedSeconds}s elapsed\n`;
  }
  if (progress.phase === "bundle-building") {
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    const records = beeperProgressInteger(progress.records, 0);
    const bytes = beeperProgressInteger(progress.bytes, 0);
    return `wrench: Beeper export: building local bundle; ${records} ${plural(records, "record", "records")}, ${bytes} bytes; ${elapsedSeconds}s elapsed\n`;
  }
  if (progress.phase === "bundle-validating") {
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    const records = beeperProgressInteger(progress.records, 0);
    const bytes = beeperProgressInteger(progress.bytes, 0);
    return `wrench: Beeper export: validating local bundle; ${records} ${plural(records, "record", "records")}, ${bytes} bytes; ${elapsedSeconds}s elapsed\n`;
  }
  if (progress.phase === "bundle-publishing") {
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    const records = beeperProgressInteger(progress.records, 0);
    const bytes = beeperProgressInteger(progress.bytes, 0);
    return `wrench: Beeper export: publishing local bundle atomically; ${records} ${plural(records, "record", "records")}, ${bytes} bytes; ${elapsedSeconds}s elapsed\n`;
  }
  if (progress.phase === "private-cleanup") {
    const elapsedSeconds = beeperProgressInteger(progress.elapsedSeconds, 0);
    return `wrench: Beeper export: removing private raw shards; ${elapsedSeconds}s elapsed\n`;
  }
  const exhaustive: never = progress;
  void exhaustive;
  throw new Error("Beeper export progress was invalid");
}

type PreparedCapture = {
  readonly arguments: readonly string[];
  readonly runtimeOptions: ClipRuntimeOptions;
  readonly cleanup: () => void;
};

type ResolvedCapture = {
  readonly arguments: readonly string[];
  readonly auth?: WrenchAuth;
};

function resolveCaptureArgumentsWithAuth(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedCapture {
  const forwarded: string[] = [];
  let authId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--auth") {
      forwarded.push(argument ?? "");
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("--auth requires a stored auth locator ID");
    if (authId !== undefined) throw new Error("capture accepts at most one --auth locator");
    authId = value;
    index += 1;
  }
  if (authId === undefined) return { arguments: forwarded };
  const explicitAuthFlags = new Set(["--browser-profile", "--cookie-source", "--cookie-profile", "--cookies-file"]);
  if (forwarded.some((argument) => explicitAuthFlags.has(argument))) {
    throw new Error("--auth cannot be combined with raw browser-profile or cookie-source options");
  }
  const auth = loadAuth(authId, environment);
  if (auth.kind === "oauth-token-file") {
    if (auth.provider === "gmail") {
      return { arguments: forwarded, auth };
    }
    throw new Error(
      `auth locator ${auth.id} is for official ${auth.provider} API capabilities and cannot be used for browser capture; use cookie/profile auth for clip or read`,
    );
  }
  if (auth.kind === "linked-device-store") {
    throw new Error(
      `auth locator ${auth.id} is a ${auth.provider} linked-device protocol realm and cannot be used for browser capture`,
    );
  }
  if (auth.kind === "cookie-source") {
    return {
      arguments: [
        ...forwarded,
        "--cookie-source", auth.source,
        ...(auth.profile === undefined ? [] : ["--cookie-profile", auth.profile]),
      ],
      auth,
    };
  }
  if (auth.kind === "cookies-file") {
    return {
      arguments: [...forwarded, "--cookies-file", auth.path],
      auth,
    };
  }
  return {
    arguments: [
      ...forwarded,
      "--browser-profile", auth.profile,
      ...(auth.cookieSource === undefined ? [] : ["--cookie-source", auth.cookieSource]),
      ...(auth.cookieProfile === undefined ? [] : ["--cookie-profile", auth.cookieProfile]),
    ],
    auth,
  };
}

function prepareCapture(
  resolved: ResolvedCapture,
  environment: Readonly<Record<string, string | undefined>>,
): PreparedCapture {
  const auth = resolved.auth;
  if (auth?.kind !== "browser-profile") {
    return { arguments: resolved.arguments, runtimeOptions: {}, cleanup: () => undefined };
  }
  const sourceProfile = profilePath(auth.profile);
  if (sourceProfile === null) {
    return {
      arguments: resolved.arguments,
      runtimeOptions: auth.browserExecutable === undefined
        ? {}
        : { browserExecutable: auth.browserExecutable },
      cleanup: () => undefined,
    };
  }
  const privateDirectory = createBrowserSnapshotDirectory(environment);
  try {
    const cloned = cloneBrowserProfile(sourceProfile, privateDirectory.path);
    const clonedArguments = [...resolved.arguments];
    const profileIndex = clonedArguments.indexOf("--browser-profile");
    if (profileIndex < 0 || clonedArguments[profileIndex + 1] !== auth.profile) {
      throw new Error("resolved browser-profile auth does not match its capture arguments");
    }
    clonedArguments[profileIndex + 1] = cloned.userDataPath;
    return {
      arguments: clonedArguments,
      runtimeOptions: {
        ...(auth.browserExecutable === undefined
          ? {}
          : { browserExecutable: auth.browserExecutable }),
        ownedBrowserProfile: {
          path: cloned.userDataPath,
          ...(cloned.profileDirectory === undefined ? {} : { profileDirectory: cloned.profileDirectory }),
        },
      },
      cleanup: () => removeBrowserSnapshotDirectory(privateDirectory, environment),
    };
  } catch (error) {
    removeBrowserSnapshotDirectory(privateDirectory, environment);
    throw error;
  }
}

async function runCaptureCommand(
  prefix: readonly string[],
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  output: Output,
  dependencies: WrenchDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const resolved = resolveCaptureArgumentsWithAuth(arguments_, environment);
  const unresolvedArguments = [...prefix, ...resolved.arguments];
  const parsed = parseCaptureArguments(unresolvedArguments, environment);
  if (!parsed.ok) {
    return dependencies.clipMain(unresolvedArguments, environment, output);
  }
  if (
    resolved.auth?.kind === "oauth-token-file"
    && resolved.auth.provider === "gmail"
    && (parsed.value.command === "capture" || parsed.value.command === "inspect")
  ) {
    const hasExplicitMedia = resolved.arguments.includes("--media");
    const normalizedGmailArguments = parsed.value.media === "images" && !hasExplicitMedia
      ? { ...parsed.value, media: "all" as const }
      : parsed.value;
    const hasExplicitOutput = resolved.arguments.includes("--output");
    const persistentPrivateCapture = !normalizedGmailArguments.stdout && !hasExplicitOutput;
    const gmailOptions = persistentPrivateCapture
      ? {
          ...normalizedGmailArguments,
          outputBase: join(wrenchStateHome(environment), "captures", "gmail"),
        }
      : normalizedGmailArguments;
    if (persistentPrivateCapture) {
      ensurePrivateStateDirectory(gmailOptions.outputBase, environment);
    }
    return dependencies.gmailCaptureMain(
      gmailOptions,
      resolved.auth,
      environment,
      output,
    );
  }
  const prepared = prepareCapture(resolved, environment);
  try {
    return await dependencies.clipMain(
      [...prefix, ...prepared.arguments],
      environment,
      output,
      {
        runCapture: (captureArguments) => dependencies.runCapture(
          captureArguments,
          environment,
          signal === undefined ? {} : { signal },
        ),
      },
      prepared.runtimeOptions,
    );
  } finally {
    prepared.cleanup();
  }
}

async function readStdinBounded(maxBytes: number): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const output = new BoundedByteBuffer(maxBytes);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!output.append(next.value)) throw new Error(`stdin exceeds ${maxBytes} bytes`);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output.toUint8Array());
}

async function readInput(source: string): Promise<unknown> {
  const maximum = 1024 * 1024;
  let text = source;
  if (source === "-") text = await readStdinBounded(maximum);
  else if (source.startsWith("@")) {
    const path = resolve(source.slice(1));
    text = readRegularFile(path, maximum, "input file");
  } else if (Buffer.byteLength(source, "utf8") > maximum) throw new Error(`inline input exceeds ${maximum} bytes`);
  return JSON.parse(text) as unknown;
}

const MAX_THREAD_TEXT_BYTES = 64 * 1024;

async function readTextInput(source: string): Promise<string> {
  if (source === "-") return readStdinBounded(MAX_THREAD_TEXT_BYTES);
  if (source.startsWith("@")) {
    return readRegularFile(resolve(source.slice(1)), MAX_THREAD_TEXT_BYTES, "thread text file");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_THREAD_TEXT_BYTES) {
    throw new Error(`inline thread text exceeds ${MAX_THREAD_TEXT_BYTES} bytes`);
  }
  return source;
}

const PLATFORM_POLICY_NOTICE = "Catalog entries are reviewed policy only. adapter-eligible does not mean an adapter or capability is installed.";

function selectedPlatformSurfaces(surfaceId?: PlatformSurfaceId): readonly PlatformSurfaceCatalogEntry[] {
  return surfaceId === undefined
    ? platformSurfaceIds.map((id) => socialPlatformCatalog[id])
    : [socialPlatformCatalog[surfaceId]];
}

function platformPolicyView(
  surfaceId?: PlatformSurfaceId,
): Record<string, unknown> {
  return {
    ok: true,
    kind: "reviewed-platform-policy",
    policyOnly: true,
    installationStatus: "not-evaluated",
    notice: PLATFORM_POLICY_NOTICE,
    installedCapabilitiesCommand: "wrench capabilities [adapter]",
    surfaces: selectedPlatformSurfaces(surfaceId),
  };
}

function renderPlatformPolicyText(
  surfaceId?: PlatformSurfaceId,
): string {
  const lines = [
    "Wrench reviewed platform policy",
    PLATFORM_POLICY_NOTICE,
    "Run 'wrench capabilities [adapter]' to inspect installed capabilities.",
  ];
  for (const surface of selectedPlatformSurfaces(surfaceId)) {
    lines.push("", `${surface.displayName} (${surface.id})`, `  Exact origins: ${surface.originPolicy.exactOrigins.join(", ")}`);
    if (surface.originPolicy.additionalExactOrigins.state === "adapter-declared") {
      lines.push(`  Additional origin: ${surface.originPolicy.additionalExactOrigins.note}`);
    }
    for (const state of ["adapter-eligible", "unsupported", "not-applicable", "R4"] as const) {
      const operations = semanticOperationNames.flatMap((name) => {
        const policy = surface.operations[name];
        if (policy.state !== state) return [];
        return [policy.state === "adapter-eligible" ? `${name} (${policy.risk})` : name];
      });
      lines.push(`  ${state}: ${operations.length === 0 ? "none" : operations.join(", ")}`);
    }
    for (const name of compositionNames) {
      const composition = surface.compositions[name];
      if (composition === undefined) continue;
      const text = composition.text
        .map((field) => `${field.name}<=${field.safeMaxUnits} ${field.measurement}${field.required ? "" : " (optional)"}`)
        .join(", ");
      const attachment = composition.attachments.state === "none"
        ? "no attachments"
        : `${composition.attachments.minItems}-${composition.attachments.maxItems} ${composition.attachments.kinds.join("/")}`;
      lines.push(`  ${name} composition: ${text}; ${attachment}`);
    }
    lines.push(
      `  Long-form read/publish: ${surface.longForm.read.state}/${surface.longForm.publish.state}`,
      `  Thread read/publish: ${surface.threads.read.state}/${surface.threads.publish.state}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

type RuntimeThreadPolicy = {
  readonly surface: PlatformSurfaceCatalogEntry;
  readonly maxWeightedLength: number;
  readonly maxItems: number;
  readonly measurement: keyof typeof textWeightPolicies;
  readonly operation: "threads.publish";
  readonly rootOperation: "posts.publish";
  readonly continuationOperation: "replies.create";
};

function runtimeThreadPolicy(surfaceId: PlatformSurfaceId): RuntimeThreadPolicy {
  const surface: PlatformSurfaceCatalogEntry = socialPlatformCatalog[surfaceId];
  const publishing = surface.threads.publish;
  if (publishing.state !== "adapter-eligible") {
    throw new Error(`${surfaceId} native thread publishing is ${publishing.state}; no thread split policy is available`);
  }
  const rootBody = surface.compositions.post?.text.find((field) => field.name === "body");
  const replyBody = surface.compositions.reply?.text.find((field) => field.name === "body");
  if (rootBody === undefined || replyBody === undefined || rootBody.measurement !== replyBody.measurement) {
    throw new Error(`${surfaceId} has an inconsistent reviewed thread composition policy`);
  }
  return {
    surface,
    maxWeightedLength: Math.min(rootBody.safeMaxUnits, replyBody.safeMaxUnits),
    maxItems: publishing.safeMaxItems,
    measurement: rootBody.measurement,
    operation: publishing.operation,
    rootOperation: publishing.rootOperation,
    continuationOperation: publishing.continuationOperation,
  };
}

async function runThreadSplit(
  arguments_: Extract<WrenchArguments, { readonly command: "thread-split" }>,
  output: Output,
): Promise<number> {
  const { policy, text, weightPolicy, chunks } = await prepareThreadDraft(arguments_.surfaceId, arguments_.textSource);
  const view = {
    ok: true,
    kind: "local-thread-split",
    published: false,
    localSplitRequiresInstalledCapability: false,
    publicationInstallationStatus: "not-evaluated",
    notice: "This command only split local text. Publishing still requires a separately installed reviewed adapter capability.",
    surfaceId: arguments_.surfaceId,
    exactOrigins: policy.surface.originPolicy.exactOrigins,
    operation: policy.operation,
    rootOperation: policy.rootOperation,
    continuationOperation: policy.continuationOperation,
    measurement: policy.measurement,
    maxWeightedLength: policy.maxWeightedLength,
    maxItems: policy.maxItems,
    inputBytes: Buffer.byteLength(text, "utf8"),
    inputWeightedLength: weightedTextLength(text, weightPolicy),
    exactRoundTrip: true,
    chunks: chunks.map((chunk, index) => ({ index: index + 1, ...chunk })),
  };
  if (arguments_.json) {
    output.stdout(exactTerminalJson(view));
  } else {
    output.stdout(`Local ${safe(arguments_.surfaceId)} thread split: ${chunks.length} item(s); nothing was published.\n`);
    output.stdout("Publishing still requires a separately installed reviewed adapter capability.\n");
    output.stdout(`Each following chunk is an exact JSON string (${safe(policy.measurement)}, max ${policy.maxWeightedLength}).\n`);
    for (const [index, chunk] of chunks.entries()) {
      output.stdout(`${index + 1}/${chunks.length} · ${chunk.weightedLength}\n`);
      output.stdout(exactTerminalJson(chunk.text));
    }
  }
  return 0;
}

async function prepareThreadDraft(surfaceId: PlatformSurfaceId, textSource: string): Promise<{
  readonly policy: RuntimeThreadPolicy;
  readonly text: string;
  readonly weightPolicy: (typeof textWeightPolicies)[keyof typeof textWeightPolicies];
  readonly chunks: readonly { readonly text: string; readonly weightedLength: number }[];
}> {
  const policy = runtimeThreadPolicy(surfaceId);
  const text = await readTextInput(textSource);
  if (text.length === 0) throw new Error("thread text must not be empty");
  const weightPolicy = textWeightPolicies[policy.measurement];
  const result = splitWeightedThread(text, {
    maxWeightedLength: policy.maxWeightedLength,
    maxItems: policy.maxItems,
    weightPolicy,
  });
  if (!result.ok) {
    if (result.reason === "too-many-items") {
      throw new Error(`thread text requires more than the reviewed ${result.maxItems}-item limit for ${surfaceId}`);
    }
    if (result.reason === "unit-too-large") {
      throw new Error(`one Unicode grapheme or URL weighs ${result.unitWeight}, above the ${policy.maxWeightedLength}-unit per-item limit`);
    }
    if (result.reason === "invalid-unicode") throw new Error("thread text must contain well-formed Unicode");
    if (result.reason === "invalid-weight-policy") throw new Error(`invalid reviewed thread weight policy: ${result.issue}`);
    throw new Error("invalid reviewed thread split bounds");
  }
  const joined = result.chunks.map((chunk) => chunk.text).join("");
  if (joined !== text) throw new Error("thread splitter did not preserve the exact input");
  return { policy, text, weightPolicy, chunks: result.chunks };
}

async function runThreadPublish(
  arguments_: Extract<WrenchArguments, { readonly command: "thread-publish" }>,
  environment: Readonly<Record<string, string | undefined>>,
  output: Output,
  registry: ProviderPluginRegistry = providerPluginRegistry,
): Promise<number> {
  const draft = await prepareThreadDraft(arguments_.surfaceId, arguments_.textSource);
  const invocation = prepareInvocation(
    arguments_.adapterId,
    draft.policy.operation,
    { items: draft.chunks.map((chunk) => chunk.text) },
    arguments_.authId,
    environment,
    registry,
  );
  if (invocation.manifest.surfaceId !== arguments_.surfaceId) {
    throw new Error(`adapter ${arguments_.adapterId} is not bound to ${arguments_.surfaceId}`);
  }
  const operation = invocation.manifest.operations[draft.policy.operation];
  if (operation?.risk !== "R3") throw new Error("reviewed thread publishing must be an R3 capability");
  const stored = createAndSaveInvocationPlan(
    invocation,
    environment,
    new Date(),
    registry,
  );
  printPreview(output, {
    ...previewView(stored, invocation, arguments_.headed),
    thread: {
      surfaceId: arguments_.surfaceId,
      items: draft.chunks.length,
      measurement: draft.policy.measurement,
      maxWeightedLength: draft.policy.maxWeightedLength,
      exactRoundTrip: draft.chunks.map((chunk) => chunk.text).join("") === draft.text,
    },
  }, arguments_.json);
  return arguments_.preview ? 0 : 4;
}

function manifestFromPlatform(adapterId: string, surfaceId: PlatformSurfaceId): ReturnType<typeof emptyManifest> {
  const surface = socialPlatformCatalog[surfaceId];
  const primaryOrigin = surface.originPolicy.exactOrigins[0];
  if (primaryOrigin === undefined) throw new Error(`${surfaceId} has no reviewed exact origin`);
  const browserDomains = [...new Set(surface.originPolicy.exactOrigins.map((origin) => new URL(origin).hostname.toLowerCase()))];
  const manifest = emptyManifest(adapterId, primaryOrigin, browserDomains, surfaceId);
  return {
    ...manifest,
    displayName: surface.displayName,
    origins: surface.originPolicy.exactOrigins,
    browserDomains,
  };
}

function installedOperationTransport(operation: WrenchOperation): "provider-api" | "web-session-api" | "reviewed-template-api" {
  if (isProviderOperation(operation)) return "provider-api";
  if (isWebSessionOperation(operation)) return "web-session-api";
  if (isReviewedTemplateOperation(operation)) return "reviewed-template-api";
  throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
}

function capabilitySummary(
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): readonly unknown[] {
  return listRuntimeManifests(environment, registry).map(({ id, result }) => result.ok
    ? {
        id,
        version: result.value.version,
        displayName: result.value.displayName,
        surfaceId: result.value.surfaceId ?? null,
        origins: result.value.origins,
        manifestHash: manifestHash(result.value),
        operations: Object.entries(result.value.operations).map(([operationId, operation]) => {
          const provider = isProviderOperation(operation)
            ? getProviderContract(operation.provider, registry)
            : null;
          const webSession = isWebSessionOperation(operation)
            ? getWebSessionContract(operation.webSession, registry)
            : null;
          const reviewedTemplate = isReviewedTemplateOperation(operation) ? operation.reviewedTemplate : null;
          return {
            id: operationId,
            description: operation.description,
            risk: operation.risk,
            sideEffect: operation.sideEffect,
            idempotency: operation.idempotency,
            dedupeWindowMs: operation.dedupeWindowMs,
            transport: installedOperationTransport(operation),
            input: operation.input,
            ...(provider === null ? {} : {
              provider: provider.provider,
              providerAction: provider.operation,
              providerContractVersion: provider.contractVersion,
              providerContractHash: providerContractHash(provider, registry),
              requiredScopeSets: provider.requiredScopeSets,
              coverage: provider.coverage,
              implementation: provider.implementation,
            }),
            ...(webSession === null ? {} : {
              site: webSession.site,
              webSessionAction: webSession.operation,
              webSessionContractVersion: webSession.contractVersion,
              webSessionContractHash: webSessionContractHash(
                webSession,
                registry,
              ),
              state: webSession.state,
              implementation: webSession.implementation,
            }),
            ...(reviewedTemplate === null ? {} : {
              state: reviewedTemplate.state,
              reviewedTemplateContractVersion: reviewedTemplate.contractVersion,
              reviewedTemplateContractHash: reviewedTemplateHash(reviewedTemplate),
              ...(reviewedTemplate.state === "capture-required"
                ? { instructions: reviewedTemplate.instructions }
                : {
                    reviewedAt: reviewedTemplate.reviewedAt,
                    evidenceSha256: reviewedTemplate.evidenceSha256,
                    origin: reviewedTemplate.template.origin,
                  }),
            }),
          };
        }),
      }
    : { id, invalid: true, issues: result.issues });
}

function listRuntimeManifests(
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): ReturnType<typeof listInstalledManifests> {
  const stored = listInstalledManifests(environment, registry);
  const storedIds = new Set(stored.map((entry) => entry.id));
  const owned = registry.listOwnedManifests();
  const collision = owned.find((manifest) => storedIds.has(manifest.id));
  if (collision !== undefined) {
    throw new Error(
      `adapter ${collision.id} collides with an enabled portable provider plugin`,
    );
  }
  return Object.freeze([
    ...stored,
    ...owned.map((manifest) => Object.freeze({
      id: manifest.id,
      result: Object.freeze({ ok: true as const, value: manifest }),
    })),
  ].sort((left, right) => left.id.localeCompare(right.id)));
}

function officialProviderReadiness(
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): readonly {
  readonly provider: string;
  readonly adapters: readonly string[];
  readonly auth: readonly { readonly id: string; readonly tokenReady: boolean; readonly usableOperations: number }[];
  readonly ready: boolean;
}[] {
  const manifests = listRuntimeManifests(environment, registry)
    .filter((entry) => entry.result.ok)
    .map((entry) => ({ id: entry.id, manifest: entry.result.ok ? entry.result.value : null }))
    .filter((entry): entry is { readonly id: string; readonly manifest: NonNullable<typeof entry.manifest> } => entry.manifest !== null);
  const auth = listAuth(environment).filter((entry) => entry.kind === "oauth-token-file");
  const bindings = registry.list().flatMap((plugin) =>
    plugin.bindings.filter((binding) => binding.transport === "provider-api"));
  return bindings.map((binding) => {
    const provider = binding.surfaceId;
    const adapters = manifests.filter((entry) => Object.values(entry.manifest.operations).some((operation) =>
      isProviderOperation(operation) && operation.provider.provider === provider));
    const operations = adapters.flatMap((entry) => Object.values(entry.manifest.operations)
      .filter(isProviderOperation)
      .filter((operation) => operation.provider.provider === provider)
      .flatMap((operation) => {
        const resolution = registry.resolveOperationDefinition(
          "provider-api",
          provider,
          operation.provider.action,
          operation.provider.contractVersion,
        );
        return resolution === undefined ? [] : [resolution.operation];
      }));
    const locators = auth.filter((entry) => entry.provider === provider).map((entry) => {
      let tokenReady = false;
      let usableOperations = 0;
      try {
        loadOAuthToken(entry);
        tokenReady = true;
        usableOperations = operations.filter((operation) => {
          try {
            if (!("requiredScopeSets" in operation)) return false;
            requireOAuthScopes(entry, operation.requiredScopeSets);
            return true;
          } catch {
            return false;
          }
        }).length;
      } catch {
        // Doctor reports only readiness metadata and never token contents or paths.
      }
      return { id: entry.id, tokenReady, usableOperations };
    });
    return {
      provider,
      adapters: adapters.map((entry) => entry.id),
      auth: locators,
      ready: adapters.length > 0 && locators.some((entry) => entry.tokenReady && entry.usableOperations > 0),
    };
  });
}

type WebSessionReadiness = {
  readonly site: string;
  readonly adapters: readonly string[];
  readonly observedOperations: readonly string[];
  readonly captureRequiredOperations: readonly string[];
  readonly accountBoundAuth: readonly string[];
  readonly ready: boolean;
};

function authenticatedWebSessionReadiness(
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): readonly WebSessionReadiness[] {
  const manifests = listRuntimeManifests(environment, registry);
  const auth = listAuth(environment).filter((entry) =>
    isCookieCapableWebAuth(entry) || entry.kind === "linked-device-store"
  );
  const bindings = registry.list().flatMap((plugin) =>
    plugin.bindings.filter((binding) => binding.transport !== "provider-api"));
  return bindings.map((binding) => {
    const site = binding.surfaceId;
    const operations = manifests.flatMap((entry) => {
      if (!entry.result.ok || entry.result.value.schemaVersion !== 4) return [];
      return Object.entries(entry.result.value.operations).flatMap(([operationId, operation]) => {
        if (!isWebSessionOperation(operation) || operation.webSession.site !== site) return [];
        const contract = getWebSessionContract(operation.webSession, registry);
        return [{ adapter: entry.id, operation: operationId, state: contract.state }];
      });
    });
    const observed = operations.filter((entry) => entry.state === "observed");
    const captureRequired = operations.filter((entry) => entry.state === "capture-required");
    const accountBoundAuth = auth
      .filter((entry) => {
        try {
          requireProviderPluginAuth(binding, entry);
          return true;
        } catch {
          return false;
        }
      })
      .filter((entry) =>
        entry.subject !== undefined && binding.subject.matches(entry.subject))
      .map((entry) => entry.id)
      .sort();
    const adapters = [...new Set(observed.map((entry) => entry.adapter))].sort();
    const observedOperations = [...new Set(observed.map((entry) => entry.operation))].sort();
    const captureRequiredOperations = [...new Set(
      captureRequired.map((entry) => entry.operation),
    )].sort();
    return {
      site,
      adapters,
      observedOperations,
      captureRequiredOperations,
      accountBoundAuth,
      ready: adapters.length > 0 && accountBoundAuth.length > 0,
    };
  });
}

function reviewedTemplateReservationStatus(
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): {
  readonly mode: "derivation-reservation-only";
  readonly adapters: readonly string[];
  readonly operations: readonly string[];
  readonly executable: false;
  readonly requiredContract: "reviewed-template-v2-current-account-preflight";
} {
  const reservations = listRuntimeManifests(environment, registry).flatMap((entry) => {
    if (!entry.result.ok || entry.result.value.schemaVersion !== 5) return [];
    return Object.entries(entry.result.value.operations).flatMap(([operationId, operation]) =>
      isReviewedTemplateOperation(operation)
      && operation.reviewedTemplate.state === "capture-required"
        ? [{ adapter: entry.id, operation: operationId }]
        : []);
  });
  const adapters = [...new Set(reservations.map((entry) => entry.adapter))].sort();
  const operations = [...new Set(reservations.map((entry) => `${entry.adapter}/${entry.operation}`))].sort();
  return {
    mode: "derivation-reservation-only",
    adapters,
    operations,
    executable: false,
    requiredContract: "reviewed-template-v2-current-account-preflight",
  };
}

async function doctor(
  arguments_: Extract<WrenchArguments, { readonly command: "doctor" }>,
  environment: Readonly<Record<string, string | undefined>>,
  output: Output,
  dependencies: WrenchDependencies,
): Promise<number> {
  const registry = dependencies.providerPluginRegistry;
  const confirmationClaimRecovery =
    repairInterruptedConfirmationClaims(environment);
  const runJournalRecovery = repairInterruptedRunJournals(environment);
  const webSessionCleanupAdmissionRecovery =
    recoverWebSessionCleanupAdmissions(environment);
  const linkedDeviceLifecycleAdmissionRecovery =
    recoverLinkedDeviceLifecycleAdmissions(environment);
  const linkedDeviceLifecycleRecovery =
    recoverLinkedDeviceLifecycleJournals({ environment });
  const linkedDeviceBindings = registry.list().flatMap((plugin) =>
    plugin.bindings.filter(
      (binding): binding is LinkedDevicePluginBindingV1 =>
        binding.transport === "linked-device"
        && binding.linkedDeviceLifecycle !== undefined,
    ));
  const [captureInspection, mediaInspection, linkedDeviceProtocols] = await Promise.all([
    dependencies.inspectClipEnvironment(),
    dependencies.loadMediaRuntime().then(async (runtime) => ({
      runtime,
      report: await runtime.runDoctor({ env: environment }),
    })),
    Promise.all(linkedDeviceBindings.map(async (binding) => {
      try {
        return {
          surface: binding.surfaceId,
          ...(await binding.linkedDeviceLifecycle!.inspect(environment)),
        };
      } catch {
        return {
          surface: binding.surfaceId,
          ready: false,
          implementation: "unavailable",
          version: "unknown",
          integrity: "inspection-failed",
        };
      }
    })),
  ]);
  const capture = captureInspection.report;
  const media = mediaInspection.report;
  const portablePlugins = doctorPortableProviderPlugins(environment);
  const expiredPlansRemoved = purgeExpiredPlans(environment);
  const orphanedBrowserSnapshotsRemoved = purgeOrphanedBrowserSnapshots(environment);
  const adapters = capabilitySummary(environment, registry);
  const auth = listAuth(environment).map((entry) => ({ id: entry.id, kind: entry.kind }));
  const officialProviders = officialProviderReadiness(environment, registry);
  const derivations = listDerivations(environment);
  const unsettledRuns = listRunReceipts(environment).filter((receipt) =>
    "status" in receipt && (receipt.status === "pending" || receipt.status === "partial" || receipt.status === "indeterminate"));
  const browserCaptureBootstrapReady =
    captureInspection.browserCaptureBootstrapReady;
  const providerApiReady = officialProviders.some((provider) => provider.ready);
  const webSessionSites = authenticatedWebSessionReadiness(environment, registry);
  const webSessionApiReady = webSessionSites.some((site) => site.ready);
  const webSessionAdapters = [...new Set(webSessionSites.flatMap((site) => site.adapters))].sort();
  const reviewedTemplateReservations = reviewedTemplateReservationStatus(environment, registry);
  const reviewedTemplateApiReady = false;
  const actionReady = providerApiReady || webSessionApiReady;
  const runRecoveryHealthy = confirmationClaimRecovery.invalid === 0
    && runJournalRecovery.issues.length === 0;
  const webSessionCleanupRecoveryHealthy =
    webSessionCleanupAdmissionRecovery.issues.length === 0;
  const linkedDeviceLifecycleRecoveryHealthy =
    linkedDeviceLifecycleRecovery.issues.length === 0
    && linkedDeviceLifecycleAdmissionRecovery.issues.length === 0;
  const recoveryHealthy = runRecoveryHealthy
    && webSessionCleanupRecoveryHealthy
    && linkedDeviceLifecycleRecoveryHealthy;
  const wrenchReport = {
    home: wrenchStateHome(environment),
    mediaArchiveReady: media.ok,
    installedAdapters: adapters.length,
    configuredAuth: auth,
    browserCaptureBootstrapReady,
    browserActionReady: false,
    providerApiReady,
    webSessionApiReady,
    webSessionAdapters,
    webSessionSites,
    reviewedTemplateApiReady,
    reviewedTemplateReservations,
    officialProviders,
    linkedDeviceProtocols,
    // Compatibility field retained while callers move to the generic list.
    whatsappProtocol: linkedDeviceProtocols.find(
      (entry) => entry.surface === "whatsapp",
    ) ?? null,
    activeDerivations: derivations,
    unsettledRuns,
    confirmationClaimRecovery,
    runJournalRecovery,
    webSessionCleanupAdmissionRecovery,
    linkedDeviceLifecycleRecovery,
    linkedDeviceLifecycleAdmissionRecovery,
    portablePlugins,
    mutationPolicy: "R2/R3 preview+digest confirmation; R4 blocked",
    rawHarRetention: "private-until-finish-or-discard",
    expiredPlansRemoved,
    orphanedBrowserSnapshotsRemoved,
  };
  const report = {
    ok: actionReady && recoveryHealthy && portablePlugins.ok,
    capture,
    media,
    wrench: wrenchReport,
    // Frozen doctor JSON compatibility alias. Predecessor consumers received
    // this report under `oh`; both envelopes must remain structurally exact.
    oh: wrenchReport,
  };
  if (arguments_.json) output.stdout(safeJson(report));
  else {
    output.stdout(sanitizeTerminalText(captureInspection.renderReport()));
    output.stdout("\nWrench verified media archive\n");
    output.stdout(sanitizeTerminalText(mediaInspection.runtime.renderDoctorReport(media)));
    output.stdout("\nWrench actions\n");
    output.stdout(`- Home: ${safe(report.wrench.home)}\n`);
    output.stdout(`- Installed adapters: ${adapters.length}\n`);
    output.stdout(
      `- Portable plugins: ${portablePlugins.ok ? "healthy" : "attention required"}`
      + ` (${portablePlugins.installed} installed)\n`,
    );
    output.stdout(`- Auth locators: ${auth.length}\n`);
    output.stdout(
      `- Durable run recovery: ${runRecoveryHealthy ? "healthy" : "attention required"}`
      + ` (${runJournalRecovery.repaired} repaired, ${runJournalRecovery.issues.length} unresolved)\n`,
    );
    output.stdout(
      `- Authenticated-web cleanup recovery: ${webSessionCleanupRecoveryHealthy ? "healthy" : "attention required"}`
      + ` (${webSessionCleanupAdmissionRecovery.repaired} repaired, ${webSessionCleanupAdmissionRecovery.issues.length} unresolved)\n`,
    );
    output.stdout(
      `- Linked-device lifecycle recovery: ${linkedDeviceLifecycleRecoveryHealthy ? "healthy" : "attention required"}`
      + ` (${linkedDeviceLifecycleRecovery.repairedSafeRetry + linkedDeviceLifecycleRecovery.repairedIndeterminate + linkedDeviceLifecycleAdmissionRecovery.repaired} repaired, ${linkedDeviceLifecycleRecovery.issues.length + linkedDeviceLifecycleAdmissionRecovery.issues.length} unresolved)\n`,
    );
    output.stdout(`- Browser capture/bootstrap: ${browserCaptureBootstrapReady ? "ready" : "not ready"}\n`);
    output.stdout("- Generic browser/DOM action execution: disabled (internal API contracts only)\n");
    output.stdout(`- Official provider plugin APIs: ${providerApiReady ? "ready" : "not ready"}\n`);
    output.stdout(`- Authenticated internal APIs (any observed contract + account binding): ${webSessionApiReady ? "ready" : "not ready"}\n`);
    for (const readiness of webSessionSites) {
      const state = readiness.ready
        ? "ready"
        : readiness.observedOperations.length > 0
          ? "account binding required"
          : readiness.captureRequiredOperations.length > 0
            ? "capture-required"
            : "not installed";
      output.stdout(
        `- ${safe(readiness.site)} authenticated internal API: ${state}`
        + ` (${readiness.observedOperations.length} observed, ${readiness.captureRequiredOperations.length} capture-required)\n`,
      );
    }
    for (const protocol of linkedDeviceProtocols) {
      output.stdout(
        `- ${safe(protocol.surface)} linked-device protocol ${safe(protocol.version)}: ${protocol.ready ? "ready" : "not installed"}\n`,
      );
      if (!protocol.ready && protocol.setupCommand !== undefined) {
        output.stdout(`  Setup: ${safe(protocol.setupCommand)}\n`);
      }
    }
    output.stdout(`- Generic internal-API derivation: reservation-only (schema-v5 templates are inert until account preflight)\n`);
    output.stdout(`- Generic internal-API execution: not available (reviewed-template v2 account preflight required)\n`);
    output.stdout(`- Active derivations: ${derivations.length}${derivations.length === 0 ? "" : " (run 'wrench derive list')"}\n`);
    output.stdout(`- Unsettled runs: ${unsettledRuns.length}${unsettledRuns.length === 0 ? "" : " (run 'wrench runs list')"}\n`);
    output.stdout(`- Writes: ${report.wrench.mutationPolicy}\n`);
    output.stdout(`- Raw HAR retention: ${report.wrench.rawHarRetention}\n`);
  }
  return report.ok ? 0 : 3;
}

function confirmationContractView(plan: ReturnType<typeof createInvocationPlan>["plan"]): Record<string, unknown> {
  if (plan.transport === "portable-provider-plugin") {
    const identity = plan.portablePluginContract;
    return {
      transport: plan.transport,
      identity: `${identity.pluginId}/${identity.adapterId}/${identity.operation}@${identity.contractVersion}`,
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      hostApiVersion: identity.hostApiVersion,
      bundleSha256: identity.bundleSha256,
      manifestSha256: identity.manifestSha256,
      adapterId: identity.adapterId,
      pluginTransport: identity.transport,
      surfaceId: identity.surfaceId,
      operation: identity.operation,
      version: identity.contractVersion,
      descriptorSha256: identity.descriptorSha256,
    };
  }
  if (plan.transport === "provider-api") {
    return {
      transport: plan.transport,
      identity: `${plan.providerContract.provider}/${plan.providerContract.action}@${plan.providerContract.version}`,
      provider: plan.providerContract.provider,
      action: plan.providerContract.action,
      version: plan.providerContract.version,
      hash: plan.providerContract.hash,
    };
  }
  if (plan.transport === "web-session-api") {
    return {
      transport: plan.transport,
      identity: `${plan.webSessionContract.site}/${plan.webSessionContract.action}@${plan.webSessionContract.version}`,
      site: plan.webSessionContract.site,
      action: plan.webSessionContract.action,
      version: plan.webSessionContract.version,
      hash: plan.webSessionContract.hash,
    };
  }
  if (plan.transport === "reviewed-template-api") {
    return {
      transport: plan.transport,
      identity: `${plan.adapter.id}/${plan.operation}@${plan.reviewedTemplateContract.version}`,
      version: plan.reviewedTemplateContract.version,
      hash: plan.reviewedTemplateContract.hash,
    };
  }
  throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
}

function identityBindingView(
  operation: WrenchOperation,
  input: OperationInput,
  auth: InvocationAuthority,
): Record<string, unknown> {
  const subject = auth.subject ?? null;
  if (isPublicWebSessionInvocationAuthority(auth)) {
    return {
      status: "public",
      subject,
      accountActor: null,
      requestedActor: null,
    };
  }
  const requestedActor = isProviderOperation(operation) && (operation.risk === "R2" || operation.risk === "R3")
    ? typeof input.actor === "string"
      ? input.actor
      : typeof input.author === "string" ? input.author : null
    : null;
  const accountActor = (
    requestedActor === null
    && (isProviderOperation(operation) || isWebSessionOperation(operation))
  ) ? subject : null;
  const status = requestedActor !== null
    ? requestedActor === subject ? "subject-match" : "contract-preflight-required"
    : accountActor !== null ? "account-subject" : subject !== null ? "subject-only" : "unbound";
  return {
    status,
    subject,
    accountActor,
    requestedActor,
  };
}

function previewView(
  stored: ReturnType<typeof createInvocationPlan>,
  invocation: ReturnType<typeof prepareInvocation>,
  headed: boolean,
): Record<string, unknown> {
  if (
    invocation.manifest.id !== stored.plan.adapter.id
    || invocation.manifest.version !== stored.plan.adapter.version
    || invocation.operationId !== stored.plan.operation
    || invocation.auth.id !== stored.plan.auth.id
    || invocation.auth.kind !== stored.plan.auth.kind
    || sha256(canonicalJson(invocation.auth)) !== stored.plan.auth.hash
  ) throw new Error("prepared invocation no longer matches its confirmation plan");
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation === undefined) throw new Error("operation disappeared while previewing its confirmation plan");
  const previewInputValue = (value: unknown): unknown => isPlanBoundFile(value)
    ? summarizePlanFile(value)
    : Array.isArray(value) ? value.map(previewInputValue) : value;
  const input = Object.fromEntries(Object.entries(stored.plan.input).map(([key, value]) => [key, previewInputValue(value)]));
  return {
    ok: true,
    status: "confirmation-required",
    digest: stored.digest,
    expiresAt: stored.plan.expiresAt,
    adapter: stored.plan.adapter,
    operation: stored.plan.operation,
    risk: stored.plan.risk,
    sideEffect: stored.plan.sideEffect,
    input,
    inputHash: stored.plan.inputHash,
    dispatches: stored.plan.dispatches,
    auth: {
      id: stored.plan.auth.id,
      kind: stored.plan.auth.kind,
      realmFingerprint: stored.plan.auth.hash.slice(0, 16),
    },
    identityBinding: identityBindingView(operation, stored.plan.input, invocation.auth),
    transport: stored.plan.transport,
    contract: confirmationContractView(stored.plan),
    ...(stored.plan.duplicateRisk === undefined
      ? {}
      : {
          duplicateRisk: {
            sourceRunId: stored.plan.duplicateRisk.sourceRunId,
            successorIntentFingerprint:
              stored.plan.duplicateRisk.intentHash.slice(0, 16),
            warning:
              "The source post may already exist. Confirming creates one distinct at-most-once successor intent and can publish a duplicate; the source evidence remains preserved.",
          },
        }),
    confirmCommand: `wrench confirm ${stored.digest}${headed ? " --headed" : ""}`,
  };
}

function directPreviewView(invocation: ReturnType<typeof prepareInvocation>): Record<string, unknown> {
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation === undefined) throw new Error("operation disappeared while previewing it");
  return {
    ok: true,
    status: "preview",
    requiresConfirmation: false,
    adapter: {
      id: invocation.manifest.id,
      version: invocation.manifest.version,
      hash: manifestHash(invocation.manifest),
    },
    operation: invocation.operationId,
    risk: operation.risk,
    sideEffect: operation.sideEffect,
    input: invocation.input,
    auth: {
      id: invocation.auth.id,
      kind: invocation.auth.kind,
      realmFingerprint: sha256(canonicalJson(invocation.auth)).slice(0, 16),
    },
    identityBinding: identityBindingView(operation, invocation.input, invocation.auth),
    transport: invocation.portablePluginContract === undefined
      ? installedOperationTransport(operation)
      : "portable-provider-plugin",
    ...(invocation.portablePluginContract === undefined
      ? {}
      : {
          portablePluginContract: invocation.portablePluginContract,
        }),
  };
}

export function invocationView(result: Awaited<ReturnType<typeof executeReadInvocation>>): Record<string, unknown> {
  return {
    ok: result.receipt.status === "succeeded" || result.receipt.status === "submitted",
    status: result.receipt.status,
    runId: result.receipt.runId,
    replayed: result.replayed,
    receipt: result.receipt,
    output: result.output,
  };
}

export function cachedInvocationView(
  result: ReadProjectionCacheResult,
): Record<string, unknown> {
  if (result.status === "miss") {
    return {
      ok: false,
      status: "cache-miss",
      source: "cache",
      projection: { key: result.key },
    };
  }
  return {
    ok: true,
    status: "cached",
    source: "cache",
    projection: {
      key: result.key,
      dataRevision: result.dataRevision,
      createdAt: result.createdAt,
      dataChangedAt: result.dataChangedAt,
      validatedAt: result.validatedAt,
      runId: result.runId,
      ageMs: result.ageMs,
      freshness: result.freshness,
    },
    output: result.output,
  };
}

export function revalidatedInvocationView(
  result: RevalidatedCapability,
): Record<string, unknown> {
  return {
    ...invocationView(result.live),
    source: "live",
    cache: result.cache,
  };
}

function printPreview(output: Output, value: Record<string, unknown>, json: boolean): void {
  output.stdout(json ? exactTerminalJson(value) : exactTerminalJson(value));
}

async function runCommand(
  arguments_: WrenchArguments,
  environment: Readonly<Record<string, string | undefined>>,
  output: Output,
  dependencies: WrenchDependencies,
  signal?: AbortSignal,
): Promise<number> {
  if (arguments_.command === "help") {
    output.stdout(renderWrenchUsage());
    return 0;
  }
  if (arguments_.command === "clip") {
    return runCaptureCommand(
      [],
      arguments_.arguments,
      environment,
      output,
      dependencies,
      signal,
    );
  }
  if (arguments_.command === "read") {
    return runCaptureCommand(
      ["inspect"],
      arguments_.arguments,
      environment,
      output,
      dependencies,
      signal,
    );
  }
  if (arguments_.command === "media") {
    const media = await dependencies.loadMediaRuntime();
    return media.runCli(arguments_.arguments, {
      io: output,
      environment,
      ...(signal === undefined ? {} : { signal }),
    });
  }
  if (arguments_.command === "beeper-export-message-like-me") {
    const admission = acquireReadProjectionAuthAdmission(
      arguments_.authId,
      environment,
    );
    try {
      const auth = loadAuth(arguments_.authId, environment);
      if (auth.kind !== "linked-device-store" || auth.provider !== "beeper") {
        throw new Error(
          "Message Like Me export requires a Beeper linked-device-store auth locator",
        );
      }
      const runtime = await dependencies.loadBeeperMessageLikeMeCliRuntime();
      const result = await runtime.exportBeeperMessageLikeMeFromAuth({
        auth,
        outputRoot: arguments_.output,
        limits: {
          ...(arguments_.limitChats === undefined
            ? {}
            : { limitChats: arguments_.limitChats }),
          ...(arguments_.limitMessages === undefined
            ? {}
            : { limitMessages: arguments_.limitMessages }),
          ...(arguments_.maxParticipants === undefined
            ? {}
            : { maxParticipants: arguments_.maxParticipants }),
        },
        environment,
        onProgress: (progress) => {
          output.stderr(renderBeeperMessageLikeMeProgress(progress));
        },
        ...(signal === undefined ? {} : { signal }),
      });
      const summary = Object.freeze({
        ok: true,
        outputRoot: result.outputRoot,
        manifestPath: result.manifestPath,
        manifestSha256: result.manifestSha256,
        completeness: result.manifest.completeness,
        warnings: result.manifest.warnings,
        counts: result.manifest.counts,
      });
      print(output, summary, arguments_.json);
      return 0;
    } finally {
      admission.release();
    }
  }
  if (arguments_.command === "doctor") {
    return doctor(arguments_, environment, output, dependencies);
  }
  if (arguments_.command === "capabilities") {
    return runCapabilities(
      arguments_,
      environment,
      output,
      dependencies.providerPluginRegistry,
    );
  }
  if (arguments_.command === "plugin-list") {
    return await runPluginList(
      arguments_,
      environment,
      output,
      dependencies.providerPluginRegistry,
    );
  }
  if (arguments_.command === "plugin-show") {
    return await runPluginShow(
      arguments_,
      environment,
      output,
      dependencies.providerPluginRegistry,
    );
  }
  if (arguments_.command === "platforms") {
    if (arguments_.json) {
      output.stdout(safeJson(platformPolicyView(arguments_.surfaceId)));
    } else {
      output.stdout(
        sanitizeTerminalText(
          redactSensitiveText(renderPlatformPolicyText(arguments_.surfaceId)),
        ),
      );
    }
    return 0;
  }
  if (arguments_.command === "thread-split") return runThreadSplit(arguments_, output);
  if (arguments_.command === "thread-publish") {
    return runThreadPublish(
      arguments_,
      environment,
      output,
      dependencies.providerPluginRegistry,
    );
  }
  if (arguments_.command === "auth-login") {
    const login = await loginGoogleOAuth({
      clientFile: resolve(arguments_.clientFile),
      openBrowser: arguments_.openBrowser,
      onAuthorizationUrl: (url) => {
        output.stderr(
          `Approve Google access in your system browser. If it did not open, use this one-time URL:\n${safe(url)}\n`,
        );
      },
      ...(signal === undefined ? {} : { signal }),
    });
    const installed = installManagedGoogleOAuth(
      arguments_.id,
      login,
      environment,
      arguments_.force ? { force: true } : {},
    );
    const result = {
      ok: true,
      id: installed.auth.id,
      provider: installed.auth.provider,
      subject: installed.auth.subject,
      scopes: installed.auth.scopes,
      renewal: "automatic",
      refreshExpiresAt: login.refreshTokenExpiresAt,
    } as const;
    // This bounded view contains intentionally exposed, validated auth metadata
    // and no credential or token-file fields. Keep its public scope identifiers
    // exact instead of passing them through the generic URL credential redactor.
    if (arguments_.json) output.stdout(exactTerminalJson(result));
    else {
      output.stdout(
        `Connected ${safe(login.subject)} as ${safe(arguments_.id)}. Wrench will renew Google access automatically.\n`,
      );
    }
    if (login.refreshTokenExpiresAt !== null) {
      output.stderr(
        `Google made this refresh credential time-limited until ${safe(login.refreshTokenExpiresAt)}. Publish the personal OAuth app to production and repeat with --force for durable renewal.\n`,
      );
    }
    return 0;
  }
  if (arguments_.command === "auth-list") {
    const values = listAuth(environment).map((auth) => ({
      id: auth.id,
      kind: auth.kind,
      realmFingerprint: sha256(canonicalJson(auth)).slice(0, 16),
      subject: auth.subject ?? null,
      ...(auth.kind === "cookie-source" ? { source: auth.source, profile: auth.profile ?? null } : {}),
      ...(auth.kind === "browser-profile" ? {
        trustUnfilteredEgress: true,
        ...(auth.cookieSource === undefined ? {} : { cookieSource: auth.cookieSource }),
        ...(auth.cookieProfile === undefined ? {} : { cookieProfile: auth.cookieProfile }),
      } : {}),
      ...(auth.kind === "oauth-token-file" ? {
        provider: auth.provider,
        scopes: auth.scopes,
        managed: auth.managed === true,
      } : {}),
      ...(auth.kind === "linked-device-store" ? {
        provider: auth.provider,
      } : {}),
    }));
    if (arguments_.json) output.stdout(exactTerminalJson({ ok: true, auth: values }));
    else print(output, values, false);
    return 0;
  }
  if (arguments_.command === "auth-bind") {
    const authSnapshot = loadAuthSnapshot(arguments_.id, environment);
    const auth = authSnapshot.auth;
    const binding = dependencies.providerPluginRegistry.requireSessionRoute(
      arguments_.site,
    );
    requireProviderPluginAuth(binding, auth);
    const portableIdentity =
      portableProviderPluginSubjectProbeIdentity(binding);
    const lease = portableIdentity === null
      ? null
      : acquirePortableProviderPluginInvocationLease(
          portableIdentity,
          crypto.randomUUID(),
          environment,
        );
    const containment = lease === null
      ? null
      : createPortableProviderPluginInvocationLeaseContainmentController(
          lease,
          environment,
        );
    try {
      const subject = await dependencies.probePluginSubject(
        binding,
        auth,
        signal,
      );
      if (!binding.subject.matches(subject)) {
        throw new Error(
          `provider plugin surface ${binding.surfaceId} returned a subject outside ${binding.subject.format}`,
        );
      }
      if (
        auth.subject !== undefined
        && auth.subject !== subject
        && !arguments_.force
      ) {
        throw new Error("auth locator is already bound to a different account; repeat with --force only after reviewing the active signed-in account");
      }
      const bound = { ...auth, subject } satisfies WrenchAuth;
      await dependencies.beforeAuthBindCommit();
      if (!replaceAuthIfUnchanged(
        authSnapshot,
        bound,
        environment,
      ).replaced) {
        throw new Error(
          `auth locator ${auth.id} changed while its account was being probed; the concurrent value was preserved`,
        );
      }
      print(output, {
        ok: true,
        id: bound.id,
        site: arguments_.site,
        subject: bound.subject,
        realmFingerprint: sha256(canonicalJson(bound)).slice(0, 16),
      }, arguments_.json);
      return 0;
    } finally {
      if (containment !== null) {
        containment.cleanupComplete();
        releasePortableProviderPluginInvocationLease(
          containment.current,
          environment,
        );
      }
    }
  }
  if (arguments_.command === "auth-pair") {
    const auth = loadAuth(arguments_.id, environment);
    if (auth.kind !== "linked-device-store") {
      throw new Error("auth pair requires a linked-device-store locator");
    }
    const binding = dependencies.providerPluginRegistry.requireSessionRoute(
      auth.provider,
    );
    if (binding.transport !== "linked-device") {
      throw new Error(
        `provider plugin surface ${auth.provider} is not a linked-device transport`,
      );
    }
    requireProviderPluginAuth(binding, auth);
    if (binding.linkedDeviceLifecycle === undefined) {
      throw new Error(
        `provider plugin surface ${auth.provider} does not declare pairing`,
      );
    }
    output.stdout(
      `Starting explicit ${safe(auth.provider)} linked-device pairing. This creates a separate device session and performs a bounded bootstrap sync; it does not reuse browser cookies.\n`,
    );
    const paired = await runLinkedDevicePairLifecycle(
      binding,
      auth.id,
      {
        registry: dependencies.providerPluginRegistry,
        environment,
        ...(arguments_.phone === undefined
          ? {}
          : { phone: arguments_.phone }),
        ...(signal === undefined ? {} : { signal }),
        invokePair: dependencies.pairLinkedDeviceAuth,
      },
    );
    output.stdout(
      `Paired and bound ${safe(auth.id)} to ${safe(paired.subject)}. Use 'wrench auth sync ${safe(auth.id)} --once' when you explicitly want to refresh its local projection.\n`,
    );
    return 0;
  }
  if (arguments_.command === "auth-sync") {
    const auth = loadAuth(arguments_.id, environment);
    if (
      auth.kind !== "linked-device-store"
      || auth.subject === undefined
    ) {
      throw new Error(
        "auth sync requires a paired and account-bound linked-device-store locator",
      );
    }
    const binding = dependencies.providerPluginRegistry.requireSessionRoute(
      auth.provider,
    );
    if (
      binding.transport !== "linked-device"
      || binding.linkedDeviceLifecycle === undefined
    ) {
      throw new Error(
        `provider plugin surface ${auth.provider} does not declare one-shot linked-device sync`,
      );
    }
    requireProviderPluginAuth(binding, auth);
    if (!binding.subject.matches(auth.subject)) {
      throw new Error(
        `auth subject does not match ${binding.subject.format}`,
      );
    }
    output.stderr(
      `${auth.provider} sync explicitly connects the linked device and may emit protocol transport acknowledgements according to its registered lifecycle contract.\n`,
    );
    const lifecycle = await runLinkedDeviceSyncOnceLifecycle(
      binding,
      auth.id,
      {
        registry: dependencies.providerPluginRegistry,
        environment,
        ...(signal === undefined ? {} : { signal }),
        invokeSyncOnce: dependencies.syncLinkedDeviceAuthOnce,
      },
    );
    const result = lifecycle.result;
    print(output, {
      ok: true,
      id: auth.id,
      subject: auth.subject,
      itemsStored: result.itemsStored,
      // Compatibility field for the bundled WhatsApp projection.
      ...(auth.provider === "whatsapp"
        ? { messagesStored: result.itemsStored }
        : {}),
      projection: result.projection,
      presenceMode: "quiet",
      emitsProtocolAcknowledgements: result.emitsProtocolAcknowledgements,
    }, arguments_.json);
    return 0;
  }
  if (arguments_.command === "auth-add") {
    const auth = arguments_.linkedDeviceProvider !== undefined
      ? createAuth(arguments_.id, {
        linkedDeviceProvider: arguments_.linkedDeviceProvider,
        deviceStore: arguments_.deviceStore === undefined
          ? join(
            wrenchStateHome(environment),
            "linked-device-stores",
            arguments_.id,
          )
          : resolve(arguments_.deviceStore),
        ...(arguments_.subject === undefined ? {} : { subject: arguments_.subject }),
      })
      : arguments_.oauthProvider !== undefined
      ? createAuth(arguments_.id, {
        oauthProvider: arguments_.oauthProvider,
        tokenFile: arguments_.tokenFile ?? "",
        scopes: arguments_.scopes ?? [],
        ...(arguments_.subject === undefined ? {} : { subject: arguments_.subject }),
      })
      : arguments_.browserProfile !== undefined
        ? createAuth(arguments_.id, {
          browserProfile: arguments_.browserProfile,
          ...(arguments_.browserExecutable === undefined
            ? {}
            : { browserExecutable: arguments_.browserExecutable }),
          trustUnfilteredEgress: arguments_.trustProfileEgress,
          ...(arguments_.cookieSource === undefined ? {} : { cookieSource: arguments_.cookieSource }),
          ...(arguments_.cookieProfile === undefined ? {} : { cookieProfile: arguments_.cookieProfile }),
          ...(arguments_.subject === undefined ? {} : { subject: arguments_.subject }),
        })
        : arguments_.cookieSource !== undefined
          ? createAuth(arguments_.id, {
            source: arguments_.cookieSource,
            ...(arguments_.cookieProfile === undefined ? {} : { profile: arguments_.cookieProfile }),
            ...(arguments_.subject === undefined ? {} : { subject: arguments_.subject }),
          })
          : arguments_.cookiesFile !== undefined
            ? createAuth(arguments_.id, {
              cookiesFile: resolve(arguments_.cookiesFile),
              ...(arguments_.subject === undefined ? {} : { subject: arguments_.subject }),
            })
            : (() => { throw new Error("auth add has no selected locator"); })();
    const path = saveAuth(auth, environment, { force: arguments_.force });
    output.stdout(`Saved ${safe(auth.id)} auth locator (${auth.kind}) to ${safe(path)}.\n`);
    if (auth.kind === "linked-device-store") {
      const binding = dependencies.providerPluginRegistry.resolveSessionRoute(
        auth.provider,
      );
      if (
        binding?.transport === "linked-device"
        && binding.linkedDeviceLifecycle !== undefined
      ) {
        output.stdout(
          `Next: wrench auth pair ${safe(auth.id)} (optionally add --phone <international-number>).\n`,
        );
      } else {
        output.stdout(
          `Next: wrench auth bind ${safe(auth.id)} --site ${safe(auth.provider)}.\n`,
        );
      }
    }
    return 0;
  }
  if (arguments_.command === "auth-remove") {
    if (!arguments_.yes) {
      throw new Error(
        "auth remove requires --yes; this removes the locator, any Wrench-managed OAuth credential, and local caches, but does not revoke browser or provider-side grants",
      );
    }
    const removed = removeAuth(arguments_.id, environment);
    output.stdout(removed ? `Removed auth locator ${safe(arguments_.id)}.\n` : `Auth locator ${safe(arguments_.id)} was not present.\n`);
    return 0;
  }
  if (arguments_.command === "plugin-init") {
    const result = initPortableProviderPlugin({
      id: arguments_.id,
      displayName: arguments_.displayName,
      surfaceId: arguments_.surfaceId,
      origin: arguments_.origin,
      operation: arguments_.operation,
      transport: arguments_.transport,
      ...(arguments_.requiredScopeSets === undefined
        ? {}
        : { requiredScopeSets: arguments_.requiredScopeSets }),
      ...(arguments_.coverage === undefined
        ? {}
        : { coverage: arguments_.coverage }),
      output: resolve(arguments_.output),
    });
    if (arguments_.json) {
      print(output, { ok: true, ...result }, true);
    } else {
      output.stdout(
        `Created inert portable plugin ${safe(result.manifest.id)} at ${safe(result.path)}.\n`,
      );
      output.stdout(
        `Next: wrench plugin check ${safe(result.path)} && wrench plugin test ${safe(result.path)}\n`,
      );
    }
    return 0;
  }
  if (arguments_.command === "plugin-scaffold") {
    const outputDirectory = resolve(arguments_.output);
    const files = scaffoldWebProvider({
      site: arguments_.site,
      displayName: arguments_.displayName,
      origin: arguments_.origin,
      operation: arguments_.operation,
      risk: arguments_.risk,
      evidencePath: resolve(arguments_.evidence),
      candidateIndex: arguments_.candidate,
      outputDirectory,
    });
    const pluginId = `${arguments_.site}-web`;
    const result = {
      status: "capture-required",
      executable: false,
      pluginId,
      outputDirectory,
      files: files.map((file) => file.slice(outputDirectory.length + 1)),
      next:
        `Review the source unit at src/plugins/${pluginId}, then run 'wrench plugin check src/plugins/${pluginId}'; the scaffold performs no request and contains no browser action.`,
    } as const;
    if (arguments_.json) {
      print(output, result, true);
    } else {
      output.stdout(
        `Created network-inert capture-required source plugin ${safe(pluginId)} at ${safe(outputDirectory)}.\n`,
      );
      for (const file of result.files) output.stdout(`- ${safe(file)}\n`);
      output.stdout(`${safe(result.next)}\n`);
    }
    return 0;
  }
  if (arguments_.command === "plugin-check") {
    const directory = resolve(arguments_.path);
    if (
      existsSync(join(directory, PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME))
      || existsSync(join(directory, LEGACY_PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME))
    ) {
      const result = checkPortableProviderPlugin(directory);
      if (arguments_.json) {
        print(output, { ok: true, plugin: result }, true);
      } else {
        output.stdout(
          `Checked portable provider plugin ${safe(result.id)} ${safe(result.bundleSha256)} at ${safe(result.path)}.\n`,
        );
        output.stdout(
          `Activation: ${result.activation}; execution requires explicit trust at install.\n`,
        );
      }
      return 0;
    }
    const result = checkSourceProviderPluginDirectory(directory);
    if (arguments_.json) {
      print(output, result, true);
    } else {
      output.stdout(
        `Checked source provider plugin ${safe(result.pluginId)} at ${safe(result.directory)}.\n`,
      );
      output.stdout("State: capture-required; executable: no.\n");
      for (const file of result.files) output.stdout(`- ${safe(file)}\n`);
    }
    return 0;
  }
  if (arguments_.command === "plugin-test") {
    const result = await testPortableProviderPlugin(
      resolve(arguments_.path),
      { trustExecutableCode: arguments_.trustCode },
    );
    print(
      output,
      arguments_.json
        ? result
        : `Portable plugin ${result.pluginId}: ${result.inert} inert reservation(s), ${result.executed} secret-free fixture(s) passed.`,
      arguments_.json,
    );
    return 0;
  }
  if (arguments_.command === "plugin-pack") {
    const result = packPortableProviderPlugin(
      resolve(arguments_.path),
      resolve(arguments_.output),
    );
    print(
      output,
      arguments_.json
        ? { ok: true, ...result }
        : `Packed immutable portable plugin ${result.bundleSha256} at ${result.path}.`,
      arguments_.json,
    );
    return 0;
  }
  if (arguments_.command === "plugin-install") {
    const packagePath = resolve(arguments_.path);
    const checked = checkPortableProviderPlugin(packagePath);
    if (dependencies.providerPluginRegistry.get(checked.id) !== undefined) {
      throw new Error(
        `portable plugin ${checked.id} conflicts with a trusted source plugin ID`,
      );
    }
    const current = showPortableProviderPlugin(checked.id, environment);
    const currentDigest = current?.summary.bundleSha256;
    if (
      arguments_.expectedCurrent !== undefined
      && arguments_.expectedCurrent !== currentDigest
    ) {
      throw new Error(
        `portable plugin ${checked.id} changed from --expected-current`,
      );
    }
    const installed = installPortableProviderPlugin(packagePath, {
      trustExecutableCode: arguments_.trustCode,
      expectedCurrentBundleSha256:
        arguments_.expectedCurrent ?? currentDigest ?? null,
      assertActivatable: (candidate) =>
        assertPortableProviderPluginActivatable(
          candidate,
          dependencies.providerPluginRegistry,
          environment,
        ),
      assertCurrentQuiescent: (bundleSha256, artifactPath) =>
        assertPortableProviderPluginQuiescent(
          bundleSha256,
          artifactPath,
          environment,
        ),
      environment,
    });
    print(
      output,
      arguments_.json
        ? { ok: true, plugin: installed }
        : `Trusted and enabled portable plugin ${installed.id} ${installed.bundleSha256}.`,
      arguments_.json,
    );
    return 0;
  }
  if (arguments_.command === "plugin-doctor") {
    const report = doctorPortableProviderPlugins(environment);
    print(
      output,
      arguments_.json
        ? report
        : report.ok
          ? `Portable plugin store: ${report.installed} installation(s) verified.`
          : `Portable plugin store is invalid: ${report.issues.join("; ")}`,
      arguments_.json,
    );
    return report.ok ? 0 : 3;
  }
  if (
    arguments_.command === "plugin-disable"
    || arguments_.command === "plugin-remove"
  ) {
    if (
      arguments_.command === "plugin-remove"
      && !arguments_.yes
    ) {
      throw new Error(
        "plugin remove requires --yes; activation is removed while immutable trust and artifact evidence are retained",
      );
    }
    const current = showPortableProviderPlugin(arguments_.id, environment);
    if (current === null) {
      throw new Error(`portable plugin ${arguments_.id} is not installed`);
    }
    if (
      arguments_.expectedCurrent !== undefined
      && arguments_.expectedCurrent
        !== current.summary.bundleSha256
    ) {
      throw new Error(
        `portable plugin ${arguments_.id} changed from --expected-current`,
      );
    }
    const expectedBundleSha256 =
      arguments_.expectedCurrent ?? current.summary.bundleSha256;
    const result = arguments_.command === "plugin-disable"
      ? disablePortableProviderPlugin(arguments_.id, {
          expectedBundleSha256,
          assertQuiescent: (bundleSha256, artifactPath) =>
            assertPortableProviderPluginQuiescent(
              bundleSha256,
              artifactPath,
              environment,
            ),
          environment,
        })
      : removePortableProviderPlugin(arguments_.id, {
          expectedBundleSha256,
          assertQuiescent: (bundleSha256, artifactPath) =>
            assertPortableProviderPluginQuiescent(
              bundleSha256,
              artifactPath,
              environment,
            ),
          environment,
        });
    print(
      output,
      arguments_.json
        ? { ok: true, plugin: result }
        : arguments_.command === "plugin-disable"
          ? `Disabled portable plugin ${result.id} ${result.bundleSha256}.`
          : `Removed portable plugin ${result.id} activation; immutable audit bytes were retained.`,
      arguments_.json,
    );
    return 0;
  }
  if (arguments_.command === "adapter-init") {
    const directory = resolve(arguments_.output);
    const path = join(directory, "wrench-adapter.json");
    const manifest = arguments_.target.kind === "origin"
      ? emptyManifest(arguments_.id, arguments_.target.origin)
      : manifestFromPlatform(arguments_.id, arguments_.target.surfaceId);
    if (arguments_.force) writePrivateJson(path, manifest);
    else if (!createPrivateJsonIfAbsent(path, manifest).created) throw new Error(`manifest already exists: ${path}`);
    output.stdout(`Created adapter manifest ${safe(path)}.\n`);
    if (arguments_.target.kind === "platform") {
      output.stdout(`Copied reviewed ${safe(arguments_.target.surfaceId)} origins into an empty, uninstalled manifest; no capability was created.\n`);
      if (socialPlatformCatalog[arguments_.target.surfaceId].originPolicy.additionalExactOrigins.state === "adapter-declared") {
        output.stdout("No custom publication origin was inferred; initialize that exact HTTPS origin with --origin instead.\n");
      }
    }
    return 0;
  }
  if (arguments_.command === "adapter-sync-bundled") {
    const { syncBundledAdapters } = await import(
      "./scripts/sync-bundled-adapters"
    );
    const result = await syncBundledAdapters({
      environment,
      output: arguments_.json
        ? { stdout: () => {}, stderr: output.stderr }
        : output,
    });
    if (arguments_.json) {
      print(output, { ok: true, ...result }, true);
    } else {
      output.stdout(
        `Bundled adapter generation ${safe(result.commitId)} installed ${String(result.installed)} and preserved ${String(result.preserved)}.\n`,
      );
    }
    return 0;
  }
  if (arguments_.command === "adapter-validate") {
    const result = readManifestFile(
      resolve(arguments_.path),
      dependencies.providerPluginRegistry,
    );
    print(output, result.ok
      ? {
          ok: true,
          id: result.value.id,
          version: result.value.version,
          surfaceId: result.value.surfaceId ?? null,
          manifestHash: manifestHash(result.value),
          operations: Object.keys(result.value.operations),
        }
      : { ok: false, issues: result.issues }, arguments_.json);
    return result.ok ? 0 : 2;
  }
  if (arguments_.command === "adapter-install") {
    const installed = withPortableProviderPluginCatalogLock(
      portableProviderPluginStoreRoot(environment),
      new Date(),
      () => {
        const currentRegistry =
          dependencies.createPortableProviderPluginCatalog(
          dependencies.providerPluginRegistry,
          environment,
        ).registry;
        const result = readManifestFile(
          resolve(arguments_.path),
          currentRegistry,
        );
        if (!result.ok) {
          throw new Error(`invalid manifest: ${result.issues.join("; ")}`);
        }
        if (
          currentRegistry.resolveOwnedManifest(
            result.value.id,
          ) !== undefined
        ) {
          throw new Error(
            `adapter ${result.value.id} is owned by an enabled portable provider plugin`,
          );
        }
        if (
          result.value.schemaVersion === 1
          && (
            result.value.id !== "linkedin"
            || manifestHash(result.value)
              !== WRENCH_LEGACY_LINKEDIN_MANIFEST_HASH
          )
        ) {
          throw new Error(
            "schemaVersion 1 installs are restricted to the exact archived LinkedIn v0.4.0 migration fixture",
          );
        }
        let force = arguments_.force;
        let expectedCurrentContentSha256: string | undefined;
        if (arguments_.upgradeFrom !== undefined) {
          const priors = arguments_.upgradeFrom.map((path) => {
            const prior = readDiagnosticManifestFile(
              resolve(path),
              currentRegistry,
            );
            if (!prior.ok) {
              throw new Error(
                `invalid prior bundled manifest: ${prior.issues.join("; ")}`,
              );
            }
            if (prior.value.id !== result.value.id) {
              throw new Error(
                "--upgrade-from manifests must have the same adapter ID",
              );
            }
            return prior.value;
          });
          const priorHashes = new Set(
            priors.map((prior) => manifestHash(prior)),
          );
          if (priorHashes.size !== priors.length) {
            throw new Error(
              "--upgrade-from manifests must identify distinct adapter versions",
            );
          }
          const installedSnapshot =
            loadInstalledDiagnosticManifestSnapshot(
              result.value.id,
              environment,
              currentRegistry,
            );
          const current = installedSnapshot.result;
          force = current.ok
            && priorHashes.has(manifestHash(current.value));
          if (force) {
            if (installedSnapshot.contentSha256 === null) {
              throw new Error(
                "installed adapter snapshot omitted its content hash",
              );
            }
            expectedCurrentContentSha256 =
              installedSnapshot.contentSha256;
          }
          if (
            current.ok
            && !force
            && manifestHash(current.value) !== manifestHash(result.value)
          ) {
            throw new Error(
              `adapter ${result.value.id} differs from the current manifest and all upgrade baselines; preserved the user-modified install`,
            );
          }
        }
        const path = installManifest(result.value, {
          force,
          environment,
          registry: currentRegistry,
          ...(expectedCurrentContentSha256 === undefined
            ? {}
            : { expectedCurrentContentSha256 }),
        });
        return Object.freeze({ id: result.value.id, path });
      },
    );
    output.stdout(
      `Installed ${safe(installed.id)} at ${safe(installed.path)}.\n`,
    );
    return 0;
  }
  if (arguments_.command === "adapter-remove") {
    if (!arguments_.yes) {
      throw new Error(
        "adapter remove requires --yes; existing previews for it will fail closed",
      );
    }
    const removed = withPortableProviderPluginCatalogLock(
      portableProviderPluginStoreRoot(environment),
      new Date(),
      () => removeInstalledManifest(arguments_.id, environment),
    );
    output.stdout(removed ? `Removed adapter ${safe(arguments_.id)}.\n` : `Adapter ${safe(arguments_.id)} was not present.\n`);
    return 0;
  }
  if (arguments_.command === "derive-start") {
    const auth = loadAuth(arguments_.authId, environment);
    if (auth.kind === "oauth-token-file") {
      throw new Error(
        `auth locator ${auth.id} is for official ${auth.provider} API capabilities and cannot start an agent-browser derivation; use cookie/profile auth`,
      );
    }
    if (auth.kind === "linked-device-store") {
      throw new Error(
        `auth locator ${auth.id} is a ${auth.provider} linked-device protocol realm and cannot start an agent-browser derivation`,
      );
    }
    const session = await startDerivation(
      arguments_.adapterId,
      arguments_.url,
      auth,
      {
        allowRemoteActions: arguments_.allowRemoteActions,
        contentMode: arguments_.contentMode,
        browserDomains: arguments_.browserDomains,
        cookieOrigins: arguments_.cookieOrigins,
        fixtureSources: arguments_.fixtureSources,
        headed: arguments_.headed,
        environment,
      },
    );
    output.stdout(safeJson({
      ok: true,
      derivationId: session.id,
      targetOrigin: session.targetOrigin,
      allowRemoteActions: session.allowRemoteActions,
      contentMode: session.contentMode,
      fixtures: derivationFixtureSummaries(session.fixtures),
      domainContainment: session.profilePath === null,
      browserDomains: session.browserDomains,
      next: [
        `wrench derive browser ${session.id} -- snapshot -i`,
        `wrench derive review ${session.id} --limit 50 --json`,
        `wrench derive finish ${session.id} --output ./wrench-${session.adapterId}`,
      ],
      warning: session.profilePath === null
        ? "Page loads can cause background writes such as read receipts. Private review seals the recorder; raw HAR data remains task-owned temporary state and is deleted at finish/discard."
        : "This profile-backed browser has unfiltered egress; browserDomains is review metadata, not network containment. Page loads can contact other origins and cause background writes such as read receipts. Private review seals the recorder; raw HAR data remains task-owned temporary state and is deleted at finish/discard.",
    }));
    return 0;
  }
  if (arguments_.command === "derive-list") {
    const values = listDerivations(environment);
    print(output, arguments_.json ? { ok: true, derivations: values } : values, arguments_.json);
    return 0;
  }
  if (arguments_.command === "derive-browser") {
    const result = await runDerivationBrowserCommand(arguments_.id, arguments_.browserArguments, environment);
    print(output, result, arguments_.json);
    return 0;
  }
  if (arguments_.command === "derive-review") {
    let selection: DerivationReviewSelection;
    if (arguments_.selection.kind === "entry") {
      let fixtures: DerivationReviewFixtures = {};
      if (arguments_.selection.fixtures) {
        let value: unknown;
        try {
          value = JSON.parse(await readStdinBounded(64 * 1024)) as unknown;
        } catch {
          throw new Error("derive review fixtures must be valid UTF-8 JSON on stdin");
        }
        fixtures = parseDerivationReviewFixtures(value);
      }
      selection = { kind: "entry", entryIndex: arguments_.selection.entryIndex, fixtures };
    } else selection = arguments_.selection;
    const result = await reviewDerivation(
      arguments_.id,
      selection,
      environment,
      arguments_.reviewOrigin,
    );
    print(output, { ok: true, sealed: true, ...result }, arguments_.json);
    return 0;
  }
  if (arguments_.command === "derive-finish") {
    const result = await finishDerivation(arguments_.id, arguments_.output, {
      force: arguments_.force,
      registry: dependencies.providerPluginRegistry,
      ...(arguments_.surfaceId === undefined ? {} : { surfaceId: arguments_.surfaceId }),
      environment,
    });
    print(output, {
      ok: true,
      observedEntries: result.analysis.observedEntries,
      candidates: result.analysis.candidates.length,
      manifestPath: result.manifestPath,
      candidatesPath: result.candidatesPath,
      internalApiCandidates: result.internalEvidence.candidates.length,
      evidencePath: result.evidencePath,
      reservationPath: result.reservationPath,
      rawHarRetained: false,
      next: [
        `Review ${result.reservationPath}`,
        `Edit ${result.manifestPath} only after exact request/response review`,
        `wrench adapter validate ${result.manifestPath}`,
        `wrench adapter install ${result.manifestPath}`,
      ],
    }, arguments_.json);
    return 0;
  }
  if (arguments_.command === "derive-discard") {
    if (!arguments_.yes) throw new Error("derive discard requires --yes because it deletes the private session and raw HAR");
    const discarded = await discardDerivation(arguments_.id, environment);
    output.stdout(discarded ? "Discarded the derivation and deleted its private artifacts.\n" : "Derivation was not present.\n");
    return 0;
  }
  if (arguments_.command === "derive-analyze") {
    const analysis = analyzeHarFile(resolve(arguments_.har), arguments_.adapterId, arguments_.origin);
    const result = writeDerivationScaffold(arguments_.output, analysis, {
      force: arguments_.force,
      registry: dependencies.providerPluginRegistry,
      ...(arguments_.surfaceId === undefined ? {} : { surfaceId: arguments_.surfaceId }),
    });
    print(output, { ok: true, observedEntries: analysis.observedEntries, candidates: analysis.candidates.length, ...result }, arguments_.json);
    return 0;
  }
  if (arguments_.command === "omni-read") {
    const request = await readInput(arguments_.inputSource);
    const common = {
      environment,
      registry: dependencies.providerPluginRegistry,
    } as const;
    const value = arguments_.identityOnly
      ? dependencies.identifyOmniView(request, common)
      : arguments_.cacheOnly
        ? dependencies.readCachedOmniViewInternal(request, common)
        : arguments_.fromExactCache
          ? dependencies.rebuildOmniViewFromExactCache(request, common)
          : await dependencies.revalidateOmniViewInternal(request, {
              ...common,
              headed: arguments_.headed,
              ...(signal === undefined ? {} : { signal }),
            });
    if (arguments_.json) output.stdout(exactTerminalJson(value));
    else print(output, value, false);
    return 0;
  }
  if (arguments_.command === "invoke") {
    if (arguments_.duplicateRiskOf.length > 0 && !arguments_.preview) {
      throw new Error("--duplicate-risk-of requires an explicit --preview");
    }
    const invocation = prepareInvocation(
      arguments_.adapterId,
      arguments_.operationId,
      await readInput(arguments_.inputSource),
      arguments_.authId,
      environment,
      dependencies.providerPluginRegistry,
    );
    const operation = invocation.manifest.operations[arguments_.operationId];
    if (operation === undefined) throw new Error("operation disappeared before invocation");
    if (operation.risk === "R4") {
      throw new Error("R4 capabilities are blocked by wrench");
    }
    if (arguments_.cacheOnly && operation.risk !== "R1") {
      throw new Error("invoke --cache-only is available only for R1 capabilities");
    }
    if (arguments_.projectionIdentityOnly && operation.risk !== "R1") {
      throw new Error("invoke --projection-identity-only is available only for R1 capabilities");
    }
    if (operation.risk === "R1") {
      if (arguments_.duplicateRiskOf.length > 0) {
        throw new Error(
          "--duplicate-risk-of is available only for one-dispatch R3 web-session posts.publish mutations",
        );
      }
      if (arguments_.projectionIdentityOnly) {
        const inputHash = sha256(canonicalJson(invocation.input));
        const authIdentity = invocation.readProjectionAuthIdentityHash;
        if (
          authIdentity === undefined
          || !/^[a-f0-9]{64}$/u.test(authIdentity)
        ) {
          throw new Error(
            "prepared invocation is missing its auth lifetime identity; prepare it again",
          );
        }
        const authHash = sha256(canonicalJson(invocation.auth));
        if (invocation.auth.subject === undefined) {
          const view = {
            ok: true,
            source: "projection-identity",
            status: "unbound",
            authIdentity,
            authHash,
            inputHash,
          };
          if (arguments_.json) output.stdout(exactTerminalJson(view));
          else print(output, view, false);
          return 0;
        }
        const query = createReadProjectionQueryForInvocation(
          invocation,
          environment,
          dependencies.providerPluginRegistry,
        );
        const view = {
          ok: true,
          source: "projection-identity",
          status: "ready",
          authIdentity,
          authHash,
          inputHash,
          projection: { key: query.key },
        };
        if (arguments_.json) output.stdout(exactTerminalJson(view));
        else print(output, view, false);
        return 0;
      }
      if (arguments_.preview) {
        printPreview(output, directPreviewView(invocation), arguments_.json);
        return 0;
      }
      if (arguments_.cacheOnly) {
        const result = dependencies.readCachedPreparedCapability(invocation, {
          environment,
          registry: dependencies.providerPluginRegistry,
        });
        const view = cachedInvocationView(result);
        if (arguments_.json) output.stdout(exactTerminalJson(view));
        else print(output, view, false);
        return result.status === "hit" ? 0 : 3;
      }
      const result = await dependencies.revalidatePreparedCapability(
        invocation,
        {
          headed: arguments_.headed,
          environment,
          registry: dependencies.providerPluginRegistry,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const view = revalidatedInvocationView(result);
      if (arguments_.json) output.stdout(exactTerminalJson(view));
      else print(output, view, false);
      return result.live.receipt.status === "succeeded" || result.live.receipt.status === "submitted" ? 0 : result.live.receipt.status === "indeterminate" ? 5 : 3;
    }
    const stored = createAndSaveInvocationPlan(
      invocation,
      environment,
      new Date(),
      dependencies.providerPluginRegistry,
      { duplicateRiskOf: arguments_.duplicateRiskOf },
    );
    printPreview(
      output,
      previewView(stored, invocation, arguments_.headed),
      arguments_.json,
    );
    return arguments_.preview ? 0 : 4;
  }
  if (arguments_.command === "confirm") {
    const result = await confirmInvocation(arguments_.digest, {
      headed: arguments_.headed,
      environment,
      registry: dependencies.providerPluginRegistry,
      ...(signal === undefined ? {} : { signal }),
    });
    print(output, invocationView(result), arguments_.json);
    return result.receipt.status === "succeeded" || result.receipt.status === "submitted" ? 0 : result.receipt.status === "indeterminate" ? 5 : 3;
  }
  if (arguments_.command === "runs-list") {
    repairInterruptedConfirmationClaims(environment);
    repairInterruptedRunJournals(environment);
    const receipts = listRunReceipts(environment);
    print(output, arguments_.json ? { ok: true, runs: receipts } : receipts, arguments_.json);
    return 0;
  }
  if (arguments_.command === "runs-reconcile") {
    const linkedDeviceJournal = readLinkedDeviceLifecycleJournal(
      arguments_.runId,
      environment,
    );
    if (linkedDeviceJournal !== null) {
      if (arguments_.inputSource === undefined) {
        throw new Error(
          "linked-device lifecycle reconciliation requires --input with an explicit observed outcome and evidence hash",
        );
      }
      const result = await dependencies
        .reconcileLinkedDeviceLifecycleJournal(
          arguments_.runId,
          await readInput(arguments_.inputSource),
          {
            environment,
            registry: dependencies.providerPluginRegistry,
          },
        );
      print(output, result, arguments_.json);
      return 0;
    }
    const claimRecovery = repairInterruptedConfirmationClaims(environment);
    const runRecovery = repairInterruptedRunJournals(environment);
    if (claimRecovery.invalid > 0 || runRecovery.issues.length > 0) {
      throw new Error(
        "local execution recovery has unresolved state; run wrench doctor before reconciliation",
      );
    }
    let receipt: ReturnType<typeof readRunReceipt> | null = null;
    try {
      receipt = readRunReceipt(arguments_.runId, environment);
    } catch {
      // The transport-specific reconciler remains responsible for reporting
      // missing, malformed, or legacy receipts. This probe only routes exact
      // schema-6 receipts to the portable evidence path.
    }
    if (
      receipt?.schemaVersion === 6
      && receipt.transport === "portable-provider-plugin"
    ) {
      if (arguments_.inputSource === undefined) {
        throw new Error(
          "portable plugin reconciliation requires --input with an explicit observed outcome and evidence hash",
        );
      }
      const result = dependencies.reconcilePortableProviderPluginRun(
        arguments_.runId,
        await readInput(arguments_.inputSource),
        {
          environment,
          registry: dependencies.providerPluginRegistry,
        },
      );
      print(output, result, arguments_.json);
      return 0;
    }
    const result = await dependencies.reconcileWebSessionRun(
      arguments_.runId,
      arguments_.inputSource === undefined
        ? undefined
        : await readInput(arguments_.inputSource),
      {
        environment,
        registry: dependencies.providerPluginRegistry,
      },
    );
    print(output, result, arguments_.json);
    return result.ok ? 0 : 5;
  }
  if (arguments_.command === "plans-list") {
    const plans = listInvocationPlans(environment);
    print(output, arguments_.json ? { ok: true, plans } : plans, arguments_.json);
    return 0;
  }
  if (arguments_.command === "plans-cancel") {
    if (!arguments_.yes) throw new Error("plans cancel requires --yes; cancellation permanently removes that encrypted preview");
    const removed = cancelInvocationPlan(arguments_.digest, environment);
    output.stdout(removed ? `Cancelled preview ${safe(arguments_.digest)}.\n` : `Preview ${safe(arguments_.digest)} was not present.\n`);
    return 0;
  }
  repairInterruptedConfirmationClaims(environment);
  repairInterruptedRunJournals(environment);
  const receipt = readRunReceipt(arguments_.runId, environment);
  print(output, receipt, arguments_.json);
  return 0;
}

export async function main(
  rawArguments: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  output: Output = defaultOutput,
  dependencyOverrides: Partial<WrenchDependencies> = {},
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseWrenchArguments(rawArguments);
  if (!parsed.ok) {
    output.stderr(
      `${safe(parsed.message)}\n\n${renderWrenchUsage()}`,
    );
    return 2;
  }
  try {
    let dependencies = resolveDependencies(dependencyOverrides);
    if (
      dependencyOverrides.providerPluginRegistry === undefined
      && commandUsesPortableProviderCatalog(parsed.value.command)
    ) {
      dependencies = {
        ...dependencies,
        providerPluginRegistry:
          dependencies.createPortableProviderPluginCatalog(
          dependencies.providerPluginRegistry,
          environment,
        ).registry,
      };
    }
    return await runCommand(
      parsed.value,
      environment,
      output,
      dependencies,
      signal,
    );
  } catch (error) {
    if (error instanceof LinkedDeviceLifecycleIndeterminateError) {
      const failure = {
        ok: false,
        status: "indeterminate",
        journalId: error.journalId,
      };
      if ("json" in parsed.value && parsed.value.json === true) {
        output.stdout(safeJson(failure));
      } else {
        output.stderr(`wrench: ${safe(error.message)}\n`);
      }
      return 5;
    }
    if (error instanceof PreservedBrowserArtifactsError) {
      const recoveryHandle = boundedCliRecoveryHandle(error.recoveryHandle);
      const failure = {
        ok: false,
        status: "indeterminate",
        privateArtifactsPreserved: true,
        error: safe(error.message),
        ...(recoveryHandle === null ? {} : { recoveryHandle }),
      };
      if ("json" in parsed.value && parsed.value.json === true) {
        // The recovery handle is an owned, bounded terminal-safe locator.
        // Generic redaction treats its `session=` field as a credential and
        // would destroy the only actionable cleanup handle.
        output.stdout(exactTerminalJson(failure));
      } else {
        output.stderr(
          `wrench: ${failure.error}${recoveryHandle === null
            ? "; recovery handle was unavailable; run wrench doctor before retrying"
            : `; recovery handle: ${recoveryHandle}`}\n`,
        );
      }
      return 5;
    }
    output.stderr(
      `wrench: ${safe(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 3;
  }
}

function commandUsesPortableProviderCatalog(
  command: WrenchArguments["command"],
): boolean {
  return command === "doctor"
    || command === "capabilities"
    || command === "adapter-validate"
    || command === "derive-analyze"
    || command === "derive-finish"
    || command === "thread-publish"
    || command === "auth-bind"
    || command === "auth-pair"
    || command === "auth-sync"
    || command === "omni-read"
    || command === "invoke"
    || command === "confirm"
    || command === "runs-reconcile";
}

const WRENCH_PROCESS_CLEANUP_PERSISTENCE_MARGIN_MS = 5_000;
const WRENCH_PROCESS_GRACEFUL_TERMINATION_TIMEOUT_MS =
  WEB_SESSION_CLEANUP_JOIN_TIMEOUT_MS
  + WRENCH_PROCESS_CLEANUP_PERSISTENCE_MARGIN_MS;

type WrenchProcessBoundaryDependencies = {
  readonly rawArguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly output: Output;
  readonly runMain: typeof main;
  readonly subscribeTermination: (
    terminate: (signal: NodeJS.Signals) => void,
  ) => () => void;
  readonly scheduleForcedTermination: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  readonly resendSignal: (signal: NodeJS.Signals) => void;
  readonly setExitCode: (code: number) => void;
};

function subscribeProcessTermination(
  terminate: (signal: NodeJS.Signals) => void,
): () => void {
  const onInterrupt = (): void => terminate("SIGINT");
  const onTerminate = (): void => terminate("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  };
}

function scheduleForcedTermination(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export async function runWrenchProcess(
  overrides: Partial<WrenchProcessBoundaryDependencies> = {},
): Promise<void> {
  const dependencies: WrenchProcessBoundaryDependencies = {
    rawArguments: overrides.rawArguments ?? process.argv.slice(2),
    environment: overrides.environment ?? process.env,
    output: overrides.output ?? defaultOutput,
    runMain: overrides.runMain ?? main,
    subscribeTermination:
      overrides.subscribeTermination ?? subscribeProcessTermination,
    scheduleForcedTermination:
      overrides.scheduleForcedTermination ?? scheduleForcedTermination,
    resendSignal:
      overrides.resendSignal ?? ((signal) => process.kill(process.pid, signal)),
    setExitCode:
      overrides.setExitCode ?? ((code) => {
        process.exitCode = code;
      }),
  };
  const controller = new AbortController();
  const terminationState: {
    cancelFallback: (() => void) | null;
  } = { cancelFallback: null };
  let unsubscribeTermination = (): void => undefined;
  let terminating = false;
  const terminate = (signal: NodeJS.Signals): void => {
    if (terminating) return;
    terminating = true;
    controller.abort();
    unsubscribeTermination();
    // Not every upstream browser/capture primitive accepts AbortSignal yet.
    // Leave a hard upper bound, but reserve enough time for the browser's
    // bounded TERM/KILL/stream, close, proxy, and recovery-handle joins. A
    // second OS signal uses its restored default disposition immediately.
    terminationState.cancelFallback = dependencies.scheduleForcedTermination(
      () => dependencies.resendSignal(signal),
      WRENCH_PROCESS_GRACEFUL_TERMINATION_TIMEOUT_MS,
    );
  };
  unsubscribeTermination = dependencies.subscribeTermination(terminate);
  try {
    dependencies.setExitCode(await dependencies.runMain(
      dependencies.rawArguments,
      dependencies.environment,
      dependencies.output,
      {},
      controller.signal,
    ));
  } finally {
    terminationState.cancelFallback?.();
    unsubscribeTermination();
  }
}

if (import.meta.main) {
  await runWrenchProcess();
}
