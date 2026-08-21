---
title: x-web Article transaction webpack document
description: Headless cookie-source Article create can mint x-client-transaction-id because post-cookie eval runs on the responsive-web HTML that installs webpack.
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

# x-web Article transaction webpack document

## Outcome

Headless cookie-source `articles.draft.save` can finish private `articles.create` and readback after two verified inline-image uploads. Session launch still opens `/robots.txt` before cookies. After cookies, transaction eval runs on `/home`, the same-origin HTML that already carries `vendor`, `main`, and `webpackChunk_twitter_responsive_web`. Webpack-unavailable before `begin` stays `partial` with `started === verified === 2` and the exact reason on the receipt.

## Context

Box confirm `d4b346d9-d938-4498-9247-eeffc50440e4` on merged PR 4 (`7b6d00e`) got past the cookieless 403, then died with:

`failure stage: preparing the Article create mutation; agent-browser batch failed with exit code 1: Evaluation error: Error: X webpack runtime is unavailable`

`planned 3`, `started 2`, `verified 2`. Same inputHash as the earlier partials. Auth `x-main` cookie-source, `headed: false`. Those runs remain unreconciled; do not retry them.

PR 4 left cookie-source session launch on `/robots.txt` before cookies. `generateXClientTransactionId` then opened that same URL after injection. `/robots.txt` is `text/plain`. The eval looks for `abs.twimg.com` `main.*.js`, may inject the reviewed bundle, then requires `globalThis.webpackChunk_twitter_responsive_web`. That runtime is installed by first-party HTML (inline bootstrap plus `vendor.js`), not by loading `main.js` onto a text document.

Public first-party documents on 2026-08-21:

- `/robots.txt` — `text/plain`, no scripts
- `/` — logged-out x-web `entry-client-logged-out`, not `main.*.js`
- `/home` — responsive-web HTML with `vendor`, `main`, and `webpackChunk_twitter_responsive_web`

`bootstrapX` already fetched `/home` as `text/html` with these cookies before create-prep. Local success fits a `browser-profile` clone sitting on that HTML document.

[[plans/x-web-article-create-session-launch|x-web Article cookie-source session launch]] named the webpack residual. [[notes/repository-seams|Repository seams]] keep the kernel contract here.

## Scope

### In scope

- After cookies, open `/home` for transaction eval.
- Keep cookie-source session launch on `/robots.txt`.
- Reject a non-HTML document in eval with `X webpack runtime is unavailable`.
- Fixture webpack-unavailable after two verified uploads.

### Non-goals

- An image-capable reconciler, or retrying the partial live runs.
- Official `x` OAuth, `articles.publish`, or guessed draft IDs.
- Opening first-party HTML before cookies, or launching cookie-source on `about:blank`.

## Constraints and decisions

- Keep `articles.draft.save` R2, draft-only, `published: false`, `mode: "draft"`.
- Do not search by title or invent a draft ID.
- Do not print or commit cookies, tokens, or live session material.
- Query IDs stay revision evidence.

## Plan

1. Record that robots.txt eval cannot install webpack and that `/home` is the reviewed HTML host.
2. Point the post-cookie transaction open at `/home` and fail closed on a non-HTML document.
3. Fixture webpack-unavailable after two verified uploads.

## Verification

- Cookie-source session launch still opens `https://x.com/robots.txt` before cookies and never opens `https://x.com` or `/home` first.
- Transaction eval opens `https://x.com/home` after the session exists and requires `text/html`.
- Fixture `articles.draft.save@2` with two images still completes create and private readback without `ArticleEntityPublish`.
- `X webpack runtime is unavailable` during create-prep stays `partial` with `started === verified === 2` and that reason class.
- `bun run check`.

## Risks and recovery

- Headless Chromium might still 403 `/home` even with cookies. The HTTP client on this box already retrieved that document as `text/html`; a navigation 403 stays at create-prep with the existing reason class.
- `/` remains the logged-out x-web stack and is not a webpack host.

## Execution evidence

- 2026-08-21 — Box confirm `d4b346d9-d938-4498-9247-eeffc50440e4` on `7b6d00e` failed during create-prep after two verified uploads with `X webpack runtime is unavailable`.
- 2026-08-21 — Public `/robots.txt` is `text/plain`. Public `/` is logged-out x-web. Public `/home` is the responsive-web HTML with `vendor`, `main`, and the webpack push interceptor.
