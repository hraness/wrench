---
name: cross-post-with-wrench
description: Preview and publish one exact text post, with optional local images and accessibility text, across any selected combination of X, LinkedIn, Bluesky, Substack Notes, and Threads through Wrench's bounded provider operations. Use when Codex must cross-post social content, check signed-in Wrench realms, adapt one post package to provider-specific schemas without silently changing it, confirm R3 plans, or report per-platform receipts and partial delivery safely.
---

# Cross-post with Wrench

Use the installed `wrench` CLI as the only posting transport. Orchestrate provider operations; do not implement a second HTTP client, click a composer at runtime, or treat a browser login as proof that publishing is supported.

## Build one exact post package

Record these values before planning:

- exact text, preserving whitespace and punctuation;
- ordered absolute image paths and, when supplied, one alt description per image;
- selected platforms;
- explicit provider choices such as LinkedIn visibility or a platform-specific text variant.

Do not truncate text, omit or reorder images, make a collage, split a thread, or rewrite copy to pass a provider limit. Ask for a material content choice when exact parity is impossible. A social Substack target means a public Note; an article or newsletter is a different operation.

If alt text is absent, draft a short factual description from visible image content and include it in the preview summary. Never infer identity, health, ethnicity, relationships, or other sensitive traits from an image.

## Preflight every target

1. Run `wrench --help`; if it is unavailable, report that Wrench must be installed.
2. Read [platform routing](references/platform-routing.md).
3. Run `wrench capabilities <adapter> --json` for every candidate adapter. Treat that installed output as authoritative over the reference.
4. Select one exact transport and auth realm per platform. Never switch between a browser-session and official OAuth adapter after planning.
5. Require `posts.publish` to be `observed`, the adapter to be valid, and the auth realm to be bound to its current provider subject. `capture-required` is unavailable, not degraded support.
6. Validate the exact text, image count, bytes, detected media type, and required scalar fields against each installed input schema before creating any plan.

Prefer a target-filtered cookie locator for a signed-in web adapter. Use a profile-backed realm only when the provider contract requires browser storage and the user has accepted that exact broader egress boundary. Bind a new realm with `wrench auth bind <id> --site <surface> --json` before any preview.

If support is missing and the user asked to develop it, use the packaged Wrench derivation workflow with one expressly authorized low-stakes fixture. Bind authorized capture images at derivation start with repeated `--fixture` options and upload only their returned `fixture:<n>` references. Keep the operation `capture-required` until its code-owned request, response, current-account, actor, attachment, returned-object, independent-readback, duplicate, and uncertainty contracts pass. Never post through the capture browser as the installed fallback.

## Preview the complete batch

Construct each input only from its current installed schema. In CLI input JSON, represent a scalar file field as one absolute path string and a file-array field as an ordered array of absolute path strings. Wrench replaces those paths with plan-bound opaque file references and binds immutable attachment bytes, sizes, media types, and hashes into the plan.

Run every target with `--preview --json` before confirming any target. Review and summarize:

- adapter, transport, operation, and risk;
- bound account realm and provider subject;
- exact scalar input, without hiding platform-specific variants;
- attachment order, sizes, detected types, and SHA-256 hashes;
- side effect, contract hash, dispatch count, and five-minute expiry.

Cancel superseded or unused plans. If one target cannot be planned, report that target separately; do not weaken the other inputs to manufacture parity.

## Confirm once per platform

Cross-posting is not atomic. Confirm each reviewed digest once with `wrench confirm <digest> --json`. Do not recreate an expired plan without rechecking the post package and authorization.

Classify each result independently:

- `submitted`: record the run and provider-created object evidence;
- pre-dispatch `failed`: diagnose safely and create a fresh preview only if the original action remains authorized;
- `pending`, `partial`, or `indeterminate`: preserve the run, never retry or alter copy to evade deduplication, and use only the provider's separately reviewed exact readback through `wrench runs reconcile`.

An unsettled target does not create authority to delete or repost on other platforms. Continue with another already-reviewed platform only when its dispatch is independent and still matches the user's requested batch.

## Finish with a platform ledger

Return one row per requested platform with adapter, auth realm label, plan or run ID, attachment hash summary, terminal state, and provider post identifier or public URL when the bounded response exposes one. Do not claim success from a cleared composer or HTTP status alone.

Keep post text, credentials, cookies, private response bodies, and original local paths out of receipts and diagnostics. Remove task-owned derivations and temporary profile snapshots after verified cleanup; retain evidence needed for unsettled runs.
