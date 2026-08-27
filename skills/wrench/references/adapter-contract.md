# Adapter contract

Use a strict, secret-free manifest to select a code-owned semantic operation.
For a signed-in site capability, prefer schema-v4 `webSession`. Use
schema-v6 `localCli` only for an exact source-plugin-owned provider executable.
A manifest never contains a captured request or command line.

## Contents

- [Transport versions](#transport-versions)
- [Manifest identity](#manifest-identity)
- [Semantic operation and input](#semantic-operation-and-input)
- [Schema-v6 local CLI selector](#schema-v6-local-cli-selector)
- [Schema-v4 selector](#schema-v4-selector)
- [Code-owned request template](#code-owned-request-template)
- [Dynamic token boundary](#dynamic-token-boundary)
- [Response and identity binding](#response-and-identity-binding)
- [Risk and dispatch](#risk-and-dispatch)
- [Promotion and drift](#promotion-and-drift)

## Transport versions

- Schema version 6 selects one exact, source-plugin-owned `local-cli` contract.
  Its binding pins the reviewed executable artifacts independently from the
  operation's semantic `contractVersion`. It never exposes argv or a shell.
- Schema version 5 reserves generic-site derivation work only. Version-1 `reviewedTemplate` operations must remain `capture-required`; manifest validation rejects `reviewed`, and neither state supplies an executable request. A future contract version 2 must add a current-account identity preflight and response-scope binding before generic execution can be considered.
- Schema version 4 selects one reviewed first-party authenticated web contract and uses `web-session-api` at runtime.
- Schema version 3 selects one reviewed official `provider-api` contract with OAuth auth.
- Schema version 2 is a retired semantic browser-recipe grammar retained only to diagnose old files. Any schema-v1/v2 DOM operation is install- and runtime-inert: adapter validation, installation, planning, execution, and the direct recipe executor fail closed for every origin. A supported operation must use schema 6, schema 4, or an appropriate schema-3 provider contract.
- Schema version 1 exists only for the exact archived LinkedIn migration fixture.

Never retry or fall back across these transports. A browser may help schema 4 acquire session state or current dynamic material, but it does not execute the semantic action by clicking the site.

## Manifest identity

- Use a lowercase kebab-case `id`, semantic `version`, and short `displayName`.
- Bind a catalogued site with the exact `surfaceId`.
- Declare only exact HTTPS `origins`; reject paths, embedded credentials, local/private hosts, and runtime-discovered origins.
- Keep `browserDomains` limited to hosts needed for capture or bootstrap. It does not authorize an API endpoint.
- Keep cookies, tokens, captured authorization, account-private IDs, messages, HAR values, request templates, and local paths out of the manifest.

## Semantic operation and input

Use canonical outcome names such as:

```text
feeds.read
messaging.list
messaging.read
messaging.send
posts.publish
posts.repost
reactions.set
threads.publish
```

Do not expose `graphql.call`, `voyager.request`, `restli.post`, `selector.click`, or another transport-shaped operation.

Declare bounded typed inputs. Apply exact enums and realistic length, number, array, file-size, and media-type limits. Require every field used by the owned request contract. Keep provider identifiers opaque but syntactically bounded; do not accept an arbitrary URL when a conversation, post, user, or list ID is the actual target.

Bind ordered thread items and attachment bytes into the encrypted plan before preview. The preview may show content hashes, sizes, and detected media types rather than mutable paths.

## Schema-v6 local CLI selector

Each operation selects one installed semantic contract:

```json
{
  "localCli": {
    "surface": "beeper",
    "action": "messaging.send",
    "contractVersion": 1,
    "timeoutMs": 60000,
    "maxOutputBytes": 10485760
  }
}
```

Require `surface` to match `surfaceId`, `action` to match the operation ID, and
risk/input schema to match the code-owned registry. The source-plugin binding,
not the manifest, owns the exact tool identity and fixed command template. The
contract hash binds both, so changing reviewed executable bytes invalidates an
old preview without pretending that an unchanged semantic projection needs a
new `contractVersion`.

Never put an executable path, argument array, environment variable, account
default, target URL, or output path in the manifest. See
[provider plugins](provider-plugins.md) for the source runtime boundary.

## Schema-v4 selector

Each operation contains one selector with no request surface:

```json
{
  "webSession": {
    "site": "x",
    "action": "posts.publish",
    "contractVersion": 1,
    "timeoutMs": 60000,
    "maxOutputBytes": 2097152
  }
}
```

Require `site` to match `surfaceId`, `action` to match the operation ID, and risk/input schema to match the code-owned registry. Store the contract hash in previews and receipts. Reject a stale confirmation after any contract change.

The registry uses two public states:

- `observed`: reviewed evidence and an installed runtime contract exist for the exact version.
- `capture-required`: the semantic operation is reserved, but one or more exact exchange facts are missing or stale. Perform no request and expose no browser fallback.

Do not treat `capture-required` as degraded support.

## Code-owned request template

Keep the first-party exchange in owned TypeScript or another reviewed executable module. Bind:

- one exact HTTPS origin;
- one fixed method from the reviewed set;
- an origin-relative path made from fixed segments and individually encoded typed inputs;
- fixed query names and scalar/JSON encodings;
- a fixed JSON, form, or empty body structure;
- fixed non-credential headers;
- cookie acquisition through the auth layer;
- explicitly allowed dynamic credential sources and sinks;
- one bounded response contract.

Reject redirects rather than inheriting credentials across locations. Reject unknown methods, origins, paths, query parameters, body fields, headers, or response variants. Never add an arbitrary request, header, raw GraphQL, or templated URL escape hatch.

## Dynamic token boundary

Resolve a current value only when the contract names its source and sink:

- CSRF/XSRF may come from one exact cookie, meta field, or local/session-storage key and terminate only in one fixed CSRF/XSRF header.
- Authorization may come from one exact storage key or a captured authorization header and terminate only in `authorization`.
- Registered-query revisions may be discovered from current first-party assets or capture metadata by exact operation prefix; require one unique bounded match.

Keep values in memory and out of plans, receipts, logs, URLs, bodies, and normalized output. Reject literals in credential-bearing headers. Reject source/sink mismatch, duplicate cookie values, malformed encoding, missing browser bootstrap, and ambiguous revisions.

## Response and identity binding

Declare exact successful status and content-type pairs. Bound response bytes before parsing. For JSON, project only named, typed paths and reject required-path or type drift.

Add strict response bindings for every field needed to prevent confused-deputy behavior:

- requested conversation, post, comment, user, list, or article identity;
- requested desired state or created content identity;
- actor identity for a mutation;
- created parent/root relationships for replies, reposts, or threads.

Bind the auth realm separately to the current provider account. Resolve a stable viewer/account ID through a reviewed first-party request, compare it with the realm's expected binding, and fail before private reads or dispatch when missing, ambiguous, or mismatched. Do not infer account identity from a profile path or cookie filename.

## Risk and dispatch

| Risk | Meaning | Execution |
| --- | --- | --- |
| `R1` | Reviewed read with no intended mutation | Direct |
| `R2` | Bounded, normally reversible mutation | Exact preview and digest confirmation |
| `R3` | Externally visible or consequential mutation | Exact preview and digest confirmation |
| `R4` | Sensitive/high-authority action outside this boundary | Blocked |

For R1, use `sideEffect: "none"`, `idempotency: "none"`, and `dedupeWindowMs: 0`. Permit only read methods and explicitly deny observed presence, seen, delivery, read-receipt, badge, and acknowledgement requests.

For R2/R3, describe the remote effect, use `local-at-most-once`, and choose a 60-second-to-30-day dedupe window. Bind the complete dispatch schedule before confirmation. Messages, comments, replies, posts, reposts, quotes, and threads are R3. Likes, bookmarks, reversible reactions, and follows may be R2 when the exact create/delete desired-state contract is captured. One exact authored-item deletion may be R3 only on a reviewed surface that binds current-account ownership, an immutable target/revision, a single delete request, and independent exact absence readback. Credential, access-control, financial, bulk/untargeted deletion, account deletion, and administration actions remain R4.

Mark dispatch durable immediately before the request leaves. Mark verification only after an exact response variant and target/account bindings pass. A timeout or binding failure after dispatch is `indeterminate`; a stopped multi-request schedule after verified earlier effects is `partial`. Never auto-resume either state.

## Promotion and drift

Promote a contract only after:

1. inert HAR evidence identifies the exact first-party exchange;
2. deterministic tests reject all undeclared request and response variations;
3. account, actor, target, and parent bindings are explicit;
4. secrets can reach only their reviewed header sinks;
5. one authorized low-stakes live fixture passes through the public CLI;
6. duplicate refusal and uncertain-result behavior pass;
7. logs, plans, receipts, and temporary state pass a secret scan.

On path, query revision, feature set, token source, request field, status, content type, projection, or binding drift, return `capture-required`. Re-capture and review a new contract version. Do not patch the request from arbitrary live traffic and do not click the DOM instead.
