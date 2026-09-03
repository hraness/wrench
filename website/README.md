# wrench.rip

This directory owns the public Wrench landing page. It is a deterministic,
dependency-free static build whose release facts come from the repository-root
package metadata. The published `@hraness/wrench` package excludes this entire
directory through its explicit `files` allowlist.

The page is fully readable without JavaScript. A small progressive enhancement
adds copy feedback to the Agent Skill install command. Public content pages
serve HTML by default and Markdown when `Accept` prefers `text/markdown`.
`/llms.txt` is the agent site guide. On the canonical production host only, an
optional PostHog bootstrap records privacy-bounded page lifecycle events and the
two explicit repository links. Set `NEXT_PUBLIC_POSTHOG_KEY` to the shared
project's public `phc_` token; `NEXT_PUBLIC_POSTHOG_HOST` defaults to
`https://us.i.posthog.com`. Set
`NEXT_PUBLIC_HRANESS_MAILING_TURNSTILE_SITEKEY` to the public Cloudflare
Turnstile sitekey registered for `wrench.rip` to enable the product-specific
Wrench mailing-list form. Production builds require a valid key and fail closed
when it is absent or malformed. Local and Preview builds may omit it; in those
environments the shared footer stays visible without rendering a signup form.
The private Turnstile secret remains in the central Accounts service.
No personal API key is used by the runtime build.

```sh
bun run website:check
```

The Vercel project uses the repository root and serves `website/dist`. Keep
Vercel System Environment Variables enabled and configure its Production Branch
as `website-production`. The checked-in build command injects exact non-secret
marker `WRENCH_VERCEL_BUILD=release-bound-v1`. Local admission is allowed only
when that marker and every Vercel signal are absent; otherwise the exact marker,
`VERCEL=1`, valid `VERCEL_ENV`, and exact nonempty `VERCEL_GIT_COMMIT_REF` are
all required. Missing, malformed, or inconsistent platform state fails closed.
Production admission requires the production branch ref, while `main` and pull
requests produce previews only. After the documented one-time bootstrap, the
tag Release workflow publishes only the immutable GitHub Release. A separate
main-origin promotion workflow either proves the established production branch
already exact without entering its key environment, or uses one repository-only
release App token and an explicit expected-old Git lease to fast-forward it to
the exact verified release commit. That writer first fetches only the verified
tag into its depth-one reviewed-workflow checkout, peels it to the independently
verified SHA without executing tagged code, and then performs the leased push.
The reviewed workflow source must descend from that release commit and must
equal or precede protected current main; canonical npm, the peeled tag, and the
immutable Latest GitHub Release must agree on the release identity. A missing branch is a hard
failure; neither workflow recreates it. One live no-bypass ruleset protects
creation, deletion, and non-fast-forward movement on the production and canary
refs. A second update rule denies every updater except exact App `4783991` as an
`Integration` with `bypass_mode=always`. Production-only freeze ruleset
`22149969` still blocks every production update until a fresh release-owner
audit removes it by captured numeric ID. The retained privileged setup proof
establishes that private Hraness App `4783991`, through installation
`158077029`, is installed only on exact repository `hraness/wrench`. The App
registration and each separately repository-narrowed runtime token use exactly
`metadata:read`, `contents:write`, and `workflows:write`; the reviewer-gated
writer environment holds the key. Workflows write is required for admitted
commits that change checked workflow files. Retained workflow run `33691443614`
proves the exact
workflow-changing leased `P` to `C` canary, ordinary denial, stale-lease
rejection, and token-revocation convergence. `docs/publishing.md` records the
durable archive, one-shot key-setup proof, and activation proof. Stable public
identifiers and published SHA-256 digests bind those artifacts. The App
registration, installation-selection, token, and revocation response bodies are
owner-controlled private response evidence. Those identifiers and digests bind
the retained bytes; they do not make those private responses independently
public.
Retained evidence is not standing mutation authority. Before every required
fast-forward, fresh administrator readback must reconfirm the permanent
rulesets and target refs, the sole App `4783991` `Integration` bypass, the
App's exact permission set, and that installation `158077029` still selects
only Wrench repository ID `1316443113`. It must also reconfirm the main-only
`production-ref-writer-key` environment, sole reviewer `0thernet`,
`prevent_self_review=false`, disabled administrator bypass, exactly four App
identity variables and the one private-key secret. Any drift leaves production
unchanged. Live production freeze `22149969` remains retained; this evidence
correction does not authorize its removal.
The persistent canary remains at
exact `C=0bf88a064233635e0c5485c61f9c533974a7dca4` and must never be reset,
deleted, or repurposed. On a production deployment,
`website:vercel-build` independently verifies checked-out HEAD, the matching
GitHub tag commit, canonical npm, and the immutable Latest Release before building.
Preview and local builds perform no external release verification.
Root `middleware.ts` imports only `edge/negotiation.ts` for Accept q-values,
`406`, and markdown 404 bodies.
