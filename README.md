# Wrench

[![Wrench: precise web capabilities for AI agents](https://wrench.rip/og.png)](https://wrench.rip)

**Give your agent a precise handle on the web.**

Wrench is an open-source, bring-your-own-agent CLI and TypeScript SDK. It is the
capability and custody layer beneath any AI agent that can run a command: a way
to capture pages, preserve media, query encrypted snapshots, and use reviewed
account capabilities without handing the model a mouse, keyboard, cookie jar,
arbitrary HTTP client, or every signed-in tab.

The caller asks for a named outcome such as `messaging.list`. Wrench binds that
operation to one exact provider, transport, account realm, contract version,
implementation, and risk level. If those facts drift, the operation stops. It
does not silently fall back to general browser control.

Bring the model, planner, tool loop, approval interface, and application shell
you prefer. Wrench supplies precise web capabilities with local custody and
explicit evidence.

```sh
wrench https://example.com/article
wrench capabilities
wrench plugin list
```

[Project site](https://wrench.rip) · [Security policy](SECURITY.md) · [Plugin guide](docs/plugins.md)

## What Wrench does

- **Capture knowledge.** Turn a public URL into durable Markdown, inspect it
  without saving, and search the knowledge you keep locally.
- **Preserve media.** Archive one authorized, accessible, finite media item
  with source bytes, requested derivatives, transcript, manifest, and SHA-256
  integrity records.
- **Read connected services.** Store validated account-bound reads as encrypted
  exact-query snapshots, then load the last verified state without reopening a
  browser or contacting the provider.
- **Add one capability.** Turn a reviewed first-party exchange into a typed,
  semantic operation with strict inputs, bounded outputs, and explicit trust.

## Why Wrench is different

- **Intent over mechanism.** Agents receive labeled operations, not credentials,
  selectors, scripts, caller-selected endpoints, or unrestricted browser access.
- **Exact identity.** Authenticated calls bind the provider, origin, transport,
  account, contract, and implementation instead of relying on ambient state.
- **Visible drift.** A changed origin, account proof, status, field, or response
  shape returns to `capture-required` rather than guessing or changing tools.
- **Local custody.** Archives remain inspectable and exact provider snapshots
  remain encrypted. Verified cached reads can work without a provider roundtrip.
- **Honest mutations.** Consequential writes require an exact preview and durable
  dispatch evidence. An indeterminate write is reconciled and never blindly retried.
- **Content-bound trust.** Portable plugin approval applies to one verified
  content-addressed bundle, so changed code requires a new trust decision.

Wrench complements browser automation, direct API clients, MCP, and agent
frameworks. Those tools own interfaces, transports, models, and planning. Wrench
owns the narrow capability boundary that can sit beneath them.

## Install

Pin the public repository to the immutable `v0.10.1` tag:

```sh
bun add --global github:hraness/wrench#v0.10.1
wrench adapter sync-bundled --json
wrench doctor
```

Wrench requires Bun 1.3.14. It runs on macOS and Linux. `wrench doctor`
reports capture, media, authentication, provider, plugin, and durable-recovery
readiness. Provider-specific commands remain unavailable until their exact
local dependency and auth contracts are ready.

`wrench adapter sync-bundled` atomically installs the reviewed data manifests
shipped by that exact package version. It upgrades only an exact current or
archived bundled baseline and preserves any independently modified install.

The public manifest projects each closure-attested package as an exact runtime
dependency. Standalone validation installs without the repository lock, then
verifies the resolved closure versions and reviewed entrypoint hashes.

## SDK and code mode

Install Wrench in an agent or application that owns its own model, planning,
tool loop, approvals, and interface:

```sh
bun add github:hraness/wrench#v0.10.1
```

```ts
import {
  isProviderPluginId,
  isProviderPluginOperationName,
  type ProviderPluginDefinitionV1,
} from "@hraness/wrench"

if (!isProviderPluginId(candidate.id)) {
  throw new Error("invalid plugin ID")
}

const plugin = candidate satisfies ProviderPluginDefinitionV1
void plugin
```

The package root exposes programmatic plugin types and bounded validators.
`@hraness/wrench/client` exposes persistent-read client helpers, while
`@hraness/wrench/omni` exposes normalized cross-provider reads. Importing any
SDK entrypoint does not start the CLI. Importing the package root also does not
inspect local state or load provider runtimes.

## Capture and inspect

```sh
wrench URL                         # capture into a Markdown knowledge base
wrench read URL                    # inspect without persistence
wrench archive URL                 # create a verified media archive
wrench audio URL
wrench video URL
wrench transcript URL
wrench verify path/to/archive-item
wrench context path/to/code        # resolve nearby agent context
wrench search "query"              # search the local knowledge base
wrench url-metadata backfill --root kb
wrench doctor --json
```

### Local browser admission

Wrench permits at most two locally owned browser acquisitions at once across
all Wrench processes that share the same state home. This first gate covers
fresh and profile-backed page capture. Explicit `--cdp` and `--browser-live`
attachments do not launch a Wrench-owned browser and therefore do not consume
a slot.

Admission is automatic. Polling uses bounded jitter and a budget equal to the
lesser of the remaining capture timeout and 30 seconds. Queueing consumes the
capture timeout. An in-flight bounded state-safety operation may settle after
that polling budget expires, but Wrench rechecks the deadline and rolls back a
late claim, so no browser launches after it. Each claim binds a random token to
the owner's exact process-start identity. Wrench automatically reclaims a claim
only after it verifies that the claim came from an earlier operating-system
boot. A same-boot claim remains occupied even when its Wrench owner is dead
because an owned agent-browser daemon or Chromium process may have survived.
Malformed and unverifiable claims also remain occupied, so ambiguous state can
reduce capacity but cannot raise it above two.

Initialize a brand-new state home once before starting several Wrench processes:

```sh
wrench runs list --json
```

If a crash leaves capacity blocked, run `wrench doctor --json` and read
`wrench.home` from the report. The admission files are under
`<wrench.home>/captures/browser-admissions`. Rebooting is the safest recovery;
the next capture can verify the prior-boot claim and retire it. Manual recovery
on the same boot requires first finding and terminating the exact orphaned
agent-browser and Chromium process group, then removing only its corresponding
`slot-N.json`. Never remove a claim merely because its Wrench PID is gone.

The slot remains held through upstream browser, proxy, process, and isolation
cleanup settlement. Managed provider/bootstrap and derivation browser sessions
remain outside this first gate and keep their existing containment and cleanup
boundaries.

`wrench url-metadata` delegates to the shared `@hraness/kb` URL-intelligence
boundary. Backfill searches for bounded metadata through its pinned Rust search
helper, records resumable `url-metadata.json` sidecars beside saved URLs, and
performs read-only Archive.today discovery, including archive.is URLs, by
default. Pass `--no-archive` to disable archive discovery or `--refresh` to
replace an existing sidecar after a fresh bounded lookup. Run
`wrench url-metadata --help` for the complete limits and helper-path options.

Wrench archives one accessible, finite, non-DRM media item at a time. It
rejects playlists, live streams, affirmative DRM, and unsupported
authentication instead of weakening the archive boundary. Use it only for
material you are authorized to access. Wrench does not bypass authentication,
payment, access controls, or DRM.

Each completed media item retains the acquired encoded media,
privacy-projected provider metadata, requested derivatives and transcripts, a
versioned manifest, and SHA-256 integrity records. Inspect the directory
directly and run `wrench verify` to recompute every recorded artifact hash.

## Inspect provider support

```sh
wrench capabilities --json
wrench capabilities x-web --json
wrench plugin list --json
wrench plugin show x-web --json
wrench platforms --json
wrench plugin doctor --json
```

`capabilities` reports the installed semantic operations and their current
contract state. A `capture-required` operation is an inert reservation, not a
partially supported request. Source plugins are trusted in-process code.
Portable plugins run as explicitly trusted child-process code; process
separation contains ordinary failures but is not a hostile-code sandbox.

## Persistent reads

Successful R1 invocations with a verified account subject publish an encrypted
snapshot of the exact validated query and bounded provider output. The same
query can be returned later without opening a browser or provider connection:

```sh
wrench auth bind reddit-main --site reddit-web
wrench reddit-web messaging.list --auth reddit-main --input '{"folder":"inbox","limit":25}' --json
wrench reddit-web messaging.list --auth reddit-main --input '{"folder":"inbox","limit":25}' --cache-only --json
```

Normal invocation is the explicit revalidation step. Cache publication has a
separate outcome from the live read, so a failed refresh or local publication
never erases the last good snapshot. Inputs, account subjects, cursors, private
IDs, and provider output remain inside authenticated local ciphertext.
Replacing or removing an auth locator rotates its local lifetime identity, so
old projection and provider-session ciphertext cannot revive after recreation.

UI clients can render the current snapshot before awaiting revalidation:

```ts
import { staleWhileRevalidateCapability } from "@hraness/wrench/client"

const messages = staleWhileRevalidateCapability({
  adapterId: "reddit-web",
  operationId: "messaging.list",
  authId: "reddit-main",
  input: { folder: "inbox", limit: 25 },
}, { freshForMs: 30_000 })

if (messages.cached?.status === "hit") {
  render(messages.cached.output, messages.cached.freshness)
}
const refreshed = await messages.revalidation
if (refreshed.current?.source === "cache") {
  render(refreshed.current.output, refreshed.current.freshness)
} else if (refreshed.current?.source === "live") {
  render(refreshed.current.output)
}
```

`current` applies Wrench's ordering policy. It prefers the verified
`cachedAfter` snapshot after a failed refresh, a superseded publication, or a
cache error with a concurrently advanced run, revision, or validation time. It
uses live output only when that output is still current, and is `null` when a
failed refresh has no last-good snapshot. `cachedBefore`, `cachedAfter`, `live`,
and `cache` remain available for diagnostics and richer UI states.

Exact snapshots preserve provider page and completeness semantics without
reinterpretation. Revalidation reruns the selected R1 operation; it does not
imply a separate provider sync. In particular, WhatsApp reads revalidate its
local linked-device projection, while `wrench auth sync <id> --once` remains
explicit.

### Contact providers

`contacts.list` uses one shared directional-statistics shape. A count is either
complete, an explicit lower bound, or `null` when the provider cannot supply
it. Timestamps carry the same completeness and basis evidence. Providers do
not turn missing message history into zero activity.

| Provider | Contact collection | Directional statistics |
| --- | --- | --- |
| Gmail | Google People connections | Bounded Gmail message scans with explicit truncation |
| LinkedIn official API | First-degree connections with locale-selection evidence | Unavailable; the Connections API does not expose ordinary inbox history |
| Instagram authenticated web | Unique non-viewer participants from the reviewed first Direct inbox summary page, with explicit first-page and pagination incompleteness | Unavailable until acknowledgement-free message-history paging is reviewed |
| WhatsApp linked device | One page of the authenticated account owner's private, quiescent Whatsmeow contact store | Unavailable; Wrench does not treat a linked-device message cache as account-owned history |
| Facebook authenticated web | Capture-required reservation for friends or Messenger participants | Capture-required |
| Telegram | Not installed | Requires a reviewed TDLib user-session lifecycle; Wrench does not substitute the Bot API or claim contact access |

LinkedIn requires approved access to both the restricted
`r_1st_connections` and `r_liteprofile` scopes. Before listing connections,
Wrench reads `/v2/me`, derives the exact authenticated person URN, and compares
it byte-for-byte with the OAuth locator. Its consumer-web contact operation
remains capture-required and never falls back from the official API:

```sh
wrench linkedin contacts.list --auth linkedin-main \
  --input '{"start":0,"count":25}' --json
```

Instagram returns only participants visible in one reviewed first inbox page.
Its output marks provider pagination signals and local thread or contact limits
as incomplete instead of presenting that page as a complete contact set.
WhatsApp reads contacts from the authenticated account owner's private,
quiescent Whatsmeow `session.db` without opening a new WhatsApp connection.
Message counts and last-message timestamps remain explicitly unavailable:

```sh
wrench instagram-web contacts.list --auth instagram-main \
  --input '{"thread_limit":25,"contact_limit":50}' --json
wrench whatsapp-web contacts.list --auth whatsapp-main \
  --input '{"limit":50}' --json
```

Telegram's official `getContacts` method belongs to
[TDLib's user-client API](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1get_contacts.html).
Wrench will not install or expose this surface until it can bind the TDLib
authorization lifecycle, account identity, local database, paging behavior,
and message-history completeness without weakening the linked-device boundary.

### Gmail

Gmail uses the official Gmail and People APIs. Download one Google OAuth
**Desktop app** client JSON, then let Wrench open the system browser:

```sh
wrench auth login gmail-main --client-file /absolute/path/client_secret.json
```

The user completes Google's consent page. Wrench uses PKCE and a loopback
callback, verifies the exact Gmail account, stores the refresh credential in
mode-restricted private Wrench state, and renews access tokens automatically.
The managed JSON contains the refresh token, current access token, and needed
Desktop client fields; it is not an OS keychain and is not encrypted at rest.
Keep Wrench state out of shared backups and protect the local disk account. It
never asks an agent to copy or print a token. If Google reports that the refresh
credential is time-limited, the command prints its expiry; publish the personal
consent app to production and repeat with `--force` to obtain durable renewal.
`gmail.readonly` is a Google restricted scope whose consent grants mailbox-read
access even though the relationship projection's code-owned contract fetches
metadata only and never message bodies.

After login, confirm the account with a bounded live read:

```sh
wrench gmail contacts.list --auth gmail-main \
  --input '{"collection":"contacts","limit":1,"include_stats":false}' --json
```

`wrench auth remove gmail-main --yes` removes Wrench's local managed credential.
Revoking the Google grant itself remains a separate account-owner action in
Google's third-party connections settings.

Manual mode-0600 schema-1 token documents remain supported for externally
managed or legacy OAuth. Their provider, subject, and sorted scopes must match
the Wrench auth locator exactly:

```json
{
  "schemaVersion": 1,
  "provider": "gmail",
  "subject": "person@example.com",
  "scopes": [
    "https://www.googleapis.com/auth/contacts.other.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/gmail.readonly"
  ],
  "accessToken": "replace-with-the-access-token",
  "expiresAt": "2099-01-01T00:00:00.000Z"
}
```

```sh
wrench auth add gmail-main --oauth-provider gmail \
  --token-file /absolute/private/gmail-token.json \
  --scopes https://www.googleapis.com/auth/contacts.other.readonly,https://www.googleapis.com/auth/contacts.readonly,https://www.googleapis.com/auth/gmail.readonly \
  --subject person@example.com

wrench gmail contacts.list --auth gmail-main \
  --input '{"collection":"contacts","limit":20,"stats_scan_limit":100}' --json
wrench gmail contacts.list --auth gmail-main \
  --input '{"collection":"contacts","include_dates":true,"include_stats":false,"limit":20}' --json
wrench gmail contacts.list --auth gmail-main \
  --input '{"collection":"other-contacts","limit":100,"include_stats":false}' --json
wrench gmail contacts.list --auth gmail-main \
  --input '{"collection":"interactions","before":"2026-08-14T12:00:00.000Z","limit":100}' --json
wrench gmail contacts.list --auth gmail-main \
  --input '{"collection":"interactions","after":"2026-08-14T12:00:00.000Z","before":"2026-08-15T12:00:00.000Z","limit":100}' --json
wrench gmail messaging.list --auth gmail-main \
  --input '{"view":"inbox","limit":25}' --json
wrench gmail messaging.list --auth gmail-main \
  --input '{"view":"search","query":"from:example.com has:attachment","limit":25}' --json
wrench gmail messaging.read --auth gmail-main \
  --input '{"thread_id":"thread-id-from-list"}' --json
```

`contacts.list` selects saved Google Contacts, interaction-created Other
contacts, or the mailbox-wide `interactions` projection. Paginate each
collection independently with its returned
`nextCursor`; the OAuth token must carry both People read scopes. Contact
statistics are optional so bulk enumeration can avoid per-contact Gmail
queries. For saved contacts, `include_dates:true` adds birthdays, contact
events, and the selected name's display, given, middle, family, prefix, and
suffix fields. Wrench selects the sole People primary name when present and
otherwise accepts only a single unmarked name. Other contacts and interaction
rows do not accept this option. When requested, contact statistics report sent and received counts plus the maximum internal
date across every bounded matched message. Count and date completeness flags
remain explicit when the scan bound truncates a query or a message lacks a
date. Contacts with mixed, unsupported, or absent addresses report `partial`,
`unsupported`, or `unavailable` address coverage and lower-bound, incomplete
statistics instead of exact zeroes for unscanned mailboxes. `limit * stats_scan_limit` cannot
exceed 2,000, which bounds the per-direction Gmail scan before its paired
metadata reads. Inbox and search rows include a provider-derived `threadUrl`
and the exact `messaging.read` input. Reading does not mark a message seen or
emit a protocol acknowledgement.

The `interactions` projection scans each matching Gmail message once in a
fixed half-open window. Omit `after` for the initial mailbox scan; later calls
can pass the prior `before` as an inclusive lower bound and fetch only newer
messages. A guarded one-second search overlap is filtered by exact internal
date before aggregation. The projection reads headers, labels, and internal
dates but never message bodies. Per canonical external address it emits sent/received
counts, first/last timestamps, 30/90/365-day counts, and direction-specific
completeness. Spam, trash, drafts, and chats are outside the projection;
the first page lists the account's configured Gmail send-as addresses so
callers can exclude every self alias from all pages. Missing internal dates
become explicit lower bounds. Opaque hashes and the
unchanged window let a caller reject repeated pages without exposing raw Gmail
message IDs.

Pass a returned Gmail `threadUrl` to `wrench read` or `wrench clip` with the
same auth locator. Gmail clips default to private Wrench state rather than the
Git-backed knowledge base. `--output <directory>` is the explicit plaintext
export boundary. Attachments are content-addressed and integrity-recorded;
the implicit capture default and explicit `--media all` include every MIME
attachment, while `--media none` omits their bytes. `--media images` is rejected
because it would misrepresent non-image files in a Gmail thread. The private
bundle keeps one physical file per digest and a `gmail.json` occurrence map for
message, MIME part, provider attachment, declared filename and MIME type, and
snapshot provenance. Its schema-2 provenance preserves normalized reviewed headers
for each message: Subject, In-Reply-To, From, To, Cc, Bcc, Date, and Message-ID. Every
physical attachment object uses the deterministic `<sha256>.bin` name and
`application/octet-stream` manifest type, so conflicting or active declared
types cannot create a second object or activate stored content.
Text body leaves that Gmail externalizes through its attachment endpoint are
resolved within the same body budget before a read or clip reports completion.
Official `messaging.read` results cap full-thread decoded text at 7 MiB. Gmail's
Omni projection keeps an exact UTF-8-safe 256 KiB prefix per message and sets
`bodyTruncated` explicitly without adding a synthetic marker.
Full-thread JSON reserves at most 32 MiB for inline attachment payloads;
provider-hosted attachment endpoints remain independently bounded to 100 MiB
per file, so profile, thread, and attachment responses never share one broad
memory allowance.

### Native Article drafts

Wrench separates private draft saving from publication:

- `articles.draft.save` is R2. It creates or replaces one private native draft
  and has no publish-capable branch.
- `articles.publish` is R3. It is a different semantic operation with its own
  installed contract, preview, confirmation, and exact result binding.

A draft ID is not permission to publish, and a draft preview cannot be reused
for publication. The separate official API and signed-in web adapters remain
distinct transports and auth realms; Wrench never switches between them to
fill a capability gap.

The current provider state is explicit:

| Adapter | `articles.draft.save` | `articles.publish` |
| --- | --- | --- |
| `x` | Observed R2 response-bound private draft create through the documented OAuth API | Observed R3 response-bound publication through the documented OAuth API |
| `x-web` | Observed R2 structured private draft with ordered inline images and exact unpublished readback | Capture-required R3 |
| `linkedin-web` | Observed R2 paragraphs/headings/native-blockquote/native-link private draft with a separate banner cover, ordered inline images, alt text, captions, and exact unpublished readback | Capture-required R3 |

The `x-web` draft operation accepts a title, a canonical provider-neutral
`ArticleDraftDocument` schemaVersion 2 string, 1–20 ordered plan-bound JPEG,
PNG, or WebP files up to 5 MiB each, and an optional exact existing
private `draft_id`. The document supports paragraphs, headings, blockquotes,
list items, bold/italic/strikethrough ranges, and native canonical HTTPS link
ranges. Image blocks support captions; native image alt text, covers, embeds,
Markdown, and HTML remain unavailable. The separate official `x` OAuth operation exposes only its reviewed
plain-text `body` contract plus an optional cover. Inspect the exact installed
capability instead of translating inputs or switching transports implicitly.

Capture or read source material separately. The caller owns every editorial
choice involved in translating, abridging, retitling, attributing, and linking
it for the destination. Wrench sends only the final reviewed title and
document; it does not turn a source URL into provider copy. The exported
`projectXStatusArticleEmbed` helper provides one deterministic destination
projection for already-reviewed X status text: blockquote plus canonical X
link for both `x-web` and `linkedin-web`.

For `linkedin-web`, pass `cover_image` outside the canonical document when
creating a draft or intentionally replacing its banner. On an exact
`draft_id` replacement, omit `cover_image` to preserve the independently read
existing banner without another upload. Wrench binds a supplied cover only to
LinkedIn's Article banner slot. `inline_images` contains only images intended
at exact body positions.

For X, put the exact inner canonical JSON document and local image path in a
private input file:

```json
{
  "title": "Reviewed title",
  "document": "{\"blocks\":[{\"links\":[{\"length\":6,\"offset\":9,\"url\":\"https://example.com/source\"}],\"text\":\"Read the source\",\"type\":\"paragraph\"},{\"caption\":\"Puerto Rico\",\"imageIndex\":0,\"type\":\"image\"}],\"schemaVersion\":2}",
  "inline_images": ["/absolute/private/puerto-rico.png"]
}
```

Then use one account-bound signed-in realm:

```sh
wrench adapter sync-bundled --json
wrench auth add x-main --cookie-source arc
wrench auth bind x-main --site x
wrench capabilities x-web --json

wrench x-web articles.draft.save \
  --input @/absolute/private/article-draft-input.json \
  --auth x-main --preview --json

wrench confirm <preview-digest> --json
```

Review the exact account, title, canonical document, ordered attachment
hashes, optional draft ID, contract, and dispatch schedule. Require a successful result to identify
`articles.draft.save`, report `published: false` and `mode: "draft"`, and return
the private draft identity. Do not retry a partial or indeterminate save and do
not call `articles.publish` as recovery. The current image-capable contracts do
not reconcile automatically because an uncertain upload may have created a
provider asset absent from the confirmed input; preserve the run and do not
repeat uploads.

Signed-in LinkedIn now exposes the same private R2 seam through
`linkedin-web articles.draft.save`. Its schemaVersion 2 document supports
paragraphs, H1/H2 headings, native blockquotes, native HTTPS links, and ordered inline images with
required descriptive alt text and optional captions. It creates or replaces
only one bound private draft and independently verifies the exact unpublished
text/image/asset result from one bounded hidden server payload in the
authenticated editor HTML. Its fixed current single-upload registration, signed byte
transfer, writes, and server-response read run inside a contained, account-bound Chrome
session because LinkedIn rejects the same editor traffic when replayed by a
standalone HTTP client. Wrench does not type into or inspect the editor DOM,
and the contained headed browser may be visible while the private save runs.
Lists, styles, proprietary embeds, and publication remain unavailable.
See the packaged [native article draft workflow](skills/wrench/references/article-drafts.md)
for the shared document grammar and safety sequence.

## Normalized omni views

The omni layer materializes selected exact inbox snapshots into a strict shared
union of conversations, messages, and notifications. Each provider owns a pure,
versioned materializer with explicit identity, pagination, completeness,
tombstone, and deletion semantics. Unsupported providers say why. A shape
change fails at that provider-owned boundary, retains the last good normalized
entities, and records the exact failed revision instead of guessing.

Omni v1 has no provider-authored write-invalidation tags. Auth-incarnation,
materializer, and plugin implementation identity changes strand the prior
normalized coordinates. Freshness advances only when the exact query is
explicitly revalidated. If a newer exact snapshot drifts, Wrench keeps the last
good derivative and reports `retained-after-drift`. The provider-local
diagnostic remains inside encrypted normalized state. Public reasons are
categorical and do not echo foreign values or unreviewed property names.

```sh
wrench omni read --input '{
  "schemaVersion": 1,
  "sources": [
    {"adapterId":"reddit-web","operationId":"messaging.list","authId":"reddit-main","input":{"folder":"inbox","limit":25}},
    {"adapterId":"whatsapp-web","operationId":"messaging.list","authId":"whatsapp-main","input":{"folder":"all","limit":100}}
  ],
  "filter": {"kinds":["conversation","message","notification"]},
  "page": {"limit":100}
}' --cache-only --json
```

`--cache-only` reads encrypted normalized state without a browser or provider
round trip. `--from-exact-cache` rebuilds derivatives from encrypted exact
snapshots. The default mode revalidates supported sources independently and
then returns one locally paged view. Provider cursors remain private; public
view cursors are authenticated and bound to the request, account lifetimes,
materializer closure, and view revision.

Each source row exposes a keyed `normalizationDataRevision` for causal cache
comparison without revealing normalized bytes. During SWR, `current` may be an
`omni-merged` result: it adopts a proven newer cached view while retaining every
unresolved live source status. A concurrent advance for one provider, account,
or continuation therefore cannot erase another live failure; the independent
`live` and `cachedAfter` observations remain available as well.

```ts
import { staleWhileRevalidateOmniView } from "@hraness/wrench/omni"

const messages = staleWhileRevalidateOmniView({
  schemaVersion: 1,
  sources: [{
    adapterId: "reddit-web",
    operationId: "messaging.list",
    authId: "reddit-main",
    input: { folder: "inbox", limit: 25 },
  }],
})

render(messages.cached?.view)
render((await messages.revalidation).current.view)
```

## Create a portable plugin

An agent can create a private, network-inert starting point without editing
Wrench:

```sh
wrench plugin init example-web \
  --display-name "Example" \
  --surface example \
  --origin https://www.example.com \
  --operation feeds.read \
  --output /absolute/private/example-web

wrench plugin check /absolute/private/example-web --json
wrench plugin test /absolute/private/example-web --trust-code --json
wrench plugin pack /absolute/private/example-web \
  --output /absolute/private/example-web.wrenchplugin --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --json
```

`init` writes a strict `wrench-plugin.json`, a self-contained runtime, inert
operation metadata, secret-free fixtures, and package-local agent guidance.
`check` is static and does not execute plugin code. `test --trust-code` binds
the decision to the verified plugin identity before running its declared
secret-free fixtures. `pack` creates a reproducible content-addressed package.
`install --trust-code` is the separate decision to let that exact package run.

Portable code receives only declared, bounded host capabilities. Network
requests are pinned to declared HTTPS origins; credentials are opaque handles
usable only at declared sinks; files and state are namespaced handles; and
mutations must use the kernel's begin, request, and verify sequence. The host
does not expose a shell, package manager, ambient environment, unrestricted
filesystem, redirect, retry, or arbitrary request primitive.

Read [the plugin guide](docs/plugins.md) before replacing an inert reservation
with an observed contract. The packaged [Wrench Agent Skill](https://github.com/hraness/wrench/blob/v0.10.1/skills/wrench/SKILL.md)
gives coding agents the same workflow and safety boundary. The packaged
[cross-post skill](skills/cross-post-with-wrench/SKILL.md) orchestrates exact,
previewed posts across X, LinkedIn, Bluesky, Substack Notes, and Threads while
preserving per-provider attachment limits and at-most-once dispatch evidence.

## Risk and confirmation

- R1 is a reviewed read with no intended remote mutation.
- R2 is one bounded, normally reversible change.
- R3 is an externally visible or consequential change, including an exact
  authored-item deletion only where a provider-specific contract binds the
  target, current account, revision, mutation, and independent absence readback.
- R4 is blocked.

R2 and R3 commands create an exact, short-lived preview. Review its adapter,
transport, account realm, input, attachment hashes, side effect, contract hash,
and complete dispatch schedule, then pass its digest to `wrench confirm`.
After a partial or indeterminate dispatch, Wrench does not retry or switch
transport. The run remains unsettled until exact external evidence supports a
separate reconciliation.

An operator who explicitly accepts the risk of a duplicate may create one new
intent from one terminal indeterminate `posts.publish` run:

```sh
wrench invoke <adapter> posts.publish --input @post.json --auth <id> \
  --preview --duplicate-risk-of <source-run-id>
wrench confirm <new-plan-digest>
```

This v1 path is limited to one started dispatch over the same reviewed R3 web
session contract. Wrench revalidates the exact adapter, account realm,
operation, normalized input (including attachment hashes), contract, source
receipt, journal, ledger, and recovery capsule at preview and confirmation.
The source run remains indeterminate and its evidence is never cleared or
rewritten. Re-previewing the unchanged source produces the same successor
intent; that successor has its own permanent at-most-once ledger. If the
process exits after electing the successor but before starting its dispatch,
the election remains fail-closed and must be inspected rather than retried.

New previews use one environment-neutral durable contract identity. Readers
also accept the exact predecessor identities produced by the standard `test`,
`production`, and `development` modes. They do not accept a wildcard identity
for custom `NODE_ENV` values. Wrench retains unsupported unsettled evidence and
directs the operator to `wrench doctor`, the exact predecessor build, or manual
evidence review. Runtime loading still verifies the current exact source,
dependency, and execution closure separately.

## Develop

```sh
git clone https://github.com/hraness/wrench.git
cd wrench
bun install --frozen-lockfile
bun run check
```

The full gate type-checks, tests, builds, runs the secret-free CLI and portable
plugin lifecycle smoke, then installs and imports the packed package in a clean
consumer. See [CONTRIBUTING.md](CONTRIBUTING.md) for change boundaries and
[local development](docs/local-development.md) for isolated parallel worktrees.

## License

MIT
