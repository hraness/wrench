import { createServer, type Server as HttpServer } from "node:http";
import { isIP, connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import {
  isPrivateAddress,
  isPrivateHostname,
  resolveSafeNetworkTarget,
  type NetworkResolver,
  type ResolvedNetworkAddress,
} from "@hraness/kb/clip/network";

const MAX_BROWSER_DOMAINS = 100;
const MAX_CONNECT_AUTHORITY_BYTES = 1_024;
const MAX_CONNECT_ADDRESSES = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_TRANSFERRED_BYTES = 1024 * 1024 * 1024;

export type DerivationProxyConnect = (
  address: ResolvedNetworkAddress,
  port: number,
) => Socket;

export type DerivationNetworkProxyOptions = {
  readonly browserDomains: readonly string[];
  readonly timeoutMs?: number;
  readonly maxConnections?: number;
  readonly maxTransferredBytes?: number;
  /** Deterministic test seams. Production callers must leave these unset. */
  readonly resolveHostname?: NetworkResolver;
  readonly connectAddress?: DerivationProxyConnect;
};

export type DerivationNetworkProxy = {
  readonly url: string;
  readonly port: number;
  readonly close: () => Promise<void>;
};

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("derivation proxy limits must be positive integers");
  }
  return Math.min(value, maximum);
}

function domainBase(domain: string): string {
  return domain.startsWith("*.") ? domain.slice(2) : domain;
}

export function browserDomainsCover(
  browserDomains: readonly string[],
  hostnameValue: string,
): boolean {
  const hostname = hostnameValue.toLowerCase();
  if (hostname.endsWith(".")) return false;
  return browserDomains.some((domain) => {
    if (domain === hostname) return true;
    if (!domain.startsWith("*.")) return false;
    const base = domain.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  });
}

/** Strict public exact/wildcard hostname policy shared by DNR and the proxy. */
export function validateDerivationBrowserDomains(
  values: readonly string[],
  targetHostname: string,
): readonly string[] {
  if (values.length < 1 || values.length > MAX_BROWSER_DOMAINS) {
    throw new Error("browser domains must contain 1-100 exact or wildcard hostnames");
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string"
      || !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/iu.test(value)
      || value.includes("..")
    ) {
      throw new Error("browser domains must contain 1-100 exact or wildcard hostnames");
    }
    const domain = value.toLowerCase();
    const base = domainBase(domain);
    if (
      isPrivateHostname(base)
      || (isIP(base) !== 0 && isPrivateAddress(base))
      || (domain.startsWith("*.") && isIP(base) !== 0)
    ) {
      throw new Error("browser domains cannot contain private, local, reserved, or wildcard IP hosts");
    }
    if (!seen.has(domain)) {
      seen.add(domain);
      normalized.push(domain);
    }
  }
  if (!browserDomainsCover(normalized, targetHostname.toLowerCase())) {
    throw new Error("browser domains must cover the derivation target hostname");
  }
  return Object.freeze(normalized);
}

function connectAuthority(authority: string | undefined): URL {
  if (
    authority === undefined
    || authority.length < 1
    || Buffer.byteLength(authority, "utf8") > MAX_CONNECT_AUTHORITY_BYTES
    || /[\s\\/?#@]/u.test(authority)
  ) throw new Error("invalid CONNECT authority");
  let target: URL;
  try {
    target = new URL(`https://${authority}/`);
  } catch {
    throw new Error("invalid CONNECT authority");
  }
  if (
    target.username !== ""
    || target.password !== ""
    || target.hostname === ""
    || target.hostname.endsWith(".")
  ) throw new Error("invalid CONNECT authority");
  return target;
}

function targetPort(target: URL): number {
  const port = target.port === "" ? 443 : Number(target.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid CONNECT port");
  }
  return port;
}

function finishSocket(socket: Duplex, status: 400 | 403 | 502 | 503 | 504): void {
  if (socket.destroyed) return;
  const reason = status === 400
    ? "Bad Request"
    : status === 403
      ? "Forbidden"
      : status === 503
        ? "Service Unavailable"
        : status === 504
          ? "Gateway Timeout"
          : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function trackSocket(
  socket: Duplex,
  sockets: Set<Duplex>,
  timeoutMs: number,
): void {
  sockets.add(socket);
  if ("setTimeout" in socket && typeof socket.setTimeout === "function") {
    socket.setTimeout(timeoutMs, () => socket.destroy());
  }
  socket.once("close", () => sockets.delete(socket));
}

async function connectPinned(
  addresses: readonly ResolvedNetworkAddress[],
  port: number,
  timeoutMs: number,
  sockets: Set<Duplex>,
  connectAddress: DerivationProxyConnect,
  closing: () => boolean,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (const address of addresses.slice(0, MAX_CONNECT_ADDRESSES)) {
    if (closing()) throw new Error("derivation proxy is closing");
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          reject(new Error("derivation proxy connection timed out"));
          return;
        }
        const candidate = connectAddress(address, port);
        trackSocket(candidate, sockets, timeoutMs);
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          candidate.destroy();
          reject(new Error("derivation proxy connection timed out"));
        }, remainingMs);
        candidate.once("connect", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(candidate);
        });
        candidate.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          candidate.destroy();
          reject(error);
        });
        candidate.once("close", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error("derivation proxy connection closed"));
        });
      });
      if (closing()) {
        socket.destroy();
        throw new Error("derivation proxy is closing");
      }
      return socket;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("derivation proxy could not connect to a validated destination", {
    cause: lastError,
  });
}

/**
 * A loopback-only CONNECT proxy. TLS remains end to end: the proxy validates
 * the exact hostname policy, resolves only public addresses, pins the chosen
 * address, and then transports opaque bytes without seeing HTTP credentials.
 */
export async function startDerivationNetworkProxy(
  options: DerivationNetworkProxyOptions,
): Promise<DerivationNetworkProxy> {
  const browserDomains = validateDerivationBrowserDomains(
    options.browserDomains,
    domainBase(options.browserDomains[0] ?? ""),
  );
  const timeoutMs = positiveBoundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10 * 60_000);
  const maxConnections = positiveBoundedInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS, 1_024);
  const maxTransferredBytes = positiveBoundedInteger(
    options.maxTransferredBytes,
    DEFAULT_MAX_TRANSFERRED_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  const sockets = new Set<Duplex>();
  let activeConnections = 0;
  let transferredBytes = 0;
  let closing = false;
  const connectAddress = options.connectAddress
    ?? ((address: ResolvedNetworkAddress, port: number): Socket => connectTcp({
      host: address.address,
      port,
      family: address.family,
    }));

  const server: HttpServer = createServer({
    maxHeaderSize: 32 * 1024,
    headersTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    keepAliveTimeout: Math.min(timeoutMs, 5_000),
  });
  server.maxConnections = maxConnections;
  server.on("request", (_request, response) => {
    response.writeHead(403, {
      "Cache-Control": "no-store",
      Connection: "close",
      "Content-Length": "0",
    });
    response.end();
  });
  server.on("upgrade", (_request, socket) => finishSocket(socket, 403));
  server.on("clientError", (_error, socket) => finishSocket(socket, 400));
  server.on("connection", (socket) => trackSocket(socket, sockets, timeoutMs));
  server.on("connect", (request, downstream, head) => {
    if (closing || activeConnections >= maxConnections) {
      finishSocket(downstream, 503);
      return;
    }
    activeConnections += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activeConnections = Math.max(0, activeConnections - 1);
    };
    downstream.once("close", release);

    void (async () => {
      let target: URL;
      try {
        target = connectAuthority(request.url);
      } catch {
        finishSocket(downstream, 400);
        return;
      }
      if (!browserDomainsCover(browserDomains, target.hostname)) {
        finishSocket(downstream, 403);
        return;
      }
      try {
        const addresses = await resolveSafeNetworkTarget(target, {
          allowPrivateNetwork: false,
          timeoutMs,
          ...(options.resolveHostname === undefined
            ? {}
            : { resolveHostname: options.resolveHostname }),
        });
        if (downstream.destroyed || closing) return;
        const upstream = await connectPinned(
          addresses,
          targetPort(target),
          timeoutMs,
          sockets,
          connectAddress,
          () => closing,
        );
        if (downstream.destroyed || closing) {
          upstream.destroy();
          return;
        }
        const account = (size: number): boolean => {
          transferredBytes += size;
          if (transferredBytes <= maxTransferredBytes) return true;
          downstream.destroy();
          upstream.destroy();
          return false;
        };
        downstream.write(
          "HTTP/1.1 200 Connection Established\r\nProxy-Agent: wrench\r\n\r\n",
        );
        if (head.byteLength > 0 && account(head.byteLength)) upstream.write(head);
        downstream.on("data", (chunk: Buffer) => account(chunk.byteLength));
        upstream.on("data", (chunk: Buffer) => account(chunk.byteLength));
        downstream.once("error", () => upstream.destroy());
        upstream.once("error", () => downstream.destroy());
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        finishSocket(
          downstream,
          message.includes("timed out")
            ? 504
            : message.includes("private") || message.includes("reserved")
              ? 403
              : 502,
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("derivation proxy did not bind a TCP port");
  }

  let closePromise: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => {
      if (closePromise !== null) return closePromise;
      closing = true;
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
      });
      return closePromise;
    },
  };
}
