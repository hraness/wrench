---
name: wrench
description: >-
  Use Wrench to give a bring-your-own coding agent bounded, local-first web
  capabilities: capture or scrape public and signed-in web pages into Markdown;
  archive authorized audio, video, and transcripts with verification; query
  encrypted cached email, contacts, inbox, and messaging views; resolve a live
  conversation, read fresh context, preview ordered message bubbles, and
  execute an exactly authorized turn through one provider route; publish and
  reconcile text, image, and video posts through observed installed social
  capabilities; inspect or develop bounded provider contracts for X, LinkedIn,
  Bluesky, Substack Notes, Threads, TikTok, Instagram, and YouTube Shorts; save
  private native article drafts; operate reviewed Beeper messaging actions
  through an exact pinned native CLI; and build or run typed provider plugins
  from recorded browser-session APIs or versioned provider CLIs. Trigger for web capture,
  URL clipping, authenticated sites, social media posting or cross-posting,
  media download or archiving, transcription, email and messaging integrations,
  HAR-to-API workflows, browser-session API automation, semantic operations,
  and safe provider mutations when raw HTTP, DOM control, cookies, and
  credentials must stay outside the agent.
---

# Wrench

Wrench supplies bounded CLI and SDK capabilities, not an agent runtime or application. Use it from the caller's own agent loop.

## Install or verify Wrench

Start with `wrench --help`. If the command is unavailable, read
[installation and diagnostics](references/install.md) and install the pinned
CLI before continuing when the user's request includes installing or using
Wrench. Never guess a source-tree command or substitute general browser
automation.

## Choose the smallest path

- Capture a URL: `wrench <url>` or `wrench clip <url>`.
- Read without persistence: `wrench read <url>`.
- Archive media: `wrench archive <url>` or `wrench audio|video|transcript <url>`.
- Discover supported article embeds through the provider's bounded semantic media read, then archive each exact returned finite item separately. Do not treat a collection page as one media item or scrape its DOM to manufacture asset routes.
- Inspect support: `wrench plugin list`, `wrench plugin show <id>`, and `wrench capabilities [adapter]`.
- Search public Puerto Rico rentals: `wrench clasificados-web listings.search --input '{"location":"San Juan, PR","beds_min":2,"max_price":5500}' --json`. Keep `location` to the reviewed San Juan tokens. Neighborhood comes from street, ZIP, known address, or list-card coordinates, never from broker copy. Zillow-group and Puerto Rico MLS public search are not installed.
- Operate Beeper: inspect `wrench capabilities beeper-local --json`, then use
  only its typed read or action operation with the bound local Desktop realm.
- Export exact local Apple Photos contact evidence: follow
  [Apple Photos contact evidence](references/apple-photos.md). This source has
  no auth or network authority. Its cluster identifiers and counts are private
  biometric-derived metadata. It does not open or ask Photos to materialize
  referenced photo or video asset files, and the returned JSON excludes images,
  crops, and faceprint templates.
- Read or act on a live conversation: follow
  [agentic messaging](references/messaging.md). Keep one exact provider route,
  use private artifacts for prose and capability references, and never expose a
  provider CLI or API beside Wrench as a second action path.
- Diagnose state: `wrench operator doctor --json`.
- Invoke a supported semantic operation: `wrench invoke <adapter> <operation>` or its printed shorthand.
- Collect exact daily social-account statistics into a checked consumer snapshot: follow [social profile statistics](references/social-profile-stats.md).
- Export the signed-in X account's bookmarks as a bounded JSON page keyed by `post_id`: follow [X authenticated web API adapter](references/x-adapter.md#export-bookmarks).
- Read a previously validated exact query without a provider roundtrip: repeat the subject-bound R1 invocation with `--cache-only`; omit that flag to revalidate it explicitly.
- Read a normalized cross-provider inbox without a provider roundtrip: `wrench omni read --input <json|@file|-> --cache-only --json`; use `--from-exact-cache` to rebuild from exact ciphertext or omit the mode to revalidate supported sources.
- Save one private native article draft, including supported plan-bound covers, inline images, and destination-safe source-post references: inspect `articles.draft.save`, then follow [native article drafts](references/article-drafts.md). Keep a provider cover outside the body document; on an exact LinkedIn replacement, omit it only to preserve the independently read existing banner. Never substitute `articles.publish`.
- Cross-post one exact text and optional ordered-image package: inspect every installed target schema, then follow [social cross-posting](references/cross-posting.md).
- Cross-post one exact video package: require an observed video-capable operation for every selected target, then follow [video social cross-posting](references/cross-posting-video.md).
- When a cross-post package uses user-supplied copy, never mark it as AI-generated. Follow [X AI disclosure](references/x-ai-disclosure.md): leave official `x` `made_with_ai` unset or `false`, prefer a Wrench transport over the X composer, and treat a live sparkle Made with AI label as a failed publish. An explicitly authorized AI-media label outside that workflow remains a separate provider input choice.
- Add a provider without changing Wrench source: author a portable plugin.
- Derive a reviewed first-party contract from authorized HAR evidence: follow [the derivation guide](references/derivation.md).

Do not expose raw requests, endpoints, GraphQL, Rest.li, JavaScript, selectors, cookies, headers, storage, arbitrary paths, or unrestricted file transfer. A capability is a bounded semantic operation with an exact transport, origin, account binding, input schema, risk, side effect, and response projection.
For a native provider CLI, do not expose argv, a shell, ambient environment,
package-manager channels, target defaults, or plugin installation. Require an
exact source-plugin-owned executable identity and fixed operation templates.

Wrench admits at most two locally owned fresh or profile-backed page-capture
browsers across processes sharing its state home. Let capture wait for the
lesser of its remaining timeout and the 30-second admission polling budget;
queueing consumes that timeout. A bounded state helper may settle after the
polling budget, but the browser cannot launch after deadline revalidation. Do
not bypass the gate by spawning agent-browser directly. Explicit CDP and
browser-live attachment skip admission because Wrench does not own those
browser processes. Managed provider/bootstrap and derivation sessions remain
outside this first cap. Before parallel first use of a new state home, run
`wrench runs list --json` once serially. Malformed, unverifiable, and same-boot
dead-owner claims remain occupied until their exact resources are recovered.
Run `wrench doctor --json`; it acquires a durable recovery lease before any
effect and acts only when the exact private session, daemon start identity,
launch identity, CDP endpoint, and private-root generation still match. It
persists quiescence before journaled root removal so a crash can resume without
weakening those proofs. Never delete a claim, kill a browser tree, or edit
Wrench state to bypass this fence. If any proof is missing or changes, retain
the claim and inspect the reported category rather than treating a reboot as a
recovery procedure.

## Author a portable provider

Read [provider plugins](references/provider-plugins.md), [the adapter contract](references/adapter-contract.md), and [safety and state](references/safety-and-state.md). Then create an inert package:

```sh
wrench plugin init example-web \
  --display-name "Example" \
  --surface example \
  --origin https://www.example.com \
  --operation feeds.read \
  --output /absolute/private/example-web
```

`init` writes a strict `wrench-plugin.json`, one self-contained Bun runtime, secret-free fixtures, and package-local agent guidance. Its operation starts `capture-required` and network-inert. Keep it that way until authorized evidence proves:

1. the exact HTTPS origin and route;
2. the current-account probe and stable subject binding;
3. the bounded request and credential sinks;
4. accepted status, content type, response projection, and pagination;
5. actor, target, side effect, idempotency, and uncertainty behavior;
6. drift and negative cases without a DOM or transport fallback.

Verify the package in order:

```sh
wrench plugin check /absolute/private/example-web --json
wrench plugin test /absolute/private/example-web --trust-code --json
wrench plugin pack /absolute/private/example-web \
  --output /absolute/private/example-web.wrenchplugin --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --json
wrench capabilities example-web --json
```

`check` is static. `test --trust-code` and `install --trust-code` explicitly authorize execution of the exact verified bundle. Process separation contains ordinary failures but is not a hostile-code sandbox: plugin code still runs as the user's OS account. Never execute an unverified authoring directory or import portable code into the host.

For updates, bind the transition to the installed digest:

```sh
wrench plugin show example-web --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --expected-current <bundle-sha256> --json
```

Wrench refuses update, disable, or removal while a live invocation, preview, claim, journal, recovery capsule, or linked-device lifecycle owns the bundle. Inspect blockers with `wrench plugin doctor`, `wrench plans list`, and `wrench runs list`.

## Configure one stable auth realm

Store a locator, not copied secrets:

```sh
wrench auth add example-main --cookie-source arc --cookie-profile "Profile 1"
wrench auth bind example-main --site example
wrench auth list --json
```

Use OAuth only for a reviewed `provider-api` plugin. Use browser cookies or a private profile only for a reviewed `web-session-api` plugin. Use a linked-device store locator for the reviewed Beeper `local-cli` binding; that locator selects the already-authorized Desktop realm, not arbitrary process authority. Never silently switch transports. A profile snapshot requires the source browser to be closed and may require `--browser-executable` plus explicit `--trust-profile-egress` because a path-backed browser has no domain-containment boundary.

For Gmail/Google Contacts, prefer managed native OAuth:

```sh
wrench auth login gmail-main --client-file /absolute/path/to/google-desktop-client.json
```

Wrench opens the system browser, uses PKCE plus a loopback callback, verifies
the Gmail subject, stores the refresh credential and Desktop client fields in
a mode-restricted local JSON file, and renews access tokens. This is not an OS
keychain or encrypted-at-rest store. The user—not browser automation—handles
Google sign-in, account choice, warnings, and consent. Tell them that
`gmail.readonly` is a Google restricted mailbox-read grant even though the
relationship contract fetches metadata only. Never ask the user to paste a
token. Confirm `accountSubject` with a one-row live `contacts.list` read before
syncing. Use `contacts.list` with collection
`contacts`, `other-contacts`, or `interactions`; the last requires one fixed
whole-second `before` cutoff, accepts the prior cutoff as an optional inclusive
`after` bound for incremental reads, and exposes message-count/timestamp
completeness plus first-page send-as aliases for self-address exclusion without
reading bodies.

Treat each auth ID as one stable provider account. Probe and bind the current account before private reads or writes; reject missing, ambiguous, changed, or mismatched identities. Keep tokens, cookies, HAR content, profile state, messages, and attachment paths out of output, logs, receipts, and Git.

## Invoke with the risk boundary intact

Inspect the capability first:

```sh
wrench capabilities example-web --json
wrench example-web feeds.read --input '{"limit":20}' --auth example-main --json
wrench example-web feeds.read --input '{"limit":20}' --auth example-main --cache-only --json
```

- `capture-required` performs no request.
- `R1` is a reviewed read with no intended remote mutation.
- `R2` is one bounded, normally reversible change.
- `R3` is externally visible or consequential.
- `R4` is blocked.

Successful subject-bound R1 reads publish an encrypted exact-query snapshot.
`--cache-only` returns that snapshot and its data revision, validation time,
age, and freshness without opening a browser or provider connection. A normal
R1 invocation is the explicit revalidation path. Do not rewrite cursors,
limits, folders, or targets to manufacture a cache hit, and do not assume that
revalidating a local linked-device projection performs a remote sync.

For an omni request, list each exact `messaging.list` or `messaging.read`
source with its adapter, auth ID, and input. Treat its shared Conversation,
Message, and Notification union as a derivative, never as replacement evidence
for the exact provider snapshot. Inspect every per-source normalization state.
`retained-after-drift` means the provider's newest exact bytes failed its
provider-owned materializer and the returned entities are deliberately the
last good derivative. Do not hide or coerce that status. Public reasons are
categorical; detailed drift diagnostics stay encrypted. During SWR, treat an
`omni-merged` current view as cached data paired with the unresolved live source
statuses that remain authoritative for display. Provider cursors stay private;
use only the authenticated local view cursor returned by Wrench.
Omni v1 has no write-tag invalidation surface. Auth-incarnation, materializer,
and plugin implementation identity changes strand prior derivatives. Exact
query freshness advances only through explicit R1 revalidation.

R2/R3 produce an exact five-minute preview. Review adapter, operation,
transport, account, scalar input, attachment hashes and order, side effect,
contract hash, and dispatch schedule, then run the printed `wrench confirm
<digest>`. A messaging turn uses its stricter private preview and same-turn
authorization procedure in [agentic messaging](references/messaging.md).
Never retry `pending`, `partial`, or `indeterminate` work. Reconcile from
independently observed, secret-free evidence only when the installed exact
contract advertises reconciliation; image-upload draft contracts deliberately
do not. Reconciliation never repeats the original mutation.

## Derive only when a contract is missing

Use a managed derivation to capture the minimum authorized first-party exchange. Seal and inspect the HAR through `wrench derive review`, finish into a private directory, and scaffold one inert operation with `wrench plugin scaffold`. Generic derivation output is evidence, not an executable client. Implement and promote only the exact reviewed contract; never fall back to DOM clicking. See [derivation](references/derivation.md) and [the code-owned scaffold](references/code-owned-provider-scaffold.md).

## Finish with evidence

- Freeze built-in provider source and tests before updating durable contract
  semantic identities. Follow [provider plugins](references/provider-plugins.md)
  to review the semantic digest once; Wrench derives and revalidates the exact
  source/dependency closure automatically and has no manual hash-approval step.
- Re-run `wrench plugin check` and secret-free fixtures.
- Prove exact origin, method, path, input bounds, response variants, identity binding, redirects, drift, and redaction.
- Exercise only authorized observed operations.
- Verify a `capture-required` operation performs no request.
- Inspect receipts and confirm credentials and payload text are absent.
- Remove managed HARs, profile snapshots, bootstrap state, and plan assets when their lifecycle is complete.
- Forward-test material skill changes with a fresh agent given only this skill and an installed `wrench` command.
