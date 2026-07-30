# Platform capability patterns

Use this guide to select capture evidence, operation semantics, and risk; it is rollout policy, not a capability matrix. Treat `wrench capabilities` as the sole installed-contract view. The bundled registry includes every requested surface, but only independently live-proven contracts are `observed`; every other entry is an inert `capture-required` reservation. A heading, policy row, implemented candidate, captured exchange, browser login, or planned operation is never a support claim.

## Apply one transport rule everywhere

Implement a supported signed-in operation as a code-owned first-party internal API contract. Use a browser only to capture the exchange, bootstrap an authenticated realm, and recover a reviewed current dynamic token or registered-operation revision. Do not ship DOM clicking as the operation or fallback.

Prefer a public protocol or documented official API when it exposes the exact required surface and account authority. Keep it as a distinct `provider-api` contract. A pinned linked-device protocol runtime, such as WhatsApp's, is also a distinct auth and transport realm. Do not silently switch among it, an official API, and the consumer site's `web-session-api` contract.

Add operations in this order:

1. one bounded R1 read with explicit completeness and no acknowledgement traffic;
2. one low-stakes desired-state R2 mutation;
3. one R3 message/comment/post with exact account, target, request, and response bindings;
4. media and multi-dispatch workflows only after single-dispatch behavior is proven.

Leave the state `capture-required` when current evidence is absent, ambiguous, entitlement-specific, or drifted. Never infer parity from another platform or another facet of the same company.

## LinkedIn

- Use `linkedin-web` with a browser-session/cookie realm for consumer Home feed, inbox folders, conversations, and native article-editor surfaces. The separate official `linkedin` OAuth adapter covers approved post, comment, reply, repost, and reaction scopes; it does not supply the consumer Home feed or inbox.
- No current LinkedIn web operation is observed. `messaging.list` was observed in archived bundle 1.1.0, but current bundle 1.2.0 demotes it after durable current-account projection drift; every directly exported semantic execution path refuses before cookie acquisition, browser bootstrap, or network traffic.
- Every LinkedIn web operation remains capture-required. Explicit reservations cover inbox folders, one member profile, one organization Page, one bounded page of recommended connections, and one connection invitation; none has an executable internal request. Article, feed, relationship, message, post, and comment evidence does not graduate without exact current variables, bounded target-bound projections, member binding, completeness, and acknowledgement-free behavior.
- Exclude presence, messaging badges, delivery acknowledgements, seen/read receipts, and notification badge traffic from every R1 contract.
- Bind the current viewer's person/member identity to the auth realm. `organizations.read` views a Page and does not confer Page-actor authority. For organization actions, additionally bind the administered organization actor selected by the plan.
- Treat messages, posts, comments, replies, reposts, quotes, connection requests, and native article publication as R3. Treat reversible reaction/follow/save desired state as R2 only after both create and delete exchanges are captured.
- Keep `messaging.send`, `relationships.connect`, post/comment mutations, reactions, and native article publication `capture-required` until their exact request, response, actor, and target contracts pass a low-stakes fixture. `comments.create` targets a post rather than a profile/Page itself. Never send through a textbox fallback.
- Every available LinkedIn realm returned `401` at current-account preflight during verification on July 23, 2026. A fresh authenticated realm is necessary but not sufficient: recapture and review the current mailbox projection before promotion. Browser control is not an authentication or action fallback.
- Avoid employment and recruiting threads as fixtures.

Read [linkedin-adapter.md](linkedin-adapter.md) before changing the LinkedIn registry.

## X

- Use `x-web` for consumer For You/Following/user/List/search/bookmark feeds, post/conversation reads, inbox/request folders, and consumer publishing surfaces. The separate official `x` OAuth adapter covers documented reverse-chronological/user/mentions/List/recent-search/bookmark feeds and approved writes, but never For You. Keep encrypted X Chat separate from both.
- Current GraphQL query IDs, feature sets, and authorization/CSRF material are dynamic inputs to owned code, not manifest fields. Resolve each by an exact reviewed source and require one unambiguous current value.
- The observed R1 set includes feed, post, and reply-tree reads. Authorized direct live evidence for the current contract version covers For You, bookmarks, one exact post, and its comments. DM folder and conversation reads remain capture-required because current X Chat events require the separate reviewed key-recovery and acknowledgement-free contract. Native Article reads remain capture-required where entitlement changes the exchange.
- Never pair a sliced provider page with its end cursor. Return the cursor only after projecting the complete matching page; fail closed on an over-limit page. Require user and List responses to echo the exact requested identity.
- `likes.set` and `content.save` are the only observed X web writes. Prior reversible fixtures proved exact like/bookmark desired state: the transaction header, create/delete response, account/target binding, and independent post readback passed false → true → false with the original false state restored. Text post, self-thread, reply, repost, and quote mutations remain capture-required.
- Keep DM list/read/send, media variants, native Article operations, and every other mutation capture-required until their cryptographic, request/response, and account/target bindings are complete. Never open the composer as a fallback.
- Bind the current X user ID before private reads and mutations. Bind reply/quote/root IDs and every returned created post ID in ordered threads.

Read [x-adapter.md](x-adapter.md) before changing the X registry. Treat encrypted X Chat plaintext/send as a separate cryptographic contract, not a normal HAR template.

## Reddit and Hacker News

- Prefer public capture for posts, comments, and Hacker News item trees.
- Use an authenticated internal client only for user-specific inbox, saved, vote, submit, or comment operations that public capture cannot perform.
- Reddit currently has live-proven direct feed, post, comment-tree, inbox-list, and exact legacy-message reads. Hacker News currently has live-proven direct feed, post, and ordered comment-tree reads.
- Reddit vote/save request builders and readbacks are deterministic-test proven but remain capture-required because no authorized low-stakes live fixture was run. Every Reddit/Hacker News write remains capture-required.
- Comments, replies, submissions, and messages are R3. Votes, favorites, saves, and follows are R2 desired state. Deletion and moderation stay R4.
- Bind the logged-in username/account ID, exact parent item, community, and returned created item/comment ID.
- If automation or network defenses reject the request, report the block. Do not imitate a different client or use DOM clicks.

## WhatsApp Web

- Browser cookies and Arc profile storage are not WhatsApp protocol authority. Use a separate private `linked-device-store` realm backed by the exact pinned `wacli`/whatsmeow release; pairing requires the normal WhatsApp linked-device QR or phone flow.
- Keep inbox/message/media R1 reads offline against the private SQLite projection. Pairing and explicit sync are separate network operations because even connection setup can emit protocol acknowledgements.
- WhatsApp chat listing, exact-conversation reading, and exact attachment-metadata reading are live-proven through the public CLI against the account-bound, read-only local SQLite projection. They do not open a WhatsApp connection or emit acknowledgements.
- WhatsApp send/reaction/edit/forward candidates remain capture-required; code-owned planners and parsers do not by themselves constitute support.
- Text/media send, reaction, edit, and one-message forward need separate target-bound fixtures. Sends/forwards/edits are R3; star/save and reversible reaction may be R2.
- Bind the linked-device LID and optional phone-number identity, exact conversation, message, sender, and returned message ID. Keep group/community administration and deletion R4.

## Substack

- Use capture for public or entitled articles. Never bypass subscription or payment gates.
- Live-proven direct R1 coverage currently includes reader/Notes feeds, exact Notes/posts, articles, comments, media metadata, and inbox thread listing. Message reads and every mutation remain capture-required.
- Capture Notes, comments, chats, likes, saves, follows, restacks, and publisher-editor exchanges separately. A custom publication host remains one exact origin.
- Comments, replies, Notes, chats, restacks, and article publication are R3. Likes, free follows, and saves may be R2. Paid membership, pledges, purchases, audience administration, and access changes stay R4.
- Bind the signed-in account, publication identity, draft/article ID, audience, and returned published URL/ID.

## Instagram, Threads, and Facebook

- Treat Instagram, Threads, Facebook Page, Facebook Group, and Facebook Marketplace as separate surfaces and auth/account bindings even when Meta shares infrastructure.
- Live-proven direct R1 coverage currently includes Instagram feed/post/media/comment/inbox summaries, the Threads feed, Facebook's bounded initial personal home-feed bootstrap, one exact Group's bounded first feed page, the Marketplace browse feed with cursor continuation, and one exact Marketplace listing. Every result is exact-current-user bound; Group and Marketplace reads additionally bind their exact numeric targets.
- The personal Facebook home result makes no completion or pagination claim. The Group reader assembles only the complete first streamed page and never exposes its provider cursor because the matching continuation query is not yet reviewed. Marketplace reads use a direct inert HTML bootstrap, resolve the current registered Relay revision from bounded canonical first-party bundles without executing them, and assemble each complete streamed page before returning a locally authenticated, account/descriptor/target/chain-bound cursor envelope. A locally truncated projection returns no cursor so it cannot skip unreturned listings. Exact listing reads use the inert bootstrap so the browser-only item-seen mutation is never executed.
- Facebook personal Messenger listing is capture-required: the current route and folder queries, paging and completeness, and acknowledgement/presence behavior are not proven. Every Meta write, all message reads/sends, every Facebook Page operation, and all Group operations except the exact first-page feed read remain capture-required. Marketplace messaging and mutations remain capture-required; its observed feed/listing reads do not confer publishing, seller, conversation, or purchase authority.
- Capture each surface's exact first-party GraphQL/REST exchange and dynamic token source. Do not copy an operation name, revision, feature set, or actor binding across surfaces.
- DMs, comments, replies, posts, stories, reels, shares, Page messages, Group posts, and Marketplace listing publication are R3. Reversible likes, reactions, follows, and saves may be R2.
- For Facebook, bind Page/profile/group/Marketplace actor and target independently. Keep roles, ads, business settings, member moderation, purchases, payments, shipping commitments, and deletion R4.
- For Marketplace publication, bind title, body, price, currency, category, condition, location, delivery, images, seller identity, and returned listing ID. Never accept UI defaults as reviewed input.
- Keep each remaining operation capture-required until its exact current exchange and account/facet binding are reviewed. A modal or accessible label is not an API contract.

Read [meta-comet-contract.md](meta-comet-contract.md) before changing a
Facebook internal-API operation.

## TikTok and YouTube

- Use capture/media archive for accessible non-DRM video, metadata, and transcripts.
- TikTok currently has live-proven direct signed-in feed and comment reads. YouTube currently has live-proven direct feed, video metadata, Community-post, and comment reads.
- YouTube like, Watch Later, and subscription candidates have deterministic request/readback tests but remain capture-required until an authorized reversible live fixture passes. Every TikTok mutation and every YouTube comment/post/upload mutation remains capture-required.
- Capture signed-in feed, notification, comment, save, follow, DM, Studio, and upload exchanges independently. Do not reuse yt-dlp or capture cookies as an unrestricted action client.
- DMs, comments, replies, posts, and uploads are R3. Likes, follows/subscriptions, and saves may be R2. Commerce, promotion, monetization, copyright declarations, live streaming, audience changes, and account administration remain R4 or require a narrower system.
- Bind the current creator/channel account, exact media bytes, target item/channel, audience, and returned provider ID.

## Bluesky

- Prefer the public AT Protocol for public reads and a reviewed authenticated protocol module when it exactly covers the requested account action. Keep browser-session auth separate if consumer web capture is still needed.
- The strict direct XRPC runtime live-proves bounded feed, post, thread, and media projections against the selected signed-in DID. DM reads and every mutation remain capture-required until exact nonempty fixtures or authorized write evidence exist.
- Bootstrap the exact engine-affine profile from `BSKY_STORAGE`. When its access JWT expires, rotate it only through the selected account's allowlisted PDS `com.atproto.server.refreshSession` procedure; bind both token subjects and the response DID, then retain the rotated pair only in the encrypted auth-hash-bound session cache.
- Posts, replies, DMs, quotes, reposts, and ordered threads are R3. Likes, follows, and saves are R2 desired state.
- Bind the DID/account, repository record keys, parent/root references, and every returned URI/CID. Stop an ordered thread on partial or indeterminate delivery.
- Never expose a generic AT Protocol request surface through wrench.

## Add another service

1. Prove capture first.
2. Record one exact first-party R1 exchange in a managed HAR.
3. Add a code-owned site/action registry entry in `capture-required` state.
4. Implement fixed request/response, token, account, actor, target, and bounds contracts.
5. Promote to observed only after deterministic and authorized low-stakes live tests.
6. Add R2/R3 operations one at a time through the normal preview, ledger, and receipt path.

Do not call a service supported until the installed operation is observed, the auth realm is account-bound, and current preflight passes. Browser access alone proves none of those conditions.
