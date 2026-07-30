import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  FOCUSED_CAPTURE_NAMESPACE,
  captureIdentity,
  revisionLineageIdentity,
} from "./archive";
import {
  WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
  WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
  WRENCH_MEDIA_WHISPER_CPP_PROFILE,
} from "./manifest";
import { parseProbeMetadata } from "./metadata";
import { REVISION_CAPTURE_NAMESPACE } from "./revision";

function metadataFor(id: string) {
  const parsed = parseProbeMetadata(
    {
      id,
      extractor_key: "Generic",
      webpage_url: "https://example.com/item",
      subtitles: { en: [{}] },
    },
    "https://example.com/item",
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.metadata;
}

function hasIdentityControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) return true;
  }
  return false;
}

test("property: raw and focused identities occupy disjoint structural namespaces", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 128 }).filter((value) => !hasIdentityControl(value)),
      fc.string({ minLength: 1, maxLength: 64 }),
      (id, language) => {
        const metadata = metadataFor(id);
        const archive = captureIdentity(metadata, { mode: "archive" });
        const audio = captureIdentity(metadata, { mode: "audio" });
        const video = captureIdentity(metadata, { mode: "video" });
        const transcript = captureIdentity(
          metadata,
          {
            mode: "transcript",
            transcript: { kind: "provider", source: "manual", language },
          },
        );

        expect(archive.itemPathSegments[0]).not.toBe(FOCUSED_CAPTURE_NAMESPACE);
        for (const focused of [audio, video, transcript]) {
          expect(focused.itemPathSegments[0]).toBe(FOCUSED_CAPTURE_NAMESPACE);
          expect(focused.storagePathSegments[0]).toBe(FOCUSED_CAPTURE_NAMESPACE);
          expect(focused.assetKey).toMatch(/^variant-v1-[0-9a-f]{64}$/u);
          expect(focused.itemPathSegments).not.toEqual(archive.itemPathSegments);
        }
        expect(new Set([archive.assetKey, audio.assetKey, video.assetKey, transcript.assetKey]).size).toBe(4);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: every capture subject has one disjoint revision lineage", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 128 }).filter((value) => !hasIdentityControl(value)),
      fc.string({ minLength: 1, maxLength: 64 }),
      (id, language) => {
        const metadata = metadataFor(id);
        const requests = [
          { mode: "archive" as const },
          { mode: "audio" as const },
          { mode: "video" as const },
          {
            mode: "transcript" as const,
            transcript: { kind: "provider" as const, source: "manual" as const, language },
          },
        ];
        const subjects = requests.map((request) => captureIdentity(metadata, request));
        const lineages = requests.map((request) => revisionLineageIdentity(metadata, request));

        for (const [index, lineage] of lineages.entries()) {
          const subject = subjects[index];
          if (subject === undefined) throw new Error("revision lineage omitted its capture subject");
          expect(lineage.itemParentPathSegments[0]).toBe(REVISION_CAPTURE_NAMESPACE);
          expect(lineage.storagePathSegments[0]).toBe(REVISION_CAPTURE_NAMESPACE);
          expect(lineage.subjectAssetKey).toBe(subject.assetKey);
        }
        expect(new Set(lineages.map(({ subjectAssetKey }) => subjectAssetKey)).size).toBe(4);
        expect(new Set(lineages.map(({ itemParentPathSegments }) => itemParentPathSegments.join("/"))).size).toBe(4);
        expect(new Set(lineages.map(({ storagePathSegments }) => storagePathSegments.join("/"))).size).toBe(4);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: suffix-shaped source IDs cannot alias focused variants", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 48 }).filter((value) => !hasIdentityControl(value)),
      fc.constantFrom("audio", "video", "transcript-en"),
      (id, suffix) => {
        const focused = captureIdentity(
          metadataFor(id),
          {
            mode: "transcript",
            transcript: { kind: "provider", source: "manual", language: "en" },
          },
        );
        const suffixSource = captureIdentity(metadataFor(`${id}--${suffix}`), { mode: "archive" });
        expect(focused.itemPathSegments).not.toEqual(suffixSource.itemPathSegments);
        expect(focused.assetKey).not.toBe(suffixSource.assetKey);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: opaque raw IDs never enter archive or focused path segments", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 8, maxLength: 64 }).filter((value) => /^[A-Za-z0-9]+$/u.test(value)),
      (token) => {
        const rawId = `RAW-ID-${token}`;
        const metadata = metadataFor(rawId);
        for (const identity of [
          captureIdentity(metadata, { mode: "archive" }),
          captureIdentity(metadata, { mode: "audio" }),
          captureIdentity(metadata, {
            mode: "transcript",
            transcript: { kind: "provider", source: "manual", language: "en" },
          }),
        ]) {
          expect(identity.itemPathSegments.join("/")).not.toContain(rawId);
          expect(identity.storagePathSegments.join("/")).not.toContain(rawId);
        }
      },
    ),
    { numRuns: 300 },
  );
});

test("property: every frozen local transcriber component participates in focused identity", () => {
  const digest = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
    (bytes) => Buffer.from(bytes).toString("hex"),
  );
  fc.assert(
    fc.property(
      digest,
      digest,
      digest,
      digest,
      digest,
      digest,
      fc.integer({ min: 0, max: 256 }),
      fc.constantFrom("auto", "en", "pt-br", "zh-hant"),
      fc.constantFrom("auto", "en", "pt-br", "zh-hant"),
      (
        executableSha256,
        modelSha256,
        runtimeSha256,
        replacementExecutableSha256,
        replacementModelSha256,
        replacementRuntimeSha256,
        runtimeDependencyCount,
        requestedLanguage,
        replacementLanguage,
      ) => {
        fc.pre(replacementExecutableSha256 !== executableSha256);
        fc.pre(replacementModelSha256 !== modelSha256);
        fc.pre(replacementRuntimeSha256 !== runtimeSha256);
        fc.pre(replacementLanguage !== requestedLanguage);
        const metadata = metadataFor("local-transcript-source");
        const identity = {
          adapter: "whisper-cpp" as const,
          profile: WRENCH_MEDIA_WHISPER_CPP_PROFILE,
          executableSha256,
          runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
          runtimeSha256,
          runtimeDependencyCount,
          modelSha256,
          normalizationProfile: WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
          requestedLanguage,
        };
        const first = captureIdentity(metadata, {
          mode: "transcript",
          transcript: { kind: "local", identity },
        });
        const repeated = captureIdentity(metadata, {
          mode: "transcript",
          transcript: { kind: "local", identity: { ...identity } },
        });
        const changes = [
          { ...identity, executableSha256: replacementExecutableSha256 },
          { ...identity, runtimeSha256: replacementRuntimeSha256 },
          {
            ...identity,
            runtimeDependencyCount: (runtimeDependencyCount + 1) % 257,
          },
          { ...identity, modelSha256: replacementModelSha256 },
          { ...identity, requestedLanguage: replacementLanguage },
        ].map((changedIdentity) => captureIdentity(metadata, {
          mode: "transcript",
          transcript: { kind: "local", identity: changedIdentity },
        }));

        expect(first).toEqual(repeated);
        expect(first.itemPathSegments.slice(0, 4)).toEqual([
          FOCUSED_CAPTURE_NAMESPACE,
          metadata.itemDirectory,
          "transcript",
          "local",
        ]);
        for (const changed of changes) {
          expect(first.itemPathSegments).not.toEqual(changed.itemPathSegments);
          expect(first.storagePathSegments).not.toEqual(changed.storagePathSegments);
          expect(first.assetKey).not.toBe(changed.assetKey);
        }
      },
    ),
    { numRuns: 300 },
  );
});
