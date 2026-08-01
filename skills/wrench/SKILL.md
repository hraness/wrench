---
name: wrench
description: Use the Wrench CLI to capture or read web content, archive media, inspect installed semantic capabilities, and author, verify, package, install, or operate bounded provider plugins. Use when an agent needs a new site integration without adding raw HTTP, DOM automation, or credentials to its tool surface.
---

# Wrench

Use the installed `wrench` command. Start with `wrench --help`; if it is unavailable, report that the CLI must be installed instead of guessing a source-tree command.

## Choose the smallest path

- Capture a URL: `wrench <url>` or `wrench clip <url>`.
- Read without persistence: `wrench read <url>`.
- Archive media: `wrench archive <url>` or `wrench audio|video|transcript <url>`.
- Inspect support: `wrench plugin list`, `wrench plugin show <id>`, and `wrench capabilities [adapter]`.
- Diagnose state: `wrench operator doctor --json`.
- Invoke a supported semantic operation: `wrench invoke <adapter> <operation>` or its printed shorthand.
- Read a previously validated exact query without a provider roundtrip: repeat the subject-bound R1 invocation with `--cache-only`; omit that flag to revalidate it explicitly.
- Add a provider without changing Wrench source: author a portable plugin.
- Derive a reviewed first-party contract from authorized HAR evidence: follow [the derivation guide](references/derivation.md).

Do not expose raw requests, endpoints, GraphQL, Rest.li, JavaScript, selectors, cookies, headers, storage, arbitrary paths, or unrestricted file transfer. A capability is a bounded semantic operation with an exact transport, origin, account binding, input schema, risk, side effect, and response projection.

## Author a portable provider

Read [provider plugins](references/provider-plugins.md), [the adapter contract](references/adapter-contract.md), and [safety and state](references/safety-and-state.md). Then create an inert package:

```sh
wrench plugin init example-web \
  --display-name "Example" \
  --surface example \
  --origin https://www.example.com \
  --operation feeds.read \
  --output /absolute/private/example-web
```

`init` writes a strict `wrench-plugin.json`, one self-contained Bun runtime, secret-free fixtures, and package-local agent guidance. Its operation starts `capture-required` and network-inert. Keep it that way until authorized evidence proves:

1. the exact HTTPS origin and route;
2. the current-account probe and stable subject binding;
3. the bounded request and credential sinks;
4. accepted status, content type, response projection, and pagination;
5. actor, target, side effect, idempotency, and uncertainty behavior;
6. drift and negative cases without a DOM or transport fallback.

Verify the package in order:

```sh
wrench plugin check /absolute/private/example-web --json
wrench plugin test /absolute/private/example-web --trust-code --json
wrench plugin pack /absolute/private/example-web \
  --output /absolute/private/example-web.wrenchplugin --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --json
wrench capabilities example-web --json
```

`check` is static. `test --trust-code` and `install --trust-code` explicitly authorize execution of the exact verified bundle. Process separation contains ordinary failures but is not a hostile-code sandbox: plugin code still runs as the user's OS account. Never execute an unverified authoring directory or import portable code into the host.

For updates, bind the transition to the installed digest:

```sh
wrench plugin show example-web --json
wrench plugin install /absolute/private/example-web.wrenchplugin \
  --trust-code --expected-current <bundle-sha256> --json
```

Wrench refuses update, disable, or removal while a live invocation, preview, claim, journal, recovery capsule, or linked-device lifecycle owns the bundle. Inspect blockers with `wrench plugin doctor`, `wrench plans list`, and `wrench runs list`.

## Configure one stable auth realm

Store a locator, not copied secrets:

```sh
wrench auth add example-main --cookie-source arc --cookie-profile "Profile 1"
wrench auth bind example-main --site example
wrench auth list --json
```

Use OAuth only for a reviewed `provider-api` plugin. Use browser cookies or a private profile only for a reviewed `web-session-api` plugin. Never silently switch transports. A profile snapshot requires the source browser to be closed and may require `--browser-executable` plus explicit `--trust-profile-egress` because a path-backed browser has no domain-containment boundary.

Treat each auth ID as one stable provider account. Probe and bind the current account before private reads or writes; reject missing, ambiguous, changed, or mismatched identities. Keep tokens, cookies, HAR content, profile state, messages, and attachment paths out of output, logs, receipts, and Git.

## Invoke with the risk boundary intact

Inspect the capability first:

```sh
wrench capabilities example-web --json
wrench example-web feeds.read --input '{"limit":20}' --auth example-main --json
wrench example-web feeds.read --input '{"limit":20}' --auth example-main --cache-only --json
```

- `capture-required` performs no request.
- `R1` is a reviewed read with no intended remote mutation.
- `R2` is one bounded, normally reversible change.
- `R3` is externally visible or consequential.
- `R4` is blocked.

Successful subject-bound R1 reads publish an encrypted exact-query snapshot.
`--cache-only` returns that snapshot and its data revision, validation time,
age, and freshness without opening a browser or provider connection. A normal
R1 invocation is the explicit revalidation path. Do not rewrite cursors,
limits, folders, or targets to manufacture a cache hit, and do not assume that
revalidating a local linked-device projection performs a remote sync.

R2/R3 produce an exact five-minute preview. Review adapter, operation, transport, account, scalar input, attachment hashes, side effect, contract hash, and dispatch schedule, then run the printed `wrench confirm <digest>`. Never retry `pending`, `partial`, or `indeterminate` work. Reconcile from independently observed, secret-free evidence with `wrench runs reconcile`; reconciliation never repeats the original mutation.

## Derive only when a contract is missing

Use a managed derivation to capture the minimum authorized first-party exchange. Seal and inspect the HAR through `wrench derive review`, finish into a private directory, and scaffold one inert operation with `wrench plugin scaffold`. Generic derivation output is evidence, not an executable client. Implement and promote only the exact reviewed contract; never fall back to DOM clicking. See [derivation](references/derivation.md) and [the code-owned scaffold](references/code-owned-provider-scaffold.md).

## Finish with evidence

- Re-run `wrench plugin check` and secret-free fixtures.
- Prove exact origin, method, path, input bounds, response variants, identity binding, redirects, drift, and redaction.
- Exercise only authorized observed operations.
- Verify a `capture-required` operation performs no request.
- Inspect receipts and confirm credentials and payload text are absent.
- Remove managed HARs, profile snapshots, bootstrap state, and plan assets when their lifecycle is complete.
- Forward-test material skill changes with a fresh agent given only this skill and an installed `wrench` command.

interface:
  display_name: "wrench"
  short_description: "Capture sites and build bounded provider plugins"
  default_prompt: "Use $wrench to capture this site or add the smallest safe semantic provider capability."
