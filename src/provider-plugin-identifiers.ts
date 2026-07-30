/** Shared bounded identifiers at every provider-plugin trust boundary. */
export const PROVIDER_PLUGIN_ID_MAX_LENGTH = 63;
export const PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH = 163;

export type ProviderPluginId = string;
export type ProviderPluginSurfaceId = string;
export type ProviderPluginOperationName = string;

const strictKebabPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const strictKebabSegmentPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const portableProviderPluginVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isPortableProviderPluginVersion(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = portableProviderPluginVersionPattern.exec(value);
  if (match === null) return false;
  const prerelease = match[1];
  return prerelease === undefined
    || prerelease.split(".").every((identifier) =>
      !/^[0-9]+$/u.test(identifier)
      || identifier === "0"
      || !identifier.startsWith("0"));
}

export function isProviderPluginId(value: string): boolean;
export function isProviderPluginId(value: unknown): value is ProviderPluginId;
export function isProviderPluginId(value: unknown): boolean {
  return typeof value === "string"
    && value.length <= PROVIDER_PLUGIN_ID_MAX_LENGTH
    && strictKebabPattern.test(value);
}

export function isProviderPluginSurfaceId(value: string): boolean;
export function isProviderPluginSurfaceId(
  value: unknown,
): value is ProviderPluginSurfaceId;
export function isProviderPluginSurfaceId(value: unknown): boolean {
  return isProviderPluginId(value);
}

export function isProviderPluginOperationName(value: string): boolean;
export function isProviderPluginOperationName(
  value: unknown,
): value is ProviderPluginOperationName;
export function isProviderPluginOperationName(value: unknown): boolean {
  if (
    typeof value !== "string"
    || value.length > PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH
  ) {
    return false;
  }
  const segments = value.split(".");
  return segments.length >= 2
    && segments.length <= 4
    && segments.every((segment) =>
      segment.length <= 40 && strictKebabSegmentPattern.test(segment));
}
