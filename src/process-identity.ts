import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dlopen, ptr } from "bun:ffi";

export type ProcessStartIdentity = {
  readonly bootId: string;
  readonly processStartId: string;
};

export type ProcessOwnerIdentity = ProcessStartIdentity & {
  readonly pid: number;
};

export type ProcessOwnerStatus =
  | "exact-live-owner"
  | "different-or-dead"
  | "unknown";

type ProcessInspection =
  | { readonly status: "alive"; readonly processStartId: string }
  | { readonly status: "dead" | "missing" | "unknown" };

type ProcessRecordInspection =
  | { readonly status: "alive"; readonly rawStartId: string }
  | { readonly status: "dead" | "unknown" };

type DarwinProcessIdentityRecordReader = (
  pid: number,
) => Uint8Array | null;

let cachedBootId: string | null = null;
let cachedCurrentProcessStartIdentity: {
  readonly pid: number;
  readonly bootId: string;
  readonly processStartId: string;
} | null = null;
let cachedDarwinProcPidInfo:
  | ((pid: number, flavor: number, buffer: Uint8Array) => number)
  | undefined;

const DARWIN_PROCESS_STATE_PATTERN = /^[DIRSTUZ][+<>AELNSsVWX]*$/u;
const DARWIN_PROC_PID_T_BSDINFO_WITH_UNIQID = 18;
const DARWIN_PROC_BSDINFO_SIZE = 136;
const DARWIN_PROC_UNIQIDENTIFIERINFO_SIZE = 56;
const DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE =
  DARWIN_PROC_BSDINFO_SIZE + DARWIN_PROC_UNIQIDENTIFIERINFO_SIZE;
const DARWIN_PROC_BSDINFO_FLAGS_OFFSET = 0;
const DARWIN_PROC_BSDINFO_STATUS_OFFSET = 4;
const DARWIN_PROC_BSDINFO_PID_OFFSET = 12;
const DARWIN_PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const DARWIN_PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
const DARWIN_PROC_UNIQUE_ID_OFFSET = 16;
const DARWIN_PROC_ID_VERSION_OFFSET = 32;
const DARWIN_PROC_FLAG_INEXIT = 0x4;
const DARWIN_PROCESS_STATUS_IDLE = 1;
const DARWIN_PROCESS_STATUS_RUNNING = 2;
const DARWIN_PROCESS_STATUS_SLEEPING = 3;
const DARWIN_PROCESS_STATUS_STOPPED = 4;
const DARWIN_PROCESS_STATUS_ZOMBIE = 5;
const DARWIN_PROCESS_INSPECTION_ATTEMPTS = 3;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function identityDigest(kind: string, value: string): string {
  return createHash("sha256")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function commandText(command: string, arguments_: readonly string[]): string {
  const environment: NodeJS.ProcessEnv = process.platform === "win32"
    ? {
        NODE_ENV: "production",
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
      }
    : { LANG: "C", LC_ALL: "C", NODE_ENV: "production", TZ: "UTC" };
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    env: environment,
    timeout: 2_000,
    windowsHide: true,
  }).trim();
}

function windowsPowerShellPath(): string {
  return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
}

function normalizeDarwinBootSessionUuid(raw: string): string {
  const value = raw.trim();
  if (!UUID_PATTERN.test(value)) {
    throw new Error("system boot identity is malformed");
  }
  return value.toLowerCase();
}

function darwinBootId(raw: string): string {
  return identityDigest("io-boot", normalizeDarwinBootSessionUuid(raw));
}

function currentBootId(): string {
  if (cachedBootId !== null) return cachedBootId;
  let raw: string;
  if (process.platform === "linux") {
    raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[a-f0-9-]{36}$/iu.test(raw)) {
      throw new Error("system boot identity is malformed");
    }
  } else if (process.platform === "darwin") {
    cachedBootId = darwinBootId(
      commandText(
        "/usr/sbin/sysctl",
        ["-n", "kern.bootsessionuuid"],
      ),
    );
    return cachedBootId;
  } else if (process.platform === "win32") {
    raw = commandText(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
    ]);
    if (!/^\d{10,30}$/u.test(raw)) {
      throw new Error("system boot identity is malformed");
    }
  } else {
    throw new Error(`system boot identity is unsupported on ${process.platform}`);
  }
  cachedBootId = identityDigest("io-boot", raw);
  return cachedBootId;
}

function processIsDefinitelyMissing(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ESRCH"
    );
  }
}

function inspectLinuxProcessRecord(raw: string): ProcessRecordInspection {
  const close = raw.lastIndexOf(")");
  if (close < 1) return { status: "unknown" };
  const fields = raw.slice(close + 1).trim().split(/\s+/u);
  const state = fields[0];
  if (state === "Z" || state === "X" || state === "x") {
    return { status: "dead" };
  }
  if (
    state !== "R"
    && state !== "S"
    && state !== "D"
    && state !== "T"
    && state !== "t"
    && state !== "W"
    && state !== "K"
    && state !== "P"
    && state !== "I"
  ) {
    return { status: "unknown" };
  }
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
    return { status: "unknown" };
  }
  return { status: "alive", rawStartId: startTicks };
}

function inspectDarwinProcessInfo(
  raw: Uint8Array,
  expectedPid: number,
): ProcessRecordInspection {
  if (raw.byteLength < DARWIN_PROC_BSDINFO_SIZE) {
    return { status: "unknown" };
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const flags = view.getUint32(DARWIN_PROC_BSDINFO_FLAGS_OFFSET, true);
  const status = view.getUint32(DARWIN_PROC_BSDINFO_STATUS_OFFSET, true);
  const pid = view.getUint32(DARWIN_PROC_BSDINFO_PID_OFFSET, true);
  // proc_pidinfo must return the exact requested PID. A mismatch is an
  // untrusted read, not proof that the requested process has a different
  // identity, so callers retain uncertainty and may retry.
  if (pid !== expectedPid) return { status: "unknown" };
  if (
    status === DARWIN_PROCESS_STATUS_ZOMBIE
    || (flags & DARWIN_PROC_FLAG_INEXIT) !== 0
  ) {
    return { status: "dead" };
  }
  if (
    status !== DARWIN_PROCESS_STATUS_IDLE
    && status !== DARWIN_PROCESS_STATUS_RUNNING
    && status !== DARWIN_PROCESS_STATUS_SLEEPING
    && status !== DARWIN_PROCESS_STATUS_STOPPED
  ) {
    return { status: "unknown" };
  }
  const seconds = view.getBigUint64(
    DARWIN_PROC_BSDINFO_START_SECONDS_OFFSET,
    true,
  );
  const microseconds = view.getBigUint64(
    DARWIN_PROC_BSDINFO_START_MICROSECONDS_OFFSET,
    true,
  );
  if (seconds === 0n || microseconds >= 1_000_000n) {
    return { status: "unknown" };
  }
  return {
    status: "alive",
    rawStartId: `${seconds}:${microseconds}`,
  };
}

function darwinUniqueProcessIdentity(raw: Uint8Array): string | null {
  if (raw.byteLength < DARWIN_PROC_UNIQIDENTIFIERINFO_SIZE) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const uniqueId = view.getBigUint64(DARWIN_PROC_UNIQUE_ID_OFFSET, true);
  const idVersion = view.getUint32(DARWIN_PROC_ID_VERSION_OFFSET, true);
  if (uniqueId === 0n || idVersion === 0) return null;
  return `${uniqueId}:${idVersion}`;
}

function inspectDarwinProcessIdentity(
  raw: Uint8Array,
  expectedPid: number,
): ProcessRecordInspection {
  if (raw.byteLength < DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE) {
    return { status: "unknown" };
  }
  const bsdInfo = raw.subarray(0, DARWIN_PROC_BSDINFO_SIZE);
  const uniqueInfo = raw.subarray(
    DARWIN_PROC_BSDINFO_SIZE,
    DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE,
  );
  const record = inspectDarwinProcessInfo(bsdInfo, expectedPid);
  if (record.status !== "alive") return record;
  const uniqueIdentity = darwinUniqueProcessIdentity(uniqueInfo);
  if (uniqueIdentity === null) return { status: "unknown" };
  return {
    status: "alive",
    rawStartId: `${uniqueIdentity}:${record.rawStartId}`,
  };
}

function darwinProcPidInfo():
  ((pid: number, flavor: number, buffer: Uint8Array) => number) | null {
  if (cachedDarwinProcPidInfo !== undefined) return cachedDarwinProcPidInfo;
  try {
    const library = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: ["int", "int", "u64", "ptr", "int"],
        returns: "int",
      },
    } as const);
    cachedDarwinProcPidInfo = (pid, flavor, buffer) =>
      library.symbols.proc_pidinfo(
        pid,
        flavor,
        0,
        ptr(buffer),
        buffer.byteLength,
      );
  } catch {
    // A transient loader failure must not disable exact process inspection for
    // the rest of this process. Cache a successfully opened symbol only.
    return null;
  }
  return cachedDarwinProcPidInfo;
}

function darwinProcessIsDefinitelyDead(pid: number): boolean {
  if (processIsDefinitelyMissing(pid)) return true;
  try {
    const state = commandText("/bin/ps", [
      "-o",
      "state=",
      "-p",
      String(pid),
    ]);
    if (
      DARWIN_PROCESS_STATE_PATTERN.test(state)
      && state.startsWith("Z")
    ) {
      return true;
    }
  } catch {
    // A state-only fallback may fail during exit; retain unknown.
  }
  return processIsDefinitelyMissing(pid);
}

function inspectDarwinProcessWithReader(
  pid: number,
  readRecord: DarwinProcessIdentityRecordReader,
  isDefinitelyDead: (pid: number) => boolean,
): ProcessRecordInspection {
  for (let attempt = 0; attempt < DARWIN_PROCESS_INSPECTION_ATTEMPTS; attempt += 1) {
    let record: ProcessRecordInspection = { status: "unknown" };
    try {
      const raw = readRecord(pid);
      if (raw !== null) record = inspectDarwinProcessIdentity(raw, pid);
    } catch {
      // A failed kernel read is uncertain and receives the same bounded retry.
    }
    if (
      record.status === "alive"
      || record.status === "dead"
    ) {
      return record;
    }
    if (isDefinitelyDead(pid)) return { status: "dead" };
  }
  return { status: "unknown" };
}

function inspectDarwinProcess(pid: number): ProcessRecordInspection {
  // Darwin flavor 18 returns the public BSD record and the kernel's 64-bit
  // process-unique ID from one proc reference. Short or temporarily unknown
  // reads receive a small bounded retry while the PID remains present. A
  // parsed dead record is terminal and never gets replaced by a later read.
  // Persistent uncertainty stays unknown rather than falling back to a
  // timestamp that can collide after PID reuse.
  return inspectDarwinProcessWithReader(
    pid,
    (targetPid) => {
      const inspect = darwinProcPidInfo();
      if (inspect === null) return null;
      const processInfo = Buffer.alloc(DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE);
      const bytesRead = inspect(
        targetPid,
        DARWIN_PROC_PID_T_BSDINFO_WITH_UNIQID,
        processInfo,
      );
      if (
        !Number.isSafeInteger(bytesRead)
        || bytesRead < 0
        || bytesRead > DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE
      ) {
        return null;
      }
      return processInfo.subarray(0, bytesRead);
    },
    darwinProcessIsDefinitelyDead,
  );
}

export function inspectLinuxProcessRecordForTest(
  raw: string,
): ProcessRecordInspection {
  return inspectLinuxProcessRecord(raw);
}

export function inspectDarwinProcessInfoForTest(
  raw: Uint8Array,
  expectedPid: number,
): ProcessRecordInspection {
  return inspectDarwinProcessInfo(raw, expectedPid);
}

export function inspectDarwinProcessIdentityForTest(
  raw: Uint8Array,
  expectedPid: number,
): ProcessRecordInspection {
  return inspectDarwinProcessIdentity(raw, expectedPid);
}

export function darwinBootIdForTest(raw: string): string {
  return darwinBootId(raw);
}

export function normalizeDarwinBootSessionUuidForTest(raw: string): string {
  return normalizeDarwinBootSessionUuid(raw);
}

export function inspectDarwinProcessWithReaderForTest(
  pid: number,
  readRecord: DarwinProcessIdentityRecordReader,
  isDefinitelyDead: (pid: number) => boolean,
): ProcessRecordInspection {
  return inspectDarwinProcessWithReader(pid, readRecord, isDefinitelyDead);
}

function inspectProcessStartId(
  pid: number,
  bootId: string,
): ProcessInspection {
  if (
    pid === process.pid
    && cachedCurrentProcessStartIdentity?.pid === pid
    && cachedCurrentProcessStartIdentity.bootId === bootId
  ) {
    return {
      status: "alive",
      processStartId: cachedCurrentProcessStartIdentity.processStartId,
    };
  }
  try {
    let raw: string;
    if (process.platform === "linux") {
      const record = inspectLinuxProcessRecord(
        readFileSync(`/proc/${pid}/stat`, "utf8").trim(),
      );
      if (record.status !== "alive") return record;
      raw = record.rawStartId;
    } else if (process.platform === "win32") {
      raw = commandText(windowsPowerShellPath(), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p=[int]$args[0]; (Get-Process -Id $p -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        String(pid),
      ]);
      if (!/^\d{10,30}$/u.test(raw)) return { status: "unknown" };
    } else if (process.platform === "darwin") {
      const record = inspectDarwinProcess(pid);
      if (record.status !== "alive") return record;
      raw = record.rawStartId;
    } else {
      return { status: "unknown" };
    }
    const processStartId = identityDigest(
      "io-process-start",
      `${bootId}\0${raw}`,
    );
    if (pid === process.pid) {
      cachedCurrentProcessStartIdentity = { pid, bootId, processStartId };
    }
    return { status: "alive", processStartId };
  } catch (error) {
    if (
      processIsDefinitelyMissing(pid)
      || (
        process.platform === "linux"
        && typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      )
    ) {
      return { status: "missing" };
    }
    return { status: "unknown" };
  }
}

export function currentProcessStartIdentity(): ProcessStartIdentity {
  const owner = captureProcessOwnerIdentity(process.pid);
  return Object.freeze({
    bootId: owner.bootId,
    processStartId: owner.processStartId,
  });
}

/**
 * Capture one exact live process identity. Callers use the start identity, not
 * PID alone, so a later PID reuse cannot satisfy containment proof.
 */
export function captureProcessOwnerIdentity(
  pid: number,
): ProcessOwnerIdentity {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("process identity PID is malformed");
  }
  const bootId = currentBootId();
  const inspection = inspectProcessStartId(pid, bootId);
  if (inspection.status !== "alive") {
    throw new Error("exact live process identity is unavailable");
  }
  return Object.freeze({
    pid,
    bootId,
    processStartId: inspection.processStartId,
  });
}

export function processOwnerStatus(
  owner: ProcessOwnerIdentity,
): ProcessOwnerStatus {
  const bootId = currentBootId();
  if (bootId !== owner.bootId) return "different-or-dead";
  const inspection = inspectProcessStartId(owner.pid, bootId);
  if (inspection.status !== "alive") {
    return inspection.status === "unknown" ? "unknown" : "different-or-dead";
  }
  return inspection.processStartId === owner.processStartId
    ? "exact-live-owner"
    : "different-or-dead";
}
