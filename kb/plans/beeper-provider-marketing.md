---
title: Make Beeper and provider support legible across Hraness products
description: Ship release-bound provider marketing for Wrench, Message Like Me, and PeopleBlade without overstating each product's Beeper boundary.
type: plan
area: provider-marketing
status: in-progress
repository_scopes:
  - README.md
  - docs
  - kb/plans/beeper-provider-marketing.md
  - package.json
  - vercel.json
  - bun.lock
  - website
aliases:
  - Beeper consumer marketing
tags:
  - beeper
  - documentation
  - marketing
  - providers
---

# Make Beeper and provider support legible across Hraness products

## Outcome

A visitor can identify Beeper as a current integration from the first public page of Wrench, Message Like Me, or PeopleBlade, then reach an exact explanation of what that integration can and cannot do. Wrench presents its provider catalog as release-bound evidence instead of an unqualified logo wall. Message Like Me presents Beeper as a private history source via Wrench, never as a direct or sending integration. PeopleBlade presents Beeper as a read-only contact and interaction source, never as a messaging client.

The three changes ship in dependency order: Wrench first, then Message Like Me, then PeopleBlade. Each repository passes its complete gate, adversarial review, current-head pull request, required CI, merge, and documented production verification before the next repository begins.

## Context

The integrations already exist, but their public discoverability is uneven.

- Wrench main contains a pinned Beeper CLI 0.6.2 adapter with 32 observed semantic operations. The README and provider attestation explain it, while the homepage names no provider and the provider page makes readers cross a 317-row table before reaching the Beeper explanation.
- Message Like Me v0.4.0 verifies and ingests Wrench's multi-account Beeper bundle. The README is explicit, while the homepage says only “connected accounts” above the fold and its mobile install commands overflow a 390-pixel viewport.
- PeopleBlade v0.14.0 consumes Wrench's earlier reviewed Beeper projection for read-only contacts, optional body-free interaction counts, and bounded identity-search evidence. Its README and provider guide are explicit, while the HTML homepage and About page omit Beeper and disagree with their Markdown projections.
- Wrench main has advanced its Beeper adapter from the released v0.14.0 web-session contract to an unreleased v2 local-CLI contract. Marketing the new contract as the current release requires a new immutable Wrench release before either consumer can name or pin it.

Wrench owns provider contracts and execution boundaries; consuming products own their application semantics and UI, as recorded in [[../notes/repository-seams|Repository seams]]. The README, current guides, executable tests, and this plan retain their separate truth-owning roles under [[../notes/documentation-ownership|Documentation ownership]].

Official competitive material establishes the surrounding market:

- Composio, Pipedream Connect, and Nango lead with hundreds or thousands of integrations, managed authentication, and broad tool execution.
- Arcade leads with per-action authorization, policy, audit, and versioned tools.
- Beeper itself provides an agent-oriented CLI and Desktop API/MCP, so Wrench must explain the narrower execution and evidence boundary it adds rather than claiming it uniquely enables agent access.
- Grammarly, Shortwave, Apple Writing Tools, and autonomous “clone” products make convenience or imitation claims that Message Like Me should reject in favor of contact-specific evidence, provenance, and drafts-only authorship.
- Dex, Clay, Monica, and folk cover personal CRM, relationship automation, self-hosting, and sales workflows. PeopleBlade should distinguish local authority, provenance, reversible identity review, and bounded agent access instead of competing on generic “people intelligence.”

## Scope

### In scope

- Generate Wrench's provider presentation from the same validated adapter attestation that owns provider names, versions, operation states, transports, and limits.
- Put recognizable, accessible provider marks and exact observed-versus-reserved counts near the top of Wrench's homepage and provider directory.
- Add a focused Wrench Beeper page that explains actions, requirements, mutation evidence, exclusions, and every independent version boundary.
- Improve Wrench README and local-CLI provider discovery without duplicating executable contracts.
- Release the merged Wrench package at the next semantic minor version so the website and install instructions describe a real immutable artifact.
- Give Message Like Me a canonical supported-source catalog, first-screen Beeper language, a dedicated Sources page, two honest onboarding paths, and a mobile overflow fix.
- Keep Message Like Me's canonical description and drafts-only, local CLI boundary intact; verify compatibility with the released Wrench bundle coordinate.
- Give PeopleBlade one canonical source catalog consumed by HTML and machine-readable pages, provider-first homepage and About content, and precise Beeper copy.
- Migrate PeopleBlade's exact Wrench/Beeper route identity to the released local-CLI contract with regression fixtures if that release is adopted.
- Validate public pages visually and structurally, including narrow viewports, accessible names, no-JavaScript or machine-readable surfaces where applicable, and HTML/Markdown parity.
- Record adversarial copy and implementation findings in this plan and resolve them before merge.

### Non-goals

- Expanding Wrench beyond its reviewed 32 Beeper operations or exposing the official CLI as a general command runner.
- Adding Beeper sending, reactions, drafts, or account operations to Message Like Me or PeopleBlade.
- Claiming complete history, complete provider catalogs, delivery, endorsement, absolute privacy, or security.
- Turning Wrench's website into an application, Message Like Me into a hosted analyzer, or PeopleBlade into an outbound CRM.
- Replacing the consumers' product-specific source semantics with a shared package before two stable consumers require the same interface.
- Reworking unrelated local Facebook or Telegram changes in the existing PeopleBlade checkout.

## Constraints and decisions

- Support claims use “observed operations” and put inert `capture-required` reservations beside them. A provider with no observed operation cannot appear as ready.
- Wrench presentation data joins strictly to the validated active attestation. A new or removed provider surface fails the site build until its presentation metadata is reviewed.
- Icons aid scanning but never replace visible names or status text. Assets remain local, are decorative to assistive technology, and carry no endorsement claim. Product-owned neutral marks are preferred over copied brand artwork when trademark or provenance is unclear.
- Wrench's Beeper value is its exact executable, account, target, transport, semantic contract, preview, dispatch, and reconciliation boundary around the official CLI. It is not “Beeper for agents,” because Beeper already provides agent surfaces.
- Message Like Me uses “Sources,” not “Integrations,” because it ingests history but does not operate accounts. Its Beeper path always says “via Wrench.”
- PeopleBlade groups sources by semantic mode: local sync, reviewed live connectors, official archives, and honest limits. It calls Google Contacts by its actual name and describes Beeper as read-only.
- Wrench must release before consumers pin or advertise the v2 local-CLI route. The release tag must equal the package version on main, pass the read-only release gate, and produce an immutable Latest GitHub Release.
- Repository writes occur in clean worktrees from current remote main. Existing dirty or untracked work in primary checkouts remains untouched.
- Public copy follows each repository's prose contract and passes the swap test: every line names a product-specific, observable behavior.

## Plan

1. Freeze the cross-product claim matrix and adversarial gate from current remote code, public pages, official Beeper documentation, and official competitive sources.
2. Implement the Wrench provider presentation model, homepage directory, focused Beeper page, provider-directory restructuring, discovery copy, tests, and next minor release identity.
3. Run Wrench's complete gate and fresh adversarial review; merge through a current-head pull request, tag the verified main commit, and verify the immutable Latest release and production documentation.
4. Implement Message Like Me's canonical source model, homepage and Sources page, README/discovery updates, responsive fix, and Wrench-release compatibility wording.
5. Run Message Like Me's root and site gates, preview it through the existing Sites project, complete fresh adversarial review, merge through its required workflow, publish, and verify the production site.
6. Implement PeopleBlade's canonical source model and public page parity. If adopting the new Wrench release, migrate the Beeper route to adapter v2/local-CLI receipts while preserving the read-only application boundary.
7. Run PeopleBlade's full check and browser gate, complete fresh adversarial review, merge through its required workflow, deploy to production, and verify visible HTML and machine-readable Markdown parity.
8. Re-audit all three live products as one journey, resolve inconsistent names or claims, complete this plan, and promote only reusable conclusions to their maintained owner.

## Verification

- Provider cards cannot drift from Wrench manifests → strict attestation-to-presentation join tests and `bun run website:check`.
- Wrench release claims describe an installable artifact → package/tag equality, `bun run check`, Required CI, immutable GitHub Release, and live route checks.
- Beeper scope is exact → public tests require the pinned CLI, 32 observed operations, preview/confirm mutation language, and exclusions; tests reject generic CLI or complete-history claims.
- Message Like Me names Beeper without implying direct access → source-catalog tests, page tests, README generation, root `bun run check`, and site `bun run check`.
- Message Like Me is usable at narrow widths → local preview at 390 pixels with document width no greater than viewport width and command-local overflow where necessary.
- PeopleBlade HTML and Markdown agree → both derive from one catalog and parity tests assert Beeper, LinkedIn, Google Contacts, source state, and limitations.
- PeopleBlade remains read-only over Beeper → route/receipt fixtures and tests prove only contact projections, body-free counts, and staged search evidence are accepted.
- No product claims endorsement or impossible guarantees → fresh adversarial copy review against the checklist below before each merge.

## Adversarial review gate

Reject any change that:

- turns observed and reserved operations into one undifferentiated integration count;
- says Wrench wraps “all Beeper CLI features,” “all chats,” or delivered messages;
- collapses adapter, semantic contract, CLI, executable digest, Desktop target, or API revision into one version;
- implies Beeper or another provider endorses any Hraness product;
- calls Message Like Me a clone, twin, autonomous representative, direct Beeper client, or sender;
- says Message Like Me analyzes every message or that style evidence preserves meaning, facts, consent, or authorship;
- calls PeopleBlade a generic “people intelligence” system, says Gmail instead of Google Contacts, or implies it reads or sends Beeper message bodies;
- presents blocked Telegram or live X routes as ready;
- says data never leaves a device despite requested provider work, an external agent, optional enrichment, or optional cloud projection;
- substitutes “safe,” “secure,” “seamless,” “powerful,” or “production-ready” for an observable control;
- invents social proof, completion percentages, partner status, or breadth comparisons that cannot be reproduced.

## Risks and recovery

- A provider card overstates a partially observed adapter → generate state from the attestation and fail closed on unmatched presentation metadata.
- Brand marks create endorsement or licensing ambiguity → use local neutral marks with visible names and a non-endorsement note; remove a mark without affecting meaning.
- Wrench's release races another main change → refresh the branch and rerun the complete gate immediately before the current-head pull request and tag.
- A consumer cannot adopt the new Wrench route without widening its authority → retain its current immutable pin and market only the current read-only boundary; do not expose mutation operations.
- Generated pages diverge from authored data → make generation deterministic, check generated artifacts in the owning repository, and fail CI on drift.
- Deployment differs from the verified build → use each repository's documented hosting path, verify the deployed revision and canonical routes, and roll back through the host's prior immutable deployment if production checks fail.

## Execution evidence

- 2026-08-27 — Audited current `origin/main` for all three repositories in parallel. Confirmed real Beeper support in README, docs, skills, commands, and strict contracts; confirmed homepage discovery gaps in every product.
- 2026-08-27 — Loaded Wrench's release-bound attestation: 317 operations across 21 adapters, 128 observed and 189 capture-required; Beeper adapter 2.0.0 contributes 32 observed operations over the pinned local CLI.
- 2026-08-27 — Reviewed official positioning from Beeper, Composio, Pipedream, Nango, Arcade, Grammarly, Shortwave, Apple, Dex, Clay, Monica, and folk. Chose exactness, local custody, provenance, and bounded authority over catalog-size or imitation claims.
- 2026-08-27 — Found release dependency: Wrench main's Beeper adapter v2 is newer than tag v0.14.0, while PeopleBlade pins v0.14.0 and its v1.1 web-session receipt identity. Sequenced release and consumer compatibility work accordingly.
- 2026-08-27 — Implemented Wrench's strict 19-surface presentation directory from the 21-adapter attestation, with Beeper first, visible observed-versus-reserved counts, neutral accessible icons, and grouped operation tables that remain complete in HTML and Markdown.
- 2026-08-27 — Added the focused Beeper guide, binding page metadata, adapter identity, semantic contract versions, CLI 0.6.2 release URL and four artifact URLs/hashes, Desktop API review revision, and 32-operation count to reviewed source facts instead of independent copy.
- 2026-08-27 — Promoted Wrench to v0.15.0 so the 32-operation Beeper claim can identify a real release rather than the immutable v0.14.0 tag, which contains only five Beeper operations.
- 2026-08-27 — Visually reviewed the Wrench homepage, provider directory, and Beeper guide at 320, 390, 768, 1280, and 1440 pixel widths. Confirmed zero horizontal document overflow, readable one-column provider cards, retained provider navigation, collapsed operation groups, and no browser-console errors.
- 2026-08-27 — Passed the definitive Wrench gate after review fixes: type checks; 35 website and edge tests; site generation; package build and clean-consumer install; 3,164 general runtime/property tests with one documented CI-only timing skip; 18 serialized omni-runtime tests; standalone smoke; and `git diff --check`.

## Review findings

- Pre-implementation finding: the Wrench provider page's exhaustive table precedes the Beeper narrative and is about 120 KB generated HTML. Disposition: add a generated directory and provider explanation before the detailed attestation, then group or defer the exhaustive view without removing static evidence.
- Pre-implementation finding: Message Like Me's 390-pixel page has a 461-pixel document width because install commands refuse to wrap. Disposition: keep overflow local to command panels and add a responsive regression check.
- Pre-implementation finding: PeopleBlade's HTML omits Beeper while its generated Markdown includes it, and the homepage labels Google Contacts as Gmail. Disposition: derive both from one source catalog and test parity.
- Wrench review finding: the initial presentation encoded adapter ID and version as one `id@version` string and stated Beeper contract version 1 independently. Disposition: retain structured adapter identities, derive the complete semantic contract-version set from attested rows, and render release metadata from one fact model with drift tests.
- Wrench review finding: the initial provider copy implied every Beeper mutation had exact reconciliation. Disposition: state that every mutation retains preview, confirmation, durable dispatch, and at-most-once evidence; exact reconciliation exists only where separately reviewed readback is available, while other indeterminate mutations remain fenced and unretried.
- Wrench review finding: the README called all 19 entries “support” even though Facebook Pages is reservation-only. Disposition: call it a provider catalog, state that 18 surfaces have observed operations, and identify Facebook Pages as zero-executable rather than treating presence as a support badge.
- Wrench review finding: operation-table scroll regions lacked adapter-specific names, the Beeper parent-nav link used the wrong current-page state, and Markdown concatenated adapter IDs with versions. Disposition: add exact region labels, use `aria-current="location"`, and retain a literal generated separator with regression coverage.
- Wrench review finding: setup copy named neither the versioned executable coordinate nor every upstream artifact, and the release target URL was initially literal. Disposition: document the default state root and exact tool path, link all four reviewed assets, derive the release URL from `BEEPER_CLI_PIN`, and test the built link.
- Final Wrench adversarial review: no remaining findings or scope creep after the corrections above.
