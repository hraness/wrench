import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  authContextSha256,
  createDirectHttpMetadata,
  identityDirectorySegment,
  isPortableIdentityDirectorySegment,
  opaqueYtDlpSourceAssetKey,
  parseProbeMetadata,
  providerIdentitySha256,
  renderProviderMetadataJson,
  requestedUrlSha256,
  sourceAssetKey,
  sourceExtractorDirectory,
  sourceItemDirectory,
} from "./metadata";

const sha256Arbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
  (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
);

test("property: identity segments are always one safe path component", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const segment = identityDirectorySegment(value, "item");
      expect(segment).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
      expect(segment).not.toBe(".");
      expect(segment).not.toBe("..");
      expect(segment).not.toContain("/");
      expect(segment).not.toContain("\\");
    }),
    { numRuns: 300 },
  );
});

test("property: canonical source paths are portable and raw-identity-sensitive", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 256 }), fc.string({ maxLength: 256 }), (extractor, id) => {
      expect(isPortableIdentityDirectorySegment(sourceExtractorDirectory(extractor))).toBeTrue();
      expect(isPortableIdentityDirectorySegment(sourceItemDirectory(id))).toBeTrue();
      expect(sourceAssetKey(extractor, id)).toMatch(/^source-v1-[0-9a-f]{64}$/u);
    }),
    { numRuns: 300 },
  );
});

test("property: distinct bounded source tuples have distinct owned identities", () => {
  const tuple = fc.tuple(
    fc.string({ maxLength: 64 }),
    fc.string({ maxLength: 64 }),
  );
  fc.assert(
    fc.property(tuple, tuple, (left, right) => {
      fc.pre(left[0] !== right[0] || left[1] !== right[1]);
      expect(sourceAssetKey(left[0], left[1])).not.toBe(sourceAssetKey(right[0], right[1]));
      if (left[0] === right[0]) {
        expect(sourceItemDirectory(left[1])).not.toBe(sourceItemDirectory(right[1]));
      }
    }),
    { numRuns: 300 },
  );
});

test("property: arbitrary probe values never throw", () => {
  fc.assert(
    fc.property(fc.anything({ maxDepth: 3, maxKeys: 12 }), (value) => {
      expect(() => parseProbeMetadata(value, "https://example.com/item")).not.toThrow();
    }),
    { numRuns: 200 },
  );
});

test("property: generic canonical URLs never retain arbitrary query values", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 256 }), fc.string({ maxLength: 256 }), (key, value) => {
      const url = new URL("https://example.com/item");
      url.searchParams.set(key, value);
      const parsed = parseProbeMetadata(
        { id: "item", extractor: "generic", webpage_url: url.href },
        url.href,
      );
      expect(parsed).toMatchObject({
        ok: true,
        metadata: { canonicalUrl: "https://example.com/" },
      });
    }),
    { numRuns: 200 },
  );
});

const opaqueToken = fc.string({
  unit: fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  ),
  minLength: 8,
  maxLength: 48,
});

test("property: distinct opaque acquisition tuples retain collision-resistant projected identities", () => {
  fc.assert(
    fc.property(opaqueToken, opaqueToken, opaqueToken, opaqueToken, (leftExtractor, leftId, rightExtractor, rightId) => {
      fc.pre(leftExtractor !== rightExtractor || leftId !== rightId);
      const parse = (extractor: string, id: string) => parseProbeMetadata(
        { extractor: `Adapter-${extractor}`, id: `RAW-ID-${id}`, webpage_url: "https://example.com/item" },
        "https://example.com/item",
      );
      const left = parse(leftExtractor, leftId);
      const right = parse(rightExtractor, rightId);
      if (!left.ok || !right.ok) throw new Error("bounded opaque fixture did not parse");
      expect(left.metadata.extractor).toBe("External");
      expect(right.metadata.extractor).toBe("External");
      expect(left.metadata.extractorDirectory).toBe(right.metadata.extractorDirectory);
      expect(left.metadata.assetKey).not.toBe(right.metadata.assetKey);
      expect(left.metadata.id).not.toBe(right.metadata.id);
      expect(left.metadata.itemDirectory).not.toBe(right.metadata.itemDirectory);
    }),
    { numRuns: 300 },
  );
});

test("property: opaque yt-dlp URL identity is stable, fragment-invariant, and path/query-sensitive", () => {
  fc.assert(
    fc.property(opaqueToken, opaqueToken, opaqueToken, (path, query, fragment) => {
      const build = (url: string) => parseProbeMetadata(
        { extractor_key: "Generic", id: "index", webpage_url: url },
        url,
      );
      const base = new URL(`https://example.com/${path}`);
      base.searchParams.set("token", query);
      const repeated = build(base.href);
      const withFragment = new URL(base);
      withFragment.hash = fragment;
      const fragmentResult = build(withFragment.href);
      const changedPath = new URL(base);
      changedPath.pathname = `/${path}-changed`;
      const pathResult = build(changedPath.href);
      const changedQuery = new URL(base);
      changedQuery.searchParams.set("token", `${query}-changed`);
      const queryResult = build(changedQuery.href);
      if (!repeated.ok || !fragmentResult.ok || !pathResult.ok || !queryResult.ok) {
        throw new Error("bounded opaque URL fixture did not parse");
      }
      expect(repeated.metadata.assetKey).toBe(fragmentResult.metadata.assetKey);
      expect(repeated.metadata.assetKey).not.toBe(pathResult.metadata.assetKey);
      expect(repeated.metadata.assetKey).not.toBe(queryResult.metadata.assetKey);
      expect(repeated.metadata.id).toMatch(/^opaque-v2-[0-9a-f]{64}$/u);
      const identity = repeated.metadata.opaqueYtDlpIdentity;
      if (identity === undefined) throw new Error("opaque identity provenance is missing");
      expect(identity.providerIdentitySha256).toBe(providerIdentitySha256("Generic", "index"));
      expect(identity.requestedUrlSha256).toBe(requestedUrlSha256(base.href));
      expect(repeated.metadata.assetKey).toBe(opaqueYtDlpSourceAssetKey(identity));
    }),
    { numRuns: 300 },
  );
});

test("property: private source identity separates access mode, context, and request URL", () => {
  fc.assert(
    fc.property(opaqueToken, opaqueToken, opaqueToken, (leftContext, rightContext, path) => {
      fc.pre(leftContext.toLowerCase() !== rightContext.toLowerCase());
      const url = `https://example.com/${path}?token=private`;
      const parse = (
        mode: "browser" | "ambient_config",
        context: string,
        requestUrl = url,
      ) => parseProbeMetadata(
        { extractor_key: "Generic", id: "index", webpage_url: requestUrl },
        requestUrl,
        { mode, contextSha256: authContextSha256(context) },
      );
      const left = parse("browser", leftContext);
      const repeated = parse("browser", leftContext);
      const right = parse("browser", rightContext);
      const ambient = parse("ambient_config", leftContext);
      const changedUrl = parse("browser", leftContext, `${url}-changed`);
      if (!left.ok || !repeated.ok || !right.ok || !ambient.ok || !changedUrl.ok) {
        throw new Error("bounded private identity fixture did not parse");
      }
      expect(left.metadata.assetKey).toBe(repeated.metadata.assetKey);
      expect(left.metadata.assetKey).not.toBe(right.metadata.assetKey);
      expect(left.metadata.assetKey).not.toBe(ambient.metadata.assetKey);
      expect(left.metadata.assetKey).not.toBe(changedUrl.metadata.assetKey);
      expect(left.metadata.id).toMatch(/^opaque-v3-[0-9a-f]{64}$/u);
      expect(left.metadata.projection).toBe("opaque");
    }),
    { numRuns: 300 },
  );
});

test("property: arbitrary Unicode probe tuples are total and distinct accepted tuples do not alias", () => {
  const boundedIdentity = fc.string({ minLength: 1, maxLength: 64 });
  fc.assert(
    fc.property(
      boundedIdentity,
      boundedIdentity,
      boundedIdentity,
      boundedIdentity,
      (leftExtractor, leftId, rightExtractor, rightId) => {
        const parse = (extractor: string, id: string) => parseProbeMetadata(
          { extractor, id, webpage_url: "https://example.com/item" },
          "https://example.com/item",
        );
        expect(() => parse(leftExtractor, leftId)).not.toThrow();
        expect(() => parse(rightExtractor, rightId)).not.toThrow();
        const left = parse(leftExtractor, leftId);
        const right = parse(rightExtractor, rightId);
        if (
          left.ok
          && right.ok
          && (leftExtractor !== rightExtractor || leftId !== rightId)
        ) {
          expect(left.metadata.assetKey).not.toBe(right.metadata.assetKey);
          expect(left.metadata.id).not.toBe(right.metadata.id);
          expect(left.metadata.itemDirectory).not.toBe(right.metadata.itemDirectory);
        }
      },
    ),
    { numRuns: 300 },
  );
});

test("property: direct HTTP identity changes with either request or body digest", () => {
  fc.assert(
    fc.property(
      sha256Arbitrary,
      sha256Arbitrary,
      sha256Arbitrary,
      sha256Arbitrary,
      (leftUrl, leftBody, rightUrl, rightBody) => {
        fc.pre(leftUrl !== rightUrl || leftBody !== rightBody);
        const build = (requestedUrlSha256: string, bodySha256: string) =>
          createDirectHttpMetadata({
            requestedOrigin: "https://example.com/",
            requestedUrlSha256,
            bodySha256,
          });
        const left = build(leftUrl, leftBody);
        const right = build(rightUrl, rightBody);
        expect(left.assetKey).not.toBe(right.assetKey);
        expect(left.id).not.toBe(right.id);
        expect(left.itemDirectory).not.toBe(right.itemDirectory);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: opaque raw identity and descriptive markers never enter persisted metadata or paths", () => {
  fc.assert(
    fc.property(opaqueToken, (token) => {
      const extractor = `PrivateAdapter-${token}`;
      const id = `RAW-ID-${token}`;
      const title = `PrivateTitle-${token}`;
      const parsed = parseProbeMetadata(
        { extractor, id, title, webpage_url: `https://example.com/${id}` },
        `https://example.com/${id}`,
      );
      if (!parsed.ok) throw new Error(parsed.message);
      const persisted = [
        parsed.metadata.extractorDirectory,
        parsed.metadata.itemDirectory,
        renderProviderMetadataJson(parsed.metadata),
      ].join("\n");
      for (const marker of [extractor, id, title]) expect(persisted).not.toContain(marker);
    }),
    { numRuns: 300 },
  );
});
