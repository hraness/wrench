import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  negotiateDocumentRepresentation,
  notAcceptableBody,
  parseAcceptMediaRanges,
} from "./content-negotiation";

describe("document Accept negotiation", () => {
  test("serves HTML when Accept is absent, empty, or unrestricted", () => {
    expect(negotiateDocumentRepresentation(null)).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("*/*")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("text/*")).toEqual({ kind: "html" });
  });

  test("honors q-values, specificity, client order, and q=0", () => {
    expect(negotiateDocumentRepresentation("text/markdown")).toEqual({ kind: "markdown" });
    expect(negotiateDocumentRepresentation("text/html")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("text/markdown, text/html")).toEqual({
      kind: "markdown",
    });
    expect(negotiateDocumentRepresentation("text/html, text/markdown")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("text/markdown;q=0.8, text/html;q=0.9")).toEqual({
      kind: "html",
    });
    expect(negotiateDocumentRepresentation("text/html;q=0.1, text/markdown;q=1")).toEqual({
      kind: "markdown",
    });
    expect(negotiateDocumentRepresentation("text/html;q=0, text/markdown")).toEqual({
      kind: "markdown",
    });
    expect(negotiateDocumentRepresentation("text/html;q=0, */*")).toEqual({ kind: "markdown" });
    expect(negotiateDocumentRepresentation("text/markdown;charset=utf-8")).toEqual({
      kind: "markdown",
    });
  });

  test("returns 406 only when every owned representation is rejected", () => {
    expect(negotiateDocumentRepresentation("application/pdf")).toEqual({
      accept: "application/pdf",
      kind: "not-acceptable",
    });
    expect(negotiateDocumentRepresentation("text/markdown;q=0, text/html;q=0")).toEqual({
      accept: "text/markdown;q=0, text/html;q=0",
      kind: "not-acceptable",
    });
    expect(notAcceptableBody("application/pdf")).toContain("- text/html");
    expect(notAcceptableBody("application/pdf")).toContain("- text/markdown");
    expect(notAcceptableBody("application/pdf")).toContain("You requested: application/pdf");
  });

  test("property: arbitrary Accept values stay inside the documented decision set", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (header) => {
        const decision = negotiateDocumentRepresentation(header);
        expect(["html", "markdown", "not-acceptable"]).toContain(decision.kind);
        if (decision.kind === "not-acceptable") {
          expect(decision.accept).toBe(header ?? "");
          expect(parseAcceptMediaRanges(header).some((range) => range.q > 0 && (
            (range.type === "*" && range.subtype === "*")
            || (range.type === "text" && (range.subtype === "*" || range.subtype === "html" || range.subtype === "markdown"))
          ))).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
