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

import { htmlMainToMarkdown } from "./html-to-markdown";
import {
  loadProviderCapabilityAttestation,
  renderProviderCapabilityAttestationTable,
  type ProviderCapabilityAttestation,
} from "./provider-capability-attestation";

export const SITE_ORIGIN = "https://wrench.rip" as const;
export const SITE_TITLE = "Wrench: precise web capabilities for AI agents" as const;
export const SITE_DESCRIPTION =
  "Open-source CLI and TypeScript SDK for precise web capabilities for AI agents: page capture, verified media archives, encrypted reads, and typed provider operations." as const;
export const REPOSITORY_URL = "https://github.com/hraness/wrench" as const;
export const PUBLISHER_URL = "https://github.com/hraness" as const;
export const SKILL_INSTALL_COMMAND = "npx skills add hraness/wrench" as const;
export const SKILL_INSTALL_COMMAND_BUNX = "bunx skills add hraness/wrench" as const;
export const CONTENT_REVIEWED_RELEASE = "v0.12.0" as const;
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com" as const;

export const PUBLIC_PAGES = [
  {
    canonicalPath: "/",
    description: SITE_DESCRIPTION,
    outputFile: "index.html",
    sourceFile: "index.html",
    title: SITE_TITLE,
  },
  {
    canonicalPath: "/getting-started/",
    description:
      "Install Wrench with Bun, verify local readiness, capture a first URL, and inspect the exact capabilities available on your machine.",
    outputFile: "getting-started/index.html",
    sourceFile: "getting-started.html",
    title: "Install Wrench: CLI and TypeScript SDK getting started guide",
  },
  {
    canonicalPath: "/capture-and-archives/",
    description:
      "Capture public URLs as Markdown and preserve one authorized media item with manifests, transcripts, provenance, and SHA-256 verification.",
    outputFile: "capture-and-archives/index.html",
    sourceFile: "capture-and-archives.html",
    title: "Capture URLs and create verified media archives with Wrench",
  },
  {
    canonicalPath: "/provider-capabilities/",
    description:
      "Wrench provider capability attestation checked against bundled public adapter manifests. Each listed operation includes its reviewed completeness and current limit.",
    outputFile: "provider-capabilities/index.html",
    sourceFile: "provider-capabilities.html",
    title: "Wrench provider capability attestation",
  },
  {
    canonicalPath: "/security/",
    description:
      "Understand Wrench local custody, encrypted snapshots, exact account binding, fail-closed provider contracts, risk levels, and mutation recovery.",
    outputFile: "security/index.html",
    sourceFile: "security.html",
    title: "Wrench security: local custody and bounded provider contracts",
  },
  {
    canonicalPath: "/plugins/",
    description:
      "Create, statically check, test, reproducibly pack, trust, and install a content-addressed Wrench provider plugin without weakening the kernel boundary.",
    outputFile: "plugins/index.html",
    sourceFile: "plugins.html",
    title: "Author and verify Wrench provider plugins",
  },
  {
    canonicalPath: "/about/",
    description:
      "Wrench is an open-source CLI and TypeScript SDK that gives command-capable agents precise web capabilities with local custody.",
    outputFile: "about/index.html",
    sourceFile: "about.html",
    title: "About Wrench: open-source web capabilities for AI agents",
  },
  {
    canonicalPath: "/contact/",
    description:
      "Contact Wrench through public GitHub issues or private vulnerability reporting. No telephone, postal address, or support inbox is published.",
    outputFile: "contact/index.html",
    sourceFile: "contact.html",
    title: "Contact Wrench maintainers and report security issues",
  },
  {
    canonicalPath: "/privacy/",
    description:
      "wrench.rip uses cookieless, personless, DNT-aware PostHog analytics limited to page lifecycle, Core Web Vitals, and two GitHub links.",
    outputFile: "privacy/index.html",
    sourceFile: "privacy.html",
    title: "Wrench website privacy: cookieless, personless analytics",
  },
] as const;

export type PublicPage = (typeof PUBLIC_PAGES)[number];

export function markdownSiblingPath(canonicalPath: string): string {
  return canonicalPath === "/" ? "/index.md" : `${canonicalPath.slice(0, -1)}.md`;
}

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
  attestation: ProviderCapabilityAttestation;
  attestationTable: string;
  cssAsset: string;
  packageIdentity: PackageIdentity;
  postHogHost: string;
  postHogKey: string;
  skillInstallAsset: string;
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

function isHtmlTemplate(template: string): boolean {
  return /<!doctype html/iu.test(template);
}

function replaceHtmlRequired(template: string, placeholder: string, value: string): string {
  if (!isHtmlTemplate(template)) {
    return template.includes(placeholder) ? template.replaceAll(placeholder, value) : template;
  }
  return replaceRequired(template, placeholder, value);
}

function sharedJsonLd(identity: PackageIdentity): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return [
    {
      "@id": `${SITE_ORIGIN}/#organization`,
      "@type": "Organization",
      name: "Hraness",
      sameAs: [PUBLISHER_URL],
      url: PUBLISHER_URL,
    },
    {
      "@id": `${SITE_ORIGIN}/#website`,
      "@type": "WebSite",
      description: SITE_DESCRIPTION,
      inLanguage: "en",
      name: "Wrench",
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      url: `${SITE_ORIGIN}/`,
    },
    {
      "@id": `${SITE_ORIGIN}/#software`,
      "@type": "SoftwareApplication",
      applicationCategory: "DeveloperApplication",
      author: { "@id": `${SITE_ORIGIN}/#organization` },
      description: SITE_DESCRIPTION,
      featureList: [
        "Durable Markdown page capture",
        "Verified finite-item media archives",
        "Encrypted exact-query read snapshots",
        "Typed and bounded provider operations",
        "Fail-closed provider contract drift",
      ],
      installUrl: `${SITE_ORIGIN}/getting-started/`,
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
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
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
  ];
}

function jsonLd(identity: PackageIdentity, page: PublicPage): Readonly<Record<string, unknown>> {
  const url = `${SITE_ORIGIN}${page.canonicalPath}`;
  const pageId = `${url}#webpage`;
  const isHome = page.canonicalPath === "/";
  const pageGraph: Array<Readonly<Record<string, unknown>>> = [
    {
      "@id": pageId,
      "@type": "WebPage",
      breadcrumb: isHome ? undefined : { "@id": `${url}#breadcrumb` },
      description: page.description,
      inLanguage: "en",
      isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
      mainEntity: { "@id": isHome ? `${SITE_ORIGIN}/#software` : `${url}#article` },
      name: page.title,
      url,
    },
  ];

  if (!isHome) {
    pageGraph.push(
      {
        "@id": `${url}#article`,
        "@type": "TechArticle",
        about: { "@id": `${SITE_ORIGIN}/#software` },
        author: { "@id": `${SITE_ORIGIN}/#organization` },
        description: page.description,
        headline: page.title,
        inLanguage: "en",
        isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
        mainEntityOfPage: { "@id": pageId },
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      },
      {
        "@id": `${url}#breadcrumb`,
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            item: `${SITE_ORIGIN}/`,
            name: "Wrench",
            position: 1,
          },
          {
            "@type": "ListItem",
            item: url,
            name: page.title,
            position: 2,
          },
        ],
      },
    );
  }

  return {
    "@context": "https://schema.org",
    "@graph": [...sharedJsonLd(identity), ...pageGraph],
  };
}

function renderTemplate(
  template: string,
  options: RenderOptions,
  page?: PublicPage,
): string {
  const { packageIdentity: identity } = options;
  const installCommand = `bun add --global github:hraness/wrench#${identity.release}`;
  let rendered = template;
  rendered = replaceHtmlRequired(rendered, "{{ANALYTICS_ASSET}}", escapeHtml(options.analyticsAsset));
  rendered = replaceHtmlRequired(rendered, "{{CSS_ASSET}}", escapeHtml(options.cssAsset));
  if (page) {
    const structuredData = JSON.stringify(jsonLd(identity, page)).replaceAll("<", "\\u003c");
    rendered = replaceRequired(rendered, "{{JSON_LD}}", structuredData);
    rendered = replaceRequired(
      rendered,
      "{{MARKDOWN_ALTERNATE}}",
      `<link rel="alternate" type="text/markdown" title="Markdown" href="${SITE_ORIGIN}${markdownSiblingPath(page.canonicalPath)}">`,
    );
  } else if (rendered.includes("{{JSON_LD}}")) {
    throw new Error("A non-indexable page must not include structured data.");
  } else if (rendered.includes("{{MARKDOWN_ALTERNATE}}")) {
    throw new Error("A non-indexable page must not advertise a markdown alternate.");
  }
  rendered = replaceHtmlRequired(rendered, "{{POSTHOG_HOST}}", escapeHtml(options.postHogHost));
  rendered = replaceHtmlRequired(rendered, "{{POSTHOG_KEY}}", escapeHtml(options.postHogKey));
  if (page?.canonicalPath === "/provider-capabilities/") {
    rendered = replaceRequired(
      rendered,
      "{{PROVIDER_CAPABILITY_ATTESTATION_TABLE}}",
      options.attestationTable,
    );
    rendered = replaceRequired(
      rendered,
      "{{PROVIDER_CAPABILITY_ADAPTER_COUNT}}",
      String(options.attestation.adapterCount),
    );
    rendered = replaceRequired(
      rendered,
      "{{PROVIDER_CAPABILITY_CAPTURE_REQUIRED_COUNT}}",
      String(options.attestation.captureRequiredCount),
    );
    rendered = replaceRequired(
      rendered,
      "{{PROVIDER_CAPABILITY_OBSERVED_COUNT}}",
      String(options.attestation.observedCount),
    );
    rendered = replaceRequired(
      rendered,
      "{{PROVIDER_CAPABILITY_OPERATION_COUNT}}",
      String(options.attestation.operationCount),
    );
  } else if (rendered.includes("{{PROVIDER_CAPABILITY")) {
    throw new Error("Only the provider capability page may include attestation placeholders.");
  }
  const optionalValues = new Map([
    ["{{WRENCH_DESCRIPTION}}", identity.description],
    ["{{WRENCH_INSTALL_COMMAND}}", installCommand],
    ["{{WRENCH_RELEASE}}", identity.release],
    ["{{WRENCH_REPOSITORY}}", REPOSITORY_URL],
    ["{{WRENCH_SKILL_INSTALL_ASSET}}", options.skillInstallAsset],
    ["{{WRENCH_SKILL_INSTALL_COMMAND}}", SKILL_INSTALL_COMMAND],
    ["{{WRENCH_SKILL_INSTALL_COMMAND_BUNX}}", SKILL_INSTALL_COMMAND_BUNX],
    ["{{WRENCH_VERSION}}", identity.version],
  ]);
  for (const [placeholder, value] of optionalValues) {
    if (rendered.includes(placeholder)) {
      rendered = rendered.replaceAll(placeholder, escapeHtml(value));
    }
  }
  if (/\{\{[A-Z0-9_]+\}\}/u.test(rendered)) {
    throw new Error("The rendered page contains an unresolved template value.");
  }
  return rendered;
}

export function renderIndex(template: string, options: RenderOptions): string {
  return renderTemplate(template, options, PUBLIC_PAGES[0]);
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
  const [
    manifest,
    publicTemplates,
    notFoundTemplate,
    notFoundMarkdown,
    llmsTemplate,
    css,
    analyticsBuild,
    skillInstallBuild,
    attestation,
  ] = await Promise.all([
    Bun.file(join(repositoryRoot, "package.json")).json(),
    Promise.all(PUBLIC_PAGES.map((page) => readFile(join(sourceRoot, page.sourceFile), "utf8"))),
    readFile(join(sourceRoot, "404.html"), "utf8"),
    readFile(join(sourceRoot, "404.md"), "utf8"),
    readFile(join(sourceRoot, "llms.txt"), "utf8"),
    readFile(join(sourceRoot, "styles.css")),
    Bun.build({
      entrypoints: [join(sourceRoot, "analytics.ts")],
      format: "esm",
      minify: true,
      sourcemap: "none",
      target: "browser",
    }),
    Bun.build({
      entrypoints: [join(sourceRoot, "skill-install-command.ts")],
      format: "esm",
      minify: true,
      sourcemap: "none",
      target: "browser",
    }),
    loadProviderCapabilityAttestation(repositoryRoot),
  ]);
  if (!analyticsBuild.success || analyticsBuild.outputs.length !== 1) {
    const messages = analyticsBuild.logs.map((log) => log.message).join("\n");
    throw new Error(`Analytics build failed: ${messages || "no browser output"}`);
  }
  const analytics = new Uint8Array(await analyticsBuild.outputs[0]!.arrayBuffer());
  if (!skillInstallBuild.success || skillInstallBuild.outputs.length !== 1) {
    const messages = skillInstallBuild.logs.map((log) => log.message).join("\n");
    throw new Error(`Skill install control build failed: ${messages || "no browser output"}`);
  }
  const skillInstall = new Uint8Array(await skillInstallBuild.outputs[0]!.arrayBuffer());
  const identity = parsePackageIdentity(manifest);
  if (identity.release !== CONTENT_REVIEWED_RELEASE) {
    throw new Error(
      `Website content is reviewed for ${CONTENT_REVIEWED_RELEASE}, not ${identity.release}. Review every public page before updating CONTENT_REVIEWED_RELEASE.`,
    );
  }
  const postHog = postHogEnvironment(environment);
  const cssAsset = `/assets/styles-${contentHash(css)}.css`;
  const analyticsAsset = `/assets/analytics-${contentHash(analytics)}.js`;
  const skillInstallAsset = `/assets/skill-install-${contentHash(skillInstall)}.js`;
  const renderOptions = {
    analyticsAsset,
    attestation,
    attestationTable: renderProviderCapabilityAttestationTable(attestation),
    cssAsset,
    packageIdentity: identity,
    postHogHost: postHog.host,
    postHogKey: postHog.key,
    skillInstallAsset,
  } as const;

  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(join(outputRoot, "assets"), { recursive: true });
  await Promise.all(PUBLIC_PAGES.map((page) => mkdir(dirname(join(outputRoot, page.outputFile)), {
    recursive: true,
  })));
  const renderedPages = PUBLIC_PAGES.map((page, index) => ({
    page,
    html: renderTemplate(publicTemplates[index]!, renderOptions, page),
  }));
  await Promise.all([
    ...renderedPages.map(({ page, html }) => writeFile(join(outputRoot, page.outputFile), html)),
    ...renderedPages.map(({ page, html }) => writeFile(
      join(outputRoot, markdownSiblingPath(page.canonicalPath).slice(1)),
      htmlMainToMarkdown(html, `${SITE_ORIGIN}${page.canonicalPath}`),
    )),
    writeFile(join(outputRoot, "404.html"), renderTemplate(notFoundTemplate, renderOptions)),
    writeFile(join(outputRoot, "404.md"), renderTemplate(notFoundMarkdown, renderOptions)),
    writeFile(join(outputRoot, "llms.txt"), renderTemplate(llmsTemplate, renderOptions)),
    writeFile(join(outputRoot, cssAsset.slice(1)), css),
    writeFile(join(outputRoot, analyticsAsset.slice(1)), analytics),
    writeFile(join(outputRoot, skillInstallAsset.slice(1)), skillInstall),
    writeFile(
      join(outputRoot, "robots.txt"),
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
    ),
    writeFile(
      join(outputRoot, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PUBLIC_PAGES.map((page) => `  <url>\n    <loc>${SITE_ORIGIN}${page.canonicalPath}</loc>\n  </url>`).join("\n")}\n</urlset>\n`,
    ),
    copyFile(join(publicRoot, "favicon.svg"), join(outputRoot, "favicon.svg")),
    copyFile(join(publicRoot, "og.png"), join(outputRoot, "og.png")),
    copyFile(
      join(publicRoot, "dc84ee4863539f2fff50ef5f0a164168.txt"),
      join(outputRoot, "dc84ee4863539f2fff50ef5f0a164168.txt"),
    ),
  ]);
}

if (import.meta.main) {
  await buildWebsite();
}
