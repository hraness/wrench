#!/usr/bin/env bun

import { isAbsolute } from "node:path";

const callerWorkingDirectory = process.env.WRENCH_LOCAL_DEV_CALLER_CWD;
if (
  callerWorkingDirectory === undefined
  || !isAbsolute(callerWorkingDirectory)
  || callerWorkingDirectory.includes("\0")
) {
  throw new Error("WRENCH_LOCAL_DEV_CALLER_CWD must be an absolute physical path");
}

process.chdir(callerWorkingDirectory);
const { runWrenchCliProcess } = await import("../../src/cli");
await runWrenchCliProcess(process.argv.slice(2));
