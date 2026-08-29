import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adoptDerivationNetworkBoundary,
  closeDerivationNetworkBoundary,
  closeInterruptedDerivationNetworkBoundary,
  createDerivationNetworkBoundary,
  verifyDerivationNetworkBoundary,
} from "./derivation-network-boundary";
import {
  DERIVATION_GUARD_CONTROL_SOCKET,
  DERIVATION_GUARD_PROXY_READY,
  derivationGuardControlSocketPath,
  parseDerivationNetworkGuard,
} from "./derivation-network-guard";
import { processOwnerStatus } from "./process-identity";

function identity(path: string): { readonly device: string; readonly inode: string } {
  const stats = lstatSync(path, { bigint: true });
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function boundaryFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const directory = join(root, "derivation");
  const socketDirectory = join(root, "socket");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(socketDirectory, { mode: 0o700 });
  chmodSync(root, 0o700);
  return { root, directory, socketDirectory, derivationId: crypto.randomUUID() };
}

async function createFixtureBoundary(fixture: ReturnType<typeof boundaryFixture>) {
  return createDerivationNetworkBoundary({
    derivationId: fixture.derivationId,
    directory: fixture.directory,
    directoryIdentity: identity(fixture.directory),
    socketDirectory: fixture.socketDirectory,
    socketIdentity: identity(fixture.socketDirectory),
    browserDomains: ["example.com"],
  });
}

function interruptedBoundaryInput(fixture: ReturnType<typeof boundaryFixture>) {
  return {
    derivationId: fixture.derivationId,
    directory: fixture.directory,
    directoryIdentity: identity(fixture.directory),
    socketDirectory: fixture.socketDirectory,
    socketIdentity: identity(fixture.socketDirectory),
  } as const;
}

describe("contained derivation network boundary lifecycle", () => {
  test("helper teardown never asks Bun to close and unlink the listener path", () => {
    const source = readFileSync(join(import.meta.dir, "derivation-network-proxy-helper.ts"), "utf8");
    expect(source).not.toMatch(/\bcontrol\??\.close\s*\(/u);
  });

  test("binds a private helper, revalidates it, closes it, and exposes no domain/path metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-network-boundary-test-"));
    const directory = join(root, "derivation");
    const socketDirectory = join(root, "socket");
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(socketDirectory, { mode: 0o700 });
    chmodSync(root, 0o700);
    const derivationId = crypto.randomUUID();
    let closed = false;
    try {
      const guard = await createDerivationNetworkBoundary({
        derivationId,
        directory,
        directoryIdentity: identity(directory),
        socketDirectory,
        socketIdentity: identity(socketDirectory),
        browserDomains: ["example.com", "*.upload.example.com"],
      });
      const serialized = JSON.stringify(guard);
      expect(serialized).not.toContain("example.com");
      expect(serialized).not.toContain(root);
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
      const controlPath = derivationGuardControlSocketPath(derivationId);
      expect(existsSync(controlPath)).toBeTrue();
      expect(existsSync(join(socketDirectory, DERIVATION_GUARD_CONTROL_SOCKET))).toBeFalse();
      const verification = {
        derivationId,
        directory,
        directoryIdentity: identity(directory),
        socketDirectory,
        socketIdentity: identity(socketDirectory),
        browserDomains: ["example.com", "*.upload.example.com"],
        guard,
      } as const;
      await expect(verifyDerivationNetworkBoundary(verification))
        .rejects.toThrow("changed identity");
      await adoptDerivationNetworkBoundary({ derivationId, guard });
      writeFileSync(join(socketDirectory, "agent-browser-unknown-sidecar"), "discard\n", { mode: 0o600 });
      for (const entry of readdirSync(socketDirectory)) {
        rmSync(join(socketDirectory, entry), { recursive: true, force: true });
      }
      expect(existsSync(controlPath)).toBeTrue();
      await expect(verifyDerivationNetworkBoundary(verification)).resolves.toBeUndefined();
      await closeDerivationNetworkBoundary({ derivationId, guard });
      closed = true;
      expect(processOwnerStatus(guard.proxy.owner)).toBe("different-or-dead");
      expect(existsSync(controlPath)).toBeFalse();
      await expect(verifyDerivationNetworkBoundary({
        derivationId,
        directory,
        directoryIdentity: identity(directory),
        socketDirectory,
        socketIdentity: identity(socketDirectory),
        browserDomains: ["example.com", "*.upload.example.com"],
        guard,
      })).rejects.toThrow();
    } finally {
      // A failed lifecycle assertion deliberately preserves private state;
      // the test root is removed only after the exact helper is gone.
      if (closed) rmSync(root, { recursive: true, force: true });
    }
  });

  test("abandons and removes the provisional socket when its parent dies before adoption", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-network-boundary-crash-test-"));
    const directory = join(root, "derivation");
    const socketDirectory = join(root, "socket");
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(socketDirectory, { mode: 0o700 });
    chmodSync(root, 0o700);
    const derivationId = crypto.randomUUID();
    const boundaryModule = join(import.meta.dir, "derivation-network-boundary.ts");
    const source = `
      import { lstatSync } from "node:fs";
      import { createDerivationNetworkBoundary } from ${JSON.stringify(boundaryModule)};
      const identity = (path) => {
        const stats = lstatSync(path, { bigint: true });
        return { device: stats.dev.toString(), inode: stats.ino.toString() };
      };
      const [directory, socketDirectory, derivationId] = process.argv.slice(1);
      const guard = await createDerivationNetworkBoundary({
        derivationId,
        directory,
        directoryIdentity: identity(directory),
        socketDirectory,
        socketIdentity: identity(socketDirectory),
        browserDomains: ["example.com"],
      });
      process.stdout.write(JSON.stringify(guard));
    `;
    let helperDead = false;
    try {
      const child = Bun.spawn([
        process.execPath,
        "--no-env-file",
        "--no-install",
        "--no-macros",
        "--no-addons",
        "-e",
        source,
        directory,
        socketDirectory,
        derivationId,
      ], {
        env: { NODE_ENV: "production" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const guard = parseDerivationNetworkGuard(JSON.parse(stdout) as unknown);
      const deadline = Date.now() + 3_000;
      while (
        processOwnerStatus(guard.proxy.owner) === "exact-live-owner"
        && Date.now() < deadline
      ) await Bun.sleep(25);
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      expect(helperDead).toBeTrue();
      expect(existsSync(socketDirectory)).toBeFalse();
      expect(existsSync(join(directory, DERIVATION_GUARD_PROXY_READY))).toBeFalse();
    } finally {
      // Only remove the fixture after the exact provisional helper is dead.
      if (helperDead) rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats a pre-adoption termination signal as provisional abandonment", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-network-boundary-signal-test-"));
    const directory = join(root, "derivation");
    const socketDirectory = join(root, "socket");
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(socketDirectory, { mode: 0o700 });
    chmodSync(root, 0o700);
    const guard = await createDerivationNetworkBoundary({
      derivationId: crypto.randomUUID(),
      directory,
      directoryIdentity: identity(directory),
      socketDirectory,
      socketIdentity: identity(socketDirectory),
      browserDomains: ["example.com"],
    });
    let helperDead = false;
    try {
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
      process.kill(guard.proxy.owner.pid, "SIGTERM");
      const deadline = Date.now() + 3_000;
      while (
        processOwnerStatus(guard.proxy.owner) === "exact-live-owner"
        && Date.now() < deadline
      ) await Bun.sleep(25);
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      expect(helperDead).toBeTrue();
      expect(existsSync(socketDirectory)).toBeFalse();
      expect(existsSync(join(directory, DERIVATION_GUARD_PROXY_READY))).toBeFalse();
    } finally {
      if (helperDead) rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats authenticated close before adoption as provisional abandonment", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-network-boundary-close-test-"));
    const directory = join(root, "derivation");
    const socketDirectory = join(root, "socket");
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(socketDirectory, { mode: 0o700 });
    chmodSync(root, 0o700);
    const derivationId = crypto.randomUUID();
    const guard = await createDerivationNetworkBoundary({
      derivationId,
      directory,
      directoryIdentity: identity(directory),
      socketDirectory,
      socketIdentity: identity(socketDirectory),
      browserDomains: ["example.com"],
    });
    let helperDead = false;
    try {
      await closeDerivationNetworkBoundary({ derivationId, guard });
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      expect(helperDead).toBeTrue();
      expect(existsSync(socketDirectory)).toBeFalse();
      expect(existsSync(join(directory, DERIVATION_GUARD_PROXY_READY))).toBeFalse();
    } finally {
      if (helperDead) rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleans every injected post-proxy initialization failure", async () => {
    for (const stage of [
      "after-proxy",
      "after-control-listen",
      "after-ready-write",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "wrench-network-boundary-failure-test-"));
      const directory = join(root, "derivation");
      const socketDirectory = join(root, "socket");
      mkdirSync(directory, { mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      chmodSync(root, 0o700);
      const derivationId = crypto.randomUUID();
      try {
        await expect(createDerivationNetworkBoundary({
          derivationId,
          directory,
          directoryIdentity: identity(directory),
          socketDirectory,
          socketIdentity: identity(socketDirectory),
          browserDomains: ["example.com"],
          failHelperAtForTest: stage,
        })).rejects.toThrow();
        expect(existsSync(socketDirectory)).toBeFalse();
        expect(existsSync(join(directory, DERIVATION_GUARD_PROXY_READY))).toBeFalse();
        expect(existsSync(derivationGuardControlSocketPath(derivationId))).toBeFalse();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("refuses a pre-existing standalone control path without replacing it", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-preexisting-test-");
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    writeFileSync(controlPath, "preserve\n", { flag: "wx", mode: 0o600 });
    try {
      await expect(createFixtureBoundary(fixture)).rejects.toThrow();
      expect(readFileSync(controlPath, "utf8")).toBe("preserve\n");
    } finally {
      rmSync(controlPath, { force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("terminates only the exact owner when its standalone control path is missing", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-missing-control-test-");
    const guard = await createFixtureBoundary(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    let helperDead = false;
    try {
      await adoptDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
      unlinkSync(controlPath);
      await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      expect(helperDead).toBeTrue();
      expect(existsSync(controlPath)).toBeFalse();
    } finally {
      if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
        await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
        helperDead = true;
      }
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("closes an authentic present endpoint from exact interrupted-init evidence", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-authentic-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    const owner = await closeInterruptedDerivationNetworkBoundary(input);
    expect(owner).toEqual(guard.proxy.owner);
    expect(processOwnerStatus(guard.proxy.owner)).toBe("different-or-dead");
    expect(existsSync(derivationGuardControlSocketPath(fixture.derivationId))).toBeFalse();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("signals only the ready-recorded owner for interrupted-init evidence with true ENOENT", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-missing-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    unlinkSync(controlPath);
    const owner = await closeInterruptedDerivationNetworkBoundary(input);
    expect(owner).toEqual(guard.proxy.owner);
    expect(processOwnerStatus(guard.proxy.owner)).toBe("different-or-dead");
    expect(existsSync(controlPath)).toBeFalse();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("waits through transient post-signal owner uncertainty before proving quiescence", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-transient-owner-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    let inspections = 0;
    let helperDead = false;
    try {
      unlinkSync(controlPath);
      const owner = await closeInterruptedDerivationNetworkBoundary({
        ...input,
        dependencies: {
          inspectOwner: (candidate) => {
            inspections += 1;
            if (inspections === 3) return "unknown";
            return processOwnerStatus(candidate);
          },
        },
      });
      expect(owner).toEqual(guard.proxy.owner);
      expect(inspections).toBeGreaterThan(3);
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      expect(helperDead).toBeTrue();
      expect(existsSync(controlPath)).toBeFalse();
    } finally {
      if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
        await closeInterruptedDerivationNetworkBoundary(input);
        helperDead = true;
      }
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed when post-signal owner uncertainty persists through the cleanup bound", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-persistent-owner-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    let inspections = 0;
    let now = 0;
    let helperDead = false;
    try {
      unlinkSync(controlPath);
      await expect(closeInterruptedDerivationNetworkBoundary({
        ...input,
        dependencies: {
          inspectOwner: (candidate) => {
            inspections += 1;
            if (inspections > 2) return "unknown";
            return processOwnerStatus(candidate);
          },
          monotonicNow: () => {
            now += 5_000;
            return now;
          },
        },
      })).rejects.toThrow("cannot prove process quiescence");
      expect(inspections).toBeGreaterThan(2);
      const helperDeadline = Date.now() + 1_000;
      while (
        processOwnerStatus(guard.proxy.owner) === "exact-live-owner"
        && Date.now() < helperDeadline
      ) await Bun.sleep(25);
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      expect(helperDead).toBeTrue();
      expect(existsSync(controlPath)).toBeFalse();
    } finally {
      if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
        await closeInterruptedDerivationNetworkBoundary(input);
        helperDead = true;
      }
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed when the cleanup monotonic clock is invalid", async () => {
    for (const clock of [
      {
        expected: "monotonic clock is non-finite",
        readings: [Number.NaN],
      },
      {
        expected: "monotonic clock is non-finite",
        readings: [10, Number.POSITIVE_INFINITY],
      },
      {
        expected: "monotonic clock moved backward",
        readings: [10, 11, 10],
      },
      {
        expected: "monotonic clock did not advance",
        readings: [10, 10, 10],
      },
    ] as const) {
      const fixture = boundaryFixture("wrench-network-boundary-invalid-clock-test-");
      const guard = await createFixtureBoundary(fixture);
      const input = interruptedBoundaryInput(fixture);
      const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
      let inspections = 0;
      let reading = 0;
      let helperDead = false;
      try {
        unlinkSync(controlPath);
        await expect(closeInterruptedDerivationNetworkBoundary({
          ...input,
          dependencies: {
            inspectOwner: () => {
              inspections += 1;
              return inspections <= 2 ? "exact-live-owner" : "unknown";
            },
            monotonicNow: () => clock.readings[reading++] ?? clock.readings.at(-1)!,
          },
        })).rejects.toThrow(clock.expected);
        const helperDeadline = Date.now() + 1_000;
        while (
          processOwnerStatus(guard.proxy.owner) === "exact-live-owner"
          && Date.now() < helperDeadline
        ) await Bun.sleep(25);
        helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
        expect(helperDead).toBeTrue();
        expect(existsSync(controlPath)).toBeFalse();
      } finally {
        if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
          await closeInterruptedDerivationNetworkBoundary(input);
          helperDead = true;
        }
        if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("rejects uncertain owner identity before signalling interrupted-init evidence", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-unknown-owner-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    let helperDead = false;
    try {
      unlinkSync(controlPath);
      for (const statuses of [
        ["unknown"],
        ["exact-live-owner", "unknown"],
      ] as const) {
        let inspections = 0;
        await expect(closeInterruptedDerivationNetworkBoundary({
          ...input,
          dependencies: {
            inspectOwner: () => statuses[inspections++] ?? "unknown",
          },
        })).rejects.toThrow("owner cannot be verified for cleanup");
        expect(inspections).toBe(statuses.length);
        expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
        expect(existsSync(controlPath)).toBeFalse();
      }
      await closeInterruptedDerivationNetworkBoundary(input);
      helperDead = true;
    } finally {
      if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
        await closeInterruptedDerivationNetworkBoundary(input);
        helperDead = true;
      }
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves interrupted-init owner, endpoint, and state on a foreign response", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-foreign-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    unlinkSync(controlPath);
    const fake = createServer((socket) => socket.end('{"schemaVersion":1,"ok":true}\n'));
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(controlPath, resolve);
    });
    chmodSync(controlPath, 0o600);
    let helperDead = false;
    try {
      await expect(closeInterruptedDerivationNetworkBoundary(input)).rejects.toThrow("malformed");
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
      expect(existsSync(controlPath)).toBeTrue();
      expect(existsSync(fixture.directory)).toBeTrue();
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      if (existsSync(controlPath)) unlinkSync(controlPath);
      await closeInterruptedDerivationNetworkBoundary(input);
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
    expect(helperDead).toBeTrue();
  });

  test("rejects interrupted-init ID, policy, socket, and directory cross-wires before owner inspection", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-crosswire-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    let inspections = 0;
    const dependencies = {
      inspectOwner: () => {
        inspections += 1;
        return "exact-live-owner" as const;
      },
    };
    let helperDead = false;
    try {
      await expect(closeInterruptedDerivationNetworkBoundary({
        ...input,
        derivationId: crypto.randomUUID(),
        dependencies,
      })).rejects.toThrow("changed identity");
      await expect(closeInterruptedDerivationNetworkBoundary({
        ...input,
        socketDirectory: `${input.socketDirectory}-foreign`,
        dependencies,
      })).rejects.toThrow("changed identity");
      await expect(closeInterruptedDerivationNetworkBoundary({
        ...input,
        directoryIdentity: { ...input.directoryIdentity, inode: "0" },
        dependencies,
      })).rejects.toThrow("directory changed identity");

      const readyPath = join(fixture.directory, DERIVATION_GUARD_PROXY_READY);
      const originalReady = readFileSync(readyPath, "utf8");
      const crossedReady = JSON.parse(originalReady) as Record<string, unknown>;
      crossedReady.policySha256 = "f".repeat(64);
      writeFileSync(readyPath, `${JSON.stringify(crossedReady)}\n`, { mode: 0o600 });
      await expect(closeInterruptedDerivationNetworkBoundary({
        ...input,
        dependencies,
      })).rejects.toThrow("changed identity");
      writeFileSync(readyPath, originalReady, { mode: 0o600 });

      expect(inspections).toBe(0);
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
      await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
      helperDead = true;
    } finally {
      if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
        await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
        helperDead = true;
      }
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("status-first interrupted recovery preserves the helper on ready owner or port mismatch", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-interrupted-ready-mismatch-test-");
    const guard = await createFixtureBoundary(fixture);
    const input = interruptedBoundaryInput(fixture);
    const readyPath = join(fixture.directory, DERIVATION_GUARD_PROXY_READY);
    const originalReady = readFileSync(readyPath, "utf8");
    const originalValue = JSON.parse(originalReady) as Record<string, unknown>;
    let helperDead = false;
    try {
      const wrongPort = {
        ...originalValue,
        port: guard.proxy.port === 65_535 ? 65_534 : guard.proxy.port + 1,
      };
      writeFileSync(readyPath, `${JSON.stringify(wrongPort)}\n`, { mode: 0o600 });
      await expect(closeInterruptedDerivationNetworkBoundary(input))
        .rejects.toThrow("status changed identity");
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");

      const wrongOwner = {
        ...originalValue,
        owner: {
          ...(originalValue.owner as Record<string, unknown>),
          processStartId: "e".repeat(64),
        },
      };
      writeFileSync(readyPath, `${JSON.stringify(wrongOwner)}\n`, { mode: 0o600 });
      await expect(closeInterruptedDerivationNetworkBoundary(input))
        .rejects.toThrow("status changed identity");
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");

      writeFileSync(readyPath, originalReady, { mode: 0o600 });
      await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
      helperDead = true;
    } finally {
      if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
        writeFileSync(readyPath, originalReady, { mode: 0o600 });
        await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
        helperDead = true;
      }
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects cross-wired derivation IDs before probing or signalling either owner", async () => {
    const first = boundaryFixture("wrench-network-boundary-crosswire-a-test-");
    const second = boundaryFixture("wrench-network-boundary-crosswire-b-test-");
    const firstGuard = await createFixtureBoundary(first);
    const secondGuard = await createFixtureBoundary(second);
    let cleaned = false;
    try {
      await adoptDerivationNetworkBoundary({ derivationId: first.derivationId, guard: firstGuard });
      await adoptDerivationNetworkBoundary({ derivationId: second.derivationId, guard: secondGuard });
      await expect(closeDerivationNetworkBoundary({
        derivationId: second.derivationId,
        guard: firstGuard,
      })).rejects.toThrow("does not match its derivation ID");
      expect(processOwnerStatus(firstGuard.proxy.owner)).toBe("exact-live-owner");
      expect(processOwnerStatus(secondGuard.proxy.owner)).toBe("exact-live-owner");
      await closeDerivationNetworkBoundary({ derivationId: first.derivationId, guard: firstGuard });
      await closeDerivationNetworkBoundary({ derivationId: second.derivationId, guard: secondGuard });
      cleaned = true;
    } finally {
      if (processOwnerStatus(firstGuard.proxy.owner) === "exact-live-owner") {
        await closeDerivationNetworkBoundary({ derivationId: first.derivationId, guard: firstGuard });
      }
      if (processOwnerStatus(secondGuard.proxy.owner) === "exact-live-owner") {
        await closeDerivationNetworkBoundary({ derivationId: second.derivationId, guard: secondGuard });
      }
      if (cleaned) {
        rmSync(first.root, { recursive: true, force: true });
        rmSync(second.root, { recursive: true, force: true });
      }
    }
  });

  test("rejects a malformed derivation ID before inspecting or signalling its owner", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-malformed-id-test-");
    const guard = await createFixtureBoundary(fixture);
    let inspections = 0;
    let helperDead = false;
    try {
      await expect(closeDerivationNetworkBoundary({
        derivationId: "not-a-derivation-id",
        guard,
        dependencies: {
          inspectOwner: () => {
            inspections += 1;
            return "exact-live-owner";
          },
        },
      })).rejects.toThrow("malformed");
      expect(inspections).toBe(0);
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
      await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
      helperDead = true;
    } finally {
      if (!helperDead && processOwnerStatus(guard.proxy.owner) === "exact-live-owner") {
        await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
        helperDead = true;
      }
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves a live owner and a refused rebound endpoint", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-rebound-control-test-");
    const guard = await createFixtureBoundary(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    await adoptDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
    unlinkSync(controlPath);
    const source = `
      import { chmodSync } from "node:fs";
      import { createServer } from "node:net";
      const path = ${JSON.stringify(controlPath)};
      const server = createServer();
      server.listen(path, () => chmodSync(path, 0o600));
      setInterval(() => {}, 1000);
    `;
    const rebound = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 2_000;
    let reboundReady = false;
    while (!reboundReady && Date.now() < deadline) {
      try {
        const stats = lstatSync(controlPath);
        reboundReady = stats.isSocket() && (stats.mode & 0o777) === 0o600;
      } catch {
        // The child has not bound the test endpoint yet.
      }
      if (!reboundReady) await Bun.sleep(10);
    }
    expect(reboundReady).toBeTrue();
    process.kill(rebound.pid, "SIGKILL");
    await rebound.exited;
    let helperDead = false;
    try {
      await expect(closeDerivationNetworkBoundary({
        derivationId: fixture.derivationId,
        guard,
      })).rejects.toThrow("unavailable");
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
      expect(existsSync(controlPath)).toBeTrue();
    } finally {
      if (existsSync(controlPath)) unlinkSync(controlPath);
      await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
    expect(helperDead).toBeTrue();
  });

  test("helper signal teardown preserves a rebound regular control path", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-helper-rebound-test-");
    const guard = await createFixtureBoundary(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    await adoptDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
    unlinkSync(controlPath);
    writeFileSync(controlPath, "foreign-rebound\n", { flag: "wx", mode: 0o600 });
    let helperDead = false;
    try {
      process.kill(guard.proxy.owner.pid, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (
        processOwnerStatus(guard.proxy.owner) === "exact-live-owner"
        && Date.now() < deadline
      ) await Bun.sleep(25);
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      expect(helperDead).toBeTrue();
      expect(readFileSync(controlPath, "utf8")).toBe("foreign-rebound\n");
    } finally {
      expect(readFileSync(controlPath, "utf8")).toBe("foreign-rebound\n");
      unlinkSync(controlPath);
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves an exact owner when a bound endpoint returns a malformed response", async () => {
    const fixture = boundaryFixture("wrench-network-boundary-malformed-control-test-");
    const guard = await createFixtureBoundary(fixture);
    const controlPath = derivationGuardControlSocketPath(fixture.derivationId);
    await adoptDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
    unlinkSync(controlPath);
    const fake = createServer((socket) => socket.end('{"schemaVersion":1,"ok":true}\n'));
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(controlPath, resolve);
    });
    chmodSync(controlPath, 0o600);
    let helperDead = false;
    try {
      await expect(closeDerivationNetworkBoundary({
        derivationId: fixture.derivationId,
        guard,
      })).rejects.toThrow("malformed");
      expect(processOwnerStatus(guard.proxy.owner)).toBe("exact-live-owner");
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      if (existsSync(controlPath)) unlinkSync(controlPath);
      await closeDerivationNetworkBoundary({ derivationId: fixture.derivationId, guard });
      helperDead = processOwnerStatus(guard.proxy.owner) === "different-or-dead";
      if (helperDead) rmSync(fixture.root, { recursive: true, force: true });
    }
    expect(helperDead).toBeTrue();
  });
});
