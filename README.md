# Wrench

Wrench is a local-first Bun CLI for durable web capture, knowledge context,
verified media archives, and bounded provider plugins.

```sh
wrench https://example.com/article
wrench capabilities
wrench plugin list
```

Project site: [hraness.com/wrench](https://hraness.com/wrench)

## Install

Pin the public repository to the immutable `v0.1.0` tag:

```sh
bun add --global github:hraness/wrench#v0.1.0
wrench doctor
```

Wrench requires Bun 1.3.14. It runs on macOS and Linux. `wrench doctor`
reports capture, media, authentication, provider, plugin, and durable-recovery
readiness. Provider-specific commands remain unavailable until their exact
local dependency and auth contracts are ready.

The public manifest projects each closure-attested package as an exact runtime
dependency. Standalone validation installs without the repository lock, then
verifies the resolved closure versions and reviewed entrypoint hashes.

For programmatic plugin types and bounded validators:

```sh
bun add github:hraness/wrench#v0.1.0
```

```ts
import {
  isProviderPluginId,
  isProviderPluginOperationName,
  type ProviderPluginDefinitionV1,
} from "@hraness/wrench"

if (!isProviderPluginId(candidate.id)) {
  throw new Error("invalid plugin ID")
}

const plugin = candidate satisfies ProviderPluginDefinitionV1
void plugin
```

Importing the package root does not start the CLI, inspect local state, or
load provider runtimes.

## Capture and inspect

```sh
wrench URL                         # capture into a Markdown knowledge base
wrench read URL                    # inspect without persistence
wrench archive URL                 # create a verified media archive
wrench audio URL
wrench video URL
wrench transcript URL
wrench context path/to/code        # resolve nearby agent context
wrench search "query"              # search the local knowledge base
wrench doctor --json
```

Wrench captures only material the user is authorized to access. It does not
bypass authentication, payment, access controls, or DRM.

The `doctor --json` response uses `wrench` as its canonical report envelope.
It also emits the structurally identical deprecated `oh` envelope as a frozen
JSON compatibility alias for predecessor consumers. New integrations must use
`wrench`; the two envelopes must never diverge.

## Inspect provider support

```sh
wrench capabilities --json
wrench capabilities x-web --json
wrench plugin list --json
wrench plugin show x-web --json
wrench platforms --json
wrench plugin doctor --json
```

`capabilities` reports the installed semantic operations and their current
contract state. A `capture-required` operation is an inert reservation, not a
partially supported request. Source plugins are trusted in-process code.
Portable plugins run as explicitly trusted child-process code; process
separation contains ordinary failures but is not a hostile-code sandbox.

## Create a portable plugin

An agent can create a private, network-inert starting point without editing
Wrench:

```sh
wrench plugin init example-web \
  --display-name "Example" \
  --surface example \
  --origin https://www.example.com \
  --operation feeds.read \
  --output /absolute/private/example-web

wrench plugin check /absolute/private/example-web --json
wrench plugin test /absolute/private/example-web --trust-code --json
wrench plugin pack /absolute/private/example-web \
  --output /absolute/private/example-web.wrenchplugin --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --json
```

`init` writes a strict `wrench-plugin.json`, a self-contained runtime, inert
operation metadata, secret-free fixtures, and package-local agent guidance.
`check` is static and does not execute plugin code. `test --trust-code` binds
the decision to the verified plugin identity before running its declared
secret-free fixtures. `pack` creates a reproducible content-addressed package.
`install --trust-code` is the separate decision to let that exact package run.

Portable code receives only declared, bounded host capabilities. Network
requests are pinned to declared HTTPS origins; credentials are opaque handles
usable only at declared sinks; files and state are namespaced handles; and
mutations must use the kernel's begin, request, and verify sequence. The host
does not expose a shell, package manager, ambient environment, unrestricted
filesystem, redirect, retry, or arbitrary request primitive.

Read [the plugin guide](docs/plugins.md) before replacing an inert reservation
with an observed contract. The packaged [Wrench Agent Skill](skills/wrench/SKILL.md)
gives coding agents the same workflow and safety boundary.

## Risk and confirmation

- R1 is a reviewed read with no intended remote mutation.
- R2 is one bounded, normally reversible change.
- R3 is an externally visible or consequential change.
- R4 is blocked.

R2 and R3 commands create an exact, short-lived preview. Review its adapter,
transport, account realm, input, attachment hashes, side effect, contract hash,
and complete dispatch schedule, then pass its digest to `wrench confirm`.
After a partial or indeterminate dispatch, Wrench does not retry or switch
transport. The run remains unsettled until exact external evidence supports a
separate reconciliation.

New previews use one environment-neutral durable contract identity. Readers
also accept the exact predecessor identities produced by the standard `test`,
`production`, and `development` modes. They do not accept a wildcard identity
for custom `NODE_ENV` values. Wrench retains unsupported unsettled evidence and
directs the operator to `wrench doctor`, the exact predecessor build, or manual
evidence review. Runtime loading still verifies the current exact source,
dependency, and execution closure separately.

## Develop

```sh
git clone https://github.com/hraness/wrench.git
cd wrench
bun install --frozen-lockfile
bun run check
```

The full gate type-checks, tests, builds, runs the secret-free CLI and portable
plugin lifecycle smoke, then installs and imports the packed package in a clean
consumer. See [CONTRIBUTING.md](CONTRIBUTING.md) for change boundaries.

## License

MIT
