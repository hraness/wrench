# Meta Comet contract template

Use this template for Facebook personal, Page, Group, and Marketplace internal
API operations. Treat each surface as a separate actor/target contract even
when it shares the same Comet bootstrap and Relay endpoint.

## Bootstrap without executing the page

Acquire the selected browser profile's cookies through the normal auth locator,
then issue one pinned direct HTTPS `GET` for the exact first-party root needed
by the operation. Parse inert `application/json` script bodies from the HTML;
do not load the route in a browser or execute its JavaScript.

The bootstrap must:

- find one primary JSON root anchored by the unique
  `RelayAPIConfigDefaults` module;
- require `CurrentUserInitialData`, `DTSGInitialData`, `SprinkleConfig`, `LSD`,
  and `SiteData` in that same root;
- require account ID, user ID, Relay actor ID, and the auth realm's expected
  viewer to agree;
- allow later hydrated roots only when any repeated viewer identity agrees;
- select DTSG, LSD, revision, HSI, and Comet environment values only from the
  anchored root, never by mixing pagelet copies;
- reject missing, duplicate-within-root, malformed, oversized, ambiguous, or
  unreviewed module shapes.

Raw proof and build values stay in opaque one-use memory. Declare each source
and sink explicitly:

| Source | Only sink |
| --- | --- |
| current viewer | access binding and `__user` |
| current actor | access binding and `av` |
| DTSG bootstrap | `fb_dtsg` |
| DTSG-derived jazoest | `jazoest` |
| LSD bootstrap | `lsd` |
| client revision | `__rev` |
| HSI bootstrap | `__hsi` |
| Comet environment | `__comet_req` |
| monotonic request counter | `__req` |

Never serialize these values into evidence, manifests, plans, receipts, logs,
URLs, exceptions, or generic output. A bootstrap parser failure is a drift
failure, not permission to scrape a token from arbitrary HTML.

Materialize a proof handle only against a genuine descriptor-built request.
Compare its viewer, actor, target, descriptor key, and exact declared proof
field set with the bootstrap before retaining any raw material. The network
sink must consume that same request object and handle together, exactly once;
a proof for one request cannot authorize a reconstructed or second request.
Expose only redacted evidence for the descriptor-declared subset.

## Describe one operation exactly

Define a code-owned descriptor with:

- semantic operation name and query/mutation type;
- exact origin, method, path, Relay friendly name, and reviewed registered
  operation revision;
- one access policy: personal viewer, Page actor and Page target, group target,
  or Marketplace viewer and listing target;
- exact semantic inputs and nested Relay variables, with no passthrough fields;
- required proof declarations and their fixed form sinks;
- one or more mutually exclusive response-root variants;
- bounded projection, completeness semantics, and target/actor echoes;
- pagination fields bound to descriptor, viewer, actor, target, and prior cursor
  chain;
- for a mutation, one independent observed query readback and a single planned
  dispatch.

An observation resolves a descriptor's dynamic registered-operation revision;
it does not turn captured variables or headers into runtime constants. Reject
friendly-name, operation-type, transport, revision, variable, response-root,
and account drift before dispatch.

Scope bootloader containers to the operation that observed them. A personal
home-feed preloader does not authorize Group or Marketplace data, and a
Marketplace browse preloader does not authorize a listing detail root.
Validate the exact module name, method, dependency/argument tuple, payload
coordinate, semantic patch path, and root-edge-final document order. Bind the
complete preloader identifier from the initial root and require every streamed
edge and final fragment to use that same identifier; a shared operation-name
prefix is not enough. Treat a container query revision and its pagination query
revision as distinct facts even when one bootstrap supplies both.

Never accept a provider cursor directly from CLI input. Return a
wrench-authenticated opaque envelope bound to the local installation key,
auth-locator hash, the canonical full descriptor, viewer, actor, target, exact
preloader-derived input context, and preceding provider cursor. Authenticate
and reconstruct that binding before cookie acquisition or network access, and
seal every successor cursor with the same coordinates plus the hashes of all
prior cursors. Bound each chain explicitly; the Marketplace contract currently
permits at most 48 provider pages. Reject tampering, another installation or
account, any descriptor or input-context drift, a cursor seen anywhere earlier
in the chain, and malformed or oversized chains.

When Meta's registered-operation revision lives in JavaScript bundles, derive
the candidate bundle URLs only from canonical
`https://static.xx.fbcdn.net/rsrc.php/.../*.js` literals in the inert HTML.
Fetch a bounded number of bounded first-party assets, resolve exactly one
top-level Relay operation module, and compare its current revision with the
reviewed descriptor. Reject foreign, relative, encoded, queried, fragmented,
ambiguous, malformed, or syntactically deceptive asset/module candidates.
Never execute the bundle or use a general JavaScript evaluator.

## Separate facet authority

- Personal operations require viewer actor equals the bound viewer.
- Page operations require a `page_id`; Page mutations additionally prove the
  selected actor is authorized for that exact Page.
- Group operations require a `group_id`; membership, moderation, and posting
  are different contracts.
- Marketplace exact reads require a `listing_id`. Conversation reads and sends
  additionally bind the conversation to that listing and both participants.

Do not infer Page, Group, Marketplace, Instagram, or Threads authority from a
successful personal Facebook preflight.

## Exclude visit-side mutations

A browser navigation can emit last-visit, item-seen, presence, delivery, badge,
or read-acknowledgement mutations. Those requests are not part of an R1 read.
Prefer direct root HTML or a reviewed query request that does not execute page
scripts. If the desired response cannot be separated from visit-side
mutations, leave the operation `capture-required`.

`sideEffect: "none"` describes semantic provider state, acknowledgements, and
user-visible interaction—not ordinary HTTPS access logging. A promoted direct
GET may therefore appear in provider infrastructure logs, but it must not
execute client scripts, include a visit/seen acknowledgement request, or retry
an indeterminate route read.

Do not open Messenger or a conversation route for evidence without explicit
approval that covers possible presence, sync, delivery, badge, seen, and read
side effects. Opening a route is not automatically a read-only action.

## Promotion checklist

Promote one operation only when:

1. managed capture identifies the exact current query or mutation;
2. the bootstrap, descriptor, variables, response, account, actor, target, and
   bounds pass deterministic drift tests;
3. incidental mutations are enumerated and excluded;
4. one authorized live fixture succeeds through the public CLI;
5. R1 receipts show zero dispatches, or the exact confirmed R2/R3 schedule is
   durably ledgered and independently read back;
6. errors and receipts contain no credentials or private response text.

Keep media upload, multi-part dispatch, comments, posts, messages, moderation,
commerce, and every unobserved operation `capture-required` until each has its
own evidence and fixture.
