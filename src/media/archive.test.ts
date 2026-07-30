import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CaptureMode } from "./args";
import {
  DIRECT_HTTP_CAPTURE_NAMESPACE,
  MediaArchiveError,
  mediaUrl,
  revisionLineageIdentity,
  type CaptureIdentityRequest,
  type MediaArchiveDependencies,
} from "./archive";
import type { MediaDerivativeReport } from "./ffmpeg";
import {
  detectDirectHttpMedia,
  directHttpMediaForContainer,
  type DirectHttpMedia,
} from "./http";
import type { DirectHttpCaptureSink } from "./http-capture";
import { DirectHttpProbeTransport, type DirectHttpProbe } from "./http-probe";
import {
  WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
  WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
  WRENCH_MEDIA_SCHEMA_VERSION,
  WRENCH_MEDIA_WHISPER_CPP_PROFILE,
  createMediaArtifact,
  verifyMediaItem,
  writeMediaManifest,
  type MediaLocalTranscriptProvenance,
  type MediaManifest,
  type MediaYtDlpManifest,
} from "./manifest";
import {
  authContextSha256,
  parseProbeMetadata,
  sourceAssetKey,
  type ProbeMetadata,
} from "./metadata";
import type { TranscribeAudioLocallyOptions } from "./local-transcription";
import { compareUtf8 } from "./utf8-order";
import type { ReadyTranscriber } from "./transcriber-config";
import {
  MAX_TRACKED_REVISION_ITEMS,
  REVISION_CAPTURE_NAMESPACE,
  trackedRevisionAssetKey,
} from "./revision";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function providerMetadata(extractor: string, id: string): ProbeMetadata {
  const canonicalUrl = extractor === "Youtube"
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
    : `https://example.com/watch/${encodeURIComponent(id)}`;
  const parsed = parseProbeMetadata(
    {
      id,
      extractor,
      webpage_url: canonicalUrl,
      subtitles: { en: [{}] },
    },
    canonicalUrl,
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.metadata;
}

const metadata: ProbeMetadata = {
  ...providerMetadata("Youtube", "video-id001"),
  canonicalUrl: "https://www.youtube.com/watch?v=video-id001",
  title: "Fixture",
};

function trackedRevisionSubject(manifest: MediaManifest): string {
  return trackedManifest(manifest).revision.subjectAssetKey;
}

function trackedManifest(manifest: MediaManifest): MediaYtDlpManifest {
  if (!("revision" in manifest) || manifest.acquisition.adapter !== "yt-dlp") {
    throw new Error("fixture did not create a tracked revision manifest");
  }
  return manifest;
}

async function expectRevisionParentEmpty(
  root: string,
  source: ProbeMetadata,
  request: CaptureIdentityRequest,
): Promise<void> {
  const lineage = revisionLineageIdentity(source, request);
  const parent = join(
    await realpath(root),
    source.extractorDirectory,
    ...lineage.itemParentPathSegments,
  );
  expect(await readdir(parent)).toEqual([]);
}

const readyTranscriber: ReadyTranscriber = {
  executablePath: "/fake/whisper-cli",
  modelPath: "/fake/ggml-model.bin",
  descriptor: {
    adapter: "whisper-cpp",
    profile: WRENCH_MEDIA_WHISPER_CPP_PROFILE,
    executableSha256: "a".repeat(64),
    runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
    runtimeSha256: "c".repeat(64),
    runtimeDependencyCount: 1,
    modelSha256: "b".repeat(64),
    modelBytes: 1_024,
  },
  runtimeClosure: {
    profile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
    platform: "darwin",
    evidence: "dynamic-loader",
    executableSha256: "a".repeat(64),
    closureSha256: "c".repeat(64),
    dependencyCount: 1,
    dependencyBytes: 2_048,
    dependencies: [{
      physicalPath: "/fake/lib/libwhisper.dylib",
      logicalName: "libwhisper.dylib",
      sha256: "d".repeat(64),
      bytes: 2_048,
    }],
  },
};

function localProvenance(
  options: TranscribeAudioLocallyOptions,
): MediaLocalTranscriptProvenance {
  return {
    adapter: "whisper-cpp",
    profile: WRENCH_MEDIA_WHISPER_CPP_PROFILE,
    executableSha256: options.transcriber.descriptor.executableSha256,
    runtimeProfile: options.transcriber.descriptor.runtimeProfile,
    runtimeSha256: options.transcriber.descriptor.runtimeSha256,
    runtimeDependencyCount: options.transcriber.descriptor.runtimeDependencyCount,
    modelSha256: options.transcriber.descriptor.modelSha256,
    requestedLanguage: options.requestedLanguage,
    input: {
      path: options.audioArtifact.path,
      bytes: options.audioArtifact.bytes,
      sha256: options.audioArtifact.sha256,
      normalized: {
        profile: WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
        bytes: 44_100,
        sha256: "c".repeat(64),
      },
    },
  };
}

function successfulLocalTranscript(options: TranscribeAudioLocallyOptions) {
  return {
    status: "transcribed",
    language: options.requestedLanguage === "auto" ? "en" : options.requestedLanguage,
    transcript: {
      vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nlocal words\n",
      text: "local words\n",
      json: "[{\"startMs\":0,\"endMs\":1000,\"text\":\"local words\"}]\n",
      cues: [{ startMs: 0, endMs: 1_000, text: "local words" }],
    },
    provenance: localProvenance(options),
  } as const;
}

function dependencies(
  captureCalls: { value: number },
  probeMetadata: ProbeMetadata = metadata,
): MediaArchiveDependencies {
  return {
    findExecutable: (name) => Promise.resolve(`/fake/${name}`),
    probe: () => Promise.resolve({ ok: true, metadata: probeMetadata }),
    capture: async (options) => {
      captureCalls.value += 1;
      await mkdir(options.captureDirectory, { recursive: true });
      if (options.mode !== "transcript") {
        await writeFile(join(options.captureDirectory, "media.webm"), "original-media");
      }
      await writeFile(
        join(options.captureDirectory, "media.info.json"),
        `${JSON.stringify({
          formats: [{
            url: "https://media.invalid/video?signature=raw-sidecar-secret",
            fragments: [{ url: "https://media.invalid/fragment?ticket=raw-fragment-secret" }],
            http_headers: { Cookie: "raw-cookie-secret" },
          }],
        })}\n`,
      );
      await writeFile(join(options.captureDirectory, "media.description"), "description\n");
      await writeFile(join(options.captureDirectory, "media.webp"), "thumbnail");
      if (options.caption !== null) {
        await writeFile(join(options.captureDirectory, "media.en.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nhello world\n");
      }
      return {
        ok: true,
        identity: { ...probeMetadata.acquisitionIdentity, ext: "webm" },
      };
    },
    derive: async (options) => {
      await mkdir(options.derivativesDirectory, { recursive: true });
      const video = join(options.derivativesDirectory, "video.mkv");
      const audio = join(options.derivativesDirectory, "audio.mka");
      const roles = new Set(options.roles);
      if (roles.has("video")) await writeFile(video, "video-stream");
      if (roles.has("audio")) await writeFile(audio, "audio-stream");
      return {
        probe: { ok: true, inspection: { streams: [], hasVideo: true, hasAudio: true, firstVideoStreamIndex: 0, firstAudioStreamIndex: 1 } },
        video: roles.has("video")
          ? { role: "video", path: video, status: "created", sourceStreamIndex: 0 }
          : { role: "video", path: video, status: "not-requested" },
        audio: roles.has("audio")
          ? { role: "audio", path: audio, status: "created", sourceStreamIndex: 1 }
          : { role: "audio", path: audio, status: "not-requested" },
      } satisfies MediaDerivativeReport;
    },
    ytDlpVersion: () => Promise.resolve("2026.07.04"),
    ffmpegVersion: () => Promise.resolve("8.1.2"),
    probeDirectHttp: () => Promise.resolve({
      ok: false,
      kind: "not-applicable",
      reason: "unrecognized-media",
    }),
    captureDirectHttp: () => Promise.resolve({
      ok: false,
      error: { code: "transport", message: "direct capture is not configured in this fixture" },
    }),
    loadConfiguredTranscriber: () => Promise.resolve({ kind: "not-configured" }),
    transcribeAudioLocally: () => Promise.reject(new Error("local transcription is not configured in this fixture")),
    now: () => new Date("2026-07-21T00:00:00.000Z"),
  };
}

describe("mediaUrl", () => {
  test("atomically creates and verifies a complete archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const result = await mediaUrl({
      url: "https://www.youtube.com/watch?v=video-id001",
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls));
    expect(result.status).toBe("created");
    expect(result.manifest.artifacts.map((artifact) => artifact.role).toSorted()).toEqual([
      "audio", "capture", "description", "provider_metadata", "thumbnail", "transcript_json", "transcript_text", "transcript_vtt", "video",
    ]);
    const providerMetadataArtifact = result.manifest.artifacts.find(
      (artifact) => artifact.role === "provider_metadata",
    );
    expect(providerMetadataArtifact?.path).toBe("data/metadata/provider.json");
    const providerMetadataSource = await readFile(
      join(result.itemDirectory, providerMetadataArtifact?.path ?? "missing"),
      "utf8",
    );
    expect(JSON.parse(providerMetadataSource)).toMatchObject({
      schemaVersion: 1,
      sourceAssetKey: metadata.assetKey,
      source: {
        extractor: metadata.extractor,
        id: metadata.id,
        canonicalUrl: metadata.canonicalUrl,
        title: "Fixture",
      },
    });
    expect(result.manifest.source).toMatchObject({
      extractor: "Youtube",
      id: "video-id001",
      canonicalUrl: "https://www.youtube.com/watch?v=video-id001",
      title: "Fixture",
    });
    expect(providerMetadataSource).not.toContain("formats");
    expect(providerMetadataSource).not.toContain("raw-sidecar-secret");
    expect(providerMetadataSource).not.toContain("raw-fragment-secret");
    expect(providerMetadataSource).not.toContain("raw-cookie-secret");
    expect(
      readFile(join(result.itemDirectory, "data", "capture", "media.info.json")),
    ).rejects.toThrow();
    expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true, checkedArtifacts: 9 });
    expect(calls.value).toBe(1);

    const cached = await mediaUrl({
      url: "https://www.youtube.com/watch?v=video-id001",
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls));
    expect(cached.status).toBe("existing");
    expect(calls.value).toBe(1);
  });

  test("reuses the head by default and records equal, changed, and A/B/A refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-revision-history-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const base = dependencies(calls);
    let providerBytes = "provider-A";
    let derivativeSequence = 0;
    const deps: MediaArchiveDependencies = {
      ...base,
      capture: async (options) => {
        const result = await base.capture(options);
        if (result.ok) {
          await writeFile(join(options.captureDirectory, "media.webm"), providerBytes);
        }
        return result;
      },
      derive: async (options) => {
        const result = await base.derive(options);
        derivativeSequence += 1;
        for (const derivative of [result.video, result.audio]) {
          if (derivative.status === "created" || derivative.status === "exists") {
            await writeFile(
              derivative.path,
              `${derivative.role}-derivative-${String(derivativeSequence)}`,
            );
          }
        }
        return result;
      },
    };
    const options = {
      url: metadata.canonicalUrl,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };

    const first = await mediaUrl(options, deps);
    const firstManifest = trackedManifest(first.manifest);
    expect(first.status).toBe("created");
    expect(firstManifest.revision).toMatchObject({
      sequence: 1,
      subjectAssetKey: metadata.assetKey,
    });
    expect(firstManifest.revision.previousAssetKey).toBeUndefined();

    providerBytes = "provider-B";
    const cached = await mediaUrl(options, deps);
    expect(cached).toMatchObject({
      status: "existing",
      itemDirectory: first.itemDirectory,
    });
    expect(calls.value).toBe(1);

    providerBytes = "provider-A";
    const equalRefresh = await mediaUrl({ ...options, refresh: true }, deps);
    expect(equalRefresh).toMatchObject({
      status: "existing",
      itemDirectory: first.itemDirectory,
    });
    expect(equalRefresh.manifest.assetKey).toBe(firstManifest.assetKey);
    expect(calls.value).toBe(2);

    providerBytes = "provider-B";
    const second = await mediaUrl({ ...options, refresh: true }, deps);
    const secondManifest = trackedManifest(second.manifest);
    expect(second.status).toBe("created");
    expect(secondManifest.revision).toMatchObject({
      sequence: 2,
      previousAssetKey: firstManifest.assetKey,
    });
    expect(secondManifest.revision.content.sha256).not.toBe(
      firstManifest.revision.content.sha256,
    );

    providerBytes = "provider-A";
    const third = await mediaUrl({ ...options, refresh: true }, deps);
    const thirdManifest = trackedManifest(third.manifest);
    expect(third.status).toBe("created");
    expect(thirdManifest.revision).toMatchObject({
      sequence: 3,
      previousAssetKey: secondManifest.assetKey,
      content: { sha256: firstManifest.revision.content.sha256 },
    });
    expect(new Set([
      firstManifest.assetKey,
      secondManifest.assetKey,
      thirdManifest.assetKey,
    ]).size).toBe(3);

    const revisionParent = dirname(first.itemDirectory);
    expect(dirname(second.itemDirectory)).toBe(revisionParent);
    expect(dirname(third.itemDirectory)).toBe(revisionParent);
    expect((await readdir(revisionParent)).toSorted(compareUtf8)).toEqual([
      basename(first.itemDirectory),
      basename(second.itemDirectory),
      basename(third.itemDirectory),
    ]);
    for (const item of [first, second, third]) {
      expect(await verifyMediaItem(item.itemDirectory)).toMatchObject({ ok: true });
    }

    providerBytes = "provider-B";
    const latest = await mediaUrl(options, deps);
    expect(latest).toMatchObject({
      status: "existing",
      itemDirectory: third.itemDirectory,
    });
    expect(latest.manifest.assetKey).toBe(thirdManifest.assetKey);
    expect(calls.value).toBe(4);
  });

  test("fails closed on a malformed tracked history instead of returning an older head", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-malformed-history-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const options = {
      url: metadata.canonicalUrl,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    const created = await mediaUrl(options, dependencies(calls));
    const manifest = trackedManifest(created.manifest);
    const malformedLeaf = `0000000000000002-${manifest.assetKey}`;
    await rename(created.itemDirectory, join(dirname(created.itemDirectory), malformedLeaf));

    await expectMediaRejection(
      mediaUrl(options, dependencies(calls)),
      "ARCHIVE_INVALID",
    );
    expect(calls.value).toBe(1);
  });

  test("bounds revision-history discovery before validating directory contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-bounded-history-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const options = {
      url: metadata.canonicalUrl,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    const created = await mediaUrl(options, dependencies(calls));
    const revisionParent = dirname(created.itemDirectory);
    const extraEntries = Array.from(
      { length: MAX_TRACKED_REVISION_ITEMS },
      (_, index) => join(revisionParent, `unowned-${String(index).padStart(4, "0")}`),
    );
    for (let offset = 0; offset < extraEntries.length; offset += 128) {
      await Promise.all(extraEntries.slice(offset, offset + 128).map(async (path) => {
        await writeFile(path, "");
      }));
    }

    await expectMediaRejection(
      mediaUrl(options, dependencies(calls)),
      "ARCHIVE_INVALID",
    );
    expect(calls.value).toBe(1);
  });

  test("serializes concurrent refreshes without forking the revision chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-concurrent-revision-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const base = dependencies(calls);
    const options = {
      url: metadata.canonicalUrl,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    const first = await mediaUrl(options, base);
    let releaseCapture: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
    const release = new Promise<void>((resolveRelease) => { releaseCapture = resolveRelease; });
    const refreshDependencies: MediaArchiveDependencies = {
      ...base,
      capture: async (captureOptions) => {
        const result = await base.capture(captureOptions);
        if (result.ok) {
          await writeFile(join(captureOptions.captureDirectory, "media.webm"), "concurrent-B");
        }
        markEntered?.();
        await release;
        return result;
      },
    };

    const winningRefresh = mediaUrl({ ...options, refresh: true }, refreshDependencies);
    await entered;
    await expectMediaRejection(
      mediaUrl({ ...options, refresh: true }, refreshDependencies),
      "BUSY",
    );
    releaseCapture?.();
    const second = await winningRefresh;
    expect(trackedManifest(second.manifest).revision).toMatchObject({
      sequence: 2,
      previousAssetKey: first.manifest.assetKey,
    });

    const retry = await mediaUrl({ ...options, refresh: true }, refreshDependencies);
    expect(retry).toMatchObject({
      status: "existing",
      itemDirectory: second.itemDirectory,
    });
    expect(await readdir(dirname(first.itemDirectory))).toHaveLength(2);
    expect(calls.value).toBe(3);
  });

  test("keeps the verified head intact when an explicit refresh is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-cancelled-refresh-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const base = dependencies(calls);
    const options = {
      url: metadata.canonicalUrl,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    const first = await mediaUrl(options, base);
    const controller = new AbortController();
    await expectMediaRejection(mediaUrl({
      ...options,
      refresh: true,
      signal: controller.signal,
    }, {
      ...base,
      capture: () => {
        controller.abort();
        return Promise.resolve({
          ok: false,
          diagnostic: "cancelled refresh",
          processReason: "aborted",
        });
      },
    }), "CANCELLED");

    expect(await readdir(dirname(first.itemDirectory))).toEqual([
      basename(first.itemDirectory),
    ]);
    expect(await verifyMediaItem(first.itemDirectory)).toMatchObject({ ok: true });
    const cached = await mediaUrl(options, base);
    expect(cached).toMatchObject({
      status: "existing",
      itemDirectory: first.itemDirectory,
    });
    expect(calls.value).toBe(1);
  });

  test("projects signed Generic acquisition identity to an opaque archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const signedUrl = "https://example.com/private-route-token/signed-basename-token.mp4?signature=query-token#fragment-token";
    const parsed = parseProbeMetadata(
      {
        id: "signed-basename-token",
        extractor: "PrivateAdapterToken",
        title: "signed-title-token",
        description: "signed-description-token",
        webpage_url: signedUrl,
        subtitles: { en: [{}] },
      },
      signedUrl,
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const deps = dependencies({ value: 0 }, parsed.metadata);
    const result = await mediaUrl({
      url: signedUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, {
      ...deps,
      capture: async (options) => {
        expect(options.persistDescriptiveMetadata).toBeFalse();
        expect(options.privateRedactions).toContain("signed-basename-token");
        expect(options.privateRedactions).toContain("signed-title-token");
        const capture = await deps.capture(options);
        await writeFile(
          join(options.captureDirectory, "media.description"),
          "signed-description-token\n",
        );
        return capture;
      },
    });
    const [providerSource, manifestSource] = await Promise.all([
      readFile(join(result.itemDirectory, "data", "metadata", "provider.json"), "utf8"),
      readFile(join(result.itemDirectory, "wrench-media.json"), "utf8"),
    ]);
    expect(result.manifest.source.canonicalUrl).toBe("https://example.com/");
    expect(result.manifest.source.extractor).toBe("External");
    expect(result.manifest.source.id).toMatch(/^opaque-v2-[0-9a-f]{64}$/u);
    expect(result.manifest.artifacts.map((artifact) => artifact.role)).not.toContain("description");
    expect(result.manifest.artifacts.map((artifact) => artifact.role)).not.toContain("thumbnail");
    const textArtifacts = await Promise.all(
      result.manifest.artifacts
        .filter((artifact) => [
          "provider_metadata",
          "transcript_vtt",
          "transcript_text",
          "transcript_json",
        ].includes(artifact.role))
        .map(async (artifact) => await readFile(join(result.itemDirectory, artifact.path), "utf8")),
    );
    const forbidden = [
      "private-route-token",
      "PrivateAdapterToken",
      "signed-basename-token",
      "signed-title-token",
      "signed-description-token",
      "query-token",
      "fragment-token",
    ];
    for (const source of [
      result.itemDirectory,
      providerSource,
      manifestSource,
      JSON.stringify(result.manifest),
      ...textArtifacts,
    ]) {
      for (const token of forbidden) expect(source).not.toContain(token);
    }
  });

  test("isolates public, browser, ambient, and cross-context caches without persisting selectors", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrench-media-auth-context-test-"));
    roots.push(root);
    const requestedUrl = "https://example.com/private-route-token/media?signature=query-token#fragment-token";
    const rawProbe = {
      id: "shared-provider-id",
      extractor: "Generic",
      title: "private-title-token",
      webpage_url: requestedUrl,
      subtitles: {},
    } as const;
    const browserSelector = "firefox:/private/browser-profile-token";

    const projected = (
      access: undefined | Readonly<{
        mode: "browser" | "ambient_config";
        context: string;
      }>,
    ): ProbeMetadata => {
      const parsed = parseProbeMetadata(
        rawProbe,
        requestedUrl,
        access === undefined
          ? undefined
          : {
              mode: access.mode,
              contextSha256: authContextSha256(access.context),
            },
      );
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.metadata;
    };

    const captureCounts = new Map<string, number>();
    const capture = async (
      context: string | undefined,
      accessMode: "public" | "browser" | "ambient_config",
      marker: string,
    ) => {
      if (accessMode !== "public" && context === undefined) {
        throw new Error("private test capture requires a context");
      }
      const key = `${accessMode}:${context ?? "public"}`;
      const counter = { value: 0 };
      const metadataForAccess = projected(accessMode === "public"
        ? undefined
        : { mode: accessMode, context: context ?? "missing" });
      const base = dependencies(counter, metadataForAccess);
      const result = await mediaUrl({
        url: requestedUrl,
        mode: "archive",
        language: "en",
        libraryDirectory: root,
        ...(accessMode === "browser" ? { browser: browserSelector } : {}),
        ...(context === undefined ? {} : { authContext: context }),
        inheritYtDlpConfig: accessMode === "ambient_config",
      }, {
        ...base,
        capture: async (options) => {
          const captured = await base.capture(options);
          await writeFile(join(options.captureDirectory, "media.webm"), marker);
          return captured;
        },
      });
      captureCounts.set(key, (captureCounts.get(key) ?? 0) + counter.value);
      return result;
    };

    const personal = await capture("PersonalRealmSecret", "browser", "personal-media");
    const personalCached = await capture("personalrealmsecret", "browser", "must-not-capture");
    const work = await capture("WorkRealmSecret", "browser", "work-media");
    const ambient = await capture("PersonalRealmSecret", "ambient_config", "ambient-media");
    const publicCapture = await capture(undefined, "public", "public-media");

    expect(personal.status).toBe("created");
    expect(personalCached.status).toBe("existing");
    expect(work.status).toBe("created");
    expect(ambient.status).toBe("created");
    expect(publicCapture.status).toBe("created");
    expect(captureCounts.get("browser:PersonalRealmSecret")).toBe(1);
    expect(captureCounts.get("browser:personalrealmsecret")).toBe(0);
    expect(new Set([
      personal.manifest.assetKey,
      work.manifest.assetKey,
      ambient.manifest.assetKey,
      publicCapture.manifest.assetKey,
    ]).size).toBe(4);
    expect(personal.itemDirectory).toBe(personalCached.itemDirectory);
    expect(new Set([
      personal.itemDirectory,
      work.itemDirectory,
      ambient.itemDirectory,
      publicCapture.itemDirectory,
    ]).size).toBe(4);

    for (const result of [personal, work, ambient, publicCapture]) {
      expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true });
      const persisted = [
        result.itemDirectory,
        JSON.stringify(result.manifest),
        await readFile(join(result.itemDirectory, "wrench-media.json"), "utf8"),
        await readFile(join(result.itemDirectory, "data", "metadata", "provider.json"), "utf8"),
      ].join("\n");
      for (const secret of [
        "PersonalRealmSecret",
        "personalrealmsecret",
        "WorkRealmSecret",
        "workrealmsecret",
        "browser-profile-token",
        "private-route-token",
        "query-token",
        "fragment-token",
        "private-title-token",
        "raw-cookie-secret",
      ]) expect(persisted).not.toContain(secret);
    }
  });

  test("rejects a custom probe that tries to inject unowned descriptive metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const opaque = providerMetadata("Generic", "private-raw-id");
    expect(mediaUrl({
      url: opaque.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, {
      ...opaque,
      title: "private-title-token",
      canonicalUrl: "https://example.com/private-path-token",
    }))).rejects.toMatchObject({ code: "PROBE_FAILED" });
    expect(calls.value).toBe(0);
  });

  test("scrubs opaque acquisition values from injected capture failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const opaque = providerMetadata("PrivateAdapterToken", "signed-basename-token");
    const deps = dependencies({ value: 0 }, opaque);
    try {
      await mediaUrl({
        url: "https://example.com/signed-basename-token.mp4",
        mode: "archive",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...deps,
        capture: () => Promise.resolve({
          ok: false,
          diagnostic: "PrivateAdapterToken failed signed-basename-token",
        }),
      });
      throw new Error("expected capture failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaArchiveError);
      if (!(error instanceof MediaArchiveError)) throw error;
      expect(error.message).not.toContain("PrivateAdapterToken");
      expect(error.message).not.toContain("signed-basename-token");
    }
  });

  test("fails transcript-only before capture when the provider has no captions", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const deps = dependencies(calls);
    const rejection = mediaUrl({
      url: "https://example.com/no-captions",
      mode: "transcript",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, { ...deps, probe: () => Promise.resolve({ ok: true, metadata: { ...metadata, manualCaptionLanguages: [] } }) });
    try {
      await rejection;
      throw new Error("expected transcript capture to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "TRANSCRIPT_UNAVAILABLE" });
    }
    expect(calls.value).toBe(0);
  });

  test("preserves staging when derivation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const deps = dependencies(calls);
    const rejection = mediaUrl({
      url: "https://example.com/failure",
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, {
      ...deps,
      derive: (options) => Promise.resolve({
        probe: { ok: false, reason: "process", diagnostic: "probe failed" },
        video: { role: "video", path: join(options.derivativesDirectory, "video.mkv"), status: "failed", stage: "probe", diagnostic: "probe failed" },
        audio: { role: "audio", path: join(options.derivativesDirectory, "audio.mka"), status: "failed", stage: "probe", diagnostic: "probe failed" },
      }),
    });
    try {
      await rejection;
      throw new Error("expected derivation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaArchiveError);
    }
    const lineage = revisionLineageIdentity(metadata, { mode: "archive" });
    expect(await readFile(join(
      root,
      ".wrench-media-staging",
      ...lineage.storagePathSegments,
      "data",
      "capture",
      "media.webm",
    ), "utf8")).toBe("original-media");
  });

  test("discards identity-mismatched staging before a stable retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const physicalRoot = await realpath(root);
    const calls = { value: 0 };
    const opaque = providerMetadata("Generic", "private-raw-id");
    const deps = dependencies(calls, opaque);
    expect(mediaUrl({
      url: opaque.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, {
      ...deps,
      capture: async (options) => {
        const result = await deps.capture(options);
        if (!result.ok) return result;
        await writeFile(join(options.captureDirectory, "media.webm"), "source-b-poison");
        return { ok: true, identity: { ...result.identity, id: "different-id" } };
      },
    })).rejects.toMatchObject({ code: "CAPTURE_FAILED" });
    expect(calls.value).toBe(1);
    const lineage = revisionLineageIdentity(opaque, { mode: "archive" });
    expect(readFile(join(
      physicalRoot,
      ".wrench-media-staging",
      ...lineage.storagePathSegments,
      "data",
      "capture",
      "media.webm",
    ))).rejects.toThrow();
    await expectRevisionParentEmpty(root, opaque, { mode: "archive" });

    const stable = await mediaUrl({
      url: opaque.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, deps);
    expect(await readFile(
      join(stable.itemDirectory, "data", "capture", "media.webm"),
      "utf8",
    )).toBe("original-media");
    expect(stable.manifest.source.id).toBe(opaque.id);
    expect(stable.manifest.source.id).not.toBe(opaque.acquisitionIdentity.id);
    expect(calls.value).toBe(2);
  });

  test("does not promote a selected transcript that yt-dlp failed to write", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const deps = dependencies({ value: 0 });
    expect(mediaUrl({
      url: metadata.canonicalUrl,
      mode: "transcript",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, {
      ...deps,
      capture: async (options) => {
        const result = await deps.capture(options);
        await rm(join(options.captureDirectory, "media.en.vtt"));
        return result;
      },
    })).rejects.toMatchObject({ code: "CAPTURE_FAILED" });
    const request: CaptureIdentityRequest = {
      mode: "transcript",
      transcript: { kind: "provider", source: "manual", language: "en" },
    };
    await expectRevisionParentEmpty(root, metadata, request);
  });

  test("checks every newly built media manifest against its requested mode", async () => {
    for (const mode of ["audio", "video", "archive"] as const) {
      const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
      roots.push(root);
      const deps = dependencies({ value: 0 });
      expect(mediaUrl({
        url: metadata.canonicalUrl,
        mode,
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...deps,
        derive: (options) => Promise.resolve({
          probe: {
            ok: true,
            inspection: {
              streams: [],
              hasVideo: false,
              hasAudio: false,
              firstVideoStreamIndex: null,
              firstAudioStreamIndex: null,
            },
          },
          video: {
            role: "video",
            path: join(options.derivativesDirectory, "video.mkv"),
            status: "not-present",
          },
          audio: {
            role: "audio",
            path: join(options.derivativesDirectory, "audio.mka"),
            status: "not-present",
          },
        }),
      })).rejects.toMatchObject({ code: "DERIVATION_FAILED" });
      await expectRevisionParentEmpty(root, metadata, { mode });
    }
  });

  test("focused media modes derive and record only their requested role", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    for (const mode of ["audio", "video"] as const) {
      const deps = dependencies({ value: 0 });
      let selectedCaption: unknown = "not-called";
      const result = await mediaUrl({
        url: metadata.canonicalUrl,
        mode,
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...deps,
        capture: (options) => {
          selectedCaption = options.caption;
          return deps.capture(options);
        },
      });
      const roles = new Set(result.manifest.artifacts.map((artifact) => artifact.role));
      const opposite = mode === "audio" ? "video" : "audio";
      expect(roles.has("capture")).toBeTrue();
      expect(roles.has(mode)).toBeTrue();
      expect(roles.has(opposite)).toBeFalse();
      expect(roles.has("transcript_vtt")).toBeFalse();
      expect(roles.has("transcript_text")).toBeFalse();
      expect(roles.has("transcript_json")).toBeFalse();
      expect(result.manifest.transcript).toEqual({
        status: "unavailable",
        reason: "not_requested",
      });
      expect(selectedCaption).toBeNull();
      const oppositeName = opposite === "video" ? "video.mkv" : "audio.mka";
      expect(readFile(
        join(result.itemDirectory, "data", "derivatives", oppositeName),
      )).rejects.toThrow();
    }
  });

  test("never reuses a mixed focused manifest as a valid mode cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const created = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "audio",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls));
    const videoPath = join(created.itemDirectory, "data", "derivatives", "video.mkv");
    await writeFile(videoPath, "unexpected-video");
    const videoArtifact = await createMediaArtifact(
      created.itemDirectory,
      "data/derivatives/video.mkv",
      "video",
    );
    const mixedManifest = {
      ...created.manifest,
      artifacts: [...created.manifest.artifacts, videoArtifact],
    };
    const manifestSource = `${JSON.stringify(mixedManifest, null, 2)}\n`;
    await writeFile(join(created.itemDirectory, "wrench-media.json"), manifestSource);
    const manifestDigest = createHash("sha256").update(manifestSource, "utf8").digest("hex");
    const checksumSource = [
      ...mixedManifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`),
      `${manifestDigest}  wrench-media.json`,
    ].toSorted(compareUtf8).join("\n");
    await writeFile(
      join(created.itemDirectory, "manifest-sha256.txt"),
      `${checksumSource}\n`,
    );

    expect(mediaUrl({
      url: metadata.canonicalUrl,
      mode: "audio",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls))).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect(calls.value).toBe(1);
  });

  test("rejects a tracked opaque cache whose projected source identity changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const opaque = providerMetadata("Generic", "cache-private-raw-id");
    const created = await mediaUrl({
      url: opaque.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, opaque));
    const other = parseProbeMetadata(
      {
        id: opaque.acquisitionIdentity.id,
        extractor: opaque.acquisitionIdentity.extractor,
        webpage_url: "https://example.com/other-resource",
      },
      "https://example.com/other-resource",
    );
    if (!other.ok || other.metadata.opaqueYtDlpIdentity === undefined) {
      throw new Error("fixture did not create another opaque identity");
    }
    const currentManifest = trackedManifest(created.manifest);
    const otherRevision = {
      ...currentManifest.revision,
      subjectAssetKey: revisionLineageIdentity(
        other.metadata,
        { mode: "archive" },
      ).subjectAssetKey,
    };
    const otherManifest = {
      ...currentManifest,
      assetKey: trackedRevisionAssetKey(otherRevision),
      source: { ...currentManifest.source, id: other.metadata.id },
      acquisition: {
        adapter: "yt-dlp",
        version: currentManifest.acquisition.version,
        identity: other.metadata.opaqueYtDlpIdentity,
      },
      revision: otherRevision,
    } satisfies MediaYtDlpManifest;
    const inconsistentItemDirectory = join(
      dirname(created.itemDirectory),
      `${String(otherRevision.sequence).padStart(16, "0")}-${otherManifest.assetKey}`,
    );
    await rename(created.itemDirectory, inconsistentItemDirectory);
    await writeMediaManifest(inconsistentItemDirectory, otherManifest);

    expect(mediaUrl({
      url: opaque.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, opaque))).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect(calls.value).toBe(1);
  });

  test("warns only when a complete archive genuinely has no provider captions", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    const audioRoot = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root, audioRoot);
    const noCaptions = {
      ...metadata,
      manualCaptionLanguages: [],
      automaticCaptionLanguages: [],
    } satisfies ProbeMetadata;
    const deps = dependencies({ value: 0 }, noCaptions);
    const result = await mediaUrl({
      url: noCaptions.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, deps);
    expect(result.warnings).toEqual([
      "provider has no transcript and no local transcriber is configured; the media archive is complete",
    ]);
    expect(result.manifest.transcript).toEqual({
      status: "unavailable",
      reason: "transcriber_not_configured",
    });

    const audioDeps = dependencies({ value: 0 }, noCaptions);
    const audio = await mediaUrl({
      url: noCaptions.canonicalUrl,
      mode: "audio",
      language: "en",
      libraryDirectory: audioRoot,
      inheritYtDlpConfig: false,
    }, audioDeps);
    expect(audio.warnings).toEqual([]);
    expect(audio.manifest.transcript).toEqual({
      status: "unavailable",
      reason: "not_requested",
    });
  });

  test("provider captions and focused media modes never inspect or invoke the local transcriber", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    let configurationLoads = 0;
    let localAttempts = 0;
    const base = dependencies({ value: 0 });
    const deps: MediaArchiveDependencies = {
      ...base,
      loadConfiguredTranscriber: () => {
        configurationLoads += 1;
        return Promise.resolve({ kind: "ready", transcriber: readyTranscriber });
      },
      transcribeAudioLocally: () => {
        localAttempts += 1;
        return Promise.reject(new Error("provider-backed modes must never transcribe locally"));
      },
    };

    for (const mode of ["archive", "transcript", "audio", "video"] as const) {
      const result = await mediaUrl({
        url: metadata.canonicalUrl,
        mode,
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, deps);
      expect(result.status).toBe("created");
    }
    expect(configurationLoads).toBe(0);
    expect(localAttempts).toBe(0);
  });

  test("creates archive and focused local transcripts with normalized identity and private ephemeral attempts", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "media-local-archive-test-"));
    const focusedRoot = await mkdtemp(join(tmpdir(), "media-local-focused-test-"));
    roots.push(archiveRoot, focusedRoot);
    const noCaptions = {
      ...metadata,
      manualCaptionLanguages: [],
      automaticCaptionLanguages: [],
    } satisfies ProbeMetadata;
    const captureModes: CaptureMode[] = [];
    const derivativeRoles: (readonly string[])[] = [];
    const attempts: string[] = [];
    const base = dependencies({ value: 0 }, noCaptions);
    const deps: MediaArchiveDependencies = {
      ...base,
      loadConfiguredTranscriber: () => Promise.resolve({
        kind: "ready",
        transcriber: readyTranscriber,
      }),
      capture: async (options) => {
        captureModes.push(options.mode);
        return await base.capture(options);
      },
      derive: async (options) => {
        derivativeRoles.push(options.roles);
        return await base.derive(options);
      },
      transcribeAudioLocally: async (options) => {
        const attempt = await lstat(options.attemptDirectory);
        expect(attempt.isDirectory()).toBeTrue();
        expect(attempt.mode & 0o777).toBe(0o700);
        expect(await readdir(options.attemptDirectory)).toEqual([]);
        expect(options.audioArtifact.role).toBe("audio");
        expect(options.audioPath).toEndWith(options.audioArtifact.path);
        attempts.push(options.attemptDirectory);
        return successfulLocalTranscript(options);
      },
    };

    const archived = await mediaUrl({
      url: noCaptions.canonicalUrl,
      mode: "archive",
      language: "PT-br",
      libraryDirectory: archiveRoot,
      inheritYtDlpConfig: false,
    }, deps);
    const focused = await mediaUrl({
      url: noCaptions.canonicalUrl,
      mode: "transcript",
      language: "PT-br",
      libraryDirectory: focusedRoot,
      inheritYtDlpConfig: false,
    }, deps);

    expect(captureModes).toEqual(["archive", "audio"]);
    expect(derivativeRoles).toEqual([["video", "audio"], ["audio"]]);
    expect(archived.manifest.transcript).toMatchObject({
      status: "available",
      source: "local",
      language: "pt-br",
      provenance: {
        requestedLanguage: "pt-br",
        runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
        runtimeSha256: readyTranscriber.descriptor.runtimeSha256,
        runtimeDependencyCount: readyTranscriber.descriptor.runtimeDependencyCount,
      },
    });
    expect(archived.warnings).toEqual([]);
    expect(focused.manifest.artifacts.map((artifact) => artifact.role).toSorted()).toEqual([
      "audio",
      "capture",
      "description",
      "provider_metadata",
      "thumbnail",
      "transcript_json",
      "transcript_text",
      "transcript_vtt",
    ]);
    expect(focused.itemDirectory).toContain(join("transcript", "local", "pt-br", "transcriber-v1-"));
    expect(await readFile(join(focused.itemDirectory, "data", "captions", "transcript.txt"), "utf8")).toBe("local words\n");
    expect(await verifyMediaItem(archived.itemDirectory)).toMatchObject({ ok: true });
    expect(await verifyMediaItem(focused.itemDirectory)).toMatchObject({ ok: true });
    for (const itemDirectory of [archived.itemDirectory, focused.itemDirectory]) {
      const persistedManifest = await readFile(join(itemDirectory, "wrench-media.json"), "utf8");
      expect(persistedManifest).not.toContain(readyTranscriber.executablePath);
      expect(persistedManifest).not.toContain(readyTranscriber.modelPath);
      expect(persistedManifest).not.toContain("/fake/lib/libwhisper.dylib");
      expect(persistedManifest).not.toContain("runtimeClosure");
    }
    for (const attempt of attempts) expect(lstat(attempt)).rejects.toThrow();
    expect(lstat(join(archived.itemDirectory, ".tmp"))).rejects.toThrow();
    expect(lstat(join(focused.itemDirectory, ".tmp"))).rejects.toThrow();
  });

  test("rejects descriptor, runtime closure, and provenance drift without promotion", async () => {
    const noCaptions = {
      ...metadata,
      manualCaptionLanguages: [],
      automaticCaptionLanguages: [],
    } satisfies ProbeMetadata;

    for (const failure of [
      "descriptor-drift",
      "runtime-closure-drift",
      "forged-model-provenance",
      "forged-runtime-provenance",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "media-local-integrity-test-"));
      roots.push(root);
      const base = dependencies({ value: 0 }, noCaptions);
      let configurationLoads = 0;
      let localAttempts = 0;
      const deps: MediaArchiveDependencies = {
        ...base,
        loadConfiguredTranscriber: () => {
          configurationLoads += 1;
          return Promise.resolve({
            kind: "ready",
            transcriber: failure === "descriptor-drift" && configurationLoads === 2
              ? {
                  ...readyTranscriber,
                  descriptor: {
                    ...readyTranscriber.descriptor,
                    modelSha256: "d".repeat(64),
                  },
                }
              : failure === "runtime-closure-drift" && configurationLoads === 2
                ? {
                    ...readyTranscriber,
                    runtimeClosure: {
                      ...readyTranscriber.runtimeClosure,
                      dependencies: readyTranscriber.runtimeClosure.dependencies.map(
                        (dependency, index) => index === 0
                          ? { ...dependency, physicalPath: "/replaced/lib/libwhisper.dylib" }
                          : dependency,
                      ),
                    },
                  }
              : readyTranscriber,
          });
        },
        transcribeAudioLocally: (options) => {
          localAttempts += 1;
          const result = successfulLocalTranscript(options);
          return Promise.resolve(failure === "forged-model-provenance"
            ? {
                ...result,
                provenance: {
                  ...result.provenance,
                  modelSha256: "e".repeat(64),
                },
              }
            : failure === "forged-runtime-provenance"
              ? {
                  ...result,
                  provenance: {
                    ...result.provenance,
                    runtimeSha256: "f".repeat(64),
                  },
                }
              : result);
        },
      };

      await expectMediaRejection(mediaUrl({
        url: noCaptions.canonicalUrl,
        mode: "transcript",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, deps), "TRANSCRIPTION_FAILED");
      expect(configurationLoads).toBe(2);
      expect(localAttempts).toBe(
        failure === "descriptor-drift" || failure === "runtime-closure-drift" ? 0 : 1,
      );
      const request: CaptureIdentityRequest = {
        mode: "transcript",
        transcript: {
          kind: "local",
          identity: {
            adapter: "whisper-cpp",
            profile: WRENCH_MEDIA_WHISPER_CPP_PROFILE,
            executableSha256: readyTranscriber.descriptor.executableSha256,
            runtimeProfile: readyTranscriber.descriptor.runtimeProfile,
            runtimeSha256: readyTranscriber.descriptor.runtimeSha256,
            runtimeDependencyCount: readyTranscriber.descriptor.runtimeDependencyCount,
            modelSha256: readyTranscriber.descriptor.modelSha256,
            normalizationProfile: WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
            requestedLanguage: "en",
          },
        },
      };
      await expectRevisionParentEmpty(root, noCaptions, request);
    }
  });

  test("does not promote focused local transcripts when audio or speech is absent", async () => {
    const noCaptions = {
      ...metadata,
      manualCaptionLanguages: [],
      automaticCaptionLanguages: [],
    } satisfies ProbeMetadata;
    for (const outcome of ["no-audio", "no-speech"] as const) {
      const root = await mkdtemp(join(tmpdir(), "media-local-focused-outcome-test-"));
      roots.push(root);
      const base = dependencies({ value: 0 }, noCaptions);
      let localAttempts = 0;
      const deps: MediaArchiveDependencies = {
        ...base,
        loadConfiguredTranscriber: () => Promise.resolve({ kind: "ready", transcriber: readyTranscriber }),
        derive: outcome === "no-audio"
          ? async (options) => {
              const report = await base.derive(options);
              await rm(join(options.derivativesDirectory, "audio.mka"));
              return {
                ...report,
                audio: {
                  role: "audio",
                  path: join(options.derivativesDirectory, "audio.mka"),
                  status: "not-present",
                },
              };
            }
          : base.derive,
        transcribeAudioLocally: (options) => {
          localAttempts += 1;
          return Promise.resolve({
            status: "no-speech",
            language: options.requestedLanguage,
            provenance: localProvenance(options),
          });
        },
      };
      await expectMediaRejection(mediaUrl({
        url: noCaptions.canonicalUrl,
        mode: "transcript",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, deps), "TRANSCRIPT_UNAVAILABLE");
      expect(localAttempts).toBe(outcome === "no-audio" ? 0 : 1);
    }
  });

  test("persists archive fallback outcomes and rejects operational transcription failures", async () => {
    const noCaptions = {
      ...metadata,
      manualCaptionLanguages: [],
      automaticCaptionLanguages: [],
    } satisfies ProbeMetadata;

    for (const outcome of ["no-audio", "no-speech", "failed"] as const) {
      const root = await mkdtemp(join(tmpdir(), "media-local-outcome-test-"));
      roots.push(root);
      let attempts = 0;
      const base = dependencies({ value: 0 }, noCaptions);
      const deps: MediaArchiveDependencies = {
        ...base,
        loadConfiguredTranscriber: () => Promise.resolve({ kind: "ready", transcriber: readyTranscriber }),
        derive: outcome === "no-audio"
          ? async (options) => {
              const report = await base.derive(options);
              await rm(join(options.derivativesDirectory, "audio.mka"));
              return {
                ...report,
                audio: {
                  role: "audio",
                  path: join(options.derivativesDirectory, "audio.mka"),
                  status: "not-present",
                },
              };
            }
          : base.derive,
        transcribeAudioLocally: (options) => {
          attempts += 1;
          if (outcome === "no-speech") {
            return Promise.resolve({
              status: "no-speech",
              language: options.requestedLanguage,
              provenance: localProvenance(options),
            });
          }
          return Promise.resolve({
            status: "failed",
            stage: "transcriber",
            diagnostic: "The local transcriber returned no usable output.",
          });
        },
      };

      if (outcome === "failed") {
        await expectMediaRejection(mediaUrl({
          url: noCaptions.canonicalUrl,
          mode: "archive",
          language: "en",
          libraryDirectory: root,
          inheritYtDlpConfig: false,
        }, deps), "TRANSCRIPTION_FAILED");
        expect(attempts).toBe(1);
        expect(readFile(join(root, noCaptions.extractorDirectory, noCaptions.itemDirectory, "wrench-media.json"))).rejects.toThrow();
        continue;
      }

      const result = await mediaUrl({
        url: noCaptions.canonicalUrl,
        mode: "archive",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, deps);
      expect(result.manifest.transcript).toMatchObject({
        status: "unavailable",
        reason: outcome === "no-audio" ? "audio_not_present" : "no_speech",
      });
      expect(attempts).toBe(outcome === "no-audio" ? 0 : 1);
      expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true });
    }
  });

  test("maps invalid local setup to owned errors before capture", async () => {
    const noCaptions = {
      ...metadata,
      manualCaptionLanguages: [],
      automaticCaptionLanguages: [],
    } satisfies ProbeMetadata;
    for (const mode of ["archive", "transcript"] as const) {
      const root = await mkdtemp(join(tmpdir(), "media-local-config-test-"));
      roots.push(root);
      const captureCalls = { value: 0 };
      const base = dependencies(captureCalls, noCaptions);
      await expectMediaRejection(mediaUrl({
        url: noCaptions.canonicalUrl,
        mode,
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...base,
        loadConfiguredTranscriber: () => Promise.resolve({
          kind: "invalid",
          reason: "model-hash-mismatch",
          message: "The configured whisper.cpp model no longer matches its recorded identity.",
        }),
      }), "DEPENDENCY_MISSING");
      expect(captureCalls.value).toBe(0);
    }

    const invalidLanguageRoot = await mkdtemp(join(tmpdir(), "media-local-language-test-"));
    roots.push(invalidLanguageRoot);
    let configurationLoads = 0;
    const base = dependencies({ value: 0 }, noCaptions);
    await expectMediaRejection(mediaUrl({
      url: noCaptions.canonicalUrl,
      mode: "transcript",
      language: "../model",
      libraryDirectory: invalidLanguageRoot,
      inheritYtDlpConfig: false,
    }, {
      ...base,
      loadConfiguredTranscriber: () => {
        configurationLoads += 1;
        return Promise.resolve({ kind: "ready", transcriber: readyTranscriber });
      },
    }), "TRANSCRIPTION_FAILED");
    expect(configurationLoads).toBe(0);
  });

  test("uses independent focused variants so later enrichment and languages do not conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const physicalRoot = await realpath(root);
    const calls = { value: 0 };
    const deps = dependencies(calls);
    const transcriptEn = await mediaUrl({
      url: "https://www.youtube.com/watch?v=video-id001",
      mode: "transcript",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, deps);
    const archive = await mediaUrl({
      url: "https://www.youtube.com/watch?v=video-id001",
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, deps);
    const transcriptFr = await mediaUrl({
      url: "https://www.youtube.com/watch?v=video-id001",
      mode: "transcript",
      language: "fr",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, {
      ...metadata,
      manualCaptionLanguages: ["en", "fr"],
    }));

    expect(transcriptEn.itemDirectory).not.toBe(archive.itemDirectory);
    expect(transcriptFr.itemDirectory).not.toBe(transcriptEn.itemDirectory);
    expect(dirname(transcriptEn.itemDirectory)).toBe(join(
      physicalRoot,
      metadata.extractorDirectory,
      REVISION_CAPTURE_NAMESPACE,
      metadata.itemDirectory,
      "transcript",
      "manual",
      "en",
    ));
    expect(dirname(transcriptFr.itemDirectory)).toBe(join(
      physicalRoot,
      metadata.extractorDirectory,
      REVISION_CAPTURE_NAMESPACE,
      metadata.itemDirectory,
      "transcript",
      "manual",
      "fr",
    ));
    expect(transcriptEn.manifest.assetKey).toMatch(/^revision-v1-[0-9a-f]{64}$/u);
    expect(transcriptFr.manifest.assetKey).toMatch(/^revision-v1-[0-9a-f]{64}$/u);
    expect(trackedRevisionSubject(transcriptEn.manifest)).toMatch(/^variant-v1-[0-9a-f]{64}$/u);
    expect(trackedRevisionSubject(transcriptFr.manifest)).toMatch(/^variant-v1-[0-9a-f]{64}$/u);
    expect(trackedRevisionSubject(transcriptEn.manifest)).not.toBe(
      trackedRevisionSubject(transcriptFr.manifest),
    );
    expect(trackedRevisionSubject(archive.manifest)).toBe(metadata.assetKey);
    expect(calls.value).toBe(3);
    expect(await verifyMediaItem(transcriptEn.itemDirectory)).toMatchObject({ ok: true });
    expect(await verifyMediaItem(archive.itemDirectory)).toMatchObject({ ok: true });
    expect(await verifyMediaItem(transcriptFr.itemDirectory)).toMatchObject({ ok: true });
  });

  test("keys transcript variants by selected language and source quality", async () => {
    const fallbackRoot = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    const qualityRoot = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(fallbackRoot, qualityRoot);
    const calls = { value: 0 };

    const fallback = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "transcript",
      language: "en",
      libraryDirectory: fallbackRoot,
      inheritYtDlpConfig: false,
    }, dependencies(calls, {
      ...metadata,
      manualCaptionLanguages: ["de"],
    }));
    const exact = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "transcript",
      language: "en",
      libraryDirectory: fallbackRoot,
      inheritYtDlpConfig: false,
    }, dependencies(calls, {
      ...metadata,
      manualCaptionLanguages: ["de", "en"],
    }));
    expect(fallback.status).toBe("created");
    expect(exact.status).toBe("created");
    expect(dirname(fallback.itemDirectory)).toEndWith(join("transcript", "manual", "de"));
    expect(dirname(exact.itemDirectory)).toEndWith(join("transcript", "manual", "en"));
    expect(fallback.manifest.transcript).toMatchObject({ source: "manual", language: "de" });
    expect(exact.manifest.transcript).toMatchObject({ source: "manual", language: "en" });

    const automatic = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "transcript",
      language: "en",
      libraryDirectory: qualityRoot,
      inheritYtDlpConfig: false,
    }, dependencies(calls, {
      ...metadata,
      manualCaptionLanguages: [],
      automaticCaptionLanguages: ["en"],
    }));
    const manual = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "transcript",
      language: "en",
      libraryDirectory: qualityRoot,
      inheritYtDlpConfig: false,
    }, dependencies(calls, {
      ...metadata,
      manualCaptionLanguages: ["en"],
      automaticCaptionLanguages: ["en"],
    }));
    expect(automatic.status).toBe("created");
    expect(manual.status).toBe("created");
    expect(dirname(automatic.itemDirectory)).toEndWith(join("transcript", "automatic", "en"));
    expect(dirname(manual.itemDirectory)).toEndWith(join("transcript", "manual", "en"));
    expect(automatic.manifest.transcript).toMatchObject({ source: "automatic", language: "en" });
    expect(manual.manifest.transcript).toMatchObject({ source: "manual", language: "en" });
  });

  test("keeps a focused capture disjoint from a legitimate suffix-shaped provider ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const physicalRoot = await realpath(root);
    const calls = { value: 0 };
    const suffixMetadata = providerMetadata("Generic", "video-1--transcript-en");

    const focused = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "transcript",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, metadata));
    const raw = await mediaUrl({
      url: suffixMetadata.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, suffixMetadata));

    expect(dirname(focused.itemDirectory)).toBe(join(
      physicalRoot,
      metadata.extractorDirectory,
      REVISION_CAPTURE_NAMESPACE,
      metadata.itemDirectory,
      "transcript",
      "manual",
      "en",
    ));
    expect(dirname(raw.itemDirectory)).toBe(join(
      physicalRoot,
      suffixMetadata.extractorDirectory,
      REVISION_CAPTURE_NAMESPACE,
      suffixMetadata.itemDirectory,
      "archive",
    ));
    expect(focused.manifest.assetKey).not.toBe(raw.manifest.assetKey);
    expect(focused.manifest.source.id).toBe(metadata.id);
    expect(raw.manifest.source.id).toBe(suffixMetadata.id);
    expect(calls.value).toBe(2);
    expect(await verifyMediaItem(focused.itemDirectory)).toMatchObject({ ok: true });
    expect(await verifyMediaItem(raw.itemDirectory)).toMatchObject({ ok: true });
  });

  test("keeps opaque raw extractor tuples disjoint without mislabeling provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const plus = providerMetadata("A+B", "same");
    const space = providerMetadata("A B", "same");

    const plusResult = await mediaUrl({
      url: plus.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, plus));
    const spaceResult = await mediaUrl({
      url: space.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, space));

    expect(plus.extractorDirectory).toBe(space.extractorDirectory);
    expect(plus.assetKey).not.toBe(space.assetKey);
    expect(plus.id).not.toBe(space.id);
    expect(plus.itemDirectory).not.toBe(space.itemDirectory);
    expect(plusResult.itemDirectory).not.toBe(spaceResult.itemDirectory);
    expect(plusResult.manifest.source.extractor).toBe("External");
    expect(spaceResult.manifest.source.extractor).toBe("External");
    expect(calls.value).toBe(2);

    const aliasedSource: ProbeMetadata = {
      ...plus,
      assetKey: sourceAssetKey(
        plus.acquisitionIdentity.extractor,
        "different-raw-source",
      ),
    };
    expect(mediaUrl({
      url: "https://example.com/different-raw-source",
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, aliasedSource))).rejects.toMatchObject({
      code: "PROBE_FAILED",
    });
    expect(calls.value).toBe(2);
  });

  test("archives case-distinct provider IDs into distinct portable final paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const upper = providerMetadata("Youtube", "AbCdefghijk");
    const lower = providerMetadata("Youtube", "abcdefghijk");

    const upperResult = await mediaUrl({
      url: upper.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, upper));
    const lowerResult = await mediaUrl({
      url: lower.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies(calls, lower));

    expect(upper.itemDirectory).not.toBe(lower.itemDirectory);
    expect(upper.itemDirectory.toLowerCase()).not.toBe(lower.itemDirectory.toLowerCase());
    expect(upperResult.itemDirectory).not.toBe(lowerResult.itemDirectory);
    expect(upperResult.manifest.source.id).toBe("AbCdefghijk");
    expect(lowerResult.manifest.source.id).toBe("abcdefghijk");
    expect(await verifyMediaItem(upperResult.itemDirectory)).toMatchObject({ ok: true });
    expect(await verifyMediaItem(lowerResult.itemDirectory)).toMatchObject({ ok: true });
    expect(calls.value).toBe(2);
  });

  test("uses structural revision staging and lock namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const physicalRoot = await realpath(root);
    const identity = revisionLineageIdentity(metadata, { mode: "audio" });
    expect(identity.storagePathSegments).toEqual([
      REVISION_CAPTURE_NAMESPACE,
      metadata.assetKey,
      "audio",
    ]);
    const lockLeaf = identity.storagePathSegments.at(-1);
    if (lockLeaf === undefined) throw new Error("missing lock leaf");
    const lockPath = join(
      physicalRoot,
      ".wrench-media-locks",
      ...identity.storagePathSegments.slice(0, -1),
      `${lockLeaf}.lock`,
    );
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "", { mode: 0o600 });

    expect(mediaUrl({
      url: metadata.canonicalUrl,
      mode: "audio",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies({ value: 0 }, metadata))).rejects.toMatchObject({
      code: "BUSY",
      details: { lockPath },
    });
  });

  test("rejects symlinked revision namespace parents at every archive boundary", async () => {
    for (const boundary of ["final", "staging", "locks"] as const) {
      const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
      roots.push(root);
      const outside = join(root, "outside");
      await mkdir(outside);
      const base = boundary === "final"
        ? join(root, metadata.extractorDirectory)
        : join(root, boundary === "staging" ? ".wrench-media-staging" : ".wrench-media-locks");
      await mkdir(base, { recursive: true });
      await symlink("../outside", join(base, REVISION_CAPTURE_NAMESPACE));
      const calls = { value: 0 };

      expect(mediaUrl({
        url: metadata.canonicalUrl,
        mode: "transcript",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, dependencies(calls, metadata))).rejects.toMatchObject({ code: "IO_ERROR" });
      expect(calls.value).toBe(0);
    }
  });

  test("safely restarts after crash-left control temps and unverified media", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const lineage = revisionLineageIdentity(metadata, { mode: "archive" });
    const stagingItem = join(root, ".wrench-media-staging", ...lineage.storagePathSegments);
    await mkdir(stagingItem, { recursive: true });
    const staleUuid = "11111111-2222-4333-8444-555555555555";
    await writeFile(join(stagingItem, `wrench-media.json.tmp-${staleUuid}`), "partial manifest");
    await writeFile(
      join(stagingItem, `manifest-sha256.txt.tmp-${staleUuid}`),
      "partial checksums",
    );
    await mkdir(join(stagingItem, "data", "capture"), { recursive: true });
    await writeFile(
      join(stagingItem, "data", "capture", "media.webm"),
      "crash-left-unverified-media",
    );

    const result = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies({ value: 0 }, metadata));

    expect(result.status).toBe("created");
    expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true });
    expect(await readFile(
      join(result.itemDirectory, "data", "capture", "media.webm"),
      "utf8",
    )).toBe("original-media");
    expect(readFile(join(result.itemDirectory, `wrench-media.json.tmp-${staleUuid}`))).rejects.toThrow();
    expect(
      readFile(join(result.itemDirectory, `manifest-sha256.txt.tmp-${staleUuid}`)),
    ).rejects.toThrow();
  });

  test("reclaims an interrupted stale lock and safely restarts capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-archive-test-"));
    roots.push(root);
    const lockRoot = join(root, ".wrench-media-locks");
    await mkdir(lockRoot, { recursive: true });
    const lockPath = join(lockRoot, `${metadata.assetKey}.lock`);
    await writeFile(lockPath, "", { mode: 0o600 });
    const stale = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockPath, stale, stale);

    const result = await mediaUrl({
      url: "https://www.youtube.com/watch?v=video-id001",
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, dependencies({ value: 0 }));
    expect(result.status).toBe("created");
    expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true });
  });

  test("maps finite-source boundary rejections to unsupported without capturing", async () => {
    const fixtures = [
      { reason: "playlist", envelope: { _type: "playlist" } },
      { reason: "live", envelope: { is_live: true } },
      { reason: "upcoming", envelope: { live_status: "is_upcoming" } },
      { reason: "post-live", envelope: { live_status: "post_live" } },
      { reason: "drm", envelope: { has_drm: true } },
    ] as const;

    for (const { reason, envelope } of fixtures) {
      const root = await mkdtemp(join(tmpdir(), "media-unsupported-source-test-"));
      roots.push(root);
      const url = `https://example.com/adaptive/${reason}`;
      const parsed = parseProbeMetadata({
        id: "shared-provider-id",
        extractor: "Generic",
        webpage_url: url,
        ...envelope,
      }, url);
      if (parsed.ok || parsed.kind !== "unsupported") {
        throw new Error(`fixture did not produce an unsupported ${reason} result`);
      }
      expect(parsed.reason).toBe(reason);
      let captureCalls = 0;
      const base = dependencies({ value: 0 });

      try {
        await mediaUrl({
          url,
          mode: "archive",
          language: "en",
          libraryDirectory: root,
          inheritYtDlpConfig: false,
        }, {
          ...base,
          probe: () => Promise.resolve(parsed),
          capture: () => {
            captureCalls += 1;
            return Promise.reject(new Error("capture must not run for unsupported input"));
          },
        });
        throw new Error("expected unsupported source rejection");
      } catch (error) {
        expect(error).toMatchObject({
          code: "UNSUPPORTED_SOURCE",
          details: { reason },
        });
      }

      expect(captureCalls).toBe(0);
      expect((await readdir(root)).filter((entry) => !entry.startsWith("."))).toEqual([]);
    }
  });

  test("isolates equal Generic tuples by exact requested URL through item, staging, and lock identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-opaque-url-identity-test-"));
    roots.push(root);
    const physicalRoot = await realpath(root);
    const urls = [
      "https://example.com/adaptive/alpha",
      "https://example.com/adaptive/beta?variant=two",
    ] as const;
    const metadataByUrl = new Map<string, ProbeMetadata>();
    for (const url of urls) {
      const parsed = parseProbeMetadata({
        id: "index",
        extractor: "Generic",
        webpage_url: url,
        subtitles: { en: [{}] },
      }, url);
      if (!parsed.ok) throw new Error(parsed.message);
      metadataByUrl.set(url, parsed.metadata);
    }
    const firstMetadata = metadataByUrl.get(urls[0]);
    const secondMetadata = metadataByUrl.get(urls[1]);
    if (firstMetadata === undefined || secondMetadata === undefined) {
      throw new Error("missing opaque URL identity fixtures");
    }
    expect(firstMetadata.acquisitionIdentity).toEqual(secondMetadata.acquisitionIdentity);
    expect(firstMetadata.assetKey).not.toBe(secondMetadata.assetKey);
    expect(firstMetadata.id).not.toBe(secondMetadata.id);

    let enteredCount = 0;
    let markBothEntered: (() => void) | undefined;
    let releaseCaptures: (() => void) | undefined;
    const bothEntered = new Promise<void>((resolveEntered) => {
      markBothEntered = resolveEntered;
    });
    const released = new Promise<void>((resolveReleased) => {
      releaseCaptures = resolveReleased;
    });
    const base = dependencies({ value: 0 });
    const deps: MediaArchiveDependencies = {
      ...base,
      probe: (options) => {
        const selected = metadataByUrl.get(options.url);
        return selected === undefined
          ? Promise.resolve({ ok: false, diagnostic: "unknown fixture URL" })
          : Promise.resolve({ ok: true, metadata: selected });
      },
      capture: async (options) => {
        const selected = metadataByUrl.get(options.url);
        if (selected === undefined) return { ok: false, diagnostic: "unknown fixture URL" };
        await mkdir(options.captureDirectory, { recursive: true });
        await writeFile(join(options.captureDirectory, "media.webm"), `media:${selected.assetKey}`);
        await writeFile(join(options.captureDirectory, "media.info.json"), "{}\n");
        await writeFile(join(options.captureDirectory, "media.en.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nwords\n");
        enteredCount += 1;
        if (enteredCount === urls.length) markBothEntered?.();
        await released;
        return {
          ok: true,
          identity: { ...selected.acquisitionIdentity, ext: "webm" },
        };
      },
    };
    const optionsFor = (url: string) => ({
      url,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    });
    const pending = urls.map((url) => mediaUrl(optionsFor(url), deps));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const enteredBeforeRelease = await Promise.race([
      bothEntered.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), 1_000);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);

    if (enteredBeforeRelease) {
      for (const source of [firstMetadata, secondMetadata]) {
        const identity = revisionLineageIdentity(source, { mode: "archive" });
        expect(await lstat(join(
          physicalRoot,
          ".wrench-media-staging",
          ...identity.storagePathSegments,
        ))).toMatchObject({});
        const leaf = identity.storagePathSegments.at(-1);
        if (leaf === undefined) throw new Error("missing storage identity leaf");
        expect(await lstat(join(
          physicalRoot,
          ".wrench-media-locks",
          ...identity.storagePathSegments.slice(0, -1),
          `${leaf}.lock`,
        ))).toMatchObject({});
      }
    }
    releaseCaptures?.();
    const settled = await Promise.allSettled(pending);

    expect(enteredBeforeRelease).toBeTrue();
    expect(settled.every((result) => result.status === "fulfilled")).toBeTrue();
    const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(results).toHaveLength(2);
    expect(results[0]?.itemDirectory).not.toBe(results[1]?.itemDirectory);
    expect(results.map((result) => trackedRevisionSubject(result.manifest)).toSorted()).toEqual(
      [firstMetadata.assetKey, secondMetadata.assetKey].toSorted(),
    );
    for (const result of results) {
      expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true });
    }
  });

  test("rejects wrong primary names, unclaimed files, and directories without promotion", async () => {
    const fixtures = [
      {
        label: "wrong-primary",
        expectedCode: "ARCHIVE_CONFLICT",
        mutate: async (captureDirectory: string) => {
          await rm(join(captureDirectory, "media.webm"));
          await writeFile(join(captureDirectory, "media.mp4"), "wrong-primary");
        },
      },
      {
        label: "extra-file",
        expectedCode: "ARCHIVE_CONFLICT",
        mutate: async (captureDirectory: string) => {
          await writeFile(join(captureDirectory, "unexpected.bin"), "extra");
        },
      },
      {
        label: "directory",
        expectedCode: "IO_ERROR",
        mutate: async (captureDirectory: string) => {
          await mkdir(join(captureDirectory, "unexpected-directory"));
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const root = await mkdtemp(join(tmpdir(), `media-capture-ownership-${fixture.label}-`));
      roots.push(root);
      const base = dependencies({ value: 0 });
      await expectMediaRejection(mediaUrl({
        url: metadata.canonicalUrl,
        mode: "archive",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...base,
        capture: async (options) => {
          const result = await base.capture(options);
          await fixture.mutate(options.captureDirectory);
          return result;
        },
      }), fixture.expectedCode);

      await expectRevisionParentEmpty(root, metadata, { mode: "archive" });
    }
  });

  test("cleans a cancelled yt-dlp attempt and permits a stable retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-yt-dlp-cancel-test-"));
    roots.push(root);
    const controller = new AbortController();
    const base = dependencies({ value: 0 });
    let attempts = 0;
    const deps: MediaArchiveDependencies = {
      ...base,
      capture: (options) => {
        attempts += 1;
        if (attempts === 1) {
          expect(options.signal).toBe(controller.signal);
          controller.abort();
          return Promise.resolve({
            ok: false,
            diagnostic: "capture cancelled",
            processReason: "aborted",
          });
        }
        return base.capture(options);
      },
    };
    const options = {
      url: metadata.canonicalUrl,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    await expectMediaRejection(mediaUrl({ ...options, signal: controller.signal }, deps), "CANCELLED");

    const identity = revisionLineageIdentity(metadata, { mode: "archive" });
    const leaf = identity.storagePathSegments.at(-1);
    if (leaf === undefined) throw new Error("missing storage identity leaf");
    expect(lstat(join(root, ".wrench-media-staging", ...identity.storagePathSegments))).rejects.toMatchObject({ code: "ENOENT" });
    expect(lstat(join(
      root,
      ".wrench-media-locks",
      ...identity.storagePathSegments.slice(0, -1),
      `${leaf}.lock`,
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expectRevisionParentEmpty(root, metadata, { mode: "archive" });

    const retried = await mediaUrl(options, deps);
    expect(retried.status).toBe("created");
    expect(attempts).toBe(2);
    expect(await verifyMediaItem(retried.itemDirectory)).toMatchObject({ ok: true });
  });
});

function directMediaBody(marker: number): Uint8Array {
  const body = new Uint8Array(64);
  new DataView(body.buffer).setUint32(0, 16, false);
  body.set(new TextEncoder().encode("ftyp"), 4);
  body[16] = marker;
  return body;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function expectMediaRejection(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected Wrench media archive rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function directProbe(
  url: string,
  body: Uint8Array,
  media: DirectHttpMedia = directHttpMediaForContainer("iso-bmff"),
): DirectHttpProbe {
  const requested = new URL(url);
  requested.hash = "";
  const effective = new URL(`https://cdn.example/private/media.${media.extension}`);
  effective.searchParams.set("signature", `transport-secret-${String(body[16] ?? 0)}`);
  const rawEtag = `"validator-secret-${String(body[16] ?? 0)}"`;
  return {
    transport: new DirectHttpProbeTransport(requested.href),
    publicOrigin: `${requested.origin}/`,
    requestedUrlSha256: sha256(requested.href),
    effectiveUrlSha256: sha256(effective.href),
    redirectCount: 1,
    declaredMediaType: media.mediaType,
    lastModified: "Mon, 21 Jul 2025 12:34:56 GMT",
    validator: { strength: "strong", sha256: sha256(rawEtag) },
    media,
    expectedBytes: body.byteLength,
  };
}

async function completeDirectCapture(
  probe: DirectHttpProbe,
  sink: DirectHttpCaptureSink,
  body: Uint8Array,
  reportedSha256 = sha256(body),
) {
  await sink.write(body);
  await sink.close();
  return {
    ok: true,
    capture: {
      bytes: body.byteLength,
      sha256: reportedSha256,
      media: probe.media,
      provenance: {
        requestedUrlSha256: probe.requestedUrlSha256,
        effectiveUrlSha256: probe.effectiveUrlSha256,
        validator: probe.validator,
        lastModified: probe.lastModified,
        declaredMediaType: probe.declaredMediaType,
        container: probe.media.container,
        body: { bytes: body.byteLength, sha256: reportedSha256 },
        redirectCount: probe.redirectCount,
      },
      attempts: 1,
      resumed: false,
    },
  } as const;
}

function directDependencies(
  body: () => Uint8Array,
  directCaptureCalls: { value: number },
): MediaArchiveDependencies {
  const base = dependencies({ value: 0 });
  return {
    ...base,
    findExecutable: (name) => Promise.resolve(name === "yt-dlp" ? null : `/fake/${name}`),
    probe: () => Promise.reject(new Error("yt-dlp probe must not run for direct media")),
    capture: () => Promise.reject(new Error("yt-dlp capture must not run for direct media")),
    ytDlpVersion: () => Promise.reject(new Error("yt-dlp version must not run for direct media")),
    probeDirectHttp: (url) => Promise.resolve({ ok: true, probe: directProbe(url, body()) }),
    captureDirectHttp: async (probe, sink) => {
      directCaptureCalls.value += 1;
      return await completeDirectCapture(probe, sink, body());
    },
  };
}

describe("direct HTTP archive routing", () => {
  test("creates and verifies direct media without discovering yt-dlp", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const body = directMediaBody(1);
    const result = await mediaUrl({
      url: "https://example.com/private/media.mp4?token=request-secret#local-fragment",
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, directDependencies(() => body, calls));

    expect(result.status).toBe("created");
    expect(result.manifest.artifacts.map((artifact) => artifact.role).toSorted()).toEqual([
      "audio",
      "capture",
      "provider_metadata",
      "video",
    ]);
    expect(result.manifest).toMatchObject({
      schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
      source: { extractor: "External", canonicalUrl: "https://example.com/" },
      authentication: { mode: "public" },
      acquisition: {
        adapter: "direct-http",
        provenance: {
          requestedUrlSha256: sha256("https://example.com/private/media.mp4?token=request-secret"),
          container: "iso-bmff",
          body: { bytes: body.byteLength, sha256: sha256(body) },
        },
      },
      transcript: { status: "unavailable", reason: "transcriber_not_configured" },
    });
    expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({
      ok: true,
      checkedArtifacts: 4,
    });
    expect([...await readFile(join(result.itemDirectory, "data", "capture", "media.mp4"))]).toEqual([...body]);
    const persisted = `${await readFile(join(result.itemDirectory, "wrench-media.json"), "utf8")}\n${await readFile(join(result.itemDirectory, "data", "metadata", "provider.json"), "utf8")}`;
    for (const secret of [
      "private/media.mp4",
      "request-secret",
      "local-fragment",
      "transport-secret",
      "validator-secret",
    ]) expect(persisted).not.toContain(secret);
    expect(calls.value).toBe(1);
  });

  test("preserves exact owned media types for Ogg and MPEG transport-stream captures", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const oggBody = new Uint8Array(64);
    oggBody.set(new TextEncoder().encode("OggS"));
    const transportBody = new Uint8Array(4 * 188);
    for (let packet = 0; packet < 4; packet += 1) {
      const offset = packet * 188;
      transportBody[offset] = 0x47;
      transportBody[offset + 3] = 0x10;
    }
    const fixtures = [
      { body: oggBody, media: directHttpMediaForContainer("ogg") },
      { body: transportBody, media: directHttpMediaForContainer("mpeg-ts") },
    ] as const;

    for (const { body, media } of fixtures) {
      expect(detectDirectHttpMedia(body)).toEqual(media);
      const calls = { value: 0 };
      const url = `https://example.com/media.${media.extension}`;
      const base = directDependencies(() => body, calls);
      const result = await mediaUrl({
        url,
        mode: "video",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...base,
        probeDirectHttp: () => Promise.resolve({
          ok: true,
          probe: directProbe(url, body, media),
        }),
      });

      expect(result.status).toBe("created");
      expect(result.manifest.artifacts.find(({ role }) => role === "capture")).toMatchObject({
        path: `data/capture/media.${media.extension}`,
        mediaType: media.mediaType,
      });
      expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true });
      expect(calls.value).toBe(1);
    }
  });

  test("re-captures before returning an identical immutable item and separates changed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    let body = directMediaBody(2);
    const deps = directDependencies(() => body, calls);
    const options = {
      url: "https://example.com/mutable/media.mp4?token=private",
      mode: "audio" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    const first = await mediaUrl(options, deps);
    const identical = await mediaUrl(options, deps);
    expect(first.status).toBe("created");
    expect(identical.status).toBe("existing");
    expect(identical.itemDirectory).toBe(first.itemDirectory);
    expect(calls.value).toBe(2);

    body = directMediaBody(3);
    const changed = await mediaUrl(options, deps);
    expect(changed.status).toBe("created");
    expect(changed.itemDirectory).not.toBe(first.itemDirectory);
    expect(changed.manifest.assetKey).not.toBe(first.manifest.assetKey);
    expect(calls.value).toBe(3);
  });

  test("returns an identical verified item even when media tools disappear", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const body = directMediaBody(20);
    const options = {
      url: "https://example.com/cache/media.mp4?token=private",
      mode: "audio" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    const available = directDependencies(() => body, calls);
    const first = await mediaUrl(options, available);
    const unavailable: MediaArchiveDependencies = {
      ...available,
      findExecutable: () => Promise.resolve(null),
      derive: () => Promise.reject(new Error("derivation must not run for an existing item")),
      ffmpegVersion: () => Promise.reject(new Error("version lookup must not run for an existing item")),
    };
    const existing = await mediaUrl(options, unavailable);
    expect(existing).toMatchObject({ status: "existing", itemDirectory: first.itemDirectory });
    expect(calls.value).toBe(2);

    await expectMediaRejection(mediaUrl(
      options,
      { ...unavailable, captureDirectHttp: async (probe, sink) =>
        await completeDirectCapture(probe, sink, directMediaBody(21)) },
    ), "DEPENDENCY_MISSING");
    expect(lstat(join(
      root,
      ".wrench-media-staging",
      DIRECT_HTTP_CAPTURE_NAMESPACE,
      sha256(options.url),
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("redacts returned and thrown direct probe diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const url = "https://example.com/private-path-token/media.mp4?token=encoded%20secret";
    const forbidden = [
      url,
      "private-path-token",
      "encoded%20secret",
      "encoded secret",
      "opaque-validator-only-secret",
    ];
    const base = dependencies({ value: 0 });
    const adapters = [
      () => Promise.resolve({
        ok: false as const,
        kind: "error" as const,
        error: {
          code: "network" as const,
          message: `probe exposed ${url} private-path-token encoded%20secret encoded secret opaque-validator-only-secret`,
        },
      }),
      () => Promise.reject(new Error(
        `probe threw ${url} private-path-token encoded%20secret encoded secret opaque-validator-only-secret`,
      )),
    ];
    for (const probeDirectHttp of adapters) {
      try {
        await mediaUrl({
          url,
          mode: "video",
          language: "en",
          libraryDirectory: root,
          inheritYtDlpConfig: false,
        }, { ...base, probeDirectHttp });
        throw new Error("expected probe failure");
      } catch (error) {
        expect(error).toBeInstanceOf(MediaArchiveError);
        if (!(error instanceof MediaArchiveError)) throw error;
        const diagnostic = `${error.message}\n${JSON.stringify(error.details)}\n${JSON.stringify(error)}`;
        for (const secret of forbidden) expect(diagnostic).not.toContain(secret);
      }
    }
  });

  test("redacts direct capture failures and rejects forged media paths before opening a sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const body = directMediaBody(22);
    const url = "https://example.com/private-capture-token/media.mp4?token=decoded%20capture";
    const base = directDependencies(() => body, { value: 0 });
    try {
      await mediaUrl({
        url,
        mode: "video",
        language: "en",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...base,
        captureDirectHttp: () => Promise.resolve({
          ok: false,
          error: {
            code: "transport",
            message: `capture exposed ${url} private-capture-token decoded%20capture decoded capture opaque-cdn-only-secret`,
          },
        }),
      });
      throw new Error("expected capture failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaArchiveError);
      if (!(error instanceof MediaArchiveError)) throw error;
      const diagnostic = `${error.message}\n${JSON.stringify(error.details)}\n${JSON.stringify(error)}`;
      for (const secret of [
        url,
        "private-capture-token",
        "decoded%20capture",
        "decoded capture",
        "opaque-cdn-only-secret",
      ]) {
        expect(diagnostic).not.toContain(secret);
      }
    }

    let captures = 0;
    const forged = directProbe(url, body);
    const forgedProbe = {
      ...forged,
      media: { ...forged.media, extension: "../../escape" },
    } as unknown as DirectHttpProbe;
    await expectMediaRejection(mediaUrl({
      url,
      mode: "video",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, {
      ...base,
      probeDirectHttp: () => Promise.resolve({ ok: true, probe: forgedProbe }),
      captureDirectHttp: () => {
        captures += 1;
        return Promise.reject(new Error("must not capture"));
      },
    }), "PROBE_FAILED");
    expect(captures).toBe(0);
  });

  test("keeps transcript probes bounded and authenticated requests on yt-dlp", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const calls = { value: 0 };
    const body = directMediaBody(4);
    const deps = directDependencies(() => body, calls);
    await expectMediaRejection(mediaUrl({
      url: "https://example.com/media.mp4",
      mode: "transcript",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, deps), "TRANSCRIPT_UNAVAILABLE");
    expect(calls.value).toBe(0);

    let directProbes = 0;
    const contextSha256 = authContextSha256("personal");
    const parsedAuthenticated = parseProbeMetadata({
      id: "video-id001",
      extractor: "Youtube",
      webpage_url: metadata.canonicalUrl,
      subtitles: { en: [{}] },
    }, metadata.canonicalUrl, {
      mode: "browser",
      contextSha256,
    });
    if (!parsedAuthenticated.ok) throw new Error(parsedAuthenticated.message);
    const yt = dependencies({ value: 0 }, parsedAuthenticated.metadata);
    const authenticated = await mediaUrl({
      url: metadata.canonicalUrl,
      mode: "archive",
      language: "en",
      libraryDirectory: root,
      browser: "safari",
      authContext: "personal",
      inheritYtDlpConfig: false,
    }, {
      ...yt,
      probeDirectHttp: () => {
        directProbes += 1;
        return Promise.resolve({ ok: false, kind: "not-applicable", reason: "unrecognized-media" });
      },
    });
    expect(authenticated.status).toBe("created");
    expect(authenticated.manifest.authentication).toEqual({
      mode: "browser",
      context: {
        profile: "wrench-media-auth-context-v1",
        sha256: contextSha256,
      },
    });
    expect(directProbes).toBe(0);
  });

  test("captures direct media for focused and archive local transcription", async () => {
    for (const mode of ["transcript", "archive"] as const) {
      const root = await mkdtemp(join(tmpdir(), "media-direct-local-test-"));
      roots.push(root);
      const calls = { value: 0 };
      const body = directMediaBody(mode === "transcript" ? 31 : 32);
      const base = directDependencies(() => body, calls);
      let localAttempts = 0;
      const result = await mediaUrl({
        url: `https://example.com/${mode}/media.mp4`,
        mode,
        language: "EN",
        libraryDirectory: root,
        inheritYtDlpConfig: false,
      }, {
        ...base,
        loadConfiguredTranscriber: () => Promise.resolve({
          kind: "ready",
          transcriber: readyTranscriber,
        }),
        transcribeAudioLocally: (options) => {
          localAttempts += 1;
          return Promise.resolve(successfulLocalTranscript(options));
        },
      });

      expect(calls.value).toBe(1);
      expect(localAttempts).toBe(1);
      expect(result.manifest.transcript).toMatchObject({
        status: "available",
        source: "local",
        language: "en",
        provenance: { requestedLanguage: "en" },
      });
      expect(result.manifest.artifacts.map((artifact) => artifact.role)).toContain("capture");
      expect(result.manifest.artifacts.map((artifact) => artifact.role)).toContain("audio");
      expect(result.manifest.artifacts.map((artifact) => artifact.role).includes("video")).toBe(mode === "archive");
      expect(await verifyMediaItem(result.itemDirectory)).toMatchObject({ ok: true });
    }
  });

  test("rejects adapter/file digest disagreement without promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const body = directMediaBody(5);
    const base = directDependencies(() => body, { value: 0 });
    await expectMediaRejection(mediaUrl({
      url: "https://example.com/media.mp4?secret=digest",
      mode: "video",
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    }, {
      ...base,
      captureDirectHttp: async (probe, sink) =>
        await completeDirectCapture(probe, sink, body, "0".repeat(64)),
    }), "CAPTURE_FAILED");
    expect((await readdir(root)).filter((name) => !name.startsWith(".wrench-media-"))).toEqual([]);
  });

  test("serializes the same mutable request under its provisional lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-archive-test-"));
    roots.push(root);
    const body = directMediaBody(6);
    const base = directDependencies(() => body, { value: 0 });
    let releaseCapture: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
    const release = new Promise<void>((resolveRelease) => { releaseCapture = resolveRelease; });
    const deps: MediaArchiveDependencies = {
      ...base,
      captureDirectHttp: async (probe, sink) => {
        markEntered?.();
        await release;
        return await completeDirectCapture(probe, sink, body);
      },
    };
    const options = {
      url: "https://example.com/mutable.mp4?secret=lock",
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    const first = mediaUrl(options, deps);
    await entered;
    await expectMediaRejection(mediaUrl(options, deps), "BUSY");
    releaseCapture?.();
    expect((await first).status).toBe("created");
  });

  test("cleans a cancelled direct attempt and permits a stable retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-direct-cancel-test-"));
    roots.push(root);
    const body = directMediaBody(42);
    const url = "https://example.com/cancel/media.mp4?token=private";
    const controller = new AbortController();
    const base = directDependencies(() => body, { value: 0 });
    let attempts = 0;
    const deps: MediaArchiveDependencies = {
      ...base,
      captureDirectHttp: (probe, sink, options) => {
        attempts += 1;
        if (attempts === 1) {
          expect(options?.signal).toBe(controller.signal);
          controller.abort();
          return Promise.resolve({
            ok: false,
            error: { code: "aborted", message: "direct capture cancelled" },
          });
        }
        return base.captureDirectHttp(probe, sink, options);
      },
    };
    const options = {
      url,
      mode: "archive" as const,
      language: "en",
      libraryDirectory: root,
      inheritYtDlpConfig: false,
    };
    await expectMediaRejection(mediaUrl({ ...options, signal: controller.signal }, deps), "CANCELLED");

    const requestSha = sha256(url);
    expect(lstat(join(
      root,
      ".wrench-media-staging",
      DIRECT_HTTP_CAPTURE_NAMESPACE,
      requestSha,
    ))).rejects.toMatchObject({ code: "ENOENT" });
    expect(lstat(join(
      root,
      ".wrench-media-locks",
      DIRECT_HTTP_CAPTURE_NAMESPACE,
      `${requestSha}.lock`,
    ))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((entry) => !entry.startsWith("."))).toEqual([]);

    const retried = await mediaUrl(options, deps);
    expect(retried.status).toBe("created");
    expect(attempts).toBe(2);
    expect(await verifyMediaItem(retried.itemDirectory)).toMatchObject({ ok: true });
  });
});
