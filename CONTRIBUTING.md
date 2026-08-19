# Contributing to Wrench

Issues and focused pull requests are welcome. Open an issue before changing a
durable wire format, trust boundary, confirmation rule, or compatibility
contract so the required migration and evidence can be agreed first.

Use Bun 1.3.14 and run the complete standalone gate:

```sh
bun install --frozen-lockfile
bun run check
```

For parallel chats or other concurrent local work, follow the
[isolated worktree workflow](docs/local-development.md). It keeps changing
source and development state separate from the stable Wrench installation.

Provider changes must keep semantic operations separate from transport
mechanics. Add deterministic tests for strict parsing, account and target
binding, request construction, response projection, drift, cancellation,
redaction, and recovery. A new mutation also needs preview-digest,
at-most-once, indeterminate-result, and reconciliation evidence. Keep an
operation `capture-required` until the exact current contract is proved.

Media changes must preserve the one-item, finite, non-DRM source boundary and
must never add an access-control bypass. Keep acquisition output staged until
the complete artifact contract, manifest, and SHA-256 records verify. Add
deterministic coverage for parsing, direct and provider acquisition,
derivation, transcripts, revision history, locking, cancellation, and
full-item verification.

Portable-plugin changes must preserve static validation before code execution,
content-addressed packages, explicit code trust, denied-by-default host
capabilities, exact-origin HTTPS, opaque credential sinks, bounded files and
state, serialized lifecycle transitions, and immutable run identity. Include a
secret-free fixture for each executable operation.

Built-in source plugins retain a separate exact source/dependency closure
check. Wrench derives that identity from the current tree, snapshots it at
registry startup, and revalidates it immediately before and after lazy runtime
load. There is no manual closure allowlist or hash-approval step: durable
contract identity remains the reviewed semantic boundary, while automatic
closure revalidation catches ordinary source or dependency drift. Released and
development commands must never ask an operator or maintainer to approve source
hashes.

Do not include cookies, tokens, authenticated HAR values, browser profiles,
private messages, local state, real account identifiers, or unredacted provider
responses in fixtures, issues, logs, or pull requests. Networked acceptance
tests must be explicit and must not require contributor credentials.
