import type { WrenchAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import type { WebSessionRecipe } from "./model";

export const PUBLIC_WEB_SESSION_AUTHORITY_KIND = "public-web-session";

/**
 * Kernel-owned authority for a reviewed operation that is deliberately public.
 * It is an invocation/cache coordinate, never an auth locator or credential.
 */
export type PublicWebSessionInvocationAuthority = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: typeof PUBLIC_WEB_SESSION_AUTHORITY_KIND;
  readonly subject: string;
};

export type InvocationAuthority = WrenchAuth | PublicWebSessionInvocationAuthority;

export type WebSessionAuthenticationPolicy =
  | { readonly kind: "required" }
  | {
      readonly kind: "public";
      readonly authority: PublicWebSessionInvocationAuthority;
    };

export type WebSessionAuthenticationPolicyContext = {
  readonly adapterId: string;
  readonly access?: "public";
  readonly operationId: string;
  readonly recipe: WebSessionRecipe;
  readonly pluginSourceKind: "built-in" | "source" | "portable";
  readonly portable: boolean;
  readonly risk: "R1" | "R2" | "R3" | "R4";
  readonly state: "observed" | "capture-required";
  readonly dispatch: "none" | "single" | "thread-items" | "bounded-items";
};

const requiredPolicy = Object.freeze({ kind: "required" as const });

export function publicWebSessionInvocationAuthority(
  adapterId: string,
  operationId: string,
): PublicWebSessionInvocationAuthority {
  const coordinate = Object.freeze({
    adapter: adapterId,
    operation: operationId,
  });
  return Object.freeze({
    schemaVersion: 1,
    id: `public-${sha256(canonicalJson(coordinate)).slice(0, 32)}`,
    kind: PUBLIC_WEB_SESSION_AUTHORITY_KIND,
    subject: `public:${adapterId}:${operationId}`,
  });
}

/**
 * Authentication policy is code-owned. Manifests and portable plugins cannot
 * opt into public execution by declaring data that resembles this route.
 */
export function webSessionAuthenticationPolicy(
  context: WebSessionAuthenticationPolicyContext,
): WebSessionAuthenticationPolicy {
  if (context.access === "public") {
    if (
      context.pluginSourceKind !== "built-in"
      || context.portable
      || context.risk !== "R1"
      || context.state !== "observed"
      || context.dispatch !== "none"
    ) {
      throw new Error(
        "public web-session access requires an observed dispatch-free built-in R1 operation",
      );
    }
    return Object.freeze({
      kind: "public" as const,
      authority: publicWebSessionInvocationAuthority(
        context.adapterId,
        context.operationId,
      ),
    });
  }
  return requiredPolicy;
}

export function isPublicWebSessionInvocationAuthority(
  value: InvocationAuthority,
): value is PublicWebSessionInvocationAuthority {
  return value.kind === PUBLIC_WEB_SESSION_AUTHORITY_KIND;
}

export function parsePublicWebSessionInvocationAuthority(
  value: unknown,
  expected: PublicWebSessionInvocationAuthority,
): PublicWebSessionInvocationAuthority {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) throw new Error("public web-session invocation authority must be an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 4
    || keys[0] !== "id"
    || keys[1] !== "kind"
    || keys[2] !== "schemaVersion"
    || keys[3] !== "subject"
    || record.schemaVersion !== 1
    || record.id !== expected.id
    || record.kind !== expected.kind
    || record.subject !== expected.subject
  ) {
    throw new Error("public web-session invocation authority is malformed");
  }
  return expected;
}

export function publicWebSessionAuthorityIdentityHash(
  authority: PublicWebSessionInvocationAuthority,
): string {
  return sha256(
    `wrench-public-web-session-authority-v1\0${canonicalJson(authority)}`,
  );
}

export function persistedAuthAuthority(
  authority: InvocationAuthority,
  message = "operation requires a persisted auth locator",
): WrenchAuth {
  if (isPublicWebSessionInvocationAuthority(authority)) {
    throw new Error(message);
  }
  return authority;
}
