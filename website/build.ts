import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_ORIGIN = "https://wrench.rip" as const;
export const SITE_TITLE = "Wrench: precise web capabilities for AI agents" as const;
export const SITE_DESCRIPTION =
  "Open-source CLI and TypeScript SDK for precise web capabilities for AI agents: page capture, verified media archives, encrypted reads, and typed provider operations." as const;
export const REPOSITORY_URL = "https://github.com/hraness/wrench" as const;
export const UPDATED_AT = "2026-08-14" as const;
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com" as const;

const websiteRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(websiteRoot, "..");
const sourceRoot = join(websiteRoot, "source");
const publicRoot = join(websiteRoot, "public");
const outputRoot = join(websiteRoot, "dist");

const supportedPostHogHosts = new Set([
  "https://eu.i.posthog.com",
  "https://us.i.posthog.com",
]);

export type PackageIdentity = Readonly<{
  description: typeof SITE_DESCRIPTION;
  homepage: typeof SITE_ORIGIN;
  name: "@hraness/wrench";
  release: `v${string}`;
  repositoryUrl: "git+https://github.com/hraness/wrench.git";
  version: string;
}>;

type RenderOptions = Readonly<{
  analyticsAsset: string;
  cssAsset: string;
  packageIdentity: PackageIdentity;
  postHogHost: string;
  postHogKey: string;
}>;

function unknownRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function parsePackageIdentity(value: unknown): PackageIdentity {
  const manifest = unknownRecord(value, "package.json");
  const repository = unknownRecord(manifest.repository, "package.json repository");
  const version = manifest.version;
  if (
    typeof version !== "string"
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)
  ) {
    throw new TypeError("package.json version must be a stable semantic version.");
  }
  if (manifest.name !== "@hraness/wrench") {
    throw new TypeError("The website can only describe @hraness/wrench.");
  }
  if (manifest.description !== SITE_DESCRIPTION) {
    throw new TypeError("The package and website descriptions must stay identical.");
  }
  if (manifest.homepage !== SITE_ORIGIN) {
    throw new TypeError("The package homepage must be the canonical Wrench origin.");
  }
  if (repository.url !== "git+https://github.com/hraness/wrench.git") {
    throw new TypeError("The package repository must be the canonical public Wrench repository.");
  }
  return {
    description: SITE_DESCRIPTION,
    homepage: SITE_ORIGIN,
    name: "@hraness/wrench",
    release: `v${version}`,
    repositoryUrl: "git+https://github.com/hraness/wrench.git",
    version,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function replaceRequired(template: string, placeholder: string, value: string): string {
  if (!template.includes(placeholder)) {
    throw new Error(`Template is missing ${placeholder}.`);
  }
  return template.replaceAll(placeholder, value);
}

function jsonLd(identity: PackageIdentity): Readonly<Record<string, unknown>> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@id": `${SITE_ORIGIN}/#website`,
        "@type": "WebSite",
        description: SITE_DESCRIPTION,
        name: "Wrench",
        url: `${SITE_ORIGIN}/`,
      },
      {
        "@id": `${SITE_ORIGIN}/#webpage`,
        "@type": "WebPage",
        description: SITE_DESCRIPTION,
        isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
        mainEntity: { "@id": `${SITE_ORIGIN}/#software` },
        name: SITE_TITLE,
        url: `${SITE_ORIGIN}/`,
      },
      {
        "@id": `${SITE_ORIGIN}/#software`,
        "@type": "SoftwareApplication",
        applicationCategory: "DeveloperApplication",
        description: SITE_DESCRIPTION,
        featureList: [
          "Durable Markdown page capture",
          "Verified finite-item media archives",
          "Encrypted exact-query read snapshots",
          "Typed and bounded provider operations",
          "Fail-closed provider contract drift",
        ],
        installUrl: `${SITE_ORIGIN}/#start`,
        isAccessibleForFree: true,
        license: "https://opensource.org/license/mit",
        name: "Wrench",
        offers: {
          "@type": "Offer",
          availability: "https://schema.org/InStock",
          price: 0,
          priceCurrency: "USD",
        },
        operatingSystem: ["macOS", "Linux"],
        sameAs: [REPOSITORY_URL],
        softwareRequirements: "Bun 1.3.14 on macOS or Linux",
        softwareVersion: identity.version,
        url: `${SITE_ORIGIN}/`,
      },
      {
        "@id": `${SITE_ORIGIN}/#source`,
        "@type": "SoftwareSourceCode",
        codeRepository: REPOSITORY_URL,
        license: "https://opensource.org/license/mit",
        name: "Wrench source code",
        programmingLanguage: {
          "@type": "ComputerLanguage",
          name: "TypeScript",
        },
        runtimePlatform: "Bun 1.3.14",
        targetProduct: { "@id": `${SITE_ORIGIN}/#software` },
        version: identity.version,
      },
    ],
  };
}

export function renderIndex(template: string, options: RenderOptions): string {
  const { packageIdentity: identity } = options;
  const installCommand = `bun add --global github:hraness/wrench#${identity.release}`;
  const structuredData = JSON.stringify(jsonLd(identity)).replaceAll("<", "\\u003c");
  let rendered = template;
  rendered = replaceRequired(rendered, "{{ANALYTICS_ASSET}}", escapeHtml(options.analyticsAsset));
  rendered = replaceRequired(rendered, "{{CSS_ASSET}}", escapeHtml(options.cssAsset));
  rendered = replaceRequired(rendered, "{{JSON_LD}}", structuredData);
  rendered = replaceRequired(rendered, "{{POSTHOG_HOST}}", escapeHtml(options.postHogHost));
  rendered = replaceRequired(rendered, "{{POSTHOG_KEY}}", escapeHtml(options.postHogKey));
  rendered = replaceRequired(rendered, "{{WRENCH_DESCRIPTION}}", escapeHtml(identity.description));
  rendered = replaceRequired(rendered, "{{WRENCH_INSTALL_COMMAND}}", escapeHtml(installCommand));
  rendered = replaceRequired(rendered, "{{WRENCH_RELEASE}}", escapeHtml(identity.release));
  rendered = replaceRequired(rendered, "{{WRENCH_VERSION}}", escapeHtml(identity.version));
  if (/\{\{[A-Z0-9_]+\}\}/u.test(rendered)) {
    throw new Error("The rendered page contains an unresolved template value.");
  }
  return rendered;
}

function contentHash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function postHogEnvironment(environment: Readonly<Record<string, string | undefined>>): {
  host: string;
  key: string;
} {
  const host = environment.NEXT_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  if (!supportedPostHogHosts.has(host)) {
    throw new Error(`Unsupported NEXT_PUBLIC_POSTHOG_HOST: ${host}`);
  }
  const key = environment.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "";
  if (key !== "" && !/^phc_[A-Za-z0-9_-]+$/u.test(key)) {
    throw new Error("NEXT_PUBLIC_POSTHOG_KEY must be empty or a public phc_ project token.");
  }
  return { host, key };
}

export async function buildWebsite(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const [manifest, indexTemplate, notFoundTemplate, css, analyticsBuild] = await Promise.all([
    Bun.file(join(repositoryRoot, "package.json")).json(),
    readFile(join(sourceRoot, "index.html"), "utf8"),
    readFile(join(sourceRoot, "404.html"), "utf8"),
    readFile(join(sourceRoot, "styles.css")),
    Bun.build({
      entrypoints: [join(sourceRoot, "analytics.ts")],
      format: "esm",
      minify: true,
      sourcemap: "none",
      target: "browser",
    }),
  ]);
  if (!analyticsBuild.success || analyticsBuild.outputs.length !== 1) {
    const messages = analyticsBuild.logs.map((log) => log.message).join("\n");
    throw new Error(`Analytics build failed: ${messages || "no browser output"}`);
  }
  const analytics = new Uint8Array(await analyticsBuild.outputs[0]!.arrayBuffer());
  const identity = parsePackageIdentity(manifest);
  const postHog = postHogEnvironment(environment);
  const cssAsset = `/assets/styles-${contentHash(css)}.css`;
  const analyticsAsset = `/assets/analytics-${contentHash(analytics)}.js`;
  const renderOptions = {
    analyticsAsset,
    cssAsset,
    packageIdentity: identity,
    postHogHost: postHog.host,
    postHogKey: postHog.key,
  } as const;

  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(join(outputRoot, "assets"), { recursive: true });
  await Promise.all([
    writeFile(join(outputRoot, "index.html"), renderIndex(indexTemplate, renderOptions)),
    writeFile(join(outputRoot, "404.html"), renderIndex(notFoundTemplate, renderOptions)),
    writeFile(join(outputRoot, cssAsset.slice(1)), css),
    writeFile(join(outputRoot, analyticsAsset.slice(1)), analytics),
    writeFile(
      join(outputRoot, "robots.txt"),
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
    ),
    writeFile(
      join(outputRoot, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n    <lastmod>${UPDATED_AT}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`,
    ),
    copyFile(join(publicRoot, "favicon.svg"), join(outputRoot, "favicon.svg")),
    copyFile(join(publicRoot, "og.png"), join(outputRoot, "og.png")),
  ]);
}

if (import.meta.main) {
  await buildWebsite();
}
