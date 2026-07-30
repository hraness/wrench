# Provider plugins

Use a provider plugin when a reviewed official API, first-party web API, or
linked-device protocol needs provider-specific contracts and execution. Wrench has
two distributions over one logical registry:

- a source plugin is reviewed repository code statically assembled into Wrench;
- a portable plugin is a self-contained immutable package that Wrench verifies,
  explicitly trusts, and runs through a bounded child-process protocol.

Neither kind is an installed adapter manifest. Source-plugin adapters remain
parsed local selectors. An enabled portable plugin owns virtual manifests that
the kernel projects from its verified package.

## Inspect the registry

Wrench uses the `wrench` command:

```sh
wrench plugin list
wrench plugin list --json
wrench plugin show <plugin-id>
wrench plugin show <plugin-id> --json
```

The plural `plugins` command is an alias over the same registry:

```sh
wrench plugins list --json
wrench plugins show <plugin-id> --json
```

Use `plugin list` to discover source code available in the current Wrench build and
portable packages enabled in the current `WRENCH_STATE_HOME`. Use `plugin show` to
inspect one plugin's version, source kind, immutable identity or implementation
files, transport bindings, exact surfaces and origins, auth kinds, capability
ceiling, subject format, and versioned semantic operations.

`wrench capabilities` answers a different question. It reports executable or
`capture-required` adapter operations for the current `WRENCH_STATE_HOME`: stored data
manifests resolved through source plugins plus virtual manifests owned by
enabled portable plugins. A source plugin can exist without a corresponding
stored manifest.

Commands that interpret provider ownership or protected origins use the same
active registry: capability and doctor reports, adapter validation and
installation, derivation, auth binding, invocation, confirmation, and
reconciliation cannot disagree about an enabled portable plugin.

## Treat source plugins as trusted code

Source plugins run in Wrench's Bun process. They have the operating-system
authority of that process. TypeScript types, registry validation, and a
`capture-required` contract constrain how the kernel calls a plugin; they do
not isolate the plugin from the filesystem, network, environment, or process.
Review plugin code and every owned implementation file as trusted executable
code.

When `plugin.ts` defines a source plugin, Wrench snapshots every eagerly imported
repository module and every exact installed package tree that could have
contributed a planner, validator, subject matcher, or other function object to
the descriptor. Registry startup must rediscover the same closure and bytes.
This prevents an old evaluated function from being published under a hash of
new source.

The registry separately snapshots each plugin's complete lazy runtime
implementation and dependency identity. Immediately before and after the first
runtime import, Wrench rereads only that owning closure and rejects drift; restart
Wrench after changing source files. These checks protect normal
upgrade/replacement workflows and prevent a changed runtime from reaching an
operation. They are not an atomic sandbox against a same-account writer racing
the module loader: changed top-level module code could run before the
post-import check rejects.

Bare package imports are bound to their exact relocation-stable dependency
graph, not the repository's whole lockfile. Wrench snapshots each installed package
with bounded full-tree walks around its byte reads, hashes the exact paths and
bytes, records required, optional, peer, and statically imported resolution
edges, and revalidates shared startup snapshots before the registry becomes
usable. Unrelated lockfile edits therefore do not invalidate a plugin, while an
entrypoint, undeclared hoisted import, optional dependency, duplicate physical
package occurrence, or package byte change does. Source-plugin package code
must use literal `import()` and `require()` targets so that executable closure
is knowable; an explicitly reviewed built-in exception is code-owned and
identity-bound. Agent-authored code that needs dynamic loading belongs in one
self-contained portable package instead of weakening this boundary.

Source identity also binds the Bun version, `NODE_ENV`, repository package
module semantics, safe `bunfig.toml`, the complete `tsconfig` extends chain,
and the nearest package scope for JavaScript. Wrench must start from the checked
repository root and refuses ambient loader, preload, condition, transform,
working-directory, and tsconfig overrides. Repository modules may use
JavaScript or TypeScript module extensions plus imported JSON or TOML data.
JSX, TSX, custom loaders, URL imports, and computed module targets are rejected
because their executable closure depends on configuration or cannot be known
statically.

`plugin check` reads a bounded fixed file set, parses its data, and syntax-checks
TypeScript without importing the plugin. It proves scaffold shape and
fail-closed reservation state. It does not make later plugin execution safe or
establish that the implementation is trustworthy.

`adapter install` installs a parsed data manifest only. Do not present it as a
code-plugin installer. Wrench never imports portable JavaScript into its process,
executes an authoring directory, runs package lifecycle scripts, or resolves
dependencies from ancestor `node_modules`.

## Author and trust a portable plugin

Create the smallest inert package that reserves one semantic operation:

```sh
wrench plugin init example-web \
  --display-name "Example" \
  --surface example \
  --origin https://www.example.com \
  --operation feeds.read \
  --output /absolute/private/example-web
```

The generated package contains:

- `wrench-plugin.json`, the strict identity, runtime, file inventory, capability
  ceiling, bindings, subject contract, and semantic operations;
- `dist/plugin.mjs`, one self-contained Bun child-process runtime;
- `fixtures/*.json`, bounded secret-free deterministic invocations;
- `AGENTS.md`, package-local authoring and protocol guidance.

It starts `capture-required` and network-inert. An agent may implement it
without editing Wrench, but must still prove the same origin, current-account,
request, response, target, side-effect, uncertainty, and drift facts required
for a source plugin. Then verify the fixed package boundary:

```sh
wrench plugin check /absolute/private/example-web --json
wrench plugin test /absolute/private/example-web --trust-code --json
wrench plugin pack /absolute/private/example-web \
  --output /absolute/private/example-web.wrenchplugin --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --json
```

`check` parses only a bounded canonical file tree without executing package
code and rejects symbolic links,
special files, native code, package-manager state, shells, dynamic module
loading, undeclared files, duplicate current contracts, and authority outside
the declared ceiling. `test --trust-code` binds the explicit execution
decision to the exact verified plugin ID, semantic version, and bundle digest
before running declared secret-free fixtures; its child process is not a
hostile-code sandbox. `pack` publishes verified bytes into a new empty package
directory. `install
--trust-code` records an explicit decision for the exact plugin ID, semantic
version, manifest hash, and bundle hash before enabling it.

Verification is an object-capability boundary, not a structural TypeScript
claim. The catalog accepts only the exact deeply frozen package value returned
by the verifier; a copied object with plausible digests is not verified.
Generic source-registry construction rejects portable projections. The
portable catalog alone asks the kernel runtime builder for child-host wrappers,
freezes each binding, operation descriptor, and runtime-hook container before
recording its package authority, projects virtual manifests, and then extends
an already validated source-only registry. No API can authorize
caller-supplied in-process hooks as portable package code.

The host starts the verified artifact with a minimal environment and exact
protocol, input, output, deadline, and frame bounds. Portable code receives
opaque handles rather than raw auth locators or arbitrary paths. Its optional
authorities are:

- exact-origin, DNS/IP-pinned HTTPS with no credential-bearing redirects;
- declared cookie or OAuth material usable only through its matching request
  sink;
- exact size- and SHA-bound plan-file reads;
- bundle-, adapter-, auth-, and key-namespaced state;
- bounded redacted logging;
- one kernel-bracketed dispatch begin/request/verify sequence for mutations.

Resource owners register teardown before they start. After an operation
terminalizes, Wrench gives the complete cleanup join one separate 30-second bound.
A still-pending or rejected barrier becomes cleanup-unsafe, rejects the
kernel-visible barrier, and preserves a durable retry fence rather than
silently authorizing another run. Portable plugins retain an invocation lease
that blocks the same plugin even if its bundle is replaced. Built-in and source
authenticated-web plugins retain an auth-realm admission keyed by the exact
surface and auth locator; registration durably marks the realm resource-active
before the resource starts. Same-boot cleanup-unsafe state is fail-closed and
visible in `wrench operator doctor`. Wrench permits same-boot recovery only when the browser
close was verified, the exact owner is dead, every retained private root still
matches its durably published device and inode, and identity-bound removal
succeeds. Active commands, forced termination, missing publication, unknown
ownership, changed roots, and generic cleanup failures remain fenced until a
different boot proves that the admitted resource cannot still be running.
After recovery or reboot, run `wrench operator doctor` to retire and report the durable
fence before retrying.

All other capabilities are denied. Process isolation contains ordinary crashes
and dependency mistakes; it is not a hostile-code sandbox for deliberately
malicious code running under the same OS account.

Portable v1 may describe a `linked-device` binding only as a network-inert
`capture-required` reservation. Observed linked-device operations, pairing,
and sync remain source-plugin-only until a portable lifecycle protocol can
preserve the same admission, journal, acknowledgement, and recovery
invariants. Wrench rejects that execution path without transport fallback.

Source linked-device pair, sync, auth replacement, auth removal, and explicit
reconciliation serialize on a realm derived from the provider plus canonical
physical store path, not the mutable auth ID. Consequently two auth aliases or
symlink spellings cannot bypass one another. After a post-boundary crash,
`wrench runs reconcile <journal-id> --input <json>` accepts only an explicit
`applied` or `not-applied` observation with a SHA-256 evidence digest; it never
calls the lifecycle provider or retries the original effect.

An unsettled portable R2/R3 operation uses the same explicit observation
shape:

```json
{"outcome":"applied","evidenceHash":"<sha256>"}
```

Before cleanup, Wrench binds that observation to the immutable receipt, bundle,
manifest, descriptor, auth, input, plan, and encrypted recovery capsule and
publishes a create-once resolution record. Repeating the exact observation is
idempotent; a different outcome or evidence digest is rejected. `applied`
retains the at-most-once ledger. Only `not-applied` releases the ledger for a
new, separately previewed and confirmed attempt, and only when the journal has
no verified dispatch. A verified dispatch permanently retains the fence even
if later plugin work became indeterminate. This reconciliation path does not
start portable code, call a provider, mutate the receipt, or retry a dispatch.

Every operation resolves to an exact immutable identity: plugin ID and
version, host API version, bundle and manifest SHA-256, adapter, transport,
surface, operation, contract version, and descriptor SHA-256. Wrench retains that
identity in plans, receipts, run journals, and encrypted recovery capsules.
Live R1 work also owns an exact process-bound invocation lease.

Updates are compare-and-swap operations:

```sh
wrench plugin install /absolute/private/example-web-v2.wrenchplugin \
  --trust-code --expected-current <old-bundle-sha256>
wrench plugin disable example-web --expected-current <bundle-sha256>
wrench plugin remove example-web --expected-current <bundle-sha256> --yes
```

The catalog lock serializes portable activation, adapter installation,
invocation leases, and confirmation-plan publication. Wrench refuses update,
disable, or removal while the exact old bundle owns a live/unknown invocation,
preview, claim, nonterminal or unreconciled run, recovery capsule, or
linked-device lifecycle. Invalid or unexpected durable state also blocks.
`remove` deletes activation only; immutable artifact and trust evidence remain
available for audit and historical recovery.

Each command observes one validated catalog snapshot. Adapter synchronization
records the installed-plugin fingerprint used to derive its candidate
generation and rechecks that fingerprint while holding the publication lock;
a concurrent plugin activation cannot publish adapters for a mixed catalog.

## Preserve the kernel boundary

The kernel owns authority policy and durable state:

- auth selection, locator loading, and credential-scope validation;
- attachment resolution and content-bound asset bundles;
- risk enforcement, exact preview, digest confirmation, and R4 refusal;
- dispatch scheduling, journaling, at-most-once state, recovery, and receipts;
- output bounds, terminal sanitization, and redaction.

A plugin owns provider-specific meaning:

- plugin identity, exact transport, surface, runtime endpoint, manifest-origin,
  and protected-hostname-family ownership;
- semantic operation contracts, input refinements, and subject format;
- current-account probing and account, actor, and target checks;
- deterministic dispatch planning, execution, and optional reconciliation;
- the complete implementation-source list used for its code identity.

The trusted source-plugin v1 contexts retain compatibility with existing
runtimes: an official-provider executor can receive its selected auth locator,
loaded token material, bounded HTTP client, and resolver-produced local file
paths; web and linked-device runtimes receive their corresponding scoped
context. This does not attenuate the process's authority or isolate secrets
from plugin code. Keep additions transport-specific and narrowly typed; do not
add arbitrary requests or expose unrelated kernel objects. The portable
out-of-process host replaces these values with opaque, bounded host
capabilities. Never fall back between official API, web-session API,
linked-device protocol, and browser behavior.

## Define one binding

Every plugin definition is validated and deeply frozen. Its top level declares
`apiVersion: 1`, a strict kebab-case `id`, semantic `version`, `displayName`,
`sourceKind`, owned implementation sources, and at least one binding.

Each binding declares:

- one `provider-api`, `web-session-api`, or `linked-device` transport;
- a strict kebab-case `surfaceId`;
- the exact code-owned runtime `origin`;
- exact `manifestOrigins` when the public product origin differs from the
  runtime endpoint;
- `protectedHostnameFamilies` that reserve the provider's signed-in hostname
  family from generic browser and reviewed-template adapters;
- accepted auth kinds and one stable, namespaced subject matcher;
- one or more versioned semantic operations;
- a lazy runtime loader. Import provider execution code only inside that
  loader.

An operation declares its active `contractVersion`, any structurally compatible
`historicalContractVersions`, exact risk, bounded input schema, side effect,
idempotency and dedupe policy, observed or capture-required state, dispatch
shape, deterministic planner, and input validator. Optional hooks may bind an
input actor to the auth subject or declare boolean desired-state
reconciliation. A linked-device binding can additionally declare inspect,
pair, and one-shot sync lifecycle support.

`manifestOrigins` and `protectedHostnameFamilies` are different. The first is
the exact public origin set durable manifests must carry for current execution.
The second is a hostname-suffix reservation that also protects sibling API and
asset hosts. For example, a runtime at `api.example.com` and public product at
`www.example.com` normally reserve `example.com`. Avoid an overbroad public
suffix such as `co.uk`.

## Scaffold one source plugin

Start from one sanitized derivation candidate and one semantic operation:

```sh
wrench plugin scaffold \
  --site example \
  --display-name "Example" \
  --origin https://www.example.com \
  --operation feeds.read \
  --risk R1 \
  --evidence /absolute/private/derivation/internal-api-evidence.json \
  --candidate 0 \
  --output src/plugins/example-web \
  --json
```

`wrench adapter scaffold` remains a compatibility alias. New agent workflows
should use `wrench plugin scaffold`.

The scaffold creates one source-plugin directory containing:

- `plugin.ts`;
- `runtime.ts`;
- `plugin.test.ts`;
- `runtime.internal.test.ts`;
- `wrench-adapter.json`;
- `promotion-checklist.json`.

The generated plugin is network-inert and `capture-required`. Scaffolding does
not register it, install its manifest, promote its operation, or authorize a
live request.

## Implement and register the contract

1. Review the sanitized evidence and promotion checklist. Bind the exact
   origin, method, path construction, query or body shape, fixed header sinks,
   response variants, account, actor, target, incidental effects, and output
   bounds in source.
2. Keep the operation `capture-required` while any request, response, identity,
   target, or drift fact is unknown. A type-correct runtime is not evidence.
3. Add deterministic contract and runtime tests for the exact observed
   exchange, malformed input, redirects, response drift, wrong identity,
   output bounds, and secret redaction. Add dispatch and reconciliation cases
   for R2/R3.
4. Check the complete source unit before registration:

   ```sh
   wrench plugin check src/plugins/example-web --json
   bun test src/plugins/example-web
   ```

5. Keep the reviewed directory at `src/plugins/<plugin-id>` and run
   `bun run src/scripts/generate-provider-plugin-catalog.ts`. The generator scans only that source root and
   writes static imports. Do not add runtime directory scanning or load code
   from local state.
   List the plugin and provider entry roots in the implementation-source
   closure. Wrench then resolves and binds every recursive local value dependency,
   so an agent can split JavaScript or TypeScript code into helpers without
   manually maintaining a duplicate file list. Keep installed package loads
   literal and declared when possible. Wrench follows literal undeclared package
   imports defensively, but rejects computed package loads because no
   statically knowable implementation identity can include an unknown target.
   Definitions are bounded before Wrench copies their sources, bindings,
   operations, contract histories, origins, auth kinds, scopes, coverage, or
   input fields.
   Source plugins are trusted repository code, not a hostile-code sandbox;
   use a portable plugin whenever agent-authored code needs dynamic loading or
   process isolation.
6. Inspect the assembled result, then install and inspect the separate data
   manifest:

   ```sh
   wrench plugin show example-web --json
   wrench adapter validate src/plugins/example-web/wrench-adapter.json --json
   wrench adapter install src/plugins/example-web/wrench-adapter.json
   wrench capabilities example-web --json
   ```

Promote an operation to `observed` only after deterministic tests and one
authorized low-stakes fixture prove the exact contract. A plugin update changes
its implementation identity and invalidates stale previews; it does not
reinterpret an unsettled historical receipt.
