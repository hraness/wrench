# Social profile statistics

Use this workflow for a scheduled, read-only collection of exact counters from
explicitly selected social profiles, owned publications, and organization
pages. Wrench owns acquisition, invocation authority, and target binding. The consumer
owns history, public field selection, presentation, and delivery.

## Preconditions

Run `wrench operator doctor --json`, then inspect each named adapter with
`wrench capabilities <adapter> --json`. Every requested operation must be
installed, `observed`, and R1. Every authenticated operation must be bound to
the intended account realm; a public operation must instead prove its exact
requested target. Record a gap for a missing, changed, ambiguous, or
cleanup-unsafe realm and continue with the independent rows. `capture-required`
is not a partial success and performs no provider request.

Use a normal invocation, never `--cache-only`, for today's observation. A
cached value may explain the last known level, but it cannot become today's
sample. Do not use general browser automation, selectors, raw HTTP, or a public
page's rounded display as a fallback.

## Hraness account manifest

Collect these reads in this order. The auth IDs are local Wrench locators, not
credentials. Wrench probes and binds each authenticated provider subject.

| Consumer key | Adapter / operation | Auth | Input | Required exact metrics |
| --- | --- | --- | --- | --- |
| `x-hraness` | `x-web profiles.read` | `x-chrome` | `{"handle":"hraness"}` | followers, following |
| `x-hrawdog` | `x-web profiles.read` | `x-chrome` | `{"handle":"hrawdog"}` | followers, following |
| `linkedin-personal` | `linkedin-web profiles.read` | `linkedin-chrome` | `{"profile_url":"https://www.linkedin.com/in/hraness","include_connections":true}` | followers, connections |
| `linkedin-company-hraness` | `linkedin-web organizations.read` | `linkedin-chrome` | `{"organization_url":"https://www.linkedin.com/company/hraness"}` | followers |
| `youtube-hraness` | `youtube-web profiles.read` | `youtube-chrome` | `{"profile":"@hraness"}` | subscribers, videos, views |
| `twitch-hranessdotcom` | `twitch-web profiles.read` | `twitch-chrome` | `{"profile":"hranessdotcom"}` | followers |
| `bluesky-hraness` | `bluesky-web profiles.read` | public | `{"handle":"hraness.bsky.social"}` | followers, following, posts |
| `instagram-hraness` | `instagram-web profiles.read` | `instagram-chrome` | `{"profile":"hraness"}` | followers, following, posts |
| `threads-hraness` | `threads-web profiles.read` | `threads-chrome` | `{"profile":"hraness"}` | followers, recentViews |
| `substack-hraness` | `substack-web profiles.read` | `substack-chrome` | `{"profile":"hraness"}` | followers |
| `substack-hraness` | `substack-web organizations.read` | `substack-chrome` | `{"organization":"hraness"}` | freeSubscribers, paidSubscribers |
| `github-0thernet` | `github-web profiles.read` | public | `{"username":"0thernet"}` | followers, following, publicRepositories |
| `github-hraness` | `github-web organizations.read` | public | `{"organization":"hraness"}` | stars, followers |
| `tiktok-hraness` | `tiktok-web profiles.read` | `tiktok-chrome` | `{"profile":"hraness"}` | followers, following, likes |
| `reddit-bgdotjpg` | `reddit-web profiles.read` | `reddit-chrome` | `{"profile":"bgdotjpg"}` | followers, karma, contributions |

Bluesky and GitHub profile and organization statistics come from public target-bound APIs.
Invoke these rows without `--auth`. Wrench assigns each reviewed operation a
deterministic public authority for receipts and exact R1 caching. Supplying an
auth locator is an error.

The Twitch row targets exactly
`https://www.twitch.tv/hranessdotcom`. Until `twitch-web profiles.read` is an
installed observed capability and `twitch-chrome` resolves to an eligible,
target-bound auth source, record Twitch followers as a categorical gap. Do not
substitute browser automation, raw HTTP, a rounded public display, a cached
value, or an estimate.

Keep the two X calls sequential, both LinkedIn calls sequential, and both
Substack calls sequential because each pair shares one authenticated realm.
`linkedin-chrome` must be a path-backed `browser-profile` locator over a
private dormant Chrome snapshot, optionally overlaid with current filtered
cookies from the selected Chrome profile. A cookie-source-only LinkedIn realm
is not an acceptable scheduled fallback because LinkedIn invalidates the
exported session outside its browser/device context. Before the initial
snapshot, or after a contained identity preflight returns 401, load LinkedIn
normally in the source Chrome profile, confirm the session is current, fully
quit Chrome, and replace the dormant snapshot. A filtered cookie overlay does
not revive a stale source session.
Leave a 60-second idle interval after the LinkedIn personal read before the
company read; current live evidence shows shorter intervals can trigger a
temporary identity-preflight redirect even when the realm remains correctly
bound. Do not routinely rebind or rotate the locator.
The first scheduled version should run the whole table sequentially. This is a
small daily workload and avoids provider bootstrap, keychain, and session-lock
contention. A later caller may parallelize distinct realms with a small bound,
but must never overlap work on the same `(surface, auth ID)` pair.

Invoke each row with bounded stdin and exact JSON output:

```sh
printf '%s' '<input-json>' \
  | wrench invoke <adapter> <operation> --input - --auth <auth-id> --json
```

For the public Bluesky and GitHub rows, omit the auth option:

```sh
printf '%s' '{"handle":"hraness.bsky.social"}' \
  | wrench invoke bluesky-web profiles.read --input - --json
printf '%s' '{"username":"0thernet"}' \
  | wrench invoke github-web profiles.read --input - --json
printf '%s' '{"organization":"hraness"}' \
  | wrench invoke github-web organizations.read --input - --json
```

`github-web organizations.read` first binds the exact organization and its
declared public repository count, then completes the fixed public repository
pagination before summing `stargazers_count`. It returns `stars` only when the
complete repository set is available and bound; it never substitutes a partial
page, a rounded display total, or a prior observation.

Do not put an auth ID, provider receipt, cache key, run ID, subject identifier,
or raw provider response in the consumer snapshot. Do not print or persist
cookies, headers, tokens, HTML, first-party response bodies, or exception text.

## Accept exact metric observations

Accept a row only when the live invocation reports a succeeded R1 receipt and
its live output binds the requested provider and canonical target, plus the
current realm for authenticated operations. The profile-stat envelope is
version 1 and contains:

- `provider`, `target`, `observedAt`, and `completeness`;
- one metric record per requested counter, including categorical unavailable
  records when the provider cannot expose an exact value;
- bounded public metadata such as handle, display name, bio, or public website.

Each publishable metric must have `status: "available"`,
`precision: "exact"`, `unit: "count"`, and a nonnegative safe-integer `value`.
Reject `500+`, `1.2K`, estimated, lower-bound, rounded, hidden, unavailable, and
provider-drift values. A provider may return them as categorical unavailable
evidence, but the consumer must not coerce them. Accept each exact available
metric independently once the invocation and target are valid. A partial
provider output may therefore advance followers while leaving recent views
unavailable. Substack is an intentional two-read join, but either target-bound
read may contribute its own exact metrics when the other read fails.

An unavailable metric creates a gap only for that metric. Never write zero,
copy the previous day into the scheduled date, or suppress a different exact
metric from the same account. Report failed consumer keys and metric keys with
bounded categorical reasons after the sequential collection completes.

## Install into Hraness

Build one mode-private temporary document with this exact public handoff:

```json
{
  "schemaVersion": 1,
  "scheduledDate": "YYYY-MM-DD",
  "timezone": "America/New_York",
  "observations": [
    {
      "accountKey": "x-hraness",
      "observedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
      "metrics": {
        "followers": 1,
        "following": 1
      }
    }
  ]
}
```

Run the consumer's installer from a clean, current Jungle worktree:

```sh
bun run --cwd projects/hraness social:install --input /absolute/private/run.json
bun run --cwd projects/hraness social:validate
bun run check:affected
```

For the Hraness consumer, the preferred daily entry point performs the fixed
sequential collection and installs its validated public subset directly:

```sh
bun run --cwd projects/hraness social:refresh
bun run --cwd projects/hraness social:validate
bun run check:affected
```

The installer is the only process allowed to update
`projects/hraness/app/social-stats.generated.json`. It validates the exact
configured metric subset, derives the Eastern date from each observation time,
preserves a newer same-day success, retains fourteen days, and writes canonical
JSON. Remove the temporary document after installation.

Review that the task diff contains only the checked social snapshot. Commit and
deliver it through the repository's current-main workflow, then verify the
Hraness production deployment. Never commit an empty or synthetic observation,
raw Wrench output, capture evidence, or local state.
