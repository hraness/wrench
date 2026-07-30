import { join } from "node:path";

import { ensurePrivateStateDirectory, wrenchStateHome } from "../storage";

const runtimeVersionPattern = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/u;

export function prepareStateHome(
  runtimeVersion: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (!runtimeVersionPattern.test(runtimeVersion)) {
    throw new Error("the WhatsApp runtime version must be a canonical numeric semantic version");
  }
  const root = wrenchStateHome(environment);
  ensurePrivateStateDirectory(join(root, "tools", "wacli", runtimeVersion), environment);
  return root;
}

if (import.meta.main) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length !== 1) throw new Error("exactly one WhatsApp runtime version is required");
    process.stdout.write(`${prepareStateHome(arguments_[0] ?? "")}\n`);
  } catch (error) {
    process.stderr.write(
      `wrench state-home resolver: ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    process.exitCode = 1;
  }
}
