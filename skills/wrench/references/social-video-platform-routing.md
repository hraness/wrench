# Social video platform routing

Use this as routing guidance only. Always inspect
`wrench capabilities <adapter> --json`; installed adapter state and schemas
are authoritative and may change.

| Surface | Candidate adapter | Video operation | Meaning |
| --- | --- | --- | --- |
| X | `x-web` | `posts.publish` when the installed schema accepts `video/mp4` | Consumer X post. Observed `x-web` `posts.publish` now accepts one plan-bound PNG or one MP4. |
| X | `x` | `posts.publish` when the installed schema accepts `video/mp4` | Official OAuth post. Already schemas MP4. |
| LinkedIn | `linkedin` | video-capable `posts.publish` | Observed official OAuth member or explicitly bound organization post. |
| LinkedIn | `linkedin-web` | `media.publish` when observed | Consumer-web member video; currently a separate capture-required route so image `posts.publish` remains unchanged. |
| Bluesky | `bluesky-web` | `media.publish` | Observed AT Protocol video feed post; image `posts.publish` remains a separate observed contract. |
| Substack | `substack-web` | `media.publish` when observed | Public Substack Note, not an article or newsletter. |
| TikTok | `tiktok-web` | `media.publish` when observed | Native TikTok video |
| Instagram | `meta-web` on the Instagram surface | `media.publish` when observed | Instagram video or Reel only when the schema says so. |
| Threads | `meta-web` on the Threads surface | `media.publish` | Observed single-MP4 Threads video post; image `posts.publish` remains a separate contract. |
| YouTube Shorts | `youtube-web` | `media.publish` when observed | Studio video upload. Community `posts.publish` is not a Short. |
| Reddit | `reddit-web` | `media.publish` when observed | One video post in one exact confirmed subreddit. |

At the 2026-08-22 reference revision, `x-web` `posts.publish` is observed
for one plan-bound `image/png` or one plan-bound `video/mp4`. Official `x`
and official `linkedin` already observe MP4 post contracts. `reddit-web`
`media.publish@9` observes one plan-bound MP4 plus a required plan-bound
PNG/JPEG poster and explicit NSFW, spoiler, and reply declarations. Threads
`media.publish@1` observes one plan-bound ISO BMFF MP4, exact dimensions, its
single-request video upload, durable created-post identity, and independent
permalink actor/text/video readback. Bluesky `media.publish@2` observes one
plan-bound ISO BMFF MP4, the fixed first-party legacy upload and response-bound
processing job, processed blob, exact repository record, durable accepted
target, and authoritative PDS plus public AppView readbacks. LinkedIn web,
Substack Notes, TikTok, Instagram, and YouTube expose bounded video `media.publish`
reservations. Those routes stay `capture-required` until their exact upload,
processing, request, response, actor/target, and independent readback contracts
are implemented and proven.
Treat them as unavailable until the installed capability independently says
`observed`.

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
  Instagram, and YouTube Shorts. Leave X, LinkedIn, Substack, Bluesky,
  Threads, and Reddit tag-free.

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
