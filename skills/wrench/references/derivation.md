# Derive a first-party authenticated API contract

Use derivation to observe one signed-in first-party exchange and turn it into a reviewed code-owned contract. Treat browser interaction as temporary evidence collection. Do not ship the interaction as a DOM recipe.

## Contents

- [Define the evidence target](#define-the-evidence-target)
- [Record a managed HAR](#record-a-managed-har)
- [Review one sealed capture](#review-one-sealed-capture)
- [Finish and remove the raw capture](#finish-and-remove-the-raw-capture)
- [Create a fail-closed provider scaffold](#create-a-fail-closed-provider-scaffold)
- [Promote evidence into a reviewed contract](#promote-evidence-into-a-reviewed-contract)
- [Install only a bounded semantic contract](#install-only-a-bounded-semantic-contract)
- [Forward-test the contract](#forward-test-the-contract)

## Define the evidence target

Before opening a browser, write down:

- one semantic operation, such as `messaging.list`, `messaging.send`, or `posts.publish`;
- one exact HTTPS first-party origin;
- one auth realm and expected provider account;
- one bounded, non-sensitive fixture;
- the intended risk and every plausible incidental effect;
- the request and response facts that must be proved.

Use a read-only fixture first. For a mutation, obtain explicit authorization for one exact low-stakes dispatch and decide how the response and visible provider state will identify the target and result.

## Record a managed HAR

Run `wrench operator doctor`, select the auth locator, and start with response content disabled:

```sh
wrench derive start linkedin-web https://www.linkedin.com/feed/ \
  --auth linkedin-main \
  --content none \
  --domains 'www.linkedin.com' \
  --headed
```

For an authorized image- or video-bearing mutation, bind each media file before browser
startup with a repeated `--fixture` option and enable remote actions:

```sh
wrench derive start example-web https://example.com/feed/ \
  --auth example-main \
  --content text \
  --fixture /absolute/private/image.png \
  --allow-remote-actions \
  --headed
```

Wrench copies at most 20 PNG, JPEG, GIF, WebP, or MP4 files into the mode-private
derivation directory, records only their byte counts, detected media types,
SHA-256 hashes, and `fixture:<n>` references, and never retains their original
paths. Upload only a start-bound reference to a current snapshot file input:

```sh
wrench derive browser <id> -- upload @e5 fixture:1
```

If the accessible attach control is a button backed by a hidden input, use the
fixed `@single-file-input` reference. Wrench first proves that the current page
contains exactly one HTML file input; it never accepts a caller-selected CSS
selector:

```sh
wrench derive browser <id> -- upload @single-file-input fixture:1
```

When a site keeps its file input behind a closed native chooser, bind the
visible upload control from a fresh snapshot and let Wrench attach only the
staged fixture through its code-owned chooser bridge:

```bash
wrench derive browser <id> -- choose-upload @e5 fixture:1
```

This command accepts no selector, path, script, cookie, or caller-selected
request. It suppresses the native picker, attaches only the start-bound fixture,
then disables interception and closes the private CDP connection before
returning.

If the composer contains multiple file inputs but exactly one advertises an
image accept type, use the fixed `@single-image-input` reference. Wrench proves
that the current page contains exactly one matching image input before upload:

```sh
wrench derive browser <id> -- upload @single-image-input fixture:1
```

Raw paths, arbitrary selectors, and unstaged references are rejected. Wrench
re-verifies the private copy immediately before and after upload and resolves
only that Wrench-owned copy for the persistent browser daemon; finish/discard
removes it with the rest of the private derivation state. The ordinary
`upload` form also keeps its browser batch alive for one fixed five-second
settling interval so page code can consume the selected file before the short
helper invocation exits; the derivation remains open for later commands.

When the file upload itself is the final evidence target, prefer the terminal
form below. It uploads, allows one fixed five-second network-settling interval,
and stops HAR recording in one browser batch, then disables further browser
commands for that derivation. This preserves the raw capture even when a
provider leaves the pinned browser unable to accept a second IPC request after
file selection:

```sh
wrench derive browser <id> -- upload-and-seal @single-file-input fixture:1
```

Continue with `derive review` and `derive finish`; do not expect to type or
submit through a derivation after `upload-and-seal`.

Do not use `upload-and-seal` at the file-selection step of a provider dialog
that has a separate review or **Next** action. Selection proves only that page
code received the staged file; it may produce no registration or transfer.
Use nonterminal `upload`, inspect the resulting dialog, activate the one exact
review/Next action, allow the fixed settling interval, and then run `derive
review` to seal the recorder. LinkedIn's Article image dialog required this
sequence before its single-upload registration, signed transfer, and autosave
appeared. Keep snapshot references capture-local; never encode them in a
runtime contract.

Save the derivation ID. Use `wrench derive list` to recover it after an interruption. wrench serializes every lifecycle command for that ID from preflight through cleanup. A session becomes executable only after its create-only readiness marker binds the final session metadata; interrupted initialization remains visible as `ready: false`, `recoverable: true`. `socketAvailable` distinguishes a live helper from state left after a reboot.

Agent-browser may navigate, snapshot, and exercise the chosen fixture while recording. Those actions exist only to generate evidence. Do not translate snapshot references, accessible labels, element order, or click sequences into the installed capability.

For authenticated LinkedIn capture, use a path-backed `browser-profile` auth
locator stored with `--trust-profile-egress`, an exact
`--browser-executable`, and optionally a filtered Arc/Chrome
`--cookie-source`. wrench clones that profile into the task-private derivation
directory before launch. Named agent-browser profiles are rejected because
they would be opened directly rather than cloned. Cookie-only contained
derivation is rejected for LinkedIn: the pinned agent-browser containment
bootstrap can lose LinkedIn's authenticated execution context, terminate its
Chrome child, and thereby lose the in-memory HAR while leaving the daemon
socket alive. Never treat an automatic `about:blank` relaunch as continuity.
Use Chrome or Chromium as the exact executable for an Arc snapshot. Arc may
attach its normal source user-data root to a task-private launch, so wrench
rejects Arc itself as the managed derivation executable. Arc remains supported
as a fully closed source profile and as an explicitly selected cookie source.
Fully quit the source Chromium browser first; wrench rejects an active or stale
`Singleton*`/`DevToolsActivePort` lock rather than copying unsettled LevelDB or
SQLite state. A path-backed profile also disables agent-browser domain
containment. Its `--domains` list is retained as review metadata, while
`--trust-profile-egress` acknowledges that the browser and page scripts may
contact other origins.

For an R1 capture, avoid inbox or conversation routes that emit presence, seen, read, delivery, badge, or acknowledgement traffic. Record the desired read request separately from incidental requests and explicitly deny the latter in the contract.

For an R2/R3 capture, restart with `--allow-remote-actions` only after authorization. Send the exact fixture once. Record enough response content to prove request fields, response bindings, and account/target identity, but prefer `--content none` whenever structural evidence is sufficient. Never use a production-sensitive conversation merely because it is convenient.

## Review one sealed capture

Private review can expose the structure needed to write a typed contract without printing or retaining request values:

```sh
wrench derive review <id> --limit 50 --json
wrench derive review <id> --entry 0 --json
printf '%s' '{"target":"known-fixture-value"}' \
  | wrench derive review <id> --entry 0 --fixtures - --json
```

The first review stops and seals the exact inode-bound managed HAR. Browser commands are then disabled; repeat reviews and `finish` consume the same sealed bytes. Fixture values are accepted only through bounded stdin, matched only by exact primitive equality, and the result contains labels and structural locations, never the supplied values. It never performs substring probes. Credential-like query, form, JSON, path, header, cookie, authorization, session, signature, CSRF/XSRF, and token material is opaque. Bounded traversal reports `truncated: true` whenever searchable content was omitted, including oversized URLs, query values, JSON or text, capped parameters or containers, forms, and multipart bodies.

Review cannot replay a request or generate executable transport. Use the returned locations only to implement and test an owned parser and request builder.

## Finish and remove the raw capture

```sh
wrench derive finish <id> --output /absolute/private/linkedin-web-capture
```

Successful finish writes four mode-private artifacts and deletes the managed raw HAR:

- `internal-api-evidence.json` retains exact first-party method/path structure, safe query and header names, anonymous request/response field paths, status codes, and registered-operation revisions.
- `derivation.candidates.json` retains the more conservative generic structural report.
- `wrench-adapter.json` is an empty scaffold. It does not contain an executable client.
- `reviewed-template.reservation.json` binds the candidate evidence hash to a non-executable review checklist. It never promotes captured traffic automatically.

Both evidence reports are inert and `reviewRequired`. They omit cookies, header values, URL values, body values, response values, and cross-origin paths. Inspect them for accidental identifying names before sharing or committing them. Normally keep them in private temporary state and transfer only the reviewed contract facts into source.

Discard an abandoned session:

```sh
wrench derive discard <id> --yes
```

Discard is also the recovery path for init-only, unready, or post-reboot sessions. It closes an identity-bound live helper before deleting state and refuses cleanup if that close cannot be proved; when the exact ephemeral socket has disappeared, it can remove the retained private session safely. Browser, review, and finish always require a live socket and a valid readiness boundary.

`wrench derive analyze <har> ...` can inspect an external HAR, but it cannot attest to or delete that file. Store it privately and delete it immediately after review.

## Create a fail-closed provider scaffold

After reviewing one candidate, follow
[code-owned-provider-scaffold.md](code-owned-provider-scaffold.md). Pass the
private sanitized `internal-api-evidence.json` and exact candidate index to
`scripts/scaffold-web-provider.ts`. The command binds the evidence hash into a
private promotion checklist and creates a schema-v4 provider, runtime, manifest,
and tests that all fail before auth or network I/O.

The scaffold deliberately does not copy an endpoint, request value, response
value, or browser step into executable code. It is a code-review starting point,
not a generated client and not evidence that an operation is observed.

## Promote evidence into a reviewed contract

Add or update a code-owned site/action contract for every executable operation; a manifest may only select that contract. A generic schema-v5 manifest may retain a `capture-required` reservation, but generated evidence and reservations never supply an executable exchange. Manifest validation rejects every schema-v5 v1 `reviewed` template, including apparent R1 reads, until contractVersion 2 adds a reviewed current-account identity preflight and response-scope binding.

Apply these rules to either executable form:

1. Keep the registry entry `capture-required` while any request, response, token, target, actor, or account fact is unknown.
2. Bind one exact origin, method, path structure, allowed query names, body field shape, and timeout/response bounds.
3. Encode all user-controlled path, query, and body values from typed operation inputs. Reject unknown fields and ambiguous target forms.
4. Allow cookies through the authenticated session layer, never as manifest literals.
5. Route a current CSRF or authorization value only from its reviewed cookie, meta, storage, or captured-header source to its fixed header sink.
6. Resolve registered-operation revisions by an exact operation prefix and require one unique current candidate.
7. Declare every exact successful status and content-type pair. Reject redirects, alternate origins, unexpected content types, oversized responses, and undeclared success shapes.
8. Project only bounded fields needed by the semantic result.
9. Bind response fields to the requested target and, for mutations, to the expected actor and created/updated object.
10. Bind the auth realm to the current provider account through a reviewed viewer/account request. Fail before dispatch on missing, ambiguous, or mismatched identity.

Set the contract to observed only when the evidence and deterministic tests support every fact. “The UI worked” is not contract evidence.

## Install only a bounded semantic contract

A LinkedIn/X schema-v4 adapter selects the reviewed code-owned contract:

```json
{
  "webSession": {
    "site": "linkedin",
    "action": "messaging.list",
    "contractVersion": 1,
    "timeoutMs": 60000,
    "maxOutputBytes": 4194304
  }
}
```

That schema-v4 manifest cannot provide an endpoint, method, header, body template, token source, projection, or response binding. A generic schema-v5 v1 manifest carries only non-executable `capture-required` reviewer guidance; `reviewed-template.reservation.json` is inert evidence, not a request template or generated client. Increment the adapter version—and the owned contract version for schema v4—when any executable request or response fact changes so pending work becomes stale.

## Forward-test the contract

Use a fresh signed-in realm and low-stakes fixture:

1. Validate and install the schema-v4 code-owned adapter, or validate a schema-v5 `capture-required` reservation as inert output. Require every schema-v5 v1 `reviewed` template to fail validation while `capture-required` reservations remain non-executable.
2. Verify the expected account binding before any private read or dispatch.
3. Run each R1 operation with a small page bound. Confirm that no incidental acknowledgement endpoint was requested.
4. For a code-owned R2/R3 operation, preview each authorized payload and compare target, actor, content, attachments, risk, auth realm, contract hash, and dispatch schedule to intent.
5. Confirm a code-owned mutation once. Require an exact declared response variant and target/actor binding.
6. Inspect provider-visible state independently.
7. Repeat the identical invocation within `dedupeWindowMs`; require refusal before any request.
8. Simulate missing cookies, token ambiguity, registered-query drift, account mismatch, redirect, status/content-type drift, response-binding failure, timeout, and oversized output. Require failure with no DOM fallback.
9. Simulate uncertainty after request dispatch. Require `indeterminate` or `partial`, preserve the ledger, and do not retry.
10. Scan plans, receipts, logs, and temporary files for credentials, content values, captured authorization, account-private URLs, and raw HAR material.

Forward-test the skill with a fresh agent given only this skill path and a realistic capture task. Do not disclose the expected endpoint, token source, risk, or implementation beforehand.
