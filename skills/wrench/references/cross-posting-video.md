# Cross-post video

Use the installed `wrench` CLI as the only posting transport. Orchestrate
provider operations; do not implement a second HTTP client, click a composer
at runtime, or treat a browser login as proof that video publishing is
supported.

Reuse the preview, confirm, settlement, and ledger rules in
[cross-post text and images](cross-posting.md). Do not invent a second
confirmation model.

## Build one exact video package

Record these values before planning:

- one absolute path to the exact video file that will be posted;
- exact caption text, preserving whitespace and punctuation;
- selected platforms;
- explicit provider choices such as audience, visibility, or a YouTube title.

Do not silently recut, restyle, watermark, or replace the video after the
user has approved the package. Encoding happens before planning.

### Social encode

Prepare one social-friendly cut before any preview:

- 9:16, 1080x1920, H.264 Main, yuv420p, `+faststart`, AAC;
- if the source is landscape, letterbox or blur-pad into 9:16;
- do not crop away a required subject unless the user asked for a crop;
- if replacement background audio is supplied, replace the soundtrack and
  trim or fade it to the video duration. Do not leave the original audio
  mixed under it unless asked.

Encoding may use a local encoder such as ffmpeg. Posting may not.

### Caption and tags

- If the user provided a caption, use it exactly. Do not rewrite it to pass
  a provider limit; ask for a shorter shared caption or an explicit
  platform-specific variant. Never mark that caption as AI-generated;
  follow the unlabeled-copy rule in
  [cross-post text and images](cross-posting.md).
- If no caption was provided, write one short caption from the video's
  actual subject: about one sentence, under 120 characters. Do not invent a
  long marketing paragraph.
- Add hashtags only on TikTok, Instagram, and YouTube Shorts. Put a few
  relevant tags after the caption on those platforms only.
- Do not add hashtags on X, LinkedIn, Substack, or Bluesky.

That tag split is an explicit allowed platform-specific variant. It is not
a license to rewrite the caption.

Give the package a task-local identity. Preserve the same video bytes
through planning, settlement, duplicate accounting, and any cleanup
assessment.

## Preflight every target

1. Run `wrench --help`; if it is unavailable, follow
   [installation and diagnostics](install.md).
2. Read [video platform routing](social-video-platform-routing.md).
3. Run `wrench capabilities <adapter> --json` for every candidate adapter.
   Treat its current operation state and input schema as authoritative over
   the reference and over remembered platform behavior.
4. Select one exact transport and auth realm per platform. Never switch
   between a browser-session and official OAuth adapter after planning.
5. Choose the operation that actually accepts `video/mp4` on that adapter,
   usually `media.publish`. A text or image `posts.publish` is not a video
   operation, even when it is observed.
6. Require that video operation to be `observed`, the adapter to be valid,
   and the auth realm to be bound to its current provider subject.
   `capture-required` is unavailable, not degraded support.
7. Validate the exact file path, bytes, detected media type, caption, and
   required scalars against each installed input schema before creating any
   plan.

If a platform cannot accept this video under an observed contract, exclude
it from the batch and keep it on the ledger as unavailable. Never silently
drop it. Never post through the capture browser as the installed fallback.

Prefer a target-filtered cookie locator for a signed-in web adapter. Use a
profile-backed realm only when the provider contract requires browser
storage and the user has accepted that exact broader egress boundary. Bind
a new realm with `wrench auth bind <id> --site <surface> --json` before any
preview.

If support is missing and the user asked to develop it, use the packaged
Wrench derivation workflow with one expressly authorized low-stakes
fixture. Keep the operation `capture-required` until its contracts pass.

## Preview the complete batch

Construct each input only from its current installed schema. In CLI input
JSON, represent a scalar file field as one absolute path string.

Run every target with `--preview --json` before confirming any target.
Review and summarize adapter, transport, operation, risk, bound account,
exact scalar input, attachment hash, side effect, contract hash, and
five-minute expiry.

Cancel superseded or unused plans. If one target cannot be planned, report
that target separately; do not weaken the other inputs to manufacture
parity.

## Confirm once per platform

Cross-posting is not atomic. Confirm each reviewed digest once with
`wrench confirm <digest> --json`. Do not recreate an expired plan without
rechecking the video package and authorization.

Classify each result independently:

- `submitted`: record the run and provider-created object evidence, then
  settle availability through exact readback;
- pre-dispatch `failed`: diagnose safely and create a fresh preview only if
  the original action remains authorized;
- `pending`, `partial`, or `indeterminate`: preserve the run and use only
  an advertised, separately reviewed exact readback through
  `wrench runs reconcile`.

Never retry pending, partial, or indeterminate work. An unsettled target
does not create authority to delete or repost on other platforms.

## Settle and account for every attempt

Read [settlement and duplicate cleanup](settlement-and-duplicate-cleanup.md)
after confirmation. Give every attempt its own immutable ledger entry. Use
exact returned locators and exact provider readback; never infer delivery
from a cleared composer, a profile search, or matching text.

## Finish with a platform ledger

Return one row per requested platform and attempt with adapter, auth realm
label, plan or run ID, attachment hash summary, terminal state, exact
provider locator or public URL when exposed, readback state, and
availability timing.

Keep caption text, credentials, cookies, private response bodies, and
original local paths out of receipts and diagnostics.
