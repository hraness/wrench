import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";

import {
  APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS,
  parseApplePhotosContactEvidenceArtifact,
  parseApplePhotosContactEvidenceExportResult,
} from "./apple-photos-contact-evidence";
import type {
  ApplePhotosContactEvidenceClientOptions,
  ApplePhotosContactEvidenceClientRequest,
  ApplePhotosContactEvidenceExportResult,
} from "./apple-photos-client-types";

export {
  parseApplePhotosContactEvidenceArtifact,
  parseApplePhotosContactEvidenceExportResult,
};

const MAX_STDERR_BYTES = 8 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1_000;

function fail(message: string): never {
  throw new Error(`Wrench Apple Photos client: ${message}`);
}

function cliSourcePath(): string {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource)) return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource)) return packagedSource;
  return fail("the installed Wrench CLI source is unavailable");
}

function requireBunRuntime(): void {
  if (typeof process.versions.bun !== "string") {
    return fail("@hraness/wrench/apple-photos requires Bun to run the installed Wrench CLI");
  }
}

function dataDescriptors(
  value: unknown,
  label: string,
): Readonly<Record<string, PropertyDescriptor>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(`${label} must use a plain, non-proxy object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(`${label} has a symbol field`);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) return fail(`${label} must contain only enumerable data properties`);
  }
  return descriptors;
}

function prepareRequest(
  value: ApplePhotosContactEvidenceClientRequest,
): ApplePhotosContactEvidenceClientRequest {
  const descriptors = dataDescriptors(value, "request");
  if (Object.keys(descriptors).some((key) => key !== "library")) {
    return fail("request contains an unsupported field");
  }
  const library = descriptors.library?.value as unknown;
  if (library === undefined) return Object.freeze({});
  if (
    typeof library !== "string"
    || !isAbsolute(library)
    || resolve(library) !== library
    || !library.endsWith(".photoslibrary")
    || Buffer.byteLength(library, "utf8") > 4_096
    || /[\0\r\n]/u.test(library)
  ) return fail("library must be one normalized absolute .photoslibrary path");
  return Object.freeze({ library });
}

function prepareEnvironment(
  value: ApplePhotosContactEvidenceClientOptions["environment"],
): Readonly<Record<string, string>> {
  const environment = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(process.env)) {
    if (typeof item === "string") environment[key] = item;
  }
  if (value === undefined) return Object.freeze(environment);
  const descriptors = dataDescriptors(value, "environment");
  for (const key of Object.keys(descriptors).sort()) {
    if (key.length < 1 || key.includes("=") || key.includes("\0")) {
      return fail("environment name is malformed");
    }
    const item = descriptors[key]!.value as unknown;
    if (item === undefined) delete environment[key];
    else if (typeof item !== "string" || item.includes("\0")) {
      return fail("environment value is malformed");
    } else environment[key] = item;
  }
  return Object.freeze(environment);
}

function prepareOptions(
  value: ApplePhotosContactEvidenceClientOptions,
): Readonly<Record<string, string>> {
  const descriptors = dataDescriptors(value, "options");
  if (Object.keys(descriptors).some((key) => key !== "environment")) {
    return fail("options contain an unsupported field");
  }
  return prepareEnvironment(
    descriptors.environment?.value as
      ApplePhotosContactEvidenceClientOptions["environment"],
  );
}

function boundedError(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_STDERR_BYTES) return text;
  return `${bytes.subarray(0, MAX_STDERR_BYTES).toString("utf8").trim()}…`;
}

/**
 * Execute Wrench's installed, reviewed Apple Photos export synchronously.
 * The process owns every SQLite path, query, snapshot, and cleanup decision.
 */
export function exportApplePhotosContactEvidenceSync(
  requestValue: ApplePhotosContactEvidenceClientRequest = {},
  optionsValue: ApplePhotosContactEvidenceClientOptions = {},
): ApplePhotosContactEvidenceExportResult {
  requireBunRuntime();
  const request = prepareRequest(requestValue);
  const environment = prepareOptions(optionsValue);
  const result = spawnSync(process.execPath, [
    cliSourcePath(),
    "apple-photos",
    "export-contact-evidence",
    ...(request.library === undefined ? [] : ["--library", request.library]),
    "--json",
  ], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumWireBytes,
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) return fail("export process could not complete");
  if (result.status !== 0 || typeof result.stdout !== "string") {
    const stderr = boundedError(result.stderr);
    return fail(stderr.length === 0 ? "export process failed" : stderr);
  }
  if (
    Buffer.byteLength(result.stdout, "utf8")
    > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumWireBytes
  ) return fail("export response exceeded its byte bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return fail("export response was not JSON");
  }
  return parseApplePhotosContactEvidenceExportResult(parsed);
}

export type {
  ApplePhotosContactEvidence,
  ApplePhotosContactEvidenceArtifact,
  ApplePhotosContactEvidenceClientOptions,
  ApplePhotosContactEvidenceClientRequest,
  ApplePhotosContactEvidenceCompleteness,
  ApplePhotosContactEvidenceExportReceipt,
  ApplePhotosContactEvidenceExportResult,
  ApplePhotosContactEvidencePrivacy,
} from "./apple-photos-client-types";
