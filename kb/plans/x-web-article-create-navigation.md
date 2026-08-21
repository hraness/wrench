---
title: x-web Article create transaction navigation
description: Private Article create can finish after verified inline images because transaction bootstrap no longer navigates Chromium to /home.
type: plan
area: x-web
status: in-progress
repository_scopes:
  - src/providers/x-transaction-id.ts
  - src/providers/x-transaction-id.test.ts
  - src/providers/x-web-runtime.internal.test.ts
tags:
  - x-web
  - articles
---

# x-web Article create transaction navigation

## Outcome

`articles.draft.save` can complete private `articles.create` and readback after two verified inline-image uploads. Transaction bootstrap opens a same-origin 200 document instead of `/home`. A navigation HTTP failure before `begin` stays `partial` with `started === verified === 2` and the exact reason on the receipt.

## Context

Confirm `8de55083-91ff-41b3-abff-bf2589ce5209` on isolated current-main / x-web 1.9.0 stopped after verified media (`planned 3`, `started 2`, `verified 2`) with:

`failure stage: preparing the Article create mutation; agent-browser batch failed with exit code 1: Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE`

`articles.create` never called `begin`. The same inputHash and contract as the earlier 1.7.0 and 1.10.0 partials. Those runs remain unreconciled; do not retry them.

`generateXClientTransactionId` opened `https://x.com/home` after cookie injection. Public `/home`, `/compose/articles`, and `/compose/post` return 403 without a first-party document session. `https://x.com/` and `https://x.com/robots.txt` return 200. Derivation already bootstraps on `robots.txt` for that reason. Image uploads do not use the agent-browser; the first navigation is create-prep.

[[plans/x-web-article-create-after-images|x-web articles.draft.save create after images]] surfaced this stage. [[notes/repository-seams|Repository seams]] keep the kernel contract here.

## Scope

### In scope

- Open the same-origin 200 bootstrap used by derivation, then load the already-resolved public main bundle before calling the first-party transaction helper.
- Keep `failureStage` and `preparationReason` on the Article receipt.
- Fixture media-then-create success and a navigation HTTP failure before `begin`.

### Non-goals

- An image-capable reconciler, or retrying the partial live runs.
- Official `x` OAuth, `articles.publish`, or guessed draft IDs.
- Changing contained browser session launch for every cookie-source consumer.

## Constraints and decisions

- Keep `articles.draft.save` R2, draft-only, `published: false`, `mode: "draft"`.
- Do not search by title or invent a draft ID.
- Do not print or commit cookies, tokens, or live session material.
- Query IDs stay revision evidence.

## Plan

1. Record that `/home` is a 403 document for unauthenticated Chromium and that create-prep is that navigation.
2. Point transaction bootstrap at `/robots.txt` and load the reviewed main bundle when the page has no app scripts.
3. Fixture the navigation HTTP failure after two verified uploads.

## Verification

- Transaction bootstrap opens `https://x.com/robots.txt` and does not mention `/home` in the evaluation source.
- Fixture `articles.draft.save@2` with two images still completes create and private readback without `ArticleEntityPublish`.
- A `net::ERR_HTTP_RESPONSE_CODE_FAILURE` during create-prep stays `partial` with `started === verified === 2` and that reason class.
- `bun run check`.

## Risks and recovery

- First-party `main.js` might refuse to install webpack on an inert path. The receipt will still name the evaluation Error.
- Session setup 403 on `https://x.com/` fired on box confirm `42c33ead-76ad-47cc-ab48-d2bd8049b5ee`. Follow-up is [[plans/x-web-article-create-session-launch|x-web Article cookie-source session launch]].

## Execution evidence

- 2026-08-21 — Public `https://x.com/home` and compose Article URLs return 403. `https://x.com/` and `https://x.com/robots.txt` return 200.
- 2026-08-21 — Fixture media-then-create still succeeds. A `net::ERR_HTTP_RESPONSE_CODE_FAILURE` during create-prep stays `partial` with `started === verified === 2` (`src/providers/x-web-runtime.internal.test.ts`). Transaction bootstrap opens `https://x.com/robots.txt` (`src/providers/x-transaction-id.test.ts`).
