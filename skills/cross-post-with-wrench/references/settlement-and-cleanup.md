# Settlement and duplicate cleanup

Use this after every confirmation and before any possible repost or deletion.

## Settle one publish attempt

1. Run `wrench runs show <run-id> --json` and append the result state to the task ledger.
2. Record any response-bound provider locator. Do not recover a target by text search, profile-feed position, or approximate time.
3. For `submitted`, use the publish contract's independently verified readback evidence. When it does not establish external availability and an observed `posts.read` accepts the exact returned locator, invoke that exact R1 schema and record the observation.
4. For `pending`, `partial`, or `indeterminate`, preserve all evidence. Run `wrench runs reconcile <run-id> --json` only when the installed exact contract advertises reconciliation. Reconciliation is read-only, append-only, and never repeats the mutation.
5. Treat an absent or inconclusive read as unresolved, not as proof that the write never happened. Repeat only the bounded read/reconciliation when supported; never repeat the mutation.
6. For pre-dispatch `failed`, create a new preview only while the exact original action remains authorized.

If a current legacy reconciler explicitly requests original input, supply only the exact confirmed input that Wrench verifies against the receipt. Never reconstruct or alter it to force a match.

## Keep an exact duplicate ledger

Maintain a private append-only event ledger with one attempt row containing:

- package identity and exact scalar-input hash;
- ordered attachment hashes and media types;
- platform, adapter, transport, auth-realm label, and bound subject;
- plan digest and expiry, run ID, and current run state;
- exact provider locator returned or retained after acceptance;
- readback kind and first observed time;
- `duplicate-risk-of` links to earlier attempt run IDs;
- any canonical delete plan/run and exact post-delete proof.

Do not put credentials, cookie values, response bodies, post text, or original local paths in the ledger. Never merge two attempts because their text looks alike. Record one provider object per exact locator, including an intentional duplicate.

## Create a fresh duplicate-tolerant intent

Only proceed when the user freshly authorizes the exact platform, exact package, and possibility that each named unresolved run already created the post. Before previewing, append `duplicate-risk-of` links to those runs. Then perform the ordinary capability check, new preview, review, and one confirmation.

This does not settle or replace an older run. Keep its Wrench ledger and recovery material intact, and reconcile it separately when exact evidence becomes available.

## Delete a proven duplicate

Deletion is eligible only when all of these are true:

1. The exact provider locator is in the duplicate ledger.
2. An observed exact `posts.read` proves the object, current-account authorship, and content/media binding before deletion.
3. The same installed adapter exposes canonical `content.delete` as observed and executable. An absent or `capture-required` operation, or an R4 runtime block, means deletion is unavailable.
4. Its schema accepts that exact locator; the preview binds the account, target, side effect, and contract; and the user confirms that digest once.
5. A separate exact post-delete R1 contract proves a target-bound tombstone or exact not-found result whose reviewed semantics establish deletion. General feed absence is not proof.

If deletion becomes `pending`, `partial`, or `indeterminate`, preserve it and reconcile only through its advertised exact readback. Never retry deletion. Never substitute `posts.delete`, another semantic name, direct browser interaction, raw HTTP, or capture replay for `content.delete`.

## Report availability time precisely

Keep these times distinct:

- plan creation/confirmation: local authorization, not publication;
- dispatch start/finish: Wrench transport timing, not external availability;
- provider-created time: a provider-authored value, when strictly bound;
- first observed time: when exact independent readback saw the object.

Report first observation as “available no later than” that time; the actual visibility onset may have been earlier. When readback remains unresolved, say “provider accepted” only when proven and “external availability unverified.”
