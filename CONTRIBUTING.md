# Contributing to Wrench

Issues and focused pull requests are welcome. Open an issue before changing a
durable wire format, trust boundary, confirmation rule, or compatibility
contract so the required migration and evidence can be agreed first.

Use Bun 1.3.14 and run the complete standalone gate:

```sh
bun install --frozen-lockfile
bun run check
```

Provider changes must keep semantic operations separate from transport
mechanics. Add deterministic tests for strict parsing, account and target
binding, request construction, response projection, drift, cancellation,
redaction, and recovery. A new mutation also needs preview-digest,
at-most-once, indeterminate-result, and reconciliation evidence. Keep an
operation `capture-required` until the exact current contract is proved.

Portable-plugin changes must preserve static validation before code execution,
content-addressed packages, explicit code trust, denied-by-default host
capabilities, exact-origin HTTPS, opaque credential sinks, bounded files and
state, serialized lifecycle transitions, and immutable run identity. Include a
secret-free fixture for each executable operation.

Do not include cookies, tokens, authenticated HAR values, browser profiles,
private messages, local state, real account identifiers, or unredacted provider
responses in fixtures, issues, logs, or pull requests. Networked acceptance
tests must be explicit and must not require contributor credentials.
