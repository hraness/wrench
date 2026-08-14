# wrench.rip

This directory owns the public Wrench landing page. It is a deterministic,
dependency-free static build whose release facts come from the repository-root
package metadata. The published `@hraness/wrench` package excludes this entire
directory through its explicit `files` allowlist.

The page is fully readable without JavaScript. On the canonical production
host only, an optional PostHog bootstrap records privacy-bounded page lifecycle
events and the two explicit repository links. Set `NEXT_PUBLIC_POSTHOG_KEY` to
the shared project's public `phc_` token; `NEXT_PUBLIC_POSTHOG_HOST` defaults to
`https://us.i.posthog.com`. No personal API key is used by the runtime build.

```sh
bun run website:check
```

The Vercel project uses the repository root and serves `website/dist`.
