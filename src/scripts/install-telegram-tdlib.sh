#!/bin/sh
set -eu

tdlib_version=1.8.67
tdlib_commit=d1085f9cebc5a62379991ae1652673954f229c1f
protocol_version=1
repository=https://github.com/tdlib/td.git

fail() {
  printf '%s\n' "Wrench Telegram TDLib installer: $1" >&2
  exit 1
}

file_sha256() {
  if [ -x /usr/bin/shasum ]; then
    /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "a SHA-256 utility is required"
  fi
}

exact_real_file() {
  candidate=$1
  label=$2
  if [ ! -f "$candidate" ] || [ -L "$candidate" ]; then
    fail "$label must be a real file"
  fi
}

find_command() {
  requested=$1
  shift
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  candidate=$(command -v "$requested" 2>/dev/null || true)
  case "$candidate" in
    /*)
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return
      fi
      ;;
  esac
  fail "$requested is required"
}

directory_identity() {
  "$bun_path" -e '
    import { lstatSync, realpathSync } from "node:fs";
    import { resolve } from "node:path";
    const path = process.argv[1];
    const stats = lstatSync(path, { bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (
      resolve(path) !== path ||
      realpathSync(path) !== path ||
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (uid !== null && stats.uid !== uid) ||
      (stats.mode & 0o7777n) !== 0o700n
    ) process.exit(2);
    process.stdout.write(`${stats.dev}:${stats.ino}:${stats.birthtimeNs}`);
  ' "$1"
}

remove_bound_directory() {
  "$bun_path" -e '
    import { lstatSync, realpathSync, rmSync } from "node:fs";
    import { basename, dirname, resolve } from "node:path";
    const [path, expectedDev, expectedIno, expectedBirthtimeNs, expectedParent, expectedPrefix] = process.argv.slice(1);
    const refuse = (message) => {
      process.stderr.write(`Wrench Telegram TDLib installer cleanup: ${message}\n`);
      process.exit(2);
    };
    if (
      resolve(path) !== path ||
      resolve(expectedParent) !== expectedParent ||
      dirname(path) !== expectedParent ||
      !basename(path).startsWith(expectedPrefix)
    ) refuse("temporary path escaped its exact owned boundary");
    let stats;
    try {
      stats = lstatSync(path, { bigint: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") process.exit(0);
      throw error;
    }
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (
      stats.dev.toString() !== expectedDev ||
      stats.ino.toString() !== expectedIno ||
      stats.birthtimeNs.toString() !== expectedBirthtimeNs ||
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (uid !== null && stats.uid !== uid) ||
      (stats.mode & 0o7777n) !== 0o700n ||
      realpathSync(path) !== path
    ) refuse("temporary directory identity drifted; leaving it untouched");
    rmSync(path, { recursive: true, force: false, maxRetries: 0 });
    try {
      lstatSync(path);
      refuse("temporary directory remained after cleanup");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  ' "$1" "$2" "$3" "$4" "$5" "$6"
}

strict_validate_install() {
  "$bun_path" -e '
    import { createHash } from "node:crypto";
    import { spawnSync } from "node:child_process";
    import {
      closeSync,
      constants,
      fstatSync,
      lstatSync,
      openSync,
      readSync,
      realpathSync,
    } from "node:fs";
    import { join, resolve } from "node:path";

    const [target, expectedPlatform, expectedArch] = process.argv.slice(1);
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    const expectedIdentity = "{\"schemaVersion\":1,\"operation\":\"identity\",\"status\":\"ok\",\"implementation\":\"wrench-telegram-tdlib\",\"tdlibVersion\":\"1.8.67\",\"sourceCommit\":\"d1085f9cebc5a62379991ae1652673954f229c1f\"}";
    const fail = (message) => { throw new Error(message); };
    const identity = (stats) => ({
      dev: stats.dev,
      ino: stats.ino,
      nlink: stats.nlink,
      uid: stats.uid,
      mode: stats.mode & 0o7777n,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
      birthtimeNs: stats.birthtimeNs,
    });
    const sameFile = (left, right) =>
      left.dev === right.dev && left.ino === right.ino &&
      left.nlink === right.nlink && left.uid === right.uid &&
      left.mode === right.mode && left.size === right.size &&
      left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
      left.birthtimeNs === right.birthtimeNs;
    const sameDirectory = (left, right) =>
      left.dev === right.dev && left.ino === right.ino &&
      left.uid === right.uid && left.mode === right.mode &&
      left.birthtimeNs === right.birthtimeNs;
    const assertDirectory = (path, label) => {
      if (resolve(path) !== path) fail(`${label} path is not lexical-canonical`);
      const stats = lstatSync(path, { bigint: true });
      if (
        !stats.isDirectory() || stats.isSymbolicLink() ||
        (uid !== null && stats.uid !== uid) ||
        (stats.mode & 0o7777n) !== 0o700n ||
        realpathSync(path) !== path
      ) fail(`${label} is not one canonical owned mode-0700 directory`);
      return identity(stats);
    };
    const assertFileStats = (stats, mode, maximum, label) => {
      if (
        !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n ||
        (uid !== null && stats.uid !== uid) ||
        (stats.mode & 0o7777n) !== mode || stats.size < 1n || stats.size > maximum
      ) fail(`${label} is not one owned regular bounded file with the exact mode`);
      return identity(stats);
    };
    const openBound = (path, mode, maximum, label) => {
      if (resolve(path) !== path || realpathSync(path) !== path) {
        fail(`${label} path is not canonical`);
      }
      const lexical = assertFileStats(lstatSync(path, { bigint: true }), mode, maximum, label);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = assertFileStats(fstatSync(fd, { bigint: true }), mode, maximum, label);
        if (!sameFile(lexical, opened)) fail(`${label} identity changed while opening`);
        return { fd, identity: opened };
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    };
    const readBound = (path, mode, maximum, label) => {
      const opened = openBound(path, mode, BigInt(maximum), label);
      try {
        const chunks = [];
        let total = 0;
        for (;;) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
          const count = readSync(opened.fd, chunk, 0, chunk.length, total);
          if (count === 0) break;
          chunks.push(chunk.subarray(0, count));
          total += count;
          if (total > maximum) fail(`${label} exceeded its byte bound`);
        }
        const finalIdentity = identity(fstatSync(opened.fd, { bigint: true }));
        if (!sameFile(opened.identity, finalIdentity)) fail(`${label} changed while reading`);
        return { bytes: Buffer.concat(chunks), identity: opened.identity };
      } finally {
        closeSync(opened.fd);
      }
    };
    const hashBound = (path, mode, maximum, label) => {
      const opened = openBound(path, mode, BigInt(maximum), label);
      try {
        const hash = createHash("sha256");
        let position = 0;
        for (;;) {
          const chunk = Buffer.allocUnsafe(64 * 1024);
          const count = readSync(opened.fd, chunk, 0, chunk.length, position);
          if (count === 0) break;
          hash.update(chunk.subarray(0, count));
          position += count;
          if (position > maximum) fail(`${label} exceeded its byte bound`);
        }
        const finalIdentity = identity(fstatSync(opened.fd, { bigint: true }));
        if (!sameFile(opened.identity, finalIdentity)) fail(`${label} changed while hashing`);
        return { digest: hash.digest("hex"), identity: opened.identity };
      } finally {
        closeSync(opened.fd);
      }
    };
    const parseManifest = (bytes) => {
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { fail("install manifest is not valid UTF-8"); }
      let value;
      try { value = JSON.parse(text); }
      catch { fail("install manifest is not valid JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("install manifest is not an object");
      const keys = Object.keys(value).sort().join(",");
      if (keys !== "arch,binaryFile,binarySha256,implementation,platform,protocolVersion,schemaVersion,sourceCommit,tdlibVersion") {
        fail("install manifest fields are unsupported");
      }
      if (
        value.schemaVersion !== 1 ||
        value.implementation !== "wrench-telegram-tdlib" ||
        value.tdlibVersion !== "1.8.67" ||
        value.sourceCommit !== "d1085f9cebc5a62379991ae1652673954f229c1f" ||
        value.protocolVersion !== 1 ||
        value.binaryFile !== "wrench-telegram-tdlib" ||
        value.platform !== expectedPlatform ||
        value.arch !== expectedArch ||
        typeof value.binarySha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.binarySha256)
      ) fail("install manifest does not match the reviewed runtime");
      const canonical = `${JSON.stringify({
        arch: value.arch,
        binaryFile: value.binaryFile,
        binarySha256: value.binarySha256,
        implementation: value.implementation,
        platform: value.platform,
        protocolVersion: value.protocolVersion,
        schemaVersion: value.schemaVersion,
        sourceCommit: value.sourceCommit,
        tdlibVersion: value.tdlibVersion,
      })}\n`;
      if (text !== canonical) fail("install manifest is not exact canonical JSON");
      return value;
    };
    const validate = () => {
      const directoryIdentity = assertDirectory(target, "installation directory");
      const manifestPath = join(target, "install-manifest.json");
      const manifestFile = readBound(manifestPath, 0o400n, 8 * 1024, "install manifest");
      const manifest = parseManifest(manifestFile.bytes);
      const binaryPath = join(target, manifest.binaryFile);
      const binaryFile = hashBound(binaryPath, 0o500n, 256 * 1024 * 1024, "Telegram helper");
      if (binaryFile.digest !== manifest.binarySha256) fail("Telegram helper SHA-256 mismatch");
      return {
        binaryPath,
        binarySha256: binaryFile.digest,
        directoryIdentity,
        manifestIdentity: manifestFile.identity,
        binaryIdentity: binaryFile.identity,
      };
    };

    try {
      const before = validate();
      const result = spawnSync(before.binaryPath, [], {
        cwd: target,
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        input: "{\"schemaVersion\":1,\"operation\":\"identity\"}\n",
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        killSignal: "SIGKILL",
      });
      if (
        result.error !== undefined || result.signal !== null || result.status !== 0 ||
        result.stderr !== "" || typeof result.stdout !== "string" ||
        result.stdout.trim() !== expectedIdentity
      ) fail("Telegram helper embedded identity failed");
      const after = validate();
      if (
        !sameDirectory(before.directoryIdentity, after.directoryIdentity) ||
        !sameFile(before.manifestIdentity, after.manifestIdentity) ||
        !sameFile(before.binaryIdentity, after.binaryIdentity) ||
        before.binarySha256 !== after.binarySha256
      ) fail("installation identity changed during validation");
    } catch (error) {
      process.stderr.write(`Wrench Telegram TDLib installer validation: ${error instanceof Error ? error.message : "unknown failure"}\n`);
      process.exit(2);
    }
  ' "$1" "$2" "$3"
}

publish_claimed_install() {
  "$bun_path" -e '
    import { createHash } from "node:crypto";
    import {
      closeSync,
      constants,
      fstatSync,
      fsyncSync,
      linkSync,
      lstatSync,
      mkdirSync,
      openSync,
      readSync,
      realpathSync,
      rmdirSync,
      unlinkSync,
    } from "node:fs";
    import { dirname, join, resolve } from "node:path";

    const [stage, expectedStageDev, expectedStageIno, expectedStageBirthtimeNs, target, parent, expectedSha] = process.argv.slice(1);
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    const fail = (message) => { throw new Error(message); };
    const identity = (stats) => ({
      dev: stats.dev,
      ino: stats.ino,
      nlink: stats.nlink,
      uid: stats.uid,
      mode: stats.mode & 0o7777n,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
      birthtimeNs: stats.birthtimeNs,
    });
    const sameObject = (left, right) => left.dev === right.dev && left.ino === right.ino;
    const sameFile = (left, right) =>
      sameObject(left, right) && left.nlink === right.nlink &&
      left.uid === right.uid && left.mode === right.mode &&
      left.size === right.size && left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
    const sameLinkedFile = (left, right) =>
      sameObject(left, right) && left.uid === right.uid &&
      left.mode === right.mode && left.size === right.size &&
      left.mtimeNs === right.mtimeNs && left.birthtimeNs === right.birthtimeNs;
    const sameDirectory = (left, right) =>
      sameObject(left, right) && left.uid === right.uid &&
      left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
    const assertDirectory = (path, label, expected) => {
      if (resolve(path) !== path || realpathSync(path) !== path) fail(`${label} path is not canonical`);
      const stats = lstatSync(path, { bigint: true });
      if (
        !stats.isDirectory() || stats.isSymbolicLink() ||
        (uid !== null && stats.uid !== uid) ||
        (stats.mode & 0o7777n) !== 0o700n
      ) fail(`${label} is not one owned mode-0700 directory`);
      const actual = identity(stats);
      if (expected !== undefined && !sameDirectory(actual, expected)) fail(`${label} identity changed`);
      return actual;
    };
    const assertFile = (path, mode, maximum, label, links) => {
      if (resolve(path) !== path || realpathSync(path) !== path) fail(`${label} path is not canonical`);
      const stats = lstatSync(path, { bigint: true });
      if (
        !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== links ||
        (uid !== null && stats.uid !== uid) ||
        (stats.mode & 0o7777n) !== mode || stats.size < 1n || stats.size > maximum
      ) fail(`${label} metadata is unsupported`);
      return identity(stats);
    };
    const hashFile = (path, expected, label) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = identity(fstatSync(fd, { bigint: true }));
        if (!sameFile(opened, expected)) {
          fail(`${label} identity changed while opening`);
        }
        const hash = createHash("sha256");
        let position = 0;
        for (;;) {
          const chunk = Buffer.allocUnsafe(64 * 1024);
          const count = readSync(fd, chunk, 0, chunk.length, position);
          if (count === 0) break;
          hash.update(chunk.subarray(0, count));
          position += count;
          if (position > 256 * 1024 * 1024) fail(`${label} exceeded its byte bound`);
        }
        const finalIdentity = identity(fstatSync(fd, { bigint: true }));
        if (!sameFile(finalIdentity, opened)) {
          fail(`${label} changed while hashing`);
        }
        return hash.digest("hex");
      } finally { closeSync(fd); }
    };
    const syncBoundFile = (path, expected, label) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = identity(fstatSync(fd, { bigint: true }));
        if (!sameFile(before, expected)) fail(`${label} identity changed before fsync`);
        fsyncSync(fd);
        const after = identity(fstatSync(fd, { bigint: true }));
        if (!sameFile(after, before)) {
          fail(`${label} changed while fsyncing`);
        }
      } finally { closeSync(fd); }
    };
    const syncDirectory = (path, expected, label) => {
      const current = assertDirectory(path, label, expected);
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = identity(fstatSync(fd, { bigint: true }));
        if (!sameDirectory(opened, current)) fail(`${label} identity changed while opening`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    };
    const pathAbsent = (path) => {
      try { lstatSync(path); return false; }
      catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") return true;
        throw error;
      }
    };
    const unlinkIfBound = (path, expected) => {
      try {
        const current = identity(lstatSync(path, { bigint: true }));
        if (!sameLinkedFile(current, expected)) return false;
        unlinkSync(path);
        return true;
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") return true;
        throw error;
      }
    };

    let targetIdentity;
    const installedFiles = [];
    try {
      if (dirname(target) !== parent || resolve(target) !== target) fail("installation target escaped its exact parent");
      assertDirectory(parent, "installation parent");
      const stageIdentity = assertDirectory(stage, "installation staging directory");
      if (
        stageIdentity.dev.toString() !== expectedStageDev ||
        stageIdentity.ino.toString() !== expectedStageIno ||
        stageIdentity.birthtimeNs.toString() !== expectedStageBirthtimeNs
      ) {
        fail("installation staging directory identity changed");
      }
      const stagedBinaryPath = join(stage, "wrench-telegram-tdlib");
      const stagedManifestPath = join(stage, "install-manifest.json");
      const stagedBinary = assertFile(stagedBinaryPath, 0o500n, 256n * 1024n * 1024n, "staged Telegram helper", 1n);
      const stagedManifest = assertFile(stagedManifestPath, 0o400n, 8n * 1024n, "staged install manifest", 1n);
      if (hashFile(stagedBinaryPath, stagedBinary, "staged Telegram helper") !== expectedSha) {
        fail("staged Telegram helper SHA-256 changed before publication");
      }
      syncBoundFile(stagedBinaryPath, stagedBinary, "staged Telegram helper");
      syncBoundFile(stagedManifestPath, stagedManifest, "staged install manifest");
      syncDirectory(stage, stageIdentity, "installation staging directory");
      if (!pathAbsent(target)) fail("installation target was claimed by another installer");

      mkdirSync(target, { mode: 0o700 });
      targetIdentity = assertDirectory(target, "claimed installation target");
      syncDirectory(parent, assertDirectory(parent, "installation parent"), "installation parent");

      const publishFile = (source, destination, sourceIdentity, mode, maximum, label) => {
        assertDirectory(target, "claimed installation target", targetIdentity);
        if (!pathAbsent(destination)) fail(`${label} destination was already claimed`);
        linkSync(source, destination);
        const linked = assertFile(destination, mode, maximum, label, 2n);
        if (!sameLinkedFile(linked, sourceIdentity)) fail(`${label} hard-link identity mismatch`);
        installedFiles.push({ path: destination, identity: linked });
        unlinkSync(source);
        const installed = assertFile(destination, mode, maximum, label, 1n);
        if (!sameLinkedFile(installed, sourceIdentity)) fail(`${label} identity changed during publication`);
        installedFiles[installedFiles.length - 1] = { path: destination, identity: installed };
        syncBoundFile(destination, installed, label);
        syncDirectory(target, targetIdentity, "claimed installation target");
      };

      publishFile(
        stagedBinaryPath,
        join(target, "wrench-telegram-tdlib"),
        stagedBinary,
        0o500n,
        256n * 1024n * 1024n,
        "installed Telegram helper",
      );
      publishFile(
        stagedManifestPath,
        join(target, "install-manifest.json"),
        stagedManifest,
        0o400n,
        8n * 1024n,
        "installed install manifest",
      );
      assertDirectory(target, "claimed installation target", targetIdentity);
      syncDirectory(parent, assertDirectory(parent, "installation parent"), "installation parent");
    } catch (error) {
      let rollbackSafe = true;
      for (const installed of installedFiles.reverse()) {
        try {
          if (!unlinkIfBound(installed.path, installed.identity)) rollbackSafe = false;
        } catch { rollbackSafe = false; }
      }
      if (targetIdentity !== undefined) {
        try {
          const current = assertDirectory(target, "claimed installation target", targetIdentity);
          if (!sameDirectory(current, targetIdentity)) rollbackSafe = false;
          else rmdirSync(target);
        } catch { rollbackSafe = false; }
      }
      process.stderr.write(`Wrench Telegram TDLib installer publication: ${error instanceof Error ? error.message : "unknown failure"}${rollbackSafe ? "" : "; guarded rollback left drifted state untouched"}\n`);
      process.exit(2);
    }
  ' "$1" "$2" "$3" "$4" "$5" "$6" "$7"
}

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
source_root=$(CDPATH= cd -- "$script_directory/.." && pwd -P)
vendor_directory=$source_root/vendor/telegram-tdlib
helper_source=$vendor_directory/wrench_telegram_tdlib.cpp
helper_cmake=$vendor_directory/CMakeLists.txt
exact_real_file "$helper_source" "vendored Telegram helper source"
exact_real_file "$helper_cmake" "vendored Telegram helper CMake project"

kernel=$(uname -s)
machine=$(uname -m)
case "$kernel" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail "the reviewed source build supports only macOS and Linux" ;;
esac
case "$machine" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "the reviewed source build supports only arm64 and x86-64" ;;
esac

git_path=$(find_command git /usr/bin/git /opt/homebrew/bin/git /usr/local/bin/git)
cmake_path=$(find_command cmake /opt/homebrew/bin/cmake /usr/local/bin/cmake /usr/bin/cmake)
make_path=$(find_command make /usr/bin/make /opt/homebrew/bin/gmake /usr/local/bin/gmake)
cxx_path=$(find_command c++ /usr/bin/c++ /usr/bin/clang++ /usr/bin/g++)
gperf_path=$(find_command gperf /opt/homebrew/bin/gperf /usr/local/bin/gperf /usr/bin/gperf)

openssl_root=
if [ "$platform" = darwin ]; then
  for candidate in /opt/homebrew/opt/openssl@3 /usr/local/opt/openssl@3; do
    if [ -d "$candidate" ]; then
      openssl_root=$(CDPATH= cd -- "$candidate" && pwd -P)
      break
    fi
  done
  if [ -z "$openssl_root" ]; then
    fail "a real openssl@3 prefix at /opt/homebrew/opt or /usr/local/opt is required"
  fi
fi

if [ -n "${WRENCH_BUN:-}" ]; then
  bun_path=$WRENCH_BUN
else
  bun_path=$(find_command bun /opt/homebrew/bin/bun /usr/local/bin/bun)
fi
case "$bun_path" in
  /*) ;;
  *) fail "Bun path must be absolute" ;;
esac
if [ "$("$bun_path" --version)" != 1.3.14 ]; then
  fail "Bun 1.3.14 is required"
fi

helper_source_sha=$(file_sha256 "$helper_source")
helper_cmake_sha=$(file_sha256 "$helper_cmake")
assert_helper_sources_unchanged() {
  exact_real_file "$helper_source" "vendored Telegram helper source"
  exact_real_file "$helper_cmake" "vendored Telegram helper CMake project"
  if [ "$(file_sha256 "$helper_source")" != "$helper_source_sha" ] ||
     [ "$(file_sha256 "$helper_cmake")" != "$helper_cmake_sha" ]; then
    fail "vendored Telegram helper build inputs changed during installation"
  fi
}

state_home=$(
  cd "$source_root"
  "$bun_path" -e '
    import { join } from "node:path";
    import { ensurePrivateStateDirectory, wrenchStateHome } from "./storage.ts";
    const root = wrenchStateHome(process.env);
    ensurePrivateStateDirectory(join(root, "tools", "telegram-tdlib", "1.8.67", "d1085f9cebc5a62379991ae1652673954f229c1f"), process.env);
    process.stdout.write(root);
  '
)
parent=$state_home/tools/telegram-tdlib/$tdlib_version/$tdlib_commit
target=$parent/$platform-$arch

if [ -L "$target" ]; then
  fail "refusing symbolic-link installation target"
fi
if [ -e "$target" ]; then
  strict_validate_install "$target" "$platform" "$arch" || fail "existing Telegram helper did not pass strict runtime-equivalent validation"
  printf '%s\n' "Pinned Telegram TDLib helper is already installed at $target"
  exit 0
fi

umask 077
temporary_parent=$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P) || fail "temporary parent is unavailable"
temporary_directory=$(mktemp -d "$temporary_parent/wrench-telegram-tdlib.XXXXXX") || fail "could not create a private build directory"
temporary_directory=$(CDPATH= cd -- "$temporary_directory" && pwd -P) || fail "could not bind the private build directory"
temporary_identity=$(directory_identity "$temporary_directory") || fail "private build directory metadata is unsupported"
temporary_dev=${temporary_identity%%:*}
temporary_identity_tail=${temporary_identity#*:}
temporary_ino=${temporary_identity_tail%%:*}
temporary_birthtime_ns=${temporary_identity_tail#*:}
stage=
stage_dev=
stage_ino=
stage_birthtime_ns=

cleanup_bound_artifacts() {
  cleanup_failed=0
  if [ -n "${stage:-}" ] && [ -n "${stage_dev:-}" ] && [ -n "${stage_ino:-}" ] && [ -n "${stage_birthtime_ns:-}" ]; then
    if ! remove_bound_directory "$stage" "$stage_dev" "$stage_ino" "$stage_birthtime_ns" "$parent" ".$platform-$arch.stage."; then
      cleanup_failed=1
    fi
  fi
  if ! remove_bound_directory "$temporary_directory" "$temporary_dev" "$temporary_ino" "$temporary_birthtime_ns" "$temporary_parent" "wrench-telegram-tdlib."; then
    cleanup_failed=1
  fi
  [ "$cleanup_failed" -eq 0 ]
}

cleanup_on_exit() {
  cleanup_status=$?
  trap - EXIT HUP INT TERM
  if ! cleanup_bound_artifacts && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status=1
  fi
  exit "$cleanup_status"
}
trap cleanup_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

source_directory=$temporary_directory/td
build_directory=$temporary_directory/td-build
install_directory=$temporary_directory/td-install
helper_build=$temporary_directory/helper-build

"$git_path" init --quiet "$source_directory"
"$git_path" -C "$source_directory" remote add origin "$repository"
"$git_path" -C "$source_directory" fetch --quiet --depth=1 origin "$tdlib_commit"
fetched_commit=$("$git_path" -C "$source_directory" rev-parse FETCH_HEAD)
if [ "$fetched_commit" != "$tdlib_commit" ]; then
  fail "fetched TDLib commit did not match the reviewed pin"
fi
"$git_path" -C "$source_directory" checkout --quiet --detach "$tdlib_commit"
if [ "$("$git_path" -C "$source_directory" rev-parse HEAD)" != "$tdlib_commit" ]; then
  fail "checked-out TDLib source did not match the reviewed pin"
fi
if [ -n "$("$git_path" -C "$source_directory" status --porcelain --untracked-files=all)" ]; then
  fail "checked-out TDLib source was not clean"
fi

set -- \
  -S "$source_directory" \
  -B "$build_directory" \
  -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER="$cxx_path" \
  -DCMAKE_MAKE_PROGRAM="$make_path" \
  -DGPERF_EXECUTABLE="$gperf_path" \
  -DCMAKE_INSTALL_PREFIX="$install_directory" \
  -DBUILD_SHARED_LIBS=OFF \
  -DTD_INSTALL_STATIC_LIBRARIES=ON \
  -DTD_INSTALL_SHARED_LIBRARIES=OFF \
  -DBUILD_TESTING=OFF \
  -DOPENSSL_USE_STATIC_LIBS=TRUE \
  -DTD_ENABLE_JNI=OFF \
  -DTD_ENABLE_DOTNET=OFF
if [ -n "$openssl_root" ]; then
  set -- "$@" -DOPENSSL_ROOT_DIR="$openssl_root"
fi
"$cmake_path" "$@"
"$cmake_path" --build "$build_directory" --target install --parallel 2

assert_helper_sources_unchanged
"$cmake_path" \
  -S "$vendor_directory" \
  -B "$helper_build" \
  -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER="$cxx_path" \
  -DCMAKE_MAKE_PROGRAM="$make_path" \
  -DCMAKE_PREFIX_PATH="$install_directory"
"$cmake_path" --build "$helper_build" --parallel 2

assert_helper_sources_unchanged
built_binary=$helper_build/wrench-telegram-tdlib
exact_real_file "$built_binary" "built Telegram helper"
if [ "$platform" = darwin ]; then
  /usr/bin/strip -x "$built_binary"
elif command -v strip >/dev/null 2>&1; then
  strip "$built_binary"
fi
binary_sha=$(file_sha256 "$built_binary")
case "$binary_sha" in
  ""|*[!a-f0-9]*) fail "built Telegram helper produced an invalid SHA-256" ;;
esac
if [ "${#binary_sha}" -ne 64 ]; then
  fail "built Telegram helper produced an invalid SHA-256"
fi

identity=$(printf '%s\n' '{"schemaVersion":1,"operation":"identity"}' | env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC "$built_binary") || fail "built Telegram helper identity failed"
expected_identity='{"schemaVersion":1,"operation":"identity","status":"ok","implementation":"wrench-telegram-tdlib","tdlibVersion":"1.8.67","sourceCommit":"d1085f9cebc5a62379991ae1652673954f229c1f"}'
if [ "$identity" != "$expected_identity" ]; then
  fail "built Telegram helper embedded identity mismatch"
fi

stage=$(mktemp -d "$parent/.$platform-$arch.stage.XXXXXX") || fail "could not claim an installation staging directory"
stage=$(CDPATH= cd -- "$stage" && pwd -P) || fail "could not bind the installation staging directory"
stage_identity=$(directory_identity "$stage") || fail "installation staging directory metadata is unsupported"
stage_dev=${stage_identity%%:*}
stage_identity_tail=${stage_identity#*:}
stage_ino=${stage_identity_tail%%:*}
stage_birthtime_ns=${stage_identity_tail#*:}
cp "$built_binary" "$stage/wrench-telegram-tdlib"
chmod 0500 "$stage/wrench-telegram-tdlib"
printf '%s\n' "{\"arch\":\"$arch\",\"binaryFile\":\"wrench-telegram-tdlib\",\"binarySha256\":\"$binary_sha\",\"implementation\":\"wrench-telegram-tdlib\",\"platform\":\"$platform\",\"protocolVersion\":$protocol_version,\"schemaVersion\":1,\"sourceCommit\":\"$tdlib_commit\",\"tdlibVersion\":\"$tdlib_version\"}" > "$stage/install-manifest.json"
chmod 0400 "$stage/install-manifest.json"
if [ "$(file_sha256 "$stage/wrench-telegram-tdlib")" != "$binary_sha" ]; then
  fail "staged Telegram helper changed before publication"
fi

publish_claimed_install "$stage" "$stage_dev" "$stage_ino" "$stage_birthtime_ns" "$target" "$parent" "$binary_sha" || fail "could not publish the claimed Telegram helper installation"
strict_validate_install "$target" "$platform" "$arch" || fail "published Telegram helper did not pass strict runtime-equivalent validation"
cleanup_bound_artifacts || fail "installed Telegram helper, but exact temporary cleanup could not be proven"
stage=
temporary_directory=
trap - EXIT HUP INT TERM
printf '%s\n' "Installed pinned Telegram TDLib $tdlib_version helper at $target"
