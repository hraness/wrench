# Video platform routing

Use this as routing guidance only. Always inspect
`wrench capabilities <adapter> --json`; installed adapter state and schemas
are authoritative and may change.

| Surface | Candidate adapter | Video operation | Meaning |
| --- | --- | --- | --- |
| X | `x-web` | `posts.publish` when the installed schema accepts `video/mp4` | Consumer X post. Observed `x-web` `posts.publish` now accepts one plan-bound PNG or one MP4. |
| X | `x` | `posts.publish` when the installed schema accepts `video/mp4` | Official OAuth post. Already schemas MP4. |
| LinkedIn | `linkedin-web` or `linkedin` | inspect `media.publish` or a video-capable `posts.publish` | Member or explicitly bound organization post |
| Bluesky | `bluesky-web` | inspect for `video/mp4` | AT Protocol feed post |
| Substack | `substack-web` | inspect; Notes only | Public Substack Note, not an article or newsletter |
| TikTok | `tiktok-web` | `media.publish` when observed | Native TikTok video |
| Instagram | `meta-web` on the Instagram surface | inspect media/posts publish | Instagram video or Reel only when the schema says so |
| YouTube Shorts | `youtube-web` | `media.publish` when observed | Studio video upload. Community `posts.publish` is not a Short. |

At the 2026-08-20 reference revision, `x-web` `posts.publish` is observed
for one plan-bound `image/png` or one plan-bound `video/mp4`. Official `x`
already schemas MP4. LinkedIn-web remains image-only on `posts.publish`.
TikTok `media.publish`, Instagram/meta-web video, and YouTube
`media.publish` stay `capture-required` until their request, response, and
readback contracts are implemented. Treat those as unavailable until the
installed capability independently says `observed`.

## Selection rules

- Use exactly one adapter and one stable bound account realm per surface.
- Prefer the transport the user named or already configured. Do not fall
  back from browser-session to OAuth, or vice versa, because one operation
  is unavailable.
- Require the chosen video operation's `state == "observed"`. An invalid
  adapter or `capture-required` operation must produce no request.
- A text or image `posts.publish` is not a substitute for video.
- Re-check capabilities before every new preview.
- Tags are an explicit platform-specific variant only for TikTok,
  Instagram, and YouTube Shorts. Leave X, LinkedIn, Substack, and Bluesky
  tag-free.

## Common invocation shape

Write exact input JSON to a private task file when shell quoting would be
fragile, then invoke:

```sh
wrench invoke <adapter> media.publish \
  --input @/absolute/private/video-input.json \
  --auth <bound-auth-id> \
  --preview --json [--headed]
```

Use `posts.publish` instead only when the installed schema for that
adapter accepts `video/mp4` on that operation.

Review the returned digest and confirm it within five minutes:

```sh
wrench confirm <plan-digest> --json [--headed]
```

Follow the preview's returned `confirmCommand` exactly so headed mode is
preserved.

Do not place credentials in the input file. Delete task input files after
planning.
