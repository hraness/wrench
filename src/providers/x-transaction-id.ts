import type { CookieRecordReader } from "@hraness/kb/clip/acquire";

import type { WrenchAuth } from "../auth";
import {
  browserResultData,
  createBrowserSession,
  PreservedBrowserArtifactsError,
  type BrowserSession,
} from "../browser";
import type { WrenchManifest } from "../model";
import type {
  WebSessionCleanupResourcePublisher,
  WebSessionOperationDeadline,
} from "../web-session-execution";

const X_ORIGIN = "https://x.com";
const X_TRANSACTION_DOCUMENT = `${X_ORIGIN}/home`;
const X_ASSET_ORIGIN = "https://abs.twimg.com";
const MAX_MAIN_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_EVALUATION_OUTPUT_BYTES = 64 * 1024;
const WEB_SESSION_OPERATION_LABEL = "authenticated web operation deadline";

const xTransactionBrowserManifest = Object.freeze({
  schemaVersion: 2,
  id: "wrench-x-transaction-bootstrap",
  version: "1.0.0",
  displayName: "Wrench X transaction bootstrap",
  origins: Object.freeze([X_ORIGIN]),
  browserDomains: Object.freeze(["x.com", "*.x.com", "abs.twimg.com"]),
  operations: Object.freeze({}),
} satisfies WrenchManifest);

export type XTransactionRuntimeIds = {
  readonly wrapperModuleId: number;
  readonly exportName: string;
  readonly chunkId: number;
  readonly moduleId: number;
};

export type XTransactionBrowserDependencies = {
  readonly createBrowserSession?: typeof createBrowserSession;
  readonly acquireCookieRecords?: CookieRecordReader;
};

function boundedWebpackId(value: string, label: string): number {
  if (!/^[1-9][0-9]{0,9}$/u.test(value)) throw new Error(`${label} is not a bounded webpack ID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error(`${label} is not a bounded webpack ID`);
  }
  return parsed;
}

/**
 * Locate only the lazy transaction generator referenced by X's current
 * first-party wrapper. Any minifier or module-layout drift fails closed.
 */
export function parseXTransactionRuntimeIds(mainBundleText: string): XTransactionRuntimeIds {
  if (mainBundleText.length < 1 || mainBundleText.length > MAX_MAIN_BUNDLE_BYTES) {
    throw new Error("X transaction bootstrap main bundle exceeded its reviewed byte limit");
  }
  const marker = "rweb_client_transaction_id_enabled";
  const firstMarker = mainBundleText.indexOf(marker);
  if (firstMarker < 0 || mainBundleText.indexOf(marker, firstMarker + marker.length) >= 0) {
    throw new Error("X transaction bootstrap did not expose one unique current wrapper");
  }
  const window = mainBundleText.slice(Math.max(0, firstMarker - 4_096), firstMarker + 4_096);
  if (!window.includes("x-client-transaction-id")) {
    throw new Error("X transaction bootstrap wrapper omitted its reviewed request header");
  }
  const references: { readonly chunk: string; readonly module: string }[] = [];
  const referencePattern = /([A-Za-z_$][A-Za-z0-9_$]*)\.e\(([1-9][0-9]{0,9})\)\.then\(\1\.bind\(\1,([1-9][0-9]{0,9})\)\)/gu;
  for (const match of window.matchAll(referencePattern)) {
    if (match[2] !== undefined && match[3] !== undefined) {
      references.push({ chunk: match[2], module: match[3] });
    }
  }
  if (references.length !== 1) {
    throw new Error("X transaction bootstrap did not expose one unique lazy runtime binding");
  }
  const markerInWindow = window.indexOf(marker);
  const beforeMarker = window.slice(0, markerInWindow);
  const modulePattern = /\},([1-9][0-9]{0,9})\(([A-Za-z_$][A-Za-z0-9_$]*),([A-Za-z_$][A-Za-z0-9_$]*),([A-Za-z_$][A-Za-z0-9_$]*)\)\{"use strict";/gu;
  const modules = [...beforeMarker.matchAll(modulePattern)];
  const wrapper = modules.at(-1);
  if (wrapper?.[1] === undefined || wrapper[3] === undefined || wrapper[4] === undefined) {
    throw new Error("X transaction bootstrap did not expose its current wrapper module");
  }
  const helperMatch = /\["x-client-transaction-id"\]=await ([A-Za-z_$][A-Za-z0-9_$]*)\(/u.exec(window);
  const helperName = helperMatch?.[1];
  if (helperName === undefined) {
    throw new Error("X transaction bootstrap did not expose its current wrapper helper");
  }
  const exportMapPattern = new RegExp(`${wrapper[4]}\\.d\\(${wrapper[3]},\\{([^}]{1,2048})\\}\\)`, "u");
  const exportMap = exportMapPattern.exec(window)?.[1];
  if (exportMap === undefined) throw new Error("X transaction bootstrap did not expose its wrapper exports");
  const escapedHelper = helperName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exportMatches = [...exportMap.matchAll(new RegExp(`(?:^|,)([A-Za-z_$][A-Za-z0-9_$]*):\\(\\)=>${escapedHelper}(?=,|$)`, "gu"))];
  const exportName = exportMatches.length === 1 ? exportMatches[0]?.[1] : undefined;
  if (exportName === undefined) {
    throw new Error("X transaction bootstrap did not expose one unique exported wrapper helper");
  }
  const reference = references[0]!;
  return Object.freeze({
    wrapperModuleId: boundedWebpackId(wrapper[1], "X transaction wrapper module ID"),
    exportName,
    chunkId: boundedWebpackId(reference.chunk, "X transaction chunk ID"),
    moduleId: boundedWebpackId(reference.module, "X transaction module ID"),
  });
}

function exactMutationPath(value: string): string {
  if (!/^\/i\/api\/graphql\/[A-Za-z0-9_-]{8,128}\/[A-Za-z][A-Za-z0-9_]{1,127}$/u.test(value)) {
    throw new Error("X transaction bootstrap path is not one exact reviewed GraphQL mutation");
  }
  return value;
}

function exactMainBundlePath(value: string | URL): string {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error("X transaction bootstrap main bundle URL is invalid");
  }
  if (
    url.origin !== X_ASSET_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !/^\/responsive-web\/client-web\/main\.[A-Za-z0-9_-]{6,128}\.js$/u.test(url.pathname)
  ) throw new Error("X transaction bootstrap main bundle URL escaped its reviewed asset path");
  return url.pathname;
}

function containedBrowserAuth(auth: WrenchAuth): WrenchAuth {
  if (auth.kind === "cookie-source" || auth.kind === "cookies-file") return auth;
  if (auth.kind === "browser-profile" && auth.cookieSource !== undefined) {
    return {
      schemaVersion: 1,
      id: auth.id,
      kind: "cookie-source",
      source: auth.cookieSource,
      ...(auth.cookieProfile === undefined ? {} : { profile: auth.cookieProfile }),
      ...(auth.subject === undefined ? {} : { subject: auth.subject }),
    };
  }
  throw new Error("X transaction bootstrap requires target-filtered cookie auth");
}

function transactionEvaluationSource(input: {
  readonly method: "POST";
  readonly path: string;
  readonly mainBundlePath: string;
  readonly runtime: XTransactionRuntimeIds;
}): string {
  const bound = JSON.stringify({
    method: input.method,
    path: exactMutationPath(input.path),
    mainBundlePath: input.mainBundlePath,
    wrapperModuleId: input.runtime.wrapperModuleId,
    exportName: input.runtime.exportName,
    chunkId: input.runtime.chunkId,
    moduleId: input.runtime.moduleId,
  });
  return `(async()=>{const input=${bound};if(location.origin!=="${X_ORIGIN}")throw new Error("unexpected X origin");if(document.contentType!=="text/html")throw new Error("X webpack runtime is unavailable");const listedMains=()=>Array.from(document.scripts).map((node)=>{try{return new URL(node.src,location.href)}catch{return null}}).filter((url)=>url!==null&&url.origin==="${X_ASSET_ORIGIN}"&&/^\\/responsive-web\\/client-web\\/main\\.[A-Za-z0-9_-]{6,128}\\.js$/.test(url.pathname));let mains=listedMains();if(mains.length===0){await new Promise((resolve,reject)=>{const script=document.createElement("script");script.src="${X_ASSET_ORIGIN}"+input.mainBundlePath;script.onload=()=>resolve();script.onerror=()=>reject(new Error("X main runtime failed to load"));document.documentElement.appendChild(script)});mains=listedMains()}if(mains.length!==1||mains[0].pathname!==input.mainBundlePath)throw new Error("X main runtime drifted");const chunks=globalThis.webpackChunk_twitter_responsive_web;if(!Array.isArray(chunks)||typeof chunks.push!=="function")throw new Error("X webpack runtime is unavailable");let runtime=null;chunks.push([["wrench_x_client_transaction_bootstrap"],{},(candidate)=>{runtime=candidate}]);if(typeof runtime!=="function")throw new Error("X webpack runtime is unavailable");const exports=runtime(input.wrapperModuleId);if(exports===null||typeof exports!=="object")throw new Error("X transaction wrapper is unavailable");const helper=exports[input.exportName];if(typeof helper!=="function")throw new Error("X transaction wrapper helper is unavailable");const value=await helper(location.host,input.path,input.method);if(typeof value!=="string"||value.length<8||value.length>2048)throw new Error("X transaction wrapper returned an invalid value");try{if(atob(value).startsWith("e:"))throw new Error("X transaction wrapper reported an error")}catch(error){if(error instanceof Error&&error.message==="X transaction wrapper reported an error")throw error}return value})()`;
}

function currentBrowserUrl(record: Record<string, unknown>): URL {
  const data = browserResultData(record);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("X transaction bootstrap browser omitted its current URL");
  }
  const value = (data as Record<string, unknown>).url;
  if (typeof value !== "string") throw new Error("X transaction bootstrap browser omitted its current URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("X transaction bootstrap browser returned an invalid current URL");
  }
  if (url.origin !== X_ORIGIN || url.username !== "" || url.password !== "") {
    throw new Error("X transaction bootstrap browser left its reviewed origin");
  }
  return url;
}

function transactionId(record: Record<string, unknown>): string {
  const data = browserResultData(record);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("X transaction bootstrap returned a malformed evaluation envelope");
  }
  const envelope = data as Record<string, unknown>;
  if (typeof envelope.origin !== "string") {
    throw new Error("X transaction bootstrap evaluation omitted its origin");
  }
  let origin: URL;
  try {
    origin = new URL(envelope.origin);
  } catch {
    throw new Error("X transaction bootstrap evaluation returned an invalid origin");
  }
  if (origin.origin !== X_ORIGIN || origin.username !== "" || origin.password !== "") {
    throw new Error("X transaction bootstrap evaluation escaped its reviewed origin");
  }
  const value = envelope.result;
  if (typeof value !== "string" || !/^[A-Za-z0-9_+/=-]{8,2048}$/u.test(value)) {
    throw new Error("X transaction bootstrap returned an invalid request value");
  }
  return value;
}

type BrowserFinalizationResult = {
  readonly closeVerified: boolean;
  readonly cleanupVerified: boolean;
  readonly failures: readonly unknown[];
};

async function finalizeBrowserSession(
  session: BrowserSession,
): Promise<BrowserFinalizationResult> {
  const failures: unknown[] = [];
  let closeVerified = false;
  try {
    await session.close();
    closeVerified = true;
  } catch (error) {
    failures.push(error);
  }
  let cleanupVerified = false;
  try {
    await session.cleanup();
    cleanupVerified = true;
  } catch (error) {
    failures.push(error);
  }
  return Object.freeze({
    closeVerified,
    cleanupVerified,
    failures: Object.freeze(failures),
  });
}

function remainingTimeoutMs(
  timeoutMs: number,
  operationDeadline: WebSessionOperationDeadline | undefined,
): number {
  if (operationDeadline === undefined) return timeoutMs;
  operationDeadline.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const remaining = Math.min(timeoutMs, operationDeadline.remainingTimeMs());
  if (remaining < 1) {
    operationDeadline.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
    throw new Error("X transaction bootstrap timed out");
  }
  return remaining;
}

function runWithinOperationDeadline<T>(
  operationDeadline: WebSessionOperationDeadline | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return operationDeadline === undefined
    ? work()
    : operationDeadline.run(work, WEB_SESSION_OPERATION_LABEL);
}

function finalizeBrowserSessionWithoutBlocking(session: BrowserSession): void {
  void finalizeBrowserSession(session);
}

/** Generate one ephemeral value. The caller may place it only on this exact in-origin mutation request. */
export async function generateXClientTransactionId(input: {
  readonly auth: WrenchAuth;
  readonly mainBundleText: string;
  readonly mainBundleUrl: string | URL;
  readonly method: "POST";
  readonly path: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly operationDeadline?: WebSessionOperationDeadline;
  readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
  readonly dependencies?: XTransactionBrowserDependencies;
}): Promise<string> {
  input.operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  if (input.method !== "POST") throw new Error("X transaction bootstrap supports mutations only");
  const path = exactMutationPath(input.path);
  const mainBundlePath = exactMainBundlePath(input.mainBundleUrl);
  const runtime = parseXTransactionRuntimeIds(input.mainBundleText);
  const createSession = input.dependencies?.createBrowserSession ?? createBrowserSession;
  const creation = createSession(
    xTransactionBrowserManifest,
    containedBrowserAuth(input.auth),
    {
      headed: false,
      timeoutMs: remainingTimeoutMs(input.timeoutMs, input.operationDeadline),
      maxOutputBytes: Math.min(input.maxOutputBytes, MAX_EVALUATION_OUTPUT_BYTES),
      allowCodeOwnedEvaluation: true,
      ...(input.operationDeadline === undefined
        ? {}
        : { operationDeadline: input.operationDeadline }),
      ...(input.dependencies?.acquireCookieRecords === undefined
        ? {}
        : { dependencies: { acquireCookieRecords: input.dependencies.acquireCookieRecords } }),
      ...(input.publishCleanupResource === undefined
        ? {}
        : { publishCleanupResource: input.publishCleanupResource }),
    },
  );
  let session: BrowserSession;
  try {
    // The production creator owns deadline-aware teardown and must be allowed
    // to report its cleanup outcome. A test-only injected creator is still
    // outer-raced so a broken seam cannot defeat the kernel deadline.
    session = input.dependencies?.createBrowserSession === undefined
      ? await creation
      : await runWithinOperationDeadline(
          input.operationDeadline,
          () => creation,
        );
  } catch (error) {
    if (
      input.operationDeadline !== undefined
      && input.dependencies?.createBrowserSession !== undefined
    ) {
      void creation.then(
        (lateSession) => finalizeBrowserSessionWithoutBlocking(lateSession),
        () => undefined,
      );
    }
    throw error;
  }
  let generated: string | undefined;
  let failure: unknown;
  let failed = false;
  const activeBatchState: {
    current: Promise<readonly Record<string, unknown>[]> | null;
  } = { current: null };
  const runBatch = (
    commands: readonly (readonly string[])[],
  ): Promise<readonly Record<string, unknown>[]> => {
    const batch = session.runBatch(
      commands,
      remainingTimeoutMs(input.timeoutMs, input.operationDeadline),
      MAX_EVALUATION_OUTPUT_BYTES,
    );
    activeBatchState.current = batch;
    void batch.then(
      () => {
        if (activeBatchState.current === batch) activeBatchState.current = null;
      },
      () => {
        if (activeBatchState.current === batch) activeBatchState.current = null;
      },
    );
    return runWithinOperationDeadline(
      input.operationDeadline,
      () => batch,
    );
  };
  try {
    // Cookie-source session launch already opened /robots.txt before cookies.
    // After injection, eval needs the responsive-web HTML that installs
    // webpackChunk_twitter_responsive_web (vendor + main). /robots.txt is
    // text/plain and cannot host that runtime. / is a logged-out x-web stack.
    // /home is the same document bootstrapX already fetched as text/html with
    // these cookies.
    await runBatch([["open", X_TRANSACTION_DOCUMENT]]);
    const [urlRecord] = await runBatch([["get", "url"]]);
    if (urlRecord === undefined) throw new Error("X transaction bootstrap browser omitted its current URL");
    currentBrowserUrl(urlRecord);
    const [evaluationRecord] = await runBatch([[
        "eval",
        transactionEvaluationSource({ method: "POST", path, mainBundlePath, runtime }),
      ]]);
    if (evaluationRecord === undefined) throw new Error("X transaction bootstrap browser omitted its evaluation result");
    generated = transactionId(evaluationRecord);
  } catch (error) {
    failed = true;
    failure = error;
  }
  // Never close concurrently with an injected abort-ignorant batch. The
  // production BrowserSession also tracks its underlying command cleanup, so
  // close remains the authoritative quiescence gate after its outer promise
  // has observed cancellation.
  const activeBatch = activeBatchState.current;
  if (activeBatch !== null) {
    await activeBatch.catch(() => undefined);
  }
  const finalization = await finalizeBrowserSession(session);
  if (!finalization.closeVerified || !finalization.cleanupVerified) {
    const cleanupEvidence = (
      finalization.closeVerified
      && !finalization.cleanupVerified
      && session.cleanupResourceIdentity !== undefined
    )
      ? Object.freeze({
          kind: "agent-browser-closed-artifacts-v1" as const,
          resource: session.cleanupResourceIdentity,
        })
      : undefined;
    throw new PreservedBrowserArtifactsError(
      "X transaction bootstrap browser finalization failed; private artifacts were preserved",
      session.recoveryHandle ?? "session=x-transaction-bootstrap;artifacts=unknown",
      new AggregateError(
        [
          ...(failed ? [failure] : []),
          ...finalization.failures,
        ],
        "X transaction bootstrap browser finalization failed",
      ),
      cleanupEvidence,
    );
  }
  if (failed) throw failure;
  if (generated === undefined) throw new Error("X transaction bootstrap produced no request value");
  return generated;
}
