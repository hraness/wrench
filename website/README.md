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
current-main promotion workflow either proves the established production branch
already exact without entering its key environment, or uses one repository-only
release App token and an explicit expected-old Git lease to fast-forward it to
the exact verified release commit. That writer first fetches only the verified
tag into its depth-one current-main checkout, peels it to the independently
verified SHA without executing tagged code, and then performs the leased push.
The current-main workflow source must descend
from that release commit; canonical npm, the peeled tag, and the immutable
Latest GitHub Release must agree on the release identity. A missing branch is a hard
failure; neither workflow recreates it. The live no-bypass ruleset currently
protects deletion and non-fast-forward movement. The App-only update rule,
creation rule, writer environment, and canary proof remain pending live
reconciliation. The provisional contents-only App remains inactive until
privileged setup proves its installation selects only Wrench and an exact
workflow-changing `P` to `C` canary proves the leased push. Any proven need for
Workflows permission requires a separate reviewed amendment and repeated
canary. On a production deployment,
`website:vercel-build` independently verifies checked-out HEAD, the matching
GitHub tag commit, canonical npm, and the immutable Latest Release before building.
Preview and local builds perform no external release verification.
Root `middleware.ts` imports only `edge/negotiation.ts` for Accept q-values,
`406`, and markdown 404 bodies.
