import {
  BEEPER_CLI_COMMAND_COVERAGE,
  BEEPER_CLI_PIN,
  BEEPER_DESKTOP_API_PIN,
  BEEPER_LOCAL_OPERATION_NAMES,
} from "../src/providers/beeper-local";
import type {
  ProviderCapabilityAttestation,
  ProviderCapabilityAttestationRow,
} from "./provider-capability-attestation";

type ProviderIcon =
  | "broadcast"
  | "chat"
  | "code"
  | "community"
  | "mail"
  | "network"
  | "news"
  | "photo"
  | "publish"
  | "store"
  | "video";

type ProviderPresentationDefinition = Readonly<{
  accent: "blue" | "coral" | "gold" | "green" | "ink" | "violet";
  icon: ProviderIcon;
  name: string;
  surfaceId: string;
}>;

export const PROVIDER_PRESENTATIONS = Object.freeze([
  { accent: "blue", icon: "chat", name: "Beeper", surfaceId: "beeper" },
  { accent: "blue", icon: "network", name: "Bluesky", surfaceId: "bluesky" },
  { accent: "blue", icon: "network", name: "Facebook", surfaceId: "facebook" },
  { accent: "blue", icon: "community", name: "Facebook Groups", surfaceId: "facebook-group" },
  { accent: "blue", icon: "store", name: "Facebook Marketplace", surfaceId: "facebook-marketplace" },
  { accent: "blue", icon: "publish", name: "Facebook Pages", surfaceId: "facebook-page" },
  { accent: "ink", icon: "code", name: "GitHub", surfaceId: "github" },
  { accent: "coral", icon: "mail", name: "Gmail", surfaceId: "gmail" },
  { accent: "gold", icon: "news", name: "Hacker News", surfaceId: "hacker-news" },
  { accent: "violet", icon: "photo", name: "Instagram", surfaceId: "instagram" },
  { accent: "blue", icon: "chat", name: "iMessage", surfaceId: "imessage" },
  { accent: "blue", icon: "network", name: "LinkedIn", surfaceId: "linkedin" },
  { accent: "coral", icon: "community", name: "Reddit", surfaceId: "reddit" },
  { accent: "coral", icon: "publish", name: "Substack", surfaceId: "substack" },
  { accent: "blue", icon: "chat", name: "Telegram", surfaceId: "telegram" },
  { accent: "ink", icon: "community", name: "Threads", surfaceId: "threads" },
  { accent: "violet", icon: "video", name: "TikTok", surfaceId: "tiktok" },
  { accent: "violet", icon: "broadcast", name: "Twitch", surfaceId: "twitch" },
  { accent: "green", icon: "chat", name: "WhatsApp", surfaceId: "whatsapp" },
  { accent: "ink", icon: "publish", name: "X", surfaceId: "x" },
  { accent: "coral", icon: "video", name: "YouTube", surfaceId: "youtube" },
] as const satisfies readonly ProviderPresentationDefinition[]);

export type ProviderDirectoryEntry = Readonly<{
  accent: ProviderPresentationDefinition["accent"];
  adapterIdentities: readonly Readonly<{
    id: string;
    version: string;
  }>[];
  adapterCount: number;
  capabilities: readonly string[];
  captureRequiredCount: number;
  contractVersions: readonly number[];
  href: string;
  icon: ProviderIcon;
  name: string;
  observedCount: number;
  operationCount: number;
  supportedActionCount: number;
  surfaceId: string;
  transports: readonly ProviderCapabilityAttestationRow["transport"][];
}>;

export type ProviderDirectory = Readonly<{
  entries: readonly ProviderDirectoryEntry[];
  providerCount: number;
}>;

export type BeeperPresentationFacts = Readonly<{
  adapterVersion: string;
  artifactTable: string;
  cliCommandCount: number;
  cliCommit: string;
  cliReleaseManifestSha256: string;
  cliReleaseUrl: string;
  cliVersion: string;
  desktopApiCommit: string;
  desktopApiVersion: string;
  observedOperationCount: number;
  pageDescription: string;
  pageTitle: string;
  semanticContractVersionLabel: string;
  semanticContractVersions: readonly number[];
}>;

export const BEEPER_PAGE_METADATA = Object.freeze({
  description:
    `Use ${BEEPER_LOCAL_OPERATION_NAMES.length} supported Wrench actions to read and act through the official Beeper CLI ${BEEPER_CLI_PIN.version} and one connected Beeper Desktop account.`,
  title:
    `Beeper support in Wrench: ${BEEPER_LOCAL_OPERATION_NAMES.length} supported actions`,
} as const);

export const TELEGRAM_PAGE_METADATA = Object.freeze({
  description:
    "Sync Telegram contacts through the official TDLib user-client API into a private local Wrench projection, without using the Bot API or scanning message history.",
  title: "Telegram contacts with Wrench: private TDLib user-session sync",
} as const);

function capabilityLabel(operation: string): string {
  switch (operation.split(".")[0]) {
    case "accounts": return "Accounts";
    case "articles": return "Articles";
    case "bridges": return "Bridges";
    case "comments": return "Comments";
    case "communities": return "Communities";
    case "contacts": return "Contacts";
    case "content": return "Content";
    case "conversations": return "Conversations";
    case "feeds": return "Feeds";
    case "likes": return "Likes";
    case "listings": return "Listings";
    case "media": return "Media";
    case "messaging": return "Messages";
    case "organizations": return "Organizations";
    case "posts": return "Posts";
    case "presence": return "Presence";
    case "profiles": return "Profiles";
    case "reactions": return "Reactions";
    case "relationships": return "Relationships";
    case "replies": return "Replies";
    case "threads": return "Threads";
    default: throw new Error(`provider operation ${operation} has no public capability label`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort(compareStrings);
}

export function createProviderDirectory(
  attestation: ProviderCapabilityAttestation,
  definitions: readonly ProviderPresentationDefinition[] = PROVIDER_PRESENTATIONS,
): ProviderDirectory {
  if (attestation.rows.length < 1) {
    throw new Error("provider presentation requires at least one attested operation");
  }
  const definitionsBySurface = new Map<string, ProviderPresentationDefinition>();
  for (const [index, definition] of definitions.entries()) {
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(definition.surfaceId)) {
      throw new Error(`provider presentation surface ${definition.surfaceId} is not strict kebab-case`);
    }
    if (definition.name.trim() !== definition.name || definition.name.length < 1) {
      throw new Error(`provider presentation ${definition.surfaceId} has an invalid public name`);
    }
    if (definition.surfaceId === "beeper" && index !== 0) {
      throw new Error("Beeper must remain the first provider presentation");
    }
    if (definitionsBySurface.has(definition.surfaceId)) {
      throw new Error(`provider presentation repeats surface ${definition.surfaceId}`);
    }
    definitionsBySurface.set(definition.surfaceId, definition);
  }
  if (definitions[0]?.surfaceId !== "beeper") {
    throw new Error("Beeper must remain the first provider presentation");
  }

  const adapterIdentities = new Map<string, Readonly<{
    displayName: string;
    kind: ProviderCapabilityAttestationRow["kind"];
    surfaceId: string;
    transport: ProviderCapabilityAttestationRow["transport"];
    version: string;
  }>>();
  const adapterOperations = new Set<string>();
  for (const row of attestation.rows) {
    const validTransport =
      (row.kind === "official-api" && row.transport === "provider-api")
      || (row.kind === "local-cli" && row.transport === "local-cli")
      || (row.kind === "linked-device" && row.transport === "linked-device")
      || (
        row.kind === "authenticated-web"
        && row.transport === "web-session-api"
      );
    if (!validTransport) {
      throw new Error(`provider adapter ${row.adapterId} has an invalid ${row.kind}/${row.transport} channel`);
    }
    const identity = adapterIdentities.get(row.adapterId);
    const nextIdentity = Object.freeze({
      displayName: row.displayName,
      kind: row.kind,
      surfaceId: row.surfaceId,
      transport: row.transport,
      version: row.adapterVersion,
    });
    if (identity === undefined) {
      adapterIdentities.set(row.adapterId, nextIdentity);
    } else if (
      identity.displayName !== nextIdentity.displayName
      || identity.kind !== nextIdentity.kind
      || identity.surfaceId !== nextIdentity.surfaceId
      || identity.transport !== nextIdentity.transport
      || identity.version !== nextIdentity.version
    ) {
      throw new Error(`provider adapter ${row.adapterId} changes identity across operations`);
    }
    const operationKey = `${row.adapterId}:${row.operation}`;
    if (adapterOperations.has(operationKey)) {
      throw new Error(`provider attestation repeats ${operationKey}`);
    }
    adapterOperations.add(operationKey);
  }
  const observedCount = attestation.rows.filter((row) => row.completeness === "observed").length;
  const captureRequiredCount = attestation.rows.filter((row) =>
    row.completeness === "capture-required").length;
  if (
    attestation.operationCount !== attestation.rows.length
    || attestation.adapterCount !== adapterIdentities.size
    || attestation.observedCount !== observedCount
    || attestation.captureRequiredCount !== captureRequiredCount
    || observedCount + captureRequiredCount !== attestation.rows.length
  ) {
    throw new Error("provider attestation totals do not match its operation rows");
  }
  const attestedSurfaces = new Set(attestation.rows.map((row) => row.surfaceId));
  const presentedSurfaces = new Set(definitionsBySurface.keys());
  const missingPresentation = setDifference(attestedSurfaces, presentedSurfaces);
  const missingAttestation = setDifference(presentedSurfaces, attestedSurfaces);
  if (missingPresentation.length > 0 || missingAttestation.length > 0) {
    throw new Error([
      missingPresentation.length > 0
        ? `unpresented attested surfaces: ${missingPresentation.join(", ")}`
        : "",
      missingAttestation.length > 0
        ? `presentation surfaces without an attestation: ${missingAttestation.join(", ")}`
        : "",
    ].filter(Boolean).join("; "));
  }

  const entries = definitions.flatMap((definition): ProviderDirectoryEntry[] => {
    const rows = attestation.rows.filter((row) => row.surfaceId === definition.surfaceId);
    const supportedRows = rows.filter((row) => row.completeness === "observed");
    if (supportedRows.length === 0) return [];
    const adapterIdentities = [...new Map(supportedRows.map((row) => [
      row.adapterId,
      Object.freeze({ id: row.adapterId, version: row.adapterVersion }),
    ] as const)).values()].sort((left, right) => compareStrings(left.id, right.id));
    const contractVersions = [...new Set(supportedRows.map((row) => row.contractVersion))]
      .sort((left, right) => left - right);
    const transports = [...new Set(supportedRows.map((row) => row.transport))].sort(compareStrings);
    const observedCount = rows.filter((row) => row.completeness === "observed").length;
    const captureRequiredCount = rows.filter((row) =>
      row.completeness === "capture-required").length;
    if (observedCount + captureRequiredCount !== rows.length) {
      throw new Error(`provider presentation could not classify every ${definition.surfaceId} operation`);
    }
    return [Object.freeze({
      accent: definition.accent,
      adapterCount: adapterIdentities.length,
      adapterIdentities: Object.freeze(adapterIdentities),
      capabilities: Object.freeze([...new Set(supportedRows.map((row) =>
        capabilityLabel(row.operation)))].sort(compareStrings)),
      captureRequiredCount,
      contractVersions: Object.freeze(contractVersions),
      href: definition.surfaceId === "beeper"
        ? "/providers/beeper/"
        : definition.surfaceId === "telegram"
          ? "/providers/telegram/"
          : `/provider-capabilities/#provider-${definition.surfaceId}`,
      icon: definition.icon,
      name: definition.name,
      observedCount,
      operationCount: supportedRows.length,
      supportedActionCount: new Set(supportedRows.map((row) => row.operation)).size,
      surfaceId: definition.surfaceId,
      transports: Object.freeze(transports),
    })];
  });
  return Object.freeze({ entries: Object.freeze(entries), providerCount: entries.length });
}

function transportLabel(transport: ProviderCapabilityAttestationRow["transport"]): string {
  switch (transport) {
    case "linked-device": return "Linked device";
    case "local-cli": return "Local app";
    case "provider-api": return "Official API";
    case "web-session-api": return "Signed-in web session";
  }
}

function entryCountLabel(entry: ProviderDirectoryEntry): string {
  return `${entry.supportedActionCount} supported ${entry.supportedActionCount === 1 ? "action" : "actions"}`;
}

const providerIconPaths: Readonly<Record<ProviderIcon, readonly string[]>> = Object.freeze({
  broadcast: Object.freeze([
    '<rect x="4" y="7" width="16" height="11" rx="2"></rect>',
    '<path d="m9 22 3-4 3 4M8 3c2.7 2.3 5.3 2.3 8 0"></path>',
  ]),
  chat: Object.freeze([
    '<path d="M5.5 5.5h13a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-5.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2.5-2.5Z"></path>',
    '<path d="M8 10h8M8 13.5h5"></path>',
  ]),
  code: Object.freeze([
    '<path d="m9 7-5 5 5 5M15 7l5 5-5 5M13.5 4 10.5 20"></path>',
  ]),
  community: Object.freeze([
    '<circle cx="9" cy="8" r="3"></circle><circle cx="17" cy="10" r="2.5"></circle>',
    '<path d="M3.5 19c.6-3.3 2.4-5 5.5-5s4.9 1.7 5.5 5M14 15c3.6-.5 5.8.8 6.5 4"></path>',
  ]),
  mail: Object.freeze([
    '<rect x="3" y="5" width="18" height="14" rx="2"></rect>',
    '<path d="m4 7 8 6 8-6"></path>',
  ]),
  network: Object.freeze([
    '<circle cx="5" cy="12" r="2.5"></circle><circle cx="19" cy="6" r="2.5"></circle><circle cx="19" cy="18" r="2.5"></circle>',
    '<path d="m7.3 11 9.3-4M7.3 13l9.3 4"></path>',
  ]),
  news: Object.freeze([
    '<rect x="4" y="3" width="16" height="18" rx="2"></rect>',
    '<path d="M8 8h8M8 12h8M8 16h5"></path>',
  ]),
  photo: Object.freeze([
    '<rect x="3" y="4" width="18" height="16" rx="3"></rect><circle cx="15.5" cy="9" r="2"></circle>',
    '<path d="m5 17 4.5-4 3.2 2.5 2-1.8L19 17"></path>',
  ]),
  publish: Object.freeze([
    '<path d="M5 3h10l4 4v14H5zM15 3v5h4"></path>',
    '<path d="M8 12h8M8 16h6"></path>',
  ]),
  store: Object.freeze([
    '<path d="M4 9h16l-1.5-5h-13zM5 9v11h14V9"></path>',
    '<path d="M9 20v-6h6v6M3 9c0 2 3 3 4.5 1.2C9 12 12 12 13.5 10.2 15 12 18 11 21 9"></path>',
  ]),
  video: Object.freeze([
    '<rect x="3" y="5" width="18" height="14" rx="3"></rect>',
    '<path d="m10 9 5 3-5 3z"></path>',
  ]),
});

function renderProviderIcon(icon: ProviderIcon): string {
  return [
    '<svg aria-hidden="true" class="provider-icon" focusable="false" viewBox="0 0 24 24">',
    ...providerIconPaths[icon],
    "</svg>",
  ].join("");
}

export function renderProviderOverviewCards(directory: ProviderDirectory): string {
  return directory.entries.map((entry) => [
    `<article class="provider-card provider-accent-${entry.accent}${entry.surfaceId === "beeper" ? " provider-card-featured" : ""}">`,
    '<div class="provider-card-heading">',
    `<span aria-hidden="true" class="provider-mark" data-provider-icon="${entry.icon}">${renderProviderIcon(entry.icon)}</span>`,
    `<h3><a href="${escapeHtml(entry.href)}">${escapeHtml(entry.name)}</a></h3>`,
    "</div>",
    `<p class="provider-state"><strong>${entryCountLabel(entry)}</strong></p>`,
    `<p class="provider-capabilities">${entry.capabilities.map(escapeHtml).join(" · ")}</p>`,
    `<p class="provider-transport">${entry.transports.map(transportLabel).join(" + ")}</p>`,
    entry.surfaceId === "beeper"
      ? '<p class="provider-feature-copy">Read conversations and messages, then preview and confirm sends, edits, reactions, drafts, reminders, and other supported actions.</p>'
      : "",
    "</article>",
  ].join("")).join("");
}

const operationTitleOverrides: Readonly<Record<string, string>> = Object.freeze({
  "articles.draft.save": "Save article draft",
  "communities.membership.set": "Update community membership",
  "conversations.archive.set": "Update conversation archive state",
  "conversations.avatar.set": "Update conversation avatar",
  "conversations.description.set": "Update conversation description",
  "conversations.disappearing.set": "Update disappearing messages",
  "conversations.draft.set": "Update conversation draft",
  "conversations.focus": "Focus conversation",
  "conversations.mute.set": "Update conversation mute setting",
  "conversations.notify": "Send Notify Anyway",
  "conversations.pin.set": "Update conversation pin",
  "conversations.priority.set": "Update conversation priority",
  "conversations.read-state.set": "Update conversation read state",
  "conversations.reminder.set": "Update conversation reminder",
  "conversations.start": "Start conversation",
  "conversations.title.set": "Update conversation title",
  "messaging.content.search": "Search message content",
  "messaging.context.read": "Read message context",
  "messaging.edit": "Edit message",
  "messaging.list": "List messages",
  "messaging.message.read": "Read message",
  "messaging.read": "Read messages",
  "messaging.search": "Search messages",
  "messaging.send": "Send message",
  "relationships.follow.set": "Update follow relationship",
  "relationships.recommendations.read": "Read account recommendations",
});

const operationVerbLabels: Readonly<Record<string, string>> = Object.freeze({
  create: "Create",
  delete: "Delete",
  edit: "Edit",
  focus: "Open",
  list: "List",
  notify: "Notify",
  publish: "Publish",
  read: "Read",
  repost: "Repost",
  save: "Save",
  search: "Search",
  send: "Send",
  set: "Update",
  start: "Start",
});

function operationTitle(operation: string): string {
  const override = operationTitleOverrides[operation];
  if (override !== undefined) return override;
  const parts = operation.split(".");
  const verb = parts.pop();
  const subject = parts.map((part) => part.replaceAll("-", " ")).join(" ");
  const verbLabel = operationVerbLabels[verb ?? ""];
  if (verbLabel === undefined || subject.length < 1) {
    throw new Error(`provider operation ${operation} has no public action label`);
  }
  return `${verbLabel} ${subject}`;
}

export function renderProviderAttestationGroups(
  directory: ProviderDirectory,
  attestation: ProviderCapabilityAttestation,
): string {
  return directory.entries.map((entry) => {
    const supportedRows = attestation.rows.filter((row) =>
      row.surfaceId === entry.surfaceId && row.completeness === "observed");
    const rowsByOperation = new Map<string, ProviderCapabilityAttestationRow[]>();
    for (const row of supportedRows) {
      const operationRows = rowsByOperation.get(row.operation) ?? [];
      operationRows.push(row);
      rowsByOperation.set(row.operation, operationRows);
    }
    const actions = [...rowsByOperation.entries()].sort(([left], [right]) =>
      compareStrings(left, right)).map(([operation, rows]) => {
      const access = [...new Set(rows.map((row) => transportLabel(row.transport)))]
        .sort(compareStrings).join(" + ");
      return [
        "<li>",
        `<span><strong>${escapeHtml(operationTitle(operation))}</strong> — <code>${escapeHtml(operation)}</code></span>`,
        " ",
        `<span>· ${escapeHtml(access)}</span>`,
        "</li>",
      ].join("");
    }).join("");
    return [
      `<section class="provider-attestation-group" id="provider-${escapeHtml(entry.surfaceId)}">`,
      `<h3>${escapeHtml(entry.name)}</h3>`,
      `<p>${entryCountLabel(entry)}${entry.capabilities.length > 0 ? `: ${entry.capabilities.map(escapeHtml).join(", ")}.` : "."}</p>`,
      `<ul class="provider-operation-list">${actions}</ul>`,
      "</section>",
    ].join("");
  }).join("");
}

function renderBeeperArtifactTable(): string {
  const body = BEEPER_CLI_PIN.artifacts.map((artifact) => [
    "<tr>",
    `<th scope="row">${artifact.platform === "darwin" ? "macOS" : "Linux"} ${artifact.arch}</th>`,
    `<td><a href="${escapeHtml(artifact.downloadUrl)}">Official release asset</a></td>`,
    `<td><code>${artifact.archiveSha256}</code></td>`,
    `<td><code>${artifact.executableSha256}</code></td>`,
    "</tr>",
  ].join("")).join("");
  return [
    '<table><thead><tr><th scope="col">Runtime</th><th scope="col">Download</th><th scope="col">Archive SHA-256</th><th scope="col">Executable SHA-256</th></tr></thead>',
    `<tbody>${body}</tbody></table>`,
  ].join("");
}

export function createBeeperPresentationFacts(
  directory: ProviderDirectory,
): BeeperPresentationFacts {
  const beeper = directory.entries.find((entry) => entry.surfaceId === "beeper");
  if (beeper === undefined) throw new Error("provider presentation lost Beeper");
  const adapterIdentity = beeper.adapterIdentities[0];
  if (
    beeper.adapterIdentities.length !== 1
    || adapterIdentity?.id !== "beeper-local"
    || beeper.transports.length !== 1
    || beeper.transports[0] !== "local-cli"
    || beeper.captureRequiredCount !== 0
    || beeper.observedCount !== BEEPER_LOCAL_OPERATION_NAMES.length
  ) {
    throw new Error("Beeper presentation drifted from the exact local CLI contract");
  }
  if (adapterIdentity.version.length < 1 || beeper.contractVersions.length < 1) {
    throw new Error("Beeper presentation lost its adapter version");
  }
  const semanticContractVersionLabel = beeper.contractVersions.length === 1
    ? `Contract version ${beeper.contractVersions[0]}`
    : `Contract versions ${beeper.contractVersions.join(", ")}`;
  return Object.freeze({
    adapterVersion: adapterIdentity.version,
    artifactTable: renderBeeperArtifactTable(),
    cliCommandCount: Object.keys(BEEPER_CLI_COMMAND_COVERAGE).length,
    cliCommit: BEEPER_CLI_PIN.commit,
    cliReleaseManifestSha256: BEEPER_CLI_PIN.releaseManifestSha256,
    cliReleaseUrl: BEEPER_CLI_PIN.releaseUrl,
    cliVersion: BEEPER_CLI_PIN.version,
    desktopApiCommit: BEEPER_DESKTOP_API_PIN.commit,
    desktopApiVersion: BEEPER_DESKTOP_API_PIN.version,
    observedOperationCount: beeper.observedCount,
    pageDescription: BEEPER_PAGE_METADATA.description,
    pageTitle: BEEPER_PAGE_METADATA.title,
    semanticContractVersionLabel,
    semanticContractVersions: beeper.contractVersions,
  });
}
