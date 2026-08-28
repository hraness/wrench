import type { WrenchAuth } from "../auth";
import { canonicalJson } from "../canonical-json";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  createWebSessionClient,
  webSessionAuthSubject,
  webSessionCookie,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import { failedProviderRead, type ProviderReadFailureStage } from "./read-failure";
import {
  TWITCH_GQL_ORIGIN,
  TWITCH_GQL_PATH,
  TWITCH_WEB_CLIENT_ID,
  TWITCH_WEB_OPERATIONS,
  parseTwitchCurrentViewerResponse,
  parseTwitchProfileResponse,
  projectTwitchProfileStats,
  twitchCurrentViewerRequest,
  twitchLogin,
  twitchProfileRequest,
  TwitchProfileTargetUnavailableError,
  TwitchViewerAuthRepairRequiredError,
  type TwitchPersistedQueryRequest,
  type TwitchViewer,
} from "./twitch-web";

const MAX_TWITCH_RESPONSE_BYTES = 256 * 1024;

export type TwitchWebRuntimeDependencies =
  Partial<WebSessionNetworkDependencies> & {
    readonly now?: () => number;
  };

function exactProfileInput(input: OperationInput): string {
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "profile") {
    throw new Error("Twitch profiles.read accepts only input.profile");
  }
  return twitchLogin(input.profile, "input.profile");
}

function twitchAuthToken(client: WebSessionClient): string {
  const token = webSessionCookie(client.cookies, "auth-token");
  if (!/^[A-Za-z0-9._~-]{16,512}$/u.test(token)) {
    throw new Error("Twitch auth-token cookie did not match the reviewed credential shape");
  }
  return token;
}

function twitchHeaders(
  client: WebSessionClient,
  referer: string,
): Readonly<Record<string, string>> {
  if (!/^[a-z0-9]{20,64}$/u.test(TWITCH_WEB_CLIENT_ID)) {
    throw new Error("Twitch web client ID is not reviewed");
  }
  const token = twitchAuthToken(client);
  return Object.freeze({
    accept: "*/*",
    authorization: `OAuth ${token}`,
    "client-id": TWITCH_WEB_CLIENT_ID,
    "content-type": "text/plain",
    referer,
  });
}

async function requestTwitchBatch(
  client: WebSessionClient,
  request: readonly TwitchPersistedQueryRequest[],
  referer: string,
  maximumBytes: number,
): Promise<unknown> {
  return client.requestJson({
    url: new URL(TWITCH_GQL_PATH, TWITCH_GQL_ORIGIN),
    method: "POST",
    headers: twitchHeaders(client, referer),
    body: canonicalJson(request),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_TWITCH_RESPONSE_BYTES),
  });
}

async function currentViewer(
  client: WebSessionClient,
): Promise<TwitchViewer> {
  return parseTwitchCurrentViewerResponse(await requestTwitchBatch(
    client,
    twitchCurrentViewerRequest(),
    "https://www.twitch.tv/",
    MAX_TWITCH_RESPONSE_BYTES,
  ));
}

function viewerSubject(viewer: TwitchViewer): string {
  return `twitch:${viewer.id}`;
}

function requireBoundViewer(auth: WrenchAuth, viewer: TwitchViewer): void {
  const expected = webSessionAuthSubject(auth);
  if (expected === null || !/^twitch:[1-9][0-9]{0,31}$/u.test(expected)) {
    throw new Error(
      "Twitch profile statistics require an auth locator bound to the exact viewer subject",
    );
  }
  if (viewerSubject(viewer) !== expected) {
    throw new Error(
      "Twitch browser session viewer no longer matches the confirmed auth subject",
    );
  }
}

function observedAt(
  dependencies: TwitchWebRuntimeDependencies | undefined,
): string {
  const now = dependencies?.now?.() ?? Date.now();
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || now > 8_640_000_000_000_000
  ) {
    throw new Error("Twitch profile observation time is invalid");
  }
  return new Date(now).toISOString();
}

export async function probeTwitchWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: TwitchWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(TWITCH_GQL_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
  });
  return viewerSubject(await currentViewer(client));
}

export async function executeTwitchWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (
      event: WebSessionDispatchEvent,
    ) => Promise<void>;
    readonly afterDispatchVerified?: (
      event: WebSessionDispatchEvent,
    ) => Promise<void>;
    readonly dependencies?: TwitchWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "twitch"
    || recipe.action !== "profiles.read"
    || recipe.contractVersion !== 1
    || TWITCH_WEB_OPERATIONS["profiles.read"].state !== "observed"
  ) {
    throw new Error("Twitch authenticated profiles.read contract is not installed");
  }
  const profile = exactProfileInput(input);
  // R1 performs no dispatch and never invokes mutation lifecycle callbacks.
  void options.beforeDispatch;
  void options.afterDispatchVerified;
  const finalUrl = `https://www.twitch.tv/${profile}`;
  let stage: ProviderReadFailureStage = "bootstrap";
  try {
    const client = await createWebSessionClient(TWITCH_GQL_ORIGIN, auth, {
      timeoutMs: recipe.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.operationDeadline === undefined
        ? {}
        : { operationDeadline: options.operationDeadline }),
      ...(options.dependencies === undefined
        ? {}
        : { dependencies: options.dependencies }),
    });
    stage = "identity";
    const viewer = await currentViewer(client);
    requireBoundViewer(auth, viewer);
    stage = "target";
    const response = await requestTwitchBatch(
      client,
      twitchProfileRequest(profile),
      `${finalUrl}/about`,
      recipe.maxOutputBytes,
    );
    const output = projectTwitchProfileStats(
      parseTwitchProfileResponse(response, profile, viewer),
      observedAt(options.dependencies),
    );
    return {
      status: "succeeded",
      output,
      finalUrl: output.target.url,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    };
  } catch (error) {
    return failedProviderRead("Twitch profile", error, finalUrl, {
      stage,
      authenticated: true,
      accountMismatch: (candidate) => candidate.message.includes("no longer matches")
        || candidate.message.includes("did not bind the current viewer ID"),
      authRepairRequired: (candidate) => candidate.message.includes("auth-token cookie")
        || candidate.message.includes("auth locator bound")
        || candidate instanceof TwitchViewerAuthRepairRequiredError,
      targetUnavailable: (candidate) => candidate instanceof TwitchProfileTargetUnavailableError,
    });
  }
}
