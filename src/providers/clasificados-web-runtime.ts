import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import { OperationDeadlineError } from "../operation-deadline";
import { pinnedHttpsFetch, type PinnedHttpsFetch } from "../pinned-https";
import type {
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  failedProviderRead,
  ProviderReadResponseRejectedError,
  ProviderReadThrottledError,
  ProviderReadTransportError,
} from "./read-failure";
import {
  CLASIFICADOS_MAX_RESPONSE_BYTES,
  CLASIFICADOS_ORIGIN,
  CLASIFICADOS_WEB_OPERATIONS,
  clasificadosListUrl,
  clasificadosPueblosForLocation,
  clasificadosSearchTargetUrl,
  projectClasificadosListingsSearch,
  type ClasificadosPueblo,
} from "./clasificados-web";
import { parseRentalListingsSearchInput } from "./rental-listings";

const OPERATION_LABEL = "Clasificados public listings.search deadline";
const USER_AGENT = "Mozilla/5.0 (compatible; Wrench/1.0; +https://wrench.rip)";

export type ClasificadosWebRuntimeDependencies = {
  readonly fetch?: PinnedHttpsFetch;
  readonly now?: () => number;
};

function remainingTimeoutMs(
  timeoutMs: number,
  deadline: WebSessionOperationDeadline | undefined,
  label: string,
): number {
  deadline?.throwIfUnavailable(label);
  const remaining = Math.min(
    timeoutMs,
    deadline?.remainingTimeMs() ?? timeoutMs,
  );
  if (remaining < 1_000) {
    throw new OperationDeadlineError(label, "timed-out");
  }
  return remaining;
}

function htmlContentType(response: Response): boolean {
  const raw = response.headers.get("content-type");
  if (raw === null) return false;
  const type = raw.split(";", 1)[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

function decodeLatin1(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength === 0) {
    throw new Error(`${label} was empty`);
  }
  return new TextDecoder("latin1").decode(bytes);
}

async function boundedBytes(
  response: Response,
  maximum: number,
  deadline: WebSessionOperationDeadline | undefined,
  label: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} exceeded its reviewed byte limit`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await (async () => {
        try {
          return deadline === undefined
            ? await reader.read()
            : await deadline.run(() => reader.read(), label);
        } catch (error) {
          if (error instanceof OperationDeadlineError) throw error;
          throw new ProviderReadTransportError(error);
        }
      })();
      if (item.done) break;
      if (
        !(item.value instanceof Uint8Array)
        || item.value.byteLength > maximum - length
      ) {
        void reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeded its reviewed byte limit`);
      }
      chunks.push(item.value);
      length += item.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function clasificadosHeaders(): Readonly<Record<string, string>> {
  return {
    accept: "text/html,application/xhtml+xml;q=0.9",
    "accept-language": "en-US,en;q=0.9,es;q=0.8",
    "user-agent": USER_AGENT,
  };
}

async function requestClasificadosHtml(
  url: URL,
  maximum: number,
  fetch: PinnedHttpsFetch,
  signal: AbortSignal,
  timeoutMs: number,
  deadline: WebSessionOperationDeadline | undefined,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: clasificadosHeaders(),
      redirect: "error",
      signal,
    }, remainingTimeoutMs(timeoutMs, deadline, OPERATION_LABEL));
  } catch (error) {
    if (signal.aborted) {
      if (deadline !== undefined) deadline.throwIfUnavailable(OPERATION_LABEL);
      throw new OperationDeadlineError(OPERATION_LABEL, "timed-out");
    }
    throw new ProviderReadTransportError(error);
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 429 || response.status === 503) {
      throw new ProviderReadThrottledError();
    }
    throw new ProviderReadResponseRejectedError(response.status);
  }
  if (!htmlContentType(response)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Clasificados rental list returned an unreviewed content type");
  }
  return decodeLatin1(
    await boundedBytes(response, maximum, deadline, "Clasificados rental list"),
    "Clasificados rental list",
  );
}

function signalForOperation(
  recipe: WebSessionRecipe,
  deadline: WebSessionOperationDeadline | undefined,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  if (deadline !== undefined) {
    return Object.freeze({ signal: deadline.signal, dispose: () => undefined });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), recipe.timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  });
}

export async function executeClasificadosPublicListingsSearch(
  recipe: WebSessionRecipe,
  input: OperationInput,
  dependencies: ClasificadosWebRuntimeDependencies | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "clasificados"
    || recipe.action !== "listings.search"
    || recipe.contractVersion !== 1
    || CLASIFICADOS_WEB_OPERATIONS["listings.search"].state !== "observed"
  ) {
    throw new Error("Clasificados public listings.search contract is not installed");
  }
  const search = parseRentalListingsSearchInput(input);
  const pueblos = clasificadosPueblosForLocation(search.location);
  const fetch = dependencies?.fetch ?? pinnedHttpsFetch;
  const operation = signalForOperation(recipe, operationDeadline);
  const targetUrl = clasificadosSearchTargetUrl(search.location, search);
  try {
    const pages: {
      readonly pueblo: ClasificadosPueblo;
      readonly html: string;
    }[] = [];
    for (const pueblo of pueblos) {
      const html = await requestClasificadosHtml(
        clasificadosListUrl(pueblo, search),
        Math.min(recipe.maxOutputBytes, CLASIFICADOS_MAX_RESPONSE_BYTES),
        fetch,
        operation.signal,
        recipe.timeoutMs,
        operationDeadline,
      );
      pages.push({ pueblo, html });
    }
    const output = projectClasificadosListingsSearch(
      pages,
      search,
      new Date(dependencies?.now?.() ?? Date.now()).toISOString(),
    );
    return {
      status: "succeeded",
      output,
      finalUrl: output.target.url,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    };
  } catch (error) {
    return failedProviderRead("Clasificados listings", error, targetUrl, {
      stage: "target",
      authenticated: false,
      targetStatusUnavailable: true,
    });
  } finally {
    operation.dispose();
  }
}

export function probeClasificadosWebSubject(_auth: WrenchAuth): Promise<string> {
  return Promise.reject(
    new Error("Clasificados public rental searches do not use an auth realm"),
  );
}

export function executeClasificadosAuthenticatedOperation(): Promise<WebSessionExecution> {
  return Promise.reject(
    new Error("Clasificados has no installed authenticated web operations"),
  );
}

export const CLASIFICADOS_PUBLIC_USER_AGENT = USER_AGENT;
export const CLASIFICADOS_PUBLIC_ORIGIN = CLASIFICADOS_ORIGIN;
