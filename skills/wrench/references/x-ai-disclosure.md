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
- `x-web` `posts.publish` has no AI-disclosure input. Do not invent one. The
  reviewed CreateTweet contract sends empty `semantic_annotation_ids` and no
  content-disclosure field.
- Inspect every other installed schema for a comparable flag and leave it unset
  or `false` for the user-supplied package.

Do not add "Made with AI", "Made with Grok", or similar disclosure text to the
body.

Keep R3 preview and confirm unchanged. Review the digest, then run the printed
`wrench confirm <digest>`.

## Composer fallback

Use the X composer only when the user explicitly asked for that fallback after
a Wrench transport was unavailable. Before Post:

1. Open the post `…` menu.
2. Open Content disclosure.
3. Confirm Made with AI is OFF. If the switch will not turn off, stop. Do not
   post.
4. Close the dialog and confirm the composer no longer shows a Made with AI
   disclosure before clicking Post.

After publish:

1. Open the live permalink. Do not infer success from a cleared composer.
2. If the sparkle Made with AI or Made with Grok label is present, the publish
   failed. Report the permalink and the label. Do not report success.
3. Do not delete or repost unless the user asks.

A labeled post is a failed publish. Leave it in place unless the user asks for
cleanup through an installed `content.delete` capability.
