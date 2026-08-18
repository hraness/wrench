# Native article drafts

## Contents

- [Own the editorial translation](#own-the-editorial-translation)
- [Build the mixed document](#build-the-mixed-document)
- [Save without publishing](#save-without-publishing)
- [Handle uncertainty](#handle-uncertainty)
- [Check provider state](#check-provider-state)

Use `articles.draft.save` to create or replace one private native long-form
draft. Treat it as an R2 mutation with its own preview, confirmation, dispatch
record, and provider-bound unpublished result. It has no publish-capable
branch.

Keep `articles.publish` separate. Publication is R3 and requires a different
installed observed contract, input, preview, and confirmation. A saved draft
ID is not permission to publish, and a draft preview cannot be reused for
publication.

## Own the editorial translation

Capture or read source material separately. The caller decides how to
translate, abridge, retitle, attribute, link, and place images. Wrench does not
turn source HTML, Markdown, or a URL into provider copy and does not infer
attribution or alternative text. Pass only the final reviewed title, canonical
document, and exact local image files to the mutation.

## Build the mixed document

The current `x-web` and `linkedin-web` capabilities require canonical JSON for
`ArticleDraftDocument` schemaVersion 2. Text blocks are:

- `paragraph`
- `heading1`
- `heading2`
- `blockquote`
- `unordered-list-item`
- `ordered-list-item`

Represent a native link with an ordered, non-overlapping range over the
block's UTF-16 text and one canonical absolute HTTPS URL. Represent bold,
italic, or strikethrough with ordered style ranges. Put each paragraph or list
item in its own block; block text cannot contain a newline.

Place an inline image with an `image` block. Its `imageIndex` is the zero-based
position of the matching file in outer `input.inline_images`. Image indexes
must be unique, contiguous from zero, and referenced exactly once. A caption
is optional. Platform metadata differs:

- `x-web` supports captions but its native alt-text write remains
  capture-required, so omit `altText`.
- `linkedin-web` requires a non-empty descriptive `altText`; captions are
  optional.

Both current web adapters accept 1–20 ordered JPEG, PNG, or WebP files, at most
5 MiB each. Wrench sniffs the bytes, copies them into the encrypted preview's
plan-asset bundle, hashes them, removes source paths and filenames from the
preview, and reverifies the exact bytes before dispatch. Do not pass a URL,
provider asset ID, expiring CDN source, cover, video, embed, HTML, Markdown, or
editor payload as an inline image.

Provider text support remains narrower where capture evidence is narrower:
`linkedin-web` accepts only `paragraph`, `heading1`, and `heading2`, native
HTTPS links, and no text styles. `x-web` accepts all listed text block types,
native links, and bold, italic, or strikethrough.

This is canonical X document JSON with one native link and one image:

```json
{"blocks":[{"links":[{"length":6,"offset":9,"url":"https://example.com/source"}],"text":"Read the source","type":"paragraph"},{"caption":"Puerto Rico","imageIndex":0,"type":"image"}],"schemaVersion":2}
```

Put that exact inner JSON string and an absolute local image path in a private
invocation input file:

```json
{
  "title": "Reviewed title",
  "document": "{\"blocks\":[{\"links\":[{\"length\":6,\"offset\":9,\"url\":\"https://example.com/source\"}],\"text\":\"Read the source\",\"type\":\"paragraph\"},{\"caption\":\"Puerto Rico\",\"imageIndex\":0,\"type\":\"image\"}],\"schemaVersion\":2}",
  "inline_images": ["/absolute/private/puerto-rico.png"]
}
```

For LinkedIn, add `"altText":"A descriptive account of the image"` before
`caption` in the canonical image block. If the final block is an image, do not
add an empty paragraph after it; LinkedIn owns that editor-only trailing block
and Wrench removes exactly that provider-added value during readback.

Add `draft_id` only to replace the exact existing private draft owned by the
bound account. Treat `wrench capabilities <adapter> --json` as authoritative
for all installed bounds and contract versions.

## Save without publishing

Inspect support and use the exact provider and auth realm printed by the
installed capability:

```sh
wrench capabilities x-web --json
wrench x-web articles.draft.save \
  --input @/absolute/private/article-draft-input.json \
  --auth x-main --preview --json
wrench confirm <preview-digest> --json
```

Use the same sequence with `linkedin-web` and its bound LinkedIn cookie realm;
never switch adapter or auth realm after preview. LinkedIn executes its fixed
reviewed registration, signed byte-transfer, autosave, and editor-response
readback contract inside contained headed Chrome. The reviewed editor proceeds
from the transfer's `201` response directly to autosave; Wrench does not invent
a processing poll that the editor does not perform. The window may appear, but
Wrench does not type into or read the editor DOM, and callers cannot supply a
URL, header, script, or selector.

Review the account, title, canonical document, ordered attachment hashes,
optional draft ID, R2 side effect, contract version, and every planned
dispatch. X plans one dispatch per image followed by create, or image uploads
then title and content replacement. LinkedIn create plans the title shell,
each image, then content; replacement plans each image followed by one
conservative title/content replacement.

Require a successful result to identify `articles.draft.save`, report
`published: false` and `mode: "draft"`, return the private draft identity, and
report the exact image count. X verifies the owner, private Draft lifecycle,
title, text/link/style structure, captions, image order, and uploaded media
IDs. LinkedIn verifies the current author, private `DRAFT` lifecycle, title,
text/link structure, image order, alt text, captions, and stable asset URNs.
Never continue into publication.

## Handle uncertainty

Do not retry a partial or indeterminate image save. An upload may have produced
a provider asset even when its stable identity never entered the confirmed
result. Preserve the run, inspect the exact private draft, and do not search by
title, guess an ID, repeat uploads, switch transports, or publish as recovery.

Current image-capable X and LinkedIn draft contracts deliberately have no
automated reconciliation path. Only already-durable historical text-only
contracts retain read-only replacement reconciliation for an exact confirmed
`draft_id`; that historical route is never selected for a new preview.

## Check provider state

- `x`: the documented OAuth adapter has separate response-bound private-draft
  and publish operations with its own plain-text/optional-cover schema. It is
  not a substitute for `x-web` and does not accept this mixed document.
- `x-web`: `articles.draft.save@2` creates or replaces one private structured
  Article with native links, styles, ordered inline images, and captions, then
  verifies the unpublished result. Alt text and covers remain
  capture-required; `articles.publish` remains capture-required.
- `linkedin-web`: `articles.draft.save@3` creates or replaces one private
  paragraphs/headings/links Article with ordered inline images, required alt
  text, and optional captions, then verifies the exact current-author
  unpublished result. Styles, lists, blockquotes, covers, and
  `articles.publish` remain capture-required.

Never switch between an official API and a signed-in web adapter because one
lacks a field or publishing capability.
