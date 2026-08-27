# Provider plugins

Wrench has two plugin forms with one semantic catalog.

A source plugin ships with Wrench, loads in-process, and may implement a
reviewed provider transport. It is trusted application code. A portable plugin
is an independently authored, content-addressed package installed into local
state after an explicit code-trust decision. It runs in a child process through
a versioned, denied-by-default host protocol.

Neither form may redefine the kernel's custody rules. Wrench owns input
resolution, auth selection, risk, preview and confirmation, dispatch journals,
recovery, receipts, bounds, redaction, activation, and lifecycle serialization.
A plugin owns exact provider identity, route and operation descriptors, request
and response contracts, account probes, execution, and reconciliation logic.

A linked-device binding may either own an explicit `inspect`/`pair`/`syncOnce`
lifecycle or attach read-only to an independently managed local source. The
latter must omit the lifecycle declaration and all mutating surfaces. Its auth
locator is established with `wrench auth add ... --linked-device ...
--device-store ...`, then account-bound with `wrench auth bind`; Wrench must not
suggest pairing or syncing a lifecycle the plugin does not declare.

A source plugin may also bind a reviewed native provider client through the
`local-cli` transport. This is an exact, versioned executable mechanism behind
semantic operations, not a generic command runner. The binding records every
supported release artifact digest, and each operation owns a fixed command
template, strict input and output contracts, target and account proof, process
bounds, and mutation lifecycle. Portable protocol v1 cannot request native
process authority. See [local CLI provider transports](local-cli-providers.md)
for the versioning and execution contract.

## Start inert

Create a portable package with one `capture-required` reservation:

```sh
wrench plugin init example-web \
  --display-name "Example" \
  --surface example \
  --origin https://www.example.com \
  --operation feeds.read \
  --output /absolute/private/example-web
```

The result has a strict `wrench-plugin.json`, one self-contained runtime,
secret-free fixtures, and local guidance. `capture-required` means no request
can be planned or executed. It is the correct state until authorized evidence
proves the full contract.

## Prove one operation

Before changing an operation to `observed`, establish all of these facts:

1. One semantic operation name and bounded input schema.
2. One exact transport, origin, route, method, and request shape.
3. One current-account probe and stable subject format.
4. Exact actor, target, response, side effect, and completion projections.
5. Credential material names and their only allowed sinks.
6. Risk, dispatch count, deduplication, retry, and uncertainty behavior.
7. Drift behavior that returns the operation to an inert state.
8. Secret-free fixtures that cover success, rejection, malformed output, and
   any partial or indeterminate mutation outcome.

Do not infer an internal API contract from UI labels, a single route name, or a
structural traffic candidate. Do not add DOM automation as an execution or
recovery fallback.

## Validate and trust separately

```sh
wrench plugin check /absolute/private/example-web --json
wrench plugin test /absolute/private/example-web --trust-code --json
wrench plugin pack /absolute/private/example-web \
  --output /absolute/private/example-web.wrenchplugin --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --json
```

`check` parses and validates without running plugin code. `test` is the first
code-execution boundary and requires an explicit trust flag. `pack` verifies
the fixed file set and produces reproducible bytes. `install` records trust for
that exact identity and activates it only after catalog conflict checks.

Updates, disable, and removal serialize with invocation leases, confirmations,
run journals, recovery capsules, and linked-device lifecycles. Wrench refuses a
transition while the old bundle still owns live or unknown work.

## Host capabilities

Portable code receives only the capabilities declared by its verified package:

- exact-origin HTTPS with bounded request and response bodies;
- opaque cookie material bound only to a cookie jar and OAuth material bound
  only to the Authorization header;
- content-bound file handles with bounded reads;
- namespaced JSON state;
- bounded diagnostic messages;
- explicit mutation dispatch begin and verify steps; and
- declared session material handles.

Namespaced state supports exact-byte compare-and-exchange. A plugin opts in by
reading with `includeVersion: true`, then supplies that returned version to
`state.write` or `state.delete`. Legacy unversioned V1 state operations remain
available for compatibility, but new plugins should use the versioned form
whenever an invocation can overlap another invocation.

It receives no shell, package manager, ambient environment, raw auth locator,
unrestricted filesystem, arbitrary redirect, automatic retry, or caller-chosen
network primitive. Native code and undeclared module imports are rejected.

## Protocol and public types

The package root exports bounded identifier and version validators plus the
types needed to describe source plugins and portable protocol messages. The
root is intentionally side-effect-free. Use CLI `plugin check` as the
authoritative validation of a complete authoring directory and
`plugin test --trust-code` as the explicit runtime boundary.
