---
title: x-web Article readback block data
description: Cookie-source articles.draft.save can finish private create when X annotates provider-only keys onto block.data around a mention.
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

# x-web Article readback block data

## Outcome

Cookie-source `articles.draft.save` with two verified inline images, a mention in a blockquote, and a later tweet-URL paragraph can finish `articles.create` and return `published: false`, `mode: "draft"`, the response-bound draft id, and the edit URL. Provider-only `block.data` keys on readback are non-binding. A load-bearing `data` shape stays `indeterminate`, names the observed keys, and does not retry create.

## Context

Isolated confirm `8c6ad3c7-792f-4c5f-b481-8435a2dc3c98` on `84095bc` (PR 6) proved the receipt fix. No 403. No webpack miss. Create began. Polling ran. The receipt carried the real Error:

`X Article readback block 11.data left the reviewed empty-or-urls shape`

- inputHash `963b210123d3c314518a7f938d0b082248f7e74af35f568492fc66276452b697`
- planDigest `d5d65fc1af9950cbc080ff3e7640157ccf9255f3d16bf43df265468315ccc8de`
- planned 3 / started 3 / verified 2
- startedAt `2026-08-21T04:56:43.292Z`, finishedAt `2026-08-21T04:56:52.760Z`
- `failureStage` `verifying the created Article readback`
- no draft id on the receipt

`normalizedArticleBlockData` labels are 1-based. Input block 10 is the blockquote `(70x subsidy reported by @SemiAnalysis_ in June)` with empty links. We send `data: {}`. The helper already drops a reviewed `urls` array to `{}`. Extra keys fail first. The live extra key names are unknown; do not invent them.

Leave these runs alone: `b940e5d8`, `6f4a1209`, `8de55083`, `42c33ead`, `d4b346d9`, `ecae5825`, `8c6ad3c7`.

[[plans/x-web-article-create-readback|x-web Article create readback]] surfaced this bind. [[notes/repository-seams|Repository seams]] keep the kernel contract here.

## Scope

### In scope

- Treat extra `block.data` keys as non-binding on readback and still return `{}`.
- Keep failing closed when `urls` exist and do not bind the block text.
- Reject a remaining load-bearing shape (media or entity-map fields on `data`) and include the observed keys.
- Fixture a mention blockquote plus a tweet-URL paragraph after two verified images.

### Non-goals

- Retrying the listed live runs, guessing a draft id, title search, or a reconciler.
- Sending mention entities on create that the confirmed input did not include.
- Opening `/` or `/home` before cookies, or reverting launch, eval, polling, or real-error receipts.

## Constraints and decisions

- Keep `articles.draft.save` R2, draft-only, `published: false`, `mode: "draft"`.
- Do not invent the live extra key names. The mention-annotation hypothesis is verified only by treating unknown extra keys as non-binding unless they carry reviewed media or entity-map fields.
- Do not change the create payload.
- Do not print or commit cookies, tokens, or live session material.

## Plan

1. Record that block 11 failed because `data` was neither `{}` nor exactly `{ urls }`.
2. Strip provider-only `data` keys and keep `urls` binding plus a load-bearing reject that names observed keys.
3. Fixture mention extras on success and a media-bearing `data` shape after create starts.

## Verification

- Two verified images then private create still succeed with `published: false` and no `ArticleEntityPublish`, including a blockquote whose readback `data` has extra provider keys around a `@mention`.
- After create starts, a load-bearing `data` shape stays `indeterminate`, includes the real reason and observed keys, and does not retry create.
- Cookie-source still launches `https://x.com/robots.txt` before cookies. Transaction eval still opens `https://x.com/home` after cookies and requires `text/html`.
- `bun run check`.

## Risks and recovery

- If the live extra key is actually a media or entity-map field, the next confirm will name it. Do not retry the ledger.
- Tweet-URL-to-embed rewrite was not reached on this run. Leave that closed until a receipt shows it.

## Execution evidence

- 2026-08-21 — Confirm `8c6ad3c7-792f-4c5f-b481-8435a2dc3c98` on `84095bc` started create after two verified images, then stayed indeterminate at `verifying the created Article readback` because block 11 `data` left the empty-or-urls shape.
