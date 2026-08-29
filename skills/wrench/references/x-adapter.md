# X authenticated web API adapter

The `x-web` schema-v4 adapter executes fixed, code-owned first-party `x.com` GraphQL/internal API exchanges with a signed-in cookie realm. A browser may record a managed HAR, bootstrap private session material, or resolve a reviewed current operation revision or transaction value. It never reads a feed, publishes, likes, bookmarks, or messages through X's DOM.

First-party traffic is not the same as a documented public API. Use this local client only with the user's account authority, comply with applicable provider rules, and keep bulk or unsolicited automation outside wrench.

## Contents

- [Install and inspect](#install-and-inspect)
- [Save an Article draft](#save-an-article-draft)
- [Read one private Article draft](#read-one-private-article-draft)
- [Configure and bind the signed-in realm](#configure-and-bind-the-signed-in-realm)
- [Use observed contracts](#use-observed-contracts)
- [Export bookmarks](#export-bookmarks)
- [Resolve current X material](#resolve-current-x-material)
- [Preserve capture-required mutations](#preserve-capture-required-mutations)
- [Other capture-required operations](#other-capture-required-operations)
- [Risk and confirmation](#risk-and-confirmation)
- [Recapture on drift](#recapture-on-drift)

## Install and inspect

```sh
wrench adapter validate src/assets/adapters/x/wrench-web-adapter.json
wrench adapter install src/assets/adapters/x/wrench-web-adapter.json
wrench capabilities x-web --json
```

`observed` means the exact code-owned contract version may execute. `capture-required` performs no request and never opens a browser-action fallback.

The separate `x` adapter uses X's documented OAuth API. It covers documented reverse-chronological/user/mentions/List/recent-search/bookmark reads and approved posting, reply, thread, repost, bookmark, Article, media, and legacy-DM surfaces; it never supplies For You. Encrypted X Chat remains a separate cryptographic contract. Keep these transports and auth realms distinct, and never switch among them after preview or because one lacks coverage.

## Save an Article draft

Use `x-web articles.draft.save` to create or replace one private native X
Article. This is an observed R2 contract with no publish-capable branch. It
accepts a reviewed title, a canonical provider-neutral `ArticleDraftDocument`,
and an optional exact existing private `draft_id`. Read [native article
drafts](article-drafts.md) before constructing the document.

The current contract uses `ArticleDraftDocument` schemaVersion 2. It supports
paragraphs, headings, lists, blockquotes, native HTTPS links, bold, italic, or
strikethrough ranges, and 1–20 ordered plan-bound JPEG, PNG, or WebP inline
images up to 5 MiB each. Image captions are supported. Native alt-text writing,
covers, proprietary embed cards, HTML, Markdown, and editor payloads remain
outside this contract. The caller owns every editorial and image-placement
choice.

For a source X status embedded in an Article, use
`projectXStatusArticleEmbed`. The default X projection is the exact status text
in a blockquote followed immediately by its canonical native X link. Omit
profile chrome, timestamps, engagement metrics, and card screenshots unless
the user explicitly requests them as Article content. This representation is
stable rich text plus a native link; it does not claim to create a proprietary
X embed card.

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

Review the bound numeric account, exact title, canonical document, ordered
attachment hashes, optional draft ID, contract version 2, and the image-upload
plus create or title/content replacement schedule. A successful result must identify `articles.draft.save`, report
`published: false` and `mode: "draft"`, and return the private draft ID and edit
URL. The runtime independently reads the result and binds its unpublished
state, owner, title, content, captions, image order, and uploaded media IDs.

The active image contract has no automatic reconciliation path because an
uncertain upload may have created a provider media ID that is absent from the
confirmed input. Preserve every partial or indeterminate run and do not retry,
search by title, guess an ID, or repeat uploads. Exact read-only replacement
reconciliation remains only for already-durable historical text-only runs.

`articles.publish` is a distinct capture-required R3 operation. Its mutation
and public readback are outside the observed private-draft contract. Never use
a saved draft ID, a draft preview, or the presence of an
`ArticleEntityPublish` descriptor as publication authority. Keep the separate
official `x` OAuth transport and its previews isolated from this signed-in
cookie realm.

The documented OAuth `x` adapter also exposes draft saving and publication as
two semantic operations. `x articles.draft.save` is an observed R2 private
draft create using its reviewed plain-text body and optional-cover schema;
it binds the returned draft ID and title but does not make a separate
unpublished read. `x articles.publish` is the separate R3 publish-only
operation and binds the publish response rather than claiming an independent
public readback. The retired
`draft_only` input is accepted by neither current contract. The retained
`articles.publish@2` route is available only for exact recovery of already
durable v2 evidence; it is not selected for a new preview. Inspect both current
capabilities and keep their OAuth plans separate from the `x-web` cookie realm.

## Read one private Article draft

Use `x-web articles.read@2` to read one exact current-viewer-owned private X
Article in the `Draft` lifecycle. Pass its 1–19 digit private ID through the
same bound X cookie realm used for other authenticated web operations:

```sh
wrench x-web articles.read \
  --input '{"article_id":"1234567890123456789"}' \
  --auth x-main --json
```

This is an R1 read with no mutation dispatch. Wrench resolves the current
viewer before the Article query, requires the result to echo the requested ID
and viewer-owner ID, and accepts only `lifecycle: "Draft"` with
`published: false`. The closed output includes the exact ID, owner ID, private
draft kind, lifecycle, one bounded single-line title, and bounded normalized
rich content.

The contract does not list drafts, read another account's draft, or read a
published Article. Those surfaces remain capture-required. Do not use an edit
URL, title search, or the separate official OAuth adapter as a fallback.

## Configure and bind the signed-in realm

Prefer a target-filtered browser cookie source:

```sh
wrench auth add x-main --cookie-source arc --cookie-profile "Profile 2"
wrench auth bind x-main --site x
wrench auth list --json
```

Use a private profile snapshot only when current local/session storage or first-party assets are needed to recover an approved authorization value or registered-operation revision.

Before private reads or mutations, resolve the current stable X user ID through a reviewed account request and compare it with the realm's expected binding. Bind created posts, replies, quotes, reposts, likes, bookmarks, and DMs to that account plus the exact requested target. Fail before dispatch on account ambiguity or mismatch.

## Use observed contracts

The current registry marks these code-owned reads observed:

- `feeds.read`: one bounded For You, Following, user, List, search, or bookmarks page; bookmarks pages also emit stable `items` keyed by `post_id`;
- `posts.read`: one exact post through the current TweetDetail query;
- `comments.read`: one bounded TweetDetail conversation/reply page;
- `articles.read@2`: one exact current-viewer-owned private Article Draft.

Authorized direct live evidence for this contract version covers For You,
bookmarks, one exact post and its bounded comments, plus one exact private
Article Draft. Following, user, List, and search remain declared modes of the
observed `feeds.read` contract; check `wrench capabilities x-web --json` for the
installed input schema and let current preflight fail closed on revision drift.

The observed web writes are `likes.set`, `content.save`, and
`articles.draft.save` (R2), plus `posts.publish` and `replies.create` (R3).
Like and bookmark evidence comes from prior reversible live fixtures, not the
current read-only probes. Preview the exact post ID and desired `liked` or
`saved` boolean, confirm the returned digest, and inspect the receipt. wrench
does not mark either desired-state mutation verified until an independent
TweetResultByRestId readback matches that boolean. Article draft saving uses
the separate exact unpublished Article readback described above.

Examples:

```sh
wrench x-web feeds.read \
  --input '{"feed":"for-you","limit":25}' \
  --auth x-main --json

wrench x-web feeds.read \
  --input '{"feed":"bookmarks","limit":25}' \
  --auth x-main --json

wrench x-web posts.read \
  --input '{"post_id":"POST_ID"}' \
  --auth x-main --json

wrench x-web comments.read \
  --input '{"post_id":"ROOT_POST_ID","limit":50}' \
  --auth x-main --json

wrench x-web articles.read \
  --input '{"article_id":"1234567890123456789"}' \
  --auth x-main --json
```

One page is not a completeness claim. Return a provider cursor only after projecting the complete provider page. If X returns more matching posts or replies than the requested projection limit, fail without exposing the end cursor instead of silently skipping unseen entries. User and List feeds additionally require the response to echo exactly the requested user/List identity. Keep inbox listing separate from conversation read so the R1 contract can exclude acknowledgement traffic.

DM folder/conversation reads remain `capture-required` because current X Chat
events are encrypted. They require the separate reviewed key-recovery,
plaintext projection, and acknowledgement-free contract. Published Article
reads, draft listing, and any entitlement-specific Article variant beyond the
exact private Draft contract remain `capture-required`.

## Export bookmarks

`x-web feeds.read` with `feed:"bookmarks"` reads one bounded page of the
signed-in account's bookmarks through the captured Bookmarks GraphQL query. It
does not scrape the x.com DOM. Use this page when a daily digest needs a stable
JSON list it can upsert by post ID.

```sh
wrench auth add x-main --cookie-source arc
wrench auth bind x-main --site x
wrench capabilities x-web --json

wrench x-web feeds.read \
  --input '{"feed":"bookmarks","limit":25}' \
  --auth x-main --json
```

A succeeded JSON result has `output.feed` equal to `"bookmarks"`. Upsert
`output.items`. Each item has this exact shape:

```json
{
  "post_id": "2078889282404569267",
  "url": "https://x.com/i/status/2078889282404569267",
  "author_username": "hraness",
  "author_name": "Hraness",
  "text": "Exact status text",
  "created_at": "Tue Jul 22 12:00:00 +0000 2026",
  "folder_id": null,
  "bookmarked_at": null
}
```

`post_id` is the stable X status ID. Treat a repeated `post_id` as the same
bookmark. `url` is the `/i/status/{post_id}` permalink, so it stays valid if
the author handle changes. `author_username` and `author_name` are null when
the GraphQL page omits the author nest. `folder_id` and `bookmarked_at` are
present and null on the current Bookmarks page; do not invent folder or
timestamp values.

Pass the previous page's `output.cursor` as `cursor` to read the next page:

```sh
wrench x-web feeds.read \
  --input '{"feed":"bookmarks","limit":25,"cursor":"PREVIOUS_PAGE_CURSOR"}' \
  --auth x-main --json
```

Stop when `output.cursor` is null, when `terminatedDirections` includes
`Bottom`, or when every returned `post_id` is already in the store. If the
provider page contains more matching posts than `limit`, the command fails
closed or returns `cursor: null` instead of skipping unseen entries. Bind the
signed-in account before the read; an account mismatch fails before the
Bookmarks query. This is an R1 read and does not change unlabeled-copy or Made
with AI publish behavior.

The same invocation still returns `output.posts` with the shared camelCase feed
projection (`id` equals `post_id`). Prefer `output.items` for an external
sqlite upsert.

## Resolve current X material

Code owns the operation name, exact GraphQL path, feature variables, query/body shape, and response projection. Current registered-operation revisions may be recovered from bounded first-party assets or capture metadata only by exact operation prefix. Require one unique match.

Acquire cookies through the auth layer. Route the reviewed CSRF value only to the fixed CSRF header and a captured/storage authorization value only to `authorization`. Keep both in memory. Never put a bearer value, CSRF token, cookie, feature contract, query revision, or raw GraphQL variables in a manifest, preview, receipt, URL log, or generic output.

Return `capture-required` on a missing or ambiguous operation revision, feature drift, token-source drift, response-shape drift, or account-binding failure. Do not launch the X composer to compensate.

## Preserve capture-required mutations

The current registry keeps these text/desired-state exchanges capture-required:

- `threads.publish` (`R3`): one confirmed ordered root/self-reply schedule;
- `posts.repost` (`R3`): exact desired repost state;
- `posts.quote` (`R3`): one text quote bound to an exact post.
- `content.delete` (`R3`): the DeleteTweet descriptor is revision evidence only; keep deletion capture-required until an authorized fixture binds the exact authored target and text, request variables, accepted response, and exact not-found readback.

Current `x-client-transaction-id` generation is code-owned: wrench resolves the unique wrapper module, exported helper, and lazy-module evidence from the current first-party main bundle, calls that cached helper through one contained private agent-browser session, closes and cleans the session, then places the ephemeral value only on the already-reviewed in-origin mutation request. Drift or bootstrap failure occurs before the durable dispatch boundary and is never retried. This prerequisite does not by itself graduate the contract states listed above.

`likes.set` and `content.save` (`R2`) bind the exact account and post, select only the matching create/delete mutation for the confirmed desired state, validate the operation-specific `Done` response, and independently read the same post through TweetResultByRestId before marking the dispatch verified. Separate reversible live fixtures proved bookmark false → true → false and like false → true → false, including both independent reads and restoration of the original false state. `articles.draft.save` is the separate observed private structured-text-and-inline-image contract above.

`posts.publish@4` is the separate observed R3 post contract. It accepts exact
text and at most one plan-bound PNG or MP4, binds the account and uploaded media ID,
admits one CreateTweet dispatch, durably retains the response-bound post/media
target before readback, and polls only that exact post through
TweetResultByRestId.

`replies.create@1` is the observed R3 text-reply contract on the same CreateTweet
path. It accepts exact `post_id` plus `body`, binds `reply.in_reply_to_tweet_id`
to that parent, rejects quote IDs and media, admits one CreateTweet dispatch,
durably retains the response-bound reply ID, and polls only that exact reply
through TweetResultByRestId. The response and independent readback must echo
the authenticated account and requested parent. Threads, quotes, reposts, DMs,
and Article publishing remain capture-required. Do not launch the X composer
as a fallback.

CreateTweet sends empty `semantic_annotation_ids` and no AI or
content-disclosure field. The reviewed GraphQL contract has no
`made_with_ai` or `content_disclosure` input; do not invent one. Official
OAuth `x` `posts.publish` exposes optional `made_with_ai` and sends `true`
only when the caller explicitly asks. Leave that field unset or `false` for
user-supplied cross-post copy. JPEG and PNG uploads are re-encoded to
pixels-only bytes before INIT or APPEND. A live Made with AI sparkle on
CreateTweet or TweetResultByRestId is a failed unlabeled-copy publish for
both `posts.publish` and `replies.create`.
See [X AI disclosure](x-ai-disclosure.md).

Bind every CreateTweet response to the authenticated account and requested reply/quote parent. For a thread, bind each returned post ID, use it as the next reviewed parent, and durably mark each dispatch. Stop on `partial` or `indeterminate`; never replay the root or remaining continuations automatically.

Treat repost, like, and bookmark as desired state only when both create and delete mutations are reviewed and response-bound. A state mismatch is not permission to issue another mutation blindly.

Article covers, embeds, video, and native image alt text are outside
`articles.draft.save`. Inline images use only the exact plan-bound file array;
do not ignore a supplied file or fall back to DOM upload.

## Other capture-required operations

The current `x-web` registry keeps these unavailable:

- `messaging.list` and `messaging.read` (`R1`) until verified X Chat key recovery, plaintext projection, and acknowledgement-free handling are installed;
- `messaging.send` (`R3`) until its exact current mutation, conversation/user target, response, and media path are captured;
- `articles.publish` (`R3`) until the distinct publish mutation and public
  readback are captured and response-bound. `articles.draft.save` never
  authorizes `ArticleEntityPublish`.

No operation may be guessed from downloaded bundles or copied network snippets. A capture-required DM send must not type into X's message composer.

Encrypted X Chat is not a normal HAR template. Plaintext and send require a separately reviewed cryptographic contract for key recovery, request signatures, Juicebox access, exact payload encryption and decryption, and forward compatibility.

## Risk and confirmation

R1 reads run only after account binding and exclusion of seen/read
acknowledgement requests. The private Article read additionally binds the exact
requested Draft to the current viewer. Likes, bookmarks, and private Article
draft saves are R2. Posts, replies, quotes, reposts, threads, DMs, and Article
publication are R3.

Preview the exact account realm, target, body/items, attachment hashes, reply settings, desired state, contract hash, and dispatch schedule. Confirm once. Require duplicate refusal. If a request left but its response or target binding is uncertain, report `indeterminate` and preserve the ledger.

## Recapture on drift

Recapture when the operation revision, feature variables, path, request fields, authorization/CSRF source, response status/content type, projection, or identity binding changes. Update owned code, bump the contract and adapter versions, and rerun deterministic plus authorized live tests. Never patch a live request from arbitrary HAR values and never substitute browser clicks.
