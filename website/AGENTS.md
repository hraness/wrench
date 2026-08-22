# Contents

- `source/` – checked HTML, CSS, analytics, discovery, fallback, markdown, and llms.txt sources.
- `public/` – checked public social assets.
- `build.ts` – deterministic static output generation from the root package release.
- `content-negotiation.ts`, `document-negotiation.ts`, and `html-to-markdown.ts` – Accept parsing, markdown variants, and 406/404 recovery.
- `*.test.ts` – identity, SEO, accessibility, analytics-privacy, negotiation, and build regressions.
- `../middleware.ts` – Vercel edge negotiation for `Accept: text/markdown`.
- `dist/` – ignored generated deployment output.

# Guidelines

- Keep the page useful without JavaScript. JavaScript may progressively enhance explicit copy controls and canonical-host analytics; keep all commands readable and selectable without it.
- Keep every product claim observable in the public Wrench release and put each qualification beside the claim it limits.
- Derive release identity and install commands from the validated root `package.json`; never copy a version into page source.
- Keep the Agent Skill install command centralized in `build.ts`, render it as inert HTML, and make clipboard enhancement reusable through the `data-skill-install` contract.
- Keep canonical metadata, robots, sitemap, llms.txt, Open Graph, X metadata, and the linked JSON-LD graph aligned to `https://wrench.rip/`.
- Public content pages keep one URL for HTML and Markdown. Honor `Accept` q-values, set `Vary: Accept`, and return `406` only when no owned representation remains. Unknown paths stay HTTP 404 and point agents at llms.txt, the sitemap, and getting started.
- Keep analytics canonical-host-only, cookieless, personless, memory-only, DNT-aware, query-free, and restricted to page lifecycle plus the two explicit GitHub links.
- Do not add private packages, private assets, cookies, replay, identity, feature flags, broad autocapture, console capture, or application behavior.
- Preserve semantic headings, native disclosures, visible focus, keyboard-scrolling tables, touch-sized links, reduced-motion behavior, and forced-color legibility.
