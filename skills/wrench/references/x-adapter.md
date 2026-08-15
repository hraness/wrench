# X authenticated web API adapter

The `x-web` schema-v4 adapter executes fixed, code-owned first-party `x.com` GraphQL/internal API exchanges with a signed-in cookie realm. A browser may record a managed HAR, bootstrap private session material, or resolve a reviewed current operation revision or transaction value. It never reads a feed, publishes, likes, bookmarks, or messages through X's DOM.

First-party traffic is not the same as a documented public API. Use this local client only with the user's account authority, comply with applicable provider rules, and keep bulk or unsolicited automation outside wrench.

## Contents

- [Install and inspect](#install-and-inspect)
- [Save an Article draft](#save-an-article-draft)
- [Configure and bind the signed-in realm](#configure-and-bind-the-signed-in-realm)
- [Use observed R1 contracts](#use-observed-r1-contracts)
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

Use the documented OAuth adapter when the intent is to save an X Article without publishing it. Contract version 2 accepts the literal `draft_only: true`, calls the draft endpoint, and returns before any publish request. Omitting the flag preserves the publishing operation, so require it in every draft workflow and inspect the preview before confirmation.

Configure the official `x` OAuth locator with the exact mode-0600 token document, stable numeric subject, and sorted scopes documented in the public Wrench README. The signed-in cookie realm below belongs only to `x-web` and cannot authorize this operation.

```sh
wrench adapter sync-bundled --json
wrench capabilities x --json

wrench x articles.publish \
  --input '{"title":"Reviewed title","body":"Reviewed body","draft_only":true}' \
  --auth x-api --preview --json

wrench confirm <preview-digest> --json
```

The operation remains R3 because the same semantic operation can publish when the flag is absent. Confirm only an exact preview whose input includes `draft_only: true`, whose dispatch contract is version 2, and whose body is the final reviewed draft. The result must report `published: false` and `mode: "draft"`; never treat a returned draft ID as permission to call the separate publish endpoint.

When an existing Arc, Chrome, or Chromium session is the authorized realm, the
`x-web` adapter can create or replace a private native rich draft without an
OAuth token. This is a distinct, first-party internal-API transport. Its
version-3 Article contract requires `draft_only: true`, accepts a strict
version-1 block document with native links and styles, binds optional inline
and cover image files into the exact preview, and has no publish-capable branch.

Create a private JSON input file like this:

```json
{
  "title": "Reviewed title",
  "document": "{\"schemaVersion\":1,\"blocks\":[{\"type\":\"paragraph\",\"text\":\"Read the source\",\"links\":[{\"offset\":9,\"length\":6,\"url\":\"https://example.com/source\"}]},{\"type\":\"image\",\"imageIndex\":0,\"caption\":\"Reviewed caption\"}]}",
  "inline_images": ["/absolute/private/inline.webp"],
  "cover_image": "/absolute/private/cover.jpg",
  "draft_only": true
}
```

```sh
wrench adapter sync-bundled --json
wrench auth add x-arc --cookie-source arc
wrench auth bind x-arc --site x

wrench x-web articles.publish \
  --input @/absolute/private/article-input.json \
  --auth x-arc --preview --json

wrench confirm <preview-digest> --json
```

Confirm only the exact final title, canonical document, plan-bound assets,
optional existing `draft_id`, bound numeric account subject, contract version
3, and `draft_only: true`. Require `published: false` and `mode: "draft"` in the
result. To repair an existing draft, preserve the source block order, put every
inline image block at its intended position, and let `draft_id` drive an exact
title/content/cover replacement. A text-and-links-only failure after dispatch
can be reconciled through the exact Article readback. Pending media cannot be
reconstructed from a lost upload ID: do not retry or clear it. Never reuse the
preview with the official OAuth adapter or silently switch auth realms.

## Configure and bind the signed-in realm

Prefer a target-filtered browser cookie source:

```sh
wrench auth add x-main --cookie-source arc --cookie-profile "Profile 2"
wrench auth bind x-main --site x
wrench auth list --json
```

Use a private profile snapshot only when current local/session storage or first-party assets are needed to recover an approved authorization value or registered-operation revision.

Before private reads or mutations, resolve the current stable X user ID through a reviewed account request and compare it with the realm's expected binding. Bind created posts, replies, quotes, reposts, likes, bookmarks, and DMs to that account plus the exact requested target. Fail before dispatch on account ambiguity or mismatch.

## Use observed R1 contracts

The current registry marks these code-owned reads observed:

- `feeds.read`: one bounded For You, Following, user, List, search, or bookmarks page;
- `posts.read`: one exact post through the current TweetDetail query;
- `comments.read`: one bounded TweetDetail conversation/reply page.

Authorized direct live evidence for this contract version covers For You, bookmarks, one exact post, and its bounded comments. Following, user, List, and search remain declared modes of the observed `feeds.read` contract; check `wrench capabilities x-web --json` for the installed input schema and let current preflight fail closed on revision drift.

The only observed web writes are `likes.set` and `content.save`, both R2 desired-state mutations. Their evidence comes from prior reversible live fixtures, not the current read-only probes. Preview the exact post ID and desired `liked` or `saved` boolean, confirm the returned digest, and inspect the receipt. wrench does not mark either mutation verified until an independent TweetResultByRestId readback matches that boolean.

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

```

One page is not a completeness claim. Return a provider cursor only after projecting the complete provider page. If X returns more matching posts or replies than the requested projection limit, fail without exposing the end cursor instead of silently skipping unseen entries. User and List feeds additionally require the response to echo exactly the requested user/List identity. Keep inbox listing separate from conversation read so the R1 contract can exclude acknowledgement traffic.

DM folder/conversation reads remain `capture-required` because current X Chat events are encrypted. They require the separate reviewed key-recovery, plaintext projection, and acknowledgement-free contract. Native X Article read remains `capture-required` until the entitlement-specific detail exchange is captured and projected.

## Resolve current X material

Code owns the operation name, exact GraphQL path, feature variables, query/body shape, and response projection. Current registered-operation revisions may be recovered from bounded first-party assets or capture metadata only by exact operation prefix. Require one unique match.

Acquire cookies through the auth layer. Route the reviewed CSRF value only to the fixed CSRF header and a captured/storage authorization value only to `authorization`. Keep both in memory. Never put a bearer value, CSRF token, cookie, feature contract, query revision, or raw GraphQL variables in a manifest, preview, receipt, URL log, or generic output.

Return `capture-required` on a missing or ambiguous operation revision, feature drift, token-source drift, response-shape drift, or account-binding failure. Do not launch the X composer to compensate.

## Preserve capture-required mutations

The current registry keeps these text/desired-state exchanges capture-required:

- `posts.publish` (`R3`): one text post;
- `threads.publish` (`R3`): one confirmed ordered root/self-reply schedule;
- `replies.create` (`R3`): one text reply bound to an exact parent;
- `posts.repost` (`R3`): exact desired repost state;
- `posts.quote` (`R3`): one text quote bound to an exact post.

Current `x-client-transaction-id` generation is code-owned: wrench resolves the unique wrapper module, exported helper, and lazy-module evidence from the current first-party main bundle, calls that cached helper through one contained private agent-browser session, closes and cleans the session, then places the ephemeral value only on the already-reviewed in-origin mutation request. Drift or bootstrap failure occurs before the durable dispatch boundary and is never retried. This prerequisite does not by itself graduate the contract states listed above.

`likes.set` and `content.save` (`R2`) bind the exact account and post, select only the matching create/delete mutation for the confirmed desired state, validate the operation-specific `Done` response, and independently read the same post through TweetResultByRestId before marking the dispatch verified. Separate reversible live fixtures proved bookmark false → true → false and like false → true → false, including both independent reads and restoration of the original false state. `articles.publish` is also observed only for its version-3, private-draft rich contract above. Text posts, threads, replies, reposts, quotes, DMs, and Article publishing did not graduate from those fixtures.

Bind every CreateTweet response to the authenticated account and requested reply/quote parent. For a thread, bind each returned post ID, use it as the next reviewed parent, and durably mark each dispatch. Stop on `partial` or `indeterminate`; never replay the root or remaining continuations automatically.

Treat repost, like, and bookmark as desired state only when both create and delete mutations are reviewed and response-bound. A state mismatch is not permission to issue another mutation blindly.

Article images are limited to the reviewed version-3 INIT/APPEND/FINALIZE and
Article entity attachment schedule. Other media remains capture-required. Do
not ignore a supplied file or fall back to DOM upload.

## Other capture-required operations

The current `x-web` registry keeps these unavailable:

- `messaging.list` and `messaging.read` (`R1`) until verified X Chat key recovery, plaintext projection, and acknowledgement-free handling are installed;
- `messaging.send` (`R3`) until its exact current mutation, conversation/user target, response, and media path are captured;
- `articles.read` (`R1`) until the entitlement-specific detail read is captured;
- `x-web articles.publish` is observed only for the version-3 native rich,
  draft-only path described above; `ArticleEntityPublish` remains outside that
  contract.

No operation may be guessed from downloaded bundles or copied network snippets. A capture-required DM send must not type into X's message composer.

Encrypted X Chat is not a normal HAR template. Plaintext and send require a separately reviewed cryptographic contract for key recovery, request signatures, Juicebox access, exact payload encryption and decryption, and forward compatibility.

## Risk and confirmation

R1 reads run only after account binding and exclusion of seen/read acknowledgement requests. Likes and bookmarks are R2 desired state. Posts, replies, quotes, reposts, threads, DMs, and Article drafts are R3.

Preview the exact account realm, target, body/items, attachment hashes, reply settings, desired state, contract hash, and dispatch schedule. Confirm once. Require duplicate refusal. If a request left but its response or target binding is uncertain, report `indeterminate` and preserve the ledger.

## Recapture on drift

Recapture when the operation revision, feature variables, path, request fields, authorization/CSRF source, response status/content type, projection, or identity binding changes. Update owned code, bump the contract and adapter versions, and rerun deterministic plus authorized live tests. Never patch a live request from arbitrary HAR values and never substitute browser clicks.
