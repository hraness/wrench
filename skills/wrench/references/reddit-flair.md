# Reddit flair

Inspect `wrench capabilities reddit-web --json` before using flair. The
`flair.user.choices`, `flair.post.choices`, `flair.user.select`, and
`flair.post.select` contracts are currently **capture-required**. Their schemas
are reserved and tested, but they perform no authenticated request. Do not
report that Wrench can apply flair until the installed contract is observed
and a same-account live readback passes.

## Choose flair under the caller's authority

When the user authorizes appropriate flair selection, choose it without asking
them to pick a label. Read the community's current rules, including expanded
authorship restrictions, and its live self-selectable choices. Post flair
classifies one contribution. User flair represents the account within one
community and can be required even for comments.

Match post flair to the content and use a required promotion category honestly.
Preserve an appropriate existing user flair. Otherwise choose a neutral label
or a role supported by the user's stated facts. Do not invent an occupation,
credential, diagnosis, housing status, or moderator role. Skip a destination
with no truthful choice. Flair does not make a prohibited contribution eligible.

The caller owns this decision. Wrench supplies the account-bound options and
exact mutation boundary; it does not infer personal facts or run a growth loop.

## Complete the live contract before enabling it

Use [managed derivation](derivation.md) for one explicitly authorized account,
community, and low-stakes selection. Verify the displayed account against the
outreach account before recording or changing anything. An existing browser
auth locator may belong to a different account; never silently substitute it.

Capture user choices and post choices separately. Bind the exact response to
the current account and community, project template IDs, labels, eligibility,
and existing selection, and reject duplicate IDs or incomplete choice sets.
For a post, prove that it belongs to the same account and community. The
[Reddit API reference](https://www.reddit.com/dev/api/) and
[PRAW's submission flair documentation](https://praw.readthedocs.io/en/stable/code_overview/other/submissionflair.html)
describe choices and selection; they do not prove an authenticated-web exchange.

The select contracts accept an exact template ID and its expected label, not
an arbitrary username, custom text, or moderator assignment. Before dispatch,
freshly read choices and reject a missing, changed, or non-self-selectable
template. Preserve an already selected matching flair without a mutation.
User selection is R2; changing flair on an existing public post is R3.

Keep the exact five-minute Wrench preview and durable dispatch boundary.
Standing user authority lets the calling agent review and confirm its eligible
plan without requesting redundant approval. Confirm once and verify exact
account, community, post when relevant, template ID, and visible label through
independent readback. Treat uncertain writes as indeterminate, never retry them
blindly. A setup-only flair change is not a new public contribution.

Before promoting either contract, test account drift, wrong-post ownership,
template changes, moderator-only choices, duplicate labels, denied selection,
unexpected content type or redirect, and uncertain dispatch. Keep the other
contracts capture-required if their evidence is missing. No DOM recipe, raw
request fallback, or guessed endpoint belongs in the installed provider.
