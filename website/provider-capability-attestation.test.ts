import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { resolve } from "node:path";

import {
  escapeAttestationHtml,
  isProviderCapabilityCompleteness,
  loadProviderCapabilityAttestation,
  parseCurrentAdapterManifest,
  readCurrentAdapterManifestFiles,
  renderProviderCapabilityAttestationTable,
} from "./provider-capability-attestation";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("provider capability attestation", () => {
  test("joins current bundled adapter manifests to exactly one plugin contract each", async () => {
    const [attestation, adapterFiles] = await Promise.all([
      loadProviderCapabilityAttestation(repositoryRoot),
      readCurrentAdapterManifestFiles(repositoryRoot),
    ]);
    const expectedKeys = new Set<string>();
    for (const file of adapterFiles) {
      const manifest = parseCurrentAdapterManifest(file.value, file.fileName, file.relativePath);
      for (const operation of Object.keys(manifest.operations)) {
        expectedKeys.add(`${manifest.id}:${operation}`);
      }
    }
    expect(attestation.operationCount).toBe(expectedKeys.size);
    expect(attestation.adapterCount).toBe(adapterFiles.length);
    expect(attestation.observedCount + attestation.captureRequiredCount).toBe(attestation.operationCount);
    expect(attestation.rows).toHaveLength(attestation.operationCount);

    const rowKeys = attestation.rows.map((row) => `${row.adapterId}:${row.operation}`);
    expect(new Set(rowKeys).size).toBe(rowKeys.length);
    expect(rowKeys).toEqual([...rowKeys].sort((left, right) => left.localeCompare(right)));
    expect(new Set(rowKeys)).toEqual(expectedKeys);

    const gmailContacts = attestation.rows.find((row) =>
      row.adapterId === "gmail" && row.operation === "contacts.list");
    expect(gmailContacts).toMatchObject({
      completeness: "observed",
      contractVersion: 5,
      pluginId: "gmail-official",
      risk: "R1",
    });
    const facebookContacts = attestation.rows.find((row) =>
      row.adapterId === "facebook-web" && row.operation === "contacts.list");
    expect(facebookContacts).toMatchObject({
      completeness: "capture-required",
      pluginId: "meta-web",
    });
    const redditPublish = attestation.rows.find((row) =>
      row.adapterId === "reddit-web" && row.operation === "media.publish");
    expect(redditPublish).toMatchObject({
      completeness: "observed",
      contractVersion: 9,
    });
    expect(attestation.rows.some((row) => row.adapterId.includes("telegram") || row.displayName.includes("Telegram")))
      .toBe(false);
    expect(attestation.rows.every((row) => isProviderCapabilityCompleteness(row.completeness))).toBe(true);
  });

  test("fails closed when no plugin catalog can own a bundled adapter", async () => {
    await expect(loadProviderCapabilityAttestation(repositoryRoot, [])).rejects.toThrow(
      "exactly one src/plugins binding",
    );
  });

  test("renders a crawlable table that repeats every attested operation and limit", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const html = renderProviderCapabilityAttestationTable(attestation);
    expect(html.startsWith("<table>")).toBe(true);
    expect(html).toContain("<th scope=\"col\">Provider</th>");
    expect(html).toContain("<th scope=\"col\">Operation</th>");
    expect(html).toContain("<th scope=\"col\">Completeness</th>");
    expect(html).toContain("<th scope=\"col\">Limit</th>");
    expect(html.match(/<tr>/gu)?.length).toBe(attestation.operationCount + 1);
    for (const row of attestation.rows) {
      expect(html).toContain(`<code>${escapeAttestationHtml(row.adapterId)}</code>`);
      expect(html).toContain(`<code>${escapeAttestationHtml(row.operation)}</code>`);
      expect(html).toContain(`<code>${escapeAttestationHtml(row.completeness)}</code>`);
      expect(html).toContain(escapeAttestationHtml(row.limit));
    }
    expect(html).not.toContain("{{");
    expect(html).not.toContain("<script");
  });

  test("rejects adapter bytes that omit the current contract version", () => {
    expect(() => parseCurrentAdapterManifest({
      displayName: "Example",
      id: "example",
      operations: {
        "contacts.list": {
          description: "Observed contract: example.",
          risk: "R1",
        },
      },
      surfaceId: "example",
      version: "1.0.0",
    }, "wrench-web-adapter.json", "example.json")).toThrow("webSession");
  });

  test("escapes arbitrary attestation text and keeps completeness a closed union", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    fc.assert(
      fc.property(
        fc.constantFrom(...attestation.rows),
        fc.string(),
        (row, hostile) => {
          expect(["observed", "capture-required"]).toContain(row.completeness);
          expect(row.operation).toMatch(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u);
          const escaped = escapeAttestationHtml(`<${hostile}&"${row.adapterId}`);
          expect(escaped).not.toContain("<");
          expect(escaped).not.toContain(">");
          expect(escaped).toContain("&lt;");
          expect(escaped).toContain("&amp;");
          expect(escaped).toContain("&quot;");
        },
      ),
      { numRuns: 200 },
    );
  });
});
