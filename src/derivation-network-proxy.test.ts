import { afterEach, describe, expect, test } from "bun:test";
import { createServer, connect as connectTcp, type Server, type Socket } from "node:net";

import {
  browserDomainsCover,
  startDerivationNetworkProxy,
  validateDerivationBrowserDomains,
  type DerivationNetworkProxy,
} from "./derivation-network-proxy";

const proxies: DerivationNetworkProxy[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function upstream(): Promise<{ readonly port: number; readonly received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      received.push(Buffer.from(chunk));
      socket.write(chunk);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server unavailable");
  return { port: address.port, received };
}

function proxyExchange(
  proxy: DerivationNetworkProxy,
  authority: string,
  body: readonly Buffer[] = [],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(proxy.port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let sentBody = false;
    let total = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("test proxy exchange timed out"));
    }, 5_000);
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      total += bytes.byteLength;
      const joined = Buffer.concat(chunks, total);
      if (!sentBody && joined.includes("\r\n\r\n")) {
        sentBody = true;
        if (joined.toString("latin1").startsWith("HTTP/1.1 200")) {
          for (const part of body) socket.write(part);
          if (body.length === 0) socket.end();
          else setTimeout(() => socket.end(), 25);
        }
      }
    });
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks, total));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("contained derivation CONNECT proxy", () => {
  test("normalizes exact/wildcard domains and rejects private, ambiguous, and wildcard IP inputs", () => {
    expect(validateDerivationBrowserDomains(
      ["EXAMPLE.com", "*.CDN.Example.com", "example.com"],
      "example.com",
    )).toEqual(["example.com", "*.cdn.example.com"]);
    expect(browserDomainsCover(["*.example.com"], "EXAMPLE.com")).toBeTrue();
    expect(browserDomainsCover(["*.example.com"], "a.b.example.com")).toBeTrue();
    expect(browserDomainsCover(["*.example.com"], "example.com.")).toBeFalse();
    expect(browserDomainsCover(["*.example.com"], "notexample.com")).toBeFalse();
    expect(browserDomainsCover(["example.com"], "example.com.invalid")).toBeFalse();
    for (const domain of [
      "localhost",
      "*.localhost",
      "127.0.0.1",
      "*.8.8.8.8",
      "metadata.internal",
      "example.com.",
      "example..com",
    ]) {
      expect(() => validateDerivationBrowserDomains([domain], domain.replace(/^\*\./u, "")))
        .toThrow();
    }
  });

  test("pins a validated public answer while streaming an opaque body unchanged", async () => {
    const target = await upstream();
    const connected: { readonly address: string; readonly port: number }[] = [];
    const proxy = await startDerivationNetworkProxy({
      browserDomains: ["upload.example.com"],
      resolveHostname: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      connectAddress: (address, port): Socket => {
        connected.push({ address: address.address, port });
        return connectTcp(target.port, "127.0.0.1");
      },
    });
    proxies.push(proxy);
    const body = [
      Buffer.alloc(96 * 1024, 0x61),
      Buffer.alloc(128 * 1024, 0x5a),
      Buffer.from("streamed-file-tail"),
    ];
    const response = await proxyExchange(proxy, "UPLOAD.EXAMPLE.COM:443", body);
    expect(response.toString("latin1")).toStartWith("HTTP/1.1 200 Connection Established");
    expect(connected).toEqual([{ address: "93.184.216.34", port: 443 }]);
    expect(Buffer.concat(target.received)).toEqual(Buffer.concat(body));
    expect(response.subarray(response.indexOf("\r\n\r\n") + 4)).toEqual(Buffer.concat(body));
  });

  test("fails DNS rebinding to private space before opening a destination socket", async () => {
    const target = await upstream();
    let privateAnswer = false;
    let connections = 0;
    const proxy = await startDerivationNetworkProxy({
      browserDomains: ["upload.example.com"],
      resolveHostname: () => Promise.resolve([privateAnswer
        ? { address: "127.0.0.1", family: 4 as const }
        : { address: "93.184.216.34", family: 4 as const }]),
      connectAddress: (): Socket => {
        connections += 1;
        return connectTcp(target.port, "127.0.0.1");
      },
    });
    proxies.push(proxy);
    expect((await proxyExchange(proxy, "upload.example.com", [Buffer.from("first")])).toString("latin1"))
      .toStartWith("HTTP/1.1 200");
    privateAnswer = true;
    expect((await proxyExchange(proxy, "upload.example.com")).toString("latin1"))
      .toStartWith("HTTP/1.1 403 Forbidden");
    expect(connections).toBe(1);
  });

  test("rejects unallowlisted, suffix-confused, trailing-dot, and cleartext proxy requests", async () => {
    let resolutions = 0;
    const proxy = await startDerivationNetworkProxy({
      browserDomains: ["*.example.com"],
      resolveHostname: () => {
        resolutions += 1;
        return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
      },
      connectAddress: () => {
        throw new Error("must not connect");
      },
    });
    proxies.push(proxy);
    for (const authority of ["notexample.com", "example.com.invalid"]) {
      expect((await proxyExchange(proxy, authority)).toString("latin1"))
        .toStartWith("HTTP/1.1 403 Forbidden");
    }
    expect((await proxyExchange(proxy, "example.com.")).toString("latin1"))
      .toStartWith("HTTP/1.1 400 Bad Request");
    const plain = await new Promise<string>((resolve, reject) => {
      const socket = connectTcp(proxy.port, "127.0.0.1");
      let output = "";
      socket.once("connect", () => socket.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"));
      socket.on("data", (chunk) => { output += chunk.toString("latin1"); });
      socket.once("end", () => resolve(output));
      socket.once("error", reject);
    });
    expect(plain).toStartWith("HTTP/1.1 403 Forbidden");
    expect(resolutions).toBe(0);
  });
});
