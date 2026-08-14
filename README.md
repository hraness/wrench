# Wrench

Wrench is a bring-your-own-agent CLI and TypeScript SDK. It gives coding agents
a standard interface for operating browser sessions through recorded private
APIs. It records the private APIs behind a browser workflow, turns them into
typed plugins, and exposes bounded semantic operations without returning raw
browser access.

Wrench does not bundle an agent runtime or application. Use the CLI from any
agent that can run commands, or import the SDK from agent code. The local-first
Bun package also provides durable web capture, encrypted read projections,
normalized cross-provider views, verified media archives, and bounded provider
plugins.

```sh
wrench https://example.com/article
wrench capabilities
wrench plugin list
```

Project site: [wrench.rip](https://wrench.rip)

## Install

Pin the public repository to the immutable `v0.7.0` tag:

```sh
bun add --global github:hraness/wrench#v0.7.0
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
bun add github:hraness/wrench#v0.7.0
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

Gmail uses the official Gmail and People APIs. Create a current-user-owned
mode-0600 token document whose provider, subject, and sorted scopes exactly
match its Wrench auth locator:

```json
{
  "schemaVersion": 1,
  "provider": "gmail",
  "subject": "person@example.com",
  "scopes": [
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
  --scopes https://www.googleapis.com/auth/contacts.readonly,https://www.googleapis.com/auth/gmail.readonly \
  --subject person@example.com

wrench gmail contacts.list --auth gmail-main \
  --input '{"limit":20,"stats_scan_limit":100}' --json
wrench gmail messaging.list --auth gmail-main \
  --input '{"view":"inbox","limit":25}' --json
wrench gmail messaging.list --auth gmail-main \
  --input '{"view":"search","query":"from:example.com has:attachment","limit":25}' --json
wrench gmail messaging.read --auth gmail-main \
  --input '{"thread_id":"thread-id-from-list"}' --json
```

Contact statistics report sent and received counts plus the maximum internal
date across every bounded matched message. Count and date completeness flags
remain explicit when the scan bound truncates a query or a message lacks a
date. Contacts with mixed, unsupported, or absent addresses report `partial`,
`unsupported`, or `unavailable` address coverage and lower-bound, incomplete
statistics instead of exact zeroes for unscanned mailboxes. `limit * stats_scan_limit` cannot
exceed 2,000, which bounds the per-direction Gmail scan before its paired
metadata reads. Inbox and search rows include a provider-derived `threadUrl`
and the exact `messaging.read` input. Reading does not mark a message seen or
emit a protocol acknowledgement.

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

### X Article drafts

X Article drafts use the documented OAuth API. Create a current-user-owned
mode-0600 token document whose stable numeric subject and sorted scopes exactly
match the Wrench auth locator:

```json
{
  "schemaVersion": 1,
  "provider": "x",
  "subject": "123456789",
  "scopes": ["tweet.read", "tweet.write", "users.read"],
  "accessToken": "replace-with-the-access-token",
  "expiresAt": "2099-01-01T00:00:00.000Z"
}
```

```sh
wrench adapter sync-bundled --json
wrench capabilities x --json

wrench auth add x-api --oauth-provider x \
  --token-file /absolute/private/x-token.json \
  --scopes tweet.read,tweet.write,users.read \
  --subject 123456789

wrench x articles.publish \
  --input '{"title":"Reviewed title","body":"Reviewed body","draft_only":true}' \
  --auth x-api --preview --json

wrench confirm <preview-digest> --json
```

The current Article contract treats `draft_only: true` as a literal safety
boundary: it creates the draft and returns without calling X's publish
endpoint. The operation remains R3 because omitting that flag preserves the
separate publish behavior. Confirm only an exact version-2 preview containing
the flag, then require `published: false` and `mode: "draft"` in the result.

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
with an observed contract. The packaged [Wrench Agent Skill](https://github.com/hraness/wrench/blob/v0.7.0/skills/wrench/SKILL.md)
gives coding agents the same workflow and safety boundary.

## Risk and confirmation

- R1 is a reviewed read with no intended remote mutation.
- R2 is one bounded, normally reversible change.
- R3 is an externally visible or consequential change.
- R4 is blocked.

R2 and R3 commands create an exact, short-lived preview. Review its adapter,
transport, account realm, input, attachment hashes, side effect, contract hash,
and complete dispatch schedule, then pass its digest to `wrench confirm`.
After a partial or indeterminate dispatch, Wrench does not retry or switch
transport. The run remains unsettled until exact external evidence supports a
separate reconciliation.

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
consumer. See [CONTRIBUTING.md](CONTRIBUTING.md) for change boundaries.

## License

MIT
