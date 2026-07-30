import { createHash } from "node:crypto";
import { isValidBrowserSpec, normalizeAuthContextName, type CaptureMode } from "./args";

export type DirectCaptureMode = Exclude<CaptureMode, "transcript">;

export interface SourceRouteInput {
  readonly url: string;
  readonly mode: CaptureMode;
  readonly browser?: string;
  readonly authContext?: string;
  readonly inheritYtDlpConfig: boolean;
}

interface RoutedRequest {
  /** Fragment-free in-memory transport URL. It is not a persisted identity. */
  readonly requestUrl: string;
  /** SHA-256 of the exact fragment-free UTF-8 request URL. */
  readonly requestUrlSha256: string;
}

export type SourceRoute =
  | Readonly<{
      kind: "reject";
      reason:
        | "malformed-url"
        | "credentials-not-allowed"
        | "unsupported-protocol"
        | "invalid-browser"
        | "ambiguous-private-access"
        | "auth-context-required"
        | "auth-context-not-applicable"
        | "invalid-auth-context";
    }>
  | (Readonly<{
      kind: "yt-dlp";
      reason: "browser-auth" | "ambient-config";
      mode: CaptureMode;
      authContext: string;
    }> & RoutedRequest)
  | DirectHttpMediaProbeRoute
  | DirectHttpTranscriptProbeRoute;

export type DirectHttpMediaProbeRoute = Readonly<{
  kind: "direct-http";
  intent: "media-probe";
  mode: DirectCaptureMode;
}> & RoutedRequest;

export type DirectHttpTranscriptProbeRoute = Readonly<{
  kind: "direct-http";
  intent: "transcript-probe-only";
  mode: "transcript";
}> & RoutedRequest;

export type DirectMediaProbeResult =
  | Readonly<{ kind: "applicable" }>
  | Readonly<{ kind: "not-applicable" }>;

export type DirectMediaResolution =
  | (Readonly<{
      kind: "direct-http-capture";
      mode: DirectCaptureMode;
    }> & RoutedRequest)
  | (Readonly<{
      kind: "yt-dlp-fallback";
      reason: "not-applicable-media";
      mode: DirectCaptureMode;
    }> & RoutedRequest);

function requestUrlSha256(requestUrl: string): string {
  return createHash("sha256").update(requestUrl, "utf8").digest("hex");
}

function routedRequest(url: URL): RoutedRequest {
  url.hash = "";
  const requestUrl = url.href;
  return { requestUrl, requestUrlSha256: requestUrlSha256(requestUrl) };
}

function assertNever(value: never): never {
  throw new TypeError(`unhandled source-routing state: ${String(value)}`);
}

function isDirectCaptureMode(mode: CaptureMode): mode is DirectCaptureMode {
  return mode === "archive" || mode === "audio" || mode === "video";
}

/** Pure initial policy: validate transport, then select a probe boundary. */
export function routeSource(input: SourceRouteInput): SourceRoute {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { kind: "reject", reason: "malformed-url" };
  }
  if (url.username !== "" || url.password !== "") {
    return { kind: "reject", reason: "credentials-not-allowed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "reject", reason: "unsupported-protocol" };
  }

  const request = routedRequest(url);
  if (input.browser !== undefined && !isValidBrowserSpec(input.browser)) {
    return { kind: "reject", reason: "invalid-browser" };
  }
  if (input.browser !== undefined && input.inheritYtDlpConfig) {
    return { kind: "reject", reason: "ambiguous-private-access" };
  }
  const normalizedContext = input.authContext === undefined
    ? undefined
    : normalizeAuthContextName(input.authContext);
  if (normalizedContext === null) {
    return { kind: "reject", reason: "invalid-auth-context" };
  }
  const hasPrivateAccess = input.browser !== undefined || input.inheritYtDlpConfig;
  if (hasPrivateAccess && normalizedContext === undefined) {
    return { kind: "reject", reason: "auth-context-required" };
  }
  if (!hasPrivateAccess && normalizedContext !== undefined) {
    return { kind: "reject", reason: "auth-context-not-applicable" };
  }
  if (input.browser !== undefined) {
    if (normalizedContext === undefined) {
      return { kind: "reject", reason: "auth-context-required" };
    }
    return {
      kind: "yt-dlp",
      reason: "browser-auth",
      mode: input.mode,
      authContext: normalizedContext,
      ...request,
    };
  }
  if (input.inheritYtDlpConfig) {
    if (normalizedContext === undefined) {
      return { kind: "reject", reason: "auth-context-required" };
    }
    return {
      kind: "yt-dlp",
      reason: "ambient-config",
      mode: input.mode,
      authContext: normalizedContext,
      ...request,
    };
  }

  if (isDirectCaptureMode(input.mode)) {
    return { kind: "direct-http", intent: "media-probe", mode: input.mode, ...request };
  }
  if (input.mode === "transcript") {
    return {
      kind: "direct-http",
      intent: "transcript-probe-only",
      mode: input.mode,
      ...request,
    };
  }
  return assertNever(input.mode);
}

/** Resolves only media probes; a transcript route cannot inhabit this input type. */
export function resolveDirectMediaProbe(
  route: DirectHttpMediaProbeRoute,
  result: DirectMediaProbeResult,
): DirectMediaResolution {
  if (route.kind !== "direct-http" || route.intent !== "media-probe" || !isDirectCaptureMode(route.mode)) {
    throw new TypeError("only a direct HTTP media probe can resolve to capture");
  }
  const request = {
    requestUrl: route.requestUrl,
    requestUrlSha256: route.requestUrlSha256,
  };
  switch (result.kind) {
    case "applicable":
      return { kind: "direct-http-capture", mode: route.mode, ...request };
    case "not-applicable":
      return {
        kind: "yt-dlp-fallback",
        reason: "not-applicable-media",
        mode: route.mode,
        ...request,
      };
    default:
      return assertNever(result);
  }
}
