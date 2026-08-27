import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  HRANESS_HOME_URL,
  HRANESS_NEWSLETTER_URL,
  hranessSocialLinks,
} from "@hraness/site-footer";

import {
  buildWebsite,
  CONTENT_REVIEWED_RELEASE,
  DEFAULT_POSTHOG_HOST,
  DEMO_PUBLIC_FILES,
  markdownSiblingPath,
  parsePackageIdentity,
  PUBLIC_PAGES,
  PUBLISHER_URL,
  REPOSITORY_URL,
  SITE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TITLE,
  SKILL_INSTALL_COMMAND,
  SKILL_INSTALL_COMMAND_BUNX,
} from "./build";
import { handleDocumentNegotiation } from "../edge/negotiation";
import {
  loadProviderCapabilityAttestation,
} from "./provider-capability-attestation";
import {
  createBeeperPresentationFacts,
  createProviderDirectory,
  renderProviderAttestationGroups,
  renderProviderOverviewCards,
} from "./provider-presentation";

const repositoryRoot = resolve(import.meta.dir, "..");
const websiteRoot = import.meta.dir;

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

  test("builds canonical discovery, semantic content, and private-key-free analytics", async () => {
    const packageIdentity = parsePackageIdentity(
      await Bun.file(join(repositoryRoot, "package.json")).json(),
    );
    await buildWebsite({
      NEXT_PUBLIC_POSTHOG_HOST: DEFAULT_POSTHOG_HOST,
      NEXT_PUBLIC_POSTHOG_KEY: "phc_public_project_token",
    });
    const [pages, notFound, notFoundMarkdown, llms, robots, sitemap, indexNowKey, favicon, sourceCss, demoFiles, vercel, middleware] = await Promise.all([
      Promise.all(PUBLIC_PAGES.map(async (page) => ({
        definition: page,
        html: await readFile(join(websiteRoot, "dist", page.outputFile), "utf8"),
      }))),
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
    const cssAsset = /<link rel="stylesheet" href="([^"?]+)">/u.exec(html)?.[1];
    expect(cssAsset).toMatch(/^\/assets\/styles-[a-f0-9]{12}\.css$/u);
    const builtCss = await readFile(join(websiteRoot, "dist", cssAsset!.slice(1)), "utf8");

    expect(html).toContain(`<title>${SITE_TITLE}</title>`);
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
    expect(html).toContain(`>${SKILL_INSTALL_COMMAND}</code>`);
    expect(html).toContain(`<code>${SKILL_INSTALL_COMMAND_BUNX}</code>`);
    expect(html).not.toContain(`value="${SKILL_INSTALL_COMMAND}"`);
    expect(html).toContain('class="skill-install" data-skill-install');
    expect(html).toContain("data-skill-install-copy");
    expect(html).toMatch(/data-skill-install-copy\s+hidden/gu);
    expect(html).toContain('aria-label="Copy Agent Skill install command"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain('/assets/skill-install-');
    expect(html.indexOf('class="hero-statement"')).toBeLessThan(
      html.indexOf('class="skill-install"'),
    );
    expect(html.indexOf('class="skill-install"')).toBeLessThan(
      html.indexOf('class="hero-explainer"'),
    );
    expect(html).not.toContain("{{");
    expect(html).not.toContain("@jungle/");
    expect(html).not.toContain("hraness.com/wrench");
    expect(html.match(/<h1\b/gu)).toHaveLength(1);
    expect(html.match(/<details>/gu)).toHaveLength(5);
    expect(html).toContain('class="table-scroll" role="region" tabindex="0"');
    expect(html).toContain('<a class="skip-link" href="#main">');
    expect(html.match(/data-analytics-event="project link opened"/gu)).toHaveLength(2);
    expect(html.match(new RegExp(`href="${REPOSITORY_URL}"`, "gu"))).toHaveLength(2);
    expect(html).toContain("Privacy: cookieless PostHog analytics");
    expect(html).toContain('href="/compare/personal-agents-browser-use/"');
    expect(html).toContain('href="/agentic-web-spoofing/"');
    expect(html).toContain('href="/vms-cannot-contain-agents/"');
    expect(html).toContain('href="/providers/beeper/"');
    expect(html).toContain("Give agents bounded access to pages, media, and connected accounts.");
    expect(html).toContain("Know which operations can run before you bind an account.");
    expect(html).toContain('src="/favicon.svg"');
    expect(html).not.toContain("🔧");
    expect(html).toContain(`href="${PUBLISHER_URL}">Hraness GitHub organization</a>`);
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
    expect(llms).toContain(`${SITE_ORIGIN}/agentic-web-spoofing/`);
    expect(llms).toContain(`${SITE_ORIGIN}/vms-cannot-contain-agents/`);
    expect(llms).toContain(`${SITE_ORIGIN}/providers/beeper/`);
    expect(llms).toContain("submission is not a delivery claim");
    expect(llms).toContain("npx skills add hraness/wrench");
    expect(llms).toContain("Accept: text/markdown");
    expect(llms).not.toContain("{{");
    expect(robots).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
    expect(sitemap.match(/<url>/gu)).toHaveLength(PUBLIC_PAGES.length);
    for (const page of PUBLIC_PAGES) {
      expect(sitemap).toContain(`<loc>${SITE_ORIGIN}${page.canonicalPath}</loc>`);
    }
    expect(sitemap).not.toContain("<lastmod>");
    expect(sitemap).not.toContain("<changefreq>");
    expect(sitemap).not.toContain("<priority>");
    expect(sitemap).not.toContain("hraness.com");
    expect(indexNowKey).toBe("dc84ee4863539f2fff50ef5f0a164168\n");
    expect(favicon).toContain('viewBox="0 0 64 64"');
    expect(sourceCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(sourceCss).toContain("@media (forced-colors: active)");
    expect(sourceCss).not.toContain(".footer {");
    expect(builtCss).toContain(".hraness-site-footer {");
    expect(builtCss).toContain("@media (pointer: coarse)");
    const expectedFooterHrefs = [
      HRANESS_HOME_URL,
      HRANESS_NEWSLETTER_URL,
      ...hranessSocialLinks.map(({ href }) => href),
    ];
    for (const document of [...pages.map(({ html: pageHtml }) => pageHtml), notFound]) {
      expect(document.match(/<footer\b/gu)).toHaveLength(1);
      const footer = /<footer\b[\s\S]*?<\/footer>/u.exec(document)?.[0];
      expect(footer).toBeDefined();
      expect(footer).toContain('data-slot="hraness-site-footer"');
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
        source: "/:path*/",
      },
    ]));
    expect(vercel.headers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        headers: expect.arrayContaining([
          expect.objectContaining({ key: "Vary", value: "Accept" }),
        ]),
        source: "/(.*)",
      }),
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
        expect(pageHtml.match(/<h2\b/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
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

    const gettingStarted = pages.find((page) => page.definition.canonicalPath === "/getting-started/");
    expect(gettingStarted?.html).toContain("Wrench developer resources");
    expect(gettingStarted?.html).toContain("does not publish a hosted API");
    expect(gettingStarted?.html).toContain('id="demo"');
    expect(gettingStarted?.html).toContain('poster="/wrench-first-capture.png"');
    expect(gettingStarted?.html).toContain('src="/wrench-first-capture.webm"');
    expect(gettingStarted?.html).toContain('src="/wrench-first-capture.mp4"');
    expect(gettingStarted?.html).toContain('src="/wrench-first-capture.vtt"');
    expect(gettingStarted?.html).toContain('href="/wrench-first-capture.gif"');
    expect(gettingStarted?.html).toContain("successful Wrench 0.13.5 run on August 25, 2026");
    expect(gettingStarted?.html).toContain("The terminal text is actual CLI output");

    const privacy = pages.find((page) => page.definition.canonicalPath === "/privacy/");
    expect(privacy?.html).toContain("The CLI stores state on the operator's machine");
    expect(privacy?.html).toContain("Local custody does not mean that every stored byte is encrypted");
    expect(privacy?.html).toContain("Wrench-managed Gmail OAuth JSON file");
    expect(privacy?.html).toContain("The CLI and SDK do not send wrench.rip analytics");
    expect(privacy?.html).toContain("wrench auth remove ID --yes");
    expect(privacy?.html).toContain("it is not a hostile native-code sandbox");

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
      `Wrench ${packageIdentity.version} joins its built-in provider plugins to the bundled public adapter manifests`,
    );
    expect(html).toContain(providerCards);
    expect(providerCapabilities?.html).toContain(providerCards);
    expect(providerCapabilities?.html).toContain(providerGroups);
    expect(providerCapabilities?.html).toContain("<th scope=\"col\">Operation</th>");
    expect(providerCapabilities?.html).toContain("<th scope=\"col\">Completeness</th>");
    expect(providerCapabilities?.html).toContain("<th scope=\"col\">Risk</th>");
    expect(providerCapabilities?.html).toContain("<th scope=\"col\">Contract</th>");
    expect(providerCapabilities?.html).toContain("<th scope=\"col\">Transport</th>");
    expect(providerCapabilities?.html).toContain("<th scope=\"col\">Limit</th>");
    expect(providerCapabilities?.html).toContain(`<code>gmail</code>`);
    expect(providerCapabilities?.html).toContain(`<code>contacts.list</code>`);
    expect(providerCapabilities?.html).toContain(`<code>observed</code>`);
    expect(providerCapabilities?.html).toContain(`<code>capture-required</code>`);
    expect(providerCapabilities?.html).toContain("Telegram is absent from those manifests");
    expect(providerCapabilities?.html).not.toContain("<th scope=\"row\">Telegram</th>");
    expect(providerCapabilities?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(providerMarkdown).toContain(
      "### Beeper (Pinned Local CLI) `beeper-local` · v2.0.0 · 32 of 32 observed",
    );

    const beeper = pages.find((page) => page.definition.canonicalPath === "/providers/beeper/");
    const beeperFacts = createBeeperPresentationFacts(providerDirectory);
    expect(beeper?.html).toContain(`<title>${beeperFacts.pageTitle}</title>`);
    expect(beeper?.html).toContain(
      `<meta name="description" content="${beeperFacts.pageDescription}">`,
    );
    expect(beeper?.html).toContain(
      `<h1>Beeper through ${beeperFacts.observedOperationCount} observed operations.</h1>`,
    );
    expect(beeper?.html).toContain(`adapter <code>beeper-local</code> ${beeperFacts.adapterVersion}`);
    expect(beeper?.html).toContain(`official Beeper CLI ${beeperFacts.cliVersion}`);
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
    expect(beeper?.html).toContain("evidence of submission, not network delivery");
    expect(beeper?.html).toContain("Wrench does not retry it");
    expect(beeper?.html).toContain(`all ${beeperFacts.cliCommandCount} canonical CLI commands`);
    expect(beeper?.html).toContain("These workflows are not part of the 32 adapter operations");
    expect(beeper?.html).not.toMatch(/all Beeper (?:CLI )?features/iu);
    expect(beeper?.html).not.toMatch(/all (?:your )?chats/iu);
    expect(beeper?.html).not.toContain("exactly once");
    expect(beeper?.html).not.toContain("seamless");
    expect(beeper?.html).not.toContain("Provider capabilities attestation");

    const personalAgents = pages.find((page) =>
      page.definition.canonicalPath === "/compare/personal-agents-browser-use/");
    expect(personalAgents?.html).toContain(
      "<h1>Browser-using personal agents still need attested web operations.</h1>",
    );
    expect(personalAgents?.html).toContain(
      "https://hraness.com/reading/personal-agents-notes-instinct-grok-bots-chatgpt-work",
    );
    expect(personalAgents?.html).toContain("https://wrench.rip/");
    expect(personalAgents?.html).toContain("https://wrench.rip/provider-capabilities/");
    expect(personalAgents?.html).toContain("https://wrench.rip/security/");
    expect(personalAgents?.html).toContain(
      `The current release attests ${attestation.operationCount} operations across ${attestation.adapterCount} bundled public adapters.`,
    );
    expect(personalAgents?.html).toContain(
      `${attestation.observedCount} are <code>observed</code>. ${attestation.captureRequiredCount} remain <code>capture-required</code>.`,
    );
    expect(personalAgents?.html).toContain("Telegram is absent from those manifests");
    expect(personalAgents?.html).toContain("Instinct");
    expect(personalAgents?.html).toContain("Grok Bots");
    expect(personalAgents?.html).toContain("ChatGPT Work");
    expect(personalAgents?.html).toContain("never switches to a browser fallback silently");
    expect(personalAgents?.html).toContain("https://wrench.rip/agentic-web-spoofing/");
    expect(personalAgents?.html).toContain("https://wrench.rip/vms-cannot-contain-agents/");
    expect(personalAgents?.html).not.toContain("{{PROVIDER_CAPABILITY");

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
    expect(vmsCannotContainAgents?.html).toContain("None of the three reprints the others.");
    expect(vmsCannotContainAgents?.html).not.toContain("{{PROVIDER_CAPABILITY");
    expect(vmsCannotContainAgents?.html).not.toContain("stripedex.com");
    expect(vmsCannotContainAgents?.html).not.toContain("spongeresearch.com");
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
    const [manifest, readme] = await Promise.all([
      Bun.file(join(repositoryRoot, "package.json")).json(),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
    ]);
    const identity = parsePackageIdentity(manifest);
    const referencedReleases = [...readme.matchAll(/\bv[0-9]+\.[0-9]+\.[0-9]+\b/gu)]
      .map((match) => match[0]);
    expect(referencedReleases.length).toBeGreaterThan(0);
    expect(new Set(referencedReleases)).toEqual(new Set([identity.release]));
  });

  test("ships a correctly sized original social card", async () => {
    const image = new Uint8Array(await Bun.file(join(websiteRoot, "public/og.png")).arrayBuffer());
    expect(Array.from(image.slice(1, 4))).toEqual([80, 78, 71]);
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });
});
