# Cross-post text and images

Use the installed `wrench` CLI as the only posting transport. Orchestrate provider operations; do not implement a second HTTP client, click a composer at runtime, or treat a browser login as proof that publishing is supported.

## Build one exact post package

Record these values before planning:

- exact text, preserving whitespace and punctuation;
- an ordered optional image package, with one absolute path and optional alt description per image;
- selected platforms;
- explicit provider choices such as LinkedIn visibility or a platform-specific text variant.

Do not truncate text, omit or reorder images, make a collage, split a thread, or rewrite copy to pass a provider limit. Ask for a material content choice when exact parity is impossible. A social Substack target means a public Note; an article or newsletter is a different operation.

If alt text is absent, draft a short factual description from visible image content and include it in the preview summary. Never infer identity, health, ethnicity, relationships, or other sensitive traits from an image.

Give the package a task-local identity. Preserve image order through planning, settlement, duplicate accounting, and any cleanup assessment.

## Preflight every target

1. Run `wrench --help`; if it is unavailable, follow [installation and diagnostics](install.md).
2. Read [social platform routing](social-platform-routing.md).
3. Run `wrench capabilities <adapter> --json` for every candidate adapter. Treat its current operation state and input schema as authoritative over the reference and over remembered platform behavior.
4. Select one exact transport and auth realm per platform. Never switch between a browser-session and official OAuth adapter after planning.
5. Require `posts.publish` to be `observed`, the adapter to be valid, and the auth realm to be bound to its current provider subject. `capture-required` is unavailable, not degraded support.
6. Validate the exact text, ordered image count, bytes, detected media types, alt-field shape, and required scalar fields against each installed input schema before creating any plan.

Map the package only as the installed schema permits: a scalar file gets one path, a file array gets an ordered path array, and aligned accessibility fields retain the same image order. If a provider accepts fewer images, requires an image, or lacks an alt field, report that exact constraint. Obtain an explicit per-provider package choice when parity is impossible; never silently drop, duplicate, merge, convert, or reorder images.

Prefer a target-filtered cookie locator for a signed-in web adapter. Use a profile-backed realm only when the provider contract requires browser storage and the user has accepted that exact broader egress boundary. Bind a new realm with `wrench auth bind <id> --site <surface> --json` before any preview.

If support is missing and the user asked to develop it, use the packaged Wrench derivation workflow with one expressly authorized low-stakes fixture. Bind authorized capture images at derivation start with repeated `--fixture` options and upload only their returned `fixture:<n>` references. Keep the operation `capture-required` until its code-owned request, response, current-account, actor, attachment, returned-object, independent-readback, duplicate, and uncertainty contracts pass. Never post through the capture browser as the installed fallback.

## Preview the complete batch

Construct each input only from its current installed schema. In CLI input JSON, represent a scalar file field as one absolute path string and a file-array field as an ordered array of absolute path strings. Wrench replaces those paths with plan-bound opaque file references and binds immutable attachment bytes, sizes, media types, and hashes into the plan.

Run every target with `--preview --json` before confirming any target. Capability availability is evaluated at preview time and the resulting contract identity is bound into the digest; a later adapter change must not be used to reinterpret that plan or an existing run. Review and summarize:

- adapter, transport, operation, and risk;
- bound account realm and provider subject;
- exact scalar input, without hiding platform-specific variants;
- attachment order, sizes, detected types, and SHA-256 hashes;
- side effect, contract hash, dispatch count, and five-minute expiry.

Cancel superseded or unused plans. If one target cannot be planned, report that target separately; do not weaken the other inputs to manufacture parity.

## Confirm once per platform

Cross-posting is not atomic. Confirm each reviewed digest once with `wrench confirm <digest> --json`. Do not recreate an expired plan without rechecking the post package and authorization.

Classify each result independently:

- `submitted`: record the run and provider-created object evidence, then settle availability through exact readback;
- pre-dispatch `failed`: diagnose safely and create a fresh preview only if the original action remains authorized;
- `pending`, `partial`, or `indeterminate`: preserve the run and use only an advertised, separately reviewed exact readback through `wrench runs reconcile`.

An unsettled target does not create authority to delete or repost on other platforms. Continue with another already-reviewed platform only when its dispatch is independent and still matches the user's requested batch.

## Settle and account for every attempt

Read [settlement and duplicate cleanup](settlement-and-duplicate-cleanup.md) after confirmation. Give every attempt its own immutable ledger entry. Use exact returned locators and exact provider readback; never infer delivery from a cleared composer, a profile search, or matching text.

A duplicate-tolerant action is a materially new intent, not a retry. Permit it only after explicit fresh authorization of the exact platform/package and duplicate risk. In the current v1 workflow, create the new preview with one exact eligible source run via `--duplicate-risk-of <run-id>`; Wrench binds that run to one deterministic successor intent. Keep every other prior uncertain attempt linked separately in the task ledger. Never clear, overwrite, or weaken an old Wrench ledger, receipt, recovery capsule, or attachment bundle.

Assess cleanup only through the installed canonical `content.delete` capability. If it is absent, `capture-required`, or blocked as R4, report cleanup as unavailable. Never use a semantic alias, raw HTTP, composer automation, or a capture session to perform deletion.

## Finish with a platform ledger

Return one row per requested platform and attempt with adapter, auth realm label, plan or run ID, attachment hash summary, terminal state, exact provider locator or public URL when exposed, readback state, and availability timing. Label provider creation time and first independent observation time separately; observation means the post was available no later than that check, not that it became available at that instant. If exact readback never observes it, report availability as unverified even when the provider accepted the mutation.

Keep post text, credentials, cookies, private response bodies, and original local paths out of receipts and diagnostics. Remove task-owned derivations and temporary profile snapshots after verified cleanup; retain evidence needed for unsettled runs.
