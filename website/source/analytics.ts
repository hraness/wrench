const SITE_ID = "wrench" as const;
const CANONICAL_DOMAIN = "wrench.rip" as const;
const CANONICAL_ORIGIN = `https://${CANONICAL_DOMAIN}` as const;
const SCHEMA_VERSION = 1 as const;
const NOT_FOUND_PATH = "/not-found" as const;
const POSTHOG_SDK_VERSION = "1.412.1" as const;
const CANONICAL_ROUTES = new Map<string, Readonly<{ canonicalPath: string; pageKind: string }>>([
  ["/", { canonicalPath: "/", pageKind: "product_landing" }],
  ["/capture-and-archives", {
    canonicalPath: "/capture-and-archives/",
    pageKind: "capture_and_archives",
  }],
  ["/about", { canonicalPath: "/about/", pageKind: "about" }],
  ["/contact", { canonicalPath: "/contact/", pageKind: "contact" }],
  ["/getting-started", { canonicalPath: "/getting-started/", pageKind: "getting_started" }],
  ["/plugins", { canonicalPath: "/plugins/", pageKind: "plugin_authoring" }],
  ["/privacy", { canonicalPath: "/privacy/", pageKind: "privacy" }],
  ["/provider-capabilities", {
    canonicalPath: "/provider-capabilities/",
    pageKind: "provider_capabilities",
  }],
  ["/providers/beeper", {
    canonicalPath: "/providers/beeper/",
    pageKind: "provider_beeper",
  }],
  ["/security", { canonicalPath: "/security/", pageKind: "security" }],
  ["/vms-cannot-contain-agents", {
    canonicalPath: "/vms-cannot-contain-agents/",
    pageKind: "vms_cannot_contain_agents",
  }],
  ["/paypal-grapheneos-attestation", {
    canonicalPath: "/paypal-grapheneos-attestation/",
    pageKind: "paypal_grapheneos_attestation",
  }],
]);

const ALLOWED_EVENTS = new Set([
  "$pageleave",
  "$pageview",
  "$web_vitals",
  "project link opened",
]);
const QUERY_ATTRIBUTION_KEYS = new Set([
  "_kx",
  "dclid",
  "epik",
  "fbclid",
  "gad_source",
  "gbraid",
  "gclid",
  "gclsrc",
  "igshid",
  "irclid",
  "li_fat_id",
  "mc_cid",
  "msclkid",
  "qclid",
  "rdt_cid",
  "sccid",
  "ttclid",
  "twclid",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "wbraid",
]);
const CURRENT_URL_KEYS = new Set([
  "$current_url",
  "$initial_current_url",
  "$session_entry_url",
  "current_url",
  "href",
  "url",
  "url.full",
]);
const REFERRER_KEYS = new Set(["$initial_referrer", "$referrer", "referrer"]);
const SAFE_CUSTOM_PROPERTIES = new Set([
  "target_host",
  "target_id",
  "target_kind",
  "target_path",
]);
const MAX_PROPERTIES = 64;
const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 2_048;

type AnalyticsCapture = Readonly<{
  event: string;
  properties: Readonly<Record<string, unknown>>;
  timestamp?: string;
  uuid?: string;
}>;

type BrowserEvidence = Readonly<{
  href: string;
  referrer: string;
}>;

type PostHogCaptureOptions = Readonly<{
  send_instantly: true;
  transport: "sendBeacon";
}>;

type PostHogCaptureTarget = Readonly<{
  capture?: (
    event: string,
    properties?: Readonly<Record<string, unknown>>,
    options?: PostHogCaptureOptions,
  ) => void;
}>;

type PostHogQueue = unknown[] & PostHogCaptureTarget & {
  __SV?: number;
  _i?: unknown[];
  init?: (token: string, config: Readonly<Record<string, unknown>>, name?: string) => void;
  people?: unknown[] & { toString?: () => string };
  toString?: (stub?: number) => string;
  [key: string]: unknown;
};

declare global {
  interface Window {
    posthog?: PostHogQueue;
  }
}

function unknownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

export function normalizePathname(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/u, 1)[0] ?? "/";
  const leading = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const collapsed = leading.replace(/\/{2,}/gu, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : "/";
}

function canonicalRoute(rawUrl: string): { canonicalPath: string; pageKind: string } | null {
  try {
    const url = new URL(rawUrl, `${CANONICAL_ORIGIN}/`);
    if (url.hostname.toLowerCase().replace(/\.$/u, "") !== CANONICAL_DOMAIN) return null;
    const pathname = normalizePathname(url.pathname);
    return CANONICAL_ROUTES.get(pathname)
      ?? { canonicalPath: NOT_FOUND_PATH, pageKind: "not_found" };
  } catch {
    return null;
  }
}

function canonicalUrl(pathname: string): string {
  return `${CANONICAL_ORIGIN}${pathname}`;
}

function normalizedPropertyName(key: string): string {
  return key.toLowerCase().replace(/^\$/u, "").replace(/^(?:initial|session_entry)_/u, "");
}

function isQueryAttributionKey(key: string): boolean {
  return QUERY_ATTRIBUTION_KEYS.has(normalizedPropertyName(key));
}

function isPathnameKey(key: string): boolean {
  return /^(?:\$)?(?:(?:initial|session_entry|prev_pageview)_)?pathname$/u.test(key.toLowerCase());
}

function stripUrlDetail(value: string, originOnly: boolean): string {
  try {
    const url = new URL(value);
    return originOnly ? url.origin : `${url.origin}${normalizePathname(url.pathname)}`;
  } catch {
    return "";
  }
}

function redactText(value: string): string {
  return value
    .replace(/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, "Bearer [credential]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/(https?:\/\/[^\s?#)]+)(?:\?[^\s#)]*)?(?:#[^\s)]*)?/giu, "$1")
    .replace(/([/][^\s?#)]+)\?[^\s#)]*/gu, "$1")
    .replace(/\b(api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password)=([^\s&]+)/giu, "$1=[redacted]")
    .slice(0, MAX_STRING_LENGTH);
}

function sanitizeString(key: string, value: string, route: { canonicalPath: string }): string {
  if (REFERRER_KEYS.has(key)) return stripUrlDetail(value, true);
  if (CURRENT_URL_KEYS.has(key)) return canonicalUrl(route.canonicalPath);
  if (isPathnameKey(key)) return route.canonicalPath;
  return redactText(value);
}

function sanitizeValue(
  key: string,
  value: unknown,
  route: { canonicalPath: string },
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (isQueryAttributionKey(key)) return undefined;
  if (typeof value === "string") return sanitizeString(key, value, route);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(key, item, route, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, MAX_PROPERTIES)) {
    const safeValue = sanitizeValue(nestedKey, nestedValue, route, depth + 1, seen);
    if (safeValue !== undefined) result[nestedKey] = safeValue;
  }
  return result;
}

function trafficForReferrer(referrer: string): Readonly<Record<string, string>> {
  if (!referrer) return { traffic_channel: "direct", traffic_source: "direct" };
  let hostname: string;
  try {
    hostname = new URL(referrer).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return { traffic_channel: "referral", traffic_source: "unknown" };
  }
  if (hostname === CANONICAL_DOMAIN) {
    return { referrer_host: hostname, traffic_channel: "internal", traffic_source: "internal" };
  }
  const knownSources = [
    ["ai_referral", "chatgpt", ["chatgpt.com", "chat.openai.com"]],
    ["ai_referral", "claude", ["claude.ai"]],
    ["ai_referral", "perplexity", ["perplexity.ai"]],
    ["ai_referral", "gemini", ["gemini.google.com"]],
    ["organic_search", "google", ["google.com", "google.co.uk", "google.ca", "google.com.au"]],
    ["organic_search", "bing", ["bing.com"]],
    ["organic_search", "duckduckgo", ["duckduckgo.com"]],
    ["social", "reddit", ["reddit.com"]],
    ["social", "x", ["x.com", "twitter.com", "t.co"]],
    ["social", "linkedin", ["linkedin.com"]],
  ] as const;
  for (const [channel, source, domains] of knownSources) {
    if (domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return { referrer_host: hostname, traffic_channel: channel, traffic_source: source };
    }
  }
  return { referrer_host: hostname, traffic_channel: "referral", traffic_source: hostname };
}

export function sanitizeCapture(
  value: unknown,
  evidence: BrowserEvidence,
): AnalyticsCapture | null {
  const capture = unknownRecord(value);
  if (capture === null || typeof capture.event !== "string" || !ALLOWED_EVENTS.has(capture.event)) {
    return null;
  }
  const properties = unknownRecord(capture.properties);
  if (properties === null) return null;
  const token = properties.token;
  if (typeof token !== "string" || !/^phc_[A-Za-z0-9_-]+$/u.test(token)) return null;
  const rawUrl = typeof properties.$current_url === "string" ? properties.$current_url : evidence.href;
  const route = canonicalRoute(rawUrl);
  if (route === null) return null;
  const safeProperties: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  for (const [key, propertyValue] of Object.entries(properties).slice(0, MAX_PROPERTIES)) {
    const safeValue = sanitizeValue(key, propertyValue, route, 0, seen);
    if (safeValue !== undefined) safeProperties[key] = safeValue;
  }
  const rawReferrer = typeof properties.$referrer === "string" ? properties.$referrer : evidence.referrer;
  return {
    event: capture.event,
    properties: {
      ...safeProperties,
      ...trafficForReferrer(rawReferrer),
      $current_url: canonicalUrl(route.canonicalPath),
      $pathname: route.canonicalPath,
      $process_person_profile: false,
      analytics_schema_version: SCHEMA_VERSION,
      canonical_domain: CANONICAL_DOMAIN,
      canonical_path: route.canonicalPath,
      content_group: "wrench",
      page_kind: route.pageKind,
      site_id: SITE_ID,
      token,
    },
    ...(typeof capture.timestamp === "string" ? { timestamp: capture.timestamp } : {}),
    ...(typeof capture.uuid === "string" ? { uuid: capture.uuid } : {}),
  };
}

export function createBrowserConfig(host: string, evidence: BrowserEvidence): Readonly<Record<string, unknown>> {
  return {
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    advanced_disable_flags: true,
    api_host: host,
    autocapture: false,
    before_send: (capture: unknown) => sanitizeCapture(capture, evidence),
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_pageleave: true,
    capture_pageview: true,
    capture_performance: {
      network_timing: false,
      web_vitals: true,
      web_vitals_allowed_metrics: ["LCP", "CLS", "FCP", "INP"],
      web_vitals_attribution: false,
    },
    cookieless_mode: "always",
    cross_subdomain_cookie: false,
    custom_personal_data_properties: ["email", "token", "code", "key", "secret"],
    defaults: "2026-05-30",
    disable_capture_url_hashes: true,
    disable_conversations: true,
    disable_product_tours: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disableDeviceModel: true,
    enable_recording_console_log: false,
    internal_or_test_user_hostname: null,
    mask_all_element_attributes: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    persistence: "memory",
    person_profiles: "never",
    properties_string_max_length: MAX_STRING_LENGTH,
    rageclick: false,
    rate_limiting: { events_burst_limit: 12, events_per_second: 2 },
    respect_dnt: true,
    strict_script_versioning: true,
    ui_host: host.includes("eu.i.posthog.com") ? "https://eu.posthog.com" : "https://us.posthog.com",
  };
}

export function captureProjectLink(
  posthog: PostHogCaptureTarget,
  properties: Readonly<Record<string, string>>,
): void {
  posthog.capture?.("project link opened", properties, {
    send_instantly: true,
    transport: "sendBeacon",
  });
}

function stubMethod(target: PostHogQueue, method: string): void {
  target[method] = (...args: unknown[]) => target.push([method, ...args]);
}

function installPostHogQueue(documentValue: Document, windowValue: Window): PostHogQueue {
  if (windowValue.posthog?.__SV === 1) return windowValue.posthog;
  const queue = (windowValue.posthog ?? []) as PostHogQueue;
  queue._i = queue._i ?? [];
  queue.init = (token, config, name) => {
    if (documentValue.querySelector('script[data-wrench-posthog-sdk="true"]') === null) {
      const script = documentValue.createElement("script");
      const apiHost = typeof config.api_host === "string" ? config.api_host : "https://us.i.posthog.com";
      const assetHost = apiHost.replace(".i.posthog.com", "-assets.i.posthog.com");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.dataset.wrenchPosthogSdk = "true";
      script.src = `${assetHost}/static/${POSTHOG_SDK_VERSION}/array.js`;
      documentValue.head.append(script);
    }
    const instance = name === undefined
      ? queue
      : ((queue[name] = []) as unknown as PostHogQueue);
    instance.people = instance.people ?? [];
    instance.toString = (stub = 0) => `${name ?? "posthog"}${stub === 0 ? " (stub)" : ""}`;
    instance.people.toString = () => `${name ?? "posthog"}.people (stub)`;
    const methods = [
      "capture",
      "captureException",
      "clear_opt_in_out_capturing",
      "createPersonProfile",
      "debug",
      "get_distinct_id",
      "get_session_id",
      "get_session_replay_url",
      "getFeatureFlag",
      "getFeatureFlagResult",
      "group",
      "has_opted_in_capturing",
      "has_opted_out_capturing",
      "identify",
      "isFeatureEnabled",
      "loadToolbar",
      "onFeatureFlags",
      "onSessionId",
      "opt_in_capturing",
      "opt_out_capturing",
      "register",
      "register_once",
      "reloadFeatureFlags",
      "reset",
      "set_config",
      "startSessionRecording",
      "stopSessionRecording",
      "unregister",
    ];
    for (const method of methods) stubMethod(instance, method);
    queue._i?.push([token, config, name]);
  };
  queue.__SV = 1;
  windowValue.posthog = queue;
  return queue;
}

function metaContent(documentValue: Document, name: string): string {
  return documentValue.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() ?? "";
}

function initializeBrowserAnalytics(): void {
  const key = metaContent(document, "wrench-posthog-key");
  const host = metaContent(document, "wrench-posthog-host");
  if (
    window.location.protocol !== "https:"
    || window.location.hostname.toLowerCase().replace(/\.$/u, "") !== CANONICAL_DOMAIN
    || !/^phc_[A-Za-z0-9_-]+$/u.test(key)
    || !/^https:\/\/(?:eu|us)\.i\.posthog\.com$/u.test(host)
  ) return;

  const evidence = { href: window.location.href, referrer: document.referrer } as const;
  const posthog = installPostHogQueue(document, window);
  posthog.init?.(key, createBrowserConfig(host, evidence));

  document.addEventListener("click", (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-analytics-event]");
    if (link?.dataset.analyticsEvent !== "project link opened") return;
    const analyticsId = link.dataset.analyticsId;
    const analyticsKind = link.dataset.analyticsKind;
    const properties: Record<string, string> = {};
    if (analyticsId && SAFE_CUSTOM_PROPERTIES.has("target_id")) properties.target_id = analyticsId.slice(0, 64);
    if (analyticsKind && SAFE_CUSTOM_PROPERTIES.has("target_kind")) properties.target_kind = analyticsKind.slice(0, 64);
    try {
      const targetUrl = new URL(link.href, window.location.href);
      if (SAFE_CUSTOM_PROPERTIES.has("target_host")) properties.target_host = targetUrl.hostname.toLowerCase();
      if (SAFE_CUSTOM_PROPERTIES.has("target_path")) properties.target_path = normalizePathname(targetUrl.pathname);
    } catch {
      // A malformed link contributes no destination dimensions.
    }
    captureProjectLink(posthog, properties);
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initializeBrowserAnalytics();
}
