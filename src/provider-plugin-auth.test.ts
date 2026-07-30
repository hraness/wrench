import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "./auth";
import {
  requireProviderPluginAuth,
  type ProviderPluginAuthBinding,
} from "./provider-plugin-auth";

const hashlessOAuthAuth: WrenchAuth = {
  schemaVersion: 1,
  id: "mastodon-main",
  kind: "oauth-token-file",
  provider: "mastodon",
  path: "/private/mastodon-token",
  scopes: ["read"],
};

describe("provider plugin auth binding", () => {
  test("accepts a non-built-in OAuth realm only for its exact provider surface", () => {
    const binding: ProviderPluginAuthBinding = {
      transport: "provider-api",
      surfaceId: "mastodon",
      authKinds: ["oauth-token-file"],
    };

    expect(() => requireProviderPluginAuth(binding, hashlessOAuthAuth)).not.toThrow();
    expect(() => requireProviderPluginAuth(
      { ...binding, surfaceId: "fediverse-cloud" },
      hashlessOAuthAuth,
    )).toThrow("is for mastodon, not fediverse-cloud");
  });

  test("binds linked-device stores to the resolved linked-device surface", () => {
    const binding: ProviderPluginAuthBinding = {
      transport: "linked-device",
      surfaceId: "signal",
      authKinds: ["linked-device-store"],
    };
    const auth: WrenchAuth = {
      schemaVersion: 1,
      id: "signal-main",
      kind: "linked-device-store",
      provider: "signal",
      path: "/private/signal-device",
    };

    expect(() => requireProviderPluginAuth(binding, auth)).not.toThrow();
    expect(() => requireProviderPluginAuth(
      { ...binding, surfaceId: "whatsapp" },
      auth,
    )).toThrow("is for signal, not whatsapp");
  });

  test("rejects an auth kind the plugin binding did not declare", () => {
    const binding: ProviderPluginAuthBinding = {
      transport: "web-session-api",
      surfaceId: "example-social",
      authKinds: ["cookie-source"],
    };
    const auth: WrenchAuth = {
      schemaVersion: 1,
      id: "example-profile",
      kind: "cookies-file",
      path: "/private/cookies.json",
    };

    expect(() => requireProviderPluginAuth(binding, auth))
      .toThrow("does not accept cookies-file auth");
  });
});
