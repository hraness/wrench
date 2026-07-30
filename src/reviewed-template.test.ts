import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "./auth";
import type {
  OperationInput,
  ReviewedTemplateRecipe,
  WrenchManifest,
} from "./model";
import {
  executeReviewedTemplateOperation,
  planReviewedTemplateDispatches,
} from "./reviewed-template";
import type { WebSessionHttpDependencies } from "./web-session-http";

const auth = {
  schemaVersion: 1,
  id: "example",
  kind: "cookie-source",
  source: "arc",
  profile: "Default",
} as const satisfies WrenchAuth;

const input = { target_id: "target-1", body: "hello" } as const satisfies OperationInput;

function recipe(
  write: boolean,
  method: "GET" | "DELETE" | "POST" = write ? "POST" : "GET",
): Extract<ReviewedTemplateRecipe, { readonly state: "reviewed" }> {
  return {
    state: "reviewed",
    contractVersion: 1,
    reviewedAt: "2026-07-22T12:00:00.000Z",
    evidenceSha256: "a".repeat(64),
    timeoutMs: 30_000,
    template: {
      schemaVersion: 1,
      origin: "https://example.com",
      request: {
        method,
        path: [
          { kind: "literal", value: "api" },
          { kind: "literal", value: "targets" },
          { kind: "input", name: "target_id", valueType: "string" },
        ],
        query: [],
        headers: [{ name: "accept", value: { kind: "literal", value: "application/json" } }],
        body: write
          ? {
              kind: "json",
              value: {
                kind: "object",
                entries: [{ name: "body", value: { kind: "input", name: "body", valueType: "string" } }],
              },
            }
          : { kind: "none" },
      },
      response: {
        maxBytes: 65_536,
        variants: [{
          status: 200,
          contentType: "application/json",
          body: {
            kind: "json",
            projections: [{
              name: "id",
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "id" }],
              valueType: "string",
              required: true,
            }],
            bindings: write
              ? [{
                  path: [{ kind: "key", key: "data" }, { kind: "key", key: "target" }],
                  expected: { kind: "input", name: "target_id", valueType: "string" },
                }]
              : [],
          },
        }],
      },
    },
  };
}

function manifest(write: boolean, reviewedRecipe = recipe(write)): WrenchManifest {
  const operationId = write ? "messaging.send" : "content.read";
  return {
    schemaVersion: 5,
    id: "example-api",
    version: "1.0.0",
    displayName: "Example API",
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: {
      [operationId]: {
        description: write ? "Send one message" : "Read one target",
        risk: write ? "R3" : "R1",
        sideEffect: write ? "Sends one externally visible message" : "none",
        idempotency: write ? "local-at-most-once" : "none",
        dedupeWindowMs: write ? 86_400_000 : 0,
        input: {
          properties: {
            target_id: { type: "string", description: "Target", minLength: 1, maxLength: 128 },
            body: { type: "string", description: "Body", minLength: 1, maxLength: 2_000 },
          },
          required: write ? ["target_id", "body"] : ["target_id"],
        },
        reviewedTemplate: reviewedRecipe,
      },
    },
  };
}

function dependencies(calls: { cookieAcquisitions: number; fetches: number }): Partial<WebSessionHttpDependencies> {
  return {
    acquireCookies: () => {
      calls.cookieAcquisitions += 1;
      return Promise.resolve({ cookies: [], warnings: [] });
    },
    fetch: () => {
      calls.fetches += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
}

describe("reviewed authenticated template execution", () => {
  test("rejects reviewed v1 GET and DELETE requests before cookie acquisition or dispatch", () => {
    for (const method of ["GET", "DELETE"] as const) {
      const reviewed = recipe(false, method);
      const calls = { cookieAcquisitions: 0, fetches: 0 };
      expect(() => planReviewedTemplateDispatches("content.read", "R1", reviewed))
        .toThrow("contractVersion 2 provides a current-account identity preflight");
      expect(executeReviewedTemplateOperation(
        manifest(false, reviewed),
        "content.read",
        reviewed,
        input,
        auth,
        { dependencies: dependencies(calls) },
      )).rejects.toThrow("contractVersion 2 provides a current-account identity preflight");
      expect(calls).toEqual({ cookieAcquisitions: 0, fetches: 0 });
    }
  });

  test("rejects reviewed R2/R3 templates before any authenticated request", () => {
    const calls = { cookieAcquisitions: 0, fetches: 0 };
    expect(executeReviewedTemplateOperation(
      manifest(true),
      "messaging.send",
      recipe(true),
      input,
      auth,
      { dependencies: dependencies(calls) },
    )).rejects.toThrow("contractVersion 2 provides a current-account identity preflight");
    expect(calls).toEqual({ cookieAcquisitions: 0, fetches: 0 });
  });

  test("never plans or executes capture-required state", () => {
    const captureRequired = {
      state: "capture-required",
      contractVersion: 1,
      instructions: "review first",
    } as const satisfies ReviewedTemplateRecipe;
    const calls = { cookieAcquisitions: 0, fetches: 0 };
    expect(executeReviewedTemplateOperation(
      manifest(false),
      "content.read",
      captureRequired,
      input,
      auth,
      { dependencies: dependencies(calls) },
    )).rejects.toThrow("capture-required");
    expect(() => planReviewedTemplateDispatches("content.read", "R1", captureRequired)).toThrow("capture-required");
    expect(calls).toEqual({ cookieAcquisitions: 0, fetches: 0 });
  });
});
