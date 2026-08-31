#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const SITE_ORIGIN = "https://wrench.rip";
export const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;
export const INDEXNOW_KEY = "dc84ee4863539f2fff50ef5f0a164168";
export const INDEXNOW_KEY_LOCATION = `${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`;

const MAX_SITEMAP_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 256;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URLS = 100;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const SITEMAP_OPEN = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
`;
const SITEMAP_CLOSE = "</urlset>\n";
const XML_TEXT = "(?:[^<&\\r\\n]|&(?:amp|apos|gt|lt|quot);)+";
const URL_ENTRY = new RegExp(
  `  <url>\\n    <loc>([^<>&\\r\\n]+)</loc>(?:\\n    <image:image>\\n      <image:loc>(${XML_TEXT})</image:loc>\\n      <image:title>${XML_TEXT}</image:title>\\n      <image:caption>${XML_TEXT}</image:caption>\\n    </image:image>)?\\n  </url>\\n`,
  "gyu",
);

function fail(message) {
  throw new Error(message);
}

function exactContentType(response, expected, label) {
  const value = response.headers.get("content-type") ?? "";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!expected.has(mediaType)) {
    fail(`${label} returned unsupported Content-Type ${JSON.stringify(value)}`);
  }
}

export async function readBoundedText(response, maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail(`${label} byte bound is invalid`);
  }
  if (response.body === null) fail(`${label} returned no response body`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      fail(`${label} returned an invalid Content-Length`);
    }
    if (Number(declaredLength) > maximumBytes) {
      await response.body.cancel().catch(() => undefined);
      fail(`${label} exceeded ${String(maximumBytes)} bytes`);
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        fail(`${label} exceeded ${String(maximumBytes)} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function parseWrenchSitemap(xml) {
  if (typeof xml !== "string" || xml.length === 0) {
    fail("Wrench sitemap must be nonempty XML text");
  }
  if (!xml.startsWith(SITEMAP_OPEN) || !xml.endsWith(SITEMAP_CLOSE)) {
    fail("Wrench sitemap has an unsupported exact document boundary");
  }
  const body = xml.slice(SITEMAP_OPEN.length, -SITEMAP_CLOSE.length);
  const locations = [];
  URL_ENTRY.lastIndex = 0;
  while (URL_ENTRY.lastIndex < body.length) {
    const before = URL_ENTRY.lastIndex;
    const match = URL_ENTRY.exec(body);
    if (match === null || match.index !== before || match[1] === undefined) {
      fail("Wrench sitemap contains a malformed URL entry");
    }
    locations.push(match[1]);
  }
  if (URL_ENTRY.lastIndex !== body.length) {
    fail("Wrench sitemap contains trailing unsupported content");
  }
  if (locations.length < 1 || locations.length > MAX_URLS) {
    fail(`Wrench sitemap must contain between 1 and ${String(MAX_URLS)} locations`);
  }
  const urls = [];
  const seen = new Set();
  for (const value of locations) {
    if (value === undefined || value.length > 2_048) {
      fail("Wrench sitemap contains an invalid location");
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail("Wrench sitemap contains an invalid URL");
    }
    if (
      parsed.origin !== SITE_ORIGIN
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== ""
      || (parsed.pathname !== "/" && !parsed.pathname.endsWith("/"))
      || parsed.href !== `${SITE_ORIGIN}${parsed.pathname}`
    ) fail("Wrench sitemap contains a noncanonical location");
    if (seen.has(parsed.href)) fail("Wrench sitemap contains duplicate locations");
    seen.add(parsed.href);
    urls.push(parsed.href);
  }
  return Object.freeze(urls);
}

function requestSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
}

export async function submitCurrentWrenchSitemap(
  fetchImplementation = globalThis.fetch,
) {
  if (typeof fetchImplementation !== "function") fail("IndexNow fetch is unavailable");
  const sitemapResponse = await fetchImplementation(SITEMAP_URL, {
    headers: { accept: "application/xml, text/xml;q=0.9" },
    redirect: "error",
    signal: requestSignal(),
  });
  if (!sitemapResponse.ok) {
    await sitemapResponse.body?.cancel().catch(() => undefined);
    fail(`Wrench sitemap returned HTTP ${String(sitemapResponse.status)}`);
  }
  exactContentType(
    sitemapResponse,
    new Set(["application/xml", "text/xml"]),
    "Wrench sitemap",
  );
  const urls = parseWrenchSitemap(
    await readBoundedText(sitemapResponse, MAX_SITEMAP_BYTES, "Wrench sitemap"),
  );

  const keyResponse = await fetchImplementation(INDEXNOW_KEY_LOCATION, {
    headers: { accept: "text/plain" },
    redirect: "error",
    signal: requestSignal(),
  });
  if (!keyResponse.ok) {
    await keyResponse.body?.cancel().catch(() => undefined);
    fail(`IndexNow key returned HTTP ${String(keyResponse.status)}`);
  }
  exactContentType(keyResponse, new Set(["text/plain"]), "IndexNow key");
  const key = await readBoundedText(keyResponse, MAX_KEY_BYTES, "IndexNow key");
  if (key !== `${INDEXNOW_KEY}\n`) fail("IndexNow key does not match the checked public key");

  const notification = JSON.stringify({
    host: "wrench.rip",
    key: INDEXNOW_KEY,
    keyLocation: INDEXNOW_KEY_LOCATION,
    urlList: urls,
  });
  const response = await fetchImplementation(INDEXNOW_ENDPOINT, {
    body: notification,
    headers: {
      accept: "text/plain, application/json;q=0.9, */*;q=0.1",
      "content-type": "application/json; charset=utf-8",
      "user-agent": "hraness-wrench-indexnow/1.0",
    },
    method: "POST",
    redirect: "error",
    signal: requestSignal(),
  });
  if (response.status !== 200 && response.status !== 202) {
    const body = response.body === null
      ? ""
      : await readBoundedText(response, MAX_RESPONSE_BYTES, "IndexNow response");
    fail(`IndexNow returned HTTP ${String(response.status)}${body === "" ? "" : `: ${body}`}`);
  }
  await response.body?.cancel().catch(() => undefined);
  return Object.freeze({ status: response.status, urls });
}

async function main() {
  const result = await submitCurrentWrenchSitemap();
  process.stdout.write(
    `Submitted ${String(result.urls.length)} canonical Wrench URLs to IndexNow (HTTP ${String(result.status)}).\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
