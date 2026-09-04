export type ProductionReleaseMarker = Readonly<{
  schemaVersion: "wrench-production-release-v1";
  name: "@hraness/wrench";
  repository: "hraness/wrench";
  tag: `v${string}`;
  version: string;
  sourceSha: string;
  deploymentUrl: string;
}>;

export const PRODUCTION_RELEASE_MARKER_SCHEMA: "wrench-production-release-v1";
export const PRODUCTION_RELEASE_MARKER_PATH: "/.well-known/wrench-release.json";
export const PRODUCTION_RELEASE_MARKER_MAX_BYTES: 1_024;
export const PRODUCTION_RELEASE_MARKER_NAME: "@hraness/wrench";
export const PRODUCTION_RELEASE_MARKER_REPOSITORY: "hraness/wrench";

export function createProductionReleaseMarker(value: Readonly<{
  deploymentUrl: string;
  name: string;
  sourceSha: string;
  tag: string;
  version: string;
}>): ProductionReleaseMarker;

export function serializeProductionReleaseMarker(value: unknown): string;
export function parseProductionReleaseMarker(text: string): ProductionReleaseMarker;
