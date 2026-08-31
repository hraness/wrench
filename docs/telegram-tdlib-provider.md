# Telegram TDLib contact provider

The `telegram-linked-device` source plugin reads Telegram contacts from a
private local projection. Pairing and one-shot sync use Telegram's official
[TDLib user-client API](https://core.telegram.org/tdlib/getting-started) and
bind the projection to the exact user returned by
[`getMe`](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1get_me.html).
The read path then serves bounded pages without opening TDLib or contacting
Telegram.

This provider never uses the Telegram Bot API. A bot token cannot replace a
Telegram user session or authorize access to that user's contacts.

## Install the pinned helper

Wrench builds a separate native helper from TDLib 1.8.67 at commit
`d1085f9cebc5a62379991ae1652673954f229c1f`. The helper exposes only its
versioned stdin/stdout protocol. Wrench does not load TDLib into Bun, use
`bun:ffi`, search `PATH` for a substitute, or accept an ambient shared library.

From the exact Wrench source tree, run:

```sh
bun run telegram:tdlib:install
```

The source build requires Git, CMake, Make, gperf, a C++17 compiler, OpenSSL,
zlib, and system threads. The installer or TDLib's CMake configuration checks
these prerequisites and does not use a package manager to add them.

For a packaged installation, `wrench doctor --json` reports the exact
`setupCommand` for that package's checked installer. The installer supports
macOS and Linux on arm64 and x64, verifies its pinned source inputs, builds and
checks the helper outside the destination, and installs these files beneath
the Wrench state home:

```text
tools/telegram-tdlib/1.8.67/d1085f9cebc5a62379991ae1652673954f229c1f/<platform>-<arch>/
  install-manifest.json
  wrench-telegram-tdlib
```

The runtime requires the installation directory and each file to have the
declared owner, type, link count, mode, size, and identity. It hashes the helper
against the mode-0400 install manifest, executes an embedded identity probe,
and revalidates both files around use. Changed or substituted bytes fail
closed.

## Create the private client configuration

Register a Telegram API application at
[my.telegram.org](https://my.telegram.org/) and keep its `api_id` and
`api_hash` private. Create one dedicated absolute store directory with mode
0700. In that directory, create `client.conf` with mode 0600 and exactly these
two lines, followed by a final newline:

```text
api_id=<positive int32>
api_hash=<32 lowercase hex>
```

Do not pass the API hash through a command argument, environment variable,
prompt transcript, or committed file. Use a private editor or another local
input method that does not retain the value. Wrench rejects extra fields,
symbolic links, permissive modes, a noncanonical store path, and a changed
file identity.

## Pair one Telegram account

Sync the bundled adapter, register the private store, and pair it:

```sh
wrench adapter sync-bundled --json
wrench auth add telegram-main --linked-device telegram \
  --device-store /absolute/private/telegram-main
wrench auth pair telegram-main --phone +15551234567
```

The phone number is optional. When it is present, Wrench sends it to the helper
through private stdin rather than the helper's argv or environment. The helper reads
the remaining authorization values from the controlling terminal. It supports
an existing user's reviewed TDLib authorization states for a phone number,
email address and code, login code, two-step-verification password, or
confirmation on another device. Registration, bot-token authorization, and an
unknown authorization state fail closed.

Successful pairing calls
[`getContacts`](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1get_contacts.html),
stores `contacts.v1.json` with mode 0600, and binds the auth realm to
`telegram:user:<numeric-user-id>`. Credentials, authorization codes,
passwords, and raw TDLib updates stay out of the helper's argv, environment,
stdout, diagnostics, receipts, and Git. During pair or sync, a successful
contact projection is the helper's only stdout payload. Wrench captures it
through a bounded private pipe, validates it, and stores it in the account's
mode-0700 directory.

## Refresh and read contacts

Refresh only when you explicitly want Telegram network activity:

```sh
wrench auth sync telegram-main --once --json
```

Pairing and sync can emit TDLib protocol acknowledgements. Wrench durably fences
both lifecycles before external execution begins, and the sync result reports
the acknowledgement possibility explicitly. Sync must return the same bound
Telegram user before it atomically replaces the local projection.

Read a page from the local projection without reconnecting:

```sh
wrench telegram contacts.list --auth telegram-main \
  --input '{"limit":50}' --json
```

Pass the returned `nextCursor` as `cursor` to continue. Wrench accepts a limit
from 1 through 200 and orders contacts by numeric Telegram user ID. A contact
can contain its exact user ID, first and last names, display name, active
username, phone number, and mutual-contact, Premium, and verification flags.
The complete projection contains only the account's current TDLib contact set.

TDLib `getContacts` does not include message history. Sent and received counts,
last-sent time, and last-received time are therefore `null`, incomplete, and
carry `tdlib-contacts-do-not-include-message-history` as their reason. Wrench
does not turn missing history into zero activity or scan Telegram messages
while listing contacts.

## Custody and recovery

The store contains Telegram's local TDLib state and file directories, client
configuration, and Wrench contact projection. Keep the full directory
private and out of backups or repositories whose access exceeds the Telegram
account owner's intent.

Pair, sync, auth replacement, auth removal, and reconciliation serialize on
the canonical physical store. An interrupted external lifecycle remains
durably fenced. Inspect it with `wrench operator doctor --json`; never delete
the journal or retry the Telegram operation to escape an uncertain state.
Removing a Wrench auth locator does not revoke the provider-side Telegram
session. Revoke that device separately in Telegram when access should end.
