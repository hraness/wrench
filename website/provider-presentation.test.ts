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
  createWhatsAppPresentationFacts,
  PROVIDER_PRESENTATIONS,
  renderProviderAttestationGroups,
  renderProviderOverviewCards,
} from "./provider-presentation";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("provider presentation", () => {
  test("groups the release attestation into exact public surfaces", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const directory = createProviderDirectory(attestation);
    const supportedSurfaceIds = PROVIDER_PRESENTATIONS
      .map((entry) => entry.surfaceId)
      .filter((surfaceId) => attestation.rows.some((row) =>
        row.surfaceId === surfaceId && row.completeness === "observed"));

    expect(directory.providerCount).toBe(supportedSurfaceIds.length);
    expect(directory.entries.map((entry) => entry.surfaceId)).toEqual(
      supportedSurfaceIds,
    );
    expect(directory.entries.reduce((sum, entry) => sum + entry.operationCount, 0))
      .toBe(attestation.observedCount);
    expect(directory.entries.reduce((sum, entry) => sum + entry.observedCount, 0))
      .toBe(attestation.observedCount);
    expect(directory.entries.every((entry) =>
      entry.supportedActionCount > 0 && entry.capabilities.length > 0)).toBe(true);

    expect(directory.entries[0]).toMatchObject({
      adapterCount: 1,
      adapterIdentities: [{ id: "beeper-local", version: "2.3.0" }],
      captureRequiredCount: 0,
      contractVersions: [1, 2, 3],
      href: "/providers/beeper/",
      name: "Beeper",
      observedCount: 32,
      operationCount: 32,
      supportedActionCount: 32,
      surfaceId: "beeper",
      transports: ["local-cli"],
    });
    expect(directory.entries.find((entry) => entry.surfaceId === "whatsapp")).toMatchObject({
      adapterIdentities: [{ id: "whatsapp-web", version: "1.4.0" }],
      href: "/providers/whatsapp/",
      observedCount: 4,
      supportedActionCount: 4,
      transports: ["linked-device"],
    });
    for (const entry of directory.entries) {
      const supportedRows = attestation.rows.filter((row) =>
        row.surfaceId === entry.surfaceId && row.completeness === "observed");
      expect(entry.observedCount).toBe(supportedRows.length);
      expect(entry.operationCount).toBe(supportedRows.length);
      expect(entry.supportedActionCount).toBe(new Set(supportedRows.map((row) => row.operation)).size);
      expect(entry.transports).toEqual(
        [...new Set(supportedRows.map((row) => row.transport))].sort(),
      );
    }
    for (const surfaceId of PROVIDER_PRESENTATIONS.map((entry) => entry.surfaceId)) {
      const hasSupport = supportedSurfaceIds.includes(surfaceId);
      expect(directory.entries.some((entry) => entry.surfaceId === surfaceId)).toBe(hasSupport);
    }
  });

  test("binds the WhatsApp page to four R1 reads and exact Wacli provenance", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const facts = createWhatsAppPresentationFacts(
      createProviderDirectory(attestation),
      attestation,
    );
    expect(facts).toMatchObject({
      adapterVersion: "1.4.0",
      archiveSha256: "2b54f33d246e913a5c33525b4fc895a345363c2dcc673c70fa5f19cffb15d17d",
      binarySha256: "a900af4d0dfd10471bcdf74105b9f256d1a08574242a041df3e5985a548826aa",
      observedOperationCount: 4,
      wacliCommit: "a020de724180d31eccfa5241d45443402d62fb06",
      wacliVersion: "0.15.0",
    });

    const driftedRows = attestation.rows.map((row) =>
      row.surfaceId === "whatsapp" && row.completeness === "observed"
        ? Object.freeze({ ...row, risk: "R2" as const })
        : row);
    const drifted = Object.freeze({ ...attestation, rows: Object.freeze(driftedRows) });
    expect(() => createWhatsAppPresentationFacts(
      createProviderDirectory(drifted),
      drifted,
    )).toThrow("exactly four linked-device R1 reads");
  });

  test("binds Beeper marketing facts to reviewed code and adapter identity", async () => {
    const directory = createProviderDirectory(
      await loadProviderCapabilityAttestation(repositoryRoot),
    );
    const facts = createBeeperPresentationFacts(directory);
    expect(facts).toMatchObject({
      adapterVersion: "2.3.0",
      cliCommandCount: 101,
      cliCommit: "a416af06023449a87312dc11e54643fd9dc94b8c",
      cliReleaseUrl: "https://github.com/beeper/cli/releases/tag/v0.6.2",
      cliSourceDeclaredVersion: "0.6.1",
      cliSourcePackagePath: "packages/cli/package.json",
      cliSourceVersionDiscrepancy:
        "Official v0.6.2 binaries.json and the exact executable report 0.6.2, while package.json at tag a416af06023449a87312dc11e54643fd9dc94b8c declares 0.6.1; executable runtime identity remains authoritative.",
      cliVersion: "0.6.2",
      desktopApiCommit: "b9c1714410139c2139b597338cd002d785653e85",
      desktopApiVersion: "5.0.0",
      observedOperationCount: 32,
      pageDescription: BEEPER_PAGE_METADATA.description,
      pageTitle: BEEPER_PAGE_METADATA.title,
      semanticContractVersionLabel: "Contract versions 1, 2, 3",
      semanticContractVersions: [1, 2, 3],
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

    expect(facts.semanticContractVersions).toEqual([1, 2, 3]);
    expect(facts.semanticContractVersionLabel).toBe("Contract versions 1, 2, 3");
  });

  test("renders supported tasks without exposing internal readiness states", async () => {
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const directory = createProviderDirectory(attestation);
    const cards = renderProviderOverviewCards(directory);
    const groups = renderProviderAttestationGroups(directory, attestation);
    const iconSignatures = {
      beeper: '<path d="M5.5 5.5h13a2.5 2.5 0 0 1 2.5 2.5v6.5a2.5 2.5 0 0 1-2.5 2.5H11l-5.5 3v-3A2.5 2.5 0 0 1 3 16.5V8a2.5 2.5 0 0 1 2.5-2.5Z"></path>',
      broadcast: '<rect x="4" y="7" width="16" height="11" rx="2"></rect>',
      chat: '<path d="M5.5 5.5h13a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-5.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2.5-2.5Z"></path>',
      code: '<path d="m9 7-5 5 5 5M15 7l5 5-5 5M13.5 4 10.5 20"></path>',
      community: '<circle cx="9" cy="8" r="3"></circle><circle cx="17" cy="10" r="2.5"></circle>',
      mail: '<rect x="3" y="5" width="18" height="14" rx="2"></rect>',
      network: '<circle cx="5" cy="12" r="2.5"></circle><circle cx="19" cy="6" r="2.5"></circle><circle cx="19" cy="18" r="2.5"></circle>',
      news: '<rect x="4" y="3" width="16" height="18" rx="2"></rect>',
      photo: '<rect x="3" y="4" width="18" height="16" rx="3"></rect><circle cx="15.5" cy="9" r="2"></circle>',
      publish: '<path d="M5 3h10l4 4v14H5zM15 3v5h4"></path>',
      store: '<path d="M4 9h16l-1.5-5h-13zM5 9v11h14V9"></path>',
      video: '<rect x="3" y="5" width="18" height="14" rx="3"></rect>',
    } as const;

    expect(cards.match(/<article class="provider-card/gu)).toHaveLength(directory.providerCount);
    expect(cards.match(/class="provider-card-heading"/gu)).toHaveLength(directory.providerCount);
    expect(cards.match(/<span aria-hidden="true" class="provider-mark"/gu))
      .toHaveLength(directory.providerCount);
    expect(cards.match(/<svg aria-hidden="true" class="provider-icon" focusable="false"/gu))
      .toHaveLength(directory.providerCount);
    expect(new Set(directory.entries.map((entry) => entry.icon)))
      .toEqual(new Set(Object.keys(iconSignatures)));
    for (const entry of directory.entries) {
      expect(cards).toContain([
        `data-provider-icon="${entry.icon}">`,
        '<svg aria-hidden="true" class="provider-icon" focusable="false" viewBox="0 0 24 24">',
        iconSignatures[entry.icon],
      ].join(""));
    }
    expect(cards.indexOf(">Beeper</a>")).toBeLessThan(cards.indexOf(">Bluesky</a>"));
    expect(cards).toContain("32 supported actions");
    expect(cards).toContain("Accounts · Bridges · Contacts · Conversations · Messages · Presence · Reactions");
    expect(cards).toContain(
      "32 reviewed actions: 27 through one pinned CLI and five fixed Desktop reads; writes are previewed and uncertain outcomes stay unretriable.",
    );
    expect(cards).not.toContain("other supported actions");
    expect(cards).not.toContain("{{");
    expect(cards).not.toMatch(/observed|capture-required|adapter/iu);
    expect(groups.match(/class="provider-attestation-group"/gu)).toHaveLength(directory.providerCount);
    expect(groups).toContain('id="provider-linkedin"');
    expect(groups).toContain("List accounts");
    expect(groups).toContain("Save article draft");
    expect(groups).toContain("Update conversation read state");
    expect(groups).toContain("Search message content");
    expect(groups).toContain("Read message context");
    expect(groups).toContain("<strong>Read message</strong> — <code>messaging.message.read</code>");
    expect(groups).toContain("Local app");
    expect(groups).not.toMatch(/observed|capture-required|adapter|completeness|<th/iu);
    for (const row of attestation.rows.filter((candidate) =>
      candidate.completeness === "observed")) {
      expect(groups).toContain(`<code>${row.operation}</code>`);
    }
    for (const entry of PROVIDER_PRESENTATIONS.filter((definition) =>
      !directory.entries.some((candidate) => candidate.surfaceId === definition.surfaceId))) {
      expect(cards).not.toContain(`>${entry.name}</a>`);
      expect(groups).not.toContain(`id="provider-${entry.surfaceId}"`);
    }
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

  test("omits surfaces that have no supported actions from the public directory", () => {
    const attestation = Object.freeze({
      adapterCount: 2,
      captureRequiredCount: 1,
      observedCount: 1,
      operationCount: 2,
      rows: Object.freeze([
        Object.freeze({
          adapterId: "beeper-local",
          adapterVersion: "1.0.0",
          completeness: "observed" as const,
          contractVersion: 1,
          displayName: "Beeper fixture",
          kind: "local-cli" as const,
          limit: "List contacts.",
          operation: "contacts.list",
          pluginId: "beeper-fixture",
          risk: "R1" as const,
          surfaceId: "beeper",
          transport: "local-cli" as const,
        }),
        Object.freeze({
          adapterId: "fixture-api",
          adapterVersion: "1.0.0",
          completeness: "capture-required" as const,
          contractVersion: 1,
          displayName: "Fixture API",
          kind: "official-api" as const,
          limit: "Read posts.",
          operation: "posts.read",
          pluginId: "fixture",
          risk: "R1" as const,
          surfaceId: "fixture",
          transport: "provider-api" as const,
        }),
      ]),
    } satisfies ProviderCapabilityAttestation);
    const directory = createProviderDirectory(attestation, [
      { accent: "blue", icon: "chat", name: "Beeper", surfaceId: "beeper" },
      { accent: "ink", icon: "code", name: "Fixture", surfaceId: "fixture" },
    ]);

    expect(directory.entries.map((entry) => entry.surfaceId)).toEqual(["beeper"]);
    expect(renderProviderOverviewCards(directory)).not.toContain("Fixture");
    expect(renderProviderAttestationGroups(directory, attestation)).not.toContain("provider-fixture");
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
