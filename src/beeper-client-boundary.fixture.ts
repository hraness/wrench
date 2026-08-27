import { mock } from "bun:test";
import * as childProcess from "node:child_process";

import {
  createBeeperContactInteractionExportResult,
  summarizeBeeperContactInteractions,
} from "./beeper-contact-interactions";
import type {
  BeeperContactInteractionExportBounds,
} from "./beeper-contact-interactions";

const output = await summarizeBeeperContactInteractions({
  source: Object.freeze({
    descriptor: Object.freeze({
      source: Object.freeze({ id: "beeper-local", version: "1.1.0" }),
      provider: Object.freeze({ id: "beeper", version: "0.6.2" }),
    }),
    records: (async function* () {})(),
    completion: () => Promise.resolve(Object.freeze({
      completeness: Object.freeze({
        kind: "bounded-local",
        reason: "desktop-local-sequential-export",
        observedFrom: null,
        observedThrough: null,
      }),
      warnings: Object.freeze([]),
    })),
  }),
  coordinateForRecord: () => undefined,
});

const requestedBounds = Object.freeze({
  limitChats: 100,
  limitMessages: null,
  maxParticipants: 500,
});
const makeResult = (
  authId: string,
  bounds: BeeperContactInteractionExportBounds = requestedBounds,
) => createBeeperContactInteractionExportResult({
  runId: "00000000-0000-4000-8000-000000000123",
  startedAt: "2026-08-26T11:59:59.000Z",
  finishedAt: "2026-08-26T12:00:05.000Z",
  authId,
  authIdentitySha256: "a".repeat(64),
  bounds,
  output,
});

const responses = [
  makeResult("beeper-main"),
  makeResult("beeper-swapped"),
  makeResult("beeper-main", Object.freeze({
    ...requestedBounds,
    limitMessages: 1,
  })),
];
let responseIndex = 0;
const observedArguments: Array<readonly string[]> = [];

await mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: ((
    _command: string,
    arguments_: readonly string[],
  ) => {
    observedArguments.push(arguments_);
    const response = responses[responseIndex++];
    if (response === undefined) throw new Error("fixture response was exhausted");
    return {
      status: 0,
      stdout: JSON.stringify(response),
      stderr: "",
    };
  }) as unknown as typeof childProcess.spawnSync,
}));

const { exportBeeperContactInteractionsSync } = await import("./beeper-client");
const request = Object.freeze({
  authId: "beeper-main",
  limitChats: 100,
  maxParticipants: 500,
});
const result = exportBeeperContactInteractionsSync(request);
if (
  result.receipt.auth.id !== request.authId
  || result.receipt.bounds.limitChats !== request.limitChats
  || result.receipt.bounds.limitMessages !== null
  || result.receipt.bounds.maxParticipants !== request.maxParticipants
) throw new Error("public Beeper client did not return its exact request-bound result");

for (const expectedMessage of [
  "Wrench Beeper client: summary receipt auth does not match its request",
  "Wrench Beeper client: summary receipt bounds do not match its request",
] as const) {
  let message = "";
  try {
    exportBeeperContactInteractionsSync(request);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message !== expectedMessage) {
    throw new Error(`public Beeper client accepted a swapped receipt: ${JSON.stringify({
      expectedMessage,
      message,
    })}`);
  }
}

if (
  observedArguments.length !== 3
  || observedArguments.some((arguments_) => !arguments_.includes("--limit-chats"))
  || observedArguments.some((arguments_) => arguments_.includes("--limit-messages"))
  || observedArguments.some((arguments_) => !arguments_.includes("--max-participants"))
) throw new Error("public Beeper client changed the requested process bounds");
