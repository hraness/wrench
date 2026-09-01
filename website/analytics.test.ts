import { describe, expect, test } from "bun:test";

import {
  captureProjectLink,
  createBrowserConfig,
  sanitizeCapture,
} from "./source/analytics";

const evidence = {
  href: "https://wrench.rip/?utm_source=private#fragment",
  referrer: "https://chatgpt.com/private/thread?token=private",
} as const;

describe("Wrench browser analytics", () => {
  test("sends repository interest immediately with an unload-safe transport", () => {
    const captures: unknown[][] = [];
    const properties = {
      target_host: "github.com",
      target_id: "hero-github",
      target_kind: "repository",
      target_path: "/hraness/wrench",
    } as const;

    captureProjectLink({
      capture: (event, capturedProperties, options) => {
        captures.push([event, capturedProperties, options]);
      },
    }, properties);

    expect(captures).toEqual([["project link opened", properties, {
      send_instantly: true,
      transport: "sendBeacon",
    }]]);
  });

  test("keeps the shared cookieless and personless privacy posture", () => {
    const config = createBrowserConfig("https://us.i.posthog.com", evidence);
    expect(config).toMatchObject({
      advanced_disable_feature_flags: true,
      autocapture: false,
      capture_exceptions: false,
      capture_heatmaps: false,
      capture_pageleave: true,
      capture_pageview: true,
      cookieless_mode: "always",
      cross_subdomain_cookie: false,
      disable_conversations: true,
      disable_product_tours: true,
      disable_session_recording: true,
      disable_surveys: true,
      enable_recording_console_log: false,
      mask_all_element_attributes: true,
      mask_all_text: true,
      mask_personal_data_properties: true,
      persistence: "memory",
      person_profiles: "never",
      rageclick: false,
      respect_dnt: true,
      strict_script_versioning: true,
    });
  });

  test("canonicalizes page data and removes query attribution", () => {
    const capture = sanitizeCapture({
      event: "$pageview",
      properties: {
        $current_url: "https://wrench.rip/?utm_campaign=private#private",
        $pathname: "/private-value",
        $referrer: "https://chatgpt.com/c/private?secret=value",
        nested: {
          email: "reader@example.com",
          href: "https://wrench.rip/private?token=secret",
        },
        token: "phc_public_project_token",
        utm_campaign: "private",
      },
      uuid: "event-id",
    }, evidence);

    expect(capture).not.toBeNull();
    expect(capture?.properties).toMatchObject({
      $current_url: "https://wrench.rip/",
      $pathname: "/",
      $process_person_profile: false,
      analytics_schema_version: 1,
      canonical_domain: "wrench.rip",
      canonical_path: "/",
      content_group: "wrench",
      page_kind: "product_landing",
      referrer_host: "chatgpt.com",
      site_id: "wrench",
      traffic_channel: "ai_referral",
      traffic_source: "chatgpt",
    });
    expect(capture?.properties).not.toHaveProperty("utm_campaign");
    expect(capture?.properties.nested).toEqual({
      email: "[email]",
      href: "https://wrench.rip/",
    });
  });

  test("collapses unknown canonical paths and rejects foreign hosts", () => {
    const notFound = sanitizeCapture({
      event: "$pageview",
      properties: {
        $current_url: "https://wrench.rip/private/path?query=secret",
        token: "phc_public_project_token",
      },
    }, evidence);
    expect(notFound?.properties).toMatchObject({
      $current_url: "https://wrench.rip/not-found",
      canonical_path: "/not-found",
      page_kind: "not_found",
    });

    expect(sanitizeCapture({
      event: "$pageview",
      properties: {
        $current_url: "https://preview.example.com/",
        token: "phc_public_project_token",
      },
    }, evidence)).toBeNull();
  });

  test("keeps each public content route distinct without retaining URL detail", () => {
    const routes = [
      ["/getting-started/", "getting_started"],
      ["/capture-and-archives/", "capture_and_archives"],
      ["/provider-capabilities/", "provider_capabilities"],
      ["/providers/beeper/", "provider_beeper"],
      ["/security/", "security"],
      ["/plugins/", "plugin_authoring"],
      ["/about/", "about"],
      ["/contact/", "contact"],
      ["/privacy/", "privacy"],
      ["/vms-cannot-contain-agents/", "vms_cannot_contain_agents"],
      ["/paypal-grapheneos-attestation/", "paypal_grapheneos_attestation"],
      ["/rumour-is-the-exploit/", "rumour_is_the_exploit"],
      ["/omarchy-root-escalation/", "omarchy_root_escalation"],
    ] as const;

    for (const [path, pageKind] of routes) {
      const capture = sanitizeCapture({
        event: "$pageview",
        properties: {
          $current_url: `https://wrench.rip${path}?utm_source=private#private-fragment`,
          $pathname: `${path}?private=query`,
          token: "phc_public_project_token",
        },
      }, evidence);
      expect(capture?.properties).toMatchObject({
        $current_url: `https://wrench.rip${path}`,
        $pathname: path,
        canonical_path: path,
        page_kind: pageKind,
      });
    }
  });

  test("allows only page lifecycle, web vitals, and the repository event", () => {
    for (const event of ["$pageview", "$pageleave", "$web_vitals"]) {
      expect(sanitizeCapture({
        event,
        properties: { token: "phc_public_project_token" },
      }, evidence)?.event).toBe(event);
    }
    expect(sanitizeCapture({
      event: "project link opened",
      properties: {
        target_host: "github.com",
        target_id: "hero-github",
        target_kind: "repository",
        target_path: "/hraness/wrench",
        token: "phc_public_project_token",
      },
    }, evidence)?.properties).toMatchObject({
      target_host: "github.com",
      target_id: "hero-github",
      target_kind: "repository",
      target_path: "/hraness/wrench",
    });
    expect(sanitizeCapture({
      event: "$autocapture",
      properties: { token: "phc_public_project_token" },
    }, evidence)).toBeNull();
    expect(sanitizeCapture({
      event: "invented event",
      properties: { token: "phc_public_project_token" },
    }, evidence)).toBeNull();
  });
});
