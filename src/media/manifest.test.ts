import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WRENCH_MEDIA_SCHEMA_VERSION,
  WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
  WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
  WRENCH_MEDIA_VERSION,
  createMediaArtifact,
  localTranscriptVariantAssetKey,
  localTranscriptVariantSegments,
  parseMediaManifest,
  verifyMediaItem,
  writeMediaManifest,
  type MediaManifest,
  type MediaLocalTranscriptIdentity,
  type MediaDirectHttpManifest,
} from "./manifest";
import {
  AUTH_CONTEXT_IDENTITY_PROFILE,
  authenticatedYtDlpSourceAssetKey,
  authenticatedYtDlpSourceId,
  authContextSha256,
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

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; manifest: MediaManifest }> {
  const root = await mkdtemp(join(tmpdir(), "media-manifest-test-"));
  roots.push(root);
  await mkdir(join(root, "data", "capture"), { recursive: true });
  await mkdir(join(root, "data", "derivatives"), { recursive: true });
  await mkdir(join(root, "data", "metadata"), { recursive: true });
  await writeFile(join(root, "data", "capture", "media.mkv"), "capture\n");
  await writeFile(join(root, "data", "derivatives", "audio.mka"), "audio\n");
  await writeFile(join(root, "data", "metadata", "provider.json"), "{}\n");
  await writeFile(join(root, "data", "metadata", "description.txt"), "hello\n");
  const artifacts = await Promise.all([
    createMediaArtifact(root, "data/capture/media.mkv", "capture"),
    createMediaArtifact(root, "data/derivatives/audio.mka", "audio"),
    createMediaArtifact(root, "data/metadata/provider.json", "provider_metadata"),
    createMediaArtifact(root, "data/metadata/description.txt", "description"),
  ]);
  const youtubeId = "abcdefghijk";
  const parsed = parseMediaManifest(trackedYtDlpManifest({
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: sourceAssetKey("Youtube", youtubeId),
    capturedAt: "2026-07-21T00:00:00.000Z",
    mode: "archive",
    source: {
      extractor: "Youtube",
      id: youtubeId,
      canonicalUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
    },
    authentication: { mode: "public" },
    acquisition: {
      adapter: "yt-dlp",
      version: "2026.07.04",
      identity: {
        profile: WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
        providerIdentitySha256: providerIdentitySha256("Youtube", youtubeId),
      },
    },
    tools: { ffmpeg: "8.1.2", ffprobe: "8.1.2" },
    artifacts,
    transcript: { status: "unavailable", reason: "provider_has_no_captions" },
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return {
    root,
    manifest: parsed.manifest,
  };
}

const digest = "0".repeat(64);

function directIdentity(
  requestedUrlSha256: string,
  bodySha256: string,
  mode: "archive" | "audio" | "video" = "video",
): Readonly<{ assetKey: string; source: Readonly<Record<string, string>> }> {
  const metadata = createDirectHttpMetadata({
    requestedOrigin: "https://media.example/",
    requestedUrlSha256,
    bodySha256,
  });
  return {
    assetKey: mode === "archive"
      ? metadata.assetKey
      : variantAssetKey(metadata.assetKey, [mode]),
    source: {
      extractor: metadata.extractor,
      id: metadata.id,
      canonicalUrl: metadata.canonicalUrl,
    },
  };
}

const defaultDirectIdentity = directIdentity("1".repeat(64), digest);

function directProvenance(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    requestedUrlSha256: "1".repeat(64),
    effectiveUrlSha256: "2".repeat(64),
    validator: { strength: "strong", sha256: "3".repeat(64) },
    lastModified: "Tue, 21 Jul 2026 14:00:00 GMT",
    declaredMediaType: "video/mp4",
    container: "iso-bmff",
    body: { bytes: 7, sha256: digest },
    redirectCount: 1,
    ...overrides,
  };
}

function directManifest(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: defaultDirectIdentity.assetKey,
    capturedAt: "2026-07-21T14:00:01.000Z",
    mode: "video",
    source: defaultDirectIdentity.source,
    authentication: { mode: "public" },
    acquisition: { adapter: "direct-http", provenance: directProvenance() },
    tools: { ffmpeg: "8.1.2", ffprobe: "8.1.2" },
    artifacts: [
      { role: "capture", path: "data/capture/media.mp4", bytes: 7, sha256: digest, mediaType: "video/mp4" },
      { role: "video", path: "data/derivatives/video.mp4", bytes: 7, sha256: digest, mediaType: "video/mp4" },
      { role: "provider_metadata", path: "data/metadata/provider.json", bytes: 3, sha256: digest, mediaType: "application/json" },
    ],
    transcript: { status: "unavailable", reason: "not_requested" },
    ...overrides,
  };
}

const localAudioDigest = "a".repeat(64);
const localExecutableDigest = "b".repeat(64);
const localRuntimeDigest = "e".repeat(64);
const localModelDigest = "c".repeat(64);
const localNormalizedDigest = "d".repeat(64);
const localYoutubeId = "abcdefghijk";
const localSourceAssetKey = sourceAssetKey("Youtube", localYoutubeId);
const localYtDlpIdentity = {
  profile: WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
  providerIdentitySha256: providerIdentitySha256("Youtube", localYoutubeId),
} as const;

const localIdentity: MediaLocalTranscriptIdentity = {
  adapter: "whisper-cpp",
  profile: "wrench-media-whisper-cpp-v1",
  executableSha256: localExecutableDigest,
  runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
  runtimeSha256: localRuntimeDigest,
  runtimeDependencyCount: 3,
  modelSha256: localModelDigest,
  normalizationProfile: "pcm-s16le-16000hz-mono-v1",
  requestedLanguage: "en",
};

function localTranscriptProvenance(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    adapter: "whisper-cpp",
    profile: "wrench-media-whisper-cpp-v1",
    executableSha256: localExecutableDigest,
    runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
    runtimeSha256: localRuntimeDigest,
    runtimeDependencyCount: 3,
    modelSha256: localModelDigest,
    requestedLanguage: "en",
    input: {
      path: "data/derivatives/audio.mka",
      bytes: 11,
      sha256: localAudioDigest,
      normalized: {
        profile: "pcm-s16le-16000hz-mono-v1",
        bytes: 44_100,
        sha256: localNormalizedDigest,
      },
    },
    ...overrides,
  };
}

function localTranscriptArtifacts(
  capture: Readonly<Record<string, unknown>> = {
    role: "capture",
    path: "data/capture/media.mkv",
    bytes: 17,
    sha256: digest,
    mediaType: "video/x-matroska",
  },
): readonly Readonly<Record<string, unknown>>[] {
  return [
    capture,
    { role: "audio", path: "data/derivatives/audio.mka", bytes: 11, sha256: localAudioDigest, mediaType: "audio/x-matroska" },
    { role: "provider_metadata", path: "data/metadata/provider.json", bytes: 3, sha256: digest, mediaType: "application/json" },
    { role: "transcript_vtt", path: "data/captions/transcript.vtt", bytes: 7, sha256: digest, mediaType: "text/vtt" },
    { role: "transcript_text", path: "data/captions/transcript.txt", bytes: 7, sha256: digest, mediaType: "text/plain" },
    { role: "transcript_json", path: "data/captions/transcript.json", bytes: 7, sha256: digest, mediaType: "application/json" },
  ];
}

function localTranscript(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    status: "available",
    source: "local",
    language: "en",
    timedPath: "data/captions/transcript.vtt",
    textPath: "data/captions/transcript.txt",
    cuesPath: "data/captions/transcript.json",
    provenance: localTranscriptProvenance(),
    ...overrides,
  };
}

function localYtDlpSubjectManifest(
  mode: "archive" | "transcript" = "transcript",
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: mode === "archive"
      ? localSourceAssetKey
      : localTranscriptVariantAssetKey(localSourceAssetKey, localIdentity),
    capturedAt: "2026-07-21T15:00:00.000Z",
    mode,
    source: {
      extractor: "Youtube",
      id: localYoutubeId,
      canonicalUrl: `https://www.youtube.com/watch?v=${localYoutubeId}`,
    },
    authentication: { mode: "public" },
    acquisition: {
      adapter: "yt-dlp",
      version: "2026.07.20",
      identity: localYtDlpIdentity,
    },
    tools: { ffmpeg: "8.1.2", ffprobe: "8.1.2" },
    artifacts: localTranscriptArtifacts(),
    transcript: localTranscript(),
    ...overrides,
  };
}

function localYtDlpManifest(
  mode: "archive" | "transcript" = "transcript",
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return trackedYtDlpManifest(localYtDlpSubjectManifest(mode, overrides));
}

function directLocalTranscriptManifest(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const metadata = createDirectHttpMetadata({
    requestedOrigin: "https://media.example/",
    requestedUrlSha256: "1".repeat(64),
    bodySha256: digest,
  });
  return {
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: localTranscriptVariantAssetKey(metadata.assetKey, localIdentity),
    capturedAt: "2026-07-21T15:00:00.000Z",
    mode: "transcript",
    source: {
      extractor: metadata.extractor,
      id: metadata.id,
      canonicalUrl: metadata.canonicalUrl,
    },
    authentication: { mode: "public" },
    acquisition: { adapter: "direct-http", provenance: directProvenance() },
    tools: { ffmpeg: "8.1.2", ffprobe: "8.1.2" },
    artifacts: localTranscriptArtifacts({
      role: "capture",
      path: "data/capture/media.mp4",
      bytes: 7,
      sha256: digest,
      mediaType: "video/mp4",
    }),
    transcript: localTranscript(),
    ...overrides,
  };
}

function authenticatedYtDlpManifest(
  contextSha256: string,
  accessMode: "browser" | "ambient_config" = "browser",
  mode: "archive" | "transcript" = "archive",
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const identity = {
    profile: YT_DLP_AUTH_IDENTITY_PROFILE,
    providerIdentitySha256: "6".repeat(64),
    requestedUrlSha256: "7".repeat(64),
    accessMode,
    authContext: {
      profile: AUTH_CONTEXT_IDENTITY_PROFILE,
      sha256: contextSha256,
    },
  } as const;
  const baseSourceAssetKey = authenticatedYtDlpSourceAssetKey(identity);
  return localYtDlpManifest(mode, {
    assetKey: mode === "archive"
      ? baseSourceAssetKey
      : localTranscriptVariantAssetKey(baseSourceAssetKey, localIdentity),
    source: {
      extractor: "External",
      id: authenticatedYtDlpSourceId(baseSourceAssetKey),
      canonicalUrl: "https://media.example/",
    },
    authentication: {
      mode: accessMode,
      context: {
        profile: AUTH_CONTEXT_IDENTITY_PROFILE,
        sha256: contextSha256,
      },
    },
    acquisition: {
      adapter: "yt-dlp",
      version: "2026.07.20",
      identity,
    },
    ...overrides,
  });
}

function opaqueLocalYtDlpManifest(
  requestedUrlSha256: string,
  mode: "archive" | "transcript" = "archive",
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const identity = {
    profile: YT_DLP_OPAQUE_IDENTITY_PROFILE,
    providerIdentitySha256: "6".repeat(64),
    requestedUrlSha256,
  } as const;
  const baseSourceAssetKey = opaqueYtDlpSourceAssetKey(identity);
  return localYtDlpManifest(mode, {
    assetKey: mode === "archive"
      ? baseSourceAssetKey
      : localTranscriptVariantAssetKey(baseSourceAssetKey, localIdentity),
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
    ...overrides,
  });
}

function focusedYtDlpMediaManifest(
  mode: "audio" | "video",
): Readonly<Record<string, unknown>> {
  return trackedYtDlpManifest({
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: variantAssetKey(localSourceAssetKey, [mode]),
    capturedAt: "2026-07-21T15:00:00.000Z",
    mode,
    source: {
      extractor: "Youtube",
      id: localYoutubeId,
      canonicalUrl: `https://www.youtube.com/watch?v=${localYoutubeId}`,
    },
    authentication: { mode: "public" },
    acquisition: {
      adapter: "yt-dlp",
      version: "2026.07.20",
      identity: localYtDlpIdentity,
    },
    tools: { ffmpeg: "8.1.2", ffprobe: "8.1.2" },
    artifacts: [
      { role: "capture", path: "data/capture/media.mkv", bytes: 17, sha256: digest, mediaType: "video/x-matroska" },
      {
        role: mode,
        path: mode === "audio" ? "data/derivatives/audio.mka" : "data/derivatives/video.mkv",
        bytes: 11,
        sha256: localAudioDigest,
        mediaType: mode === "audio" ? "audio/x-matroska" : "video/x-matroska",
      },
      { role: "provider_metadata", path: "data/metadata/provider.json", bytes: 3, sha256: digest, mediaType: "application/json" },
    ],
    transcript: { status: "unavailable", reason: "not_requested" },
  });
}

function trackedYtDlpManifest(
  base: Readonly<Record<string, unknown>> = localYtDlpSubjectManifest("archive"),
  revisionOverrides: Readonly<{
    sequence?: number;
    previousAssetKey?: string;
    contentSha256?: string;
  }> = {},
): Readonly<Record<string, unknown>> {
  const existingRevision = base["revision"];
  const existingSubjectAssetKey = typeof existingRevision === "object"
    && existingRevision !== null
    && "subjectAssetKey" in existingRevision
    ? existingRevision.subjectAssetKey
    : undefined;
  const subjectAssetKey = existingSubjectAssetKey ?? base["assetKey"];
  const artifacts = base["artifacts"];
  if (typeof subjectAssetKey !== "string" || !Array.isArray(artifacts)) {
    throw new TypeError("tracked manifest fixture is malformed");
  }
  const revision: MediaTrackedRevision = {
    profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
    sequence: revisionOverrides.sequence ?? 1,
    subjectAssetKey,
    ...(revisionOverrides.previousAssetKey === undefined
      ? {}
      : { previousAssetKey: revisionOverrides.previousAssetKey }),
    content: {
      profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
      sha256: revisionOverrides.contentSha256
        ?? revisionContentSha256(artifacts as RevisionArtifactInput[]),
    },
  };
  const { revision: ignoredRevision, ...manifestBase } = base;
  void ignoredRevision;
  return {
    ...manifestBase,
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion: WRENCH_MEDIA_VERSION,
    assetKey: trackedRevisionAssetKey(revision),
    revision,
  };
}

describe("Wrench media manifest", () => {
  test("uses one Wrench-owned schema and transcriber identity", () => {
    expect(WRENCH_MEDIA_SCHEMA_VERSION).toBe(1);
    expect(WRENCH_MEDIA_VERSION).toBe("0.10.0");
    expect(localTranscriptVariantSegments(localIdentity)).toEqual([
      "transcript",
      "local",
      "en",
      expect.stringMatching(/^transcriber-v1-[0-9a-f]{64}$/u),
    ]);
  });

  test("keeps the runtime and package release versions identical", async () => {
    const packageMetadata: unknown = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(
      typeof packageMetadata === "object" &&
        packageMetadata !== null &&
        "version" in packageMetadata
        ? packageMetadata.version
        : undefined,
    ).toBe(WRENCH_MEDIA_VERSION);
  });

  test("parses one exact direct HTTP acquisition", () => {
    const parsed = parseMediaManifest(directManifest());
    expect(parsed.ok).toBeTrue();
    if (parsed.ok) expect<unknown>(parsed.manifest).toEqual(directManifest());

    const absent = directManifest({
      acquisition: {
        adapter: "direct-http",
        provenance: directProvenance({
          validator: { strength: "absent" },
          lastModified: null,
          declaredMediaType: null,
          redirectCount: 0,
        }),
      },
    });
    const parsedAbsent = parseMediaManifest(absent);
    expect(parsedAbsent.ok).toBeTrue();
    if (parsedAbsent.ok) expect<unknown>(parsedAbsent.manifest).toEqual(absent);
  });

  test("round-trips exact YouTube and opaque public yt-dlp identities", () => {
    for (const manifest of [
      localYtDlpManifest("archive"),
      localYtDlpManifest("transcript"),
      focusedYtDlpMediaManifest("audio"),
      focusedYtDlpMediaManifest("video"),
      opaqueLocalYtDlpManifest("7".repeat(64), "archive"),
      opaqueLocalYtDlpManifest("7".repeat(64), "transcript"),
    ]) {
      const parsed = parseMediaManifest(manifest);
      expect(parsed.ok).toBeTrue();
      if (!parsed.ok) continue;
      expect(parseMediaManifest(JSON.parse(JSON.stringify(parsed.manifest)))).toEqual(parsed);
    }
  });

  test("round-trips authenticated identities only when authentication agrees exactly", () => {
    const personalDigest = authContextSha256("personal");
    const workDigest = authContextSha256("work");
    const browser = authenticatedYtDlpManifest(personalDigest, "browser", "archive");
    const ambient = authenticatedYtDlpManifest(personalDigest, "ambient_config", "archive");
    const work = authenticatedYtDlpManifest(workDigest, "browser", "archive");
    const transcript = authenticatedYtDlpManifest(personalDigest, "browser", "transcript");
    for (const manifest of [browser, ambient, work, transcript]) {
      const parsed = parseMediaManifest(manifest);
      expect(parsed.ok).toBeTrue();
      if (parsed.ok) expect(parseMediaManifest(JSON.parse(JSON.stringify(parsed.manifest)))).toEqual(parsed);
    }
    expect(new Set([browser["assetKey"], ambient["assetKey"], work["assetKey"]]).size).toBe(3);

    const acquisition = browser["acquisition"] as Readonly<Record<string, unknown>>;
    const identity = acquisition["identity"] as Readonly<Record<string, unknown>>;
    for (const authentication of [
      { mode: "public" },
      { mode: "browser" },
      { mode: "browser", context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: workDigest } },
      { mode: "ambient_config", context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: personalDigest } },
      { mode: "browser", context: { profile: "wrench-media-auth-context-v0", sha256: personalDigest } },
      { mode: "browser", context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: "A".repeat(64) } },
      { mode: "browser", context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: personalDigest, extra: true } },
      { mode: "browser", context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: personalDigest }, extra: true },
    ]) {
      expect(parseMediaManifest({ ...browser, authentication }).ok).toBeFalse();
    }
    for (const invalidIdentity of [
      { ...identity, profile: "yt-dlp-auth-context-v0" },
      { ...identity, accessMode: "ambient_config" },
      { ...identity, requestedUrlSha256: "G".repeat(64) },
      { ...identity, authContext: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: workDigest } },
      { ...identity, authContext: { profile: "wrench-media-auth-context-v0", sha256: personalDigest } },
      { ...identity, authContext: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: personalDigest, extra: true } },
      { ...identity, unexpected: true },
    ]) {
      expect(parseMediaManifest({
        ...browser,
        acquisition: { ...acquisition, identity: invalidIdentity },
      }).ok).toBeFalse();
    }
    expect(parseMediaManifest({
      ...browser,
      source: { ...(browser["source"] as Readonly<Record<string, unknown>>), title: "private" },
    }).ok).toBeFalse();
    expect(parseMediaManifest({
      ...browser,
      source: {
        ...(browser["source"] as Readonly<Record<string, unknown>>),
        canonicalUrl: "https://media.example/private?token=secret",
      },
    }).ok).toBeFalse();
  });

  test("round-trips tracked public and authenticated revisions", () => {
    const publicRevision = trackedYtDlpManifest();
    const authenticatedRevision = trackedYtDlpManifest(
      authenticatedYtDlpManifest(authContextSha256("personal")),
    );
    for (const manifest of [publicRevision, authenticatedRevision]) {
      const parsed = parseMediaManifest(manifest);
      expect(parsed.ok).toBeTrue();
      if (parsed.ok) {
        expect(parseMediaManifest(JSON.parse(JSON.stringify(parsed.manifest)))).toEqual(parsed);
      }
    }

    const firstAssetKey = publicRevision["assetKey"];
    if (typeof firstAssetKey !== "string") throw new TypeError("fixture omitted asset key");
    const changedBase = localYtDlpManifest("archive", {
      artifacts: localTranscriptArtifacts({
        role: "capture",
        path: "data/capture/media.mkv",
        bytes: 17,
        sha256: "9".repeat(64),
        mediaType: "video/x-matroska",
      }),
    });
    const second = trackedYtDlpManifest(changedBase, {
      sequence: 2,
      previousAssetKey: firstAssetKey,
    });
    expect(parseMediaManifest(second).ok).toBeTrue();
    expect(second["assetKey"]).not.toBe(firstAssetKey);
  });

  test("binds revision content, subject, predecessor, sequence, and top-level identity", () => {
    const valid = trackedYtDlpManifest();
    const revision = valid["revision"] as Readonly<Record<string, unknown>>;
    const content = revision["content"] as Readonly<Record<string, unknown>>;
    for (const candidate of [
      { ...valid, assetKey: `revision-v1-${"f".repeat(64)}` },
      { ...valid, revision: { ...revision, subjectAssetKey: `source-v1-${"e".repeat(64)}` } },
      { ...valid, revision: { ...revision, sequence: 0 } },
      { ...valid, revision: { ...revision, sequence: 2 } },
      { ...valid, revision: { ...revision, previousAssetKey: `source-v1-${"e".repeat(64)}` } },
      { ...valid, revision: { ...revision, content: { ...content, sha256: "d".repeat(64) } } },
      { ...valid, unexpected: true },
      { ...valid, revision: { ...revision, unexpected: true } },
    ]) expect(parseMediaManifest(candidate).ok).toBeFalse();

    const direct = directLocalTranscriptManifest();
    expect(parseMediaManifest(trackedYtDlpManifest(direct)).ok).toBeFalse();
  });

  test("does not treat derivative-only changes as a provider revision", () => {
    const base = focusedYtDlpMediaManifest("video");
    const tracked = trackedYtDlpManifest(base);
    const artifacts = (tracked["artifacts"] as readonly Readonly<Record<string, unknown>>[])
      .map((artifact) => artifact["role"] === "video"
        ? { ...artifact, sha256: "9".repeat(64) }
        : artifact);
    expect(parseMediaManifest({ ...tracked, artifacts }).ok).toBeTrue();
  });

  test("requires public authentication for every public or direct identity", () => {
    const digest = authContextSha256("personal");
    const privateAuthentication = {
      mode: "browser",
      context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256: digest },
    } as const;
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      authentication: privateAuthentication,
    })).ok).toBeFalse();
    expect(parseMediaManifest(opaqueLocalYtDlpManifest("7".repeat(64), "archive", {
      authentication: privateAuthentication,
    })).ok).toBeFalse();
    expect(parseMediaManifest(directLocalTranscriptManifest({
      authentication: privateAuthentication,
    })).ok).toBeFalse();
  });

  test("uses requested URL identity to disambiguate the same opaque provider tuple", () => {
    const first = opaqueLocalYtDlpManifest("7".repeat(64));
    const second = opaqueLocalYtDlpManifest("8".repeat(64));
    expect(first["assetKey"]).not.toBe(second["assetKey"]);
    expect((first["source"] as Readonly<Record<string, unknown>>)["id"]).not.toBe(
      (second["source"] as Readonly<Record<string, unknown>>)["id"],
    );
    expect(parseMediaManifest(first).ok).toBeTrue();
    expect(parseMediaManifest(second).ok).toBeTrue();
  });

  test("rejects malformed, extended, or inconsistent public yt-dlp identities", () => {
    const youtube = localYtDlpManifest("archive");
    const invalidYoutubeIdentities = [
      { ...localYtDlpIdentity, profile: "yt-dlp-owned-youtube-v0" },
      { ...localYtDlpIdentity, providerIdentitySha256: "A".repeat(64) },
      { ...localYtDlpIdentity, providerIdentitySha256: "1".repeat(63) },
      { ...localYtDlpIdentity, requestedUrlSha256: "2".repeat(64) },
      { ...localYtDlpIdentity, unexpected: true },
    ];
    for (const identity of invalidYoutubeIdentities) {
      expect(parseMediaManifest({
        ...youtube,
        acquisition: { adapter: "yt-dlp", version: "2026.07.20", identity },
      }).ok).toBeFalse();
    }
    for (const source of [
      { ...youtube["source"] as Readonly<Record<string, unknown>>, id: "abcdefghijl" },
      { ...youtube["source"] as Readonly<Record<string, unknown>>, canonicalUrl: "https://youtu.be/abcdefghijk" },
    ]) {
      expect(parseMediaManifest({ ...youtube, source }).ok).toBeFalse();
    }

    const opaque = opaqueLocalYtDlpManifest("7".repeat(64));
    const acquisition = opaque["acquisition"] as Readonly<Record<string, unknown>>;
    const identity = acquisition["identity"] as Readonly<Record<string, unknown>>;
    const invalidOpaqueIdentities = [
      { ...identity, profile: "yt-dlp-opaque-url-v0" },
      { ...identity, providerIdentitySha256: "6".repeat(63) },
      { ...identity, requestedUrlSha256: "G".repeat(64) },
      { ...identity, unexpected: true },
    ];
    for (const invalidIdentity of invalidOpaqueIdentities) {
      expect(parseMediaManifest({
        ...opaque,
        acquisition: { ...acquisition, identity: invalidIdentity },
      }).ok).toBeFalse();
    }
    expect(parseMediaManifest({
      ...opaque,
      assetKey: opaqueLocalYtDlpManifest("8".repeat(64))["assetKey"],
    })).toEqual({
      ok: false,
      message: "Wrench media tracked revision identity projection is inconsistent",
    });
    expect(parseMediaManifest({
      ...opaque,
      source: {
        ...(opaque["source"] as Readonly<Record<string, unknown>>),
        id: "opaque-v2-" + "f".repeat(64),
      },
    }).ok).toBeFalse();
  });

  test("validates provider-caption focused variants from the source base", () => {
    const artifacts = localTranscriptArtifacts().filter((artifact) =>
      artifact["role"] !== "capture" && artifact["role"] !== "audio");
    const providerTranscript = {
      status: "available",
      source: "manual",
      language: "en",
      timedPath: "data/captions/transcript.vtt",
      textPath: "data/captions/transcript.txt",
      cuesPath: "data/captions/transcript.json",
    } as const;
    const manifest = localYtDlpManifest("transcript", {
      assetKey: variantAssetKey(localSourceAssetKey, ["transcript", "manual", "en"]),
      artifacts,
      tools: {},
      transcript: providerTranscript,
    });
    expect(parseMediaManifest(manifest).ok).toBeTrue();
    expect(parseMediaManifest({ ...manifest, assetKey: "variant-v1-wrong" })).toEqual({
      ok: false,
      message: "Wrench media tracked revision identity projection is inconsistent",
    });
  });

  test("binds focused local transcript identity to exact YouTube sources", () => {
    expect(parseMediaManifest(localYtDlpManifest("transcript")).ok).toBeTrue();
    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      assetKey: "variant-v1-wrong",
    }))).toEqual({
      ok: false,
      message: "Wrench media tracked revision identity projection is inconsistent",
    });

  });

  test("requires exact, bounded local provenance at every nested level", () => {
    const invalidProvenance = [
      localTranscriptProvenance({ unexpected: true }),
      localTranscriptProvenance({ executableSha256: "B".repeat(64) }),
      localTranscriptProvenance({ runtimeProfile: "media-whisper-runtime-closure-v0" }),
      localTranscriptProvenance({ runtimeSha256: "E".repeat(64) }),
      localTranscriptProvenance({ runtimeDependencyCount: -1 }),
      localTranscriptProvenance({ runtimeDependencyCount: 257 }),
      localTranscriptProvenance({ runtimeDependencyCount: 1.5 }),
      localTranscriptProvenance({ modelSha256: "c".repeat(63) }),
      localTranscriptProvenance({ requestedLanguage: "EN" }),
      localTranscriptProvenance({ requestedLanguage: "xx-US" }),
      localTranscriptProvenance({ requestedLanguage: "en\u0000secret" }),
      localTranscriptProvenance({
        input: {
          path: "../audio.mka",
          bytes: 11,
          sha256: localAudioDigest,
          normalized: {
            profile: "pcm-s16le-16000hz-mono-v1",
            bytes: 44_100,
            sha256: localNormalizedDigest,
          },
        },
      }),
      localTranscriptProvenance({
        input: {
          path: "data/derivatives/audio.mka",
          bytes: 11,
          sha256: localAudioDigest,
          unexpected: true,
          normalized: {
            profile: "pcm-s16le-16000hz-mono-v1",
            bytes: 44_100,
            sha256: localNormalizedDigest,
          },
        },
      }),
      localTranscriptProvenance({
        input: {
          path: "data/derivatives/audio.mka",
          bytes: 11,
          sha256: localAudioDigest,
          normalized: {
            profile: "pcm-s16le-16000hz-mono-v1",
            bytes: 44_100,
            sha256: localNormalizedDigest,
            unexpected: true,
          },
        },
      }),
      localTranscriptProvenance({
        input: {
          path: "data/derivatives/audio.mka",
          bytes: 0,
          sha256: localAudioDigest,
          normalized: {
            profile: "pcm-s16le-16000hz-mono-v1",
            bytes: 44_100,
            sha256: localNormalizedDigest,
          },
        },
      }),
      localTranscriptProvenance({
        input: {
          path: "data/derivatives/audio.mka",
          bytes: 11,
          sha256: localAudioDigest,
          normalized: {
            profile: "pcm-s16le-16000hz-mono-v1",
            bytes: 4 * 1024 * 1024 * 1024,
            sha256: localNormalizedDigest,
          },
        },
      }),
    ];
    for (const provenance of invalidProvenance) {
      expect(parseMediaManifest(localYtDlpManifest("transcript", {
        transcript: localTranscript({ provenance }),
      })).ok).toBeFalse();
    }

    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      transcript: { ...localTranscript(), unexpected: true },
    })).ok).toBeFalse();
    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      transcript: {
        status: "available",
        source: "local",
        language: "en",
        timedPath: "data/captions/transcript.vtt",
        textPath: "data/captions/transcript.txt",
        cuesPath: "data/captions/transcript.json",
      },
    })).ok).toBeFalse();

    for (const language of ["auto", "EN", "xx-US", "en\u0000secret", "../../model.bin"]) {
      expect(parseMediaManifest(localYtDlpManifest("archive", {
        transcript: localTranscript({ language }),
      })).ok).toBeFalse();
    }
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      transcript: localTranscript({ language: "fr" }),
    })).ok).toBeFalse();
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      transcript: localTranscript({
        language: "he",
        provenance: localTranscriptProvenance({ requestedLanguage: "iw-il" }),
      }),
    })).ok).toBeTrue();
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      transcript: localTranscript({
        language: "fr",
        provenance: localTranscriptProvenance({ requestedLanguage: "auto" }),
      }),
    })).ok).toBeTrue();
  });

  test("binds local provenance to the sole retained audio artifact and tools", () => {
    for (const input of [
      { path: "data/capture/media.mkv", bytes: 11, sha256: localAudioDigest },
      { path: "data/derivatives/audio.mka", bytes: 12, sha256: localAudioDigest },
      { path: "data/derivatives/audio.mka", bytes: 11, sha256: "f".repeat(64) },
    ]) {
      expect(parseMediaManifest(localYtDlpManifest("transcript", {
        transcript: localTranscript({
          provenance: localTranscriptProvenance({
            input: {
              ...input,
              normalized: {
                profile: "pcm-s16le-16000hz-mono-v1",
                bytes: 44_100,
                sha256: localNormalizedDigest,
              },
            },
          }),
        }),
      }))).toEqual({
        ok: false,
        message: "Wrench media local transcript provenance does not match its audio artifact",
      });
    }
    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      tools: { ffmpeg: "8.1.2" },
    }))).toEqual({
      ok: false,
      message: "Wrench media local transcript requires FFmpeg and ffprobe provenance",
    });
  });

  test("enforces provider, local, and unavailable mode shapes", () => {
    const providerArtifacts = localTranscriptArtifacts().filter((artifact) =>
      artifact["role"] !== "capture" && artifact["role"] !== "audio");
    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      assetKey: variantAssetKey(localSourceAssetKey, ["transcript", "manual", "en"]),
      artifacts: providerArtifacts,
      tools: {},
      transcript: {
        status: "available",
        source: "manual",
        language: "en",
        timedPath: "data/captions/transcript.vtt",
        textPath: "data/captions/transcript.txt",
        cuesPath: "data/captions/transcript.json",
      },
    })).ok).toBeTrue();
    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      artifacts: localTranscriptArtifacts().filter((artifact) => artifact["role"] !== "capture"),
    })).ok).toBeFalse();
    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      artifacts: [
        ...localTranscriptArtifacts(),
        { role: "video", path: "data/derivatives/video.mkv", bytes: 7, sha256: digest, mediaType: "video/x-matroska" },
      ],
    })).ok).toBeFalse();

    const unavailableArtifacts = localTranscriptArtifacts().filter((artifact) =>
      !String(artifact["role"]).startsWith("transcript_"));
    for (const reason of ["provider_has_no_captions", "transcriber_not_configured"] as const) {
      expect(parseMediaManifest(localYtDlpManifest("archive", {
        artifacts: unavailableArtifacts,
        transcript: { status: "unavailable", reason },
      })).ok).toBeTrue();
    }
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      artifacts: unavailableArtifacts,
      transcript: {
        status: "unavailable",
        reason: "no_speech",
        provenance: localTranscriptProvenance(),
      },
    })).ok).toBeTrue();
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      artifacts: unavailableArtifacts,
      transcript: { status: "unavailable", reason: "no_speech" },
    })).ok).toBeFalse();

    const videoOnlyArtifacts = [
      unavailableArtifacts.find((artifact) => artifact["role"] === "capture"),
      { role: "video", path: "data/derivatives/video.mkv", bytes: 7, sha256: digest, mediaType: "video/x-matroska" },
      unavailableArtifacts.find((artifact) => artifact["role"] === "provider_metadata"),
    ].filter((artifact) => artifact !== undefined);
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      artifacts: videoOnlyArtifacts,
      transcript: { status: "unavailable", reason: "audio_not_present" },
    })).ok).toBeTrue();
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      artifacts: videoOnlyArtifacts,
      tools: {},
      transcript: { status: "unavailable", reason: "audio_not_present" },
    }))).toEqual({
      ok: false,
      message: "Wrench media local transcript requires FFmpeg and ffprobe provenance",
    });
    expect(parseMediaManifest(localYtDlpManifest("archive", {
      artifacts: unavailableArtifacts,
      transcript: { status: "unavailable", reason: "audio_not_present" },
    })).ok).toBeFalse();
  });

  test("allows only exact local focused transcripts for direct HTTP", () => {
    expect(parseMediaManifest(directLocalTranscriptManifest()).ok).toBeTrue();
    expect(parseMediaManifest(directLocalTranscriptManifest({
      assetKey: "variant-v1-wrong",
    }))).toEqual({
      ok: false,
      message: "Wrench media direct HTTP identity or media projection is inconsistent",
    });
    expect(parseMediaManifest(directLocalTranscriptManifest({
      source: {
        ...defaultDirectIdentity.source,
        title: "unowned title",
      },
    })).ok).toBeFalse();
    expect(parseMediaManifest(directLocalTranscriptManifest({
      artifacts: [
        ...localTranscriptArtifacts({
          role: "capture",
          path: "data/capture/media.mp4",
          bytes: 7,
          sha256: digest,
          mediaType: "video/mp4",
        }),
        { role: "description", path: "data/metadata/description.txt", bytes: 7, sha256: digest, mediaType: "text/plain" },
      ],
    })).ok).toBeFalse();
    const providerArtifacts = localTranscriptArtifacts().filter((artifact) =>
      artifact["role"] !== "capture" && artifact["role"] !== "audio");
    expect(parseMediaManifest(directLocalTranscriptManifest({
      artifacts: providerArtifacts,
      transcript: {
        status: "available",
        source: "automatic",
        language: "en",
        timedPath: "data/captions/transcript.vtt",
        textPath: "data/captions/transcript.txt",
        cuesPath: "data/captions/transcript.json",
      },
    })).ok).toBeFalse();
  });

  test("rejects raw URLs and validators from direct provenance", () => {
    const invalid = [
      directProvenance({ requestedUrlSha256: "https://media.example/private.mp4?token=secret" }),
      directProvenance({ effectiveUrlSha256: "https://cdn.example/signed.mp4" }),
      directProvenance({ requestedUrl: "https://media.example/private.mp4" }),
      directProvenance({ validator: { strength: "strong", sha256: '"secret-etag"' } }),
      directProvenance({ validator: { strength: "weak", value: 'W/"secret-etag"' } }),
    ];
    for (const provenance of invalid) {
      expect(parseMediaManifest(directManifest({
        acquisition: { adapter: "direct-http", provenance },
      })).ok).toBeFalse();
    }

    expect(parseMediaManifest(directManifest({
      source: {
        extractor: "External",
        id: "opaque-v1-direct",
        canonicalUrl: "https://media.example/private.mp4?token=secret",
      },
    }))).toEqual({
      ok: false,
      message: "Wrench media direct HTTP source URL must be an origin-only public projection",
    });
    expect(parseMediaManifest(directManifest({ authentication: { mode: "browser" } }))).toEqual({
      ok: false,
      message: "Wrench media manifest has an invalid top-level contract",
    });
  });

  test("requires exact keys throughout the manifest", () => {
    const exactArtifacts = [
      { role: "capture", path: "data/capture/media.mp4", bytes: 7, sha256: digest, mediaType: "video/mp4" },
      { role: "video", path: "data/derivatives/video.mp4", bytes: 7, sha256: digest, mediaType: "video/mp4" },
      { role: "provider_metadata", path: "data/metadata/provider.json", bytes: 3, sha256: digest, mediaType: "application/json" },
    ] as const;
    const invalid = [
      directManifest({ unexpected: true }),
      directManifest({ authentication: { mode: "public", unexpected: true } }),
      directManifest({ tools: { ffmpeg: "8.1.2", unexpected: true } }),
      directManifest({ source: { extractor: "External", id: "opaque-v1-direct", canonicalUrl: "https://media.example/", unexpected: true } }),
      directManifest({ acquisition: { adapter: "direct-http", provenance: directProvenance(), unexpected: true } }),
      directManifest({ acquisition: { adapter: "direct-http", provenance: directProvenance({ unexpected: true }) } }),
      directManifest({ acquisition: { adapter: "direct-http", provenance: directProvenance({ validator: { strength: "absent", sha256: digest } }) } }),
      directManifest({ acquisition: { adapter: "direct-http", provenance: directProvenance({ body: { bytes: 7, sha256: digest, unexpected: true } }) } }),
      directManifest({ artifacts: [{ ...exactArtifacts[0], unexpected: true }, ...exactArtifacts.slice(1)] }),
      directManifest({ transcript: { status: "unavailable", reason: "not_requested", unexpected: true } }),
    ];
    for (const manifest of invalid) expect(parseMediaManifest(manifest).ok).toBeFalse();
  });

  test("ties direct HTTP provenance to one non-transcript capture artifact", () => {
    expect(parseMediaManifest(directManifest({
      acquisition: {
        adapter: "direct-http",
        provenance: directProvenance({ body: { bytes: 8, sha256: digest } }),
      },
    }))).toEqual({
      ok: false,
      message: "Wrench media direct HTTP provenance does not match its capture artifact",
    });
    expect(parseMediaManifest(directManifest({
      acquisition: {
        adapter: "direct-http",
        provenance: directProvenance({ body: { bytes: 7, sha256: "4".repeat(64) } }),
      },
    }))).toEqual({
      ok: false,
      message: "Wrench media direct HTTP provenance does not match its capture artifact",
    });
    expect(parseMediaManifest(directLocalTranscriptManifest({
      artifacts: localTranscriptArtifacts().filter((artifact) => artifact["role"] !== "capture"),
    }))).toEqual({
      ok: false,
      message: "Wrench media manifest artifacts do not satisfy its capture mode",
    });
  });

  test("derives the direct source identity and capture media projection exactly", () => {
    for (const invalid of [
      directManifest({ assetKey: "source-v1-arbitrary" }),
      directManifest({
        source: {
          ...defaultDirectIdentity.source,
          title: "unowned title",
        },
      }),
      directManifest({
        source: {
          extractor: "Youtube",
          id: "abcdefghijk",
          canonicalUrl: "https://media.example/",
        },
      }),
      directManifest({
        acquisition: {
          adapter: "direct-http",
          provenance: directProvenance({ container: "flac" }),
        },
      }),
      directManifest({ tools: {} }),
    ]) {
      expect(parseMediaManifest(invalid)).toEqual({
        ok: false,
        message: "Wrench media direct HTTP identity or media projection is inconsistent",
      });
    }
  });

  test("enforces normalized hashes, metadata, containers, and numeric bounds", () => {
    const accepted = [
      { provenance: directProvenance({
        validator: { strength: "weak", sha256: "a".repeat(64) },
        body: { bytes: 64 * 1024 * 1024 * 1024, sha256: "b".repeat(64) },
        redirectCount: 5,
      }), body: { bytes: 64 * 1024 * 1024 * 1024, sha256: "b".repeat(64) }, extension: "mp4", mediaType: "video/mp4" },
      { provenance: directProvenance({
        validator: { strength: "absent" },
        lastModified: null,
        declaredMediaType: null,
        container: "mpeg-ts",
        body: { bytes: 0, sha256: digest },
        redirectCount: 0,
      }), body: { bytes: 0, sha256: digest }, extension: "ts", mediaType: "video/mp2t" },
    ];
    for (const { provenance, body, extension, mediaType } of accepted) {
      expect(parseMediaManifest(directManifest({
        ...directIdentity("1".repeat(64), body.sha256),
        acquisition: { adapter: "direct-http", provenance },
        artifacts: [
          { role: "capture", path: `data/capture/media.${extension}`, bytes: body.bytes, sha256: body.sha256, mediaType },
          { role: "video", path: "data/derivatives/video.mp4", bytes: 7, sha256: digest, mediaType: "video/mp4" },
          { role: "provider_metadata", path: "data/metadata/provider.json", bytes: 3, sha256: digest, mediaType: "application/json" },
        ],
      })).ok).toBeTrue();
    }

    const invalid = [
      directProvenance({ requestedUrlSha256: "a".repeat(63) }),
      directProvenance({ effectiveUrlSha256: "A".repeat(64) }),
      directProvenance({ validator: { strength: "strong", sha256: "g".repeat(64) } }),
      directProvenance({ lastModified: "2026-07-21T14:00:00.000Z" }),
      directProvenance({ lastModified: "Mon, 21 Jul 2026 14:00:00 GMT" }),
      directProvenance({ declaredMediaType: "Video/MP4" }),
      directProvenance({ declaredMediaType: "video/mp4; charset=binary" }),
      directProvenance({ declaredMediaType: `${"a".repeat(128)}/mp4` }),
      directProvenance({ container: "unknown" }),
      directProvenance({ body: { bytes: -1, sha256: digest } }),
      directProvenance({ body: { bytes: 0.5, sha256: digest } }),
      directProvenance({ body: { bytes: (64 * 1024 * 1024 * 1024) + 1, sha256: digest } }),
      directProvenance({ body: { bytes: 7, sha256: "f".repeat(65) } }),
      directProvenance({ redirectCount: -1 }),
      directProvenance({ redirectCount: 1.5 }),
      directProvenance({ redirectCount: 6 }),
    ];
    for (const provenance of invalid) {
      expect(parseMediaManifest(directManifest({ acquisition: { adapter: "direct-http", provenance } })).ok).toBeFalse();
    }
  });

  test("writes and verifies an exact integrity contract", async () => {
    const { root, manifest } = await fixture();
    await writeMediaManifest(root, manifest);
    expect(await verifyMediaItem(root)).toEqual({
      ok: true,
      itemDirectory: root,
      assetKey: manifest.assetKey,
      checkedArtifacts: 4,
      failures: [],
    });
  });

  test("verification rejects re-checksummed direct provenance that diverges from capture", async () => {
    const { root, manifest } = await fixture();
    if (!("revision" in manifest)) throw new Error("fixture is not yt-dlp");
    const capture = manifest.artifacts.find((artifact) => artifact.role === "capture");
    if (capture === undefined) throw new Error("fixture omitted capture");
    const directMetadata = createDirectHttpMetadata({
      requestedOrigin: "https://media.example/",
      requestedUrlSha256: "1".repeat(64),
      bodySha256: capture.sha256,
    });
    await unlink(join(root, "data", "metadata", "description.txt"));
    const { revision: ignoredRevision, ...manifestBase } = manifest;
    void ignoredRevision;
    const direct: MediaDirectHttpManifest = {
      ...manifestBase,
      schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
      wrenchVersion: WRENCH_MEDIA_VERSION,
      assetKey: directMetadata.assetKey,
      source: {
        extractor: directMetadata.extractor,
        id: directMetadata.id,
        canonicalUrl: directMetadata.canonicalUrl,
      },
      artifacts: manifest.artifacts.filter((artifact) => artifact.role !== "description"),
      transcript: { status: "unavailable", reason: "provider_has_no_captions" },
      authentication: { mode: "public" },
      acquisition: {
        adapter: "direct-http",
        provenance: {
          requestedUrlSha256: "1".repeat(64),
          effectiveUrlSha256: "2".repeat(64),
          validator: { strength: "absent" },
          lastModified: null,
          declaredMediaType: null,
          container: "matroska",
          body: { bytes: capture.bytes, sha256: capture.sha256 },
          redirectCount: 0,
        },
      },
    };
    await writeMediaManifest(root, direct);
    if (direct.acquisition.adapter !== "direct-http") {
      throw new Error("fixture is not a direct HTTP manifest");
    }
    const mediaPath = join(root, "wrench-media.json");
    const invalid = {
      ...direct,
      acquisition: {
        ...direct.acquisition,
        provenance: {
          ...direct.acquisition.provenance,
          body: { bytes: capture.bytes + 1, sha256: capture.sha256 },
        },
      },
    };
    const rendered = `${JSON.stringify(invalid, null, 2)}\n`;
    await writeFile(mediaPath, rendered);
    const checksumPath = join(root, "manifest-sha256.txt");
    const checksum = await readFile(checksumPath, "utf8");
    const manifestDigest = createHash("sha256").update(rendered).digest("hex");
    await writeFile(
      checksumPath,
      checksum.split("\n").map((line) => line.endsWith("  wrench-media.json")
        ? `${manifestDigest}  wrench-media.json`
        : line).join("\n"),
    );
    const verified = await verifyMediaItem(root);
    expect(verified.ok).toBeFalse();
    expect(verified.failures.join(" ")).toContain("direct HTTP provenance");
  });

  test("detects changed artifact bytes", async () => {
    const { root, manifest } = await fixture();
    await writeMediaManifest(root, manifest);
    await writeFile(join(root, "data", "metadata", "description.txt"), "changed\n");
    const result = await verifyMediaItem(root);
    expect(result.ok).toBeFalse();
    expect(result.failures.join(" ")).toContain("mismatch");
  });

  test("rejects unrecorded files instead of treating a partial tree as exact", async () => {
    const { root, manifest } = await fixture();
    await writeMediaManifest(root, manifest);
    await writeFile(join(root, "data", "metadata", "unrecorded.txt"), "surprise\n");
    const result = await verifyMediaItem(root);
    expect(result.ok).toBeFalse();
    expect(result.failures.join(" ")).toContain("exactly the recorded artifacts");
  });

  test("rejects symlink artifacts", async () => {
    const { root } = await fixture();
    await symlink("description.txt", join(root, "data", "metadata", "linked.txt"));
    try {
      await createMediaArtifact(root, "data/metadata/linked.txt", "description");
      throw new Error("expected symlink artifact to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("regular file");
    }
  });

  test("does not block when a regular artifact is swapped for a FIFO before open", async () => {
    const { root } = await fixture();
    const artifactPath = join(root, "data", "metadata", "description.txt");
    const rejection = createMediaArtifact(
      root,
      "data/metadata/description.txt",
      "description",
      {
        beforeOpen: async (path) => {
          await rename(path, `${path}.replaced`);
          const process = Bun.spawn(["mkfifo", path], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          });
          const [exitCode, stderr] = await Promise.all([
            process.exited,
            new Response(process.stderr).text(),
          ]);
          if (exitCode !== 0) throw new Error(`mkfifo failed: ${stderr}`);
        },
      },
    );

    try {
      await rejection;
      throw new Error("expected swapped FIFO artifact to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("changed before hashing");
    }
    expect(artifactPath).toEndWith("description.txt");
  });

  test("rejects symlinked and oversized manifest control files before reading", async () => {
    const symlinked = await fixture();
    await writeMediaManifest(symlinked.root, symlinked.manifest);
    const outside = join(symlinked.root, "outside.json");
    await writeFile(outside, "{}\n");
    await rm(join(symlinked.root, "wrench-media.json"));
    await symlink(outside, join(symlinked.root, "wrench-media.json"));
    const symlinkResult = await verifyMediaItem(symlinked.root);
    expect(symlinkResult.ok).toBeFalse();
    expect(symlinkResult.failures.join(" ")).toContain("regular file");

    const oversized = await fixture();
    await writeMediaManifest(oversized.root, oversized.manifest);
    await writeFile(join(oversized.root, "wrench-media.json"), "x".repeat((1024 * 1024) + 1));
    const oversizedResult = await verifyMediaItem(oversized.root);
    expect(oversizedResult.ok).toBeFalse();
    expect(oversizedResult.failures.join(" ")).toContain("verification bound");
  });

  test("rejects a checksum control-file symlink", async () => {
    const { root, manifest } = await fixture();
    await writeMediaManifest(root, manifest);
    const outside = join(root, "outside-checksums.txt");
    await writeFile(outside, `${"0".repeat(64)}  wrench-media.json\n`);
    await rm(join(root, "manifest-sha256.txt"));
    await symlink(outside, join(root, "manifest-sha256.txt"));
    const result = await verifyMediaItem(root);
    expect(result.ok).toBeFalse();
    expect(result.failures.join(" ")).toContain("regular file");
  });

  test("rejects an identical control file swapped at its pathname after reading", async () => {
    const { root, manifest } = await fixture();
    await writeMediaManifest(root, manifest);
    let swapped = false;

    const result = await verifyMediaItem(root, {
      afterRead: async (path) => {
        if (swapped || !path.endsWith("/wrench-media.json")) return;
        swapped = true;
        const original = await readFile(path);
        const orphan = `${path}.orphan`;
        await rename(path, orphan);
        await writeFile(path, original, { mode: 0o600 });
        await unlink(orphan);
      },
    });

    expect(swapped).toBeTrue();
    expect(result.ok).toBeFalse();
    expect(result.failures).toContain("wrench-media.json changed while reading");
  });

  test("rejects unsafe exact-name stale control temps without deleting them", async () => {
    const directoryFixture = await fixture();
    const uuid = "11111111-2222-4333-8444-555555555555";
    const staleDirectory = join(directoryFixture.root, `wrench-media.json.tmp-${uuid}`);
    await mkdir(staleDirectory);
    expect(
      writeMediaManifest(directoryFixture.root, directoryFixture.manifest),
    ).rejects.toThrow("not a regular file");
    expect((await lstat(staleDirectory)).isDirectory()).toBeTrue();

    const symlinkFixture = await fixture();
    const staleSymlink = join(
      symlinkFixture.root,
      `manifest-sha256.txt.tmp-${uuid}`,
    );
    await symlink(
      "data/metadata/description.txt",
      staleSymlink,
    );
    expect(
      writeMediaManifest(symlinkFixture.root, symlinkFixture.manifest),
    ).rejects.toThrow("not a regular file");
    expect((await lstat(staleSymlink)).isSymbolicLink()).toBeTrue();
  });

  test("leaves near-match temp names outside Wrench media's cleanup grammar", async () => {
    const { root, manifest } = await fixture();
    const nearMatch = join(root, "wrench-media.json.tmp-not-an-owned-uuid");
    await writeFile(nearMatch, "caller-owned\n");
    await writeMediaManifest(root, manifest);
    expect(await readFile(nearMatch, "utf8")).toBe("caller-owned\n");
  });

  test("rejects transcript paths that are not artifacts", () => {
    expect(parseMediaManifest(localYtDlpManifest("transcript", {
      assetKey: variantAssetKey(localSourceAssetKey, ["transcript", "manual", "en"]),
      tools: {},
      artifacts: [{
        role: "provider_metadata",
        path: "provider.json",
        bytes: 0,
        sha256: "0".repeat(64),
        mediaType: "application/json",
      }],
      transcript: { status: "available", source: "manual", language: "en", timedPath: "a", textPath: "b", cuesPath: "c" },
    }))).toEqual({ ok: false, message: "Wrench media transcript references an unrecorded artifact" });
  });

  test("requires available transcript paths to be distinct and map to exact roles", async () => {
    const { root, manifest } = await fixture();
    const provider = manifest.artifacts.find((artifact) => artifact.role === "provider_metadata");
    const counterfeit = manifest.artifacts.find((artifact) => artifact.role === "description");
    if (provider === undefined || counterfeit === undefined) throw new Error("fixture is incomplete");
    const invalid: MediaManifest = {
      ...manifest,
      mode: "transcript",
      artifacts: [provider, counterfeit],
      transcript: {
        status: "available",
        source: "manual",
        language: "en",
        timedPath: counterfeit.path,
        textPath: counterfeit.path,
        cuesPath: counterfeit.path,
      },
    };

    expect(parseMediaManifest(invalid)).toEqual({
      ok: false,
      message: "Wrench media transcript paths do not map to their exact artifact roles",
    });
    expect(writeMediaManifest(root, invalid)).rejects.toThrow(
      "Wrench media transcript paths do not map to their exact artifact roles",
    );

    await writeFile(join(root, "wrench-media.json"), `${JSON.stringify(invalid)}\n`);
    const verification = await verifyMediaItem(root);
    expect(verification.ok).toBeFalse();
    expect(verification.checkedArtifacts).toBe(0);
    expect(verification.failures).toContain(
      "Wrench media transcript paths do not map to their exact artifact roles",
    );
  });

  test("accepts one exact transcript artifact set", () => {
    const digest = "0".repeat(64);
    const artifact = (role: "provider_metadata" | "transcript_vtt" | "transcript_text" | "transcript_json", path: string) => ({
      role,
      path,
      bytes: 0,
      sha256: digest,
      mediaType: role === "transcript_vtt" ? "text/vtt" : role === "transcript_text" ? "text/plain" : "application/json",
    } as const);
    const parsed = parseMediaManifest(localYtDlpManifest("transcript", {
      assetKey: variantAssetKey(localSourceAssetKey, ["transcript", "manual", "en"]),
      tools: {},
      artifacts: [
        artifact("provider_metadata", "data/metadata/provider.json"),
        artifact("transcript_vtt", "data/captions/transcript.vtt"),
        artifact("transcript_text", "data/captions/transcript.txt"),
        artifact("transcript_json", "data/captions/transcript.json"),
      ],
      transcript: {
        status: "available",
        source: "manual",
        language: "en",
        timedPath: "data/captions/transcript.vtt",
        textPath: "data/captions/transcript.txt",
        cuesPath: "data/captions/transcript.json",
      },
    }));

    expect(parsed.ok).toBeTrue();
  });

  test("enforces singleton roles, provider metadata, mode shape, and transcript reasons", () => {
    const digest = "0".repeat(64);
    const artifact = (role: "audio" | "transcript_text", path: string) => ({
      role,
      path,
      bytes: 0,
      sha256: digest,
      mediaType: "application/octet-stream",
    } as const);
    const base = focusedYtDlpMediaManifest("audio");
    const validArtifacts = base["artifacts"] as readonly Readonly<Record<string, unknown>>[];

    expect(parseMediaManifest(base).ok).toBeTrue();
    expect(parseMediaManifest({ ...base, artifacts: validArtifacts.slice(0, 2) })).toEqual({
      ok: false,
      message: "Wrench media manifest must contain exactly one provider metadata artifact",
    });
    expect(parseMediaManifest({
      ...base,
      artifacts: [...validArtifacts, artifact("audio", "data/derivatives/second.mka")],
    })).toEqual({ ok: false, message: "Wrench media manifest has duplicate singleton artifact roles" });
    expect(parseMediaManifest({
      ...base,
      artifacts: [...validArtifacts, artifact("transcript_text", "data/captions/transcript.txt")],
    })).toEqual({ ok: false, message: "Wrench media unavailable transcript must not have transcript artifacts" });
    expect(parseMediaManifest({
      ...base,
      transcript: { status: "unavailable", reason: "provider_has_no_captions" },
      artifacts: validArtifacts,
    })).toEqual({ ok: false, message: "Wrench media manifest artifacts do not satisfy its capture mode" });
  });
});
