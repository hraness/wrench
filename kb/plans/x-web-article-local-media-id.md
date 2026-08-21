---
title: x-web Article readback local media IDs
description: Cookie-source articles.draft.save can finish private create when X returns reviewed local_media_id values as digit strings or camelCase fields.
type: plan
area: x-web
status: in-progress
repository_scopes:
  - src/providers/x-web-runtime.ts
  - src/providers/x-web-runtime.internal.test.ts
  - src/providers/x-web.ts
tags:
  - x-web
  - articles
---

# x-web Article readback local media IDs

## Outcome

Cookie-source `articles.draft.save` with two verified inline images can finish `articles.create` and return `published: false`, `mode: "draft"`, the response-bound draft id, and the edit URL when readback represents those same images with a digit-string `local_media_id` or camelCase media-item fields on a snake-case entity map. An unreviewed extra MEDIA entity or non-binding local id stays `indeterminate` and names the observed type and value.

## Context

Isolated confirm `cc7f1a95-f135-4a9e-a047-40a88aa3335b` on `ac63784` (PR 7) got past block 11 `@SemiAnalysis_` data. No 403. No webpack miss. Create began. Died in created-Article readback:

`X rich Article local media IDs must be positive integers`

- inputHash `963b210123d3c314518a7f938d0b082248f7e74af35f568492fc66276452b697`
- planDigest `cfb4ed3e22809616605f036ea466bfa4b13a51c85e9d0587f02b9e95f1358acd`
- planned 3 / started 3 / verified 2
- startedAt `2026-08-21T05:03:01.980Z`, finishedAt `2026-08-21T05:03:11.715Z`
- `failureStage` `verifying the created Article readback`
- no draft id on the receipt

`validateXWebRichArticleContentState` requires `Number.isSafeInteger(local_media_id) && >= 1`. We send `imageIndex + 1` as numbers. `normalizedArticleMediaItems` copied the raw field. `exactMutationKeys` already required the three media-item keys, so the field was present and was not a safe integer ≥ 1. The error omitted the observed value and type.

Leave these runs alone: `b940e5d8`, `6f4a1209`, `8de55083`, `42c33ead`, `d4b346d9`, `ecae5825`, `8c6ad3c7`, `cc7f1a95`.

[[plans/x-web-article-block-data|x-web Article readback block data]] cleared the mention `data` bind. [[notes/repository-seams|Repository seams]] keep the kernel contract here.

## Scope

### In scope

- Coerce a reviewed digit string or number `local_media_id` to a bounded positive integer on readback.
- Accept camelCase or snake_case media-item field names on either entity-map shape.
- Fail closed on an unreviewed MEDIA/embed or non-binding local id and include the observed type and value.
- Keep the create payload numeric `local_media_id: imageIndex + 1`.

### Non-goals

- Retrying the listed live runs, guessing a draft id, title search, or a reconciler.
- Sending mentions or tweet embeds on create.
- Opening `/` or `/home` before cookies, or reverting launch, eval, polling, real-error receipts, or non-binding `block.data` keys.

## Constraints and decisions

- Keep `articles.draft.save` R2, draft-only, `published: false`, `mode: "draft"`.
- Reviewed local ids are 1 through 20. A snowflake string is not a reviewed local id.
- Do not invent the live extra key names. Digit-string and camelCase copies are verified against the code path that produced the receipt.
- Do not print or commit cookies, tokens, or live session material.

## Plan

1. Record that validate ran after a raw `local_media_id` copy and hid the observed value.
2. Coerce reviewed local ids and accept either media-item naming on both entity-map shapes.
3. Fixture digit-string/camelCase success and an unreviewed MEDIA local id after create starts.

## Verification

- Two verified images then private create still succeed with `published: false` and no `ArticleEntityPublish` when readback `local_media_id` is a digit string and/or camelCase on a snake-case entity map.
- After create starts, an unreviewed extra MEDIA entity or non-binding local id stays `indeterminate`, includes the real reason and observed value, and does not retry create.
- Cookie-source still launches `https://x.com/robots.txt` before cookies. Transaction eval still opens `https://x.com/home` after cookies and requires `text/html`.
- `bun run check`.

## Risks and recovery

- If the live value is `0`, empty, or a snowflake on one of the two uploaded images, the next confirm will name it. Do not retry the ledger.
- Tweet-URL-to-embed rewrite remains a hypothesis. The fail path now reports the observed local id.

## Execution evidence

- 2026-08-21 — Confirm `cc7f1a95-f135-4a9e-a047-40a88aa3335b` on `ac63784` started create after two verified images, then stayed indeterminate at `verifying the created Article readback` because `local_media_id` was not a safe integer ≥ 1.
