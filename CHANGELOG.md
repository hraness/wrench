# Changelog

## 0.13.1 - 2026-08-23

- Keep Beeper account selector aliases internal while returning plain,
  bounded-JSON-safe account projections from contact and messaging reads.

## 0.13.0 - 2026-08-22

- Add a pinned, read-only Beeper Desktop provider for contacts and messaging
  projections across locally connected accounts.
- Add `wrench beeper export-message-like-me` for private,
  provenance-preserving Message Like Me bundles with canonical digests,
  explicit completeness, graph validation, and no media downloads.
- Export Beeper accounts sequentially through the pinned official CLI with
  redacted account-level progress, elapsed-time heartbeats, and cumulative
  chat and message counts.
- Add durable process-aware recovery, global export admission, monitored raw
  working limits, and atomic validated Message Like Me bundle publication.
- Normalize account-local self aliases before record allocation, preserve
  distinct provider reaction facts, and reject contradictory identity or
  snapshot evidence without exposing private coordinates. Bound repeated
  participant work independently from output record cardinality.
