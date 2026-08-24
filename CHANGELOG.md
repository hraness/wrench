# Changelog

## 0.13.3 - 2026-08-24

- Add a credential-free, target-bound GitHub profile read through the fixed
  public REST user endpoint, projecting exact follower, following, and public
  repository counts.
- Add GitHub to the package-owned Hraness social-profile-statistics workflow.

## 0.13.2 - 2026-08-23

- Publish exact Threads text through `posts.publish@5` without requiring a
  PNG, while preserving optional PNG publication and exact permalink readback.
- Restore exact LinkedIn personal and organization profile reads from a
  path-backed signed-in Chrome realm. Wrench clones the dormant profile into a
  private contained session, binds the current member before either target
  read, keeps personal profile and connection reads sequential, and finalizes
  the browser's private artifacts after every result.

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
