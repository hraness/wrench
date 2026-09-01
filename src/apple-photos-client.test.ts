import { describe, expect, test } from "bun:test";

import { exportApplePhotosContactEvidenceSync } from "./apple-photos-client";

describe("Apple Photos public client", () => {
  test("rejects arbitrary paths and foreign request fields before spawning", () => {
    for (const request of [
      { library: "relative.photoslibrary" },
      { library: "/private/tmp/Photos.sqlite" },
      { library: "/private/tmp/../tmp/Photos.photoslibrary" },
      { library: "/private/tmp/Photos.photoslibrary", sql: "SELECT *" },
    ]) {
      expect(() => exportApplePhotosContactEvidenceSync(request as never)).toThrow(
        "Wrench Apple Photos client",
      );
    }
  });

  test("rejects accessor and proxy requests before spawning", () => {
    const accessor = Object.defineProperty({}, "library", {
      enumerable: true,
      get: () => "/private/tmp/Photos.photoslibrary",
    });
    expect(() => exportApplePhotosContactEvidenceSync(accessor)).toThrow(
      "enumerable data properties",
    );
    expect(() => exportApplePhotosContactEvidenceSync(new Proxy({}, {}))).toThrow(
      "plain, non-proxy object",
    );
  });
});
