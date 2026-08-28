import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [mode, statusPath, privateOutput] = process.argv.slice(2);
if (mode === undefined || statusPath === undefined || privateOutput === undefined) {
  throw new Error("missing lifecycle helper arguments");
}

const descendant = spawn(process.execPath, ["-e", [
  "process.on('SIGTERM', () => undefined);",
  "setInterval(() => undefined, 1000);",
].join("")], { stdio: "ignore" });

writeFileSync(privateOutput, "fixture artifact", { mode: 0o600 });
chmodSync(privateOutput, 0o600);
writeFileSync(statusPath, JSON.stringify({
  parent: process.pid,
  descendant: descendant.pid,
  temp: dirname(privateOutput),
}));

if (mode === "stdout-overflow") process.stdout.write("x".repeat(65 * 1024));
if (mode === "stderr-overflow") process.stderr.write("x".repeat(65 * 1024));
setInterval(() => undefined, 1_000);
