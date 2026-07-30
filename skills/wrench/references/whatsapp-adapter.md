# WhatsApp linked-device protocol adapter

Use this reference when adding, pairing, synchronizing, testing, or promoting
the `whatsapp-web` adapter. Despite the historical adapter ID, its runtime is
not browser automation and does not reuse a WhatsApp Web cookie/profile.

## Transport and pin

wrench uses the linked-device protocol implemented by
`github.com/openclaw/wacli` v0.13.0 at commit
`1e15f646d23598ef5db2bdb4659ac39cc5188ad2`. That release uses
`go.mau.fi/whatsmeow` for the encrypted Noise/Signal WebSocket protocol. It
does not include Chromium, Puppeteer, Selenium, `whatsapp-web.js`, DOM
selectors, or HAR replay.

The macOS arm64 installer pins both the release archive and extracted binary
SHA-256, then verifies the OpenClaw Developer ID team and hardened signed
binary before publishing it:

```sh
sh ./src/scripts/install-whatsapp-protocol.sh
```

`wrench operator doctor` reports categorical readiness and this exact setup command.
Runtime resolution accepts only fixed paths and the exact pinned binary hash.

## Auth realm and persistence

A WhatsApp linked device is a different authority realm from Arc, Chrome,
cookies, and OAuth:

```sh
wrench auth add whatsapp-main --linked-device whatsapp
wrench auth pair whatsapp-main
```

Use `--phone +<international-number>` on `auth pair` to request a phone
pairing code instead of scanning a QR code. Pairing creates a new linked
device; an existing Arc WhatsApp login cannot be imported into it.

The default store is:

```text
$WRENCH_STATE_HOME/linked-device-stores/<auth-id>/
```

It contains:

- `session.db`: device identity, Noise/Signal protocol keys, device mappings,
  and session state;
- `wacli.db`: the local message/chat projection and search index;
- private SQLite sidecars and operational lock/socket files when needed.

wrench requires an owned real mode-`0700` directory and owned files/sockets
with no group or world access. It rejects symlinks and permission widening
before trusted reads. The protocol client creates database files mode `0600`.
wrench never returns, logs, copies into a plan, or projects raw protocol keys,
media keys, direct media paths, or local media paths.

This is filesystem permission isolation, not application-level encryption of
SQLite at rest. Use FileVault or equivalent full-disk encryption for protection
against offline disk access. Removing an auth locator does not delete the
linked-device store or invalidate the phone-side linked device.

## Sync is explicit and stateful

Local list/read/media metadata operations never connect to WhatsApp. Refresh
the projection explicitly:

```sh
wrench auth sync whatsapp-main --once
```

Sync is bounded to 200,000 messages and 2 GiB, uses quiet global presence,
does not request media downloads, exits after becoming idle, and limits
reconnection time. A sync connection still emits required transport-level
protocol acknowledgements. It is therefore an explicit operational action,
never an implicit prelude to an R1 read.

The local projection has no provider completeness guarantee. Results describe
only the currently stored bounded projection; no cursor is exposed because a
timestamp-only cursor can skip messages sharing the same timestamp.

## R1 read design

The fixed read commands always include both the CLI flag and environment
enforcement:

```text
--store <bound-store> --read-only --json --full --timeout <bound>
WACLI_READONLY=1
```

`wacli` opens both SQLite databases with `mode=ro&_query_only=1`; it does not
open a WhatsApp session, run migrations, create WAL files, update badges, mark
messages read, send delivery/read receipts, or emit transport acknowledgements.

The code-owned semantic mapping is:

- `messaging.list` → bounded `chats list` with exact all/active/archived/unread
  filters;
- `messaging.read` → bounded `messages list --chat <exact-JID>`;
- `media.read` → metadata-only `messages show --chat <exact-JID> --id
  <exact-message-ID>`.

Every private read probes `auth status` from `session.db` in read-only mode and
requires its stable phone/LID subject to equal the auth realm binding. Every
returned message must equal the exact requested canonical conversation JID.

All three operations are `observed`. An authorized paired account passed
nonempty chat, exact-conversation, and exact-attachment fixtures through the
public wrench CLI with stable account binding and the pinned read-only local
projection. They retain the local-store completeness label and fail closed on
schema, account, conversation, message, or byte-bound drift.

## Mutation boundary

wrench owns fixed planners and strict response/readback parsers for:

- text or one attachment send;
- reaction set/clear;
- recent self-message edit;
- one-message forward.

It accepts only canonical user, LID, or group JIDs—never recipient names,
arbitrary flags, URLs, subcommands, or raw protocol payloads. A future
executable mutation must mark dispatch before the request can leave and verify
one independently read local message bound to the account, target, response
ID, and confirmed content.

All mutations are currently `capture-required` and perform no protocol
request. The pinned `wacli` CLI retries selected send failures once and places
message text in process argv. Both conflict with wrench's no-automatic-retry
and private-payload requirements. Promotion requires a reviewed no-retry
module or private stdin/Unix-socket payload channel plus authorized low-stakes
fixtures. Do not flip contract state around those requirements.

Star/unstar has a read projection but no reviewed mutation. Community/group
membership, administration, deletion/revoke, profile changes, calls, polls,
channels, and presence remain unsupported or R4.
