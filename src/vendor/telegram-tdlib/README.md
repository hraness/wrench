# Telegram TDLib helper provenance

Wrench uses TDLib's user-client API for Telegram contacts. It does not use or
accept a Bot API token. `wrench_telegram_tdlib.cpp` is a narrow helper that
supports only runtime identity, existing-user pairing, and one `getMe` plus
`getContacts` projection. Authentication values travel through its private
stdin or controlling terminal. Failed runs emit no stdout or stderr payload.

The installer fetches `tdlib/td` at exact commit
`d1085f9cebc5a62379991ae1652673954f229c1f`, identified by TDLib as version
1.8.67. It verifies the checked-out commit, builds a static TDLib installation,
links this helper against `Td::TdStatic`, and installs only the stripped helper
plus a canonical identity manifest. Runtime loading accepts that fixed location
only and rechecks the file identity, permissions, SHA-256, and embedded source
identity around every connected operation.

TDLib and the helper are distributed under the Boost Software License 1.0.
The complete license text is retained in `LICENSE_1_0.txt`.

The reviewed build currently covers macOS and Linux on arm64 and x86-64. It
requires Git, CMake, Make, gperf, a C++17 compiler, OpenSSL, zlib, and system threads.
The installer does not install or discover a runtime helper through `PATH`,
Homebrew, or dynamic-library environment variables.
