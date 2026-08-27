import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  loadProviderCapabilityAttestation,
  type ProviderCapabilityAttestation,
} from "./provider-capability-attestation";
import {
  BEEPER_PAGE_METADATA,
  createBeeperPresentationFacts,
  createProviderDirectory,
  PROVIDER_PRESENTATIONS,
  renderProviderAttestationGroups,
  renderProviderOverviewCards,
} from "./provider-presentation";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("provider presentation", () => {
  test("groups the release attestation into exact public surfaces", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const directory = createProviderDirectory(attestation);

    expect(directory.providerCount).toBe(20);
    expect(directory.entries.map((entry) => entry.surfaceId)).toEqual(
      PROVIDER_PRESENTATIONS.map((entry) => entry.surfaceId),
    );
    expect(directory.entries.reduce((sum, entry) => sum + entry.operationCount, 0))
      .toBe(attestation.operationCount);
    expect(directory.entries.reduce((sum, entry) => sum + entry.observedCount, 0))
      .toBe(attestation.observedCount);
    expect(directory.entries.reduce((sum, entry) => sum + entry.captureRequiredCount, 0))
      .toBe(attestation.captureRequiredCount);

    expect(directory.entries[0]).toMatchObject({
      adapterCount: 1,
      adapterIdentities: [{ id: "beeper-local", version: "2.0.0" }],
      captureRequiredCount: 0,
      contractVersions: [1],
      href: "/providers/beeper/",
      name: "Beeper",
      observedCount: 32,
      operationCount: 32,
      surfaceId: "beeper",
      transports: ["local-cli"],
    });
    expect(directory.entries.find((entry) => entry.surfaceId === "linkedin")).toMatchObject({
      adapterCount: 2,
      captureRequiredCount: 17,
      observedCount: 12,
      operationCount: 29,
      transports: ["provider-api", "web-session-api"],
    });
    expect(directory.entries.find((entry) => entry.surfaceId === "x")).toMatchObject({
      adapterCount: 2,
      captureRequiredCount: 10,
      observedCount: 21,
      operationCount: 31,
      transports: ["provider-api", "web-session-api"],
    });
    expect(directory.entries.find((entry) => entry.surfaceId === "facebook-page"))
      .toMatchObject({ captureRequiredCount: 20, observedCount: 0, operationCount: 20 });
    expect(directory.entries.find((entry) => entry.surfaceId === "imessage")).toMatchObject({
      adapterCount: 1,
      captureRequiredCount: 0,
      observedCount: 5,
      operationCount: 5,
      transports: ["local-cli"],
    });
  });

  test("binds Beeper marketing facts to reviewed code and adapter identity", async () => {
    const directory = createProviderDirectory(
      await loadProviderCapabilityAttestation(repositoryRoot),
    );
    const facts = createBeeperPresentationFacts(directory);
    expect(facts).toMatchObject({
      adapterVersion: "2.0.0",
      cliCommandCount: 101,
      cliCommit: "a416af06023449a87312dc11e54643fd9dc94b8c",
      cliReleaseUrl: "https://github.com/beeper/cli/releases/tag/v0.6.2",
      cliVersion: "0.6.2",
      desktopApiCommit: "b9c1714410139c2139b597338cd002d785653e85",
      desktopApiVersion: "5.0.0",
      observedOperationCount: 32,
      pageDescription: BEEPER_PAGE_METADATA.description,
      pageTitle: BEEPER_PAGE_METADATA.title,
      semanticContractVersionLabel: "Contract version 1",
      semanticContractVersions: [1],
    });
    expect(facts.artifactTable.match(/<tbody><tr>/gu)).toHaveLength(1);
    expect(facts.artifactTable.match(/<tr>/gu)).toHaveLength(5);
    expect(facts.artifactTable).toContain("macOS arm64");
    expect(facts.artifactTable).toContain("Linux x64");
    expect(facts.artifactTable.match(/>Official release asset<\/a>/gu)).toHaveLength(4);
  });

  test("derives Beeper contract-version copy from every attested operation", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const changedRows = attestation.rows.map((row, index) => (
      row.surfaceId === "beeper" && index === attestation.rows.findIndex((candidate) =>
        candidate.surfaceId === "beeper")
        ? Object.freeze({ ...row, contractVersion: 2 })
        : row
    ));
    const facts = createBeeperPresentationFacts(createProviderDirectory({
      ...attestation,
      rows: Object.freeze(changedRows),
    }));

    expect(facts.semanticContractVersions).toEqual([1, 2]);
    expect(facts.semanticContractVersionLabel).toBe("Contract versions 1, 2");
  });

  test("renders crawlable cards and grouped operation evidence", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const directory = createProviderDirectory(attestation);
    const cards = renderProviderOverviewCards(directory);
    const groups = renderProviderAttestationGroups(directory, attestation);

    expect(cards.match(/<article class="provider-card/gu)).toHaveLength(20);
    expect(cards.indexOf(">Beeper</a>")).toBeLessThan(cards.indexOf(">Bluesky</a>"));
    expect(cards).toContain("32 of 32 observed");
    expect(cards).toContain("0 of 20 observed · 20 capture-required");
    expect(cards).toContain('aria-hidden="true"');
    expect(cards).not.toContain("{{");
    expect(groups.match(/class="provider-attestation-group"/gu)).toHaveLength(20);
    expect(groups.match(/class="provider-adapter"/gu)).toHaveLength(attestation.adapterCount);
    expect(groups).toContain('id="provider-linkedin"');
    expect(groups).toContain("LinkedIn (Official API)");
    expect(groups).toContain("LinkedIn (Authenticated Web API)");
    expect(groups).toContain('aria-label="Beeper (Pinned Local CLI) beeper-local operations"');
    expect(groups).toContain('<code>beeper-local</code> ·</span> <span>v2.0.0');
    expect(groups).toContain('<th scope="col">Risk</th>');
    expect(groups).toContain('<th scope="col">Contract</th>');
  });

  test("escapes presentation strings even when supplied by reviewed metadata", () => {
    const attestation = Object.freeze({
      adapterCount: 1,
      captureRequiredCount: 0,
      observedCount: 1,
      operationCount: 1,
      rows: Object.freeze([Object.freeze({
        adapterId: "beeper-local",
        adapterVersion: "1.0.0",
        completeness: "observed" as const,
        contractVersion: 1,
        displayName: "Fixture",
        kind: "local-cli" as const,
        limit: "fixture",
        operation: "contacts.list",
        pluginId: "fixture",
        risk: "R1" as const,
        surfaceId: "beeper",
        transport: "local-cli" as const,
      })]),
    } satisfies ProviderCapabilityAttestation);
    const directory = createProviderDirectory(attestation, [{
      accent: "blue",
      icon: "chat",
      name: "<script>alert(1)</script>",
      surfaceId: "beeper",
    }]);
    const html = renderProviderOverviewCards(directory);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("rejects drifted totals, identities, channels, and metadata sets", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    expect(() => createProviderDirectory({
      ...attestation,
      operationCount: attestation.operationCount + 1,
    })).toThrow("totals do not match");

    const first = attestation.rows[0]!;
    expect(() => createProviderDirectory({
      ...attestation,
      adapterCount: attestation.adapterCount,
      captureRequiredCount: attestation.captureRequiredCount,
      observedCount: attestation.observedCount + 1,
      operationCount: attestation.operationCount + 1,
      rows: Object.freeze([...attestation.rows, first]),
    })).toThrow(`repeats ${first.adapterId}:${first.operation}`);

    const illegalRows = attestation.rows.map((row, index) =>
      index === 0 ? Object.freeze({ ...row, transport: "provider-api" as const }) : row);
    expect(() => createProviderDirectory({ ...attestation, rows: Object.freeze(illegalRows) }))
      .toThrow("invalid local-cli/provider-api channel");

    expect(() => createProviderDirectory(attestation, PROVIDER_PRESENTATIONS.slice(1)))
      .toThrow("Beeper must remain the first");
    expect(() => createProviderDirectory(attestation, [...PROVIDER_PRESENTATIONS, {
      accent: "ink",
      icon: "code",
      name: "Fixture",
      surfaceId: "fixture",
    }])).toThrow("presentation surfaces without an attestation: fixture");
  });
});
