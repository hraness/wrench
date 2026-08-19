# LinkedIn authenticated web API adapter

The current `linkedin-web` schema-v4 adapter has two observed operations:
`articles.draft.save@7` and `posts.publish@3`. The draft operation creates or replaces one private native Article
draft for the bound current member, supports paragraphs, H1/H2 headings, native blockquotes,
native HTTPS links, one distinct banner cover, and ordered inline images with
required alt text and optional captions, and independently verifies the exact unpublished result
from the authenticated editor-page server payload. The post operation publishes
one confirmed text post with an optional single plan-bound PNG, binds the exact
member and returned share, and verifies an independent exact-share readback.
Every other consumer-web capability remains `capture-required` and inert.

A browser may record a managed HAR, bootstrap the private session, or resolve
current session material. Runtime draft saving executes only Wrench's fixed
reviewed first-party API/write and editor-response readback contract inside a contained headed Chrome session;
LinkedIn rejects the same editor exchange from a standalone HTTP client after
its initial authenticated probe. It never types into or reads the Article
editor DOM. Callers cannot choose a URL, header, script, or selector. Wrench
never lists an inbox, opens a conversation, sends a message, or performs
another semantic action through LinkedIn's DOM.

First-party traffic is not the same as a documented public API. Use this local client only with the user's account authority, comply with applicable provider rules, and keep bulk outreach and engagement outside wrench.

## Contents

- [Install and inspect](#install-and-inspect)
- [Configure the signed-in realm](#configure-the-signed-in-realm)
- [Recapture inbox listing](#recapture-inbox-listing)
- [Native Article draft saving](#native-article-draft-saving)
- [Resolve current LinkedIn material](#resolve-current-linkedin-material)
- [Preserve capture-required operations](#preserve-capture-required-operations)
- [Risk and confirmation](#risk-and-confirmation)
- [Recapture on drift](#recapture-on-drift)

## Install and inspect

Validate the reviewed manifest before installation:

```sh
wrench adapter validate src/assets/adapters/linkedin/wrench-web-adapter.json
wrench adapter install src/assets/adapters/linkedin/wrench-web-adapter.json
wrench capabilities linkedin-web --json
```

Treat capability state as authoritative. `observed` means the exact contract version is eligible to execute after its account and current-session preflight passes. `capture-required` means the operation is reserved but unavailable; it performs no request and has no browser fallback.

The separate `linkedin` adapter uses LinkedIn's documented OAuth API for approved post, comment, reply, repost, and reaction scopes. It does not supply the consumer Home feed or consumer inbox. Keep its OAuth token and preview separate from the `linkedin-web` cookie realm, and never switch transports silently.

## Configure the signed-in realm

Prefer target-filtered Arc or Chrome cookies:

```sh
wrench auth add linkedin-main --cookie-source arc --cookie-profile "Profile 2"
wrench auth bind linkedin-main --site linkedin
wrench auth list --json
```

Use a private profile snapshot only when current browser storage or first-party assets are required for bootstrap. Never attach the runtime operation to a live inbox tab and never copy LinkedIn session material into an OAuth token document.

Bind `linkedin-main` to one stable current member/person identity before private reads or mutations. If organization operations are later added, bind the selected organization actor separately and prove that the current member can act for it. Reject account ambiguity, login changes, request-actor mismatch, and response-actor mismatch before dispatch.

The retained candidate parser derives a mailbox only when the current-account
response directly names one bounded `miniProfile` reference and exactly one
included entity binds that reference to the same numeric member subject. It
does not scan other included profile entities as a fallback. Missing,
unbound, conflicting, or ambiguous direct bindings fail.

The client can strictly review a short-lived `__cf_bm` edge-cookie
rotation: it accepts only that name, validates origin, attributes, expiry, and
deletion semantics, and binds the encrypted cache to the auth-locator hash.
Removing the auth locator removes that cache. Only the observed Article draft
operation may cross the execution boundary; every capture-required operation
still refuses before this client is created.

Verification on July 23, 2026 produced a durable projection-drift failure and
every available LinkedIn realm returned `401` at current-account preflight.
Reauthentication alone does not re-promote the contract; a fresh low-stakes
capture must also prove the current identity, mailbox, query, response
projection, and completeness semantics.

## Recapture inbox listing

`messaging.list` is a capture-required reservation. Version 1.1.0 remains
archived as historical evidence of the formerly observed bundle; version
1.2.0 first demoted it, and the current 1.7.0 bundle remains capture-required
and cannot execute. The intended folder input still reserves:

- `focused` for the main inbox;
- `other` for the additional inbox;
- `requests` for pending message requests;
- `archive`;
- `spam`;
- `all` for conversations in the returned inbox page.

The prior candidate projected bounded conversation identity, participants,
latest-message preview, read metadata, and an opaque sync token. Those shapes
are retained for comparison, not claimed as current. A new capture must prove
folder classification, whether continuation is executable, when a page is
complete, and the exclusion of presence, delivery acknowledgements,
seen/read receipts, and notification-badge requests. An inbox preview must not
be described as full conversation history.

Inspect the reservations without executing them:

```sh
wrench capabilities linkedin-web --json
```

Captured evidence identifies article, feed, mailbox-count, secondary-inbox,
conversation-list, and message endpoint families. Every family remains
capture-required until its current variables, bounded target-bound projection,
completeness, and incidental effects are proved. Reading a conversation must
use only a reviewed message query and must not mark it read.

## Profiles, organization Pages, and connections

The adapter reserves four bounded semantic operations without claiming that
their internal requests are known:

- `profiles.read` selects one exact public profile identifier or provider
  profile URN;
- `organizations.read` selects one exact organization public identifier or
  organization URN and means viewing that LinkedIn Page, not acting as it;
- `relationships.recommendations.read` selects the `all` recommended-connections
  surface and one bounded page;
- `relationships.connect` sends one confirmed invitation to an exact profile
  URN, with an optional note of at most 300 characters.

All four are `capture-required`. The three reads are R1; the invitation is R3
with a 24-hour local-at-most-once window. Their presence in `wrench
capabilities` makes the CLI shape reviewable and stable while guaranteeing that
no request runs before a managed HAR proves the exact request, viewer scope,
target, response, paging, completeness, and duplicate-state behavior.

Do not treat `organizations.read` as organization-actor authority. A future
Page-authored post or comment must separately bind the current member, selected
organization actor, administered-role entitlement, request actor, and returned
actor. `comments.create` targets an exact post URN; LinkedIn does not have a
separate wrench operation for “commenting on a profile” or “commenting on a
Page.” A member- or organization-authored post remains the comment target.

## Native Article draft saving

`articles.draft.save` is an observed R2 operation for one private native
LinkedIn Article draft. Its input uses the canonical provider-neutral
`ArticleDraftDocument` described in [native article drafts](article-drafts.md),
with an optional exact existing `draft_id`. The current contract accepts
paragraph, `heading1`, `heading2`, and `blockquote` blocks, native HTTPS link ranges, and
one separate plan-bound JPEG, PNG, or WebP cover on create, or preserves the
independently read existing banner on an exact replacement when `cover_image`
is omitted, plus 1–20 ordered inline images up to 5 MiB each. Every inline image requires descriptive alt text and
may have a caption. The cover is outer input rendered only in the banner slot;
it is never a document body block. Styles, list items, proprietary embeds,
HTML, Markdown, and editor payloads are rejected. The caller owns editorial
translation, image placement, captions, and alt text.

When the source Article contains an X status, use
`projectXStatusArticleEmbed` with the `linkedin-web` target. The reviewed
LinkedIn contract emits the exact status text as native blockquotes followed
immediately by one canonical linked X URL.
Omit source-post chrome, metrics, and card screenshots by default.

On August 18, 2026, an authorized private draft create and editor reload
independently returned the same text block as provider type `QUOTE`; this
reviewed shape is the evidence for `blockquote` write and readback support.

Create first binds a private title shell and its exact current-author
unpublished readback, registers, transfers, binds, and verifies the cover,
then registers and transfers each inline image before saving and reading back
the complete document. Replacement reads the exact private draft, performs
the same distinct cover and inline-image steps, then performs one conservative
title/document replacement. Neither schedule contains a publication or
feed-share request.

The contained browser is an authenticated transport, not a browser-operation
fallback. Chrome supplies the bound device session, cookies, user agent, and
TLS context; code-owned evaluation sends only the fixed current-member,
create, distinct cover/inline image registrations, signed byte transfers,
exact editor-page readback, cover-autosave, title-autosave, and
content-autosave requests.
The headed window may be visible during the save. Cleanup is tracked as part
of the durable operation and an unverified close preserves private artifacts
for explicit recovery instead of silently deleting evidence.

Authorized August 15–16, 2026 captures proved the current first-party Article
route family, exact create and partial-update bodies, the returned Rest.li
draft identity, normalized current-member-to-Article-author binding, private
`DRAFT` lifecycle, null publication/share fields, exact title/content/link
projection, and persistence after reopening. The August 16 live recapture also
proved that exact draft reads now come from one bounded hidden JSON payload in
the authenticated editor HTML response rather than the retired Rest.li finder.
The August 16 inline-image capture additionally proved bounded still-image
registration, a signed transfer returning `201`, stable asset-URN projection,
ordered image blocks, required accessibility text, optional captions,
provider-restored CDN sources, and persistence after reopening. The editor
proceeded directly from transfer to Article autosave and made no processing
status poll, so Wrench follows that exact sequence and gates success on the
later private Article response and independent readback.

An August 18 recapture after registration drift proved the current
`PUBLISHING_INLINE_IMAGE` response uses LinkedIn's bounded single-upload
variant. Wrench accepts that exact known-field family and the prior vector
variant, but still rejects multipart mechanisms, unknown response fields,
unreviewed headers, and upload targets outside the fixed LinkedIn origin and
path. File selection in the editor's preview dialog was not upload completion:
the reviewed flow selected the staged image, advanced the dialog once, waited
for the signed transfer, and only then observed the Article autosave.

An August 19 capture proved that the Article banner is not a body image. The
editor registers it with `PUBLISHING_COVER_IMAGE`, transfers the bytes once,
and autosaves the returned asset through
`coverMediaV2Union.coverImage` with the exact reviewed CoverImage type and an
empty caption. Independent editor-response readback exposes matching legacy
and V2 cover projections bound to the same stable asset URN. The current draft
contract therefore requires one outer `cover_image` on create and plans a
supplied replacement cover as `articles.cover` before body images. When an
exact replacement omits it, Wrench preserves and verifies the current banner
asset without registering or transferring another cover. In either case, the
banner stays out of the document and `inline_images`.

An August 19 recovery exercise also proved why this distinction matters: a
cover dispatch can become indeterminate after LinkedIn has retained the banner
but before Wrench verifies that dispatch. Never retry that cover upload. After
separate inspection establishes that an exact replacement draft already has
the intended banner, a new confirmed replacement may omit `cover_image` and
preserve that independently read asset while repairing only its body. That is
a distinct intent, not reconciliation or retry of the uncertain upload.

The active image contract has no automated reconciliation path because an
uncertain upload may have created a provider asset absent from the confirmed
input. Preserve partial or indeterminate runs and do not retry or repeat
uploads. Exact read-only replacement reconciliation remains only for
already-durable historical text-only contract evidence.

The presence of a LinkedIn editor or saved UI state alone is not a contract.
Do not type into the editor as a runtime fallback. `articles.publish` remains a
separate capture-required R3 operation with its own publication evidence.

## Resolve current LinkedIn material

Derive the `csrf-token` header from exactly one bounded `JSESSIONID` cookie. Strip only the reviewed wrapper quotes and require the expected `ajax:` token form. Never log or return the cookie or derived token.

Resolve a registered query such as `voyagerFeedDashMainFeed` or `messengerMessages` from bounded current candidates by exact operation prefix. Require exactly one `<prefix>.<32-hex>` match. Zero matches mean drift; several matches mean ambiguity. Both fail before the API request.

Keep query IDs, CSRF material, cookies, variables, feature sets, and private identifiers out of manifests and receipts.

## Preserve capture-required operations

The current registry keeps these unavailable until their exact first-party exchanges are captured and reviewed:

- `feeds.read`, `profiles.read`, `organizations.read`, `relationships.recommendations.read`, `messaging.list`, `messaging.read`, `posts.read`, `comments.read`, and `articles.read` (`R1`);
- `messaging.send` (`R3`);
- `posts.repost` and `posts.quote` (`R3`);
- `comments.create` and `replies.create` (`R3`);
- `relationships.connect` (`R3`);
- `reactions.set` (`R2`);
- `articles.publish` (`R3`);

Do not guess a Voyager/GraphQL mutation from a bundle, replay a captured payload, or use the composer as a fallback. To graduate one operation:

1. capture one exact low-stakes fixture;
2. bind the current member/organization actor;
3. bind conversation/profile/organization/post/root/parent target IDs;
4. bind returned message/comment/post/article identity and successful state;
5. exclude unrelated background mutations;
6. test revision drift, account mismatch, response drift, and uncertainty;
7. bump the contract and adapter versions.

For `messaging.send`, use an already-read, user-approved, low-stakes conversation. Keep recruiting and employment threads out of fixtures. A successful pressure test requires the internal `createMessage` response contract and an independent R1 read of the exact returned message; a visibly cleared textbox is irrelevant. Text-only and each attachment family are separate fixtures: the current manifest accepts one reviewed image, GIF, MP4 video, PDF, presentation, or word-processing document, but that input schema remains inert until upload initialization, byte transfer, asset ownership, message association, and independent readback are all captured and response-bound.

`posts.publish@2` is the separate observed R3 post contract. It accepts exact
text and at most one plan-bound PNG with descriptive alt text, admits the
image transfer and post create once, and verifies the response-bound share
URN through an independent current-member readback. It does not authorize an
Article publication, repost, quote, comment, message, or additional media.

For `relationships.connect`, use a user-approved profile that is not already
connected or invitation-pending. Prove the preflight relationship state, exact
target profile URN, optional note, returned invitation identity/state, and
independent relationship readback. A disabled Connect button is not evidence.

## Risk and confirmation

R1 reads run only after they graduate and pass account binding.
`reactions.set` is R2 only as an exact desired-state create/delete pair. A
private `articles.draft.save` is R2 because its exact autosave and unpublished
readback contract has graduated. Messages, comments, replies, posts, reposts,
quotes, connection requests, and article publication are R3; only the exact
observed `posts.publish@2` post shape is executable among those R3 families.

Every R2/R3 operation must preview the exact account realm, actor, target, text/media hashes, side effect, contract hash, and dispatch schedule. Confirm once. Require local duplicate refusal. Treat an uncertain response after request start as `indeterminate`; never retry by clicking LinkedIn or by changing message whitespace.

## Recapture on drift

Fail before the semantic request when the registered query, path, allowed query fields, Rest.li shape, feature contract, CSRF source, response status/content type, projection, or target/account binding changes. Restore the affected operation to `capture-required`, record a new managed HAR, update owned code, and rerun deterministic plus authorized live tests. Never update the client directly from arbitrary live traffic.
