# WhatsApp local Message Like Me export

Use this reference to turn one existing account-bound Wacli projection into a
private Message Like Me bundle. The export reads local state. It does not pair
a device, synchronize WhatsApp, open a network connection, or send a message.

## Runtime identity

Wrench pins the official macOS arm64 Wacli v0.15.0 release at commit
`a020de724180d31eccfa5241d45443402d62fb06`.

- Official archive: `wacli_0.15.0_darwin_arm64.tar.gz`
- Archive SHA-256:
  `2b54f33d246e913a5c33525b4fc895a345363c2dcc673c70fa5f19cffb15d17d`
- Executable SHA-256:
  `a900af4d0dfd10471bcdf74105b9f256d1a08574242a041df3e5985a548826aa`
- Code-signature identity: `org.openclaw.wacli`, OpenClaw Foundation Team ID
  `FWJYW4S8P8`

Run `wrench operator doctor --json` to locate the release-matched installer.
The installer checks the official release, both SHA-256 values, the offline
code signature, hardened runtime, trusted timestamp, designated requirement,
and online notarization before it publishes the executable. Runtime reads
repeat the official release, exact executable SHA-256, and offline
code-signature checks. They do not claim to repeat online notarization.

## Export one private bundle

Use a bound WhatsApp auth ID whose existing local store contains `session.db`
and `wacli.db`. Choose a new normalized absolute output directory below an
owner-controlled parent:

```sh
wrench whatsapp export-message-like-me --auth whatsapp-main \
  --output /absolute/private/path/new-whatsapp-bundle --json
```

The auth ID is lowercase kebab case with at most 48 characters. The output
path is a non-root absolute path of at most 4,096 UTF-8 bytes with no NUL,
carriage return, or line feed. The destination must not exist.

Wrench holds one durable private-export admission across recovery, helper
launch, conversion, cleanup, and publication. It validates the bound store's
owner, mode, physical identity, schema, integrity, sidecars, account identity,
and immutable generation. One detached helper keeps the databases open across
bounded row-ID pages and seals its final counts, checkpoint, self aliases, and
rolling canonical-frame SHA-256. Wrench publishes a result only after the
complete helper stream and exact child exit settle.

## Bundle identity

The output is Message Like Me local-message bundle schema 2:

- source `wacli-local@1.0.0`;
- provider `whatsapp@0.15.0`;
- network `whatsapp`;
- immutable consumer `@hraness/message-like-me` v0.7.0;
- six NDJSON artifacts plus `manifest.json`.

Wrench imports Message Like Me's public schema-2 constants, parser, and types.
The standalone release gate runs the real Message Like Me v0.7.0 CLI against a
Wrench-generated seven-file bundle.

The output directory is mode `0700`; its files are mode `0600`. Wrench writes
and verifies a complete sibling staging directory, then publishes it with one
atomic rename. A partial directory never appears at the requested path.

## Included and excluded evidence

The bundle can retain locally stored message bodies, bubble boundaries,
reply IDs, attachment metadata, and only edit or deletion state proven by the
fixed projection. It excludes credentials, protocol and media keys, media
bytes, source paths, local media paths, status chats, broadcasts, newsletters,
and unsupported non-conversation rows.

The helper derives at most the bound account's exact phone-number (PN) and
linked-identity (LID) self aliases from the unique device row. It filters a
message-yourself chat for either alias before message content crosses the
helper boundary. It does not guess identity from digits.

Reaction rows are excluded. Wacli v0.15.0 cannot prove whether a stored
reaction is still active or was removed, so every applicable bundle reports
`reaction-state-unproven` instead of publishing retained reaction state.

## Completeness

The receipt reports:

- completeness kind `bounded-local`;
- reason `local-store-coverage-unknown`;
- warning `remote-history-incomplete`;
- exactly one account, zero reactions, and zero tombstones.

`observedFrom` and `observedThrough` describe the admitted local messages only.
A successful export does not prove that remote WhatsApp history has finished
backfilling. Additional warnings report excluded self chats, purged message
payloads, or excluded non-conversation chats when those conditions occur.

Keep the bundle private. It contains message bodies and stable account,
conversation, participant, and message evidence even though credentials,
paths, and media bytes are excluded.
