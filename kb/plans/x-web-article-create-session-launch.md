---
title: x-web Article cookie-source session launch
description: Headless cookie-source Article create can pass create-prep because the contained session no longer opens a first-party X document before cookies.
type: plan
area: x-web
status: in-progress
repository_scopes:
  - src/browser.ts
  - src/browser.test.ts
  - src/providers/x-web-runtime.internal.test.ts
tags:
  - x-web
  - articles
---

# x-web Article cookie-source session launch

## Outcome

Headless `cookie-source` `articles.draft.save` can finish private `articles.create` and readback after two verified inline-image uploads. Contained session launch opens same-origin `/robots.txt` before cookies. `browser-profile` still starts on `about:blank`. Domain allowlisting is unchanged. A session-launch HTTP failure before `begin` stays `partial` with `started === verified === 2` and the exact reason on the receipt.

## Context

Box confirm `42c33ead-76ad-47cc-ab48-d2bd8049b5ee` used merged PR 3 (`b876861`, robots.txt transaction bootstrap) and still died with:

`failure stage: preparing the Article create mutation; agent-browser batch failed with exit code 1: Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE`

`planned 3`, `started 2`, `verified 2`. Auth on that box is `x-main` cookie-source, not `browser-profile`. Transaction bootstrap is `headed: false` and `containedBrowserAuth` keeps cookie-source. Those partials remain unreconciled; do not retry them.

PR 3 only changed the open *after* `createBrowserSession` returns. For cookie-source and cookies-file, `createBrowserSession` still opened `manifest.origins[0]` (`https://x.com` for `xTransactionBrowserManifest`) and injected cookies after that navigation. `browser-profile` already launches `about:blank`. Domain-contained launches reject `about:blank` because it has no hostname; derivation already bootstraps on `/robots.txt` for that reason.

Box curls on the same machine: GET `https://x.com/` and `https://x.com/robots.txt` are 200; HEAD `https://x.com/home` is 403. Headless Chromium plus the contained proxy can still 403 a cookieless first-party document, or follow `/` into `/home`. Ben's local success fits a `browser-profile` clone that starts on `about:blank`, or a Chromium that is not 403'd on a cookieless `https://x.com` open.

[[plans/x-web-article-create-navigation|x-web Article create transaction navigation]] named this residual. [[notes/repository-seams|Repository seams]] keep the kernel contract here.

## Scope

### In scope

- Launch cookie-source and cookies-file sessions on the same-origin `/robots.txt` used by derivation, then inject cookies.
- Keep `browser-profile` on `about:blank`.
- Keep `--allowed-domains` for contained launches.
- Fixture launch order and keep media-then-create private success.

### Non-goals

- An image-capable reconciler, or retrying the partial live runs.
- Official `x` OAuth, `articles.publish`, or guessed draft IDs.
- Weakening domain allowlisting or starting cookie-source on `about:blank`.

## Constraints and decisions

- Keep `articles.draft.save` R2, draft-only, `published: false`, `mode: "draft"`.
- Do not search by title or invent a draft ID.
- Do not print or commit cookies, tokens, or live session material.
- Query IDs stay revision evidence.

## Plan

1. Record that PR 3's `/robots.txt` open never runs when cookie-source session launch 403s on `https://x.com`.
2. Point contained cookie launches at `/robots.txt` while leaving `browser-profile` on `about:blank`.
3. Fixture cookie-source launch order and a session-launch HTTP failure after two verified uploads.

## Verification

- Cookie-source session launch opens `https://x.com/robots.txt` before cookies and never opens `https://x.com` or `/home`.
- `browser-profile` still launches `about:blank`.
- `--allowed-domains` remains on contained cookie-source batches.
- Fixture `articles.draft.save@2` with two images still completes create and private readback without `ArticleEntityPublish`.
- A `net::ERR_HTTP_RESPONSE_CODE_FAILURE` from `createBrowserSession` stays `partial` with `started === verified === 2` and that reason class.
- `bun run check`.

## Risks and recovery

- First-party `main.js` might still refuse to install webpack on `/robots.txt` after cookies. The receipt will name that evaluation Error.
- If a later environment 403s `/robots.txt` itself, the receipt stays at create-prep and this launch URL must be revisited.

## Execution evidence

- 2026-08-21 — Box confirm `42c33ead-76ad-47cc-ab48-d2bd8049b5ee` on `b876861` still failed during create-prep after two verified uploads. Cookie-source session launch opened `manifest.origins[0]` before cookies (`src/browser.ts`).
- 2026-08-21 — Same-machine GET `/` and `/robots.txt` returned 200; HEAD `/home` returned 403. Headless cookie-source plus proxy is the remaining first navigation.
