# Native article drafts

## Contents

- [Own the editorial translation](#own-the-editorial-translation)
- [Build the mixed document](#build-the-mixed-document)
- [Project source-post embeds](#project-source-post-embeds)
- [Save without publishing](#save-without-publishing)
- [Read one saved X draft](#read-one-saved-x-draft)
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

`linkedin-web` requires one outer `input.cover_image` JPEG, PNG, or WebP file
up to 5 MiB when creating a draft. Supply it on replacement only to replace
the banner; omit it with an exact `draft_id` to preserve the independently
read existing banner without another cover registration or transfer. A
supplied cover is a separate plan-bound attachment and does not
implicitly create a document `image` block or appear in `input.inline_images`.
For a cover-only source asset, keep it out of the body; include the same bytes
as an inline image only when the reviewed article intentionally shows them in
both places.
Wrench registers it as `PUBLISHING_COVER_IMAGE`, transfers the exact bytes,
binds the returned asset only through LinkedIn's `coverMediaV2Union.coverImage`
autosave, and independently verifies both saved cover projections. The current
contract writes an empty cover caption. `x-web` cover saving remains
capture-required.

Provider text support remains narrower where capture evidence is narrower:
`linkedin-web` accepts `paragraph`, `heading1`, `heading2`, and `blockquote`, native
HTTPS links, and no text styles. `x-web` accepts all listed text block types,
native links, and bold, italic, or strikethrough.

## Project source-post embeds

Treat a source X status as editorial content, not as provider editor payload.
Do not copy its profile chrome, timestamp, engagement counts, or screenshot of
the rendered card into an Article by default. Do not assume that pasting a URL
creates a proprietary embed.

Use the exported `projectXStatusArticleEmbed` helper with the exact status text,
canonical source URL, and destination adapter. It removes share-tracking query
parameters and emits the status URL as one native linked paragraph immediately
after the content:

- `x-web` and `linkedin-web`: emit each non-empty source line as a native
  `blockquote`.

Preserve media attached to the source status only when the user explicitly
wants that media as independent Article images. Otherwise keep the quote and
status link only. The helper does not fetch a status, infer its text, upload
media, or claim that either provider created a native embed card.

```ts
import { projectXStatusArticleEmbed } from "@hraness/wrench";

const blocks = projectXStatusArticleEmbed({
  text: "Exact source-post text",
  url: "https://x.com/example/status/123?s=20",
}, "x-web");
```

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
Also add a sibling `"cover_image":"/absolute/private/banner.jpg"` to the
outer invocation object when creating or replacing the banner; keep the banner
out of the document blocks and out of `inline_images`. For a replacement that
must retain its existing banner, omit `cover_image` and keep the exact
`draft_id`.

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
reviewed current single-upload registration, signed byte-transfer, autosave,
and editor-response readback contract inside contained headed Chrome. The reviewed editor proceeds
from the transfer's `201` response directly to autosave; Wrench does not invent
a processing poll that the editor does not perform. The window may appear, but
Wrench does not type into or read the editor DOM, and callers cannot supply a
URL, header, script, or selector.

Review the account, title, canonical document, separate cover hash, ordered inline attachment hashes,
optional draft ID, R2 side effect, contract version, and every planned
dispatch. X plans one dispatch per image followed by create, or image uploads
then title and content replacement. LinkedIn create plans the title shell,
cover, each inline image, then content; replacement plans cover, each inline
image, then one conservative title/content replacement.

Require a successful result to identify `articles.draft.save`, report
`published: false` and `mode: "draft"`, return the private draft identity, and
report the exact cover and inline image counts. X verifies the owner, private Draft lifecycle,
title, text/link/style structure, captions, image order, and uploaded media
IDs. LinkedIn verifies the current author, private `DRAFT` lifecycle, title,
separate cover asset, text/link structure, inline-image order, alt text,
captions, and stable asset URNs.
Never continue into publication.

## Read one saved X draft

This section documents unreleased source-main preparation. The current npm
release does not contain `articles.read@2`; do not invoke it until an immutable
release includes the contract and `wrench capabilities x-web --json` lists it.

`x-web articles.read@2` reads one exact current-viewer-owned private Article
draft by its 1–19 digit provider ID. It is an R1 operation, uses the same bound
X cookie realm, and never enters the mutation dispatch ledger.

```sh
wrench x-web articles.read \
  --input '{"article_id":"1234567890123456789"}' \
  --auth x-main --json
```

The closed result identifies `provider: "x"` and `operation: "articles.read"`.
Its `article` binds the requested ID, current viewer's owner ID,
`kind: "private-draft"`, `lifecycle: "Draft"`, `published: false`, one bounded
single-line title, and bounded rich content. The contract fails closed if the
Article is missing, published, not in the Draft lifecycle, or owned by another
account.

This operation does not list drafts or read published X Articles. LinkedIn
Article reads remain capture-required; do not infer them from
`linkedin-web articles.draft.save` or switch transports to fill the gap.

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
  verifies the unpublished result. `articles.read@2` separately reads one exact
  current-viewer-owned private Draft. Alt text, covers, published Article reads,
  and `articles.publish` remain capture-required.
- `linkedin-web`: `articles.draft.save@7` creates or replaces one private
  paragraphs/headings/blockquotes/links Article with one separate new or preserved banner plus
  ordered inline images, required alt text, and optional captions, then
  verifies the exact current-author unpublished result. Styles, lists,
  `articles.read`, and `articles.publish` remain capture-required.

Never switch between an official API and a signed-in web adapter because one
lacks a field or publishing capability.
