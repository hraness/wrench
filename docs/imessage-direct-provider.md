# Direct iMessage provider

The `imessage` source plugin wraps one exact reviewed `openclaw/imsg` build. It
supports bounded local chat and message reads plus confirmed one-to-eight-bubble
turns to an exact live chat GUID. The mutation path is fixed to AppleScript and
`iMessage`, with SMS fallback disabled.

The plugin does not select an Apple ID. Messages chooses the device-default
account and routing identity. `account_id`, `account_login`, and
`last_addressed_handle` from `chat.db` are observations for route inspection,
not a selectable or proven sending account. The auth subject binds a canonical
local Messages store coordinate and this device-default policy. It does not
claim to identify the signed-in Apple account.

## Reviewed transport

The vendored patch stack applies to `openclaw/imsg` 0.14.1 at commit
`25beb76c902b0acf2dd7ae392f1b0792f6813240`. The first commit,
`292db82d89293867ef847a2875667fea0fdd5dc1`, isolates AppleScript payloads.
The second, `c5994f00d17969fd7772fd2772e7b3591089513a`, adds the read-only exact
`chats.get(chat_id)` lookup required to revalidate a route without relying on a
bounded recent-chat scan. Patch SHA-256 values, changed files, and the full
artifact review boundary are recorded in
`src/plugins/imessage-direct/vendor/provenance.json`.

AppleScript source remains on standard input. Recipient, text, service,
attachment path, chat target, and the chat-routing flag live in checked
mode-0600 files under one random mode-0700 directory. The nested `osascript`
argv contains only fixed interpreter switches and an opaque random locator.
The patch rejects symlinks, file substitution, owner or mode changes, and
in-place content changes. It reaps the child before removing known private
files and the checked directory.

The Wrench runtime adds an outer boundary. Every RPC child is a fresh detached
process group with fixed argv `imsg rpc`, bounded stdin/stdout/stderr, a fixed
minimal environment, a total deadline, and durable cleanup admission. Each
confirmed bubble produces one separately journaled send process and exactly one
send request. Private message text appears only in that process's RPC stdin.
Timeout, signal, malformed output, or lost output after spawn is indeterminate.
The runtime never retries.

`imsg rpc status` is the exact nonlaunching readiness probe. It retries the database open and
probes only an already-running private bridge. It does not launch, kill, or
relaunch Messages. Wrench requires protocol 1, imsg 0.14.1, a readable database,
and the reviewed `chats.get`, read, and send methods. This proves the local contract is currently
usable, not which Apple account Messages will choose.

## Build and installation boundary

Apply both vendored mail patches in order to an otherwise clean checkout at the exact base,
then build `imsg` in release mode. The current reviewed macOS arm64 executable
SHA-256 is
`77a0db864dfd247cd0a9142dd98997960582e6f150f76ecd3bf1c38944f2bf71`.
Compiler, SDK, and command provenance are in the manifest. A different byte is
not this reviewed transport, even if it prints version 0.14.1.

Install only that byte sequence through the checked installer:

```sh
bun run imessage:transport:install -- --binary /absolute/path/to/imsg
```

The installer supports only the declared current platform, reads the source
without following a symlink, checks owner, mode, size, stability, and SHA-256,
and installs by an exclusive same-filesystem link. It never replaces mismatched
existing bytes. Software build, installation, Messages login, and account
recovery remain operator workflows, not provider operations.

Bind the local Messages store after the reviewed binary is installed:

```sh
wrench adapter sync-bundled --json
wrench auth add imessage-main --linked-device imessage \
  --device-store "${HOME}/Library/Messages"
wrench auth bind imessage-main --site imessage
```

macOS must grant the invoking terminal Full Disk Access for `chat.db` and
Automation access to Messages for a send. No live send is part of installation
or subject binding.

## Outcome boundary

Stock AppleScript does not return a message GUID. A Wrench result is
`submitted` only when the patched imsg process independently observes one
matching outgoing `chat.db` row and returns the exact message GUID, chat GUID,
row ID, `iMessage` service, and `applescript` transport. This is evidence of
local Messages acceptance, not network delivery or recipient receipt.

The transport preserves imsg's `not_started`, `may_have_completed`, and
`still_in_flight` categories in encrypted provider output. Once Wrench has
started the confirmed child, every non-accepted result remains non-retryable at
the Wrench boundary. The separately requested `messaging.delivery.read`
operation can inspect only a GUID already obtained from exact accepted evidence.
A missing row is not proof that an unobserved send did not happen.

Threaded replies are unsupported because AppleScript cannot express them. The
generic messaging facade owns one composite confirmation and a per-part
journal with a proven accepted prefix, at most one uncertain current part, and
an unattempted suffix. Before each remaining bubble it rereads the exact chat
and bounded history, accepting only the unchanged preview base, that same base
while an accepted bubble is not yet visible, or the exact visible own-message
prefix with bounded-window eviction. Foreign activity, edits, deletions,
reordering, or identity reuse stops the suffix. The provider hook
`executeImsgDirectMessagingPart` rejects non-send recipes and delegates every
bubble to the same supervised at-most-once operation boundary.
