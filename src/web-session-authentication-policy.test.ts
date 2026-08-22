import { describe, expect, test } from "bun:test";

import {
  parsePublicWebSessionInvocationAuthority,
  publicWebSessionAuthorityIdentityHash,
  publicWebSessionInvocationAuthority,
  webSessionAuthenticationPolicy,
} from "./web-session-authentication-policy";

const publicContext = {
  adapterId: "bluesky-web",
  access: "public" as const,
  operationId: "profiles.read",
  recipe: {
    site: "bluesky",
    action: "profiles.read",
    contractVersion: 2,
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  },
  pluginSourceKind: "built-in" as const,
  portable: false,
  risk: "R1" as const,
  state: "observed" as const,
  dispatch: "none" as const,
};

describe("web-session authentication policy", () => {
  test("derives one deterministic strict public authority from a trusted descriptor", () => {
    const first = webSessionAuthenticationPolicy(publicContext);
    const second = webSessionAuthenticationPolicy({ ...publicContext });
    expect(first).toEqual(second);
    if (first.kind !== "public" || second.kind !== "public") {
      throw new Error("expected public policy");
    }
    expect(first.authority.id).toMatch(/^public-[a-f0-9]{32}$/u);
    expect(first.authority.subject).toBe(
      "public:bluesky-web:profiles.read",
    );
    expect(publicWebSessionAuthorityIdentityHash(first.authority))
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(parsePublicWebSessionInvocationAuthority(
      first.authority,
      second.authority,
    )).toEqual(first.authority);
    expect(() => parsePublicWebSessionInvocationAuthority(
      { ...first.authority, subject: "public:switched:profiles.read" },
      first.authority,
    )).toThrow("malformed");
    expect(() => parsePublicWebSessionInvocationAuthority(
      { ...first.authority, extra: true },
      first.authority,
    )).toThrow("malformed");
  });

  test("defaults to required and rejects public access outside trusted built-ins", () => {
    const { access: _access, ...requiredContext } = publicContext;
    expect(webSessionAuthenticationPolicy({
      ...requiredContext,
    })).toEqual({ kind: "required" });
    for (const invalid of [
      { pluginSourceKind: "source" as const },
      { pluginSourceKind: "portable" as const, portable: true },
      { risk: "R2" as const },
      { state: "capture-required" as const },
      { dispatch: "single" as const },
    ]) {
      expect(() => webSessionAuthenticationPolicy({
        ...publicContext,
        ...invalid,
      })).toThrow("observed dispatch-free built-in R1");
    }
  });

  test("keeps authority coordinates operation-bound", () => {
    expect(publicWebSessionInvocationAuthority(
      "bluesky-web",
      "profiles.read",
    )).not.toEqual(publicWebSessionInvocationAuthority(
      "bluesky-web",
      "posts.read",
    ));
  });
});
