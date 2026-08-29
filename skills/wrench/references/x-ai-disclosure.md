# Keep user-supplied X cross-posts unlabeled

Wrench's cross-post workflow must not label user-supplied X copy as Made with
AI or Made with Grok. A live sparkle label means the publish failed, even if X
accepted the post.

The rule applies only to the user-supplied cross-post package. The official
provider input still accepts an explicitly authorized `made_with_ai: true` for
attached media outside this workflow.

## Prefer a Wrench transport

Use an installed Wrench `posts.publish` transport. Do not open the X composer
to compensate for a missing, `capture-required`, or failed contract.

- Official `x` `posts.publish` exposes optional `made_with_ai`. Leave it unset
  or `false` for user-supplied cross-post copy. Set `true` only as a separate,
  explicit request to label attached media as AI-generated.
- `x-web` `posts.publish` and `replies.create` have no AI-disclosure input. Do
  not invent one. The reviewed CreateTweet contract sends empty
  `semantic_annotation_ids` and no content-disclosure field. Wrench rejects
  `made_with_ai`, `content_disclosure`, and nonempty
  `semantic_annotation_ids` on both routes.
- Inspect every other installed schema for a comparable flag and leave it unset
  or `false` for the user-supplied package.

Do not add "Made with AI", "Made with Grok", or similar disclosure text to the
body.

Keep R3 preview and confirm unchanged. Review the digest, then run the printed
`wrench confirm <digest>`.

## Scrub attachment provenance

Turning Content disclosure off is not enough. X can still auto-apply Made with
AI from C2PA or other provenance in the uploaded bytes (`caBX` PNG chunks,
`trainedAlgorithmicMedia`, `digitalSourceType`, OpenAI Content Credentials).

Wrench re-encodes each attached JPEG or PNG to pixels-only bytes before INIT
or APPEND. If the bytes that would be uploaded still match those provenance
markers, the run fails before dispatch.

Classifier labels can still appear on images that have no obvious C2PA. Treat
live readback as the source of truth.

## Composer fallback

Use the X composer only when the user explicitly asked for that fallback after
a Wrench transport was unavailable. Before Post:

1. Open the post `…` menu.
2. Open Content disclosure.
3. Confirm Made with AI is OFF. If the switch will not turn off, or is locked
   or greyed, stop. That is an auto-label. Do not post.
4. Close the dialog and confirm the composer no longer shows a Made with AI
   disclosure before clicking Post.

After publish:

1. Open the live permalink. Do not infer success from a cleared composer.
2. If the sparkle Made with AI or Made with Grok label is present, the publish
   failed. Report the permalink and the label. Do not report success.
3. A locked or greyed Content disclosure toggle after Post is the same
   auto-label failure.
4. Do not delete or repost unless the user asks.

## Fail-closed live readback

A labeled post is a failed publish. Wrench classifies that outcome as a
terminal unlabeled-copy failure and does not report success. The post may
already exist on X. Leave it in place unless the user asks for cleanup through
an installed `content.delete` capability.
