---
title: x-web articles.draft.save create after images
description: Private Article create can finish after verified inline-image uploads, and a pre-dispatch create failure keeps started at the verified media count with the exact reason on the receipt.
type: plan
area: x-web
status: in-progress
repository_scopes:
  - src/providers/x-web-runtime.ts
  - src/providers/x-web-runtime.internal.test.ts
tags:
  - x-web
  - articles
---

# x-web articles.draft.save create after images

## Outcome

`x-web` `articles.draft.save` can complete `articles.create` and private readback after two verified inline-image uploads, still `published: false` / `mode: "draft"`. When create fails before `begin`, the receipt names the exact pre-dispatch reason and `started` stays equal to the verified media count.

## Context

Two confirms on 2026-08-21 stopped after verified media and before `articles.create` (`planned 3`, `started 2`, `verified 2`, `dispatchStarted: true`, `finalOrigin: null`):

`authenticated web API stopped after verified dispatches before completing the confirmed schedule; reconcile before retrying; reason: X verified only part of the confirmed private Article workflow; inspect the draft before retrying`

Stable x-web 1.7.0 run `b940e5d8-4f9c-4cf8-be15-a168ce718e9a` and isolated x-web 1.10.0 run `6f4a1209-052f-48d3-90ab-f09813ab57c3` share contract `x/articles.draft.save@2` hash `633d08c1…` and inputHash `963b2101…`. Preview planned `articles.media.inline[1]`, `articles.media.inline[2]`, `articles.create`. Auth realm `x-main` (cookie-source, subject `896906084014845952`). Those runs are partial and have no reconciler; do not retry them.

`started === verified === 2` means `articles.create` never crossed its before-dispatch `begin`. In `executeArticleDraftSave` that is failure during `resolving the Article create mutation` or `preparing the Article create mutation`. The receipt had swallowed the underlying Error, so both runs looked identical.

The CreateTweet query-ID-drift hypothesis from [[plans/x-web-publish-confirm-dispatch|x-web posts.publish confirm dispatch]] does not hold for this mutation. Public `bundle.TwitterArticles.305538ca.js` (last-modified 2026-08-19) still exports `ArticleEntityDraftCreate` as `btD9FyMDa3_vydVp7fr87Q`. First-party create remains `graphQL(..., { content_state, title })`. Descriptor metadata is five feature switches plus `withPayments` and `withAuxiliaryUserLabels`, already handled by `fieldToggleValue`. The image fixture used `draft_id`, so it scheduled media then `articles.title` / `articles.content` and never exercised create after uploads.

[[notes/repository-seams|Repository seams]] keep that kernel contract in this package.

## Scope

### In scope

- Surface `failureStage` and the underlying Error on the Article partial and failed receipts.
- Fixture the create-after-inline-images schedule against the current observed Article contract.
- Fixture create failing before `begin` after two verified uploads.

### Non-goals

- An image-capable reconciler, or retrying the partial live runs.
- Official `x` OAuth, `articles.publish`, or guessed draft IDs.
- Video / `posts.publish@4` work.

## Constraints and decisions

- Keep `articles.draft.save` R2, draft-only, `published: false`, `mode: "draft"`.
- Do not search by title or invent a draft ID.
- Query IDs stay revision evidence. Dispatch still resolves the current bundle and rejects drift.
- Do not print or commit cookies, tokens, or live session material.
- Do not echo query IDs in receipt assertions.

## Plan

1. Record the observed Article create evidence and discard query-ID drift for `ArticleEntityDraftCreate` on the current public bundle.
2. Return the exact pre-dispatch failure reason from `executeArticleDraftSave`.
3. Fixture two verified media dispatches then `articles.create`, and the drifted-create case where `started` stays 2.

## Verification

- Fixture confirm of `articles.draft.save@2` with two inline images starts and verifies `articles.media.inline[1]`, `articles.media.inline[2]`, `articles.create`, then private readback. No `ArticleEntityPublish`.
- A stale `ArticleEntityDraftCreate` query ID after those uploads is `partial` with `started === verified === 2`, names `query-ID drift`, and sends no create POST.
- `bun run check`.

## Risks and recovery

- A later live create failure can still be chunk-map binding, transaction-ID bootstrap, or authorize/metadata prepare. The receipt must name that Error so the next refresh is obvious.
- The partial live runs remain unreconciled. Preserve them and do not retry.

## Execution evidence

- 2026-08-21 — Public `bundle.TwitterArticles.305538ca.js` still binds `ArticleEntityDraftCreate` `btD9FyMDa3_vydVp7fr87Q` and `createDraftArticle({ content_state, title })`.
