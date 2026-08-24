# Authenticated API safety and state

Use this reference before recording signed-in traffic, resolving browser-held secrets, or invoking R2/R3 operations.

## Contents

- [Separate authority from mechanism](#separate-authority-from-mechanism)
- [Bind the authenticated account](#bind-the-authenticated-account)
- [Use persistent reads without changing their meaning](#use-persistent-reads-without-changing-their-meaning)
- [Keep browser authority narrow](#keep-browser-authority-narrow)
- [Constrain first-party HTTP](#constrain-first-party-http)
- [Minimize HAR exposure](#minimize-har-exposure)
- [Interpret execution states](#interpret-execution-states)
- [Reconcile uncertainty](#reconcile-uncertainty)
- [Clean up task-owned state](#clean-up-task-owned-state)

## Separate authority from mechanism

Confirm that the user authorized the exact account, target, and remote effect. An exploratory request to inspect a site or derive a client does not authorize a live mutation.

The five-minute digest binds the installed adapter, code-owned contract hash, transport, exact input, attachment content, auth-realm fingerprint, risk, and complete dispatch schedule. It proves what will run. It does not decide whether the action is wise, lawful, permitted by provider rules, or authorized.

Use disposable or low-stakes fixtures. Keep employment, recruiting, financial, medical, legal, security, and intimate conversations out of pressure tests.

Schema-v5 version-1 reviewed-template manifests are inert derivation reservations, not request authority. Keep every operation `capture-required`; validation rejects `reviewed`, and planning or execution must fail before cookie acquisition, token resolution, or network I/O. Use a code-owned contract for executable operations until a future contract version 2 provides a reviewed current-account preflight and response-scope binding.

## Bind the authenticated account

Treat every auth ID as one stable provider-account realm. A cookie/profile name is not account proof.

After adding a signed-in realm, probe and persist its current stable subject explicitly:

```sh
wrench auth bind linkedin-main --site linkedin
wrench auth bind x-main --site x
```

Before a private read or any dispatch:

1. Resolve the current viewer/account through a reviewed first-party identity request.
2. Require one stable provider ID.
3. Compare it with the realm's expected account binding.
4. For actor-bearing requests, require the request actor to equal that binding.
5. Require the response actor and requested target/parent bindings to match the plan.

Fail before dispatch on a missing, ambiguous, changed, or mismatched identity. Use a new auth ID for a second account. Require an explicit reviewed rebind after a deliberate login change; do not mutate an existing realm silently.

Official OAuth auth is a separate realm and must satisfy its own subject/scope binding. Never fall back between browser-session and OAuth auth.

## Use persistent reads without changing their meaning

A successful subject-bound R1 invocation publishes one encrypted snapshot of
its exact validated input and bounded output. Repeat the same invocation with
`--cache-only` to read it without a browser or provider roundtrip. Omit the flag
to rerun the reviewed R1 contract and publish a newer validation.

Treat the adapter hash, operation, full auth realm, verified subject, validated
input, transport, and exact executable contract as part of the query identity.
Do not drop a cursor, change a limit, expand a folder, or substitute an auth ID
to force a hit. A contract or account change intentionally produces a miss.

Cache freshness is an observation, not provider authority. An unchanged
revalidation advances validation time without fabricating a data revision.
Failed, partial, or indeterminate reads retain the last good snapshot.
Revalidation reruns the selected R1 operation; it does not silently
perform `auth sync`, and it must not introduce acknowledgement or presence
effects outside that operation's reviewed contract.

The separate omni storage class derives a strict shared Conversation, Message,
or Notification only through a provider-owned, versioned materializer. Its
account-lifetime identity includes the adapter, provider plugin closure,
surface, and auth incarnation. Provider pages retain explicit completeness,
membership, cursor, and tombstone evidence. Absence never means deletion
without a complete partition or explicit tombstone. Omni v1 has no
provider-authored write-invalidation tags. Auth-incarnation, materializer, and
plugin implementation identity changes strand the prior normalized
coordinates, while exact-query freshness advances only through explicit
revalidation. A materializer failure records the failed exact data revision and
retains the last good entities as `retained-after-drift`; it must not weaken
parsing or mutate the exact snapshot to make drift disappear.

Auth replacement and removal rotate a durable local lifetime identity before
cleanup. Projection and provider-session ciphertext from an earlier lifetime
must remain unreadable even if identical locator bytes are later recreated.

The projection key is bound to an authenticated store-ownership marker. Wrench
refuses a missing, malformed, or replacement key while projection ciphertext
or that marker remains. If the key is irretrievably lost, remove exactly
`read-projections/`, `omni-read-projections/`, `.projection-encryption-key`, and
`read-projection-control/store-key.json` beneath `WRENCH_STATE_HOME`, retain the
other control records, and rebuild snapshots through live revalidation.

## Keep browser authority narrow

Prefer target-filtered cookies. Use a path-backed private profile snapshot only when capture or a reviewed token source needs storage beyond cookies. Schema-v1/v2 DOM recipes are retired and fail validation, installation, planning, and execution for every origin; the direct browser-recipe executor is disabled as well. Never automate a concurrently running source profile.

Use agent-browser only for:

- rendered capture or HAR recording;
- sign-in/session bootstrap in a task-owned profile;
- cookie acquisition;
- one reviewed meta/storage/captured-header secret source;
- one current registered-operation revision lookup.

Do not use it to click, type, upload, publish, react, or send at runtime for a supported capability. DOM state is neither the operation contract nor its verification result.

Profile mode may have broader public-host egress than filtered cookies. `--trust-profile-egress` acknowledges that exposure; it does not widen allowed API origins or permit private-network access.

## Constrain first-party HTTP

Keep request construction in code. Fix the origin, method, path structure, query names, body shape, headers, timeout, response limit, successful status/content-type pairs, projections, and bindings. Reject redirects.

Send session cookies only to the reviewed exact origin. Send CSRF/XSRF and authorization values only from the reviewed source to the fixed matching header. Keep those values in memory and never return them from the bootstrap helper.

Do not add a generic HTTP, GraphQL, Rest.li, header, or URL interface. A captured endpoint is evidence, not authority. If a contract is absent or drifted, return `capture-required` and perform no request.

## Minimize HAR exposure

- Default to `--content none`.
- Record one operation and one bounded fixture at a time.
- Use mode-`0700` directories and mode-`0600` files.
- Avoid printing or searching raw HAR values in terminal output.
- Finish or discard every managed derivation.
- Delete externally supplied HARs after `wrench derive analyze`.
- Use `wrench derive review` only while the managed HAR is task-owned private state. The first review seals recording, list output exposes only bounded sanitized entry metadata, and `--fixtures -` accepts labeled strings only over stdin without echoing or persisting their values. `--review-origin` may select one canonical exact HTTPS origin only when its hostname was admitted by the immutable `--domains` declaration at derivation start; undeclared origins fail before sealing. Review never searches credential/header/cookie values and cannot replay a request.
- Serialize each derivation from preflight through cleanup with its fixed identity-bound lifecycle gate. Publish an initialization marker as soon as the socket boundary exists, and publish readiness only after HAR capture, final in-origin validation, and exact session-metadata binding. Only `list` and `discard` may inspect unready or post-reboot state; never delete a live helper that could not be closed.
- Treat the local OS account as the filesystem trust boundary. Inode binding, no-follow traversal, and unpredictable quarantine names protect against symlink swaps and accidental or cooperative same-account races; they cannot defend against hostile code already running as the same account, which can mutate `WRENCH_STATE_HOME` and browser state directly. Keep that account and machine trusted.
- Never commit a raw HAR, authenticated DOM, screenshot, profile, cookie file, or storage dump.

Successful finish deletes the managed raw HAR and emits inert structural evidence. Even that evidence can reveal operation names and response field names; review it before publishing.

## Interpret execution states

- `capture-required`: no current reviewed runtime contract exists. No request or browser-action fallback may run.
- `pending`: wrench durably reserved a confirmed action, but no terminal result exists. Reconcile it.
- `succeeded`: an R1 request passed its exact response contract.
- `submitted`: every planned R2/R3 dispatch passed its exact response and target/account bindings.
- `failed`: execution stopped before dispatch. Diagnose and create a fresh preview only if the action remains authorized.
- `partial`: earlier dispatches were verified, but the schedule stopped before completion.
- `indeterminate`: a dispatch started, but its response or binding could not be verified.

Never retry `pending`, `partial`, or `indeterminate` automatically. Do not clear the ledger or change whitespace/metadata to evade duplicate refusal.

`submitted` is stronger than a cleared composer because it requires a reviewed response contract. It still does not create a provider-side exactly-once transaction. Inspect remote state when the action matters.

## Reconcile uncertainty

1. Record the run ID and inspect `wrench runs show <run-id>`.
2. For a supported exact desired-state readback, run `wrench runs reconcile
   <run-id> --json`. Current runs recover their original input only from the
   encrypted run-, auth-, and contract-bound capsule. The recognized legacy X
   bookmark run instead requires its exact original input through `--input`;
   wrench verifies the receipt's canonical input hash before any read.
3. Use only a separate reviewed R1 request that inspects the exact target
   without acknowledgement traffic. The reconciler validates the returned
   state kind and target before recording it.
4. Treat every reconciliation as an append-only observation. It never changes
   the original receipt, idempotency ledger, or provider state and never
   creates retry authority.
   Once an exact readback durably records `desired-state-observed`, wrench
   releases only that run's encrypted capsule and digest-bound attachment
   bundle. A nonmatching or inconclusive observation retains both so another
   bounded inspection remains possible.
5. A currently absent desired state does not prove that an earlier write never
   applied briefly. Leave the ledger intact whether the effect is present,
   absent, or still uncertain.
6. Wait and inspect again when provider processing may be delayed. Issue a
   materially new action only after fresh authorization and a new exact
   preview; never retry the unsettled action automatically.

Receipts keep hashes, contract identity, transport, account-realm fingerprint, dispatch counts, origin, timestamps, and categorical errors. They omit credentials, response bodies, message/post text, private identifiers not required for reconciliation, and original attachment paths.

Recovery capsules are private AES-GCM state under `WRENCH_STATE_HOME`. They contain
the exact confirmed input needed for a bounded readback but never appear in
receipts, plans, logs, or reconciliation observations. Do not delete the
recovery key or capsule for an unsettled run; a missing key is not regenerated
during readback, and new writes are refused while older capsules remain,
because replacing the key would only destroy recoverability. Confirmed
attachment bundles follow the same lifecycle: settled and proven pre-dispatch
outcomes remove them, while `pending`, `partial`, and `indeterminate` runs keep
them until an exact successful reconciliation is durably recorded.

## Clean up task-owned state

Cancel unused plans with `wrench plans cancel <digest> --yes`, discard derivations with `wrench derive discard <id> --yes`, and remove obsolete auth locators explicitly. Uninstalling the wrapper does not recursively remove browser credentials or wrench state.

If browser capture/bootstrap shutdown cannot be verified, preserve the exact recovery handle and close only that task-owned session before deleting its directories. Do not use broad recursive cleanup against shared browser state.
