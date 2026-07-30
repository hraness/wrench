# Contents

- `src/` – the CLI, strict data and protocol models, provider-plugin kernel, built-in providers, runtime assets, helpers, and colocated tests.
- `skills/wrench/` – the packaged Agent Skill and focused operational references.
- `docs/` – provider-plugin authoring and trust-boundary guidance.
- `scripts/` – standalone CLI, plugin lifecycle, and clean-consumer package verification.
- `.github/workflows/` – read-only Linux and macOS checks plus checks-gated immutable releases.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` – usage, project policy, security reporting, and terms.
- `package.json`, `bunfig.toml`, `tsconfig.json`, and `bun.lock` – the standalone Bun package, isolated dependency layout, and frozen dependency graph.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change.
- Keep the package root import side-effect-free. Importing `@hraness/wrench` must not start the CLI, inspect local state, load built-in providers, or access the network.
- Expose bounded semantic operations, never caller-selected requests, endpoints, headers, cookies, selectors, scripts, shell commands, or arbitrary file access.
- Treat source plugins as trusted in-process code. Treat portable child-process execution as ordinary-failure containment, not a hostile-code sandbox, and require an explicit trust decision for the exact verified bundle.
- Parse every foreign manifest, package, message, plan, receipt, response, and CLI value from `unknown`; reject extra fields, malformed bounds, ambiguous ownership, and drift.
- Keep installed support discoverable from the validated active catalog. Reject duplicate plugin, route, or operation ownership before a command can use it.
- Keep built-in durable contract hashes versioned and invariant across package layout and execution environment, while checking the exact current source/dependency closure as a separate runtime-integrity boundary. Portable-plugin identity must remain bound to its exact verified artifact.
- Bind every authenticated request to one exact account realm, provider target, transport, contract version, and implementation identity. Never silently switch transport.
- Keep mutations behind exact preview, confirmation, durable dispatch, and at-most-once evidence. Never retry or clear an indeterminate dispatch; reconcile it from separately obtained exact evidence.
- Keep raw authenticated traffic, cookies, tokens, profiles, private content, and local paths out of Git, tests, receipts, logs, and diagnostics.
- Pair concrete behavior with deterministic example tests. Add property tests for strict parsers, canonical encodings, identifiers, ordering, round trips, lifecycle transitions, and arbitrary input.
- Keep the Bun runner timeout and concurrency policy in `package.json`; test bodies may own explicit product deadlines and elapsed assertions, but must not call `setDefaultTimeout` or pass per-test runner timeouts.
- Treat this repository as the complete project. Use only its public names, paths, commands, and dependencies in code, tests, documentation, and Git prose.
- Treat a `v*` tag as a release request. Keep it equal to `v<package.json version>` on `main`, wait for the read-only gate, and verify the resulting GitHub Release is non-draft, immutable, and Latest before creating another tag.
