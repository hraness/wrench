import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { exportBeeperMessageLikeMeBundle } from "../src/beeper-message-like-me-export";
import {
  BEEPER_MESSAGE_LIKE_ME_GOLDEN_FINISHED_AT,
  BEEPER_MESSAGE_LIKE_ME_GOLDEN_STARTED_AT,
  createBeeperMessageLikeMeGoldenSource,
} from "../src/beeper-message-like-me-golden-fixture";

const parent = resolve(import.meta.dir, "..", "src", "fixtures");
const outputRoot = resolve(parent, "beeper-message-like-me-v1");
await mkdir(parent, { recursive: true, mode: 0o755 });
const instants = [
  BEEPER_MESSAGE_LIKE_ME_GOLDEN_STARTED_AT,
  BEEPER_MESSAGE_LIKE_ME_GOLDEN_FINISHED_AT,
];
const result = await exportBeeperMessageLikeMeBundle({
  outputRoot,
  source: createBeeperMessageLikeMeGoldenSource(),
  clock: () => new Date(instants.shift() ?? "invalid"),
});
process.stdout.write(`${result.manifestSha256}\n`);
