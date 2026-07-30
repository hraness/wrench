# Scaffold a provider source plugin

Use the scaffold after a managed derivation has produced
`internal-api-evidence.json`. It turns one explicitly selected, sanitized
candidate into a fail-closed source-plugin unit. It never reads a raw HAR,
copies an endpoint into executable code, replays a request, or generates a
browser action.

Read [provider-plugins.md](provider-plugins.md) first. Source plugins are trusted
code in Wrench's process, not isolated installed extensions.

## Contents

- [Create the scaffold](#create-the-scaffold)
- [Implement the direct contract](#implement-the-direct-contract)
- [Prove promotion](#prove-promotion)

## Create the scaffold

Keep the derivation output private and select one candidate only after reviewing
it with `wrench derive review`:

```sh
wrench plugin scaffold \
  --site example \
  --display-name Example \
  --origin https://www.example.com \
  --operation feeds.read \
  --risk R1 \
  --evidence /absolute/private/capture/internal-api-evidence.json \
  --candidate 0 \
  --output src/plugins/example-web
```

`wrench adapter scaffold` remains a compatibility alias. New workflows should use
`wrench plugin scaffold`.

Use the exact `targetOrigin` and zero-based candidate index from the sanitized
evidence. The script requires a private, regular evidence file, refuses a
pre-existing non-empty output, rejects transport-shaped operation names, and
binds only the sanitized evidence file hash and candidate index into its
checklist. It also enforces the canonical risk for known verbs: reads and lists
are R1, reversible `set` and `save` operations are R2, and externally visible
creation, editing, publishing, sharing, and messaging are R3.

The generated source unit is self-contained:

```text
src/plugins/<site>-web/
├── plugin.ts
├── runtime.ts
├── plugin.test.ts
├── runtime.internal.test.ts
├── wrench-adapter.json
└── promotion-checklist.json
```

Check the inert unit before registering it:

```sh
wrench plugin check src/plugins/example-web --json
bun test src/plugins/example-web
bun run src/scripts/generate-provider-plugin-catalog.ts
```

Every generated operation is `capture-required`. The runtime throws before
cookie acquisition, account bootstrap, or network I/O. The manifest contains a
schema-v4 semantic selector, not a request description. Do not install it until
the plugin is present in the generated static catalog and its exact input schema
replaces the empty placeholder. `plugin check` reads and syntax-checks the fixed
file set without importing it; that check is not a sandbox or code review.

## Implement the direct contract

Replace the fail-closed boundaries one at a time without adding provider
switches to the kernel:

1. Define one `ProviderPluginV1` in `plugin.ts`. Bind the plugin ID, version,
   display name, source kind, transport, site, exact origin, accepted auth
   kinds, subject format and matcher, semantic operation, contract version,
   current-subject probe, executor, and complete implementation-source list.
2. Implement a typed request authorizer in `runtime.ts` that fixes origin, method, path
   structure, query names, body shape, non-secret headers, redirect behavior,
   timeout, and output bound.
3. Acquire only the reviewed auth realm. If a dynamic token or registered
   operation revision is unavoidable, use browser bootstrap only to resolve
   that one value and route it only to its named sink.
4. Implement a reviewed current-account request and compare its stable,
   namespaced provider subject with the bound auth realm before private reads or
   dispatch.
5. Parse foreign responses from `unknown`, require exact success status and
   content type, project bounded semantic fields, and verify target,
   actor/parent, and desired-state bindings.
6. Replace the manifest input placeholder with precise IDs, enums, text,
   attachment, pagination, and count bounds. Never accept arbitrary URLs,
   headers, request bodies, GraphQL, Rest.li, JavaScript, selectors, or cookies.
7. Replace the generated tests with deterministic request, response, identity,
   drift, size, dispatch, and recovery coverage. Keep provider-specific
   behavior inside the plugin unit or its declared implementation sources.
8. Regenerate the static catalog. Use `wrench plugin show <plugin-id> --json` to
   verify registry ownership, then validate and install the separate data
   manifest.

Use direct first-party HTTP for the semantic operation. Agent-browser may
navigate and exercise an authorized fixture during capture, or supply narrowly
reviewed session material at bootstrap. It must not click, type, upload, send,
publish, react, or read the DOM on behalf of the installed operation.

## Prove promotion

Treat `promotion-checklist.json` as review state, not proof by itself. The
scaffold checker requires every proof to remain false because it checks the
initial network-inert reservation. Set no operation to `observed` until all of
these are independently true:

- exact request shape and credential sinks;
- exact response variants and bounded projection;
- current-account, actor, target, and parent bindings;
- explicit exclusion or modeling of incidental acknowledgements;
- deterministic request, response, redirect, drift, mismatch, and size tests;
- durable dispatch and uncertainty behavior for R2/R3;
- one authorized low-stakes live fixture through the public CLI;
- duplicate refusal and independent provider-visible readback for mutations;
- secret scan of plans, receipts, logs, output, and temporary state.

For R1, prove that the request does not emit seen, presence, delivery, badge, or
read acknowledgements. For R2/R3, preview and confirm the exact bounded action
once. If any fact drifts, restore `capture-required` before another request.

After the reviewed source facts have been transferred into
`src/plugins/<plugin-id>`, delete the sanitized derivation output, managed
browser profile, any abandoned derivation, and any duplicate private scaffold.
Never commit raw HARs, profile state, tokens, cookies, captured payloads, or
authenticated DOM.
