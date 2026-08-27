#!/usr/bin/env bun

import { installReviewedImsgBinary } from "../providers/imessage-direct-install";

function binaryArgument(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--binary" || argv[1] === undefined) {
    throw new Error(
      "usage: bun run imessage:transport:install -- --binary /absolute/path/to/reviewed/imsg",
    );
  }
  return argv[1];
}

const installed = await installReviewedImsgBinary(
  binaryArgument(process.argv.slice(2)),
);
process.stdout.write(`${JSON.stringify({
  installed: true,
  alreadyPresent: installed.alreadyPresent,
  tool: "imsg-private-transport",
  version: installed.version,
  executableSha256: installed.executableSha256,
})}\n`);
