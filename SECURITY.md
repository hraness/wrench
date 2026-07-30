# Security

Please report suspected vulnerabilities through GitHub private vulnerability
reporting for the Wrench repository. Do not open a public issue containing
credentials, authenticated traffic, private content, browser profiles, state
directories, or provider account identifiers.

Wrench treats CLI input, URLs, manifests, packages, plugin messages, provider
responses, browser output, files, durable state, and subprocess diagnostics as
untrusted. Foreign values are strictly parsed and bounded. Sensitive values are
redacted from terminal output, receipts, and diagnostics.

Source plugins are trusted in-process code. Portable plugins require an
explicit trust decision for one verified content-addressed bundle and execute
through a denied-by-default child-process protocol. The protocol limits the
host services a well-behaved plugin can request and contains ordinary crashes;
it is not a hostile native-code sandbox. Plugin code still runs with the
ambient operating-system authority of the current account. Review code before
trusting it and keep Wrench state on a local filesystem protected for that
account.

Authenticated operations bind one locator to one provider account and exact
transport. Wrench does not silently switch between official API, browser
session, linked-device, or portable transports. Mutations require durable
dispatch evidence and do not retry after a partial or indeterminate result.

Wrench archives one accessible, finite, non-DRM media item at a time. It
rejects playlists, live streams, affirmative DRM, and unsupported
authentication, and it never supplies decryption keys or access-control bypass
flags. Completed items remain inspectable directories with versioned manifests
and SHA-256 records that `wrench verify` recomputes.

Media URLs, provider metadata, captions, manifests, tool output, and archive
paths are untrusted. Wrench invokes media tools without a shell, ignores
ambient yt-dlp configuration unless the user explicitly selects that mode, and
does not persist cookies, request headers, signed media URLs, raw yt-dlp
metadata, or transport fragments. Authorization-context names separate
declared access realms, but they cannot detect that the account behind a reused
name has changed. Use a new context name when the intended account changes.

The unauthenticated direct-media adapter intentionally permits loopback and
private-network HTTP(S) targets because its URL is supplied by the local user.
It is not an SSRF boundary for remotely supplied URLs. It reads a bounded
range, identifies media from bytes, and stores fixed role names instead of URL
basenames.

Local transcription setup does not download whisper.cpp, its model, or its
libraries. Wrench records and rechecks the selected executable, model, and
observable non-platform runtime closure, but those checks establish continuity,
not provenance or safety. Obtain them from trusted sources. whisper.cpp remains
user-selected native code running with the current account's filesystem and
network authority.

Media locks coordinate Wrench processes, and final publication uses an atomic
same-volume rename. The archive root and transcriber configuration are not
security boundaries against another process running as the same user. Keep
them on a trusted local filesystem with permissions limited to that account,
and use `wrench verify` to detect later archive changes.

Use Wrench only with material and accounts you are authorized to access.
