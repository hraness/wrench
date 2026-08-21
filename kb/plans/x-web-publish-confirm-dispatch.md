---
title: x-web posts.publish confirm dispatch
description: Confirm can dispatch x-web posts.publish against the matching kernel contract, and adapter sync cannot keep a kernel-invalid manifest.
type: plan
area: x-web
status: completed
repository_scopes:
  - src/providers/x-web.ts
  - src/providers/x-web-runtime.ts
  - src/scripts/sync-bundled-adapters.ts
tags:
  - x-web
  - adapters
---

# x-web posts.publish confirm dispatch

## Outcome

`x-web` `posts.publish` confirm can cross the dispatch boundary against the matching installed contract, using fixtures. Bundled adapter sync replaces a kernel-invalid installed manifest instead of leaving it in place.

## Context

Two production confirms on 2026-08-21 failed before dispatch (`dispatchStarted: false`, `finalOrigin: null`) with:

`authenticated web API operation failed before the dispatch boundary; reason: X post dispatch failed before a response-bound result was verified`

Preview had already planned `x-web` 1.7.0 / `posts.publish@2`. The same box had earlier hosted a 1.10.0 data manifest on the 0.10.1 CLI, which made capabilities invalid until `adapter install --force` restored the bundled 1.7.0 schema.

A later isolated preview on the `x-web-video-publish` worktree, run through `scripts/local-dev/run-wrench` with its own `WRENCH_STATE_HOME`, bound the same `x-main` cookie-source realm (subject `896906084014845952`). That checkout's `x-web` 1.10.0 / `posts.publish@4` planned digest `8ce5d7b09f0d190088b80cd562fdd6fa22d4224c1018b80eb013563fe4c07499` with inputHash `0a802a7a…`, the same inputHash as the failed 1.7.0 confirms. Stable 0.10.1 plus forced 1.7.0 still previews and still dies before dispatch. The missing-realm hypothesis is closed. The 1.7.0 kernel's reviewed CreateTweet evidence is stale against current X.

`resolveUniqueXWebBundleDescriptor` treats a changed CreateTweet query ID as drift. The 0.10.1 evidence still named `hIL9XdleMYEtVXOZVbr8Bg`. The current first-party bundle uses `WXTdKnLddrQOunD6MhWi3g` in `main.7792f4fa.js`, observed 2026-08-20. Preview never resolves that live descriptor, so it can plan while confirm fails in about two seconds. The 1.10.0 worktree already records that query ID; its preview success does not require shipping `posts.publish@4`.

`x-web` still registers historical `posts.publish@2`, so a leftover 1.7.0 install remains executable on this kernel. Adapter sync upgrades that archived hash to bundled 1.9.0 / `posts.publish@3`. A separate installer hole remains: `syncBundledAdapters` preserved any installed snapshot the current kernel could not validate, including a future `x-web` 1.10.0 or `linkedin-web` 1.16.0 data manifest left by a newer checkout. [[notes/repository-seams|Repository seams]] keep that kernel contract in this package; a sibling checkout cannot own the installed schema.

## Scope

### In scope

- Refresh the reviewed CreateTweet query ID and source chunk.
- Return the exact pre-dispatch failure reason from `executePublish`.
- Replace kernel-invalid installed manifests with the bundled contract during adapter sync.

### Non-goals

- Live X posting or treating a live X confirm as the test.
- Video / `posts.publish@4` work from `codex/x-web-video-publish`.
- Making archived `posts.publish@2` a current executable contract.
- Globally linking a dirty checkout over the stable binary.

## Constraints and decisions

- Keep bounded-provider rules: no raw HTTP client, composer clicking, or cookie scraping.
- Do not print or commit cookies, tokens, or live session material.
- Query IDs stay revision evidence. Dispatch still resolves the current bundle and rejects drift instead of adopting a new ID silently.
- Fix the installer pattern for every bundled adapter, not only X.
- Ship the matching current kernel pair: `x-web` 1.9.0 / `posts.publish@3` plus the 2026-08-20 CreateTweet evidence. Historical `posts.publish@2` stays executable on that same CreateTweet path. Adapter sync upgrades leftover 1.7.0 and replaces a future 1.10.0 / `posts.publish@4` install.

## Plan

1. Record the current CreateTweet evidence and fixture the matching confirm path.
2. Surface query-ID drift and other pre-dispatch causes in the failed receipt.
3. Change bundled adapter sync so an installed manifest that fails kernel validation is replaced, while a still-valid user-edited manifest remains preserved.

## Verification

- Fixture confirm of `posts.publish@2` and `posts.publish@3` starts and verifies one CreateTweet dispatch.
- A stale CreateTweet query ID fails before dispatch with `query-ID drift` and no POST.
- Adapter sync replaces future `x-web` and `linkedin-web` contracts and keeps a valid user-edited official `x` manifest.
- Adapter sync upgrades a leftover archived `x-web` 1.7.0 / `posts.publish@2` install to the bundled current contract.
- `bun run check`.

## Risks and recovery

- X can rotate CreateTweet again. The receipt must name query-ID drift so the next refresh is obvious.
- Replacing an invalid installed manifest drops a newer checkout's data schema. That schema was already unusable on the current kernel.

## Execution evidence

- 2026-08-21 — Fixture confirm of `posts.publish@2` and `posts.publish@3` starts and verifies CreateTweet. A stale query ID fails before dispatch with `query-ID drift` and no POST (`src/providers/x-web-runtime.internal.test.ts`).
- 2026-08-21 — Adapter sync replaces future `x-web` `posts.publish@4` and `linkedin-web` `articles.draft.save@8` data manifests, and still preserves a valid user-edited official `x` 9.9.9 manifest (`src/scripts/sync-bundled-adapters.test.ts`).
- 2026-08-21 — Isolated `x-web-video-publish` preview of `posts.publish@4` bound the same `x-main` realm and reused inputHash `0a802a7a…`. Stable 0.10.1 plus forced 1.7.0 still fails confirm before dispatch. Adapter sync upgrades leftover archived `x-web` 1.7.0 to the bundled current contract (`src/scripts/sync-bundled-adapters.test.ts`).

## Result

Confirm died after viewer binding because the reviewed CreateTweet query ID had drifted. The later isolated 1.10.0 preview reused the same inputHash against the same `x-main` realm, so the broken path is the 1.7.0 kernel evidence against current X. The kernel now records `WXTdKnLddrQOunD6MhWi3g` for both historical `@2` and current `@3`, and returns that drift in the pre-dispatch receipt. Bundled adapter sync upgrades leftover 1.7.0 and replaces any installed manifest the current kernel cannot execute.

## Durable memory

Query-ID drift stays an exact reviewed-evidence failure in `src/providers/x-web.ts`. Kernel-owned adapter replacement lives in `src/scripts/sync-bundled-adapters.ts`. No extra maintained note was added; the executable contracts own the rule.
