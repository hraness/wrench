# Local CLI provider transports

A source plugin may use the `local-cli` transport when a provider publishes a
native command-line client but does not expose an equally suitable stable API.
The transport turns a reviewed CLI release into bounded semantic operations. It
does not expose the program as a shell, an argument array, or a generic command
runner.

Portable plugin protocol v1 cannot declare `local-cli`. Native process authority
and executable provenance remain code-owned source-plugin responsibilities.

The built-in Beeper adapter is the first production example. It turns the
pinned official `@beeper/cli` 0.6.2 executable into 27 CLI-backed operations
and adds five fixed Beeper Desktop loopback reads, for 32 named operations in
all. The source plugin owns executable and endpoint verification, Desktop-target
and account binding, strict projections, process bounds, and mutation recovery.
See the public [Beeper provider guide](https://wrench.rip/providers/beeper/) and
the current release's [supported-action directory](https://wrench.rip/provider-capabilities/#provider-beeper).

The selected operation set is 25 operations at contract version 1, six at
version 2, and `messaging.read` at version 3. The five direct loopback reads are
`accounts.list`, `messaging.search`, `conversations.read`, `messaging.read`, and
`messaging.content.search`; they do not fall back to the CLI or SDK. The CLI
executable is authoritative: the tagged source `packages/cli/package.json`
declares 0.6.1, which is provenance only.

The 101 public manual command paths are fully accounted for as provenance, not
as supported-command parity. Forty-one paths collapse to 32 operations.
`accounts use` is absorbed into explicit account IDs; `targets status`,
`version`, and top-level `export` are internal; the R4 paths `accounts add`,
`accounts remove`, and `messages delete` are unavailable to provider dispatch;
and plain `status` is among the 53 unsupported paths. None of those three R4
paths appears in the selected 32-operation provider adapter.

## Keep three versions separate

Every local CLI binding has three independent version boundaries:

1. The source plugin version changes when its reviewed implementation changes.
2. An operation's `contractVersion` changes when its semantic input, output,
   risk, side effect, dispatch schedule, or completeness claim changes.
3. The local CLI tool identity names one exact upstream release and every
   supported executable artifact.

The tool identity uses its own schema version and records the implementation
name, an upstream version under an explicit `semver` or `opaque` scheme, and a
sorted platform and architecture table. Every table entry contains the exact
executable SHA-256, which is the execution authority. When upstream publishes
them, the identity also records a release commit, source URL, release-manifest
URL and SHA-256, and archive URL and SHA-256. Each URL-and-digest pair is
all-or-nothing; metadata that upstream does not publish is omitted rather than
invented.

Do not use a version range, channel, package-manager formula, tag name, or
reported version as execution authority. A new upstream release needs a new
reviewed identity and fixtures even when its public version string appears
compatible. Changing the tool identity changes the operation's implementation
and contract hash, so old previews, receipts, caches, and recovery evidence
cannot silently authorize the new bytes. The semantic `contractVersion` may
remain unchanged only when the operation-owned meaning and projection are
unchanged.

If the CLI is itself a client for a separately versioned local or remote API,
record the reviewed API schema or SDK revision in the operation implementation
identity too. The executable digest proves which client bytes ran; it does not
claim that an independently updated server still implements the same response
contract. Bind any server-advertised protocol version as runtime drift evidence
and fail closed when the reviewed contract cannot be proved.

## Define semantic operations, not commands

Each operation owns a fixed command template, strict input parser, dispatch
plan, strict output projection, and exact failure policy. Caller values may
fill only reviewed argument positions. They cannot select a command, flag,
endpoint, target, environment variable, header, shell fragment, or output
path.

Keep a checked coverage ledger for the reviewed upstream command inventory.
Map every canonical command to one semantic Wrench operation or one explicit
unavailable reason. Aliases do not create additional authority. Commands for
raw requests, shells, plugin installation, software installation, account
recovery, arbitrary filesystem output, or caller-selected network destinations
normally remain unavailable.

An adapter manifest selects a local CLI operation with `localCli`:

```json
{
  "localCli": {
    "surface": "example",
    "action": "messaging.send",
    "contractVersion": 1,
    "timeoutMs": 60000,
    "maxOutputBytes": 10485760
  }
}
```

The selector identifies an installed source-plugin contract. It is not an
executable name or command line.

## Bind the complete execution realm

Before private work, resolve the final executable and verify its exact digest.
The provider runtime must also bind the current account and the exact local or
remote service target used by that executable. A reported CLI version is a
drift check, not a substitute for the artifact digest.

Start the process directly without a shell. Give it a minimal environment and
operation-private config, data, cache, and temporary directories. Remove
ambient credentials, default targets, account selectors, plugin search paths,
debug settings, update checks, and proxy settings unless the reviewed contract
explicitly owns them. If the upstream CLI supports installable or linked
plugins, isolate or reject that user-plugin state so unbound code cannot add or
override commands.

The temporary filesystem must expose a nonzero immutable directory birth time
for operation-private roots. Wrench checks this during local-CLI readiness and
reports the transport unavailable before staging credentials or starting a
child when the filesystem cannot provide that generation identity. Device and
inode plus mutable ctime are not a safe crash-recovery substitute.

Use exact resource IDs. Never use fuzzy selectors, interactive pickers, current
account defaults, default targets, or an automatic transport fallback. Stage a
file input only from the kernel's content-bound plan asset, enforce its size and
digest, and remove the private stage during cleanup. Do not accept an arbitrary
path merely because the upstream CLI accepts one.

The runtime owns its deadline and stdout and stderr bounds. Parse both streams
from `unknown`, require the operation's exact success envelope and projected
fields, and convert failures to bounded categorical diagnostics. Never copy
foreign output, command arguments, tokens, private paths, message bodies, or
provider objects into logs, plans, receipts, or public errors.

Some CLIs accept private text only through arguments. Direct process spawning
prevents shell interpretation but does not hide arguments from same-account
process inspection. Such an operation must document that local exposure,
minimize process lifetime, and never persist or print the argument vector.

## Preserve the mutation boundary

Local CLI writes use the same R2 and R3 preview, confirmation, durable claim,
dispatch journal, receipt, and reconciliation rules as every other transport.
The runtime calls the kernel's dispatch boundary immediately before starting
the effect. If the provider returns an accepted pending target, record that
exact target before later verification.

For this transport, one dispatch item is one fixed child invocation. A reviewed
CLI command may perform multiple internal provider calls that Wrench cannot
fence separately—for example, upload an attachment and then send it. Declare
that opaque sequence and its possible intermediate effects in the operation
contract and preview. Once the child starts, failure at any internal stage is
post-dispatch uncertainty even if the final provider action was never reached.

Never retry a mutation after the child may have reached the provider. A
timeout, signal, malformed response, lost response, or noncategorical failure
after dispatch is indeterminate. Reconcile only through a separately obtained
exact read supported by the operation contract. Upstream retry flags and
claimed idempotency do not replace Wrench's at-most-once evidence.

The Beeper messaging facade has a separate agentic text-send path. After route
and context preflight it performs one fixed POST to the bound Desktop loopback
endpoint; it does not call the CLI or SDK and never retries. A returned
`pendingMessageID` proves submission to Desktop only, not network delivery.
Message reads use opaque before/after cursors returned by Desktop and an
optional sender filter. Callers pass those returned values and never derive a
cursor from a terminal message ID.

Use R4 for destructive, administrative, account-recovery, software-lifecycle,
or insufficiently observable operations. The presence of a CLI command does
not make that command a safe Wrench capability.

## Review checklist

- An exact executable digest covers every supported platform; published
  archives are also digest-bound.
- The reported tool version and every available upstream provenance fact are
  bound as drift evidence.
- User, linked, and just-in-time plugin code cannot affect wrapped commands.
- The child environment cannot inherit a credential, target, proxy, or debug
  override.
- Every selector is an exact resource ID tied to the probed account realm.
- Input values can enter only reviewed fixed argument positions.
- Output and error parsers reject extra fields and changed envelopes.
- Deadlines, byte bounds, process-group termination, and cleanup are tested.
- Every upstream canonical command has one tested coverage-ledger disposition.
- Mutation acceptance, uncertainty, reconciliation, and no-retry behavior have
  deterministic tests.
