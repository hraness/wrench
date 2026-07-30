import { expect, test } from "bun:test";
import fc from "fast-check";
import { directHttpMediaForContainer } from "./http";
import {
  WRENCH_MEDIA_SCHEMA_VERSION,
  WRENCH_MEDIA_VERSION,
  WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
  WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
  localTranscriptVariantAssetKey,
  localTranscriptVariantSegments,
  parseMediaManifest,
  relativeArtifactPath,
  type MediaLocalTranscriptIdentity,
} from "./manifest";
import {
  AUTH_CONTEXT_IDENTITY_PROFILE,
  authenticatedYtDlpSourceAssetKey,
  authenticatedYtDlpSourceId,
  createDirectHttpMetadata,
  opaqueYtDlpSourceAssetKey,
  opaqueYtDlpSourceId,
  providerIdentitySha256,
  sourceAssetKey,
  variantAssetKey,
  YT_DLP_AUTH_IDENTITY_PROFILE,
  YT_DLP_OPAQUE_IDENTITY_PROFILE,
} from "./metadata";
import {
  WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
  WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  revisionContentSha256,
  trackedRevisionAssetKey,
  type MediaTrackedRevision,
  type RevisionArtifactInput,
} from "./revision";

const hashArbitrary = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
  .map((characters) => characters.join(""));

function directManifest(
  provenance: Readonly<Record<string, unknown>>,
  capture: Readonly<{ bytes: number; sha256: string }> = {
    bytes: 1,
    sha256: "0".repeat(64),
  },
  projection: Readonly<{
    assetKey: string;
    source: Readonly<{ extractor: string; id: string; canonicalUrl: string }>;
    capturePath: string;
    captureMediaType: string;
  }> = directProjection("1".repeat(64), "0".repeat(64), "iso-bmff"),
): unknown {
  const digest = "0".repeat(64);
  return {
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: projection.assetKey,
    capturedAt: "2026-07-21T14:00:01.000Z",
    mode: "video",
    source: projection.source,
    authentication: { mode: "public" },
    acquisition: { adapter: "direct-http", provenance },
    tools: { ffmpeg: "8.1.2", ffprobe: "8.1.2" },
    artifacts: [
      { role: "capture", path: projection.capturePath, bytes: capture.bytes, sha256: capture.sha256, mediaType: projection.captureMediaType },
      { role: "video", path: "data/derivatives/video.mp4", bytes: 1, sha256: digest, mediaType: "video/mp4" },
      { role: "provider_metadata", path: "data/metadata/provider.json", bytes: 1, sha256: digest, mediaType: "application/json" },
    ],
    transcript: { status: "unavailable", reason: "not_requested" },
  };
}

function trackedManifest(
  base: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const subjectAssetKey = base["assetKey"];
  const artifacts = base["artifacts"];
  if (typeof subjectAssetKey !== "string" || !Array.isArray(artifacts)) {
    throw new TypeError("tracked property fixture is malformed");
  }
  const revision: MediaTrackedRevision = {
    profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
    sequence: 1,
    subjectAssetKey,
    content: {
      profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
      sha256: revisionContentSha256(artifacts as RevisionArtifactInput[]),
    },
  };
  return {
    ...base,
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: trackedRevisionAssetKey(revision),
    revision,
  };
}

function localSubjectManifest(
  audio: Readonly<{ bytes: number; sha256: string }>,
  normalized: Readonly<{ bytes: number; sha256: string }>,
  inputOverrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const digest = "0".repeat(64);
  const youtubeId = "abcdefghijk";
  const baseSourceAssetKey = sourceAssetKey("Youtube", youtubeId);
  return {
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: baseSourceAssetKey,
    capturedAt: "2026-07-21T14:00:01.000Z",
    mode: "archive",
    source: {
      extractor: "Youtube",
      id: youtubeId,
      canonicalUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
    },
    authentication: { mode: "public" },
    acquisition: {
      adapter: "yt-dlp",
      version: "2026.07.20",
      identity: {
        profile: WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
        providerIdentitySha256: providerIdentitySha256("Youtube", youtubeId),
      },
        },
    tools: { ffmpeg: "8.1.2", ffprobe: "8.1.2" },
    artifacts: [
      { role: "capture", path: "data/capture/media.mkv", bytes: 1, sha256: digest, mediaType: "video/x-matroska" },
      { role: "audio", path: "data/derivatives/audio.mka", ...audio, mediaType: "audio/x-matroska" },
      { role: "provider_metadata", path: "data/metadata/provider.json", bytes: 1, sha256: digest, mediaType: "application/json" },
      { role: "transcript_vtt", path: "data/captions/transcript.vtt", bytes: 1, sha256: digest, mediaType: "text/vtt" },
      { role: "transcript_text", path: "data/captions/transcript.txt", bytes: 1, sha256: digest, mediaType: "text/plain" },
      { role: "transcript_json", path: "data/captions/transcript.json", bytes: 1, sha256: digest, mediaType: "application/json" },
    ],
    transcript: {
      status: "available",
      source: "local",
      language: "en",
      timedPath: "data/captions/transcript.vtt",
      textPath: "data/captions/transcript.txt",
      cuesPath: "data/captions/transcript.json",
      provenance: {
        adapter: "whisper-cpp",
        profile: "wrench-media-whisper-cpp-v1",
        executableSha256: "1".repeat(64),
        runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
        runtimeSha256: "3".repeat(64),
        runtimeDependencyCount: 4,
        modelSha256: "2".repeat(64),
        requestedLanguage: "en",
        input: {
          path: "data/derivatives/audio.mka",
          ...audio,
          normalized: {
            profile: "pcm-s16le-16000hz-mono-v1",
            ...normalized,
          },
          ...inputOverrides,
        },
      },
    },
  };
}

function localManifest(
  audio: Readonly<{ bytes: number; sha256: string }>,
  normalized: Readonly<{ bytes: number; sha256: string }>,
  inputOverrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return trackedManifest(localSubjectManifest(audio, normalized, inputOverrides));
}

function directProjection(
  requestedUrlSha256: string,
  bodySha256: string,
  container: Parameters<typeof directHttpMediaForContainer>[0],
): Readonly<{
  assetKey: string;
  source: Readonly<{ extractor: string; id: string; canonicalUrl: string }>;
  capturePath: string;
  captureMediaType: string;
}> {
  const metadata = createDirectHttpMetadata({
    requestedOrigin: "https://media.example/",
    requestedUrlSha256,
    bodySha256,
  });
  const media = directHttpMediaForContainer(container);
  return {
    assetKey: variantAssetKey(metadata.assetKey, ["video"]),
    source: {
      extractor: metadata.extractor,
      id: metadata.id,
      canonicalUrl: metadata.canonicalUrl,
    },
    capturePath: `data/capture/media.${media.extension}`,
    captureMediaType: media.mediaType,
  };
}

function opaqueLocalManifest(
  providerDigest: string,
  requestedUrlDigest: string,
): unknown {
  const identity = {
    profile: YT_DLP_OPAQUE_IDENTITY_PROFILE,
    providerIdentitySha256: providerDigest,
    requestedUrlSha256: requestedUrlDigest,
  } as const;
  const baseSourceAssetKey = opaqueYtDlpSourceAssetKey(identity);
  const current = localSubjectManifest(
    { bytes: 1, sha256: "0".repeat(64) },
    { bytes: 1, sha256: "0".repeat(64) },
  );
  return trackedManifest({
    ...current,
    assetKey: baseSourceAssetKey,
    source: {
      extractor: "External",
      id: opaqueYtDlpSourceId(baseSourceAssetKey),
      canonicalUrl: "https://media.example/",
    },
    acquisition: {
      adapter: "yt-dlp",
      version: "2026.07.20",
      identity,
    },
  });
}

function authenticatedLocalManifest(
  providerDigest: string,
  requestedUrlDigest: string,
  contextDigest: string,
  accessMode: "browser" | "ambient_config",
): Readonly<Record<string, unknown>> {
  const identity = {
    profile: YT_DLP_AUTH_IDENTITY_PROFILE,
    providerIdentitySha256: providerDigest,
    requestedUrlSha256: requestedUrlDigest,
    accessMode,
    authContext: {
      profile: AUTH_CONTEXT_IDENTITY_PROFILE,
      sha256: contextDigest,
    },
  } as const;
  const baseSourceAssetKey = authenticatedYtDlpSourceAssetKey(identity);
  const current = localSubjectManifest(
    { bytes: 1, sha256: "0".repeat(64) },
    { bytes: 1, sha256: "0".repeat(64) },
  );
  return trackedManifest({
    ...current,
    assetKey: baseSourceAssetKey,
    source: {
      extractor: "External",
      id: authenticatedYtDlpSourceId(baseSourceAssetKey),
      canonicalUrl: "https://media.example/",
    },
    authentication: {
      mode: accessMode,
      context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: contextDigest },
    },
    acquisition: { adapter: "yt-dlp", version: "2026.07.20", identity },
  });
}

test("property: arbitrary manifest JSON never throws", () => {
  fc.assert(
    fc.property(fc.anything(), (value) => {
      expect(() => parseMediaManifest(value)).not.toThrow();
    }),
    { numRuns: 300 },
  );
});

test("property: opaque identities round-trip exactly", () => {
  fc.assert(
    fc.property(hashArbitrary, hashArbitrary, (providerDigest, requestedUrlDigest) => {
      const current = opaqueLocalManifest(providerDigest, requestedUrlDigest);
      const parsed = parseMediaManifest(current);
      expect(parsed.ok).toBeTrue();
      if (parsed.ok) {
        expect(parseMediaManifest(JSON.parse(JSON.stringify(parsed.manifest)))).toEqual(parsed);
      }
    }),
    { numRuns: 200 },
  );
});

test("property: authentication context and mode are identity-bound", () => {
  fc.assert(
    fc.property(
      hashArbitrary,
      hashArbitrary,
      hashArbitrary,
      hashArbitrary,
      fc.constantFrom("browser" as const, "ambient_config" as const),
      (providerDigest, requestedUrlDigest, firstContext, candidateSecondContext, accessMode) => {
        const secondContext = candidateSecondContext === firstContext
          ? `${candidateSecondContext[0] === "0" ? "1" : "0"}${candidateSecondContext.slice(1)}`
          : candidateSecondContext;
        const otherMode = accessMode === "browser" ? "ambient_config" as const : "browser" as const;
        const first = authenticatedLocalManifest(
          providerDigest,
          requestedUrlDigest,
          firstContext,
          accessMode,
        );
        const differentContext = authenticatedLocalManifest(
          providerDigest,
          requestedUrlDigest,
          secondContext,
          accessMode,
        );
        const differentMode = authenticatedLocalManifest(
          providerDigest,
          requestedUrlDigest,
          firstContext,
          otherMode,
        );
        expect(parseMediaManifest(first).ok).toBeTrue();
        expect(parseMediaManifest(differentContext).ok).toBeTrue();
        expect(parseMediaManifest(differentMode).ok).toBeTrue();
        expect(new Set([
          first["assetKey"],
          differentContext["assetKey"],
          differentMode["assetKey"],
        ]).size).toBe(3);
        expect(parseMediaManifest({
          ...first,
          authentication: differentContext["authentication"],
        }).ok).toBeFalse();
        expect(parseMediaManifest({
          ...first,
          authentication: differentMode["authentication"],
        }).ok).toBeFalse();
      },
    ),
    { numRuns: 300 },
  );
});

test("property: opaque yt-dlp URL digests are distinct and identity-bound", () => {
  fc.assert(
    fc.property(
      hashArbitrary,
      hashArbitrary,
      hashArbitrary,
      (providerDigest, firstUrlDigest, candidateSecondUrlDigest) => {
        const secondUrlDigest = candidateSecondUrlDigest === firstUrlDigest
          ? `${candidateSecondUrlDigest[0] === "0" ? "1" : "0"}${candidateSecondUrlDigest.slice(1)}`
          : candidateSecondUrlDigest;
        const first = opaqueLocalManifest(providerDigest, firstUrlDigest) as Readonly<Record<string, unknown>>;
        const second = opaqueLocalManifest(providerDigest, secondUrlDigest) as Readonly<Record<string, unknown>>;
        expect(first["assetKey"]).not.toBe(second["assetKey"]);
        expect(parseMediaManifest(first).ok).toBeTrue();
        expect(parseMediaManifest(second).ok).toBeTrue();
        expect(parseMediaManifest({ ...first, assetKey: second["assetKey"] }).ok).toBeFalse();
      },
    ),
    { numRuns: 300 },
  );
});

test("property: bounded direct HTTP provenance parses and round-trips exactly", () => {
  const validatorArbitrary = fc.oneof(
    fc.constant({ strength: "absent" } as const),
    fc.record({
      strength: fc.constantFrom("weak" as const, "strong" as const),
      sha256: hashArbitrary,
    }),
  );
  const provenanceArbitrary = fc.record({
    requestedUrlSha256: hashArbitrary,
    effectiveUrlSha256: hashArbitrary,
    validator: validatorArbitrary,
    lastModified: fc.constantFrom(null, "Tue, 21 Jul 2026 14:00:00 GMT"),
    declaredMediaType: fc.constantFrom(null, "video/mp4", "audio/mpeg", "application/ogg"),
    container: fc.constantFrom(
      "iso-bmff",
      "matroska",
      "webm",
      "ogg",
      "flac",
      "wave",
      "mp3",
      "mpeg-ts",
    ),
    body: fc.record({
      bytes: fc.integer({ min: 0, max: 64 * 1024 * 1024 * 1024 }),
      sha256: hashArbitrary,
    }),
    redirectCount: fc.integer({ min: 0, max: 5 }),
  });

  fc.assert(
    fc.property(provenanceArbitrary, (provenance) => {
      const parsed = parseMediaManifest(directManifest(
        provenance,
        provenance.body,
        directProjection(
          provenance.requestedUrlSha256,
          provenance.body.sha256,
          provenance.container,
        ),
      ));
      expect(parsed.ok).toBeTrue();
      if (!parsed.ok) return;
      const serialized: unknown = JSON.parse(JSON.stringify(parsed.manifest));
      expect(parseMediaManifest(serialized)).toEqual(parsed);
    }),
    { numRuns: 300 },
  );
});

test("property: mutating either direct body field breaks capture coherence", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 1_000_000 }),
      hashArbitrary,
      fc.boolean(),
      (bytes, sha256, mutateBytes) => {
        const provenance = {
          requestedUrlSha256: "1".repeat(64),
          effectiveUrlSha256: "2".repeat(64),
          validator: { strength: "absent" },
          lastModified: null,
          declaredMediaType: "video/mp4",
          container: "iso-bmff",
          body: {
            bytes: mutateBytes ? bytes + 1 : bytes,
            sha256: mutateBytes ? sha256 : `${sha256[0] === "0" ? "1" : "0"}${sha256.slice(1)}`,
          },
          redirectCount: 0,
        } as const;
        expect(parseMediaManifest(directManifest(
          provenance,
          { bytes, sha256 },
          directProjection("1".repeat(64), sha256, "iso-bmff"),
        )).ok).toBeFalse();
      },
    ),
    { numRuns: 200 },
  );
});

test("property: every mutable local-transcriber identity component changes its variant", () => {
  const languageArbitrary = fc.constantFrom("auto", "en", "pt-br", "zh-hans");
  fc.assert(
    fc.property(
      hashArbitrary,
      hashArbitrary,
      hashArbitrary,
      fc.integer({ min: 0, max: 256 }),
      languageArbitrary,
      fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u),
      (
        executableSha256,
        runtimeSha256,
        modelSha256,
        runtimeDependencyCount,
        requestedLanguage,
        sourceAssetKey,
      ) => {
        const identity: MediaLocalTranscriptIdentity = {
          adapter: "whisper-cpp",
          profile: "wrench-media-whisper-cpp-v1",
          executableSha256,
          runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
          runtimeSha256,
          runtimeDependencyCount,
          modelSha256,
          normalizationProfile: "pcm-s16le-16000hz-mono-v1",
          requestedLanguage,
        };
        const segments = localTranscriptVariantSegments(identity);
        const assetKey = localTranscriptVariantAssetKey(sourceAssetKey, identity);
        expect(segments).toEqual(localTranscriptVariantSegments(identity));
        expect(assetKey).toBe(localTranscriptVariantAssetKey(sourceAssetKey, identity));
        expect(segments[3]).toMatch(/^transcriber-v1-[0-9a-f]{64}$/u);

        const differentExecutable = `${executableSha256[0] === "0" ? "1" : "0"}${executableSha256.slice(1)}`;
        const differentRuntime = `${runtimeSha256[0] === "0" ? "1" : "0"}${runtimeSha256.slice(1)}`;
        const differentModel = `${modelSha256[0] === "0" ? "1" : "0"}${modelSha256.slice(1)}`;
        const differentRuntimeCount = runtimeDependencyCount === 256
          ? runtimeDependencyCount - 1
          : runtimeDependencyCount + 1;
        const differentLanguage = requestedLanguage === "en" ? "fr" : "en";
        expect(localTranscriptVariantAssetKey(sourceAssetKey, {
          ...identity,
          executableSha256: differentExecutable,
        })).not.toBe(assetKey);
        expect(localTranscriptVariantAssetKey(sourceAssetKey, {
          ...identity,
          runtimeSha256: differentRuntime,
        })).not.toBe(assetKey);
        expect(localTranscriptVariantAssetKey(sourceAssetKey, {
          ...identity,
          runtimeDependencyCount: differentRuntimeCount,
        })).not.toBe(assetKey);
        expect(localTranscriptVariantAssetKey(sourceAssetKey, {
          ...identity,
          modelSha256: differentModel,
        })).not.toBe(assetKey);
        expect(localTranscriptVariantAssetKey(sourceAssetKey, {
          ...identity,
          requestedLanguage: differentLanguage,
        })).not.toBe(assetKey);
        expect(localTranscriptVariantAssetKey(`${sourceAssetKey}-other`, identity)).not.toBe(assetKey);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: local provenance round-trips only when its audio input stays coherent", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      hashArbitrary,
      fc.integer({ min: 1, max: 1_000_000 }),
      hashArbitrary,
      fc.boolean(),
      (bytes, sha256, normalizedBytes, normalizedSha256, mutateBytes) => {
        const audio = { bytes, sha256 };
        const normalized = { bytes: normalizedBytes, sha256: normalizedSha256 };
        const parsed = parseMediaManifest(localManifest(audio, normalized));
        expect(parsed.ok).toBeTrue();
        if (parsed.ok) {
          expect(parseMediaManifest(JSON.parse(JSON.stringify(parsed.manifest)))).toEqual(parsed);
        }

        const incoherent = mutateBytes
          ? { bytes: bytes + 1, sha256 }
          : {
              bytes,
              sha256: `${sha256[0] === "0" ? "1" : "0"}${sha256.slice(1)}`,
            };
        expect(parseMediaManifest(localManifest(audio, normalized, incoherent)).ok).toBeFalse();

      },
    ),
    { numRuns: 300 },
  );
});

test("property: raw URL strings and out-of-bound counts cannot become direct provenance", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 200 }),
      fc.oneof(
        fc.integer({ min: -10_000, max: -1 }),
        fc.integer({ min: (64 * 1024 * 1024 * 1024) + 1, max: (64 * 1024 * 1024 * 1024) + 10_000 }),
      ),
      fc.oneof(
        fc.integer({ min: -1_000, max: -1 }),
        fc.integer({ min: 6, max: 1_000 }),
      ),
      (secret, bytes, redirectCount) => {
        const rawUrl = `https://media.example/private?token=${encodeURIComponent(secret)}`;
        const provenance = {
          requestedUrlSha256: rawUrl,
          effectiveUrlSha256: "1".repeat(64),
          validator: { strength: "strong", sha256: 'W/"raw-validator"' },
          lastModified: null,
          declaredMediaType: "video/mp4",
          container: "iso-bmff",
          body: { bytes, sha256: "2".repeat(64) },
          redirectCount,
        };
        expect(parseMediaManifest(directManifest(provenance)).ok).toBeFalse();
      },
    ),
    { numRuns: 300 },
  );
});

test("property: paths outside an item cannot become artifact paths", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (suffix) => {
      expect(() => relativeArtifactPath("/tmp/item", `/tmp/outside/${suffix}`)).toThrow();
    }),
    { numRuns: 200 },
  );
});
