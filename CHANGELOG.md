# Changelog

Versioned sections identify checked package source. A version is publicly
released only after the matching canonical npm package and immutable GitHub
Release exist; the release-bound production site identifies the latest
coordinate that completed both checks.

## Unreleased

- Route Beeper account listing, chat search, exact-chat reads, message history,
  and filtered message search through fixed authenticated Desktop loopback
  `GET` routes. Preserve opaque older/newer cursors across bounded pages, reject
  replay or coordinate drift, and never call the separate mark-read route.
- Let Beeper message search paginate an exact account/chat/date-filtered local
  index without query text. Keep the prior v2.1.0 and v2.0.0 adapter manifests
  as exact upgrade baselines, and retain the local-materialization caveat rather
  than claiming complete remote provider history.
- Accept one `x-web` `posts.publish` body up to the reviewed CreateTweet
  25000-unit bound without truncation. Bind long-form text from `note_tweet`
  when CreateTweet returns a short `full_text` preview. Thread and reply item
  caps stay 280.
- Recover an orphaned same-boot browser session through a durable doctor lease
  bound to its exact daemon start identity, launch, CDP endpoint, and private
  root generations. Prepared, launch-intent, quiescent, and per-root removal
  phases make close, TERM, and deletion recovery crash-resumable. Changed or
  unprovable state remains fail-closed without making reboot part of the
  recovery contract.
- Return a bound `cleanup-required` result when durable realm admission blocks
  an R1 read before dispatch. JSON callers retain the no-retry category while
  the cleanup-unsafe claim remains fail-closed.
- Fail closed before every Vercel build unless a true local invocation has no
  Vercel signal or the checked-in release marker and exact platform state agree.
- Resolve the production release tag through a separately byte-bounded GitHub
  SHA response while retaining fixed local `git rev-parse HEAD` evidence,
  removing the remote Git descendant boundary from website admission.
- Move automatic main-only npm staging out of GitHub deployment review. npm
  still requires separate human inspection and two-factor approval before the
  staged version becomes public.

## 0.16.2 - 2026-08-28

- Require agentic messaging resolution to consume one opaque list-candidate
  route reference. Wrench reloads the checked provider target from encrypted
  private state and proves it with an exact read, so callers cannot inject or
  replace a provider account, network, conversation ID, or recipient match.
  The changed discovery, route, and resolve wire artifacts are V2; the shipped
  v0.16.1 V1 shapes remain available only for strict archival parsing.
- Start stage-only npm verification automatically when a greater stable package
  version reaches `main`. Unchanged manifest versions stop before OIDC, and the
  terminal staging job requires maintainer approval through the protected
  `npm-stage` environment before npm's separate two-factor approval.
- Add the Agent Skill to npm discovery metadata and link npm, GitHub, and
  skills.sh from the README and public software identity.
- Centralize the packed, unpacked, and file-count ceilings used by source
  artifact inspection and clean-consumer package smoke tests. The reviewed
  limits retain bounded room for the observed Linux and macOS gzip spread.

- Add a strict machine-readable Hraness social-profile collection manifest,
  correct the second X account to Life Days Left, and bind the current Twitch
  and GitHub organization metrics plus the expected Threads eligibility gap.
- Project stable, secret-free failure categories and retry dispositions for
  failed R1 reads across every provider in the Hraness manifest. Consumers can
  distinguish target, auth, account, provider, timeout, contract, and cleanup
  failures without exposing provider responses or inventing retry policy.

## 0.16.1 - 2026-08-27

- Add a provider-neutral agentic messaging facade that keeps exact routes,
  current context, prose, replies, and receipts in encrypted state and
  explicit owner-only artifacts. One private preview authorizes one ordered
  one-to-eight-bubble turn; the durable journal preserves submitted, failed,
  partial, and indeterminate outcomes without retrying uncertain work.
- Qualify Beeper Desktop for exact live agentic actions through its loopback
  API. Wrench binds one account and conversation, checks participants and the
  exact expected own-message prefix before every remaining bubble, and stops
  on foreign activity, edits, deletions, reorderings, or provider drift.
- Add a reviewed direct iMessage local transport with fixed JSON-RPC stdin,
  exact chat-row revalidation, AppleScript private files, disabled SMS
  fallback, and independent outgoing `chat.db` acceptance evidence. Threaded
  replies remain unsupported and every bubble has a separate no-retry fence.
- Vendor and verify a patched Wacli/Whatsmeow stdin-only private transport.
  The registered WhatsApp action remains unavailable until controlled live
  freshness, acceptance, and reconciliation qualification is complete.
- Ship the reviewed iMessage transport installer through the public CLI with
  digest verification, no-overwrite semantics, path-private diagnostics, and
  fail-closed handling for unsafe source and state paths.
- Add an exact lightweight `wrench --version` command and bind package smoke
  tests to the installed binary's immutable release identity.

## 0.16.0 - 2026-08-27

- Redesign wrench.rip as a restrained editorial site with a supported-actions-only
  provider directory, task-first capability labels, and no zero-action service
  cards in the public catalog.
- Add `x-web articles.read@2` for one exact current-viewer-owned private Article
  draft. The closed R1 result binds its ID, owner, Draft lifecycle, unpublished
  state, title, and bounded rich content; published X Articles and LinkedIn
  Article reads remain unsupported.
- Add `reddit-web media.read@2` for one exact Reddit-hosted video post through
  the current-account-bound `/api/info` exchange. The metadata-only R1 result
  returns post fields, dimensions, duration, safety flags, and completed status
  without playback URLs; standalone Threads post and media reads and Marketplace
  media reads remain unsupported.

## 0.15.1 - 2026-08-27

- Publish Wrench through the public npm registry with an exact Bun runtime
  floor, a bounded package inventory, and stage-only trusted publishing for
  later releases.
- Declare Wrench's authenticated browser and provider capabilities as dual-use
  content and ship the required disclosure in every package.
- Admit TAB, LF, and CR in projected X post bodies. Request headers, cursors,
  timestamps, every other C0 control, and DEL remain fail-closed.

## 0.15.0 - 2026-08-27

- Add a source-only `local-cli` provider transport with schema-v6 adapter
  selectors, exact per-platform executable identity, implementation-bound
  plans and receipts, strict subprocess lifecycles, and no generic argv or
  portable native-process authority.
- Expand the pinned Beeper Desktop integration from five reads to typed account,
  bridge, contact, conversation, message, send, edit, reaction, conversation
  state, metadata, reminder, draft, focus, and presence operations. Bind all
  four official 0.6.2 platform artifacts, isolate oclif user plugins and ambient
  targets, and account for all 101 upstream commands in a checked coverage
  ledger while leaving administrative, destructive, raw, and arbitrary-path
  commands unavailable or R4.
- Preserve the released schema-1 contact-interaction receipt on its exact
  macOS arm64 writer while keeping its 2,000-participant request ceiling;
  cross-platform Beeper operations use the new versioned local-CLI contracts.
- Add a manifest-derived provider directory to wrench.rip with exact observed
  and capture-required counts, grouped operation evidence, and local semantic
  icons that do not imply provider endorsement.
- Publish a focused Beeper guide that binds its 32 observed operations to the
  official CLI, adapter, semantic contracts, Desktop realm, executable hashes,
  preview and dispatch rules, export boundaries, and explicit exclusions.
## 0.14.0 - 2026-08-26

- Add a versioned, body-free Beeper direct-contact interaction summary over
  the same admitted sequential history as the Message Like Me v1 bundle. The
  summary preserves exact account-scoped provider coordinates, directional and
  conversation counts, first and last timestamps, provenance, completeness,
  and a canonical digest while excluding bodies, media, group messages,
  credentials, and local paths.
- Add `wrench beeper export-contact-interactions` plus the synchronous
  `@hraness/wrench/beeper` client for long-running local relationship imports.
  Its strict `{ receipt, output }` envelope binds the cleaned summary to the
  auth identity, requested bounds, linked-device transport, immutable Wrench
  release and verified official CLI pin, source versions, completeness, and
  counts.
- Pin Message Like Me v0.4.0 as the canonical bundle-v1 parser, type, limit,
  artifact-inventory, and current-manifest authority while preserving the
  checked legacy exporter bytes.
- Add async and synchronous `invokeCapability` clients that return Wrench's
  strictly parsed live receipt and output without requiring consumers to
  duplicate the CLI protocol parser.

## 0.13.6 - 2026-08-25

- Scrub JPEG and PNG provenance before X media upload, and fail closed when
  CreateTweet or independent TweetResultByRestId readback shows a Made with AI
  sparkle on user-supplied copy.
- Treat a mid-read optional admission rewrite after live I/O as an auth-changed
  discard so the live result cannot be published.
- Keep polling derivation-proxy readiness until the ready file is a complete
  0600 regular file, so an O_EXCL create cannot fail the start race.
- Add an authenticated, current-viewer-bound Twitch profile read that binds the
  fixed login-parameterized channel response to the viewer's immutable identity
  before returning its exact follower count.
- Promote the Hraness Twitch row from an expected categorical gap to the
  package-owned exact daily social-statistics workflow.

## 0.13.5 - 2026-08-24

- Add the Hraness Twitch channel to the package-owned social-statistics
  manifest with an exact-only categorical-gap contract until its reviewed
  capability and eligible authenticated source are available.

## 0.13.4 - 2026-08-24

- Add a credential-free, target-bound GitHub organization read that binds the
  organization and completes its bounded public repository pagination before
  projecting exact aggregate stars and followers.
- Preserve the existing GitHub profile read and document both public GitHub
  social-statistics routes for scheduled consumers.

## 0.13.3 - 2026-08-24

- Add a credential-free, target-bound GitHub profile read through the fixed
  public REST user endpoint, projecting exact follower, following, and public
  repository counts.
- Add GitHub to the package-owned Hraness social-profile-statistics workflow.

## 0.13.2 - 2026-08-23

- Publish exact Threads text through `posts.publish@5` without requiring a
  PNG, while preserving optional PNG publication and exact permalink readback.
- Restore exact LinkedIn personal and organization profile reads from a
  path-backed signed-in Chrome realm. Wrench clones the dormant profile into a
  private contained session, binds the current member before either target
  read, keeps personal profile and connection reads sequential, and finalizes
  the browser's private artifacts after every result.

## 0.13.1 - 2026-08-23

- Keep Beeper account selector aliases internal while returning plain,
  bounded-JSON-safe account projections from contact and messaging reads.

## 0.13.0 - 2026-08-22

- Add a pinned, read-only Beeper Desktop provider for contacts and messaging
  projections across locally connected accounts.
- Add `wrench beeper export-message-like-me` for private,
  provenance-preserving Message Like Me bundles with canonical digests,
  explicit completeness, graph validation, and no media downloads.
- Export Beeper accounts sequentially through the pinned official CLI with
  redacted account-level progress, elapsed-time heartbeats, and cumulative
  chat and message counts.
- Add durable process-aware recovery, global export admission, monitored raw
  working limits, and atomic validated Message Like Me bundle publication.
- Normalize account-local self aliases before record allocation, preserve
  distinct provider reaction facts, and reject contradictory identity or
  snapshot evidence without exposing private coordinates. Bound repeated
  participant work independently from output record cardinality.
