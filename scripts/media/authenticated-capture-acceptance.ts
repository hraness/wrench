#!/usr/bin/env bun

import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { Database } from "bun:sqlite";

import { mediaUrl, type MediaArchiveResult } from "../../src/media/archive";
import { WRENCH_MEDIA_SCHEMA_VERSION, verifyMediaItem } from "../../src/media/manifest";
import {
  AUTH_CONTEXT_IDENTITY_PROFILE,
  authContextSha256,
  YT_DLP_AUTH_IDENTITY_PROFILE,
} from "../../src/media/metadata";
import { findExecutable, runProcess } from "../../src/media/process";
import type { MediaTrackedRevision } from "../../src/media/revision";

const PERSONAL_CONTEXT = "PersonalRealmPrivate";
const WORK_CONTEXT = "WorkRealmPrivate";
const PERSONAL_COOKIE = "personal-cookie-private-8f37b1";
const WORK_COOKIE = "work-cookie-private-4c29d6";
const COOKIE_NAME = "wrench_media_session";

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
  if (executable === null) throw new Error(`${name} is required for authenticated capture acceptance`);
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

async function buildMedia(
  ffmpeg: string,
  path: string,
  color: "red" | "blue" | "green" | "yellow",
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
    `color=c=${color}:size=160x90:rate=12`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${String(frequency)}:sample_rate=48000`,
    "-t",
    "1",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-y",
    path,
  ]);
}

async function writeFirefoxProfile(profileDirectory: string, cookieValue: string): Promise<void> {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const databasePath = join(profileDirectory, "cookies.sqlite");
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.exec(`
      PRAGMA user_version = 15;
      CREATE TABLE moz_cookies (
        id INTEGER PRIMARY KEY,
        originAttributes TEXT NOT NULL DEFAULT '',
        name TEXT,
        value TEXT,
        host TEXT,
        path TEXT,
        expiry INTEGER,
        isSecure INTEGER
      );
    `);
    database.query(`
      INSERT INTO moz_cookies (
        originAttributes,
        name,
        value,
        host,
        path,
        expiry,
        isSecure
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("", COOKIE_NAME, cookieValue, "127.0.0.1", "/", 4_102_444_800, 0);
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
}

function cookieValue(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== COOKIE_NAME) continue;
    return pair.slice(separator + 1).trim();
  }
  return null;
}

function authenticatedIdentity(result: MediaArchiveResult) {
  const manifest = result.manifest;
  invariant(manifest.schemaVersion === WRENCH_MEDIA_SCHEMA_VERSION, "acceptance must write the current schema");
  invariant(manifest.acquisition.adapter === "yt-dlp", "acceptance must use yt-dlp");
  invariant(
    manifest.acquisition.identity.profile === YT_DLP_AUTH_IDENTITY_PROFILE,
    "acceptance must write an authenticated yt-dlp identity",
  );
  invariant(manifest.authentication.mode === "browser", "acceptance must record browser authentication");
  invariant(
    manifest.authentication.context.profile === AUTH_CONTEXT_IDENTITY_PROFILE,
    "acceptance must record the authorization-context profile",
  );
  return {
    identity: manifest.acquisition.identity,
    authentication: manifest.authentication,
  };
}

function trackedRevision(result: MediaArchiveResult): MediaTrackedRevision {
  const manifest = result.manifest;
  invariant("revision" in manifest, "acceptance must write a tracked revision");
  return manifest.revision;
}

function captureSha256(result: MediaArchiveResult): string {
  const capture = result.manifest.artifacts.find((artifact) => artifact.role === "capture");
  invariant(capture !== undefined, "authenticated archive must retain one capture artifact");
  return capture.sha256;
}

async function regularFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`unexpected archive entry: ${entry.name}`);
    }
  };
  await visit(root);
  return files.toSorted();
}

async function assertPrivateInputsAbsent(
  result: MediaArchiveResult,
  forbidden: readonly string[],
): Promise<void> {
  const files = await regularFiles(result.itemDirectory);
  const relativePaths = files.map((path) => relative(result.itemDirectory, path)).join("\n");
  const manifestText = JSON.stringify(result.manifest);
  for (const secret of forbidden) {
    invariant(!relativePaths.includes(secret), `private value entered an archive path: ${secret}`);
    invariant(!manifestText.includes(secret), `private value entered the parsed manifest: ${secret}`);
    const secretBytes = Buffer.from(secret, "utf8");
    for (const path of files) {
      const bytes = await readFile(path);
      invariant(!bytes.includes(secretBytes), `private value entered ${basename(path)}: ${secret}`);
    }
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wrench-media-authenticated-acceptance-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const [ffmpeg] = await Promise.all([
      requireTool("ffmpeg"),
      requireTool("ffprobe"),
      requireTool("yt-dlp"),
    ]);
    const fixtureDirectory = join(root, "fixtures");
    const profilesDirectory = join(root, "profiles");
    const personalProfile = join(profilesDirectory, "personal-browser-profile-private");
    const workProfile = join(profilesDirectory, "work-browser-profile-private");
    const personalMediaA = join(fixtureDirectory, "personal-a.mp4");
    const personalMediaB = join(fixtureDirectory, "personal-b.mp4");
    const workMediaA = join(fixtureDirectory, "work-a.mp4");
    const workMediaB = join(fixtureDirectory, "work-b.mp4");
    await Promise.all([
      mkdir(fixtureDirectory, { recursive: true }),
      writeFirefoxProfile(personalProfile, PERSONAL_COOKIE),
      writeFirefoxProfile(workProfile, WORK_COOKIE),
    ]);
    await Promise.all([
      buildMedia(ffmpeg, personalMediaA, "red", 440),
      buildMedia(ffmpeg, personalMediaB, "green", 660),
      buildMedia(ffmpeg, workMediaA, "blue", 880),
      buildMedia(ffmpeg, workMediaB, "yellow", 1_100),
    ]);

    const authorizedRequests = new Map<string, number>();
    let personalMedia = personalMediaA;
    let workMedia = workMediaA;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const session = cookieValue(request);
        if (session !== PERSONAL_COOKIE && session !== WORK_COOKIE) {
          return new Response("authorization required", { status: 401 });
        }
        const mediaPath = session === PERSONAL_COOKIE ? personalMedia : workMedia;
        authorizedRequests.set(session, (authorizedRequests.get(session) ?? 0) + 1);
        if (url.pathname === "/authorized-private-route/index.html") {
          return new Response(
            "<!doctype html><meta charset=utf-8><title>Private fixture</title><video controls src=/authorized-private-route/media.mp4></video>\n",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (url.pathname !== "/authorized-private-route/media.mp4") {
          return new Response("not found", { status: 404 });
        }
        return new Response(request.method === "HEAD" ? null : Bun.file(mediaPath), {
          headers: {
            "accept-ranges": "bytes",
            "content-type": "video/mp4",
          },
        });
      },
    });

    const origin = `http://${server.hostname}:${String(server.port)}`;
    const requestedUrl = `${origin}/authorized-private-route/index.html?ticket=request-query-private#request-fragment-private`;
    const libraryDirectory = join(root, "library");
    const homeDirectory = join(root, "home");
    await mkdir(homeDirectory, { mode: 0o700 });
    const environment = { PATH: process.env["PATH"] } as const;
    const capture = async (
      profile: string,
      context: string,
      refresh = false,
    ): Promise<MediaArchiveResult> => await mediaUrl({
      url: requestedUrl,
      mode: "archive",
      language: "en",
      browser: `firefox:${profile}`,
      authContext: context,
      inheritYtDlpConfig: false,
      libraryDirectory,
      homeDirectory,
      environment,
      ...(refresh ? { refresh: true } : {}),
    });

    const personal = await capture(personalProfile, PERSONAL_CONTEXT);
    const personalCached = await capture(personalProfile, PERSONAL_CONTEXT.toLowerCase());
    const work = await capture(workProfile, WORK_CONTEXT);
    const workCached = await capture(workProfile, WORK_CONTEXT.toLowerCase());
    invariant(personal.status === "created", "personal session must create an archive");
    invariant(personalCached.status === "existing", "same normalized context must reuse its archive");
    invariant(work.status === "created", "work session must create a separate archive");
    invariant(workCached.status === "existing", "work context must reuse its archive");
    invariant(personal.itemDirectory === personalCached.itemDirectory, "same context must resolve one item path");
    invariant(work.itemDirectory === workCached.itemDirectory, "same work context must resolve one item path");
    invariant(personal.itemDirectory !== work.itemDirectory, "different contexts must resolve distinct item paths");
    invariant(personal.manifest.assetKey !== work.manifest.assetKey, "different contexts must resolve distinct asset keys");
    invariant(captureSha256(personal) !== captureSha256(work), "the two authorized sessions must retain different media bytes");
    invariant((authorizedRequests.get(PERSONAL_COOKIE) ?? 0) > 0, "personal cookie must authorize real requests");
    invariant((authorizedRequests.get(WORK_COOKIE) ?? 0) > 0, "work cookie must authorize real requests");

    const personalEqual = await capture(personalProfile, PERSONAL_CONTEXT, true);
    const workEqual = await capture(workProfile, WORK_CONTEXT, true);
    invariant(personalEqual.status === "existing", "equal personal refresh must reuse its head");
    invariant(workEqual.status === "existing", "equal work refresh must reuse its head");
    invariant(personalEqual.itemDirectory === personal.itemDirectory, "personal equal refresh must return its head");
    invariant(workEqual.itemDirectory === work.itemDirectory, "work equal refresh must return its head");

    personalMedia = personalMediaB;
    workMedia = workMediaB;
    const personalChanged = await capture(personalProfile, PERSONAL_CONTEXT, true);
    const workChanged = await capture(workProfile, WORK_CONTEXT, true);
    invariant(personalChanged.status === "created", "changed personal refresh must append a revision");
    invariant(workChanged.status === "created", "changed work refresh must append a revision");
    invariant(personalChanged.itemDirectory !== personal.itemDirectory, "personal refresh must preserve its prior item");
    invariant(workChanged.itemDirectory !== work.itemDirectory, "work refresh must preserve its prior item");
    invariant(captureSha256(personalChanged) !== captureSha256(personal), "personal refresh must retain changed bytes");
    invariant(captureSha256(workChanged) !== captureSha256(work), "work refresh must retain changed bytes");

    const personalFirstRevision = trackedRevision(personal);
    const personalSecondRevision = trackedRevision(personalChanged);
    const workFirstRevision = trackedRevision(work);
    const workSecondRevision = trackedRevision(workChanged);
    for (const [first, second, firstResult] of [
      [personalFirstRevision, personalSecondRevision, personal],
      [workFirstRevision, workSecondRevision, work],
    ] as const) {
      invariant(first.sequence === 1, "authenticated initial revision must use sequence one");
      invariant(second.sequence === 2, "authenticated changed revision must use sequence two");
      invariant(second.previousAssetKey === firstResult.manifest.assetKey, "authenticated revision must link its predecessor");
      invariant(first.subjectAssetKey === second.subjectAssetKey, "authenticated refresh must preserve its subject");
    }

    const personalIdentity = authenticatedIdentity(personal);
    const workIdentity = authenticatedIdentity(work);
    invariant(
      personalIdentity.identity.providerIdentitySha256 === workIdentity.identity.providerIdentitySha256,
      "sessions must exercise the same provider tuple",
    );
    invariant(
      personalIdentity.identity.requestedUrlSha256 === workIdentity.identity.requestedUrlSha256,
      "sessions must exercise the same requested URL",
    );
    invariant(
      personalIdentity.authentication.context.sha256 === authContextSha256(PERSONAL_CONTEXT),
      "personal context digest must be reproducible",
    );
    invariant(
      workIdentity.authentication.context.sha256 === authContextSha256(WORK_CONTEXT),
      "work context digest must be reproducible",
    );
    invariant(
      personalIdentity.authentication.context.sha256 !== workIdentity.authentication.context.sha256,
      "authorization contexts must remain disjoint",
    );

    const forbidden = [
      PERSONAL_CONTEXT,
      PERSONAL_CONTEXT.toLowerCase(),
      WORK_CONTEXT,
      WORK_CONTEXT.toLowerCase(),
      PERSONAL_COOKIE,
      WORK_COOKIE,
      "personal-browser-profile-private",
      "work-browser-profile-private",
      "authorized-private-route",
      "request-query-private",
      "request-fragment-private",
    ] as const;
    await Promise.all([
      assertPrivateInputsAbsent(personal, forbidden),
      assertPrivateInputsAbsent(work, forbidden),
      assertPrivateInputsAbsent(personalChanged, forbidden),
      assertPrivateInputsAbsent(workChanged, forbidden),
    ]);

    await server.stop(true);
    server = undefined;
    await Promise.all([
      rm(profilesDirectory, { recursive: true, force: true }),
      rm(fixtureDirectory, { recursive: true, force: true }),
    ]);
    const retained = [personal, personalChanged, work, workChanged] as const;
    for (const result of retained) {
      const verification = await verifyMediaItem(result.itemDirectory);
      invariant(verification.ok, `offline verification failed for ${basename(result.itemDirectory)}`);
    }
    await writeOutput(process.stdout, `${JSON.stringify({
      ok: true,
      sessions: 2,
      sameContextCacheHits: Number(personalCached.status === "existing")
        + Number(workCached.status === "existing"),
      equalRefreshes: Number(personalEqual.status === "existing")
        + Number(workEqual.status === "existing"),
      changedRevisions: personalSecondRevision.sequence + workSecondRevision.sequence
        - personalFirstRevision.sequence - workFirstRevision.sequence,
      distinctAssets: new Set(retained.map((result) => result.manifest.assetKey)).size,
      distinctCaptures: new Set(retained.map(captureSha256)).size,
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
    `wrench media authenticated acceptance: ${error instanceof Error ? error.message : "failed"}\n`,
  );
  process.exitCode = 1;
}
