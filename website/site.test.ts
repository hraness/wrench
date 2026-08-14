import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  buildWebsite,
  DEFAULT_POSTHOG_HOST,
  parsePackageIdentity,
  REPOSITORY_URL,
  SITE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TITLE,
} from "./build";

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
    const [html, notFound, robots, sitemap, favicon, css, vercel] = await Promise.all([
      readFile(join(websiteRoot, "dist/index.html"), "utf8"),
      readFile(join(websiteRoot, "dist/404.html"), "utf8"),
      readFile(join(websiteRoot, "dist/robots.txt"), "utf8"),
      readFile(join(websiteRoot, "dist/sitemap.xml"), "utf8"),
      readFile(join(websiteRoot, "dist/favicon.svg"), "utf8"),
      readFile(join(websiteRoot, "source/styles.css"), "utf8"),
      Bun.file(join(repositoryRoot, "vercel.json")).json(),
    ]);

    expect(html).toContain(`<title>${SITE_TITLE}</title>`);
    expect(html).toContain(`<meta name="description" content="${SITE_DESCRIPTION}">`);
    expect(html).toContain('<link rel="canonical" href="https://wrench.rip/">');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(html).toContain('<meta property="og:image" content="https://wrench.rip/og.png">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain(`github:hraness/wrench#${packageIdentity.release}`);
    expect(html).toContain(`Install Wrench ${packageIdentity.release}`);
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
    expect(notFound).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(notFound).toContain("Privacy: this page uses cookieless, personless PostHog analytics");
    expect(robots).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
    expect(sitemap).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
    expect(sitemap).not.toContain("hraness.com");
    expect(favicon).toContain('viewBox="0 0 64 64"');
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(vercel).toMatchObject({
      framework: null,
      outputDirectory: "website/dist",
    });

    const structuredMatch = /<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(html);
    expect(structuredMatch?.[1]).toBeDefined();
    const structured: unknown = JSON.parse(structuredMatch?.[1] ?? "null");
    const graph = (structured as { "@graph"?: unknown })["@graph"];
    expect(Array.isArray(graph)).toBe(true);
    expect(graph).toEqual(expect.arrayContaining([
      expect.objectContaining({ "@id": `${SITE_ORIGIN}/#website`, "@type": "WebSite" }),
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
  });

  test("ships a correctly sized original social card", async () => {
    const image = new Uint8Array(await Bun.file(join(websiteRoot, "public/og.png")).arrayBuffer());
    expect(Array.from(image.slice(1, 4))).toEqual([80, 78, 71]);
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });
});
