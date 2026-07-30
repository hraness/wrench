import { createHash } from "node:crypto";

import type {
  PortableProviderPluginBindingV1,
  PortableProviderPluginCapabilitiesV1,
  PortableProviderPluginOperationV1,
} from "./provider-plugin-package";

export const PORTABLE_OPERATION_IDENTITY_VERSION = 1 as const;

export type PortableProviderPluginPackageMetadataV1 = {
  readonly id: string;
  readonly version: string;
  readonly hostApiVersion: 1;
  readonly bundleSha256: string;
  readonly manifestSha256: string;
  readonly capabilities: PortableProviderPluginCapabilitiesV1;
};

export type PortableProviderPluginArtifactMetadataV1 = Omit<
  PortableProviderPluginPackageMetadataV1,
  "id" | "version"
>;

export type PortableOperationIdentityV1 = {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly hostApiVersion: 1;
  readonly bundleSha256: string;
  readonly manifestSha256: string;
  readonly adapterId: string;
  readonly transport: PortableProviderPluginBindingV1["transport"];
  readonly surfaceId: string;
  readonly operation: string;
  readonly contractVersion: number;
  readonly descriptorSha256: string;
};

export type PortableOperationIdentitySourceV1 = {
  readonly package: PortableProviderPluginPackageMetadataV1;
  readonly binding: PortableProviderPluginBindingV1;
  readonly operation: PortableProviderPluginOperationV1;
};

const descriptorDomain =
  `io-portable-operation-descriptor-v${PORTABLE_OPERATION_IDENTITY_VERSION}\0`;
const pluginIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const pluginVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const adapterIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;
const operationPattern =
  /^[a-z][a-z0-9-]{0,39}(?:\.[a-z][a-z0-9-]{0,39}){1,3}$/u;

function ownDataValue(
  value: object,
  key: PropertyKey,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !("value" in descriptor)
  ) {
    throw new Error(`${label} contains unsupported accessor state`);
  }
  return descriptor.value as unknown;
}

function canonicalPortableJson(value: unknown, label: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if ((Object.getPrototypeOf(value) as unknown) !== Array.prototype) {
      throw new Error(`${label} contains a non-plain array`);
    }
    const length = value.length;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1
      || !keys.includes("length")
      || Array.from({ length }, (_unused, index) => String(index))
        .some((key) => !keys.includes(key))
    ) {
      throw new Error(`${label} contains a sparse or decorated array`);
    }
    return `[${Array.from(
      { length },
      (_unused, index) =>
        canonicalPortableJson(
          ownDataValue(value, String(index), `${label}[${index}]`),
          `${label}[${index}]`,
        ),
    ).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} contains a non-JSON value`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} contains a non-plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error(`${label} contains a symbol field`);
  }
  const sorted = (keys as string[]).sort();
  return `{${sorted.map((key) =>
    `${JSON.stringify(key)}:${canonicalPortableJson(
      ownDataValue(value, key, `${label}.${key}`),
      `${label}.${key}`,
    )}`).join(",")}}`;
}

function assertPackageMetadata(
  value: PortableProviderPluginPackageMetadataV1,
): void {
  if (
    !pluginIdPattern.test(value.id)
    || !pluginVersionPattern.test(value.version)
    || value.hostApiVersion !== 1
    || !sha256Pattern.test(value.bundleSha256)
    || !sha256Pattern.test(value.manifestSha256)
  ) {
    throw new Error("portable operation package identity is invalid");
  }
}

function identityRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("portable operation identity must be an object");
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("portable operation identity must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  const expected = [
    "pluginId",
    "pluginVersion",
    "hostApiVersion",
    "bundleSha256",
    "manifestSha256",
    "adapterId",
    "transport",
    "surfaceId",
    "operation",
    "contractVersion",
    "descriptorSha256",
  ].sort();
  if (
    keys.some((key) => typeof key !== "string")
    || keys.length !== expected.length
    || (keys as string[]).sort().some(
      (key, index) => key !== expected[index],
    )
  ) {
    throw new Error("portable operation identity has unsupported fields");
  }
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    result[key] = ownDataValue(
      value,
      key,
      `portable operation identity.${key}`,
    );
  }
  return result;
}

export function parsePortableOperationIdentityV1(
  value: unknown,
): PortableOperationIdentityV1 {
  const record = identityRecord(value);
  if (
    typeof record.pluginId !== "string"
    || record.pluginId.length > 128
    || !pluginIdPattern.test(record.pluginId)
    || typeof record.pluginVersion !== "string"
    || record.pluginVersion.length > 128
    || !pluginVersionPattern.test(record.pluginVersion)
    || record.hostApiVersion !== 1
    || typeof record.bundleSha256 !== "string"
    || !sha256Pattern.test(record.bundleSha256)
    || typeof record.manifestSha256 !== "string"
    || !sha256Pattern.test(record.manifestSha256)
    || typeof record.adapterId !== "string"
    || !adapterIdPattern.test(record.adapterId)
    || (
      record.transport !== "provider-api"
      && record.transport !== "web-session-api"
      && record.transport !== "linked-device"
    )
    || typeof record.surfaceId !== "string"
    || record.surfaceId.length > 128
    || !pluginIdPattern.test(record.surfaceId)
    || typeof record.operation !== "string"
    || !operationPattern.test(record.operation)
    || typeof record.contractVersion !== "number"
    || !Number.isSafeInteger(record.contractVersion)
    || record.contractVersion < 1
    || record.contractVersion > 1_000_000
    || typeof record.descriptorSha256 !== "string"
    || !sha256Pattern.test(record.descriptorSha256)
  ) {
    throw new Error("portable operation identity is malformed");
  }
  return Object.freeze({
    pluginId: record.pluginId,
    pluginVersion: record.pluginVersion,
    hostApiVersion: 1,
    bundleSha256: record.bundleSha256,
    manifestSha256: record.manifestSha256,
    adapterId: record.adapterId,
    transport: record.transport,
    surfaceId: record.surfaceId,
    operation: record.operation,
    contractVersion: record.contractVersion,
    descriptorSha256: record.descriptorSha256,
  });
}

function operationBelongsToBinding(
  binding: PortableProviderPluginBindingV1,
  operation: PortableProviderPluginOperationV1,
): boolean {
  const encoded = canonicalPortableJson(
    operation,
    "portable operation descriptor",
  );
  return binding.operations.some((candidate) =>
    candidate.name === operation.name
    && candidate.contractVersion === operation.contractVersion
    && canonicalPortableJson(
      candidate,
      "portable binding operation descriptor",
    ) === encoded);
}

function descriptorValue(
  source: PortableOperationIdentitySourceV1,
): Readonly<Record<string, unknown>> {
  const packageValue = source.package;
  const binding = source.binding;
  return Object.freeze({
    identityVersion: PORTABLE_OPERATION_IDENTITY_VERSION,
    plugin: Object.freeze({
      id: packageValue.id,
      version: packageValue.version,
      hostApiVersion: packageValue.hostApiVersion,
    }),
    capabilities: packageValue.capabilities,
    binding: Object.freeze({
      adapterId: binding.adapterId,
      transport: binding.transport,
      surfaceId: binding.surfaceId,
      origin: binding.origin,
      authKinds: binding.authKinds,
      subject: binding.subject,
    }),
    operation: source.operation,
  });
}

/**
 * Bind one exact logical operation to the immutable package that implements it.
 *
 * Executable closures, runtime wrapper objects, filesystem paths, and host
 * process state are deliberately absent from the descriptor projection.
 */
export function createPortableOperationIdentityV1(
  source: PortableOperationIdentitySourceV1,
): PortableOperationIdentityV1 {
  assertPackageMetadata(source.package);
  if (!operationBelongsToBinding(source.binding, source.operation)) {
    throw new Error(
      "portable operation descriptor is not owned by its declared binding",
    );
  }
  const descriptorSha256 = createHash("sha256")
    .update(descriptorDomain)
    .update(canonicalPortableJson(
      descriptorValue(source),
      "portable operation identity",
    ))
    .digest("hex");
  return parsePortableOperationIdentityV1({
    pluginId: source.package.id,
    pluginVersion: source.package.version,
    hostApiVersion: source.package.hostApiVersion,
    bundleSha256: source.package.bundleSha256,
    manifestSha256: source.package.manifestSha256,
    adapterId: source.binding.adapterId,
    transport: source.binding.transport,
    surfaceId: source.binding.surfaceId,
    operation: source.operation.name,
    contractVersion: source.operation.contractVersion,
    descriptorSha256,
  });
}
