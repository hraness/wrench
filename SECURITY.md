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

Wrench does not bypass access controls or DRM. Use it only with material and
accounts you are authorized to access.
