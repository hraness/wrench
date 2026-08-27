# WhatsApp private transport source boundary

This directory vendors the exact reviewed Wacli and Whatsmeow patches, their
upstream licenses, and a machine-readable source manifest. The manifest binds
the immutable source archives, patches, toolchain, protocol descriptor, and
current-platform binary by SHA-256.

`src/scripts/install-whatsapp-protocol.sh` supports the checked macOS arm64
platform. It verifies every vendored and downloaded input, applies both
patches, runs the focused dependency and Wacli tests, builds with the private
transport tag, verifies the deterministic binary hash, and atomically installs
the result below Wrench's private state root. It never reads a linked account
and never sends a message.

The transport daemon is an explicit Wacli follow-mode process:

```text
wacli --store <private-store> sync --follow --wrench-private-transport
```

The checked Wrench provider path first calls the authenticated status barrier.
It requires one stable, idle daemon binding, then sends one strict JSON payload
through stdin. Recipient and message text are absent from argv and the process
environment. A spawned send is never retried. Timeout, late completion,
reconnect, incomplete proof, or binding drift returns an indeterminate result
that requires authenticated status reconciliation.

## Qualification boundary

No live message was sent while producing or validating this integration. The
public `messaging.send` contract and registered generic action therefore remain
capture-required. Production promotion still requires:

- a controlled, low-stakes account fixture that proves the exact compiled
  binary, real Noise connection, provider acknowledgement, persistence, and
  duplicate behavior;
- an exact generic reconciliation read for the response's hashed provider
  message identity;
- fresh live context proof on the registered generic messaging route;
- transaction-owned commit revision evidence for every synchronous database
  mutation reachable from a sequenced handler;
- explicit registration and draining of persistence work started after a
  synchronous handler returns;
- adversarial daemon, peer-credential, key rotation, crash, suspend, ownership,
  and replacement tests;
- a maintained fork or upstream API for the Whatsmeow internals used by the
  receive barrier; and
- additional checked build records before supporting another macOS SDK,
  compiler, architecture, or operating system.

The current committed revision is a deterministic hash of the final row, not a
store-owned monotonic transaction revision. The current Whatsmeow escape
threshold also remains longer than Wrench's barrier deadline. Both conditions
fail closed locally but remain production qualification gaps.
