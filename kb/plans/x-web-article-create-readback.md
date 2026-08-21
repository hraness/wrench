---
title: x-web Article create readback
description: Cookie-source articles.draft.save can finish private create after two verified images, and a post-dispatch readback failure keeps the real Error and failureStage on the receipt.
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

# x-web Article create readback

## Outcome

Cookie-source `articles.draft.save` with two verified inline images can finish `articles.create` and return `published: false`, `mode: "draft"`, the response-bound draft id, and the edit URL. After create starts, a readback mismatch or query failure stays `indeterminate`, names the exact `failureStage`, and includes the real `Error.message`. Session launch still opens `/robots.txt` before cookies. Transaction eval still opens `/home` after cookies and requires `text/html`.

## Context

Isolated confirm `ecae5825-b8bc-406e-9151-df3951b8edeb` on `9a54c4e` (PR 5) got past webpack. No 403. `articles.create` began. Two images verified. Create did not verify.

- inputHash `963b210123d3c314518a7f938d0b082248f7e74af35f568492fc66276452b697`
- planDigest `827c777f8222ab4f5cc308f50f4d29886b1cb1f12706e6f0e1764c03efa20321`
- contract `x/articles.draft.save@2` hash `633d08c128dcb34a7936b46c39daf1fb0b23c4a936e20565af0d030c761a7bf9`
- planned 3 / started 3 / verified 2
- startedAt `2026-08-21T04:30:59.756Z`, finishedAt `2026-08-21T04:31:06.364Z`
- `failureStage` `verifying the created Article readback`
- no draft id on the receipt

Receipt error (verbatim):

`authenticated web API result is indeterminate after the dispatch boundary; reason: X may have accepted an inline-image upload or private Article dispatch while verifying the created Article readback; media-contract-step-failed; its provider media IDs are not present in the confirmed input, so preserve the indeterminate run and do not retry`

`xWebArticleImageFailureCategory` falls through to `media-contract-step-failed` for readback and verify errors. The catch in `executeArticleDraftSave` interpolates that category and drops `preparationReason`. Run JSON and journal are equally thin.

`failureStage` is verifying, so `readArticleDraft` returned an article and `verifyFinalRichArticle` threw. That function requires a private Draft, matching title, then `normalizeArticleContentReadback` plus `canonicalJson` against the sent `content_state`. `readArticleDraft` does not require `content_state`, so a create-response-shaped shell can reach verify and fail there. Snake-case MEDIA copies `media_items` as-is; camelCase already keeps only `local_media_id`, `media_category`, and `media_id`. Extra fields then fail `exactKeys`. Create currently does one immediate `ArticleEntityResultByRestId` with no delay schedule; posts already poll with `PUBLISH_READBACK_DELAYS_MS`.

Leave these runs alone: `b940e5d8`, `6f4a1209`, `8de55083`, `42c33ead`, `d4b346d9`, `ecae5825`. Do not invent a draft id.

[[plans/x-web-article-create-after-images|x-web articles.draft.save create after images]] fixtureed create after uploads. [[plans/x-web-article-create-webpack|x-web Article transaction webpack document]] got that create past webpack. [[notes/repository-seams|Repository seams]] keep the kernel contract here.

## Scope

### In scope

- Put the real `Error.message` on the images-plus-indeterminate receipt. Keep `failureStage` and the do-not-retry sentence.
- Strip snake-case readback `media_items` to the same three reviewed fields as camelCase.
- Poll created and updated Article readback on the post delay schedule until verify succeeds or the bound is exhausted, then throw the last real Error.
- Fixture two-image private create, delayed ready readback, and post-create mismatch or query failure.

### Non-goals

- Retrying the listed live runs, guessing a draft id, title search, or an image-capable reconciler.
- Official `x` OAuth, `articles.publish`, or `ArticleEntityPublish`.
- Opening `/` or `/home` before cookies, or reverting cookie-source `/robots.txt` launch and post-cookie `/home` eval.

## Constraints and decisions

- Keep `articles.draft.save` R2, draft-only, `published: false`, `mode: "draft"`.
- Do not remap unknown MEDIA categories or drop extra entity types. If those are the live bind, the receipt must now say so.
- Extra `media_items` fields are a code asymmetry, not a live guess.
- Immediate unreadiness is a hypothesis. Polling reuses the reviewed post bound; it does not invent a longer wait.
- Do not print or commit cookies, tokens, or live session material.

## Plan

1. Record the discarded readback Error and the snake-case `media_items` copy.
2. Surface `preparationReason` on the images-plus-indeterminate path.
3. Normalize snake-case MEDIA items to the three reviewed fields and poll readback after create and content update.
4. Fixture success, delayed ready readback, and post-create mismatch or query failure.

## Verification

- Two verified images then private create still succeed with `published: false` and no `ArticleEntityPublish`.
- After create starts, a readback mismatch or query failure surfaces the real reason and `failureStage`, stays `indeterminate`, and does not retry create.
- Cookie-source still launches `https://x.com/robots.txt` before cookies. Transaction eval still opens `https://x.com/home` after cookies and requires `text/html`.
- `bun run check`.

## Risks and recovery

- If X remaps `media_category` or inserts extra entity types, the next isolated confirm will show that exact Error. Do not add aliases or drop entities without that evidence.
- Exhausted polling stays indeterminate. Do not retry the ledger.

## Execution evidence

- 2026-08-21 — Confirm `ecae5825-b8bc-406e-9151-df3951b8edeb` on `9a54c4e` started create after two verified images, then stayed indeterminate at `verifying the created Article readback` with `media-contract-step-failed` and no draft id.
- 2026-08-21 — `bun test src/providers/x-web-runtime.internal.test.ts src/providers/x-transaction-id.test.ts src/browser.test.ts` passed 83 tests, including two-image private create with extra MEDIA fields, delayed `content_state` readback, post-create title mismatch and query failure, cookie-source `/robots.txt` launch, and post-cookie `/home` `text/html` eval.
