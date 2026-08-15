# Native article drafts

Use `articles.draft.save` to create or replace one private native long-form
draft. Treat it as an R2 mutation with its own exact preview, confirmation,
dispatch record, and installed result or readback contract. It has no
publish-capable branch.

Keep `articles.publish` separate. Publication is R3 and requires a distinct
installed observed contract, input, preview, and confirmation. A saved draft
ID is not permission to publish, and a draft preview cannot be reused for the
publish operation.

## Own the editorial translation

Capture or read source material separately. Let the caller decide how to
translate, abridge, retitle, attribute, or link it for the destination. Wrench
does not turn source HTML, Markdown, or a URL into provider copy and does not
infer attribution. Pass only the final reviewed title and canonical document
to the mutation.

## Build the text document

When the installed capability declares `input.document`—currently the
authenticated `x-web` adapter—encode it as canonical JSON for
`ArticleDraftDocument` schemaVersion 1. Use only these text blocks:

- `paragraph`
- `heading1`
- `heading2`
- `blockquote`
- `unordered-list-item`
- `ordered-list-item`

Represent a native link with an ordered, non-overlapping range over the
block's UTF-16 text and one canonical absolute HTTPS URL. Represent bold,
italic, or strikethrough with style ranges. Put each paragraph or list item in
its own block; block text cannot contain a newline.

Do not pass Markdown links, HTML, embeds, image blocks, cover images, files, or
provider editor payloads. This contract is text and native HTTPS links only.
Inspect the installed capability for provider-specific title, block, character,
and document bounds.

This canonical document links the word `source`:

```json
{"blocks":[{"links":[{"length":6,"offset":9,"url":"https://example.com/source"}],"text":"Read the source","type":"paragraph"}],"schemaVersion":1}
```

Place that exact JSON string inside a private invocation input file:

```json
{
  "title": "Reviewed title",
  "document": "{\"blocks\":[{\"links\":[{\"length\":6,\"offset\":9,\"url\":\"https://example.com/source\"}],\"text\":\"Read the source\",\"type\":\"paragraph\"}],\"schemaVersion\":1}"
}
```

Add `draft_id` only to replace the exact existing private draft owned by the
bound account.

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

Review the exact account, title, canonical document, optional draft ID, R2 side
effect, contract version, and dispatch schedule. Require a successful result to
identify `articles.draft.save`, report `published: false` and `mode: "draft"`,
and return the private draft identity. Never continue into publication.

Do not retry a partial or indeterminate save. Preserve the run evidence and use
only the installed operation's exact recovery path for the same bound draft.
An `x-web` replacement with an exact input
`draft_id` has that read-only reconciliation path. An indeterminate `x-web`
create does not: its immutable confirmed input contains no exact target ID, so
leave the run unsettled rather than searching by title, guessing an ID, or
retrying. Do not inspect an uncertain draft and then call `articles.publish` as
a recovery step.

## Check provider state

- `x`: the documented OAuth API exposes separate observed contracts. Its R2
  `articles.draft.save` creates one private plain-text draft with an optional
  cover and stops after binding the create response's draft ID and title. It
  does not make a separate unpublished read. Its R3 `articles.publish` creates
  and publishes through its own response-bound contract; it does not claim a
  separate public readback. Neither accepts
  `draft_only` for a new preview; inspect the official capability for its exact
  input schema. The retained `articles.publish@2` route exists only to recover
  already durable v2 evidence with its exact historical semantics.
- `x-web`: `articles.draft.save` is observed for a bound signed-in X account.
  It creates or replaces one private text-and-links Article draft and verifies
  the unpublished result. `articles.publish` remains capture-required.
- `linkedin-web`: `articles.draft.save` remains capture-required. Keep it inert
  until a managed capture proves the exact editor autosave, stable draft
  identity, current-member binding, and exact unpublished readback.
  `articles.publish` remains a separate capture-required R3 operation.

Treat `wrench capabilities <adapter> --json` as authoritative for the installed
version. Never switch between an official API and a signed-in web adapter after
preview because one lacks draft or publish coverage.
