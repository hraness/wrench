import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_HAR_ENTRIES,
  analyzeHarFile,
  analyzeHarValue,
  emptyManifest,
  safePathTemplate,
  writeDerivationScaffold as writeDerivationScaffoldWithRegistry,
} from "./har";
import { parseManifest as parseManifestWithRegistry } from "./model";
import { providerPluginRegistry } from "./provider-plugins";

const parseManifest = (value: unknown) =>
  parseManifestWithRegistry(value, providerPluginRegistry);
const writeDerivationScaffold = (
  outputDirectory: Parameters<typeof writeDerivationScaffoldWithRegistry>[0],
  analysis: Parameters<typeof writeDerivationScaffoldWithRegistry>[1],
  options: Omit<
    Parameters<typeof writeDerivationScaffoldWithRegistry>[2],
    "registry"
  >,
) => writeDerivationScaffoldWithRegistry(outputDirectory, analysis, {
  ...options,
  registry: providerPluginRegistry,
});

function entry(url: string, options: { readonly method?: string; readonly secret?: string } = {}): Record<string, unknown> {
  const secret = options.secret ?? "private-message-value";
  const privateFieldName = "alice-private-field-name";
  return {
    request: {
      method: options.method ?? "POST",
      url,
      headers: [
        { name: "authorization", value: "Bearer secret-bearer-token" },
        { name: "cookie", value: "li_at=secret-cookie" },
        { name: "x-alice-private-header", value: "header-value" },
      ],
      postData: {
        mimeType: "application/json",
        text: JSON.stringify({ [privateFieldName]: secret, recipient: "Alice Smith", nested: { "private@example.com": "secret-csrf" } }),
      },
    },
    response: {
      status: 200,
      content: {
        mimeType: "application/json; private=secret-mime-parameter",
        text: JSON.stringify({ "bob-private-response-key": "bob-private-thread", body: secret, ok: true }),
      },
    },
  };
}

describe("HAR analysis", () => {
  test("retains structural metadata without path, query, header, or body values", () => {
    const analysis = analyzeHarValue({
      log: {
        entries: [
          entry("https://example.com/in/alice-smith/details?alice-private-query=query-secret"),
          entry("https://analytics.example/users/bob-private-path", { secret: "cross-origin-secret" }),
        ],
      },
    }, "example", "https://example.com", new Date("2026-07-21T12:00:00.000Z"));
    const rendered = JSON.stringify(analysis);
    expect(analysis.observedEntries).toBe(2);
    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.candidates[0]?.pathTemplate).toBe("/in/:segment1/details");
    expect(analysis.ignoredEntries).toBe(1);
    for (const secret of [
      "alice-smith",
      "bob-private-path",
      "query-secret",
      "secret-bearer-token",
      "secret-cookie",
      "private-message-value",
      "Alice Smith",
      "bob-private-thread",
      "secret-csrf",
      "cross-origin-secret",
      "alice-private-field-name",
      "private@example.com",
      "bob-private-response-key",
      "x-alice-private-header",
      "alice-private-query",
      "secret-mime-parameter",
    ]) expect(rendered).not.toContain(secret);
    expect(rendered).toContain("authorization");
    expect(rendered).toContain("custom-header");
    expect(rendered).toContain("query1");
    expect(rendered).toContain("field1");
    expect(rendered).toContain("responseShape");
  });

  test.each([
    ["/messages/thread-bob", "/messages/:segment1"],
    ["/invoice/acme-q3", "/:segment1/:segment2"],
    ["/users/alice@example.com", "/users/:segment1"],
    ["/voyager/api/v1/voyagerMessagingGraphQL/graphql", "/voyager/api/v1/:segment1/graphql"],
    [`/${"private-segment/".repeat(300)}`, "/:oversized-path"],
  ])("conservatively templates path values in %s", (input, expected) => {
    expect(safePathTemplate(input)).toBe(expected);
  });

  test("rejects excessive entry cardinality before analysis", () => {
    expect(() => analyzeHarValue({ log: { entries: Array.from({ length: MAX_HAR_ENTRIES + 1 }) } }, "site", "https://example.com"))
      .toThrow(`more than ${MAX_HAR_ENTRIES}`);
  });

  test("uses no-follow bounded reads and never writes through a symlink output", () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-har-test-"));
    chmodSync(directory, 0o700);
    try {
      const har = join(directory, "capture.har");
      writeFileSync(har, JSON.stringify({ log: { entries: [entry("https://example.com/api/messages")] } }), { mode: 0o600 });
      const analysis = analyzeHarValue(
        JSON.parse(readFileSync(har, "utf8")) as unknown,
        "example",
        "https://example.com",
        new Date("2026-07-21T12:00:00.000Z"),
        ["example.com", "assets.example.com"],
      );
      const output = join(directory, "adapter");
      const written = writeDerivationScaffold(output, analysis, { force: false });
      expect(lstatSync(output).mode & 0o777).toBe(0o700);
      expect(lstatSync(written.manifestPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(written.reservationPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(written.candidatesPath, "utf8")).not.toContain("secret-cookie");
      expect(readFileSync(written.reservationPath, "utf8")).not.toContain("secret-cookie");
      expect(JSON.parse(readFileSync(written.manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 5,
        browserDomains: ["example.com", "assets.example.com"],
      });
      const reservationText = readFileSync(written.reservationPath, "utf8");
      expect(JSON.parse(reservationText)).toMatchObject({
        state: "capture-required",
        targetOrigin: "https://example.com",
        targetManifestSchemaVersion: 5,
        evidence: { path: "derivation.candidates.json" },
      });
      expect(reservationText).toMatch(/"sha256":"[a-f0-9]{64}"/u);

      const target = join(directory, "target");
      mkdirSync(target);
      const linked = join(directory, "linked-output");
      symlinkSync(target, linked);
      expect(() => writeDerivationScaffold(linked, analysis, { force: true })).toThrow("real directory");

      const harLink = join(directory, "capture-link.har");
      symlinkSync(har, harLink);
      expect(() => analyzeHarFile(harLink, "example", "https://example.com")).toThrow("safely open");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("reviewed surface inference", () => {
  test("infers one exact surface, refuses ambiguous facets, and leaves custom sites generic", () => {
    const x = emptyManifest("x-reader", "https://x.com");
    expect(x.surfaceId).toBe("x");
    expect(parseManifest(x).ok).toBeTrue();

    expect(() => emptyManifest("facebook-reader", "https://www.facebook.com"))
      .toThrow("select one with --platform");

    const facebook = emptyManifest(
      "facebook-page-reader",
      "https://www.facebook.com",
      undefined,
      "facebook-page",
    );
    expect(facebook.surfaceId).toBe("facebook-page");
    expect(parseManifest(facebook).ok).toBeTrue();

    const custom = emptyManifest("custom-reader", "https://letters.example.com");
    expect(custom.surfaceId).toBeUndefined();
    expect(parseManifest(custom).ok).toBeTrue();
  });

  test("binds an explicitly selected custom Substack publication to its reviewed base origin", () => {
    const manifest = emptyManifest(
      "publication-reader",
      "https://letters.example.com",
      ["letters.example.com"],
      "substack",
    );
    expect(manifest).toMatchObject({
      surfaceId: "substack",
      origins: ["https://substack.com", "https://letters.example.com"],
      browserDomains: ["letters.example.com", "substack.com"],
    });
    expect(parseManifest(manifest).ok).toBeTrue();
    expect(() => emptyManifest("wrong-reader", "https://x.com", undefined, "linkedin"))
      .toThrow("not the selected linkedin surface");
  });
});
