# Immutable-spool plan for larger video publishing

The capture-required YouTube, TikTok, Instagram, and Substack video publish
foundations currently materialize and re-snapshot complete MP4 bytes in memory.
Their interim admission limit is therefore 128 MiB. Raising a manifest limit
must wait for a provider-owned immutable-spool transport.

## Intended boundary

1. Resolve one plan-bound regular file through the existing file resolver and
   open it without following a final symlink.
2. Stream it once into a private, quota-checked, mode-0600 staging file while
   computing SHA-256 and the provider-specific MP4 metadata. Verify the source
   file identity before and after that copy.
3. Flush the completed staging file and atomically promote it to a Wrench-owned
   immutable spool entry. Reopen that exact entry without following symlinks and
   bind its device, inode, byte length, digest, media type, and metadata into the
   dispatch checkpoint.
4. Let only a reviewed provider implementation open that checkpoint and stream
   either the whole entry or fixed, contiguous provider-owned byte ranges.
   Revalidate the immutable entry before the first request and keep its handle
   pinned through the transfer.
5. Retain the spool entry while a preview, confirmed run, indeterminate run, or
   recovery capsule owns it. Reclaim it only after a terminal outcome and the
   durable ownership records agree that no reconciliation can still need it.

Multipart providers must derive every range from the checkpointed byte length,
prove exact once-only coverage, and bind accepted part evidence in order.
Cancellation or an ambiguous response remains non-retryable until independent
provider evidence reconciles the run.

## Deliberate non-goals

The spool will not expose caller-selected paths, file descriptors, streams,
URLs, methods, headers, chunk sizes, request bodies, or shell commands. It is
not a generic request or file-transfer escape hatch. Each provider must retain
fixed origins, routes, credential sinks, response projections, dispatch rules,
and independent readback before its operation can graduate from
`capture-required` or advertise a larger byte limit.
