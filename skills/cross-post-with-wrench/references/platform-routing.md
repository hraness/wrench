# Platform routing

Use this as routing guidance only. Always inspect `wrench capabilities <adapter> --json` for a Wrench target; installed adapter state and schemas are authoritative and may change. For LinkedIn on a non-local host, inspect live MCP tools on the connected LinkedIn connector instead of planning `linkedin-web`.

| Surface | Candidate adapter | Signed-in realm | Reference post shape | Meaning |
| --- | --- | --- | --- | --- |
| X | `x-web` | Browser cookies/profile | `body`; optional image fields when exposed | Consumer X post |
| X | `x` | Official OAuth | `body`, optional `media` and aligned alt-text fields | Documented API post |
| LinkedIn | `linkedin-web` | Browser cookies/profile on a local personal computer | `body`, `visibility`, optional image and accessibility fields | Member or explicitly bound organization post |
| LinkedIn | `linkedin` | Official OAuth | Inspect installed schema | Documented API post |
| LinkedIn | Connected LinkedIn connector | Agent MCP connector on a non-local host | Exact text and ordered images; `visibility` `public` when the user asked for a public cross-post | Member post through the connected account; inspect live tools for create, share, post, or ugc |
| Bluesky | `bluesky-web` | Profile-backed Bluesky web session | `body`, optional image, media type, and alt text | AT Protocol feed post |
| Substack | `substack-web` | Browser cookies/profile | `body`, optional Note media | Public Substack Note, not an article/newsletter |
| Threads | `threads-web` | Browser cookies/profile | `body`, explicit audience when required, one required PNG attachment in the current reviewed schema | Threads post |

Cleanup is capability-driven too. At this reference revision, `bluesky-web`
exposes observed `content.delete@1` only for one current-account post URI plus
its exact confirmed CID. `x-web` reserves `content.delete@1` as
`capture-required`; LinkedIn, Substack, and Threads deletion remain unavailable
unless their installed canonical capability independently says otherwise.

## Selection rules

- Use exactly one adapter or connector and one stable bound account realm per surface.
- Detect the host before selecting a LinkedIn transport. Treat Grok Bot, a shared remote computer, a Cursor cloud-agent VM, and any machine that is not the user's personal desktop with their signed-in Chrome or Arc as non-local.
- On a local personal computer, use bound `linkedin-web` or the official `linkedin` OAuth adapter the user already configured. Do not switch that choice mid-batch.
- On a non-local host, do not use `linkedin-web` cookies and do not attempt a remote Chrome LinkedIn login. Use the connected LinkedIn connector when one is connected; otherwise use official Wrench `linkedin` OAuth when a bound OAuth realm exists; otherwise report LinkedIn unavailable and continue the other platforms.
- Prefer the transport the user named or already configured. Do not fall back from browser-session to OAuth, from either of those to a LinkedIn connector, or the reverse, because one operation is unavailable.
- Wrench remains the only posting transport for X, Bluesky, Substack Notes, and Threads. `linkedin-web` stays valid for local machines; do not mark it `capture-required` or remove it.
- Require `posts.publish.state == "observed"` for a Wrench target. An invalid adapter or `capture-required` operation must produce no request. A connector LinkedIn target requires a live create, share, post, or ugc operation and a confirmed user-visible account.
- Treat each current schema's required fields, file cardinality, byte/media bounds, and accessibility-field shape literally. The table is not a capability promise.
- Preserve input image order. Require alt-text arrays to align one-to-one when the schema exposes them.
- Re-check capabilities before every new preview. A plan or run remains governed by its bound contract identity when installed support later changes.
- A provider may reject an otherwise valid image for dimensions, animation, color profile, or account entitlement. Report that provider-owned failure without converting the file unless the user asks for a derivative.
- A connector LinkedIn post still needs the exact text-and-image package, `public` visibility when the user asked for a public cross-post, and a ledger row with the connector/account label and permalink when the connector returns one. Keep credentials, tokens, and private response bodies out of receipts.

## Common invocation shape

The commands below are for Wrench-owned transports. A connector LinkedIn post uses the live MCP create, share, post, or ugc operation instead of `wrench invoke`.

Write exact input JSON to a private task file when shell quoting would be fragile, then invoke:

```sh
wrench invoke <adapter> posts.publish \
  --input @/absolute/private/post-input.json \
  --auth <bound-auth-id> \
  --preview --json [--headed]
```

Review the returned digest and confirm it within five minutes:

```sh
wrench confirm <plan-digest> --json [--headed]
```

Use headed execution when the installed signed-in web adapter or bound realm requires it and the user authorized it. Follow the preview's returned `confirmCommand` exactly so headed mode is preserved. Do not start a headed LinkedIn Chrome session on a non-local host.

Do not place credentials in the input file. Delete task input files after planning; Wrench's plan owns encrypted confirmed input and attachment bundles for its lifecycle.

## Parity decisions

- If text exceeds one platform's bound, request shorter shared copy or an explicit platform-specific variant. Do not silently use `threads.publish`.
- If the ordered image set exceeds one platform's bound, request a smaller shared set or an explicit per-platform set. Do not manufacture a collage.
- If LinkedIn requires visibility and the user requested a public cross-post, use `public` on the Wrench adapter or the connected LinkedIn connector; otherwise obtain the user's audience choice.
- If Threads requires `audience` and the user requested ordinary posting, use the installed schema's ordinary/default audience only when that meaning is explicit in the capability description.
- At this reference revision, the reviewed Threads contract requires exactly one PNG. Treat text-only Threads publication as unavailable unless the installed schema says otherwise.
- If image alt text is supported on only some targets, preserve the same factual description on every target that accepts it; unsupported alt text is not a reason to alter the visible post.
