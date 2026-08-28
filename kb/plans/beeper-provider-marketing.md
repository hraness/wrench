---
title: Make Beeper and provider support legible across Hraness products
description: Ship release-bound provider marketing for Wrench, Message Like Me, and PeopleBlade without overstating each product's Beeper boundary.
type: plan
area: provider-marketing
status: completed
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
- Replace Wrench's initial dense, icon-led directory with a minimal editorial surface patterned after Atet: serif display headings, thin rules, restrained color, compact installation, and no decorative provider chrome.
- Project only executable provider actions into Wrench's public support directory. Keep the complete observed-versus-reserved ledger in checked internal attestation code and technical documentation, but do not make those implementation states the visitor's navigation model.
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

- Superseded public-presentation decision: the first Wrench directory put “observed operations” and inert `capture-required` reservations beside every provider. User review found those contract-state terms confusing and too implementation-oriented. The public directory now lists only supported executable actions and omits a surface with no such action. The validated attestation, CLI capability output, security model, and plugin-authoring documentation retain the exact states.
- Do not publish a provider coverage percentage. A reservation is not support, and hiding one from the public directory is not a coverage gain. Count a gain only when exact request, response, account, actor, target, projection, and drift evidence promote the operation through the existing executable contract boundary.
- Wrench presentation data joins strictly to the validated active attestation. A new or removed provider surface fails the site build until its presentation metadata is reviewed.
- Superseded Wrench icon decision: neutral marks aided the first directory, but they added visual weight without improving the action model. The revised Wrench surface uses visible provider names and text only. Other products may retain local decorative marks when they remain useful and do not imply endorsement.
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

- counts an unavailable reservation as provider support, claims a coverage percentage that cannot be reproduced, or treats a filtered row as an implementation gain;
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
- 2026-08-27 — Merged [Wrench PR 63](https://github.com/hraness/wrench/pull/63) at `41b16fcbf9ed0e8d8a332aa380b7187642aac2e3`, tagged that exact main commit as `v0.15.0`, and verified release workflow `33101360984`, an immutable non-draft Latest GitHub Release, and the live homepage, provider directory, Beeper guide, sitemap, and Markdown representation.
- 2026-08-27 — Shipped Message Like Me's canonical four-source catalog, first-screen Beeper positioning, Sources and Docs pages, narrow-command layout, exact Wrench bundle coordinates, and HTML/machine-readable discovery parity through [PR 5](https://github.com/hraness/message-like-me/pull/5). Root validation passed 117 tests; the site passed 11 tests plus lint, typecheck, and build. Merge commit `e594ed41667f290419f3a9072c3b8413dc15bc47` became immutable Latest release `v0.5.1`, and `messagelikeme.com`, `/sources`, `/docs`, the sitemap, and `llms.txt` were verified live.
- 2026-08-27 — Shipped PeopleBlade's canonical source catalog, homepage and About parity, exact read-only Beeper route, explicit `beeper rebind` transition, local-CLI receipt/search provenance, source-incarnation history, and responsive/source metadata through [PR 36](https://github.com/hraness/peopleblade/pull/36). The current-main gate passed lint, typecheck, 495 tests, production build, and the StyleX browser/CSP matrix. Vercel production deployment `6130951969` bound exact merge commit `9a5d859e7d37d8373bb23212256805dd2fccc67b`; all public HTML, Markdown, `llms.txt`, sitemap, and robots routes were verified on `peopleblade.com`.
- 2026-08-27 — Re-audited the three production sites as one journey. Wrench advertises 32 observed read/manage/send operations at Wrench 0.15.0, adapter 2.0.0, and official CLI 0.6.2. Message Like Me accepts only bundle schema 1, source `beeper-local`, and transform 1.1.0 and explicitly never calls Beeper/Wrench or sends. PeopleBlade exposes contacts and candidate search at the generic coordinate, keeps exporter 1.1.0/macOS arm64 interaction counts separate, and explicitly exposes none of Wrench's Beeper mutations. No naming, version, or authority contradiction remained.
- 2026-08-27 — User review rejected Wrench's giant grotesk title, decorative circuit/orbit field, bulky controls, neutral provider icons, and contract-state-led directory as visually heavy and hard to understand. Chose Atet's editorial system as the concrete reference: Nebula Sans body copy, system serif display headings, thin rules, low-radius panels, restrained amber labels, and a two-column install-first hero.
- 2026-08-27 — Re-audited all 317 current source-bound operation rows and all 335 starting registry entries, then challenged every unavailable R1 row against existing exact reads and mutation readbacks. The trust gate accepted two standalone promotions: one current-viewer-owned private X Article draft read and one metadata-only Reddit hosted-video read. That moves the unreleased source snapshot from 128 to 130 executable contracts while 187 reservations remain inert. Retained predecessor identities bring the active registry to 337 entries: 137 observed and 200 capture-required.
- 2026-08-27 — Prepared the revised Wrench presentation as unreleased source work. The homepage now leads with a compact two-column install surface, the provider directory renders all and only the 18 services with executable actions, and the public copy contains neither `observed` nor `capture-required`. Reviewed the generated homepage and directory at desktop and 390-pixel widths, confirmed no horizontal overflow, and replaced the social preview with a matching 1200-by-630 editorial image. No package version, tag, publication, or release is assigned by this work.
- 2026-08-27 — Exercised the new website, provider contracts, registry parity, version surfaces, generated package, and clean-consumer install. A long repository run exposed one unrelated macOS child-process denial while reading `kern.boottime`; the unchanged complete derivation file then passed 173 of 173 tests and the exact reused-PID case passed 10 of 10 with the required process access. No lifecycle code change was warranted.

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
- Message Like Me review finding: the original homepage hid its source identities behind generic “connected accounts” language and allowed install commands to widen the mobile document. Disposition: lead with the exact source set, add a canonical Sources page, keep overflow inside command panels, and make the Beeper-via-Wrench boundary and two-step producer/verifier handoff explicit. Final review found no remaining copy, responsive, discovery, or scope issue.
- PeopleBlade marketing review finding: early drafts used generic CRM language, an insufficiently marked example record, private-repository setup links, broad platform claims, and route metadata/JSON-LD that did not distinguish implemented from blocked paths. Disposition: lead with the authoritative local SQLite graph, label the output illustrative, state that the local CLI is not publicly distributed, remove private links, generate route-specific metadata, and list only the eight implemented paths in structured data.
- PeopleBlade accessibility and responsive review finding: the header note collided between mobile and desktop breakpoints, public headers sat inside `main`, and the skip path was incomplete. Disposition: hide the note through 900 pixels, keep it one line from 901 pixels, move shared headers outside `main`, and add the first-link skip target. Final QA covered 320, 390, 561, 768, 900, 901, 1024, and 1440 pixels in both themes with no overflow or unnamed controls.
- PeopleBlade implementation review finding: a straightforward identity-row update was not enough for Wrench 0.15.0's strengthened Beeper target. Disposition: add append-only source-binding incarnations and one explicit compare-and-swap rebind that proves the prior receipt, exact complete inventory, current identity/state, and new local-CLI contract before transition.
- PeopleBlade database review finding: repeated raw-SQL probes found stale guard snapshots, mutable or replaceable guards, conflict-replacement deletion with recursive triggers disabled, row-ID aliases, and delete/reinsert substitution. Disposition: snapshot and recheck predecessor metadata and inventory, make admitted guards immutable through exact consumption, fence insert/replace collisions, compare every incarnation identity value including the row ID on all updates, and regress `id`, `rowid`, `UPDATE OR REPLACE`, stale-state, authority, chronology, and rollback paths. Two independent final reviews found no remaining commit-time invariant violation.
- Post-implementation user review: the complete 317-row ledger was technically exact but made provider discovery read like an implementation audit. Disposition: keep the ledger as checked source and CLI truth; render only executable actions, access methods, and provider names on the public support page, omit zero-action Facebook Pages, and leave exact state terminology to technical security and authoring contexts.
- Coverage review: relabeling or filtering unsupported rows would create false support. An initial sibling-readback audit surfaced six possible R1 conversions, but the repository trust gate accepted only X `articles.read@2` and Reddit `media.read@2`. It rejected LinkedIn Article reads, Threads post/media reads, and Marketplace media reads because retained implementation seams or stale evidence do not independently authorize new standalone public operations. LinkedIn `posts.read` also remains unavailable because its observed publish readback is only a mutation-parameterized equality oracle with no checked raw response fixture or standalone response projection. Disposition: prepare the two evidence-approved closed projections as unreleased source work and keep all other reservations inert until exact current captures and authorization exist.

## Result

All three consumers name Beeper prominently and truthfully in dependency order. Wrench v0.15.1 remains the current immutable package release; the unreleased Wrench source prepares its minimal supported-action directory and two additional closed R1 reads. Message Like Me v0.5.1 presents Beeper as a verified private history source produced by Wrench, not as a direct client. PeopleBlade presents Beeper as a read-only contact and candidate-search source with a separately versioned, narrower interaction-count exporter, while directing broader messaging and actions back to Wrench.

The earlier Wrench and Message Like Me work produced immutable releases, and PeopleBlade produced an exact-SHA production deployment. This later Wrench provider and website work remains an untagged, unpublished source preparation until its own current-head gate, review, merge, and separately authorized release are complete.

## Durable memory

The reusable conclusion is already owned by [[../notes/repository-seams|Repository seams]] and [[../notes/documentation-ownership|Documentation ownership]]: Wrench owns executable provider capability and version truth, while each consumer owns and tests the smaller application-specific subset it exposes. Wrench's validated attestation and provider presentation now own the operator-facing facts; Message Like Me's source catalog owns its bundle-only history boundary; PeopleBlade's source catalog, provider guide, and source-incarnation schema own its read-only projection and migration boundary. No additional concept note was needed.
