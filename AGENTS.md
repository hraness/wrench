<!-- kb:context scopes/repository--cdb4ee2aea69 -->
# Contents

- `src/` – the CLI, page-capture runtime, strict data and protocol models, provider-plugin kernel, built-in providers, runtime assets, helpers, and colocated tests.
- `src/media/` – the finite-item media acquisition, archive, derivation, transcript, revision, verification, and cancellation runtime.
- `skills/wrench/` – the single public Agent Skill and its focused operational references, including social publishing.
- `.agents/skills/` – reusable cross-repository KB and phased-execution workflows; product-specific Wrench operations remain under `skills/wrench/`.
- `kb/` – authored repository rationale, evidence, synthesis, and plans.
- `WRITING.md` and `STYLE.md` – internal and public prose contracts.
- `docs/` – provider-plugin authoring and trust-boundary guidance.
- `scripts/` – standalone CLI, plugin lifecycle, and clean-consumer package verification.
- `website/` – the dependency-free, statically generated `wrench.rip` documentation and landing surface; it is excluded from the published package.
- `.github/workflows/` – read-only Linux and macOS checks plus checks-gated immutable releases.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` – usage, project policy, security reporting, and terms.
- `package.json`, `bunfig.toml`, `tsconfig.json`, and `bun.lock` – the standalone Bun package, isolated dependency layout, and frozen dependency graph.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change.
- Follow `WRITING.md` for internal prose and `STYLE.md` for public prose.
- Apply unreasonably robust programming when agent work is cheap. Model invalid states out of existence and pair readable regression examples with property tests for general laws.
- Deliver changes to `main` through a current-head pull request. Keep the stable `Required` CI job green, resolve every review thread, and serialize merges. Human approval stays optional while one regular maintainer would otherwise self-review. Never force-push or bypass the gate.
- Pin Hraness dependencies to reviewed immutable releases or full commits. Never replace them with sibling paths, Git submodules, or coordinated `main` assumptions.
- Extract a shared package only after two concrete consumers need the same stable interface. Keep shared packages product-neutral and keep consumer planning, policy, agent loops, and product UI outside Wrench.
- For UI work, consume shared design-kit or `@hraness/ui` primitives only at immutable versions; keep product composition in the owning product and keep `website/` dependency-free.
- Freeze shared interfaces before parallel lanes begin. Give public barrels, manifests, lockfiles, generated catalogs, and other convergence surfaces one owner while lanes edit disjoint paths.
- Keep mandatory rules in the closest `AGENTS.md`, current procedures in `docs/`, executable contracts in types and tests, and pull-based rationale, evidence, synthesis, and plans in `kb/`.
- Keep Wrench a bring-your-own-agent CLI and TypeScript SDK. Do not add a bundled model, planning or tool loop, agent runtime, application UI, native app, or app template; consumers own those layers.
- Keep exactly one public Agent Skill at `skills/wrench/`. Bundle product workflows as references and mark repository-maintenance skills under `.agents/skills/` internal.
- Keep `website/` informational: it may explain and document Wrench, but must not grow an agent runtime, authenticated product surface, or browser-based substitute for the CLI and SDK.
- Keep the package root import side-effect-free. Importing `@hraness/wrench` must not start the CLI, inspect local state, load built-in providers, or access the network.
- Expose bounded semantic operations, never caller-selected requests, endpoints, headers, cookies, selectors, scripts, shell commands, or arbitrary file access.
- Keep media acquisition to one authorized, accessible, finite, non-DRM item. Reject playlists, live streams, affirmative DRM, unsupported authentication, and access-control bypasses. Promote an item only after its inspectable archive, versioned manifest, and SHA-256 records pass complete verification.
- Treat source plugins as trusted in-process code. Treat portable child-process execution as ordinary-failure containment, not a hostile-code sandbox, and require an explicit trust decision for the exact verified bundle.
- Parse every foreign manifest, package, message, plan, receipt, response, and CLI value from `unknown`; reject extra fields, malformed bounds, ambiguous ownership, and drift.
- Keep installed support discoverable from the validated active catalog. Reject duplicate plugin, route, or operation ownership before a command can use it.
- Keep built-in durable contract hashes versioned and invariant across package layout and execution environment. Derive the exact current source/dependency closure automatically, snapshot it at registry startup, and revalidate it before and after lazy runtime load; do not maintain a manual closure allowlist or ask an end user, provider operator, or maintainer to approve source hashes. Portable-plugin identity must remain bound to its exact verified artifact.
- Bind every authenticated request to one exact account realm, provider target, transport, contract version, and implementation identity. Never silently switch transport.
- Keep mutations behind exact preview, confirmation, durable dispatch, and at-most-once evidence. Never retry or clear an indeterminate dispatch; reconcile it from separately obtained exact evidence.
- Keep raw authenticated traffic, cookies, tokens, profiles, private content, and local paths out of Git, tests, receipts, logs, and diagnostics.
- Pair concrete behavior with deterministic example tests. Add property tests for strict parsers, canonical encodings, identifiers, ordering, round trips, lifecycle transitions, and arbitrary input.
- Keep the Bun runner timeout and concurrency policy in `package.json`; test bodies may own explicit product deadlines and elapsed assertions, but must not call `setDefaultTimeout` or pass per-test runner timeouts.
- Treat this repository as the complete project. Use only its public names, paths, commands, and dependencies in code, tests, documentation, and Git prose.
- Treat a `v*` tag as a release request. Keep it equal to `v<package.json version>` on `main`, wait for the read-only gate, and verify the resulting GitHub Release is non-draft, immutable, and Latest before creating another tag.
