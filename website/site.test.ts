import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  HRANESS_HOME_URL,
  HRANESS_MAILING_SUBSCRIBE_URL,
  HRANESS_TURNSTILE_SCRIPT_URL,
  hranessSocialLinks,
} from "@hraness/site-footer";

import {
  agentSkillInstallCommands,
  buildWebsite,
  CONTENT_REVIEWED_RELEASE,
  DEFAULT_POSTHOG_HOST,
  DEMO_PUBLIC_FILES,
  markdownSiblingPath,
  NPM_PACKAGE_URL,
  parsePackageIdentity,
  PUBLIC_PAGES,
  PUBLISHER_URL,
  REPOSITORY_URL,
  SITE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TITLE,
  SKILLS_URL,
  versionedNpmPackageUrl,
  WRENCH_MAILING_TURNSTILE_SITEKEY_ENV,
  wrenchMailingListConfig,
} from "./build";
import { handleDocumentNegotiation } from "../edge/negotiation";
import {
  EDITORIAL_ARTICLE_IMAGE_SIZES,
  EDITORIAL_CARD_IMAGE_SIZES,
  editorialImageSrcSet,
  editorialImageUrl,
  editorialImages,
} from "./editorial-images";
import {
  loadProviderCapabilityAttestation,
} from "./provider-capability-attestation";
import {
  BEEPER_PRESENTATION_TRANSPORT_COUNTS,
  createBeeperPresentationFacts,
  createProviderDirectory,
  createWhatsAppPresentationFacts,
  renderProviderAttestationGroups,
  renderProviderOverviewCards,
} from "./provider-presentation";

const repositoryRoot = resolve(import.meta.dir, "..");
const websiteRoot = import.meta.dir;

function cssPropertyValues(css: string, selector: string, property: string): string[] {
  const values: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = (match[1] ?? "").split(",").map((value) => value.trim());
    if (!selectors.includes(selector)) continue;
    const declarations = match[2] ?? "";
    const value = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "u")
      .exec(declarations)?.[1]?.trim();
    if (value !== undefined) values.push(value);
  }
  return values;
}

function lossyWebpDimensions(bytes: Uint8Array): Readonly<{ height: number; width: number }> {
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (
    bytes.byteLength < 30
    || ascii(0, 4) !== "RIFF"
    || ascii(8, 12) !== "WEBP"
    || ascii(12, 16) !== "VP8 "
    || bytes[23] !== 0x9d
    || bytes[24] !== 0x01
    || bytes[25] !== 0x2a
  ) {
    throw new Error("Editorial image must be a canonical lossy WebP frame.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    height: view.getUint16(28, true) & 0x3fff,
    width: view.getUint16(26, true) & 0x3fff,
  };
}

describe("wrench.rip static site", () => {
  test("derives the public release from strict root package identity", async () => {
    const manifest: unknown = await Bun.file(join(repositoryRoot, "package.json")).json();
    const identity = parsePackageIdentity(manifest);
    expect(identity).toMatchObject({
      description: SITE_DESCRIPTION,
      homepage: SITE_ORIGIN,
      name: "@hraness/wrench",
      repositoryUrl: "git+https://github.com/hraness/wrench.git",
    });
    expect(identity.version).toBe((manifest as { version: string }).version);
    expect(identity.release).toBe(`v${identity.version}`);
    expect(identity.release).toBe(CONTENT_REVIEWED_RELEASE);
    const packageFiles = (manifest as { files?: unknown }).files;
    expect(Array.isArray(packageFiles)).toBe(true);
    expect(packageFiles).not.toContain("website");
    expect(packageFiles).not.toContain("vercel.json");
  });

  test("rejects metadata drift and non-release versions", () => {
    const base = {
      description: SITE_DESCRIPTION,
      homepage: SITE_ORIGIN,
      name: "@hraness/wrench",
      repository: { url: "git+https://github.com/hraness/wrench.git" },
      version: "9.8.7",
    };
    expect(() => parsePackageIdentity({ ...base, homepage: "https://hraness.com/wrench" }))
      .toThrow("canonical Wrench origin");
    expect(() => parsePackageIdentity({ ...base, version: "9.8.7-beta.1" }))
      .toThrow("stable semantic version");
    expect(() => parsePackageIdentity({ ...base, description: "drift" }))
      .toThrow("descriptions must stay identical");
  });

  test("binds signup to Wrench and fails production closed without a key", () => {
    const turnstileSitekey = "1x00000000000000000000AA";
    expect(wrenchMailingListConfig({
      [WRENCH_MAILING_TURNSTILE_SITEKEY_ENV]: turnstileSitekey,
    })).toEqual({
      audience: "wrench",
      kind: "signup",
      turnstileSitekey,
    });
    expect(wrenchMailingListConfig({})).toEqual({ kind: "none" });
    expect(wrenchMailingListConfig({
      [WRENCH_MAILING_TURNSTILE_SITEKEY_ENV]: "",
    })).toEqual({ kind: "none" });
    expect(wrenchMailingListConfig({ VERCEL_ENV: "preview" }))
      .toEqual({ kind: "none" });
    for (const turnstileSitekey of [undefined, ""]) {
      expect(() => wrenchMailingListConfig({
        [WRENCH_MAILING_TURNSTILE_SITEKEY_ENV]: turnstileSitekey,
        VERCEL_ENV: "production",
      })).toThrow(WRENCH_MAILING_TURNSTILE_SITEKEY_ENV);
    }
    expect(() => wrenchMailingListConfig({
      [WRENCH_MAILING_TURNSTILE_SITEKEY_ENV]: "not a public key",
    })).toThrow(WRENCH_MAILING_TURNSTILE_SITEKEY_ENV);
  });

  test("builds canonical discovery, semantic content, and private-key-free analytics", async () => {
    const packageIdentity = parsePackageIdentity(
      await Bun.file(join(repositoryRoot, "package.json")).json(),
    );
    const npmPackageUrl = versionedNpmPackageUrl(packageIdentity);
    const skillInstallCommands = agentSkillInstallCommands(packageIdentity);
    const beeperOperationCount =
      BEEPER_PRESENTATION_TRANSPORT_COUNTS.cliBackedOperationCount
      + BEEPER_PRESENTATION_TRANSPORT_COUNTS.desktopLoopbackOperationCount;
    await buildWebsite({
      [WRENCH_MAILING_TURNSTILE_SITEKEY_ENV]: "1x00000000000000000000AA",
      NEXT_PUBLIC_POSTHOG_HOST: DEFAULT_POSTHOG_HOST,
      NEXT_PUBLIC_POSTHOG_KEY: "phc_public_project_token",
    });
    const [pages, preview, notFound, notFoundMarkdown, llms, robots, sitemap, indexNowKey, favicon, sourceCss, demoFiles, vercel, middleware] = await Promise.all([
      Promise.all(PUBLIC_PAGES.map(async (page) => ({
        definition: page,
        html: await readFile(join(websiteRoot, "dist", page.outputFile), "utf8"),
      }))),
      readFile(join(websiteRoot, "dist/preview/index.html"), "utf8"),
      readFile(join(websiteRoot, "dist/404.html"), "utf8"),
      readFile(join(websiteRoot, "dist/404.md"), "utf8"),
      readFile(join(websiteRoot, "dist/llms.txt"), "utf8"),
      readFile(join(websiteRoot, "dist/robots.txt"), "utf8"),
      readFile(join(websiteRoot, "dist/sitemap.xml"), "utf8"),
      readFile(join(websiteRoot, "dist/dc84ee4863539f2fff50ef5f0a164168.txt"), "utf8"),
      readFile(join(websiteRoot, "dist/favicon.svg"), "utf8"),
      readFile(join(websiteRoot, "source/styles.css"), "utf8"),
      Promise.all(DEMO_PUBLIC_FILES.map(async (file) => ({
        file,
        output: new Uint8Array(await Bun.file(join(websiteRoot, "dist", file)).arrayBuffer()),
        source: new Uint8Array(await Bun.file(join(websiteRoot, "public", file)).arrayBuffer()),
      }))),
      Bun.file(join(repositoryRoot, "vercel.json")).json(),
      readFile(join(repositoryRoot, "middleware.ts"), "utf8"),
    ]);
    const html = pages[0]!.html;
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    const cssAsset = /<link rel="stylesheet" href="([^"?]+)">/u.exec(html)?.[1];
    expect(cssAsset).toMatch(/^\/assets\/styles-[a-f0-9]{12}\.css$/u);
    const builtCss = await readFile(join(websiteRoot, "dist", cssAsset!.slice(1)), "utf8");

    expect(vercel.git).toEqual({
      deploymentEnabled: {
        "website-production-canary": false,
      },
    });

    expect(sourceCss).toContain('--font-sans: "Nebula Sans", ui-sans-serif, system-ui');
    expect(sourceCss).toContain('--font-serif: ui-serif, "Iowan Old Style", Baskerville');
    expect(sourceCss).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-sans\)/su);
    expect(sourceCss).toMatch(/\.wordmark\s*\{[^}]*font-family:\s*var\(--font-serif\)/su);
    expect(sourceCss).toMatch(/\.hero h1,[\s\S]*?\.preview-copy h1\s*\{[^}]*font-family:\s*var\(--font-serif\)/u);
    expect(sourceCss).toMatch(/\.preview-copy > p:last-child\s*\{(?![^}]*font-family)[^}]*\}/su);
    expect(sourceCss).toMatch(/\.preview-eyebrow\s*\{[^}]*font-family:\s*var\(--font-mono\)/su);
    expect(sourceCss).toMatch(/\.preview-flow li\s*\{[^}]*font-family:\s*var\(--font-mono\)/su);
    expect(cssPropertyValues(sourceCss, ".artifact-table table", "table-layout")).toEqual([
      "fixed",
    ]);
    expect(cssPropertyValues(sourceCss, ".version-table table", "min-width")).toEqual([
      "58rem",
    ]);
    expect(cssPropertyValues(sourceCss, ".guide-article", "max-width").at(-1)).toBe("58rem");
    expect(cssPropertyValues(sourceCss, ".content", "max-width").at(-1)).toBe("80rem");
    expect(cssPropertyValues(sourceCss, ".card-grid", "grid-template-columns")).toEqual([
      "repeat(2, minmax(0, 1fr))",
      "1fr",
    ]);
    expect(EDITORIAL_ARTICLE_IMAGE_SIZES).toBe(
      "(max-width: 31.25rem) calc(100vw - 2.5rem), (max-width: 63rem) 92vw, 58rem",
    );
    expect(EDITORIAL_CARD_IMAGE_SIZES).toBe(
      "(max-width: 31.25rem) calc(100vw - 2.5rem), (max-width: 45rem) 92vw, (max-width: 80rem) 46vw, (max-width: 100rem) calc(40rem - 4vw), 36rem",
    );
    expect(cssPropertyValues(
      sourceCss,
      ".artifact-table td:nth-child(4)",
      "width",
    )).toEqual(["33%"]);
    expect(builtCss).toContain('font-family: "Nebula Sans";');
    expect(builtCss).toContain('./fonts/nebula-sans/NebulaSans-Book.woff2');
    expect((await readFile(
      join(websiteRoot, "dist/assets/fonts/nebula-sans/NebulaSans-Book.woff2"),
    )).byteLength).toBeGreaterThan(60_000);
    expect(await readFile(
      join(websiteRoot, "dist/assets/fonts/nebula-sans/PROVENANCE.md"),
      "utf8",
    )).toContain("https://www.nebulasans.com/download/NebulaSans-1.010.zip");

    expect(html).toContain(`<title>${SITE_TITLE}</title>`);
    for (const page of pages) {
      expect(page.html.match(/data-slot="ask-ai-about-this"/gu)).toHaveLength(1);
      const destination = new URL("https://chatgpt.com/");
      destination.searchParams.set(
        "q",
        `Tell me about ${SITE_ORIGIN}${page.definition.canonicalPath}`,
      );
      expect(page.html).toContain(destination.href.replaceAll("&", "&amp;"));
    }
    expect(preview).not.toContain('data-slot="ask-ai-about-this"');
    expect(notFound).not.toContain('data-slot="ask-ai-about-this"');
    expect(html).toContain(`<meta name="description" content="${SITE_DESCRIPTION}">`);
    expect(html).toContain('<link rel="canonical" href="https://wrench.rip/">');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(html).toContain('<meta property="og:image" content="https://wrench.rip/og.png">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="robots" content="max-image-preview:large">');
    expect(html).not.toContain('<meta name="keywords"');
    expect(html).toContain(`@hraness/wrench@${packageIdentity.version}`);
    expect(html).toContain(`Install Wrench ${packageIdentity.release}`);
    expect(html).toContain(`>${skillInstallCommands.npx}</code>`);
    expect(html).toContain(`<code>${skillInstallCommands.bunx}</code>`);
    expect(html).toContain(
      `<a href="${SKILLS_URL}">View the Wrench Agent Skill on skills.sh.</a>`,
    );
    expect(html).toContain(
      `<a href="${npmPackageUrl}"><code>@hraness/wrench</code> package on npm</a>`,
    );
    expect(html).not.toContain(`value="${skillInstallCommands.npx}"`);
    expect(html).not.toContain(`href="${NPM_PACKAGE_URL}"`);
    expect(html).not.toContain("skills add hraness/wrench</code>");
    expect(html).toContain('class="skill-install" data-skill-install');
    expect(html).toContain("data-skill-install-copy");
    expect(html).toMatch(/data-skill-install-copy\s+hidden/gu);
    expect(html).toContain('aria-label="Copy Agent Skill install command"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain('/assets/skill-install-');
    expect(html.indexOf('class="hero-explainer"')).toBeLessThan(
      html.indexOf('class="skill-install"'),
    );
    expect(html).not.toContain("{{");
    expect(html).not.toContain("@jungle/");
    expect(html).not.toContain("hraness.com/wrench");
    expect(html.match(/<h1\b/gu)).toHaveLength(1);
    expect(html.match(/<details\b/gu)).toHaveLength(5);
    expect(html).toContain('class="table-scroll" role="region" tabindex="0"');
    expect(html).toContain('<a class="skip-link" href="#main">');
    expect(html.match(/data-analytics-event="project link opened"/gu)).toHaveLength(2);
    expect(html.match(new RegExp(`href="${REPOSITORY_URL}"`, "gu"))).toHaveLength(2);
    expect(html).toContain("Privacy: cookieless PostHog analytics");
    expect(html).toContain('href="/compare/personal-agents-browser-use/"');
    expect(html).toContain('href="/agentic-web-spoofing/"');
    expect(html).toContain('href="/vms-cannot-contain-agents/"');
    expect(html).toContain('href="/paypal-grapheneos-attestation/"');
    expect(html).toContain('href="/rumour-is-the-exploit/"');
    expect(html).toContain('href="/omarchy-root-escalation/"');
    expect(html).toContain('href="/providers/beeper/"');
    expect(html).toContain('href="/providers/whatsapp/"');
    const argumentsSection = /<section aria-labelledby="arguments-title" class="section editorial-cluster">[\s\S]*?<\/section>/u
      .exec(html)?.[0];
    const guidesSection = /<section aria-labelledby="guides-title" class="section guide-cluster">[\s\S]*?<\/section>/u
      .exec(html)?.[0];
    expect(argumentsSection).toBeDefined();
    expect(guidesSection).toBeDefined();
    expect(argumentsSection).toContain('<h2 id="arguments-title">Arguments and comparisons</h2>');
    expect(argumentsSection).toContain('<div class="card-grid editorial-card-grid">');
    expect(argumentsSection?.match(/<article class="card(?: editorial-card)?">/gu)).toHaveLength(6);
    expect(guidesSection?.match(/<article class="card">/gu)).toHaveLength(5);
    expect(argumentsSection).toContain('href="/paypal-grapheneos-attestation/"');
    expect(argumentsSection).toContain('href="/rumour-is-the-exploit/"');
    expect(argumentsSection).toContain('href="/omarchy-root-escalation/"');
    expect(guidesSection).not.toContain('href="/paypal-grapheneos-attestation/"');
    expect(guidesSection).not.toContain('href="/rumour-is-the-exploit/"');
    expect(guidesSection).not.toContain('href="/omarchy-root-escalation/"');
    for (const image of editorialImages) {
      expect(argumentsSection).toContain(`href="${image.canonicalPath}"`);
      expect(guidesSection).not.toContain(`href="${image.canonicalPath}"`);
    }
    expect(guidesSection).not.toContain('class="card editorial-card"');
    expect(html.indexOf(argumentsSection ?? "")).toBeLessThan(html.indexOf(guidesSection ?? ""));
    expect(html).toContain("Give your coding agent bounded access to the web.");
    const indeterminateWriteBoundary =
      "An indeterminate write is never blindly retried and remains unsettled until separate exact evidence can reconcile it.";
    for (const surface of [html, readme]) {
      expect(surface.replaceAll(/\s+/gu, " ")).toContain(indeterminateWriteBoundary);
      expect(surface).not.toContain("An indeterminate write is reconciled");
    }
    expect(html).toContain('data-hraness-marketing="hero"');
    expect(html).toContain('data-hraness-marketing="install"');
    expect(html).toContain('data-hraness-marketing="interfaces"');
    expect(html).toContain('data-hraness-marketing="trust"');
    expect(html).toContain('data-hraness-marketing="questions"');
    expect(html).toContain('data-hraness-marketing="cta"');
    expect(html).toContain("The same boundary from three surfaces.");
    expect(html).toContain('import { isProviderPluginId } from "@hraness/wrench"');
    expect(html).toMatch(/Reviewed operations across \d+ supported services\./u);
    expect(html).toContain('class="wordmark" href="/">Wrench</a>');
    expect(html).not.toMatch(/hero-field|hero-orbit|hero-glyph/u);
    expect(html).not.toMatch(/observed provider operations|capture-required|unavailable reservations/iu);
    expect(html).not.toContain("🔧");
    expect(html).toContain(`href="${PUBLISHER_URL}">Hraness GitHub organization</a>`);
    expect(preview).toContain("<title>Wrench preview</title>");
    expect(preview).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(preview).toContain('<link rel="canonical" href="https://wrench.rip/">');
    expect(preview).toContain(`<link rel="stylesheet" href="${cssAsset}">`);
    expect(preview).toContain('<body class="preview-body">');
    expect(preview).toContain("Give your coding agent bounded access to the web.");
    expect(preview).toContain("Capture pages, preserve media, and use supported provider actions");
    expect(preview).toContain('class="preview-wordmark">Wrench</p>');
    expect(preview).not.toMatch(/preview-field|preview-orbit|src="\/favicon\.svg"/u);
    expect(preview.match(/<h1\b/gu)).toHaveLength(1);
    expect(preview).not.toContain("{{");
    expect(preview).not.toMatch(/<(?:a|button|form|input|script)\b/iu);
    expect(preview).not.toContain("data-analytics");
    expect(preview).not.toContain("PostHog");
    expect(preview).not.toContain('type="application/ld+json"');
    expect(preview).not.toContain('rel="alternate"');
    expect(preview).not.toMatch(/\b(?:account|authentication|log in|sign in|user data)\b/iu);
    expect(await Bun.file(join(websiteRoot, "dist/preview.md")).exists()).toBe(false);
    expect(notFound).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(notFound).toContain(
      '<meta name="theme-color" content="#f5f3ed" media="(prefers-color-scheme: light)">',
    );
    expect(notFound).toContain(
      '<meta name="theme-color" content="#0e1113" media="(prefers-color-scheme: dark)">',
    );
    expect(notFound).toContain("Privacy: this page uses cookieless, personless PostHog analytics");
    expect(notFound).toContain('href="/llms.txt"');
    expect(notFound).toContain('href="/sitemap.xml"');
    expect(notFound).toContain('href="/getting-started/"');
    expect(notFound).not.toContain('type="application/ld+json"');
    expect(notFoundMarkdown).toContain("# This handle does not exist.");
    expect(notFoundMarkdown).toContain("https://wrench.rip/llms.txt");
    expect(notFoundMarkdown).toContain("https://wrench.rip/sitemap.xml");
    expect(llms).toContain("# Wrench");
    expect(llms).toContain("## When to use Wrench");
    expect(llms).toContain("## Wrench developer resources");
    expect(llms).toContain("Do not use Wrench as an AI agent");
    expect(llms).toContain(`${SITE_ORIGIN}/getting-started/`);
    expect(llms).toContain(`${SITE_ORIGIN}/compare/personal-agents-browser-use/`);
    expect(llms).toContain(`${SITE_ORIGIN}/paypal-grapheneos-attestation/`);
    expect(llms).toContain(`${SITE_ORIGIN}/rumour-is-the-exploit/`);
    expect(llms).toContain(`${SITE_ORIGIN}/omarchy-root-escalation/`);
    expect(llms).not.toContain(`${SITE_ORIGIN}/agentic-web-spoofing/`);
    expect(llms).not.toContain(`${SITE_ORIGIN}/vms-cannot-contain-agents/`);
    expect(llms).toContain(`${SITE_ORIGIN}/providers/beeper/`);
    expect(llms).toContain(
      `${String(beeperOperationCount)} supported actions. ${String(BEEPER_PRESENTATION_TRANSPORT_COUNTS.cliBackedOperationCount)} run through the pinned \`@beeper/cli\` 0.6.2 executable and ${String(BEEPER_PRESENTATION_TRANSPORT_COUNTS.desktopLoopbackOperationCount)} use fixed Desktop loopback reads.`,
    );
    expect(llms).toContain("Message mutations require preview and confirmation.");
    expect(llms).not.toContain("Message actions are previewed and confirmed.");
    expect(llms).not.toContain("actions\u201427");
    expect(llms).toContain("pending message ID proves submission to Desktop only, not network delivery");
    expect(llms).toContain("Tagged `packages/cli/package.json` declares 0.6.1 and is provenance-only");
    expect(llms).toContain("exact executable runtime identity remains authoritative");
    expect(llms).toContain(`${SITE_ORIGIN}/providers/whatsapp/`);
    expect(llms).toContain("does not pair, sync, or send");
    expect(llms).toContain("submission is not a delivery claim");
    expect(llms.replaceAll(/https:\/\/wrench\.rip\/[a-z0-9-/]+/gu, "")).not.toMatch(
      /observed|capture-required|reservation|attestation/iu,
    );
    expect(llms).toContain(skillInstallCommands.npx);
    expect(llms).toContain(skillInstallCommands.bunx);
    expect(llms).not.toContain("skills add hraness/wrench`");
    expect(llms).toContain("Accept: text/markdown");
    expect(llms).not.toContain("{{");
    expect(robots).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
    expect(sitemap.match(/<url>/gu)).toHaveLength(PUBLIC_PAGES.length);
    expect(sitemap).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(sitemap.match(/<image:image>/gu)).toHaveLength(editorialImages.length);
    for (const page of PUBLIC_PAGES) {
      expect(sitemap).toContain(`<loc>${SITE_ORIGIN}${page.canonicalPath}</loc>`);
    }
    for (const image of editorialImages) {
      expect(sitemap).toContain(`<image:loc>${editorialImageUrl(image)}</image:loc>`);
      expect(sitemap).toContain(`<image:title>${image.title}</image:title>`);
      expect(sitemap).toContain(`<image:caption>${image.caption}</image:caption>`);
    }
    expect(sitemap).not.toContain("paypal-grapheneos-attestation.webp");
    expect(sitemap).not.toContain("rumour-is-the-exploit.webp");
    expect(sitemap).not.toContain("omarchy-root-escalation.webp");
    expect(sitemap).not.toContain("<lastmod>");
    expect(sitemap).not.toContain("<changefreq>");
    expect(sitemap).not.toContain("<priority>");
    expect(sitemap).not.toContain("hraness.com");
    expect(sitemap).not.toContain("/preview/");
    expect(llms).not.toContain("/preview/");
    expect(indexNowKey).toBe("dc84ee4863539f2fff50ef5f0a164168\n");
    expect(favicon).toContain('viewBox="0 0 64 64"');
    expect(sourceCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(sourceCss).toContain("@media (forced-colors: active)");
    expect(sourceCss).not.toContain(".footer {");
    expect(builtCss).toContain(".hraness-site-footer {");
    expect(builtCss).toContain(".hraness-marketing-hero {");
    expect(builtCss).toContain("@media (pointer: coarse)");
    for (const css of [sourceCss, builtCss]) {
      expect(css).toMatch(
        /\.wrench-product-hero\s*\{[^{}]*\bgrid-column:\s*1\s*\/\s*-1\s*;/u,
      );
      const providerMarkDisplay = cssPropertyValues(css, ".provider-mark", "display");
      expect(providerMarkDisplay.length).toBeGreaterThan(0);
      expect(providerMarkDisplay).not.toContain("none");
      expect(providerMarkDisplay.at(-1)).toBe("inline-flex");
      const providerFeatureDisplay = cssPropertyValues(css, ".provider-feature-copy", "display");
      expect(providerFeatureDisplay.length).toBeGreaterThan(0);
      expect(providerFeatureDisplay).not.toContain("none");
      expect(providerFeatureDisplay.at(-1)).toBe("block");
    }
    const expectedFooterHrefs = [
      HRANESS_HOME_URL,
      ...hranessSocialLinks.map(({ href }) => href),
    ];
    for (const document of [...pages.map(({ html: pageHtml }) => pageHtml), notFound]) {
      expect(document.match(/<footer\b/gu)).toHaveLength(1);
      const footer = /<footer\b[\s\S]*?<\/footer>/u.exec(document)?.[0];
      expect(footer).toBeDefined();
      expect(footer).toContain('data-slot="hraness-site-footer"');
      expect(footer).toContain('data-mailing-list="signup"');
      expect(footer).toContain(`action="${HRANESS_MAILING_SUBSCRIBE_URL}"`);
      expect(footer).toContain('name="audience" type="hidden" value="wrench"');
      expect(footer).toContain(`src="${HRANESS_TURNSTILE_SCRIPT_URL}"`);
      expect(footer?.match(/data-slot="hraness-mark"/gu)).toHaveLength(1);
      expect(footer?.match(/data-slot="social-icon"/gu)).toHaveLength(10);
      expect(
        [...(footer?.matchAll(/<a\b[^>]*\shref="([^"]+)"/gu) ?? [])]
          .map((match) => match[1]),
      ).toEqual(expectedFooterHrefs);
    }
    for (const demo of demoFiles) expect(demo.output).toEqual(demo.source);
    const demoPng = demoFiles.find(({ file }) => file.endsWith(".png"))?.output;
    const demoGif = demoFiles.find(({ file }) => file.endsWith(".gif"))?.output;
    const demoMp4 = demoFiles.find(({ file }) => file.endsWith(".mp4"))?.output;
    const demoWebm = demoFiles.find(({ file }) => file.endsWith(".webm"))?.output;
    const demoVtt = demoFiles.find(({ file }) => file.endsWith(".vtt"))?.output;
    expect(Array.from(demoPng?.slice(1, 4) ?? [])).toEqual([80, 78, 71]);
    const demoPngView = new DataView(demoPng!.buffer, demoPng!.byteOffset, demoPng!.byteLength);
    expect(demoPngView.getUint32(16)).toBe(1280);
    expect(demoPngView.getUint32(20)).toBe(720);
    expect(new TextDecoder().decode(demoGif?.slice(0, 6))).toBe("GIF89a");
    const demoGifView = new DataView(demoGif!.buffer, demoGif!.byteOffset, demoGif!.byteLength);
    expect(demoGifView.getUint16(6, true)).toBe(960);
    expect(demoGifView.getUint16(8, true)).toBe(540);
    expect(new TextDecoder().decode(demoMp4?.slice(4, 8))).toBe("ftyp");
    expect(Array.from(demoWebm?.slice(0, 4) ?? [])).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(new TextDecoder().decode(demoVtt?.slice(0, 6))).toBe("WEBVTT");
    expect(vercel).toMatchObject({
      buildCommand: "WRENCH_VERCEL_BUILD=release-bound-v1 bunx bun@1.3.14 run website:vercel-build",
      framework: null,
      outputDirectory: "website/dist",
    });
    expect(vercel.rewrites).toEqual(expect.arrayContaining([
      {
        destination: "/index.md",
        has: [{ key: "accept", type: "header", value: "text/markdown" }],
        source: "/",
      },
      {
        destination: "/:path.md",
        has: [{ key: "accept", type: "header", value: "text/markdown" }],
        source: "/:path((?!preview/).*)/",
      },
    ]));
    const markdownRewrite = vercel.rewrites.find((rule: { source: string }) =>
      rule.source === "/:path((?!preview/).*)/");
    expect(markdownRewrite?.destination).toBe("/:path.md");
    const markdownRewritePattern = /^\/((?!preview\/).*)\/$/u;
    expect(markdownRewritePattern.test("/preview/")).toBe(false);
    for (const path of ["/getting-started/", "/providers/beeper/", "/missing/"]) {
      expect(markdownRewritePattern.test(path)).toBe(true);
    }
    const commonHeaders = vercel.headers.find((rule: { source: string }) =>
      rule.source === "/(.*)");
    expect(commonHeaders?.headers).toEqual([
      {
        key: "Permissions-Policy",
        value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Vary", value: "Accept" },
    ]);

    const frameDenyHeaders = vercel.headers.find((rule: { source: string }) =>
      rule.source === "/((?!preview/$).*)");
    expect(frameDenyHeaders?.headers).toEqual([
      { key: "X-Frame-Options", value: "DENY" },
      {
        key: "Content-Security-Policy",
        value: "form-action 'self' https://account.hraness.com; frame-src https://challenges.cloudflare.com; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://*.posthog.com https://*.posthogusercontent.com",
      },
    ]);
    const frameDenyPattern = /^\/((?!preview\/$).*)$/u;
    expect(frameDenyPattern.test("/preview/")).toBe(false);
    for (const deniedPath of [
      "/",
      "/preview",
      "/preview/index.html",
      "/preview/anything",
      "/security/",
      "/assets/example.css",
    ]) {
      expect(frameDenyPattern.test(deniedPath)).toBe(true);
    }

    const previewHeaders = vercel.headers.find((rule: { source: string }) =>
      rule.source === "/preview/");
    expect(previewHeaders?.headers).toEqual([
      {
        key: "Content-Security-Policy",
        value: "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com",
      },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ]);
    expect(vercel.headers.filter((rule: { headers: Array<{ key: string }> }) =>
      rule.headers.some((header) => header.key === "X-Frame-Options"))).toEqual([
      frameDenyHeaders,
    ]);
    expect(vercel.headers.filter((rule: { headers: Array<{ key: string }> }) =>
      rule.headers.some((header) => header.key === "Content-Security-Policy"))).toEqual([
      frameDenyHeaders,
      previewHeaders,
    ]);

    expect(vercel.headers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        headers: expect.arrayContaining([
          expect.objectContaining({
            key: "Content-Type",
            value: "text/markdown; charset=utf-8",
          }),
        ]),
        source: "/(.*).md",
      }),
    ]));
    expect(middleware).toContain("handleDocumentNegotiation");
    expect(middleware).toContain("./edge/negotiation");
    expect(middleware).not.toContain("website/");
    expect(vercel.redirects).toEqual(expect.arrayContaining([
      { destination: "/", permanent: true, source: "/index.html" },
      { destination: "/preview/", permanent: true, source: "/preview" },
      { destination: "/preview/", permanent: true, source: "/preview/index.html" },
      ...PUBLIC_PAGES.slice(1).map((page) => ({
        destination: page.canonicalPath,
        permanent: true,
        source: page.canonicalPath.slice(0, -1),
      })),
      ...PUBLIC_PAGES.slice(1).map((page) => ({
        destination: page.canonicalPath,
        permanent: true,
        source: `/${page.outputFile}`,
      })),
    ]));

    const structuredMatch = /<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(html);
    expect(structuredMatch?.[1]).toBeDefined();
    const structured: unknown = JSON.parse(structuredMatch?.[1] ?? "null");
    const graph = (structured as { "@graph"?: unknown })["@graph"];
    expect(Array.isArray(graph)).toBe(true);
    expect(graph).toEqual(expect.arrayContaining([
      expect.objectContaining({ "@id": `${SITE_ORIGIN}/#website`, "@type": "WebSite" }),
      expect.objectContaining({
        "@id": `${SITE_ORIGIN}/#organization`,
        "@type": "Organization",
        url: PUBLISHER_URL,
      }),
      expect.objectContaining({
        "@id": `${SITE_ORIGIN}/#webpage`,
        isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
        mainEntity: { "@id": `${SITE_ORIGIN}/#software` },
      }),
      expect.objectContaining({
        "@id": `${SITE_ORIGIN}/#software`,
        sameAs: [
          "https://github.com/hraness/wrench",
          npmPackageUrl,
          "https://skills.sh/hraness/wrench",
        ],
        softwareVersion: packageIdentity.version,
      }),
      expect.objectContaining({
        "@id": `${SITE_ORIGIN}/#source`,
        codeRepository: REPOSITORY_URL,
        targetProduct: { "@id": `${SITE_ORIGIN}/#software` },
        version: packageIdentity.version,
      }),
    ]));

    const descriptions = new Set<string>();
    for (const { definition, html: pageHtml } of pages) {
      const canonicalUrl = `${SITE_ORIGIN}${definition.canonicalPath}`;
      expect(pageHtml).toContain(`<title>${definition.title}</title>`);
      expect(pageHtml).toContain(`<meta name="description" content="${definition.description}">`);
      expect(pageHtml).toContain('class="wordmark" href="/">Wrench</a>');
      expect(pageHtml).not.toContain('class="wordmark" href="/">WRENCH</a>');
      expect(pageHtml).toContain(`<link rel="canonical" href="${canonicalUrl}">`);
      expect(pageHtml).toContain(`<meta property="og:title" content="${definition.title}">`);
      expect(pageHtml).toContain(`<meta property="og:description" content="${definition.description}">`);
      expect(pageHtml).toContain(`<meta property="og:url" content="${canonicalUrl}">`);
      expect(pageHtml).toContain(`<meta name="twitter:title" content="${definition.title}">`);
      expect(pageHtml).toContain(`<meta name="twitter:description" content="${definition.description}">`);
      expect(pageHtml).toContain('<meta name="robots" content="max-image-preview:large">');
      expect(pageHtml).toContain(`<link rel="alternate" type="text/markdown" title="Markdown" href="${SITE_ORIGIN}${markdownSiblingPath(definition.canonicalPath)}">`);
      expect(pageHtml).toContain('href="/about/"');
      expect(pageHtml).toContain('href="/contact/"');
      expect(pageHtml).toContain('href="/privacy/"');
      expect(pageHtml).toContain('href="/llms.txt"');
      expect(pageHtml).toContain(
        '<meta name="theme-color" content="#f5f3ed" media="(prefers-color-scheme: light)">',
      );
      expect(pageHtml).toContain(
        '<meta name="theme-color" content="#0e1113" media="(prefers-color-scheme: dark)">',
      );
      expect(pageHtml.match(/<meta name="theme-color"/gu)).toHaveLength(2);
      expect(pageHtml.match(/<h1\b/gu)).toHaveLength(1);
      expect(pageHtml).not.toContain('<meta name="keywords"');
      expect(pageHtml).not.toContain("{{");
      expect(pageHtml).not.toContain("FAQPage");
      descriptions.add(definition.description);

      const markdown = await readFile(
        join(websiteRoot, "dist", markdownSiblingPath(definition.canonicalPath).slice(1)),
        "utf8",
      );
      expect(markdown.startsWith("# ")).toBe(true);
      expect(markdown).toContain("Wrench");
      expect(markdown).not.toMatch(/<\/[a-z]+>/i);
      expect(markdown.length).toBeGreaterThan(400);

      const jsonMatch = /<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(pageHtml);
      expect(jsonMatch?.[1]).toBeDefined();
      const pageStructured: unknown = JSON.parse(jsonMatch?.[1] ?? "null");
      const pageGraph = (pageStructured as { "@graph"?: unknown })["@graph"];
      expect(Array.isArray(pageGraph)).toBe(true);
      expect(pageGraph).toEqual(expect.arrayContaining([
        expect.objectContaining({
          "@id": `${canonicalUrl}#webpage`,
          "@type": "WebPage",
          name: definition.title,
          url: canonicalUrl,
        }),
        expect.objectContaining({ "@id": `${SITE_ORIGIN}/#software` }),
        expect.objectContaining({ "@id": `${SITE_ORIGIN}/#organization` }),
      ]));

      if (definition.canonicalPath !== "/") {
        expect(pageHtml).toContain('class="answer-lede"');
        expect(pageHtml).toContain('aria-label="Breadcrumb"');
        expect(pageHtml.match(/<h2\b/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
        expect(pageGraph).toEqual(expect.arrayContaining([
          expect.objectContaining({
            "@id": `${canonicalUrl}#article`,
            "@type": "TechArticle",
            mainEntityOfPage: { "@id": `${canonicalUrl}#webpage` },
          }),
          expect.objectContaining({
            "@id": `${canonicalUrl}#breadcrumb`,
            "@type": "BreadcrumbList",
          }),
        ]));
      }
    }
    expect(descriptions.size).toBe(PUBLIC_PAGES.length);

    const homepageMarkdown = await readFile(
      join(websiteRoot, "dist", markdownSiblingPath("/").slice(1)),
      "utf8",
    );
    expect(homepageMarkdown).not.toContain("![](");
    for (const image of editorialImages) {
      expect(homepageMarkdown).toContain(image.cardTitle);
      expect(homepageMarkdown).not.toContain(editorialImageUrl(image));
    }

    const editorialCards = html.match(
      /<article class="card editorial-card">[\s\S]*?<\/article>/gu,
    ) ?? [];
    expect(editorialCards).toHaveLength(editorialImages.length);
    for (const [index, image] of editorialImages.entries()) {
      const card = editorialCards[index] ?? "";
      expect(card).toMatch(
        /^<article class="card editorial-card">\s*<a href="[^"]+">[\s\S]*<\/a>\s*<\/article>$/u,
      );
      expect(card.match(/<a\b/gu)).toHaveLength(1);
      expect(card).toContain(`<a href="${image.canonicalPath}">`);
      expect(card.match(/<h[1-6]\b/gu)).toHaveLength(1);
      expect(card.match(/<h3\b/gu)).toHaveLength(1);
      expect(card.match(/<\/h3>/gu)).toHaveLength(1);
      expect(card).toContain(`<h3>${image.cardTitle}</h3>`);
      expect(card).toContain(
        `<p class="editorial-card-description">${image.cardDescription}</p>`,
      );
      expect(card).toMatch(/<\/h3>\s*<p class="editorial-card-description">/u);
      expect(card).not.toContain(`</strong>${image.cardDescription}`);
      expect(card).not.toMatch(/<\/h3>[^<\s]/u);
      const linkEnd = card.lastIndexOf("</a>");
      expect(card.indexOf("<img ")).toBeLessThan(linkEnd);
      expect(card).toContain(`sizes="${EDITORIAL_CARD_IMAGE_SIZES}"`);
      expect(card.indexOf("<h3>")).toBeLessThan(linkEnd);
      expect(card.indexOf('<p class="editorial-card-description">')).toBeLessThan(linkEnd);

      const page = pages.find(({ definition }) =>
        definition.canonicalPath === image.canonicalPath);
      expect(page).toBeDefined();
      const imageUrl = editorialImageUrl(image);
      expect(page?.html).toContain(`<meta property="og:image" content="${imageUrl}">`);
      expect(page?.html).toContain(`<meta property="og:image:width" content="${image.width}">`);
      expect(page?.html).toContain(`<meta property="og:image:height" content="${image.height}">`);
      expect(page?.html).toContain(`<meta property="og:image:alt" content="${image.alt}">`);
      expect(page?.html).toContain(`<meta name="twitter:image" content="${imageUrl}">`);
      expect(page?.html).toContain(`<meta name="twitter:image:alt" content="${image.alt}">`);
      expect(page?.html).toContain(`class="editorial-figure"`);
      expect(page?.html).toContain(`src="${image.src}"`);
      expect(page?.html).toContain(`srcset="${editorialImageSrcSet(image)}"`);
      expect(page?.html).toContain(`sizes="${EDITORIAL_ARTICLE_IMAGE_SIZES}"`);
      expect(page?.html).not.toContain('fetchpriority="high"');
      expect(page?.html).toContain(`alt="${image.alt}"`);
      expect(page?.html).toContain(image.caption);
      expect(page?.html).toContain(image.credit);
      expect(image.credit).toBe("Editorial illustration generated for Wrench with Atet.");
      expect(page?.html).not.toContain("editorial-provenance/");
      expect(page?.html).not.toContain("gateway_");
      const answerLedeIndex = page?.html.indexOf('class="answer-lede"') ?? -1;
      const figureIndex = page?.html.indexOf('class="editorial-figure"') ?? -1;
      const reviewNoteIndex = page?.html.indexOf('class="review-note"') ?? -1;
      expect(answerLedeIndex).toBeGreaterThan(-1);
      expect(figureIndex).toBeGreaterThan(answerLedeIndex);
      expect(reviewNoteIndex).toBeGreaterThan(figureIndex);

      const editorialMarkdown = await readFile(
        join(websiteRoot, "dist", markdownSiblingPath(image.canonicalPath).slice(1)),
        "utf8",
      );
      expect(editorialMarkdown).toContain(`![${image.alt}](${imageUrl})`);
      expect(editorialMarkdown).toContain(`${image.caption} ${image.credit}`);

      const structuredMatch = /<script type="application\/ld\+json">([^<]+)<\/script>/u
        .exec(page?.html ?? "");
      const structured = JSON.parse(structuredMatch?.[1] ?? "null") as {
        "@graph"?: Array<{ "@type"?: string; image?: unknown }>;
      };
      const article = structured["@graph"]?.find((entry) => entry["@type"] === "TechArticle");
      expect(article?.image).toEqual({
        "@type": "ImageObject",
        caption: image.caption,
        contentUrl: imageUrl,
        creditText: image.credit,
        height: image.height,
        url: imageUrl,
        width: image.width,
      });

      const fileBytes = new Uint8Array(await Bun.file(join(websiteRoot, "public", image.src)).arrayBuffer());
      expect(createHash("sha256").update(fileBytes).digest("hex")).toBe(image.imageSha256);
      expect(lossyWebpDimensions(fileBytes)).toEqual({ height: image.height, width: image.width });
      const derivativeByteLengths: number[] = [];
      for (const derivative of image.derivatives) {
        const derivativeBytes = new Uint8Array(
          await Bun.file(join(websiteRoot, "public", derivative.src)).arrayBuffer(),
        );
        expect(createHash("sha256").update(derivativeBytes).digest("hex"))
          .toBe(derivative.sha256);
        expect(lossyWebpDimensions(derivativeBytes)).toEqual({
          height: derivative.height,
          width: derivative.width,
        });
        derivativeByteLengths.push(derivativeBytes.byteLength);
      }
      expect(derivativeByteLengths[0]).toBeLessThan(derivativeByteLengths[1] ?? 0);
      expect(derivativeByteLengths[1]).toBeLessThan(fileBytes.byteLength);
      const receipt = await Bun.file(join(websiteRoot, image.provenance.receipt)).json() as {
        localValidation?: { status?: string };
        outputs?: Array<{ sha256?: string }>;
        request?: { promptSha256?: string };
      };
      const job = await Bun.file(join(websiteRoot, image.provenance.job)).json() as {
        clientMaxRetries?: number;
        noAtetRetry?: boolean;
        request?: { promptSha256?: string };
        state?: string;
      };
      const prompt = await Bun.file(join(websiteRoot, image.provenance.prompt)).text();
      expect(receipt.outputs?.[0]?.sha256).toBe(image.imageSha256);
      expect(receipt.localValidation?.status).toBe("decode-passed");
      expect(job).toMatchObject({
        clientMaxRetries: 0,
        noAtetRetry: true,
        state: "completed",
      });
      const promptSha256 = createHash("sha256").update(prompt.trim()).digest("hex");
      expect(promptSha256).toBe(image.provenance.promptSha256);
      expect(job.request?.promptSha256).toBe(image.provenance.promptSha256);
      expect(receipt.request?.promptSha256).toBe(image.provenance.promptSha256);
    }
    expect(editorialImages.some(({ canonicalPath }) =>
      canonicalPath === ("/paypal-grapheneos-attestation/" as never))).toBe(false);
    expect(editorialImages.some(({ canonicalPath }) =>
      canonicalPath === ("/rumour-is-the-exploit/" as never))).toBe(false);
    expect(editorialImages.some(({ canonicalPath }) =>
      canonicalPath === ("/omarchy-root-escalation/" as never))).toBe(false);

    expect(html).toContain('href="https://pipedream.com/docs/connect">Pipedream Connect</a>');
    expect(html).toContain("Hosted integration breadth and managed end-user authentication");
    expect(html).toContain('href="https://docs.apify.com/integrations/mcp">Apify MCP</a>');
    expect(html).toContain("Discovering and running eligible Apify Store Actors");
    expect(html).toContain('href="https://docs.browserbase.com/platform/browser/observability/session-recording">Browserbase</a>');
    expect(html).toContain("Parallel browser automation on managed cloud sessions");
    expect(html).toContain(
      "Encrypted provider snapshots and projections, mutation previews and receipts, and fail-closed contract drift",
    );

    const gettingStarted = pages.find((page) => page.definition.canonicalPath === "/getting-started/");
    expect(gettingStarted?.html).toContain("Wrench developer resources");
    expect(gettingStarted?.html).toContain(
      `<a href="${npmPackageUrl}">Install the <code>@hraness/wrench</code> CLI and TypeScript SDK from npm</a>`,
    );
    expect(gettingStarted?.html).toContain(
      `<a href="${SKILLS_URL}">Install the Wrench Agent Skill from skills.sh</a>`,
    );
    expect(gettingStarted?.html).toContain(`<code>${skillInstallCommands.npx}</code>`);
    expect(gettingStarted?.html).toContain("does not publish a hosted API");
    expect(gettingStarted?.html).toContain('id="demo"');
    expect(gettingStarted?.html).toContain('poster="/wrench-first-capture.png"');
    expect(gettingStarted?.html).toContain('src="/wrench-first-capture.webm"');
    expect(gettingStarted?.html).toContain('src="/wrench-first-capture.mp4"');
    expect(gettingStarted?.html).toContain('src="/wrench-first-capture.vtt"');
    expect(gettingStarted?.html).toContain('href="/wrench-first-capture.gif"');
    expect(gettingStarted?.html).not.toContain('class="editorial-figure"');
    expect(gettingStarted?.html).toContain("successful Wrench 0.13.5 run on August 25, 2026");
    expect(gettingStarted?.html).toContain("The terminal text is actual CLI output");

    const privacy = pages.find((page) => page.definition.canonicalPath === "/privacy/");
    expect(privacy?.html).toContain("The CLI stores state on the operator's machine");
    expect(privacy?.html).toContain("Local custody does not mean that every stored byte is encrypted");
    expect(privacy?.html).toContain("Wrench-managed Gmail OAuth JSON file");
    expect(privacy?.html).toContain("The CLI and SDK do not send wrench.rip analytics");
    expect(privacy?.html).toContain("wrench auth remove ID --yes");
    expect(privacy?.html).toContain("it is not a hostile native-code sandbox");
    expect(privacy?.html).toContain(
      "transient full copies of the private Photos and Contacts SQLite databases",
    );
    expect(privacy?.html).toContain("Those copies can include unselected columns and raw blobs");
    expect(privacy?.html).toContain("The privacy exclusions apply only to the returned JSON");
    expect(privacy?.html).toContain(
      "does not open, copy, or ask Photos to materialize referenced photo or video asset files",
    );

    const providerCapabilities = pages.find((page) =>
      page.definition.canonicalPath === "/provider-capabilities/");
    const attestation = await loadProviderCapabilityAttestation(repositoryRoot);
    const providerDirectory = createProviderDirectory(attestation);
    const providerCards = renderProviderOverviewCards(providerDirectory);
    const providerGroups = renderProviderAttestationGroups(providerDirectory, attestation);
    const providerMarkdown = await readFile(
      join(websiteRoot, "dist", markdownSiblingPath("/provider-capabilities/").slice(1)),
      "utf8",
    );
    expect(providerCapabilities?.html).toContain(
      "This directory lists the actions supported by the current Wrench release",
    );
    expect(html).toContain(providerCards);
    expect(providerCapabilities?.html).toContain(providerCards);
    expect(html.match(/class="provider-mark"/gu)).toHaveLength(providerDirectory.providerCount);
    expect(providerCapabilities?.html.match(/class="provider-mark"/gu))
      .toHaveLength(providerDirectory.providerCount);
    expect(html.match(/class="provider-feature-copy"/gu)).toHaveLength(1);
    expect(providerCapabilities?.html.match(/class="provider-feature-copy"/gu)).toHaveLength(1);
    expect(html).toContain(
      `${String(beeperOperationCount)} reviewed actions: ${String(BEEPER_PRESENTATION_TRANSPORT_COUNTS.cliBackedOperationCount)} through one pinned CLI and ${String(BEEPER_PRESENTATION_TRANSPORT_COUNTS.desktopLoopbackOperationCount)} fixed Desktop reads; writes are previewed and uncertain outcomes stay unretriable.`,
    );
    expect(providerCapabilities?.html).toContain(
      `${String(beeperOperationCount)} reviewed actions: ${String(BEEPER_PRESENTATION_TRANSPORT_COUNTS.cliBackedOperationCount)} through one pinned CLI and ${String(BEEPER_PRESENTATION_TRANSPORT_COUNTS.desktopLoopbackOperationCount)} fixed Desktop reads; writes are previewed and uncertain outcomes stay unretriable.`,
    );
    expect(html).toContain(
      `<h2 id="providers-title">Reviewed operations across ${String(providerDirectory.providerCount)} supported services.</h2>`,
    );
    expect(html).toContain(
      "These cards summarize capability families and access methods, then link",
    );
    expect(html).toContain("to the named actions supported in this release");
    expect(html).not.toContain("Each card names the actions");
    for (const entry of providerDirectory.entries) {
      expect(html).toContain(`data-provider-icon="${entry.icon}"`);
      expect(providerCapabilities?.html).toContain(`data-provider-icon="${entry.icon}"`);
    }
    expect(providerCapabilities?.html).toContain(providerGroups);
    expect(providerCapabilities?.html).toContain("Supported actions by service");
    expect(providerCapabilities?.html).toContain("Official API");
    expect(providerCapabilities?.html).toContain(`<code>contacts.list</code>`);
    expect(providerCapabilities?.html).toContain(
      "transient full copies of the current macOS account's private Photos and Contacts SQLite databases",
    );
    expect(providerCapabilities?.html).toContain("can include unselected columns and raw blobs");
    expect(providerCapabilities?.html).toContain("The listed exclusions apply only to the returned JSON");
    expect(providerCapabilities?.html).toContain(
      "does not open, copy, or ask Photos to materialize referenced photo or video asset files",
    );
    expect(providerCapabilities?.html).toContain("distinct <code>ZASSET</code>-row counts");
    expect(providerMarkdown).toContain("unselected columns and raw blobs");
    expect(providerMarkdown).toContain("exclusions apply only to the returned JSON");
    expect(providerMarkdown).toContain(
      "does not open, copy, or ask Photos to materialize referenced photo or video asset files",
    );
    expect(providerCapabilities?.html).not.toMatch(/observed|capture-required|reservation|completeness|adapter/iu);
    expect(providerCapabilities?.html).not.toContain("Telegram");
    expect(providerCapabilities?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(providerMarkdown).toContain("### Beeper");
    expect(providerMarkdown).toContain("32 supported actions");
    expect(providerMarkdown).toContain("- **List accounts** — `accounts.list` · Local app");
    expect(providerMarkdown).toContain(
      "- **Focus conversation** — `conversations.focus` · Local app",
    );
    expect(providerMarkdown).toContain(
      "- **Send Notify Anyway** — `conversations.notify` · Local app",
    );
    expect(providerMarkdown).toContain("- **Send message** — `messaging.send` · Local app");
    const providerActionLines = providerMarkdown.split("\n").filter((line) =>
      line.startsWith("- **"));
    expect(providerActionLines.length).toBeGreaterThan(0);
    expect(providerActionLines.every((line) =>
      /^- \*\*[^*]+\*\* — `[^`]+` · [^\s].+$/u.test(line))).toBe(true);
    expect(providerMarkdown).not.toMatch(/observed|capture-required|reservation|completeness|adapter/iu);

    const beeper = pages.find((page) => page.definition.canonicalPath === "/providers/beeper/");
    const beeperFacts = createBeeperPresentationFacts(providerDirectory);
    expect(beeper?.html).toContain(`<title>${beeperFacts.pageTitle}</title>`);
    expect(beeper?.html).toContain(
      `<meta name="description" content="${beeperFacts.pageDescription}">`,
    );
    expect(beeper?.html).toContain(
      `<h1>Use Beeper through ${beeperFacts.observedOperationCount} supported actions.</h1>`,
    );
    expect(beeper?.html).toContain(`adapter <code>beeper-local</code> ${beeperFacts.adapterVersion}`);
    expect(beeper?.html).toContain(`official Beeper CLI ${beeperFacts.cliVersion}`);
    expect(beeper?.html).toContain(
      `The tagged source path is <code>${beeperFacts.cliSourcePackagePath}</code>, and its declared ${beeperFacts.cliSourceDeclaredVersion} is provenance only`,
    );
    expect(beeper?.html).toContain(beeperFacts.cliSourceVersionDiscrepancy);
    expect(beeper?.html).toContain(
      `href="${beeperFacts.cliReleaseUrl}">official ${beeperFacts.cliVersion} release</a>`,
    );
    expect(beeper?.html).toContain(
      `${beeperFacts.semanticContractVersionLabel} across the current ${beeperFacts.observedOperationCount} operations`,
    );
    expect(beeper?.html).toContain(beeperFacts.artifactTable);
    expect(beeper?.html).toContain(
      `&lt;WRENCH_STATE_HOME&gt;/tools/beeper/${beeperFacts.cliVersion}/beeper`,
    );
    expect(beeper?.html).toContain('aria-current="location" href="/provider-capabilities/"');
    expect(beeper?.html).toContain("one fixed POST");
    expect(beeper?.html).toContain("pendingMessageID");
    expect(beeper?.html).toContain("proves submission to Desktop only, not network delivery");
    expect(beeper?.html).toContain("does not call the CLI or SDK and never retries");
    expect(beeper?.html).toContain("A separately obtained exact read may be inspected");
    expect(beeper?.html).toContain(
      "Without an already accepted exact provider message identity, the run remains indeterminate and unretriable",
    );
    expect(beeper?.html).toContain("only that identity could make reconciliation categorical");
    expect(beeper?.html).not.toContain(
      "reconcile the same run from a separately obtained exact read",
    );
    expect(beeper?.html).not.toContain("--wait");
    expect(beeper?.html).not.toContain("terminal returned message ID");
    expect(beeper?.html).toContain("Use Beeper directly when you want its first-party breadth");
    expect(beeper?.html).not.toContain("lowest-friction");
    expect(beeper?.html).toContain(
      'href="https://developers.beeper.com/desktop-api/mcp/">built-in Beeper Desktop MCP</a>',
    );
    expect(beeper?.html).toContain('href="https://github.com/beeper/cli">official Beeper CLI</a>');
    expect(beeper?.html).toContain("exact executable and adapter-version pinning");
    expect(beeper?.html).toContain(
      "write previews, durable receipts, contract-specific reconciliation for generic CLI mutations, and no blind retry",
    );
    expect(beeper?.html).toContain("encrypted snapshots");
    expect(beeper?.html).toContain("versioned Message Like Me and contact-interaction exports");
    expect(beeper?.html).toContain("It wraps only the actions listed for this release");
    expect(beeper?.html).toContain(`all ${beeperFacts.cliCommandCount} public manual command paths`);
    expect(beeper?.html.match(/Beeper's supported action names and access methods/gu))
      .toHaveLength(2);
    expect(beeper?.html).not.toContain("operation-level contracts, risks, and limits");
    expect(beeper?.html).not.toContain("all Beeper contracts");
    expect(beeper?.html).toContain("<code>targets status</code>, <code>version</code>, and top-level <code>export</code> are internal");
    expect(beeper?.html).toContain("plain <code>status</code> is among the 53 unsupported paths");
    expect(beeper?.html).toContain("<code>messages delete</code> are R4 and unavailable to provider dispatch");
    expect(beeper?.html).toContain("None of those three R4 paths appears in the selected 32-operation provider adapter");
    expect(beeper?.html).not.toContain("R4/capture-required");
    expect(beeper?.html).toContain("messages.delete");
    expect(beeper?.html).toContain("fall back to deletion for only the authenticated user");
    expect(beeper?.html).toContain("returns a void success response");
    expect(beeper?.html).toContain("never dispatches this action");
    expect(beeper?.html).toContain("media.download");
    expect(beeper?.html).toContain("buffers the complete media body to stdout");
    expect(beeper?.html).toContain("no reviewed finite supervisor and proven termination contract");
    expect(beeper?.html).toContain("top-level CLI export is internal-only");
    expect(beeper?.html).toContain("--no-attachments");
    expect(beeper?.html).toContain('href="https://developers.beeper.com/desktop-api/"');
    expect(beeper?.html).toContain("sending too many messages may result in suspension");
    expect(beeper?.html).toContain("network's throttling, automation, or suspension rules");
    expect(beeper?.html).toContain("These workflows are not part of the 32 supported actions");
    expect(beeper?.html).not.toMatch(/all Beeper (?:CLI )?features/iu);
    expect(beeper?.html).not.toMatch(/all (?:your )?chats/iu);
    expect(beeper?.html).not.toContain("exactly once");
    expect(beeper?.html).not.toContain("seamless");
    expect(beeper?.html).not.toContain("Provider capabilities attestation");
    expect(beeper?.html).toContain("wrench.messaging-route-resolve-request");
    const beeperJsonMatch = /<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(
      beeper?.html ?? "",
    );
    const beeperStructured = JSON.parse(beeperJsonMatch?.[1] ?? "null") as {
      "@graph"?: ReadonlyArray<Readonly<Record<string, unknown>>>;
    };
    const beeperBreadcrumb = beeperStructured["@graph"]?.find((node) =>
      node["@id"] === `${SITE_ORIGIN}/providers/beeper/#breadcrumb`);
    expect(beeperBreadcrumb).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { name: "Wrench", position: 1, item: `${SITE_ORIGIN}/` },
        { name: "Providers", position: 2, item: `${SITE_ORIGIN}/provider-capabilities/` },
        { name: "Beeper", position: 3, item: `${SITE_ORIGIN}/providers/beeper/` },
      ],
    });
    const agentFacingMessagingDocs = [
      beeper?.html ?? "",
      readme,
      await readFile(
        join(repositoryRoot, "skills/wrench/references/messaging.md"),
        "utf8",
      ),
    ];
    for (const document of agentFacingMessagingDocs) {
      expect(document).not.toContain("wrench beeper-local messaging.send");
      expect(document).toContain(
        '{"schemaVersion":2,"format":"wrench.messaging-route-resolve-request"',
      );
      expect(document).not.toContain(
        '{"schemaVersion":1,"format":"wrench.messaging-route-resolve-request"',
      );
      for (const command of [
        "wrench messaging routes",
        "wrench messaging resolve",
        "wrench messaging context",
        "wrench messaging preview",
      ]) expect(document).toContain(command);
    }

    const whatsapp = pages.find((page) =>
      page.definition.canonicalPath === "/providers/whatsapp/");
    const whatsappFacts = createWhatsAppPresentationFacts(providerDirectory, attestation);
    expect(whatsapp?.html).toContain(`<title>${whatsappFacts.pageTitle}</title>`);
    expect(whatsapp?.html).toContain(
      `<meta name="description" content="${whatsappFacts.pageDescription}">`,
    );
    expect(whatsapp?.html).toContain(
      "<h1>Export bounded WhatsApp history for Message Like Me.</h1>",
    );
    expect(whatsapp?.html).toContain("six NDJSON files plus <code>manifest.json</code>");
    expect(whatsapp?.html).toContain("local-message schema <code>2</code>");
    expect(whatsapp?.html).toContain("<code>wacli-local@1.0.0</code>");
    expect(whatsapp?.html).toContain("<code>whatsapp@0.15.0</code>");
    expect(whatsapp?.html).toContain("Message Like Me v0.7.0");
    expect(whatsapp?.html).toContain("phone-number (PN) and linked-identity (LID)");
    expect(whatsapp?.html).toContain("Reaction rows are excluded");
    expect(whatsapp?.html).toContain("<code>reaction-state-unproven</code>");
    expect(whatsapp?.html).toContain("<code>remote-history-incomplete</code>");
    expect(whatsapp?.html).toContain(whatsappFacts.wacliCommit);
    expect(whatsapp?.html).toContain(whatsappFacts.archiveSha256);
    expect(whatsapp?.html).toContain(whatsappFacts.binarySha256);
    expect(whatsapp?.html).toContain("Runtime reads do not claim to repeat online notarization");
    expect(whatsapp?.html).not.toMatch(/retains? reaction/iu);
    expect(whatsapp?.html).not.toContain("runtime notarization");
    expect(whatsapp?.html).not.toContain("wrench auth pair");
    expect(whatsapp?.html).not.toContain("wrench auth sync");
    const whatsappJsonMatch = /<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(
      whatsapp?.html ?? "",
    );
    const whatsappStructured = JSON.parse(whatsappJsonMatch?.[1] ?? "null") as {
      "@graph"?: ReadonlyArray<Readonly<Record<string, unknown>>>;
    };
    const whatsappBreadcrumb = whatsappStructured["@graph"]?.find((node) =>
      node["@id"] === `${SITE_ORIGIN}/providers/whatsapp/#breadcrumb`);
    expect(whatsappBreadcrumb).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { name: "Wrench", position: 1, item: `${SITE_ORIGIN}/` },
        { name: "Providers", position: 2, item: `${SITE_ORIGIN}/provider-capabilities/` },
        { name: "WhatsApp", position: 3, item: `${SITE_ORIGIN}/providers/whatsapp/` },
      ],
    });

    const personalAgents = pages.find((page) =>
      page.definition.canonicalPath === "/compare/personal-agents-browser-use/");
    expect(personalAgents?.html).toContain(
      "<h1>Browser-using personal agents still need named web operations.</h1>",
    );
    expect(personalAgents?.html).toContain(
      "https://hraness.com/reading/personal-agents-notes-instinct-grok-bots-chatgpt-work",
    );
    expect(personalAgents?.html).toContain("https://wrench.rip/");
    expect(personalAgents?.html).toContain("https://wrench.rip/provider-capabilities/");
    expect(personalAgents?.html).toContain("https://wrench.rip/security/");
    expect(personalAgents?.html).toContain(
      `The current release offers ${attestation.observedCount} supported provider actions.`,
    );
    expect(personalAgents?.html).toContain("Telegram is not supported in this release");
    expect(personalAgents?.html).toContain("Instinct");
    expect(personalAgents?.html).toContain("Grok Bots");
    expect(personalAgents?.html).toContain("ChatGPT Work");
    expect(personalAgents?.html).toContain("never switches to a browser fallback silently");
    expect(personalAgents?.html).toContain("https://wrench.rip/agentic-web-spoofing/");
    expect(personalAgents?.html).toContain("https://wrench.rip/vms-cannot-contain-agents/");
    expect(personalAgents?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(personalAgents?.html).not.toMatch(/capture-required|<code>observed<\/code>/iu);

    const agenticWebSpoofing = pages.find((page) =>
      page.definition.canonicalPath === "/agentic-web-spoofing/");
    expect(agenticWebSpoofing?.html).toContain(
      "<h1>A claimed agent name is not an attested web operation.</h1>",
    );
    expect(agenticWebSpoofing?.html).toContain("https://knownagents.com/insights");
    expect(agenticWebSpoofing?.html).toContain(
      "https://hraness.com/reading/agentic-web-index-spoofing-and-security",
    );
    expect(agenticWebSpoofing?.html).toContain("https://hraness.com");
    expect(agenticWebSpoofing?.html).toContain("https://wrench.rip/");
    expect(agenticWebSpoofing?.html).toContain("https://wrench.rip/provider-capabilities/");
    expect(agenticWebSpoofing?.html).toContain("https://wrench.rip/security/");
    expect(agenticWebSpoofing?.html).toContain(
      "https://wrench.rip/compare/personal-agents-browser-use/",
    );
    expect(agenticWebSpoofing?.html).toContain(
      "A visit is considered spoofed when it claims a recognized agent identity but fails that agent's supported authentication method, such as verified IP or Web Bot Auth.",
    );
    expect(agenticWebSpoofing?.html).toContain(
      "A failed check indicates that the visit was likely impersonating the named agent; it does not identify the software or operator that actually made the request.",
    );
    expect(agenticWebSpoofing?.html).toContain(
      "Agents without a supported authentication method are not included in these measurements.",
    );
    expect(agenticWebSpoofing?.html).toContain(
      "Results characterize the observed network and broader directional trends; they should not be interpreted as a precise census of global web traffic.",
    );
    expect(agenticWebSpoofing?.html).toContain(
      "We are observing a widespread campaign impersonating AI bots to scan websites for vulnerabilities.",
    );
    expect(agenticWebSpoofing?.html).toContain(
      `The current release attests ${attestation.operationCount} operations across ${attestation.adapterCount} bundled public adapters.`,
    );
    expect(agenticWebSpoofing?.html).toContain(
      `${attestation.observedCount} are <code>observed</code>. ${attestation.captureRequiredCount} remain <code>capture-required</code>.`,
    );
    expect(agenticWebSpoofing?.html).toContain("Telegram is absent from those manifests");
    expect(agenticWebSpoofing?.html).toContain("this page does not invent those names");
    expect(agenticWebSpoofing?.html).toContain("The pages do not reprint one another.");
    expect(agenticWebSpoofing?.html).toContain("https://wrench.rip/vms-cannot-contain-agents/");
    expect(agenticWebSpoofing?.html).not.toContain("{{PROVIDER_CAPABILITY");

    const vmsCannotContainAgents = pages.find((page) =>
      page.definition.canonicalPath === "/vms-cannot-contain-agents/");
    expect(vmsCannotContainAgents?.html).toContain(
      "<h1>A VM is not an attested web operation.</h1>",
    );
    expect(vmsCannotContainAgents?.html).toContain(
      "https://blog.trailofbits.com/2026/08/26/vms-wont-contain-cyber-capable-agents/",
    );
    expect(vmsCannotContainAgents?.html).toContain("VMs won’t contain cyber-capable agents");
    expect(vmsCannotContainAgents?.html).toContain("https://rough.day");
    expect(vmsCannotContainAgents?.html).toContain("https://rough.day/info");
    expect(vmsCannotContainAgents?.html).toContain("Wednesday 26 August 2026");
    expect(vmsCannotContainAgents?.html).toContain("Trail of Bits argues VMs cannot reliably contain cyber-capable AI agents");
    expect(vmsCannotContainAgents?.html).toContain("https://hraness.com");
    expect(vmsCannotContainAgents?.html).toContain("https://wrench.rip/");
    expect(vmsCannotContainAgents?.html).toContain("https://wrench.rip/provider-capabilities/");
    expect(vmsCannotContainAgents?.html).toContain("https://wrench.rip/agentic-web-spoofing/");
    expect(vmsCannotContainAgents?.html).toContain(
      "https://wrench.rip/compare/personal-agents-browser-use/",
    );
    expect(vmsCannotContainAgents?.html).toContain(
      `The current release attests ${attestation.operationCount} operations across ${attestation.adapterCount} bundled public adapters.`,
    );
    expect(vmsCannotContainAgents?.html).toContain(
      `${attestation.observedCount} are <code>observed</code>. ${attestation.captureRequiredCount} remain <code>capture-required</code>.`,
    );
    expect(vmsCannotContainAgents?.html).toContain("Telegram is absent from those manifests");
    expect(vmsCannotContainAgents?.html).toContain("does not sell a hypervisor, a microVM, or a hostile-code sandbox");
    expect(vmsCannotContainAgents?.html).toContain("The pages do not reprint one another.");
    expect(vmsCannotContainAgents?.html).toContain("https://wrench.rip/paypal-grapheneos-attestation/");
    expect(vmsCannotContainAgents?.html).toContain("https://wrench.rip/rumour-is-the-exploit/");
    expect(vmsCannotContainAgents?.html).toContain("https://wrench.rip/omarchy-root-escalation/");
    expect(vmsCannotContainAgents?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(vmsCannotContainAgents?.html).not.toContain("stripedex.com");
    expect(vmsCannotContainAgents?.html).not.toContain("spongeresearch.com");

    const paypalGrapheneOsAttestation = pages.find((page) =>
      page.definition.canonicalPath === "/paypal-grapheneos-attestation/");
    expect(paypalGrapheneOsAttestation?.html).toContain(
      "<h1>Device policy is not a named web operation.</h1>",
    );
    expect(paypalGrapheneOsAttestation?.html).toContain(
      "https://news.ycombinator.com/item?id=49462253",
    );
    expect(paypalGrapheneOsAttestation?.html).toContain("Tell HN: PayPal blocks GrapheneOS");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://rough.day");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://rough.day/info");
    expect(paypalGrapheneOsAttestation?.html).toContain("Thursday 27 August 2026");
    expect(paypalGrapheneOsAttestation?.html).toContain(
      "PayPal app crashes on GrapheneOS, citing a root-detection security violation",
    );
    expect(paypalGrapheneOsAttestation?.html).toContain(
      "com.paypal.oslo.app.rasp.RootDetectionSecurityException: Security policy violation: s=root",
    );
    expect(paypalGrapheneOsAttestation?.html).toContain("https://hraness.com");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://wrench.rip/");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://wrench.rip/provider-capabilities/");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://wrench.rip/agentic-web-spoofing/");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://wrench.rip/vms-cannot-contain-agents/");
    expect(paypalGrapheneOsAttestation?.html).toContain(
      `The current release attests ${attestation.operationCount} operations across ${attestation.adapterCount} bundled public adapters.`,
    );
    expect(paypalGrapheneOsAttestation?.html).toContain(
      `${attestation.observedCount} are <code>observed</code>. ${attestation.captureRequiredCount} remain <code>capture-required</code>.`,
    );
    expect(paypalGrapheneOsAttestation?.html).toContain("Telegram is absent from those manifests");
    expect(paypalGrapheneOsAttestation?.html).toContain("does not invent a PayPal API");
    expect(paypalGrapheneOsAttestation?.html).toContain("The pages do not reprint one another.");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://wrench.rip/rumour-is-the-exploit/");
    expect(paypalGrapheneOsAttestation?.html).toContain("https://wrench.rip/omarchy-root-escalation/");
    expect(paypalGrapheneOsAttestation?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(paypalGrapheneOsAttestation?.html).not.toContain("stripedex.com");
    expect(paypalGrapheneOsAttestation?.html).not.toContain("spongeresearch.com");

    const rumourIsTheExploit = pages.find((page) =>
      page.definition.canonicalPath === "/rumour-is-the-exploit/");
    expect(rumourIsTheExploit?.html).toContain(
      "<h1>A rumour is not a named web operation.</h1>",
    );
    expect(rumourIsTheExploit?.html).toContain("Sourced take");
    expect(rumourIsTheExploit?.html).toContain(
      "https://anil.recoil.org/notes/rumour-is-the-exploit",
    );
    expect(rumourIsTheExploit?.html).toContain(
      "https://hraness.com/reading/rumour-is-the-exploit",
    );
    expect(rumourIsTheExploit?.html).toContain(
      "Just a rumour of a bug is enough to find a security exploit these days",
    );
    expect(rumourIsTheExploit?.html).toContain("Monday 31 August 2026");
    expect(rumourIsTheExploit?.html).toContain("22 August 2026");
    expect(rumourIsTheExploit?.html).toContain("https://hraness.com");
    expect(rumourIsTheExploit?.html).toContain("https://wrench.rip/");
    expect(rumourIsTheExploit?.html).toContain("https://wrench.rip/provider-capabilities/");
    expect(rumourIsTheExploit?.html).toContain("https://wrench.rip/vms-cannot-contain-agents/");
    expect(rumourIsTheExploit?.html).toContain("https://wrench.rip/paypal-grapheneos-attestation/");
    expect(rumourIsTheExploit?.html).toContain(
      `The current release attests ${attestation.operationCount} operations across ${attestation.adapterCount} bundled public adapters.`,
    );
    expect(rumourIsTheExploit?.html).toContain(
      `${attestation.observedCount} are <code>observed</code>. ${attestation.captureRequiredCount} remain <code>capture-required</code>.`,
    );
    expect(rumourIsTheExploit?.html).toContain("Telegram is absent from those manifests");
    expect(rumourIsTheExploit?.html).toContain("does not reconstruct exploits");
    expect(rumourIsTheExploit?.html).toContain("does not reprint the essay");
    expect(rumourIsTheExploit?.html).toContain("The pages do not reprint one another.");
    expect(rumourIsTheExploit?.html).toContain("https://wrench.rip/omarchy-root-escalation/");
    expect(rumourIsTheExploit?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(rumourIsTheExploit?.html).not.toContain("stripedex.com");
    expect(rumourIsTheExploit?.html).not.toContain("spongeresearch.com");
    expect(rumourIsTheExploit?.html).not.toMatch(/percent-encod|proof.of.concept|PoC|payload|exploit step/iu);

    const omarchyRootEscalation = pages.find((page) =>
      page.definition.canonicalPath === "/omarchy-root-escalation/");
    expect(omarchyRootEscalation?.html).toContain(
      "<h1>A root-capable desktop is not a named web operation.</h1>",
    );
    expect(omarchyRootEscalation?.html).toContain("News take");
    expect(omarchyRootEscalation?.html).toContain("https://0xcc.io/posts/omarchy-root-creds/");
    expect(omarchyRootEscalation?.html).toContain("Omarchy: Any User Process Can Escalate to Root");
    expect(omarchyRootEscalation?.html).toContain("https://rough.day");
    expect(omarchyRootEscalation?.html).toContain("https://rough.day/info");
    expect(omarchyRootEscalation?.html).toContain("Sunday 30 August 2026");
    expect(omarchyRootEscalation?.html).toContain(
      "Omarchy desktop environment allows any user process to escalate to root",
    );
    expect(omarchyRootEscalation?.html).toContain("https://hraness.com");
    expect(omarchyRootEscalation?.html).toContain("https://wrench.rip/");
    expect(omarchyRootEscalation?.html).toContain("https://wrench.rip/provider-capabilities/");
    expect(omarchyRootEscalation?.html).toContain("https://wrench.rip/vms-cannot-contain-agents/");
    expect(omarchyRootEscalation?.html).toContain("https://wrench.rip/paypal-grapheneos-attestation/");
    expect(omarchyRootEscalation?.html).toContain("https://wrench.rip/rumour-is-the-exploit/");
    expect(omarchyRootEscalation?.html).toContain(
      `The current release attests ${attestation.operationCount} operations across ${attestation.adapterCount} bundled public adapters.`,
    );
    expect(omarchyRootEscalation?.html).toContain(
      `${attestation.observedCount} are <code>observed</code>. ${attestation.captureRequiredCount} remain <code>capture-required</code>.`,
    );
    expect(omarchyRootEscalation?.html).toContain("Telegram is absent from those manifests");
    expect(omarchyRootEscalation?.html).toContain("does not decide which desktop processes may become root");
    expect(omarchyRootEscalation?.html).toContain("does not reprint the post");
    expect(omarchyRootEscalation?.html).toContain("The pages do not reprint one another.");
    expect(omarchyRootEscalation?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(omarchyRootEscalation?.html).not.toContain("stripedex.com");
    expect(omarchyRootEscalation?.html).not.toContain("spongeresearch.com");
    expect(omarchyRootEscalation?.html).not.toMatch(
      /percent-encod|proof.of.concept|PoC|payload|exploit step|docker\.sock|\/etc\/shadow/iu,
    );
    const software = (graph as ReadonlyArray<Readonly<Record<string, unknown>>>).find((node) =>
      node["@id"] === `${SITE_ORIGIN}/#software`);
    expect(software).toMatchObject({
      "@type": "SoftwareApplication",
      featureList: [
        "Durable Markdown page capture",
        "Verified finite-item media archives",
        "Encrypted exact-query read snapshots",
        "Typed and bounded provider operations",
        "Pinned Beeper CLI operations",
        "Fail-closed provider contract drift",
      ],
      softwareVersion: packageIdentity.version,
    });

    const files = new Map<string, string>();
    for (const page of PUBLIC_PAGES) {
      files.set(
        markdownSiblingPath(page.canonicalPath),
        await readFile(join(websiteRoot, "dist", markdownSiblingPath(page.canonicalPath).slice(1)), "utf8"),
      );
    }
    files.set("/404.md", notFoundMarkdown);
    const retrieve = async (url: URL): Promise<Response> => {
      const body = files.get(url.pathname);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { status: 200 });
    };
    const negotiated = await handleDocumentNegotiation(
      new Request(`${SITE_ORIGIN}/getting-started/`, { headers: { Accept: "text/markdown" } }),
      retrieve,
    );
    expect(negotiated?.status).toBe(200);
    expect(negotiated?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(negotiated?.headers.get("vary")).toBe("Accept");
    expect(await negotiated?.text()).toContain("# Install Wrench and capture your first URL.");
  });

  test("keeps every README release reference aligned with package identity", async () => {
    const [manifest, readme, attestation] = await Promise.all([
      Bun.file(join(repositoryRoot, "package.json")).json(),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      loadProviderCapabilityAttestation(repositoryRoot),
    ]);
    const identity = parsePackageIdentity(manifest);
    const catalogServiceCount = new Set(attestation.rows.map((row) => row.surfaceId)).size;
    const executableServiceCount = createProviderDirectory(attestation).providerCount;
    const referencedReleases = [...readme.matchAll(/\bv[0-9]+\.[0-9]+\.[0-9]+\b/gu)]
      .map((match) => match[0]);
    expect(referencedReleases.length).toBeGreaterThan(0);
    expect(new Set(referencedReleases)).toEqual(new Set([identity.release]));
    expect(catalogServiceCount).toBe(20);
    expect(executableServiceCount).toBe(19);
    expect(readme).toContain(
      `This ${identity.release} source tree supports executable actions for ${String(executableServiceCount)} services:`,
    );
    expect(readme).not.toContain(
      `This ${identity.release} source tree defines actions for ${String(executableServiceCount)} services:`,
    );
    expect(readme).toContain(
      "[built-in Beeper Desktop MCP server](https://developers.beeper.com/desktop-api/mcp/)",
    );
    expect(readme).not.toContain("https://github.com/beeper/desktop-api-mcp");
  });

  test("ships a correctly sized original social card", async () => {
    const image = new Uint8Array(await Bun.file(join(websiteRoot, "public/og.png")).arrayBuffer());
    expect(Array.from(image.slice(1, 4))).toEqual([80, 78, 71]);
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });
});
