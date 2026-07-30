import {
  createPinnedNetworkConnectionPool,
  requestPinnedNetworkAddress,
  resolveSafeNetworkTarget,
  type NetworkTransport,
  type PinnedNetworkConnectionPool,
  type PinnedNetworkRequest,
  type PinnedNetworkResponse,
} from "@hraness/kb/clip/network";

export type PinnedHttpsRequest = PinnedNetworkRequest;

export type PinnedHttpsResponse = PinnedNetworkResponse;

export type PinnedHttpsDependencies = {
  readonly resolveTarget: typeof resolveSafeNetworkTarget;
  readonly request: NetworkTransport;
};

export type PinnedHttpsFetch = (
  input: URL,
  init: RequestInit,
  timeoutMs: number,
) => Promise<Response>;

export type PinnedHttpsFetchScope = {
  readonly fetch: PinnedHttpsFetch;
  readonly close: () => void;
};

export type PinnedHttpsFetchScopeDependencies = {
  readonly resolveTarget?: typeof resolveSafeNetworkTarget;
  readonly createConnectionPool?: () => PinnedNetworkConnectionPool;
};

const defaultDependencies: PinnedHttpsDependencies = {
  resolveTarget: resolveSafeNetworkTarget,
  request: requestPinnedNetworkAddress,
};

function requestBody(value: RequestInit["body"]): Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new Error("authenticated HTTPS request bodies must be an owned string or byte array");
}

function responseBody(response: PinnedHttpsResponse): ReadableStream<Uint8Array> | null {
  if (response.body === null) return null;
  const iterator = response.body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) {
          response.cancel();
          controller.error(new Error("authenticated HTTPS response yielded a non-byte chunk"));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        response.cancel();
        controller.error(error);
      }
    },
    cancel() {
      response.cancel();
      void iterator.return?.();
    },
  });
}

/**
 * Make one public, DNS-pinned HTTPS request without redirects or retries.
 *
 * A single validated address is selected before the socket opens. In particular,
 * mutations never retry another address after an ambiguous transport failure.
 */
export async function pinnedHttpsFetch(
  input: URL,
  init: RequestInit,
  timeoutMs: number,
  dependencies: Partial<PinnedHttpsDependencies> = {},
): Promise<Response> {
  const url = new URL(input);
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error("authenticated requests require one credential-free HTTPS URL without a fragment");
  if (init.redirect !== "error") throw new Error("authenticated requests must reject redirects");
  if (init.signal === null || init.signal === undefined) throw new Error("authenticated requests require an abort signal");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new Error("authenticated request timeout is invalid");
  }
  const resolved = { ...defaultDependencies, ...dependencies };
  const addresses = await resolved.resolveTarget(url, {
    allowPrivateNetwork: false,
    timeoutMs,
  });
  const address = addresses[0];
  if (address === undefined) throw new Error("authenticated HTTPS origin did not resolve to a safe address");
  const headers = new Headers(init.headers);
  const body = requestBody(init.body);
  const response = await resolved.request({
    url,
    address,
    method: init.method ?? "GET",
    headers,
    body,
    signal: init.signal,
  });
  if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599) {
    response.cancel();
    throw new Error("authenticated HTTPS response status is invalid");
  }
  return new Response(responseBody(response), {
    status: response.status,
    headers: response.headers,
  });
}

function exactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("pinned HTTPS fetch scope requires an exact HTTPS origin");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.search !== ""
    || url.pathname !== "/"
    || url.origin !== value
  ) {
    throw new Error("pinned HTTPS fetch scope requires an exact HTTPS origin");
  }
  return url.origin;
}

/**
 * Create one exact-origin keep-alive scope for a bounded caller invocation.
 *
 * Every request still resolves and validates its target before dispatch. The underlying Wrench
 * transport reuses a socket only when both this origin and the newly pinned address match.
 */
export function createPinnedHttpsFetchScope(
  origin: string,
  dependencies: PinnedHttpsFetchScopeDependencies = {},
): PinnedHttpsFetchScope {
  const expectedOrigin = exactHttpsOrigin(origin);
  const pool = (dependencies.createConnectionPool
    ?? createPinnedNetworkConnectionPool)();
  let closed = false;
  const request: NetworkTransport = (candidate) => {
    if (closed) {
      return Promise.reject(new Error("pinned HTTPS fetch scope is closed"));
    }
    return pool.request(candidate);
  };

  const fetch: PinnedHttpsFetch = async (input, init, timeoutMs) => {
    const url = new URL(input);
    if (url.origin !== expectedOrigin) {
      throw new Error("pinned HTTPS fetch escaped its exact-origin scope");
    }
    if (closed) throw new Error("pinned HTTPS fetch scope is closed");
    return await pinnedHttpsFetch(url, init, timeoutMs, {
      resolveTarget: dependencies.resolveTarget ?? resolveSafeNetworkTarget,
      request,
    });
  };

  return Object.freeze({
    fetch,
    close: () => {
      if (closed) return;
      closed = true;
      pool.close();
    },
  });
}
