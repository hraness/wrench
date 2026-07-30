#!/usr/bin/env bun

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { mediaUrl, type MediaArchiveResult } from "../../src/media/archive";
import { WRENCH_MEDIA_SCHEMA_VERSION, verifyMediaItem } from "../../src/media/manifest";
import { findExecutable, runProcess } from "../../src/media/process";
import type { MediaTrackedRevision } from "../../src/media/revision";

const SAFE_FIXTURE_NAME = /^[A-Za-z0-9._-]+$/u;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function writeOutput(stream: NodeJS.WriteStream, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

async function requireTool(name: "ffmpeg" | "ffprobe" | "yt-dlp"): Promise<string> {
  const homeDirectory = process.env["HOME"];
  const executable = await findExecutable(name, {
    env: process.env,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  });
  if (executable === null) throw new Error(`${name} is required for adaptive VOD acceptance`);
  return executable;
}

async function runFixtureCommand(argv: readonly [string, ...string[]]): Promise<void> {
  const result = await runProcess(argv, {
    timeoutMs: 2 * 60 * 1_000,
    maxStdoutBytes: 64 * 1_024,
    maxStderrBytes: 1024 * 1_024,
  });
  if (!result.ok) throw new Error(result.diagnostic);
}

async function buildSource(
  ffmpeg: string,
  path: string,
  videoSource: string,
  frequency: number,
): Promise<void> {
  await runFixtureCommand([
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    videoSource,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${String(frequency)}:sample_rate=48000`,
    "-t",
    "2",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "12",
    "-c:a",
    "aac",
    "-y",
    path,
  ]);
}

function mediaType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".ts")) return "video/mp2t";
  if (path.endsWith(".mpd")) return "application/dash+xml";
  if (path.endsWith(".m4s")) return "video/iso.segment";
  if (path.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

async function buildFixtures(root: string, ffmpeg: string): Promise<Readonly<{
  generic: string;
  changedGeneric: string;
  hls: string;
  dash: string;
}>> {
  const generic = join(root, "generic");
  const hls = join(root, "hls");
  const dash = join(root, "dash");
  await Promise.all([
    mkdir(generic, { recursive: true }),
    mkdir(hls, { recursive: true }),
    mkdir(dash, { recursive: true }),
  ]);
  const source = join(root, "source.mp4");
  const changedGeneric = join(root, "source-changed.mp4");
  await Promise.all([
    buildSource(ffmpeg, source, "testsrc2=size=160x90:rate=12", 440),
    buildSource(ffmpeg, changedGeneric, "color=c=purple:size=160x90:rate=12", 660),
  ]);
  await copyFile(source, join(generic, "media.mp4"));
  await writeFile(
    join(generic, "index.html"),
    "<!doctype html><meta charset=utf-8><title>Wrench media fixture</title><video controls src=/generic/media.mp4></video>\n",
  );
  await runFixtureCommand([
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    source,
    "-map",
    "0",
    "-c",
    "copy",
    "-hls_time",
    "1",
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    join(hls, "segment%03d.ts"),
    "-y",
    join(hls, "index.m3u8"),
  ]);
  await runFixtureCommand([
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-seg_duration",
    "1",
    "-use_template",
    "1",
    "-use_timeline",
    "1",
    "-f",
    "dash",
    "-y",
    join(dash, "index.mpd"),
  ]);
  return { generic, changedGeneric, hls, dash };
}

function opaqueIdentity(result: MediaArchiveResult): Readonly<{
  providerIdentitySha256: string;
  requestedUrlSha256: string;
}> {
  const manifest = result.manifest;
  invariant(manifest.schemaVersion === WRENCH_MEDIA_SCHEMA_VERSION, "acceptance must write the current schema");
  invariant(manifest.acquisition.adapter === "yt-dlp", "acceptance must use yt-dlp");
  invariant(
    manifest.acquisition.identity.profile === "yt-dlp-opaque-url-v1",
    "acceptance fixture must use opaque URL identity",
  );
  return manifest.acquisition.identity;
}

function trackedRevision(result: MediaArchiveResult): MediaTrackedRevision {
  const manifest = result.manifest;
  invariant("revision" in manifest, "acceptance must write a tracked revision");
  return manifest.revision;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wrench-media-adaptive-acceptance-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const [ffmpeg] = await Promise.all([
      requireTool("ffmpeg"),
      requireTool("ffprobe"),
      requireTool("yt-dlp"),
    ]);
    const fixtures = await buildFixtures(join(root, "fixtures"), ffmpeg);
    const roots: ReadonlyMap<string, string> = new Map([
      ["generic", fixtures.generic],
      ["hls", fixtures.hls],
      ["dash", fixtures.dash],
    ] as const);
    let hlsTransientAttempts = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const segments = new URL(request.url).pathname.split("/").filter(Boolean);
        const area = segments[0];
        const name = segments[1];
        if (
          area === undefined
          || name === undefined
          || segments.length !== 2
          || !SAFE_FIXTURE_NAME.test(name)
        ) return new Response("not found", { status: 404 });
        const directory = roots.get(area);
        if (directory === undefined) return new Response("not found", { status: 404 });
        if (area === "hls" && name === "segment000.ts") {
          hlsTransientAttempts += 1;
          // `--check-formats` reads the first fragment before the download.
          // Let that bounded eligibility check pass, then fail the first real
          // download attempt so fragment retry—not format fallback—is tested.
          if (hlsTransientAttempts === 2) {
            return new Response("retry this fragment", { status: 503 });
          }
        }
        const path = join(directory, name);
        const file = Bun.file(path);
        if (!await file.exists()) return new Response("not found", { status: 404 });
        return new Response(request.method === "HEAD" ? null : file, {
          headers: {
            "accept-ranges": "bytes",
            "content-type": mediaType(path),
          },
        });
      },
    });
    const origin = `http://${server.hostname}:${String(server.port)}`;
    const libraryDirectory = join(root, "library");
    const homeDirectory = join(root, "home");
    await mkdir(homeDirectory, { mode: 0o700 });
    const environment = { PATH: process.env["PATH"] } as const;
    const urls = [
      `${origin}/generic/index.html`,
      `${origin}/hls/index.m3u8`,
      `${origin}/dash/index.mpd`,
    ] as const;
    const capture = async (url: string, refresh = false): Promise<MediaArchiveResult> => await mediaUrl({
      url,
      mode: "archive",
      language: "en",
      libraryDirectory,
      homeDirectory,
      environment,
      inheritYtDlpConfig: false,
      ...(refresh ? { refresh: true } : {}),
    });
    const results: MediaArchiveResult[] = [];
    for (const url of urls) {
      results.push(await capture(url));
    }
    invariant(results.every((result) => result.status === "created"), "every fixture must be newly captured");
    invariant(new Set(results.map((result) => result.itemDirectory)).size === 3, "fixtures must use distinct item paths");
    invariant(new Set(results.map((result) => result.manifest.assetKey)).size === 3, "fixtures must use distinct asset keys");
    const hlsIdentity = opaqueIdentity(results[1] as MediaArchiveResult);
    const dashIdentity = opaqueIdentity(results[2] as MediaArchiveResult);
    invariant(
      hlsIdentity.providerIdentitySha256 === dashIdentity.providerIdentitySha256,
      "same-basename HLS and DASH fixtures must exercise the same provider tuple",
    );
    invariant(
      hlsIdentity.requestedUrlSha256 !== dashIdentity.requestedUrlSha256,
      "same provider tuple must remain disambiguated by requested URL",
    );
    invariant(hlsTransientAttempts >= 3, "the transient HLS fragment failure must be retried");
    const initialGeneric = results[0] as MediaArchiveResult;
    const cachedGeneric = await capture(urls[0]);
    invariant(cachedGeneric.status === "existing", "ordinary invocation must reuse the generic head");
    invariant(
      cachedGeneric.itemDirectory === initialGeneric.itemDirectory,
      "ordinary invocation must return the exact generic head",
    );
    const equalGeneric = await capture(urls[0], true);
    invariant(equalGeneric.status === "existing", "equal generic refresh must reuse the head");
    invariant(
      equalGeneric.itemDirectory === initialGeneric.itemDirectory,
      "equal generic refresh must return the exact head",
    );
    await copyFile(fixtures.changedGeneric, join(fixtures.generic, "media.mp4"));
    const changedGeneric = await capture(urls[0], true);
    invariant(changedGeneric.status === "created", "changed generic refresh must append a revision");
    invariant(
      changedGeneric.itemDirectory !== initialGeneric.itemDirectory,
      "changed generic refresh must preserve the prior item",
    );
    const firstRevision = trackedRevision(initialGeneric);
    const secondRevision = trackedRevision(changedGeneric);
    invariant(firstRevision.sequence === 1, "initial generic revision must use sequence one");
    invariant(secondRevision.sequence === 2, "changed generic revision must use sequence two");
    invariant(
      secondRevision.previousAssetKey === initialGeneric.manifest.assetKey,
      "changed generic revision must link to its predecessor",
    );
    invariant(
      firstRevision.subjectAssetKey === secondRevision.subjectAssetKey,
      "changed generic revision must remain in the same subject lineage",
    );
    await server.stop(true);
    server = undefined;
    const retained = [...results, changedGeneric];
    for (const result of retained) {
      const verification = await verifyMediaItem(result.itemDirectory);
      invariant(verification.ok, `offline verification failed for ${basename(result.itemDirectory)}`);
    }
    await writeOutput(process.stdout, `${JSON.stringify({
      ok: true,
      fixtures: results.length,
      cacheHit: cachedGeneric.status === "existing",
      equalRefresh: equalGeneric.status === "existing",
      changedRevisions: secondRevision.sequence - firstRevision.sequence,
      distinctAssets: new Set(retained.map((result) => result.manifest.assetKey)).size,
      hlsFragmentAttempts: hlsTransientAttempts,
      offlineVerified: retained.length,
    })}\n`);
  } finally {
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  await writeOutput(
    process.stderr,
    `wrench media adaptive acceptance: ${error instanceof Error ? error.message : "failed"}\n`,
  );
  process.exitCode = 1;
}
