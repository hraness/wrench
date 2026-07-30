import { describe, expect, test } from "bun:test";

import {
  extractMetaJsonScriptTexts,
  extractMetaRelayBundleUrls,
  resolveMetaRelayDocId,
  resolveMetaRelayOperationRevision,
} from "./meta-relay-bundle";

const FRIENDLY_NAME = "CometFixtureFeedQuery";
const DOC_ID = "1234567890123456";
const OTHER_DOC_ID = "9876543210987654";

function asset(name: string): string {
  return `https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/${name}.js`;
}

function escapedAsset(name: string): string {
  return asset(name).replaceAll("/", "\\/");
}

function preloadAsset(href: string): string {
  return `<link rel="preload" as="script" crossorigin nonce href="${href}">`;
}

function relayModule(
  friendlyName = FRIENDLY_NAME,
  docId = DOC_ID,
): string {
  return `__d("${friendlyName}_facebookRelayOperation",[],(function(a,b,c,d,e,f){"use strict";e.exports="${docId}"}),null);`;
}

function rejectionMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected rejection");
}

describe("Meta Relay root-HTML asset extraction", () => {
  test("extracts only actual preload-script links, in attribute order, and deduplicates them", () => {
    const first = asset("first_Bundle-1");
    const second = asset("secondBundle");
    const resourceMap = Array.from(
      { length: 615 },
      (_, index) => escapedAsset(`resource_map_${index}`),
    );
    const html = [
      `<script src="${first}"></script>`,
      `<script type="application/json">${JSON.stringify(resourceMap)}</script>`,
      `<link href="${second}">`,
      `<link href="https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/styles.css">`,
      `<!-- ${preloadAsset(asset("comment-decoy"))} -->`,
      `<script>const decoy=${JSON.stringify(preloadAsset(asset("script-decoy")))}</script>`,
      `<div data-decoy='${preloadAsset(asset("attribute-decoy"))}'></div>`,
      `<link nonce href="${first}" crossorigin rel="preload" as="script">`,
      `<LINK AS='script' HREF='${second}' REL='preload'>`,
      preloadAsset(first),
    ].join("");
    const urls = extractMetaRelayBundleUrls(html);
    expect(urls).toEqual([first, second]);
    expect(Object.isFrozen(urls)).toBe(true);
  });

  test("accepts exactly 16 unique preload assets and rejects a seventeenth", () => {
    const sixteen = Array.from(
      { length: 16 },
      (_, index) => preloadAsset(asset(`bundle_${index}`)),
    ).join("");
    expect(extractMetaRelayBundleUrls(sixteen)).toHaveLength(16);
    expect(() => extractMetaRelayBundleUrls(
      `${sixteen}${preloadAsset(asset("bundle_16"))}`,
    )).toThrow("too many");
  });

  test("accepts a reviewed 333-character concatenated filename", () => {
    const longAsset = asset("x".repeat(333));
    expect(extractMetaRelayBundleUrls(preloadAsset(longAsset))).toEqual([longAsset]);
  });

  test("rejects malformed, foreign, credentialed, fragmented, queried, and noncanonical preload hrefs", () => {
    const valid = preloadAsset(asset("valid"));
    const invalid = [
      "http://static.xx.fbcdn.net/rsrc.php/v4/yA/r/insecure.js",
      "https://user:password@static.xx.fbcdn.net/rsrc.php/v4/yA/r/credentialed.js",
      "https://static.xx.fbcdn.net:444/rsrc.php/v4/yA/r/ported.js",
      "https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/fragmented.js#private-fragment",
      "https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/queried.js?private=query",
      "https://evil.example/rsrc.php/v4/yA/r/foreign.js",
      "https://static.xx.fbcdn.net.evil.example/rsrc.php/v4/yA/r/deceptive.js",
      "https://static.xx.fbcdn.net/other/v4/yA/r/wrong-path.js",
      "https://static.xx.fbcdn.net/rsrc.php/v4/../r/dot-segment.js",
      "https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/encoded%2Fpath.js",
      "https:\\/\\/static.xx.fbcdn.net/rsrc.php\\/v4\\/yA\\/r\\/mixed.js",
      "/rsrc.php/v4/yA/r/relative.js",
      "rsrc.php/v4/yA/r/bare-relative.js",
      "./rsrc.php/v4/yA/r/dot-relative.js",
      "../rsrc.php/v4/yA/r/parent-relative.js",
      "HTTPS://STATIC.XX.FBCDN.NET/RSRC.PHP/v4/yA/r/uppercase.JS",
      "https:&#x2F;&#x2F;static.xx.fbcdn.net&#x2F;rsrc.php&#x2F;v4&#x2F;yA&#x2F;r&#x2F;entity.js",
      "https:\\u002f\\u002fstatic.xx.fbcdn.net\\u002frsrc.php\\u002fv4\\u002fyA\\u002fr\\u002funicode.js",
      "javascript:https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/wrapped.js",
    ];
    for (const source of invalid) {
      expect(() => extractMetaRelayBundleUrls(
        `${valid}${preloadAsset(source)}`,
      )).toThrow();
    }
  });

  test("parses attributes strictly and rejects duplicate or ambiguous preload links", () => {
    const href = asset("strict");
    expect(extractMetaRelayBundleUrls(
      `<link nonce href='${href}' as=script crossorigin rel=preload>`,
    )).toEqual([href]);
    const malformed = [
      `<link rel="preload" rel="preload" as="script" href="${href}">`,
      `<link rel="preload" as="script" AS="script" href="${href}">`,
      `<link rel="preload" as="script" href="${href}" HREF="${href}">`,
      `<link rel="preload" as="script" href=${href}>`,
      "<link rel=\"preload\" as=\"script\">",
      `<link rel="preload"as="script" href="${href}">`,
      `<link rel="preload" as="script" href="${href}>`,
      `<link rel="preload stylesheet" as="script" href="${href}">`,
      `<link rel="PRELOAD" as="script" href="${href}">`,
      `<link rel="preload" as="SCRIPT" href="${href}">`,
      `<link rel="preload" as="script" bad@name href="${href}">`,
    ];
    for (const html of malformed) {
      expect(() => extractMetaRelayBundleUrls(html)).toThrow();
    }
  });

  test("ignores unrelated JavaScript URLs but rejects bad hrefs on matching links", () => {
    const valid = asset("only_preload");
    const foreign = "https://evil.example/rsrc.php/v4/yA/r/foreign.js";
    const html = [
      `<script src="${foreign}"></script>`,
      `<script type="application/json">${JSON.stringify({
        js: [foreign, escapedAsset("resource-map")],
      })}</script>`,
      `<link rel="stylesheet" as="script" href="${foreign}">`,
      `<link rel="preload" as="font" href="${foreign}">`,
      preloadAsset(valid),
    ].join("");
    expect(extractMetaRelayBundleUrls(html)).toEqual([valid]);
    expect(() => extractMetaRelayBundleUrls(
      `${preloadAsset(valid)}${preloadAsset(foreign)}`,
    )).toThrow();
  });

  test("rejects malformed and oversized HTML or preload hrefs without echoing content", () => {
    const privateMarker = "private-source-marker";
    const cases: readonly unknown[] = [
      null,
      "",
      "\0",
      "x".repeat((16 * 1024 * 1024) + 1),
      preloadAsset(
        `https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/${privateMarker}${"x".repeat(4_096)}.js`,
      ),
      preloadAsset(
        `https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/${privateMarker}.jsx`,
      ),
      preloadAsset(
        `https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/${privateMarker}.js/extra`,
      ),
      `<script>${privateMarker}`,
    ];
    for (const value of cases) {
      const message = rejectionMessage(() => extractMetaRelayBundleUrls(value));
      expect(message).not.toContain(privateMarker);
    }
  });

  test("rejects canonical-prefix smuggling inside a quoted preload href", () => {
    const privateMarker = "ambiguous-private";
    const ambiguous = [
      `data:text/plain,https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/${privateMarker}.js`,
      `${asset(privateMarker)}(suffix)`,
      `${asset(privateMarker)},suffix`,
      `${asset(privateMarker)};suffix`,
    ];
    for (const source of ambiguous) {
      const message = rejectionMessage(() => extractMetaRelayBundleUrls([
        preloadAsset(asset("valid")),
        preloadAsset(source),
      ].join("")));
      expect(message).not.toContain(privateMarker);
    }
  });

  test("accepts an observed-size JSON script tag while retaining a finite tag bound", () => {
    const json = '{"ok":true}';
    expect(extractMetaJsonScriptTexts(
      `<script data-observed="${"x".repeat(43_000)}" type="application/json">${json}</script>`,
    )).toEqual([json]);
    expect(() => extractMetaJsonScriptTexts(
      `<script data-oversized="${"x".repeat(66_000)}" type="application/json">${json}</script>`,
    )).toThrow("oversized element");
  });

  test("requires exact raw-text closing tags without attributes or slash tricks", () => {
    const json = '{"ok":true}';
    for (const closingTag of [
      "</script data-decoy>",
      "</script/>",
      "</script / >",
    ]) {
      expect(() => extractMetaJsonScriptTexts(
        `<script type="application/json">${json}${closingTag}`,
      )).toThrow("unterminated raw-text element");
    }
    expect(extractMetaJsonScriptTexts(
      `<script type="application/json">${json}</script \n\t>`,
    )).toEqual([json]);
  });

  test("bounds raw-text closing and unrelated parsed element tags", () => {
    const json = '{"ok":true}';
    expect(() => extractMetaJsonScriptTexts(
      `<script type="application/json">${json}</script${" ".repeat(66_000)}>`,
    )).toThrow("oversized element");
    expect(() => extractMetaJsonScriptTexts(
      `<unrelated data-oversized="${"x".repeat(66_000)}"><script type="application/json">${json}</script>`,
    )).toThrow("oversized element");
    expect(() => extractMetaJsonScriptTexts(
      `</unrelated${" ".repeat(66_000)}><script type="application/json">${json}</script>`,
    )).toThrow("oversized element");
  });
});

describe("Meta Relay current registered-operation resolution", () => {
  test("resolves one exact operation module and returns a frozen structural descriptor", () => {
    const bundle = [
      "__d(\"UnrelatedModule\",[],(function(a,b,c,d,e,f){e.exports=\"not-a-doc-id\"}),null);",
      relayModule(),
    ].join("");
    expect(resolveMetaRelayDocId([bundle], FRIENDLY_NAME)).toBe(DOC_ID);
    const resolved = resolveMetaRelayOperationRevision([bundle], FRIENDLY_NAME);
    expect(resolved).toEqual({
      schemaVersion: 1,
      friendlyName: FRIENDLY_NAME,
      moduleName: `${FRIENDLY_NAME}_facebookRelayOperation`,
      docId: DOC_ID,
      agreeingBundleCount: 1,
    });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  test("accepts identical revision evidence across distinct bundles only when it agrees", () => {
    const first = `${relayModule()}var afterFirst=1;`;
    const second = `var beforeSecond=2;${relayModule()}`;
    expect(resolveMetaRelayOperationRevision([first, second], FRIENDLY_NAME)).toMatchObject({
      docId: DOC_ID,
      agreeingBundleCount: 2,
    });

    const message = rejectionMessage(() => resolveMetaRelayDocId([
      first,
      relayModule(FRIENDLY_NAME, OTHER_DOC_ID),
    ], FRIENDLY_NAME));
    expect(message).toContain("ambiguous");
    expect(message).not.toContain(DOC_ID);
    expect(message).not.toContain(OTHER_DOC_ID);
  });

  test("rejects duplicate target modules inside one bundle even when IDs agree", () => {
    const message = rejectionMessage(() => resolveMetaRelayDocId(
      [`${relayModule()}${relayModule()}`],
      FRIENDLY_NAME,
    ));
    expect(message).toContain("duplicate operation module");
    expect(message).not.toContain(DOC_ID);
  });

  test("ignores exact-looking module text inside strings, comments, templates, regexes, and nested code", () => {
    const decoys = [
      `const quoted='${relayModule()}';`,
      `/* ${relayModule()} */`,
      `const templated=\`${relayModule()}\`;`,
      `const pattern=/__d\\("${FRIENDLY_NAME}_facebookRelayOperation"/;`,
      `if(true)/${relayModule().slice(0, -1)}/.test("");`,
      `function nested(){${relayModule()}}`,
      `__d("Consumer",["${FRIENDLY_NAME}_facebookRelayOperation"],(function(){}),null);`,
      relayModule(),
    ].join("");
    expect(resolveMetaRelayDocId([decoys], FRIENDLY_NAME)).toBe(DOC_ID);
  });

  test("does not promote a module-shaped sequence inside a regex after a block", () => {
    const deceptive = [
      "if(false){} /;__d(",
      `"${FRIENDLY_NAME}_facebookRelayOperation",[],`,
      `(function(a,b,c,d,e,f){"use strict";e.exports="${DOC_ID}"}),null);/; /x/;`,
    ].join("");
    expect(() => resolveMetaRelayDocId([deceptive], FRIENDLY_NAME))
      .toThrow("omitted");
    expect(resolveMetaRelayDocId(
      [`${deceptive}${relayModule()}`],
      FRIENDLY_NAME,
    )).toBe(DOC_ID);
  });

  test("requires exact friendly-name and module boundaries", () => {
    const bundle = [
      relayModule(`Prefix${FRIENDLY_NAME}`),
      relayModule(`${FRIENDLY_NAME}Suffix`),
    ].join("");
    expect(() => resolveMetaRelayDocId([bundle], FRIENDLY_NAME)).toThrow("omitted");
    for (const friendlyName of [
      null,
      "A",
      "Bad-Name",
      "_LeadingUnderscore",
      `A${"x".repeat(161)}`,
    ]) {
      expect(() => resolveMetaRelayDocId([relayModule()], friendlyName)).toThrow(
        "friendly name",
      );
    }
  });

  test("rejects target calls outside a direct top-level module statement", () => {
    const unreviewedBoundaries = [
      `0,${relayModule()}`,
      `true&&${relayModule()}`,
      `window.${relayModule()}`,
      `${relayModule().slice(0, -1)}.value;`,
    ];
    for (const bundle of unreviewedBoundaries) {
      const message = rejectionMessage(() => resolveMetaRelayDocId(
        [bundle],
        FRIENDLY_NAME,
      ));
      expect(message).toContain("boundary");
      expect(message).not.toContain(DOC_ID);
    }
    expect(resolveMetaRelayDocId(
      [`/* inert license */\n${relayModule()}`],
      FRIENDLY_NAME,
    )).toBe(DOC_ID);
  });

  test("rejects short, long, nondigit, indirect, duplicate, and structurally loose exports", () => {
    const moduleName = `${FRIENDLY_NAME}_facebookRelayOperation`;
    const cases = [
      relayModule(FRIENDLY_NAME, "123456789"),
      relayModule(FRIENDLY_NAME, "1".repeat(25)),
      relayModule(FRIENDLY_NAME, "123456789x"),
      `__d("${moduleName}",[],(function(a,b,c,d,e,f){"use strict";var x="${DOC_ID}";e.exports=x}),null);`,
      `__d("${moduleName}",[],(function(a,b,c,d,e,f){"use strict";e.exports="${DOC_ID}";e.exports="${DOC_ID}"}),null);`,
      `__d("${moduleName}",["Dependency"],(function(a,b,c,d,e,f,g){"use strict";e.exports="${DOC_ID}"}),null);`,
      `window.__d("${moduleName}",[],(function(a,b,c,d,e,f){"use strict";e.exports="${DOC_ID}"}),null);`,
    ];
    for (const bundle of cases) {
      const message = rejectionMessage(() => resolveMetaRelayDocId([bundle], FRIENDLY_NAME));
      expect(message).not.toContain(DOC_ID);
    }
  });

  test("bounds bundle count, individual bytes, aggregate bytes, and array shape", () => {
    expect(() => resolveMetaRelayDocId([], FRIENDLY_NAME)).toThrow("between 1 and 64");
    expect(() => resolveMetaRelayDocId(
      Array.from({ length: 65 }, () => relayModule()),
      FRIENDLY_NAME,
    )).toThrow("between 1 and 64");
    expect(() => resolveMetaRelayDocId([null], FRIENDLY_NAME)).toThrow("bounded inert text");
    expect(() => resolveMetaRelayDocId(
      [`${relayModule()}${"x".repeat(16 * 1024 * 1024)}`],
      FRIENDLY_NAME,
    )).toThrow("bounded inert text");
    const aggregateChunk = "é".repeat(8 * 1024 * 1024);
    expect(() => resolveMetaRelayDocId(
      [aggregateChunk, aggregateChunk, aggregateChunk, aggregateChunk, "x"],
      FRIENDLY_NAME,
    )).toThrow("aggregate byte bound");

    const withExtra = [relayModule()] as string[] & { extra?: boolean };
    withExtra.extra = true;
    expect(() => resolveMetaRelayDocId(withExtra, FRIENDLY_NAME)).toThrow(
      "unsupported fields",
    );
    const sparse = new Array(2);
    sparse[1] = relayModule();
    expect(() => resolveMetaRelayDocId(sparse, FRIENDLY_NAME)).toThrow("dense plain array");

    const trapped = new Proxy([relayModule()], {
      ownKeys() {
        throw new Error(DOC_ID);
      },
    });
    const trappedMessage = rejectionMessage(() => resolveMetaRelayDocId(
      trapped,
      FRIENDLY_NAME,
    ));
    expect(trappedMessage).toContain("plain data");
    expect(trappedMessage).not.toContain(DOC_ID);
  });

  test("redacts doc IDs and bundle content from every parser failure", () => {
    const privateContent = "private-bundle-content";
    const malformed = [
      `__d("${FRIENDLY_NAME}_facebookRelayOperation",[],(function(a,b,c,d,e,f){"use strict";e.exports="${DOC_ID}";${privateContent}}),null);`,
      `/* ${privateContent}`,
      `const value="${privateContent}`,
      `(${privateContent}`,
    ];
    for (const bundle of malformed) {
      const message = rejectionMessage(() => resolveMetaRelayDocId([bundle], FRIENDLY_NAME));
      expect(message).not.toContain(DOC_ID);
      expect(message).not.toContain(privateContent);
    }
  });
});
