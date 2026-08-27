# Wrench

[![Wrench: precise web capabilities for AI agents](https://wrench.rip/og.png)](https://wrench.rip)

[![skills.sh](https://skills.sh/b/hraness/wrench)](https://skills.sh/hraness/wrench)

**Give agents bounded access to pages, media, and connected accounts.**

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

[Project site](https://wrench.rip) · [Privacy and data custody](https://wrench.rip/privacy/) · [Security policy](SECURITY.md) · [Plugin guide](docs/plugins.md) · [Local CLI transport guide](docs/local-cli-providers.md)

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

## Built-in provider catalog

Wrench v0.15.0 ships attested adapter surfaces for Beeper, Bluesky, Facebook,
Facebook Groups, Facebook Marketplace, Facebook Pages, GitHub, Gmail, Hacker
News, Instagram, LinkedIn, Reddit, Substack, Threads, TikTok, Twitch, WhatsApp,
X, and YouTube. Eighteen of those surfaces have at least one `observed`
operation; Facebook Pages is currently reservation-only, with zero executable
operations. LinkedIn and X each have separate official and authenticated-web
adapters. The [release-bound provider directory](https://wrench.rip/provider-capabilities/)
puts each `observed` and `capture-required` count beside the provider instead of
treating a catalog entry as a generic support badge.

Beeper is Wrench's first pinned local-CLI provider. Its 32 observed operations
read accounts, contacts, conversations, and messages; manage reactions, drafts,
reminders, and conversation state; and preview and confirm sends, edits, group
changes, and presence. Wrench accepts only the reviewed official Beeper CLI
0.6.2 executable and one bound Desktop target. It does not expose a generic
command runner, and submission is not a claim of network delivery.

```sh
wrench beeper-local messaging.list --auth beeper-main \
  --input '{"limit":100}' --json
wrench beeper-local messaging.send --auth beeper-main --preview --json \
  --input '{"account_id":"<account-id>","conversation_id":"<chat-id>","kind":"text","text":"Hello from Wrench"}'
```

Read the focused [Beeper guide](https://wrench.rip/providers/beeper/) for setup,
version identities, action boundaries, export workflows, and exclusions.

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

The CLI and SDK use the immutable GitHub release tag shown below. Wrench is not
currently published on npm, Homebrew, or another package repository, so those
registries are not supported install paths. The Agent Skill remains available
through skills.sh.

Install the single Wrench Agent Skill with either runner:

```sh
npx skills add hraness/wrench
# or
bunx skills add hraness/wrench
```

The skill teaches Codex, Claude Code, Cursor, and other compatible coding
agents when to use Wrench, how to preserve its trust boundaries, and how to
install the CLI if it is missing. Start a new agent session after installation.

Install the current immutable CLI release from the `v0.15.0` tag:

```sh
bun add --global github:hraness/wrench#v0.15.0
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
bun add github:hraness/wrench#v0.15.0
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
`@hraness/wrench/client` exposes persistent-read and strict live-invocation
helpers, `@hraness/wrench/beeper` exposes the body-free Beeper contact
interaction export, and `@hraness/wrench/omni` exposes normalized
cross-provider reads. Importing any SDK entrypoint does not start the CLI.
Importing the package root also does not inspect local state or load provider
runtimes.

Consumers that need one strictly parsed live receipt and output without the
cache orchestration can use the generic client directly:

```ts
import { invokeCapabilitySync } from "@hraness/wrench/client"

const { receipt, output } = invokeCapabilitySync({
  adapterId: "beeper-local",
  operationId: "contacts.list",
  authId: "beeper-main",
  input: { limit: 100 },
})
```

The asynchronous `invokeCapability` form accepts an abort signal. Both forms
run Wrench's execution and projection identity fences before and after the
read, then return the validated CLI receipt instead of asking a consumer to
parse the raw process envelope.

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
wrench auth bind reddit-main --site reddit
wrench reddit-web messaging.list --auth reddit-main --input '{"folder":"inbox","limit":25}' --json
wrench reddit-web messaging.list --auth reddit-main --input '{"folder":"inbox","limit":25}' --cache-only --json
```

Observed `profiles.read` capabilities expose target-bound exact counters for X,
Bluesky, GitHub, LinkedIn, Instagram, Threads, Substack, YouTube, Twitch,
Reddit, and TikTok;
Substack also exposes owned-publication subscriber totals through
`organizations.read`. Each counter is either an exact nonnegative integer or a
categorical unavailable value. Wrench never promotes a rounded profile label
to an exact metric. The Agent Skill includes the bounded daily collection and
consumer-handoff workflow.

Normal invocation is the explicit revalidation step. Cache publication has a
separate outcome from the live read, so a failed refresh or local publication
never erases the last good snapshot. Inputs, account subjects, cursors, private
IDs, and provider output remain inside authenticated local ciphertext.
Replacing or removing an auth locator rotates its local lifetime identity, so
old projection and provider-session ciphertext cannot revive after recreation.

For social video, inspect the exact installed schema before planning. Current
source observes MP4 publication through `x-web posts.publish`, the official
OAuth `x` and `linkedin` post contracts, `reddit-web media.publish@9`, and
Threads `meta-web media.publish@1`, plus `bluesky-web media.publish@2`.
Reddit's route requires one plan-bound MP4, one plan-bound PNG/JPEG poster, and
explicit post declarations. The Threads route binds MP4 dimensions, upload,
created identity, actor, text, and exact permalink video readback. The Bluesky
route binds the fixed video-service upload job and processed blob to the exact
repository record, durable target, and authoritative PDS plus public AppView
readbacks. LinkedIn web, Substack Notes, TikTok, Instagram, and YouTube expose bounded `media.publish` reservations,
but those routes remain network-inert while their provider-specific upload,
processing, and independent readback contracts are `capture-required`.
Substack's reservation now has live 200 evidence for initialization, multipart
transfer, transcode, status, and video-attachment creation, but remains inert:
the authorized profile-backed Note create returned 403 in two independent
attempts, so no exact published-video target or readback exists.
`substack-web content.delete@1` is observed for one exact current-account
personal Note. It pre-reads the exact actor and body, dispatches one bodyless
target-bound DELETE, retains the accepted target, and independently requires
the exact Note read to return 404.

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
| Beeper local Desktop | One coverage-limited account-aware result window from the already-authorized local Desktop projection; the CLI exposes no continuation and may cap results below the requested limit | Unavailable; Wrench does not scan message history while listing contacts |
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

### Beeper through an exact local CLI contract

The bundled `beeper-linked-device` source plugin operates an existing Beeper
Desktop authorization through the official Beeper CLI 0.6.2. This is Wrench's
first `local-cli` transport: the adapter selects semantic operations while its
source plugin owns exact executable identity, fixed command templates, strict
input and output projections, account and Desktop-target proof, process bounds,
and mutation recovery. It is not a generic Beeper command runner.

The adapter covers ordinary Beeper work through 32 operations. R1 reads include
accounts, bridges, contacts, conversations, message pages, exact messages,
message context, and bounded searches. R2 desired-state actions include
reactions, archive, pin, mute, priority, private drafts, reminders, and local
Desktop focus. R3 actions send text, files, stickers, or voice messages; edit
an exact message; start a conversation; change the network-visible read state;
send Notify Anyway; change group metadata; set disappearing timers; and emit
bounded presence.

`conversations.start` binds only the exact account and canonical user ID.
Set a group title afterward through the separately confirmed
`conversations.title.set` operation; Wrench does not hide that rename inside
conversation creation.

Install the official CLI and authorize it to the local Desktop app first:

```sh
brew install beeper/tap/cli
beeper setup
wrench adapter sync-bundled --json
wrench auth add beeper-main --linked-device beeper \
  --device-store "${HOME}/.beeper"
wrench auth bind beeper-main --site beeper
```

Upgrading from the earlier read-only Beeper adapter intentionally changes the
bound subject: it now includes the exact Desktop loopback target and verified
stable/nightly bundle ID as well as the self account. After reviewing the
active Desktop app, its exact advertised version, and the account, either
create a new auth ID or explicitly rebind the existing one with
`wrench auth bind beeper-main --site beeper --force`. Wrench does not silently
migrate the narrower realm. Ordinary Desktop auto-updates require the same
review and rebind, then produce a newly bound auth identity and new previews.

The integrity pin is the final official 0.6.2 executable, not the moving
Homebrew formula, npm launcher, release tag, or reported version. If the tap
has advanced, install the matching 0.6.2 release executable at
`<WRENCH_STATE_HOME>/tools/beeper/0.6.2/beeper` (the default state home is
`~/.local/share/wrench`). Wrench rejects every other executable byte sequence
before private work.

| Runtime | Archive SHA-256 | Executable SHA-256 |
| --- | --- | --- |
| macOS arm64 | `688ccde7e7d044d33980cd06474bf1ae7215ccf8ca79967262fa3bfb85a2589a` | `48aa895449129c793a212ea19f69a534adc34a8adc4037ca1d7da9e648716425` |
| macOS x64 | `4113a1979cfbd7839f14743158e70c12efa941313afb77ab2b11a08309196186` | `83bb89edb6eeb9c61ebdb6ec940e0db30c90ecbca61d60a7408fe336e255f22e` |
| Linux arm64 | `2bd37043a4ed863621edc59e28aaa652e8193e55abca0e9477f5aeae1c65d629` | `102b8725bd99b03905dcff9fff645f3742e1697ce8d43ab9d8656896aafd12a8` |
| Linux x64 | `a881e1d2bc91e31218b251716644ec5f8d161d5ccb30e7eab66cf2ba6410511d` | `723cc3a6c556fa21b6ba11db8377d6a29776aca1660da48f0072883d6452ae3d` |

The binding also records release commit
`a416af06023449a87312dc11e54643fd9dc94b8c` and release-manifest SHA-256
`5c52b533180151b97e26138ef687b6b819170687b34a478184e5648335356950`.
Review the [official 0.6.2 release](https://github.com/beeper/cli/releases/tag/v0%2E6%2E2)
and [CLI manual](https://github.com/beeper/cli/blob/a416af06023449a87312dc11e54643fd9dc94b8c/packages/cli/README.md)
for the upstream distribution. The semantic response contract is separately
reviewed against `@beeper/desktop-api` 5.0.0 at
[commit `b9c1714410139c2139b597338cd002d785653e85`](https://github.com/beeper/desktop-api-js/tree/b9c1714410139c2139b597338cd002d785653e85);
the executable digest does not by itself attest independently updated Desktop
API behavior.

The live Desktop `/v1/info` bundle ID and exact advertised version are also
part of the bound account realm. An in-place Desktop upgrade therefore
requires an explicit auth rebind and produces new previews instead of silently
running an older reviewed contract against a different Desktop build.

Binding hashes the stable local self-account coordinate before storing or
printing it. Every child receives operation-private CLI, oclif plugin, cache,
and temporary state. Ambient credentials, targets, defaults, proxies, update
checks, and user plugins cannot change a wrapped command. List and fuzzy search
results remain explicitly incomplete when CLI 0.6.2 exposes no continuation or
may apply an upstream cap. Use those reads to obtain exact account,
conversation, contact, and message IDs before an exact read or action:

```sh
wrench beeper-local messaging.list --auth beeper-main \
  --input '{"limit":100}' --json
wrench beeper-local contacts.search --auth beeper-main \
  --input '{"query":"Ada Fixture","limit":20}' --json
wrench beeper-local messaging.search --auth beeper-main \
  --input '{"query":"Ada Fixture","limit":20}' --json
wrench beeper-local messaging.read --auth beeper-main \
  --input '{"account_id":"<account-id>","conversation_id":"<chat-id>","limit":100}' --json
```

Send one text message through the normal R3 preview and confirmation boundary:

```sh
wrench beeper-local messaging.send --auth beeper-main --preview --json \
  --input '{"account_id":"<account-id>","conversation_id":"<chat-id>","kind":"text","text":"Hello from Wrench"}'
wrench confirm <preview-digest> --json
```

Wrench invokes sends without Beeper's `--wait`. It durably records the exact
accepted pending-message target when the CLI returns one, and it never retries
after the child may have reached Desktop. A timeout, signal, malformed response,
or lost response after dispatch remains indeterminate until a separately
reviewed exact read can reconcile it. File, sticker, voice, avatar, draft, and
focus attachments come only from digest-bound plan assets; callers cannot pass
an arbitrary child-process path. A file send, avatar update, or attached draft
is one opaque child dispatch: the CLI may upload an asset before performing the
final mutation, so an indeterminate result can leave an unreferenced provider
asset and must never be retried. Beeper 0.6.2 only accepts a nonempty draft when
the current draft is empty; replacing one is therefore two separately previewed
and confirmed intents—clear first, then set—not a hidden multi-dispatch fallback.

The checked Beeper coverage ledger accounts for all 101 canonical 0.6.2
commands. Account setup and removal, authentication and verification, target
and server lifecycle, configuration and update, plugin lifecycle, raw API/RPC,
watch/webhook, arbitrary exports, media download, and message deletion remain
unavailable or R4. Wrench does not turn administrative, destructive,
caller-selected network, or arbitrary-filesystem commands into agent authority.

Create a private, agent-ready Message Like Me bundle from every connected
account materialized by Beeper Desktop:

```sh
wrench beeper export-message-like-me --auth beeper-main \
  --output /absolute/path/to/new-message-like-me-bundle --json
```

For contact or rolodex enrichment, derive a smaller body-free relationship
view from the same admitted sequential history. Keep the artifact private:

```sh
umask 077
wrench beeper export-contact-interactions --auth beeper-main --json \
  > /absolute/private/path/beeper-contact-interactions.json
```

Progress remains visible on stderr. Stdout is a strict `{ receipt, output }`
envelope. `output` contains stable raw account and account-scoped contact
coordinates, sent and received counts, direct-conversation counts, first and
last interaction times, and explicit lower-bound completeness. It retains only
complete direct rosters and current direction-known message versions. Bodies,
attachments, reactions, media, group messages, credentials, names, titles,
handles, and local paths are excluded from both the output and receipt as
separately surfaced fields. Provider coordinates can themselves contain
identifying values such as an email address, phone number, or username. This
artifact is body-free, not anonymized, so do not put it in Git or a shared path.

Synchronous local applications can invoke the same installed command without
duplicating its process or receipt parser:

```ts
import { exportBeeperContactInteractionsSync } from "@hraness/wrench/beeper"

const { receipt, output } = exportBeeperContactInteractionsSync({
  authId: "beeper-main",
  limitChats: 10_000,
})
```

The receipt binds the auth identity hash, requested bounds, linked-device
transport, immutable Wrench release coordinate, verified official Beeper CLI
version, commit and binary digest, source and provider versions, transform,
completeness, counts, and exact summary digest. It is returned only after
operation-owned private shards have been cleaned up.

Current source also defines the fail-closed Message Like Me handoff seam. The
SDK derives a domain-separated coordinate digest only from an exact
`conversations.read` projection. The private context exposes that digest with
its contract ID and schema version, never the raw account or conversation
coordinate. The same digest is bound into the client intent and body-free
receipt. Native Messages coordinates remain unsupported by this Beeper
producer.

This source contract is not part of the immutable v0.15.0 release. Consumers
must not claim an installed Wrench producer until a later immutable release
contains it. No tag, package publication, provider action, or message send is
performed by adding the source contract.

The released schema-1 contact-interaction writer remains macOS arm64-only
because its receipt immutably names that platform and executable digest. It
fails before creating private export state elsewhere, while its parser remains
platform-neutral. Use the `beeper-local` semantic operations on any of the four
pinned macOS and Linux artifacts described above.

The command uses the pinned official CLI directly. It enumerates the connected
account realm, then runs the official `export --no-attachments` command once per
account in a deterministic order. Each invocation selects its account through
an operation-private CLI config, so account identifiers never appear in command
arguments, environment paths, or progress output. Stderr reports the account
ordinal and cumulative validated chat and message counts. Long account,
conversion, bundle-validation, and publication phases repeat their elapsed time
every 30 seconds, including final private-shard cleanup. It prints the private
recovery check before that work begins, so stale cleanup is visible too. A final
account enumeration rejects a realm that changed while the sequential snapshot
was running.

Wrench retains each validated raw account shard until the complete sanitized
bundle passes its graph and digest checks. It builds all six NDJSON artifacts
and `manifest.json` in a private sibling directory, fsyncs them, and exposes the
seven-file bundle with one atomic directory rename. The requested output path
stays absent until that commit. Success removes the raw shards; failure or
cancellation removes owned staging and leaves no partial output. The output
directory is mode 0700, and every file is mode 0600 with a canonical SHA-256
digest.

Each connected account has exactly one normalized self participant, anchored by
the account user's stable Beeper ID. Before emitting records, Wrench proves a
deterministic candidate chat prefix against the record, byte, and participant
work bounds, then derives only hashed identity evidence from that prefix. If
normalization changes the admitted prefix, Wrench discards the provisional
state and repeats with the shorter prefix. Explicit chat `isSelf` values and
message `isSender` values establish account-local self and peer evidence. Later
admitted evidence applies to earlier chats, a rejected suffix cannot affect the
retained facts, message files stay bound to their validated SHA-256 digests, and
contradictory retained evidence stops the export without publishing. Reactions
inherit a normalized participant reference while their raw provider tuple
remains only inside a composite hash. Nonunique provider reaction IDs are
preserved with the categorical `reaction-provider-id-non-unique` warning.

The JSON result reports the manifest path and digest, record counts,
completeness, and warnings. `--limit-chats` is global across the account
sequence. `--limit-messages` and `--max-participants` apply to each chat, which
matches the official CLI flags. Reached limits are recorded as truncation.
Wrench always passes hard ceilings of 100,000 chats and 1,000,000 messages per
chat, and it emits a coherent truncated bundle before the 500,000-record or 512
MiB bundle ceiling. Conversion also stops at a deterministic chat boundary
before 250,000 participant occurrences across account anchors, rosters, message
senders, reaction actors, and implied self insertions for direct chats. This
bounds normalization work even when many chats repeat the same participants.
One chat JSON file is limited to 64 MiB so foreign input cannot force a
multi-gigabyte allocation; an oversized chat is omitted with explicit truncated
completeness and a warning. While the official CLI is
running, Wrench monitors the complete private working tree against a 4 GiB
ceiling every 500 ms and independently checks that at least 2 GiB remains free
on the filesystem. This is a monitored safety ceiling, not an operating-system
quota. After each account validates, Wrench immediately removes the redundant
Markdown and HTML renderings while retaining the hash-bound JSON needed for the
final conversion. Cleanup first moves each owned directory into a private
quarantine and verifies its filesystem identity before recursive removal.

Before credentials or message bytes enter a raw working directory, Wrench
wins one atomic export-admission claim shared across all Beeper auth IDs. A
second invocation stops before account discovery while a live or
uninspectable owner holds that claim. A later invocation can reclaim it only
after proving that the exact owner is no longer running.

After admission, Wrench writes a durable private lease containing the directory
and process identities.
The atomic bundle stage receives the same protection. A later invocation
reclaims a stale directory only after proving that its exact owner, and any
recorded Beeper child, is no longer running. Live or indeterminate owners are
left untouched and the command stops with a categorical error. If a crash
lands between the atomic rename and lease release, recovery recognizes the
same directory at the requested output path and preserves the published
bundle.

The [Beeper Desktop API MCP project](https://github.com/beeper/desktop-api-mcp)
is intended to expose Beeper tools to an MCP client. This export path uses the
official CLI because Wrench needs a pinned, bounded, read-only file snapshot
that it can validate and publish atomically.

Contact and chat lists are bounded to 200 records because CLI 0.6.2 exposes no
continuation cursor for those commands. Message pages derive the next
before/after cursor only from the terminal returned message ID and reject
duplicates or a non-advancing cursor at normalization. Output marks remote
history coverage unknown, preserves account/network/reply/edit/delete and
reaction provenance, and includes attachment metadata without media IDs,
paths, URLs, or downloads. This is a local materialized view, not a claim that
every connected network has finished backfilling its remote history.

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
with an observed contract. The repository's [Wrench Agent Skill](skills/wrench/SKILL.md)
gives coding agents the same workflow and safety boundary. Its bundled
[social cross-posting guidance](skills/wrench/references/cross-posting.md)
orchestrates exact, previewed text, image, and video posts across supported
platforms while preserving per-provider attachment limits and at-most-once
dispatch evidence. Packages built from this source carry the same consolidated
skill as the skills CLI.

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
