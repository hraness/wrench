// @bun
// src/provider-plugin-identifiers.ts
var PROVIDER_PLUGIN_ID_MAX_LENGTH = 63;
var PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH = 163;
var strictKebabPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var strictKebabSegmentPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var portableProviderPluginVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
function isPortableProviderPluginVersion(value) {
  if (typeof value !== "string" || value.length > 128)
    return false;
  const match = portableProviderPluginVersionPattern.exec(value);
  if (match === null)
    return false;
  const prerelease = match[1];
  return prerelease === undefined || prerelease.split(".").every((identifier) => !/^[0-9]+$/u.test(identifier) || identifier === "0" || !identifier.startsWith("0"));
}
function isProviderPluginId(value) {
  return typeof value === "string" && value.length <= PROVIDER_PLUGIN_ID_MAX_LENGTH && strictKebabPattern.test(value);
}
function isProviderPluginSurfaceId(value) {
  return isProviderPluginId(value);
}
function isProviderPluginOperationName(value) {
  if (typeof value !== "string" || value.length > PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH) {
    return false;
  }
  const segments = value.split(".");
  return segments.length >= 2 && segments.length <= 4 && segments.every((segment) => segment.length <= 40 && strictKebabSegmentPattern.test(segment));
}

export { PROVIDER_PLUGIN_ID_MAX_LENGTH, PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH, isPortableProviderPluginVersion, isProviderPluginId, isProviderPluginSurfaceId, isProviderPluginOperationName };
