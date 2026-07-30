import { describe, expect, test } from "bun:test";
import {
  AUTH_CONTEXT_IDENTITY_PROFILE,
  authenticatedYtDlpSourceAssetKey,
  authenticatedYtDlpSourceId,
  authContextSha256,
  createDirectHttpMetadata,
  createProviderMetadataDocument,
  identityDirectorySegment,
  isNormalizedProbeMetadata,
  isPortableIdentityDirectorySegment,
  opaqueYtDlpSourceAssetKey,
  opaqueYtDlpSourceId,
  parseProbeMetadata,
  providerIdentitySha256,
  renderProviderMetadataJson,
  requestedUrlSha256,
  selectCaption,
  sourceAssetKey,
  sourceExtractorDirectory,
  sourceItemDirectory,
  YT_DLP_AUTH_IDENTITY_PROFILE,
} from "./metadata";

describe("parseProbeMetadata", () => {
  test("allowlists identity and caption availability", () => {
    const result = parseProbeMetadata(
      {
        id: "abc123DEF45",
        extractor_key: "Youtube",
        webpage_url: "https://www.youtube.com/watch?v=abc123DEF45",
        title: "A title",
        subtitles: { "pt-BR": [{}], en: [{}], live_chat: [{}] },
        automatic_captions: { fr: [{}] },
        formats: [{ url: "https://signed.example/secret" }],
      },
      "https://www.youtube.com/watch?v=abc123DEF45",
    );
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        id: "abc123DEF45",
        extractorDirectory: sourceExtractorDirectory("Youtube"),
        itemDirectory: sourceItemDirectory("abc123DEF45"),
        assetKey: sourceAssetKey("Youtube", "abc123DEF45"),
        manualCaptionLanguages: ["en", "pt-BR"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("signed.example");
  });

  test("hashes unsafe provider identities instead of making paths from them", () => {
    expect(identityDirectorySegment("../../private", "item")).toMatch(/^item-[0-9a-f]{24}$/u);
    expect(identityDirectorySegment("safe_ID-1", "item")).toBe("safe_ID-1");
  });

  test("makes source paths portable across case-folding and Windows filesystems", () => {
    expect(sourceItemDirectory("AbC")).not.toBe(sourceItemDirectory("abc"));
    expect(sourceItemDirectory("ＡＢＣ")).not.toBe(sourceItemDirectory("ABC"));
    expect(sourceExtractorDirectory("Youtube")).not.toBe(sourceExtractorDirectory("youtube"));
    for (const segment of [
      sourceItemDirectory("CON"),
      sourceItemDirectory("item."),
      sourceExtractorDirectory("NUL"),
    ]) {
      expect(isPortableIdentityDirectorySegment(segment)).toBeTrue();
    }
    expect(isPortableIdentityDirectorySegment("CON")).toBeFalse();
    expect(isPortableIdentityDirectorySegment("aux.txt")).toBeFalse();
    expect(isPortableIdentityDirectorySegment("item.")).toBeFalse();
  });

  test("domain-separates and length-prefixes raw source tuples", () => {
    expect(sourceAssetKey("a-b", "c")).not.toBe(sourceAssetKey("a", "b-c"));
    expect(sourceAssetKey("A+B", "same")).not.toBe(sourceAssetKey("A B", "same"));
    expect(sourceAssetKey("Youtube", "AbC")).not.toBe(sourceAssetKey("Youtube", "abc"));
  });

  test("creates a content-qualified direct HTTP identity from hashes and an origin only", () => {
    const requestedUrlSha256 = "1".repeat(64);
    const bodySha256 = "2".repeat(64);
    const metadata = createDirectHttpMetadata({
      requestedOrigin: "https://media.example/",
      requestedUrlSha256,
      bodySha256,
    });
    expect(metadata).toMatchObject({
      projection: "opaque",
      extractor: "External",
      canonicalUrl: "https://media.example/",
      acquisitionIdentity: {
        extractor: "DirectHttp",
      },
      manualCaptionLanguages: [],
      automaticCaptionLanguages: [],
    });
    expect(metadata.acquisitionIdentity.id).toMatch(/^direct-http-v1-[0-9a-f]{64}$/u);
    expect(metadata.id).toMatch(/^opaque-v1-[0-9a-f]{64}$/u);
    expect(isNormalizedProbeMetadata(metadata)).toBeTrue();
    const persisted = renderProviderMetadataJson(metadata);
    expect(persisted).not.toContain(requestedUrlSha256);
    expect(persisted).not.toContain(bodySha256);

    const changedBody = createDirectHttpMetadata({
      requestedOrigin: "https://media.example/",
      requestedUrlSha256,
      bodySha256: "3".repeat(64),
    });
    expect(changedBody.assetKey).not.toBe(metadata.assetKey);
    expect(changedBody.itemDirectory).not.toBe(metadata.itemDirectory);
  });

  test("rejects raw paths and malformed hashes at the direct HTTP metadata boundary", () => {
    expect(() => createDirectHttpMetadata({
      requestedOrigin: "https://media.example/private/file.mp4?token=secret",
      requestedUrlSha256: "1".repeat(64),
      bodySha256: "2".repeat(64),
    })).toThrow("direct HTTP identity is malformed");
    expect(() => createDirectHttpMetadata({
      requestedOrigin: "https://media.example/",
      requestedUrlSha256: "not-a-hash",
      bodySha256: "2".repeat(64),
    })).toThrow("direct HTTP identity is malformed");
  });

  test("keeps exact opaque acquisition code units only in the in-memory identity", () => {
    const spaced = parseProbeMetadata(
      {
        id: " abc ",
        extractor_key: " Generic ",
        webpage_url: "https://example.com/item",
      },
      "https://example.com/item",
    );
    expect(spaced).toMatchObject({
      ok: true,
      metadata: {
        acquisitionIdentity: { id: " abc ", extractor: " Generic " },
        projection: "opaque",
        extractor: "External",
      },
    });
    if (!spaced.ok) throw new Error(spaced.message);
    expect(spaced.metadata.id).toMatch(/^opaque-v2-[0-9a-f]{64}$/u);
    const identity = spaced.metadata.opaqueYtDlpIdentity;
    if (identity === undefined) throw new Error("opaque yt-dlp identity is missing");
    expect(identity).toEqual({
      profile: "yt-dlp-opaque-url-v1",
      providerIdentitySha256: providerIdentitySha256(" Generic ", " abc "),
      requestedUrlSha256: requestedUrlSha256("https://example.com/item"),
    });
    expect(spaced.metadata.assetKey).toBe(opaqueYtDlpSourceAssetKey(identity));
    expect(spaced.metadata.id).toBe(opaqueYtDlpSourceId(spaced.metadata.assetKey));
    expect(spaced.metadata.assetKey).not.toBe(sourceAssetKey(" Generic ", " abc "));

    for (const id of ["bad\u0085id", "bad\ud800id"]) {
      expect(parseProbeMetadata(
        { id, extractor: "generic", webpage_url: "https://example.com/item" },
        "https://example.com/item",
      )).toMatchObject({ ok: false });
    }
  });

  test("rejects malformed or credential-bearing canonical URLs", () => {
    expect(parseProbeMetadata({ id: "x", extractor: "web", webpage_url: "file:///x" }, "file:///x")).toEqual({
      ok: false,
      kind: "invalid",
      message: "yt-dlp probe is missing a safe canonical URL",
    });
  });

  test("qualifies opaque yt-dlp identity by the exact fragment-free request URL", () => {
    const parse = (url: string) => parseProbeMetadata(
      { id: "index", extractor_key: "Generic", webpage_url: url },
      url,
    );
    const hls = parse("https://media.example/hls/index.m3u8?token=one#player");
    const hlsRepeat = parse("https://media.example/hls/index.m3u8?token=one#other");
    const dash = parse("https://media.example/dash/index.mpd?token=one");
    const queryChange = parse("https://media.example/hls/index.m3u8?token=two");
    if (!hls.ok || !hlsRepeat.ok || !dash.ok || !queryChange.ok) {
      throw new Error("opaque URL-qualified fixtures did not parse");
    }
    expect(hls.metadata.assetKey).toBe(hlsRepeat.metadata.assetKey);
    expect(hls.metadata.id).toBe(hlsRepeat.metadata.id);
    expect(hls.metadata.assetKey).not.toBe(dash.metadata.assetKey);
    expect(hls.metadata.assetKey).not.toBe(queryChange.metadata.assetKey);
    expect(hls.metadata.itemDirectory).not.toBe(dash.metadata.itemDirectory);
    for (const metadata of [hls.metadata, dash.metadata, queryChange.metadata]) {
      const persisted = renderProviderMetadataJson(metadata);
      for (const token of ["hls", "dash", "index.m3u8", "index.mpd", "token=", "one", "two"]) {
        expect(persisted).not.toContain(token);
      }
    }
  });

  test("projects every private access realm into a disjoint opaque identity", () => {
    const raw = {
      id: "abc123DEF45",
      extractor_key: "Youtube",
      webpage_url: "https://www.youtube.com/watch?v=abc123DEF45&token=secret",
      title: "Private title",
      description: "Private description",
      subtitles: { en: [{}] },
    };
    const personalDigest = authContextSha256("Personal");
    expect(personalDigest).toBe(authContextSha256("personal"));
    const browser = parseProbeMetadata(
      raw,
      raw.webpage_url,
      { mode: "browser", contextSha256: personalDigest },
    );
    const ambient = parseProbeMetadata(
      raw,
      raw.webpage_url,
      { mode: "ambient_config", contextSha256: personalDigest },
    );
    const work = parseProbeMetadata(
      raw,
      raw.webpage_url,
      { mode: "browser", contextSha256: authContextSha256("work") },
    );
    const publicResult = parseProbeMetadata(raw, raw.webpage_url);
    if (!browser.ok || !ambient.ok || !work.ok || !publicResult.ok) {
      throw new Error("authorization identity fixture did not parse");
    }
    expect(browser.metadata).toMatchObject({
      projection: "opaque",
      extractor: "External",
      canonicalUrl: "https://www.youtube.com/",
    });
    expect(browser.metadata.id).toMatch(/^opaque-v3-[0-9a-f]{64}$/u);
    expect(browser.metadata.title).toBeUndefined();
    expect(browser.metadata.description).toBeUndefined();
    const identity = browser.metadata.authenticatedYtDlpIdentity;
    if (identity === undefined) throw new Error("authenticated identity is missing");
    expect(identity).toEqual({
      profile: YT_DLP_AUTH_IDENTITY_PROFILE,
      providerIdentitySha256: providerIdentitySha256("Youtube", "abc123DEF45"),
      requestedUrlSha256: requestedUrlSha256(raw.webpage_url),
      accessMode: "browser",
      authContext: {
        profile: AUTH_CONTEXT_IDENTITY_PROFILE,
        sha256: personalDigest,
      },
    });
    expect(browser.metadata.assetKey).toBe(authenticatedYtDlpSourceAssetKey(identity));
    expect(browser.metadata.id).toBe(authenticatedYtDlpSourceId(browser.metadata.assetKey));
    expect(browser.metadata.assetKey).not.toBe(ambient.metadata.assetKey);
    expect(browser.metadata.assetKey).not.toBe(work.metadata.assetKey);
    expect(browser.metadata.assetKey).not.toBe(publicResult.metadata.assetKey);
    const persisted = renderProviderMetadataJson(browser.metadata);
    for (const token of [
      "Personal",
      "personal",
      "Private title",
      "Private description",
      "watch?v=",
      "token=secret",
    ]) {
      expect(persisted).not.toContain(token);
    }
    expect(isNormalizedProbeMetadata(browser.metadata)).toBeTrue();
  });

  test("rejects malformed authorization identity inputs before projection", () => {
    expect(parseProbeMetadata(
      { id: "item", extractor: "Generic", webpage_url: "https://example.com/item" },
      "https://example.com/item",
      { mode: "browser", contextSha256: "not-a-hash" },
    )).toEqual({
      ok: false,
      kind: "invalid",
      message: "yt-dlp authorization identity is malformed",
    });
    expect(() => authContextSha256("contains space")).toThrow(
      "authorization context is malformed",
    );
  });

  test("returns typed unsupported results for collections, non-finite live states, and DRM", () => {
    const base = {
      id: "item",
      extractor_key: "Generic",
      webpage_url: "https://example.com/item",
    } as const;
    for (const [marker, reason] of [
      [{ _type: "playlist" }, "playlist"],
      [{ _type: "multi_video" }, "multi-video"],
      [{ is_live: true }, "live"],
      [{ live_status: "is_live" }, "live"],
      [{ is_upcoming: true }, "upcoming"],
      [{ live_status: "is_upcoming" }, "upcoming"],
      [{ live_status: "post_live" }, "post-live"],
      [{ has_drm: true }, "drm"],
      [{ _has_drm: true }, "drm"],
      [{ requested_formats: [{ has_drm: true }] }, "drm"],
      [{ formats: [{ has_drm: true }, { has_drm: true }] }, "drm"],
    ] as const) {
      expect(parseProbeMetadata(
        { ...base, ...marker },
        "https://example.com/item",
      )).toMatchObject({ ok: false, kind: "unsupported", reason });
    }
  });

  test("accepts finite former-live VOD and absent or mixed DRM markers", () => {
    const base = {
      id: "item",
      extractor_key: "Generic",
      webpage_url: "https://example.com/item",
    } as const;
    for (const marker of [
      {},
      { is_live: false },
      { live_status: "not_live" },
      { live_status: "was_live", was_live: true },
      { formats: [{ has_drm: true }, { has_drm: false }] },
    ]) {
      expect(parseProbeMetadata(
        { ...base, ...marker },
        "https://example.com/item",
      )).toMatchObject({ ok: true });
    }
  });

  test("removes every generic query parameter from the persisted canonical URL", () => {
    const result = parseProbeMetadata(
      { id: "x", extractor: "web", webpage_url: "https://example.com/private/signed-path-token?id=1&session=secret&ticket=private&unknown=value#fragment-secret" },
      "https://example.com/x",
    );
    expect(result).toMatchObject({
      ok: true,
      metadata: { canonicalUrl: "https://example.com/" },
    });
    if (!result.ok) throw new Error(result.message);
    const persisted = renderProviderMetadataJson(result.metadata);
    expect(persisted).not.toContain("secret");
    expect(persisted).not.toContain("private");
    expect(persisted).not.toContain("signed-path-token");
  });

  test("never persists credentials or signed generic paths in owned metadata", () => {
    const parsed = parseProbeMetadata(
      {
        id: "x",
        extractor: "generic",
        webpage_url: "https://user:password@example.com/private/path-token?signature=query-token#fragment-token",
      },
      "https://example.com/fallback-path-token?fallback=query-token",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const rendered = renderProviderMetadataJson(parsed.metadata);
    expect(parsed.metadata.canonicalUrl).toBe("https://example.com/");
    for (const forbidden of [
      "user",
      "password",
      "private",
      "path-token",
      "query-token",
      "fragment-token",
      "fallback-path-token",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  test("projects only exact public YouTube identities; prefixes and malformed IDs stay opaque", () => {
    for (const [extractor, id] of [
      ["YoutubePlugin", "abc123DEF45"],
      ["Youtube", "signed-basename-token"],
      ["youtube", "abc123DEF45"],
    ] as const) {
      const parsed = parseProbeMetadata(
        {
          extractor_key: extractor,
          id,
          title: "private-title-token",
          webpage_url: `https://www.youtube.com/watch?v=${id}`,
        },
        `https://www.youtube.com/watch?v=${id}`,
      );
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.metadata).toMatchObject({ projection: "opaque", extractor: "External" });
      expect(renderProviderMetadataJson(parsed.metadata)).not.toContain("private-title-token");
    }
  });

  test("retains raw and normalized opaque values only as in-memory diagnostic redactions", () => {
    const parsed = parseProbeMetadata(
      {
        extractor: "PrivateAdapter",
        id: "signed-basename-token",
        title: "  Cafe\u0301-private-title  ",
        webpage_url: "https://example.com/signed-basename-token",
      },
      "https://example.com/signed-basename-token",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.metadata.diagnosticRedactions).toContain("  Cafe\u0301-private-title  ");
    expect(parsed.metadata.diagnosticRedactions).toContain("Caf\u00e9-private-title");
    const persisted = renderProviderMetadataJson(parsed.metadata);
    expect(persisted).not.toContain("Cafe");
    expect(persisted).not.toContain("Caf\u00e9");
  });

  test("rejects forged projection tags, canonical paths, descriptive fields, and missing redactions", () => {
    const parsed = parseProbeMetadata(
      {
        extractor: "PrivateAdapter",
        id: "signed-basename-token",
        webpage_url: "https://example.com/signed-basename-token",
      },
      "https://example.com/signed-basename-token",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    expect(isNormalizedProbeMetadata(parsed.metadata)).toBeTrue();
    expect(isNormalizedProbeMetadata({ ...parsed.metadata, projection: "other" as "opaque" })).toBeFalse();
    expect(isNormalizedProbeMetadata({ ...parsed.metadata, canonicalUrl: "https://example.com/private" })).toBeFalse();
    expect(isNormalizedProbeMetadata({ ...parsed.metadata, title: "private title" })).toBeFalse();
    expect(isNormalizedProbeMetadata({ ...parsed.metadata, diagnosticRedactions: [] })).toBeFalse();
    expect(isNormalizedProbeMetadata({
      ...parsed.metadata,
      projection: "youtube",
      extractor: "Youtube",
      id: parsed.metadata.acquisitionIdentity.id,
      extractorDirectory: sourceExtractorDirectory("Youtube"),
      itemDirectory: sourceItemDirectory(parsed.metadata.acquisitionIdentity.id),
      canonicalUrl: `https://www.youtube.com/watch?v=${parsed.metadata.acquisitionIdentity.id}`,
      diagnosticRedactions: [],
    })).toBeFalse();
  });

  test("rebuilds only YouTube's public video identity parameter", () => {
    const result = parseProbeMetadata(
      {
        id: "public-id01",
        extractor_key: "Youtube",
        webpage_url: "https://www.youtube.com/watch?v=wrong&list=private-list&session=secret#tracking",
      },
      "https://www.youtube.com/watch?v=wrong",
    );
    expect(result).toMatchObject({
      ok: true,
      metadata: { canonicalUrl: "https://www.youtube.com/watch?v=public-id01" },
    });
  });

  test("renders an exact owned metadata document and discards hostile nested probe data", () => {
    const parsed = parseProbeMetadata(
      {
        id: "abc123DEF45",
        extractor_key: "Youtube",
        webpage_url: "https://www.youtube.com/watch?v=abc123DEF45&session=manifest-secret",
        title: "Allowed title",
        description: "Allowed description",
        subtitles: { en: [{ url: "https://captions.invalid/signed-caption-secret" }] },
        formats: [{
          url: "https://media.invalid/video?signature=nested-format-secret",
          fragments: [{ url: "https://media.invalid/fragment?ticket=nested-fragment-secret" }],
          http_headers: { Cookie: "nested-cookie-secret" },
        }],
        cookies: "top-level-cookie-secret",
      },
      "https://www.youtube.com/watch?v=abc123DEF45",
    );
    if (!parsed.ok) throw new Error(parsed.message);

    const document = createProviderMetadataDocument(parsed.metadata);
    expect(document).toEqual({
      schemaVersion: 1,
      sourceAssetKey: sourceAssetKey("Youtube", "abc123DEF45"),
      source: {
        extractor: "Youtube",
        id: "abc123DEF45",
        canonicalUrl: "https://www.youtube.com/watch?v=abc123DEF45",
        title: "Allowed title",
        description: "Allowed description",
      },
      captions: {
        manualLanguages: ["en"],
        automaticLanguages: [],
      },
    });
    const rendered = renderProviderMetadataJson(parsed.metadata);
    expect(JSON.parse(rendered)).toEqual(document);
    for (const forbidden of [
      "formats",
      "fragments",
      "http_headers",
      "cookies",
      "manifest-secret",
      "nested-format-secret",
      "nested-fragment-secret",
      "nested-cookie-secret",
      "signed-caption-secret",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});

describe("selectCaption", () => {
  test("prefers exact requested relevance before manual source quality", () => {
    const parsed = parseProbeMetadata(
      {
        id: "x",
        extractor: "web",
        webpage_url: "https://example.com/x",
        subtitles: { en: [{}] },
        automatic_captions: { "en-US": [{}] },
      },
      "https://example.com/x",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    expect(selectCaption(parsed.metadata, "en-US")).toEqual({ source: "automatic", language: "en-US" });
  });

  test("uses manual quality only to break equal relevance", () => {
    const parsed = parseProbeMetadata(
      {
        id: "x",
        extractor: "web",
        webpage_url: "https://example.com/x",
        language: "fr",
        subtitles: { "en-GB": [{}], de: [{}] },
        automatic_captions: { "en-US": [{}], fr: [{}] },
      },
      "https://example.com/x",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    expect(selectCaption(parsed.metadata, "en-AU")).toEqual({ source: "manual", language: "en-GB" });
    expect(selectCaption(parsed.metadata, "fr")).toEqual({ source: "automatic", language: "fr" });
  });

  test("ignores empty caption track arrays before ranking sources", () => {
    const parsed = parseProbeMetadata(
      {
        id: "x",
        extractor: "web",
        webpage_url: "https://example.com/x",
        subtitles: {
          en: [],
          "en-GB": [null],
          "en-US": [{}],
          all: [{}],
          live_chat: [{}],
          "en.*,fr": [{}],
        },
        automatic_captions: { en: [{}] },
      },
      "https://example.com/x",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.metadata.manualCaptionLanguages).toEqual(["en-US"]);
    expect(selectCaption(parsed.metadata, "en")).toEqual({
      source: "automatic",
      language: "en",
    });
  });
});
