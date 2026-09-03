import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WrenchManifest } from "./model";
import { providerPluginRegistry } from "./provider-plugins";
import { prepareInvocation } from "./runtime";
import { installManifest } from "./storage";
import {
  isPublicWebSessionInvocationAuthority,
  publicWebSessionAuthorityIdentityHash,
} from "./web-session-authentication-policy";

describe("Clasificados public listings.search invocation", () => {
  test("prepares the reviewed public descriptor without an auth locator", () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-public-clasificados-"));
    const environment = { WRENCH_STATE_HOME: directory } as const;
    try {
      const manifest = JSON.parse(readFileSync(join(
        import.meta.dir,
        "assets",
        "adapters",
        "clasificados",
        "wrench-web-adapter.json",
      ), "utf8")) as WrenchManifest;
      installManifest(manifest, {
        force: false,
        environment,
        registry: providerPluginRegistry,
      });
      const invocation = prepareInvocation(
        "clasificados-web",
        "listings.search",
        { location: "San Juan, PR", beds_min: 2, max_price: 5500 },
        undefined,
        environment,
        providerPluginRegistry,
      );
      expect(isPublicWebSessionInvocationAuthority(invocation.auth)).toBeTrue();
      if (!isPublicWebSessionInvocationAuthority(invocation.auth)) {
        throw new Error("expected public authority");
      }
      expect(invocation.auth.subject).toBe("public:clasificados-web:listings.search");
      expect(invocation.readProjectionAuthIdentityHash).toBe(
        publicWebSessionAuthorityIdentityHash(invocation.auth),
      );
      expect(invocation.input).toEqual({
        location: "San Juan, PR",
        beds_min: 2,
        max_price: 5500,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
