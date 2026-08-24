# Social platform routing

Use this as routing guidance only. Always inspect `wrench capabilities <adapter> --json`; installed adapter state and schemas are authoritative and may change.

| Surface | Candidate adapter | Signed-in realm | Reference post shape | Meaning |
| --- | --- | --- | --- | --- |
| X | `x-web` | Browser cookies/profile | `body`; optional image fields when exposed | Consumer X post |
| X | `x` | Official OAuth | `body`, optional `media` and aligned alt-text fields; leave `made_with_ai` unset or `false` for user-supplied cross-post copy | Documented API post |
| LinkedIn | `linkedin-web` | Browser cookies/profile | `body`, `visibility`, optional image and accessibility fields | Member or explicitly bound organization post |
| LinkedIn | `linkedin` | Official OAuth | Inspect installed schema | Documented API post |
| Bluesky | `bluesky-web` | Profile-backed Bluesky web session | `body`, optional image, media type, and alt text | AT Protocol feed post |
| Substack | `substack-web` | Browser cookies/profile | `body`, optional Note media | Public Substack Note, not an article/newsletter |
| Threads | `meta-web` | Browser cookies/profile | Text/image `posts.publish`: `body`, audience, optional one PNG. Video `media.publish`: `body`, audience, one MP4. | Threads post |

Cleanup is capability-driven too. At this reference revision, `bluesky-web`
exposes observed `content.delete@1` only for one current-account post URI plus
its exact confirmed CID. `reddit-web` exposes observed `content.delete@1` only
for one exact current-account post fullname plus its confirmed title, followed
by independent absence readback. `x-web` reserves `content.delete@1` as
`capture-required`; `substack-web content.delete@1` is observed for one exact
authored personal Note with exact actor/body pre-read and independent 404
absence. LinkedIn and Threads
deletion remain unavailable unless their installed canonical capability
independently says otherwise.

## Selection rules

- Use exactly one adapter and one stable bound account realm per surface.
- Prefer the transport the user named or already configured. Do not fall back from browser-session to OAuth, or vice versa, because one operation is unavailable.
- Require `posts.publish.state == "observed"`. An invalid adapter or `capture-required` operation must produce no request.
- Treat each current schema's required fields, file cardinality, byte/media bounds, and accessibility-field shape literally. The table is not a capability promise.
- Preserve input image order. Require alt-text arrays to align one-to-one when the schema exposes them.
- Re-check capabilities before every new preview. A plan or run remains governed by its bound contract identity when installed support later changes.
- A provider may reject an otherwise valid image for dimensions, animation, color profile, or account entitlement. Report that provider-owned failure without converting the file unless the user asks for a derivative.
- For user-supplied cross-post copy, never mark the package as AI-generated. Follow [X AI disclosure](x-ai-disclosure.md). Leave official `x` `made_with_ai` unset or `false`. `x-web` `posts.publish` has no such input field.
- Prefer a Wrench transport over the X composer. If the user explicitly requested a composer fallback, require Content disclosure Made with AI OFF before Post, then open the live permalink. A sparkle label means that target failed.

## Common invocation shape

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

Use headed execution when the installed signed-in web adapter or bound realm requires it and the user authorized it. Follow the preview's returned `confirmCommand` exactly so headed mode is preserved.

Do not place credentials in the input file. Delete task input files after planning; Wrench's plan owns encrypted confirmed input and attachment bundles for its lifecycle.

## Parity decisions

- If text exceeds one platform's bound, request shorter shared copy or an explicit platform-specific variant. Do not silently use `threads.publish`.
- If the ordered image set exceeds one platform's bound, request a smaller shared set or an explicit per-platform set. Do not manufacture a collage.
- If LinkedIn requires visibility and the user requested a public cross-post, use `public`; otherwise obtain the user's audience choice.
- If Threads requires `audience` and the user requested ordinary posting, use the installed schema's ordinary/default audience only when that meaning is explicit in the capability description.
- At this reference revision, reviewed Threads text/image publication accepts no attachment or exactly one PNG, and reviewed video publication requires exactly one MP4. A dummy PNG, collage, or composer click-path changes the package and is not an installed fallback. JPEG and other image types remain unavailable unless the installed schema independently lists them.
- If image alt text is supported on only some targets, preserve the same factual description on every target that accepts it; unsupported alt text is not a reason to alter the visible post.
