import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { WrenchAuth } from "./auth";
import type {
  BrowserDispatchPlan,
  ArrayInputField,
  FileInputField,
  IdempotencyKind,
  InputField,
  InputSchema,
  OperationInput,
  OperationRisk,
  WrenchManifest,
  ScalarInputField,
} from "./model";
import type { ProviderActionContext } from "./provider-context";
import type {
  ProviderConversationV1,
  ProviderMaterializedPageV1,
  ProviderMessageV1,
} from "./omni-model";
import type { LocalCliOperationExecutor } from "./local-cli-execution";
import type { MessagingRouteCoordinateV1 } from "./messaging-types";
import type { OperationDeadline } from "./operation-deadline";
import {
  localCliToolArtifactForCurrentRuntime,
  parseLocalCliToolIdentityV1,
  type LocalCliToolArtifactIdentityV1,
  type LocalCliToolIdentityV1,
} from "./local-cli-tool-identity";
import {
  isProviderPluginId,
  isProviderPluginOperationName,
  isProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";
import {
  createPortableOperationIdentityV1,
  type PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import {
  isVerifiedPortableProviderPluginPackage,
  type PortableProviderPluginBindingV1 as PortablePackageBindingV1,
  type VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  assertKernelPortableProviderPluginBindingProjection,
} from "./provider-plugin-portable-authority";
import {
  inspectLocalCliCleanupFilesystemReadiness,
} from "./provider-plugin-cleanup-resource";
import type {
  ProviderPluginCleanupBarrierRegistrar,
  PublicWebSessionOperationExecutor,
  WebSessionOperationExecutor,
} from "./web-session-execution";

export const PROVIDER_PLUGIN_API_VERSION = 1 as const;

export const providerPluginTransports = [
  "provider-api",
  "web-session-api",
  "linked-device",
  "local-cli",
] as const;

export type ProviderPluginTransport = (typeof providerPluginTransports)[number];
export type ProviderPluginAuthKind = WrenchAuth["kind"];
export type ProviderPluginContractStateV1 = "observed" | "capture-required";

type ProviderPluginOperationDefinitionBaseV1 = {
  readonly name: string;
  /** Exact durable contract identity owned by this descriptor. */
  readonly contractVersion: number;
  /**
   * Built-in-only durable routing aliases for contracts whose reviewed
   * semantics remain compatible with this active descriptor.
   */
  readonly historicalContractVersions?: readonly number[];
  readonly risk: OperationRisk;
  readonly input: InputSchema;
  readonly sideEffect: string;
  readonly idempotency: IdempotencyKind;
  readonly dedupeWindowMs: number;
  readonly state: ProviderPluginContractStateV1;
  /** Built-in web-session-only marker for one reviewed public read. */
  readonly access?: "public";
  readonly dispatch: "none" | "single" | "thread-items" | "bounded-items";
  readonly implementation: string;
  readonly planDispatches: (input: OperationInput) => readonly BrowserDispatchPlan[];
  readonly validateInput: (input: OperationInput) => readonly string[];
  /**
   * Optional provider-owned relationship between the bound auth subject and
   * operation input (for example, an explicit actor field). The kernel still
   * requires the binding-level subject matcher for every authenticated write.
   */
  readonly validateSubjectInput?: (
    input: OperationInput,
    subject: string,
  ) => readonly string[];
  /**
   * Declares that this exact operation supports a read-only boolean
   * desired-state reconciliation. Runtime code supplies the observation; the
   * kernel compares it to this pure desired-state projection.
   */
  readonly reconciliation?: ProviderPluginReconciliationDefinitionV1;
  /**
   * Provider-owned interpretation of one exact inbox read. Every installed
   * messaging list/read contract must either supply a pure, versioned
   * materializer or state why normalization is unsafe. The kernel reparses
   * supported output from unknown before it reaches durable state.
   */
  readonly omni?: ProviderPluginOmniDefinitionV1;
};

export type ProviderPluginReconciliationDefinitionV1 =
  | {
      readonly kind: "boolean-desired-state";
      readonly desiredState: (input: OperationInput) => boolean;
    }
  | {
      /** Reconcile a create from its encrypted response-derived exact target. */
      readonly kind: "provider-accepted-target-presence";
    }
  | {
      /**
       * Reconcile a deletion from an encrypted exact target bound by a strict
       * provider read before the mutation request leaves the process.
       */
      readonly kind: "provider-bound-target-desired-state";
      readonly desiredState: false;
    };

export type ProviderPluginOmniDefinitionV1 =
  | {
      readonly state: "supported";
      readonly schemaVersion: 1;
      readonly materializerId: string;
      readonly materializerVersion: number;
      readonly materialize: (
        input: OperationInput,
        output: unknown,
      ) => unknown;
    }
  | {
      readonly state: "unsupported";
      readonly reason: string;
    };

export type ProviderPluginMessagingTargetV1 = Readonly<
  Record<string, string>
>;

export type ProviderPluginMessagingRouteCandidateV1 = {
  /** Exact provider coordinates retained only in Wrench private state. */
  readonly target: ProviderPluginMessagingTargetV1;
  /** Exact provider conversation identity used to bind normalized reads. */
  readonly conversationProviderId: string;
  readonly conversationKind: "single" | "group" | "unknown";
  readonly title: string | null;
  readonly participants: ProviderConversationV1["participants"];
  readonly providerRevision: string | null;
};

export type ProviderPluginMessagingTurnPartV1 = {
  readonly partId: string;
  readonly text: string;
  /** Exact provider message identity recovered from one current context ref. */
  readonly replyToProviderId: string | null;
};

export type ProviderPluginMessagingAcceptedResultV1 = {
  /** Provider accepted/submitted work; delivery and read remain unproven. */
  readonly state: "submitted";
  readonly providerMessageId: string;
  readonly providerRevision: string | null;
};

export type ProviderPluginMessagingExpectedOwnPrefixV1 = {
  readonly base: {
    readonly exactDataRevision: string;
    readonly latestMessageRevision: string;
    readonly contextLimit: number;
    /** Ordered, bounded hashes of the exact normalized context at preview. */
    readonly messages: readonly {
      readonly providerMessageId: string;
      readonly providerRevision: string | null;
      readonly orderedAt: string | null;
      readonly messageSha256: string;
    }[];
  };
  readonly current: {
    readonly exactDataRevision: string;
    readonly latestMessageRevision: string;
    readonly messages: readonly ProviderMessageV1[];
  };
  readonly accepted: readonly {
    readonly providerMessageId: string;
    readonly providerRevision: string | null;
    readonly direction: "outgoing";
    readonly bodySha256: string;
    readonly replyToProviderId: string | null;
  }[];
};

export type ProviderPluginMessagingLiveRouteStateV1 = {
  readonly conversationProviderId: string;
  readonly participantFingerprint: string;
  readonly providerRevision: string | null;
};

export type ProviderPluginMessagingReconciliationRequestV1 = {
  readonly operation: string;
  readonly input: OperationInput;
};

export type ProviderPluginMessagingActionDeadlineV1 = Pick<
  OperationDeadline,
  "signal" | "remainingTimeMs" | "run" | "throwIfUnavailable"
>;

export type ProviderPluginMessagingActionAttemptV1 = {
  /**
   * The provider runtime must await this durable fence immediately before its
   * first effect-capable call or child process. It may perform bounded reads
   * before the fence, but no mutation and no retry may happen before or after it.
   */
  readonly beforeExternalBegin: () => Promise<void>;
  /** One kernel-owned total budget for lazy loading and every provider step. */
  readonly operationDeadline: ProviderPluginMessagingActionDeadlineV1;
  readonly signal: AbortSignal;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Kernel-owned durable cleanup publication for provider-private resources. */
  readonly registerCleanupBarrier?: ProviderPluginCleanupBarrierRegistrar;
};

export type ProviderPluginMessagingActionExecutorV1 = (
  operation: string,
  input: OperationInput,
  auth: WrenchAuth,
  attempt: ProviderPluginMessagingActionAttemptV1,
) => Promise<unknown>;

export type ProviderPluginMessagingActionDefinitionV1 =
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly reply: "unsupported";
    }
  | {
      readonly state: "supported";
      readonly operation: string;
      readonly reply: "supported" | "unsupported";
      readonly livePreflight: {
        readonly operation: string;
        readonly input: (target: ProviderPluginMessagingTargetV1) => OperationInput;
        readonly snapshot: (output: unknown) => ProviderPluginMessagingLiveRouteStateV1;
      };
      readonly compileTurnPart: (
        target: ProviderPluginMessagingTargetV1,
        part: ProviderPluginMessagingTurnPartV1,
      ) => OperationInput;
      readonly mapAcceptedResult: (
        output: unknown,
      ) => ProviderPluginMessagingAcceptedResultV1;
      /** Prove that live state contains exactly the accepted own-message prefix and no drift. */
      readonly proveExpectedOwnPrefix: (
        value: ProviderPluginMessagingExpectedOwnPrefixV1,
      ) => "proven" | "drift";
      /**
       * Build one explicit checked provider read. The generic facade never
       * invokes this implicitly and never changes existing runs reconciliation.
       */
      readonly reconciliation: (
        target: ProviderPluginMessagingTargetV1,
        accepted: ProviderPluginMessagingAcceptedResultV1,
      ) => ProviderPluginMessagingReconciliationRequestV1;
    };

/**
 * Provider-owned exact messaging codec. The kernel owns lifecycle, storage,
 * confirmation, and execution; this SPI owns provider coordinate semantics.
 */
export type ProviderPluginMessagingDefinitionV1 = {
  readonly schemaVersion: 1;
  readonly contractId: string;
  readonly network: string;
  /** Whether an exact provider read proves current remote state. */
  readonly contextLiveness:
    | "fresh-as-of-live-preflight"
    | "freshness-unproven";
  readonly listOperation: "messaging.list";
  readonly contextOperation: "messaging.read";
  /** Closed coordinate variant this exact provider codec accepts. */
  readonly coordinateKind: MessagingRouteCoordinateV1["kind"];
  readonly enumerateRoutes: (
    input: OperationInput,
    page: ProviderMaterializedPageV1,
  ) => readonly ProviderPluginMessagingRouteCandidateV1[];
  /** Exact coordinate resolution, independent from bounded list pagination. */
  readonly resolveRoute: {
    readonly operation: string;
    readonly input: (
      listInput: OperationInput,
      coordinate: MessagingRouteCoordinateV1,
    ) => OperationInput;
    readonly candidates: (
      listInput: OperationInput,
      coordinate: MessagingRouteCoordinateV1,
      output: unknown,
    ) => readonly ProviderPluginMessagingRouteCandidateV1[];
  };
  readonly parseTarget: (value: unknown) => ProviderPluginMessagingTargetV1;
  readonly contextInput: (
    target: ProviderPluginMessagingTargetV1,
    limit: number,
  ) => OperationInput;
  readonly action: ProviderPluginMessagingActionDefinitionV1;
};

export type ProviderApiPluginOperationDefinitionV1 =
  ProviderPluginOperationDefinitionBaseV1 & {
  readonly requiredScopeSets: readonly (readonly string[])[];
  /** Bounded provider-owned coverage labels; not a kernel-owned closed union. */
  readonly coverage: readonly string[];
};

export type WebSessionPluginOperationDefinitionV1 =
  ProviderPluginOperationDefinitionBaseV1 & {
  readonly requiredScopeSets?: never;
  readonly coverage?: never;
};

export type LocalCliPluginOperationDefinitionV1 =
  WebSessionPluginOperationDefinitionV1;

export type ProviderPluginOperationDefinitionV1 =
  | ProviderApiPluginOperationDefinitionV1
  | WebSessionPluginOperationDefinitionV1
  | LocalCliPluginOperationDefinitionV1;

/** Validated registry projection. `contractVersions` is CLI compatibility only. */
export type ProviderApiPluginOperationV1 =
  ProviderApiPluginOperationDefinitionV1 & {
    readonly contractVersions: readonly number[];
  };

export type WebSessionPluginOperationV1 =
  WebSessionPluginOperationDefinitionV1 & {
    readonly contractVersions: readonly number[];
  };

export type LocalCliPluginOperationV1 = WebSessionPluginOperationV1;

export type ProviderPluginOperationV1 =
  | ProviderApiPluginOperationV1
  | WebSessionPluginOperationV1
  | LocalCliPluginOperationV1;

export const MAX_PROVIDER_PLUGIN_PLAN_DISPATCHES = 25;
export const MAX_PROVIDER_PLUGIN_PLAN_BYTES = 16 * 1024;
/** Trusted-source definitions match the portable manifest's V1 shape bounds. */
export const MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES = 512;
export const MAX_PROVIDER_PLUGIN_BINDINGS = 64;
export const MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING = 256;
export const MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION = 256;
/** A plugin may use many bindings without reaching the full 64 × 256 product. */
export const MAX_PROVIDER_PLUGIN_OPERATIONS = 4_096;

export type ProviderPluginPlanOperationV1 = Pick<
  ProviderPluginOperationDefinitionV1,
  "name" | "risk" | "dispatch" | "planDispatches"
>;

const providerPluginDispatchIdPattern =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*(?:\[[1-9][0-9]*\])?$/u;
const conformedProviderPluginPlanHooks =
  new WeakSet<ProviderPluginPlanOperationV1["planDispatches"]>();

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function ownDataProperty(
  value: object,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !("value" in descriptor)
  ) {
    throw new Error(`${label} must be an enumerable data property`);
  }
  return descriptor.value as unknown;
}

function requirePlainRecord(value: object, label: string): void {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object`);
  }
}

function cloneFrozenPlanInputValue(
  value: unknown,
  label: string,
): OperationInput[string] {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if ((Object.getPrototypeOf(value) as unknown) !== Array.prototype) {
      throw new Error(`${label} must be a plain JSON array`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const rawLength: unknown = lengthDescriptor !== undefined
      && "value" in lengthDescriptor
      ? lengthDescriptor.value as unknown
      : Number.NaN;
    if (
      typeof rawLength !== "number"
      || !Number.isSafeInteger(rawLength)
      || rawLength < 0
      || rawLength > 1_000
    ) {
      throw new Error(`${label} must be a bounded dense array`);
    }
    const length = rawLength;
    const expectedKeys = new Set<PropertyKey>([
      "length",
      ...Array.from({ length }, (_unused, index) => String(index)),
    ]);
    const actualKeys = Reflect.ownKeys(value);
    if (
      actualKeys.length !== expectedKeys.size
      || actualKeys.some((key) => !expectedKeys.has(key))
    ) {
      throw new Error(`${label} must be a bounded dense array`);
    }
    return Object.freeze(Array.from(
      { length },
      (_unused, index) =>
        cloneFrozenPlanInputScalar(
          ownDataProperty(value, String(index), `${label}[${index}]`),
          `${label}[${index}]`,
        ),
    ));
  }
  return cloneFrozenPlanInputFile(value, label);
}

function cloneFrozenPlanInputScalar(
  value: unknown,
  label: string,
): string | number | boolean | { readonly kind: "file"; readonly reference: string } {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return cloneFrozenPlanInputFile(value, label);
}

function cloneFrozenPlanInputFile(
  value: unknown,
  label: string,
): { readonly kind: "file"; readonly reference: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not JSON-compatible plugin input`);
  }
  requirePlainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2
    || !keys.includes("kind")
    || !keys.includes("reference")
  ) {
    throw new Error(`${label} is not a valid file input`);
  }
  const kind = ownDataProperty(value, "kind", `${label}.kind`);
  const reference = ownDataProperty(value, "reference", `${label}.reference`);
  if (kind !== "file" || typeof reference !== "string") {
    throw new Error(`${label} is not a valid file input`);
  }
  return Object.freeze({ kind: "file" as const, reference });
}

function detachedFrozenPlanInput(input: OperationInput): OperationInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("provider plugin plan input must be a JSON object");
  }
  requirePlainRecord(input, "provider plugin plan input");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length > 100
    || keys.some((key) => typeof key !== "string")
  ) {
    throw new Error("provider plugin plan input must be a bounded JSON object");
  }
  const result: Record<string, OperationInput[string]> = {};
  for (const key of keys as string[]) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneFrozenPlanInputValue(
        ownDataProperty(input, key, `provider plugin plan input.${key}`),
        `provider plugin plan input.${key}`,
      ),
    });
  }
  return Object.freeze(result);
}

function parseProviderPluginDispatches(
  value: unknown,
  operation: ProviderPluginPlanOperationV1,
  input: OperationInput,
): readonly BrowserDispatchPlan[] {
  const label = `provider plugin operation ${operation.name} planDispatches`;
  if (
    !Array.isArray(value)
    || (Object.getPrototypeOf(value) as unknown) !== Array.prototype
  ) {
    throw new Error(`${label} must return a plain JSON array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const rawLength: unknown = lengthDescriptor !== undefined
    && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : Number.NaN;
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 0
    || rawLength > MAX_PROVIDER_PLUGIN_PLAN_DISPATCHES
  ) {
    throw new Error(
      `${label} may return at most ${MAX_PROVIDER_PLUGIN_PLAN_DISPATCHES} dispatches`,
    );
  }
  const length = rawLength;
  const expectedKeys = new Set<PropertyKey>([
    "length",
    ...Array.from({ length }, (_unused, index) => String(index)),
  ]);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.size
    || actualKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error(`${label} must return a dense array without extra properties`);
  }
  const dispatches: BrowserDispatchPlan[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const candidate = ownDataProperty(
      value,
      String(index),
      `${label}[${index}]`,
    );
    if (
      typeof candidate !== "object"
      || candidate === null
      || Array.isArray(candidate)
    ) {
      throw new Error(`${label}[${index}] must be a plain JSON object`);
    }
    requirePlainRecord(candidate, `${label}[${index}]`);
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.length !== 2
      || !keys.includes("id")
      || !keys.includes("description")
    ) {
      throw new Error(
        `${label}[${index}] must contain only id and description`,
      );
    }
    const id = ownDataProperty(candidate, "id", `${label}[${index}].id`);
    const description = ownDataProperty(
      candidate,
      "description",
      `${label}[${index}].description`,
    );
    if (
      typeof id !== "string"
      || id.length > 80
      || !providerPluginDispatchIdPattern.test(id)
    ) {
      throw new Error(`${label}[${index}] has an invalid dispatch ID`);
    }
    if (ids.has(id)) {
      throw new Error(`${label} returned duplicate dispatch ID ${id}`);
    }
    if (
      typeof description !== "string"
      || description.length < 1
      || description.length > 500
      || hasControlCharacters(description)
      || hasUnpairedSurrogate(description)
    ) {
      throw new Error(`${label}[${index}] has an invalid description`);
    }
    ids.add(id);
    dispatches.push(Object.freeze({ id, description }));
  }

  if (operation.risk === "R1" && dispatches.length !== 0) {
    throw new Error("R1 operations must not schedule remote dispatches");
  }
  if (
    (operation.risk === "R2" || operation.risk === "R3")
    && dispatches.length === 0
  ) {
    throw new Error(`${label} must return at least one dispatch for ${operation.risk}`);
  }
  if (operation.dispatch === "none" && dispatches.length !== 0) {
    throw new Error(`${label} must return no dispatches for dispatch policy none`);
  }
  if (operation.dispatch === "single" && dispatches.length !== 1) {
    throw new Error(`${label} must return exactly one dispatch for dispatch policy single`);
  }
  if (operation.dispatch === "thread-items") {
    const items = input.items;
    if (
      !Array.isArray(items)
      || items.length < 1
      || dispatches.length !== items.length
    ) {
      throw new Error(
        `${label} must return exactly one dispatch for each input.items value`,
      );
    }
  }
  const result = Object.freeze(dispatches);
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROVIDER_PLUGIN_PLAN_BYTES) {
    throw new Error(
      `${label} exceeds its ${MAX_PROVIDER_PLUGIN_PLAN_BYTES}-byte canonical JSON bound`,
    );
  }
  return result;
}

/**
 * Run one pure planner twice at its trust boundary and return only detached,
 * deeply frozen kernel-owned data. Built-in and portable plugin hosts share
 * this exact conformance check.
 */
function runUntrustedProviderPluginPlanConformance(
  operation: ProviderPluginPlanOperationV1,
  input: OperationInput,
): readonly BrowserDispatchPlan[] {
  const plan = (): readonly BrowserDispatchPlan[] => {
    const detachedInput = detachedFrozenPlanInput(input);
    const returned: unknown = operation.planDispatches(detachedInput);
    return parseProviderPluginDispatches(returned, operation, detachedInput);
  };
  const first = plan();
  const second = plan();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(
      `provider plugin operation ${operation.name} planDispatches is unstable for identical input`,
    );
  }
  return first;
}

export function runProviderPluginPlanConformance(
  operation: ProviderPluginPlanOperationV1,
  input: OperationInput,
): readonly BrowserDispatchPlan[] {
  if (conformedProviderPluginPlanHooks.has(operation.planDispatches)) {
    return operation.planDispatches(input);
  }
  return runUntrustedProviderPluginPlanConformance(operation, input);
}

function conformingProviderPluginPlanDispatches(
  operation: ProviderPluginOperationDefinitionV1,
): ProviderPluginOperationDefinitionV1["planDispatches"] {
  const cache = new WeakMap<OperationInput, readonly BrowserDispatchPlan[]>();
  const planDispatches = (input: OperationInput): readonly BrowserDispatchPlan[] => {
    const existing = cache.get(input);
    if (existing !== undefined) return existing;
    const planned = runUntrustedProviderPluginPlanConformance(operation, input);
    cache.set(input, planned);
    return planned;
  };
  conformedProviderPluginPlanHooks.add(planDispatches);
  return planDispatches;
}

export type ProviderPluginSubjectDefinitionV1 = {
  /** Human-readable, value-free description of the accepted subject form. */
  readonly format: string;
  readonly matches: (value: string) => boolean;
};

export type ProviderPluginSubjectProbeOptionsV1 = {
  /** Caller-owned cancellation propagated through probe network/process work. */
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Kernel-owned durable publication for operation-private resources. */
  readonly registerCleanupBarrier?: ProviderPluginCleanupBarrierRegistrar;
};

export type ProviderPluginReconciliationOptionsV1 = {
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly registerCleanupBarrier?: ProviderPluginCleanupBarrierRegistrar;
};

export type ProviderPluginSubjectV1 = ProviderPluginSubjectDefinitionV1 & {
  /** Lazy compatibility hook synthesized from the binding runtime. */
  readonly probe?: (
    auth: WrenchAuth,
    options?: ProviderPluginSubjectProbeOptionsV1,
  ) => Promise<string>;
};

export type ProviderPluginImplementationSourceDefinitionV1 = {
  /** Stable plugin-relative identity included in implementation hashes. */
  readonly label: string;
  /** A reviewed source file. V1 accepts repository-owned file URLs only. */
  readonly url: URL;
};

export type ProviderPluginImplementationSourceV1 = {
  /** Stable plugin-relative identity included in implementation hashes. */
  readonly label: string;
  /** Canonical immutable path validated under Wrench's source root. */
  readonly path: string;
};

export type ProviderApiPluginRuntimeV1 = {
  readonly execute: (context: ProviderActionContext) => Promise<void>;
  readonly executeMessagingPart?: ProviderPluginMessagingActionExecutorV1;
};

export type ProviderPluginReconciliationReadbackV1 = {
  readonly actualState: boolean;
  readonly reason: string;
};

export type ProviderPluginAcceptedTargetReconciliationContextV1 = {
  readonly schemaVersion: 1;
  readonly kind: "provider-accepted-target-presence";
  readonly dispatch: {
    readonly id: string;
    readonly index: number;
    readonly planned: number;
  };
  readonly target: {
    readonly schemaVersion: 1;
    readonly identifier: string;
  };
};

export type ProviderPluginBoundTargetDesiredStateReconciliationContextV1 =
  Omit<ProviderPluginAcceptedTargetReconciliationContextV1, "kind"> & {
    readonly kind: "provider-bound-target-desired-state";
  };

export type ProviderPluginReconciliationContextV1 =
  | ProviderPluginAcceptedTargetReconciliationContextV1
  | ProviderPluginBoundTargetDesiredStateReconciliationContextV1;

export type ProviderPluginLinkedDeviceRuntimeStatusV1 = {
  readonly ready: boolean;
  readonly implementation: string;
  readonly version: string;
  readonly integrity: string;
  readonly setupCommand?: string;
};

export type ProviderPluginLinkedDeviceSyncResultV1 = {
  readonly itemsStored: number;
  readonly projection: string;
  readonly emitsProtocolAcknowledgements: boolean;
};

export type ProviderPluginLinkedDeviceAttemptBoundaryV1 = {
  /** Durable attempt identity retained for later reconciliation. */
  readonly journalId: string;
  /**
   * Bounded preflight that is contractually incapable of provider mutation or
   * protocol acknowledgement may run first. This callback must be awaited
   * before the first effect-capable process or externally observable action.
   */
  readonly beforeExternalBegin: () => Promise<void>;
};

export type ProviderPluginLinkedDeviceLifecycleRuntimeV1 = {
  readonly inspect: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<ProviderPluginLinkedDeviceRuntimeStatusV1>;
  readonly pair: (
    auth: WrenchAuth,
    options: {
      readonly phone?: string;
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    },
  ) => Promise<string>;
  readonly syncOnce: (
    auth: WrenchAuth,
    options: {
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    },
  ) => Promise<ProviderPluginLinkedDeviceSyncResultV1>;
};

export type WebSessionPluginRuntimeV1 = {
  readonly probe: (
    auth: WrenchAuth,
    options?: ProviderPluginSubjectProbeOptionsV1,
  ) => Promise<string>;
  readonly execute: WebSessionOperationExecutor;
  readonly executeMessagingPart?: ProviderPluginMessagingActionExecutorV1;
  readonly executePublic?: PublicWebSessionOperationExecutor;
  readonly reconcile?: (
    operation: string,
    input: OperationInput,
    auth: WrenchAuth,
    context?: ProviderPluginReconciliationContextV1,
  ) => Promise<ProviderPluginReconciliationReadbackV1>;
  readonly linkedDeviceLifecycle?: ProviderPluginLinkedDeviceLifecycleRuntimeV1;
};

export type LocalCliPluginRuntimeV1 = {
  readonly inspect: (
    environment: Readonly<Record<string, string | undefined>>,
    options?: {
      readonly registerCleanupBarrier?: ProviderPluginCleanupBarrierRegistrar;
    },
  ) => Promise<LocalCliPluginRuntimeStatusV1>;
  readonly probe: (
    auth: WrenchAuth,
    options?: ProviderPluginSubjectProbeOptionsV1,
  ) => Promise<string>;
  readonly execute: LocalCliOperationExecutor;
  readonly executeMessagingPart?: ProviderPluginMessagingActionExecutorV1;
  readonly reconcile?: (
    operation: string,
    input: OperationInput,
    auth: WrenchAuth,
    context?: ProviderPluginReconciliationContextV1,
    options?: ProviderPluginReconciliationOptionsV1,
  ) => Promise<ProviderPluginReconciliationReadbackV1>;
};

export type LocalCliPluginRuntimeStatusV1 = {
  readonly ready: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly version: string | null;
  readonly executableSha256: string | null;
  readonly reason: string | null;
};

export type ProviderApiPluginRuntimeHooksV1 = {
  readonly loadRuntime: () => Promise<ProviderApiPluginRuntimeV1>;
};

export type WebSessionPluginRuntimeHooksV1 = {
  readonly loadRuntime: () => Promise<WebSessionPluginRuntimeV1>;
};

export type LocalCliPluginRuntimeHooksV1 = {
  readonly loadRuntime: () => Promise<LocalCliPluginRuntimeV1>;
};

type ProviderPluginBindingDefinitionBaseV1 = {
  readonly surfaceId: string;
  /**
   * Canonical provider/service authority used by manifests, receipts, and
   * account realms. For network transports this is also the primary endpoint;
   * local-cli bindings keep child/loopback endpoints private to code-owned
   * runtime logic and never expose them as manifest authority.
   */
  readonly origin: `https://${string}`;
  /**
   * Exact public origins an adapter manifest must declare. Defaults to
   * `[origin]`; official APIs can bind a public product origin separately
   * from their API transport endpoint.
   */
  readonly manifestOrigins?: readonly `https://${string}`[];
  /**
   * Hostname suffixes reserved from generic browser/template transports.
   * Defaults to the exact transport and manifest hostnames.
   */
  readonly protectedHostnameFamilies?: readonly string[];
  readonly authKinds: readonly ProviderPluginAuthKind[];
  readonly subject: ProviderPluginSubjectDefinitionV1;
  readonly messaging?: ProviderPluginMessagingDefinitionV1;
};

export type ProviderApiPluginBindingDefinitionV1 =
  ProviderPluginBindingDefinitionBaseV1 & {
  readonly transport: "provider-api";
  /**
   * Every exact HTTPS origin that may receive this binding's OAuth bearer
   * token. Defaults to `[origin]`; declare auxiliary provider APIs explicitly.
   */
  readonly runtimeOrigins?: readonly `https://${string}`[];
  readonly operations: readonly ProviderApiPluginOperationDefinitionV1[];
  readonly runtime: ProviderApiPluginRuntimeHooksV1;
};

export type WebSessionApiPluginBindingDefinitionV1 =
  ProviderPluginBindingDefinitionBaseV1 & {
  readonly transport: "web-session-api";
  readonly operations: readonly WebSessionPluginOperationDefinitionV1[];
  readonly runtime: WebSessionPluginRuntimeHooksV1;
};

export type LinkedDevicePluginBindingDefinitionV1 =
  ProviderPluginBindingDefinitionBaseV1 & {
  readonly transport: "linked-device";
  readonly operations: readonly WebSessionPluginOperationDefinitionV1[];
  readonly linkedDeviceLifecycle?: {
    readonly pair: true;
    readonly syncOnce: true;
    readonly inspect: true;
  };
  readonly runtime: WebSessionPluginRuntimeHooksV1;
};

export type LocalCliPluginBindingDefinitionV1 =
  ProviderPluginBindingDefinitionBaseV1 & {
  readonly transport: "local-cli";
  readonly tool: LocalCliToolIdentityV1;
  readonly operations: readonly LocalCliPluginOperationDefinitionV1[];
  readonly runtime: LocalCliPluginRuntimeHooksV1;
};

export type ProviderPluginBindingDefinitionV1 =
  | ProviderApiPluginBindingDefinitionV1
  | WebSessionApiPluginBindingDefinitionV1
  | LinkedDevicePluginBindingDefinitionV1
  | LocalCliPluginBindingDefinitionV1;

export type ProviderPluginDefinitionV1 = {
  readonly apiVersion: typeof PROVIDER_PLUGIN_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly sourceKind: "built-in" | "source";
  readonly implementationSources: readonly ProviderPluginImplementationSourceDefinitionV1[];
  readonly bindings: readonly ProviderPluginBindingDefinitionV1[];
};

export type PortableProviderPluginProjectionDefinitionV1 = {
  readonly apiVersion: typeof PROVIDER_PLUGIN_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly sourceKind: "portable";
  readonly package: VerifiedPortableProviderPluginPackage;
  readonly bindings: readonly {
    readonly adapterId: string;
    readonly manifest: WrenchManifest;
    readonly portableBinding: PortablePackageBindingV1;
    readonly binding: ProviderPluginBindingDefinitionV1;
  }[];
};

type ProviderPluginBindingBaseV1 = Omit<
  ProviderPluginBindingDefinitionBaseV1,
  "manifestOrigins" | "protectedHostnameFamilies" | "subject" | "messaging"
> & {
  readonly manifestOrigins: readonly `https://${string}`[];
  readonly protectedHostnameFamilies: readonly string[];
  readonly subject: ProviderPluginSubjectV1;
  readonly messaging?: ProviderPluginMessagingDefinitionV1;
};

export type ProviderApiPluginBindingV1 = ProviderPluginBindingBaseV1 & {
  readonly transport: "provider-api";
  readonly runtimeOrigins: readonly `https://${string}`[];
  readonly operations: readonly ProviderApiPluginOperationV1[];
  readonly loadRuntime: ProviderApiPluginRuntimeHooksV1["loadRuntime"];
  readonly execute: ProviderApiPluginRuntimeV1["execute"];
  readonly executeMessagingPart?: ProviderPluginMessagingActionExecutorV1;
};

export type WebSessionApiPluginBindingV1 = ProviderPluginBindingBaseV1 & {
  readonly transport: "web-session-api";
  readonly operations: readonly WebSessionPluginOperationV1[];
  readonly loadRuntime: WebSessionPluginRuntimeHooksV1["loadRuntime"];
  readonly execute: WebSessionPluginRuntimeV1["execute"];
  readonly executeMessagingPart?: ProviderPluginMessagingActionExecutorV1;
  readonly executePublic?: NonNullable<WebSessionPluginRuntimeV1["executePublic"]>;
  readonly reconcile?: NonNullable<WebSessionPluginRuntimeV1["reconcile"]>;
};

export type LinkedDevicePluginBindingV1 = ProviderPluginBindingBaseV1 & {
  readonly transport: "linked-device";
  readonly operations: readonly WebSessionPluginOperationV1[];
  readonly loadRuntime: WebSessionPluginRuntimeHooksV1["loadRuntime"];
  readonly execute: WebSessionPluginRuntimeV1["execute"];
  readonly executeMessagingPart?: ProviderPluginMessagingActionExecutorV1;
  readonly reconcile?: NonNullable<WebSessionPluginRuntimeV1["reconcile"]>;
  readonly linkedDeviceLifecycle?: ProviderPluginLinkedDeviceLifecycleRuntimeV1;
};

export type LocalCliPluginBindingV1 = ProviderPluginBindingBaseV1 & {
  readonly transport: "local-cli";
  readonly tool: LocalCliToolIdentityV1;
  readonly operations: readonly LocalCliPluginOperationV1[];
  readonly loadRuntime: LocalCliPluginRuntimeHooksV1["loadRuntime"];
  readonly inspect: LocalCliPluginRuntimeV1["inspect"];
  readonly execute: LocalCliPluginRuntimeV1["execute"];
  readonly executeMessagingPart?: ProviderPluginMessagingActionExecutorV1;
  readonly reconcile?: NonNullable<LocalCliPluginRuntimeV1["reconcile"]>;
};

export type ProviderPluginBindingV1 =
  | ProviderApiPluginBindingV1
  | WebSessionApiPluginBindingV1
  | LinkedDevicePluginBindingV1
  | LocalCliPluginBindingV1;


export type ProviderPluginV1 = Omit<
  ProviderPluginDefinitionV1,
  "bindings" | "implementationSources" | "sourceKind"
> & {
  readonly sourceKind: "built-in" | "source" | "portable";
  readonly implementationSources: readonly ProviderPluginImplementationSourceV1[];
  readonly bindings: readonly ProviderPluginBindingV1[];
};

const pluginVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const sourceLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const authKinds = new Set<ProviderPluginAuthKind>([
  "cookie-source",
  "cookies-file",
  "browser-profile",
  "oauth-token-file",
  "linked-device-store",
]);
const validatedProviderPlugins = new WeakSet<object>();
const portableProviderPluginArtifacts = new WeakMap<object, string>();
const portableProviderPluginAdapters = new WeakMap<
  ProviderPluginBindingV1,
  { readonly adapterId: string; readonly manifest: WrenchManifest }
>();
const portableProviderPluginOperationIdentities = new WeakMap<
  ProviderPluginBindingV1,
  ReadonlyMap<string, PortableOperationIdentityV1>
>();
const portableProviderPluginSubjectProbeIdentities = new WeakMap<
  ProviderPluginBindingV1,
  PortableOperationIdentityV1
>();
const providerPluginEvaluationSourceDigests = new WeakMap<
  ProviderPluginV1,
  ReadonlyMap<string, string>
>();
const providerPluginEvaluationInstalledPackageDigests = new WeakMap<
  ProviderPluginV1,
  ReadonlyMap<string, string>
>();
const providerPluginSourceRoot = realpathSync(fileURLToPath(new URL(".", import.meta.url)));

function recordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageUsesWorkspaceDependencies(packageRoot: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as unknown;
  } catch {
    return false;
  }
  if (!recordValue(value)) return false;
  const protocol = ["workspace", ":"].join("");
  return ["dependencies", "devDependencies", "optionalDependencies"]
    .some((field) => {
      const dependencies = value[field];
      return recordValue(dependencies)
        && Object.values(dependencies).some(
          (specifier) => typeof specifier === "string" && specifier.startsWith(protocol),
        );
    });
}

function enclosingWorkspaceRoot(packageRoot: string): string {
  if (!packageUsesWorkspaceDependencies(packageRoot)) return packageRoot;
  let candidate = dirname(packageRoot);
  for (;;) {
    const manifestPath = resolve(candidate, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
        if (
          recordValue(value)
          && (Array.isArray(value.workspaces) || recordValue(value.workspaces))
        ) {
          return realpathSync(candidate);
        }
      } catch {
        // A malformed ancestor manifest cannot define the trusted boundary.
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error("Wrench workspace dependencies have no enclosing workspace root");
    }
    candidate = parent;
  }
}

function isWithinProviderPluginPhysicalRoot(
  root: string,
  candidate: string,
): boolean {
  const path = relative(root, candidate);
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`));
}

type PhysicalNodeModulesPackage = {
  readonly nodeModulesDirectory: string;
  readonly root: string;
};

function physicalNodeModulesPackage(
  entryPath: string,
): PhysicalNodeModulesPackage | undefined {
  const parsed = parse(entryPath);
  const segments = entryPath.slice(parsed.root.length).split(sep);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] !== "node_modules") continue;
    const first = segments[index + 1];
    if (first === undefined || first === "") continue;
    const packageSegments = first.startsWith("@")
      ? (
        segments[index + 2] === undefined
          ? undefined
          : [first, segments[index + 2]!]
      )
      : [first];
    if (packageSegments === undefined) continue;
    const root = resolve(
      parsed.root,
      ...segments.slice(0, index + 1 + packageSegments.length),
    );
    if (
      isWithinProviderPluginPhysicalRoot(root, entryPath)
      && existsSync(resolve(root, "package.json"))
    ) {
      return Object.freeze({
        nodeModulesDirectory: resolve(
          parsed.root,
          ...segments.slice(0, index + 1),
        ),
        root,
      });
    }
  }
  return undefined;
}

function enclosingNodeModulesBoundary(packageRoot: string): string | undefined {
  const owner = physicalNodeModulesPackage(packageRoot);
  if (owner === undefined || owner.root !== packageRoot) return undefined;
  const bunInstanceDirectory = dirname(owner.nodeModulesDirectory);
  const bunStoreDirectory = dirname(bunInstanceDirectory);
  const bunInstallNodeModules = dirname(bunStoreDirectory);
  return basename(bunStoreDirectory) === ".bun"
      && basename(bunInstallNodeModules) === "node_modules"
    ? bunInstallNodeModules
    : owner.nodeModulesDirectory;
}

/** Checked source boundary: package root standalone, enclosing workspace in development. */
export const providerPluginPackageRoot = realpathSync(
  resolve(providerPluginSourceRoot, ".."),
);
export const providerPluginRepositoryRoot = enclosingWorkspaceRoot(
  providerPluginPackageRoot,
);
const providerPluginInstallationNodeModulesBoundary =
  enclosingNodeModulesBoundary(providerPluginPackageRoot);

type ProviderPluginPhysicalPath =
  | { readonly kind: "repository" }
  | { readonly kind: "installed-package"; readonly root: string };

export function isProviderPluginRepositorySourcePath(
  repositoryRoot: string,
  path: string,
): boolean {
  const repositoryRelative = relative(repositoryRoot, path);
  return (
    repositoryRelative === ""
    || (
      repositoryRelative !== ".."
      && !repositoryRelative.startsWith(`..${sep}`)
    )
  )
    && (
      repositoryRelative === ""
      || !repositoryRelative.split(sep).includes("node_modules")
    );
}

/**
 * Classify a real module path without confusing an installed Wrench package's
 * own outer `node_modules` segments with one of its dependencies. Standalone
 * dependencies may be hoisted beside Wrench, while development dependencies
 * remain constrained to the checked repository.
 */
export function classifyProviderPluginPhysicalPath(
  path: string,
): ProviderPluginPhysicalPath {
  const repositoryRelative = relative(providerPluginRepositoryRoot, path);
  const withinRepository = repositoryRelative === ""
    || (
      repositoryRelative !== ".."
      && !repositoryRelative.startsWith(`..${sep}`)
    );
  if (isProviderPluginRepositorySourcePath(
    providerPluginRepositoryRoot,
    path,
  )) {
    return Object.freeze({ kind: "repository" });
  }
  if (
    !withinRepository
    && (
      providerPluginInstallationNodeModulesBoundary === undefined
      || !isWithinProviderPluginPhysicalRoot(
        providerPluginInstallationNodeModulesBoundary,
        path,
      )
    )
  ) {
    throw new Error(
      "provider plugin physical path resolves outside the repository and checked package installation",
    );
  }
  const owner = physicalNodeModulesPackage(path);
  if (
    owner === undefined
    || (
      providerPluginInstallationNodeModulesBoundary !== undefined
      && !withinRepository
      && !isWithinProviderPluginPhysicalRoot(
        providerPluginInstallationNodeModulesBoundary,
        owner.root,
      )
    )
  ) {
    throw new Error(
      "provider plugin physical path has no physical node_modules owner",
    );
  }
  return Object.freeze({ kind: "installed-package", root: owner.root });
}
const providerPluginApiBoundaryPath = realpathSync(
  resolve(providerPluginSourceRoot, "provider-plugin.ts"),
);
const MAX_PROVIDER_PLUGIN_EVALUATION_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_PLUGIN_EVALUATION_CLOSURE_SOURCES = 2_000;
const MAX_PROVIDER_PLUGIN_EVALUATION_CLOSURE_BYTES = 128 * 1024 * 1024;
const MAX_PROVIDER_PLUGIN_EVALUATION_IMPORTS_PER_MODULE = 4_096;
const MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGES = 128;
const MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_FILES = 4_096;
const MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_DIRECTORIES = 1_024;
const MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_DEPTH = 32;
const MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_PATH_BYTES = 1_024;
const MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_CACHE_ENTRIES = 256;
const providerPluginEvaluationImportScanners = Object.freeze({
  js: new Bun.Transpiler({ loader: "js" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
});
const providerPluginEvaluationModuleExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".ts",
]);
const providerPluginEvaluationRuntimeBuiltins = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith("node:") ? [name, name.slice("node:".length)] : [name]),
);

type ProviderPluginEvaluationPackageTreeEntry = {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly stats: BigIntStats;
};

type ProviderPluginEvaluationPackageTreeWalk = {
  readonly entries: readonly ProviderPluginEvaluationPackageTreeEntry[];
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
};

type ProviderPluginEvaluationPackageSnapshot = {
  readonly treeSha256: string;
  readonly totalBytes: number;
  readonly verificationWalk: ProviderPluginEvaluationPackageTreeWalk;
};

const providerPluginEvaluationPackageCache =
  new Map<string, ProviderPluginEvaluationPackageSnapshot>();

function sameEvaluationSourceSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readOwnedBoundedProviderPluginEvaluationFile(
  path: string,
  maximumBytes: number,
  label: string,
): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
    );
  } catch {
    throw new Error(`${label} is unreadable`);
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const uid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !before.isFile()
      || (uid !== undefined && before.uid !== BigInt(uid))
      || before.size < 0n
      || before.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} is not an owned bounded regular file`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(`${label} changed while its definition was evaluated`);
    }
    if (
      offset !== bytes.byteLength
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameEvaluationSourceSnapshot(before, after)
      || !sameEvaluationSourceSnapshot(after, current)
    ) {
      throw new Error(`${label} changed while its definition was evaluated`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readProviderPluginEvaluationSource(
  pluginId: string,
  path: string,
  label: string,
): Buffer {
  return readOwnedBoundedProviderPluginEvaluationFile(
    path,
    MAX_PROVIDER_PLUGIN_EVALUATION_SOURCE_BYTES,
    `provider plugin ${pluginId} implementation source ${label}`,
  );
}

function compareProviderPluginEvaluationText(
  left: string,
  right: string,
): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function walkProviderPluginEvaluationPackageTree(
  root: string,
): ProviderPluginEvaluationPackageTreeWalk {
  const entries: ProviderPluginEvaluationPackageTreeEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  const visit = (
    directoryPath: string,
    relativeDirectory: string,
    depth: number,
  ): void => {
    if (depth > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_DEPTH) {
      throw new Error("provider plugin evaluation package tree exceeds its depth bound");
    }
    let before: BigIntStats;
    try {
      before = lstatSync(directoryPath, { bigint: true });
    } catch {
      throw new Error(
        `provider plugin evaluation package directory ${relativeDirectory || "."} changed while it was walked`,
      );
    }
    const uid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      before.isSymbolicLink()
      || !before.isDirectory()
      || (uid !== undefined && before.uid !== BigInt(uid))
      || (before.mode & 0o022n) !== 0n
    ) {
      throw new Error(
        `provider plugin evaluation package directory ${relativeDirectory || "."} is unsafe`,
      );
    }
    directoryCount += 1;
    if (
      directoryCount
        > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_DIRECTORIES
    ) {
      throw new Error(
        "provider plugin evaluation package tree exceeds its directory bound",
      );
    }
    entries.push(Object.freeze({
      path: relativeDirectory === "" ? "." : relativeDirectory,
      kind: "directory",
      stats: before,
    }));
    const descriptor = openSync(
      directoryPath,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
    );
    try {
      const bound = fstatSync(descriptor, { bigint: true });
      if (!bound.isDirectory() || !sameEvaluationSourceSnapshot(before, bound)) {
        throw new Error(
          `provider plugin evaluation package directory ${relativeDirectory || "."} changed while it was bound`,
        );
      }
      const names: string[] = [];
      const directory = opendirSync(directoryPath);
      try {
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          names.push(entry.name);
          if (
            names.length
              > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_FILES
                + MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_DIRECTORIES
            || entries.length + names.length
              > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_FILES
                + MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_DIRECTORIES
          ) {
            throw new Error(
              "provider plugin evaluation package tree exceeds its entry bound",
            );
          }
        }
      } finally {
        directory.closeSync();
      }
      names.sort(compareProviderPluginEvaluationText);
      for (const name of names) {
        const relativePath = relativeDirectory === ""
          ? name
          : `${relativeDirectory}/${name}`;
        if (
          name === "."
          || name === ".."
          || name.includes("/")
          || relativePath.includes("\\")
          || relativePath.includes("\u0000")
          || Buffer.byteLength(relativePath, "utf8")
            > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_PATH_BYTES
        ) {
          throw new Error(
            "provider plugin evaluation package tree contains an unsafe path",
          );
        }
        const path = resolve(directoryPath, name);
        let stats: BigIntStats;
        try {
          stats = lstatSync(path, { bigint: true });
        } catch {
          throw new Error(
            `provider plugin evaluation package entry ${relativePath} changed while it was walked`,
          );
        }
        if (stats.isSymbolicLink()) {
          throw new Error(
            `provider plugin evaluation package tree contains symlink ${relativePath}`,
          );
        }
        if (stats.isDirectory()) {
          // A dependency's nested node_modules directory describes the
          // installation topology, not that package's owned payload. Static
          // imports reached through it are resolved and snapshotted as their
          // own exact installed-package identities below.
          if (name === "node_modules") continue;
          visit(path, relativePath, depth + 1);
          continue;
        }
        if (
          !stats.isFile()
          || (uid !== undefined && stats.uid !== BigInt(uid))
        ) {
          throw new Error(
            `provider plugin evaluation package tree contains unsupported entry ${relativePath}`,
          );
        }
        fileCount += 1;
        if (fileCount > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_FILES) {
          throw new Error(
            "provider plugin evaluation package tree exceeds its file bound",
          );
        }
        if (
          stats.size < 0n
          || stats.size
            > BigInt(MAX_PROVIDER_PLUGIN_EVALUATION_SOURCE_BYTES)
        ) {
          throw new Error(
            `provider plugin evaluation package file ${relativePath} exceeds its byte bound`,
          );
        }
        totalBytes += Number(stats.size);
        if (totalBytes > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_BYTES) {
          throw new Error(
            "provider plugin evaluation package tree exceeds its total byte bound",
          );
        }
        entries.push(Object.freeze({
          path: relativePath,
          kind: "file",
          stats,
        }));
      }
      const after = fstatSync(descriptor, { bigint: true });
      let current: BigIntStats;
      try {
        current = lstatSync(directoryPath, { bigint: true });
      } catch {
        throw new Error(
          `provider plugin evaluation package directory ${relativeDirectory || "."} changed while it was walked`,
        );
      }
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !sameEvaluationSourceSnapshot(before, after)
        || !sameEvaluationSourceSnapshot(after, current)
      ) {
        throw new Error(
          `provider plugin evaluation package directory ${relativeDirectory || "."} changed while it was walked`,
        );
      }
    } finally {
      closeSync(descriptor);
    }
  };
  visit(root, "", 0);
  entries.sort((left, right) =>
    compareProviderPluginEvaluationText(left.path, right.path)
      || compareProviderPluginEvaluationText(left.kind, right.kind));
  return Object.freeze({
    entries: Object.freeze(entries),
    fileCount,
    directoryCount,
    totalBytes,
  });
}

function sameProviderPluginEvaluationPackageTree(
  left: ProviderPluginEvaluationPackageTreeWalk,
  right: ProviderPluginEvaluationPackageTreeWalk,
): boolean {
  return left.fileCount === right.fileCount
    && left.directoryCount === right.directoryCount
    && left.totalBytes === right.totalBytes
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const current = right.entries[index];
      return current !== undefined
        && entry.path === current.path
        && entry.kind === current.kind
        && sameEvaluationSourceSnapshot(entry.stats, current.stats);
    });
}

function updateProviderPluginEvaluationTreeHash(
  hash: ReturnType<typeof createHash>,
  label: string,
  bytes: Buffer,
): void {
  const labelBytes = Buffer.from(label, "utf8");
  const lengths = Buffer.alloc(12);
  lengths.writeUInt32BE(labelBytes.byteLength, 0);
  lengths.writeBigUInt64BE(BigInt(bytes.byteLength), 4);
  hash.update(lengths).update(labelBytes).update(bytes);
}

/**
 * Canonical extraction mode for relocation-stable installed package identity.
 * Exact observed modes stay in stat snapshots so TOCTOU checks remain exact.
 */
export function providerPluginDurableInstalledPackageMode(
  kind: "directory" | "file",
  mode: number,
): 0o644 | 0o755 {
  if (kind === "directory") return 0o755;
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function snapshotProviderPluginEvaluationPackage(
  root: string,
): ProviderPluginEvaluationPackageSnapshot {
  const firstWalk = walkProviderPluginEvaluationPackageTree(root);
  const cached = providerPluginEvaluationPackageCache.get(root);
  if (
    cached !== undefined
    && sameProviderPluginEvaluationPackageTree(
      cached.verificationWalk,
      firstWalk,
    )
  ) return cached;

  const files: {
    readonly path: string;
    readonly bytes: Buffer;
    readonly mode: number;
  }[] = [];
  const directories: { readonly path: string; readonly mode: number }[] = [];
  for (const entry of firstWalk.entries) {
    if (entry.kind === "directory") {
      directories.push(Object.freeze({
        path: entry.path,
        mode: Number(entry.stats.mode & 0o777n),
      }));
      continue;
    }
    const path = resolve(root, entry.path);
    const bytes = readOwnedBoundedProviderPluginEvaluationFile(
      path,
      MAX_PROVIDER_PLUGIN_EVALUATION_SOURCE_BYTES,
      `provider plugin evaluation package file ${entry.path}`,
    );
    let current: BigIntStats;
    try {
      current = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(
        `provider plugin evaluation package file ${entry.path} changed while it was snapshotted`,
      );
    }
    if (
      bytes.byteLength !== Number(entry.stats.size)
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameEvaluationSourceSnapshot(entry.stats, current)
    ) {
      throw new Error(
        `provider plugin evaluation package file ${entry.path} changed while it was snapshotted`,
      );
    }
    files.push(Object.freeze({
      path: entry.path,
      bytes,
      mode: Number(entry.stats.mode & 0o777n),
    }));
  }
  const secondWalk = walkProviderPluginEvaluationPackageTree(root);
  if (!sameProviderPluginEvaluationPackageTree(firstWalk, secondWalk)) {
    throw new Error(
      "provider plugin evaluation package tree changed while it was snapshotted",
    );
  }
  const manifest = files.find((file) => file.path === "package.json");
  let manifestValue: unknown;
  try {
    manifestValue = manifest === undefined
      ? undefined
      : JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes),
      ) as unknown;
  } catch {
    throw new Error(
      `provider plugin evaluation package manifest ${root} is invalid`,
    );
  }
  if (
    typeof manifestValue !== "object"
    || manifestValue === null
    || Array.isArray(manifestValue)
  ) {
    throw new Error(
      `provider plugin evaluation package manifest ${root} has no identity`,
    );
  }
  const packageName = (manifestValue as Record<string, unknown>).name;
  const packageVersion = (manifestValue as Record<string, unknown>).version;
  if (typeof packageName !== "string" || typeof packageVersion !== "string") {
    throw new Error(
      `provider plugin evaluation package manifest ${root} has no identity`,
    );
  }
  const treeHash = createHash("sha256");
  treeHash.update("provider-plugin-installed-package-tree@1\0");
  updateProviderPluginEvaluationTreeHash(
    treeHash,
    "identity",
    Buffer.from(`${packageName}@${packageVersion}`, "utf8"),
  );
  for (const directory of directories) {
    const durableMode = providerPluginDurableInstalledPackageMode(
      "directory",
      directory.mode,
    );
    updateProviderPluginEvaluationTreeHash(
      treeHash,
      `directory/${directory.path}`,
      Buffer.from(`mode:${durableMode.toString(8)}`, "utf8"),
    );
  }
  for (const file of files) {
    const durableMode = providerPluginDurableInstalledPackageMode(
      "file",
      file.mode,
    );
    updateProviderPluginEvaluationTreeHash(
      treeHash,
      `file-mode/${file.path}`,
      Buffer.from(`mode:${durableMode.toString(8)}`, "utf8"),
    );
    updateProviderPluginEvaluationTreeHash(
      treeHash,
      `file/${file.path}`,
      file.bytes,
    );
  }
  const snapshot = Object.freeze({
    treeSha256: treeHash.digest("hex"),
    totalBytes: firstWalk.totalBytes,
    verificationWalk: secondWalk,
  });
  if (
    !providerPluginEvaluationPackageCache.has(root)
    && providerPluginEvaluationPackageCache.size
      >= MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_CACHE_ENTRIES
  ) {
    providerPluginEvaluationPackageCache.clear();
  }
  providerPluginEvaluationPackageCache.set(root, snapshot);
  return snapshot;
}

function providerPluginEvaluationValueImports(
  bytes: Buffer,
  path: string,
): readonly { readonly kind: string; readonly path: string }[] {
  const extension = extname(path);
  if (extension === ".jsx" || extension === ".tsx") {
    throw new Error(
      `provider plugin evaluation module ${path} uses configuration-dependent JSX or TSX`,
    );
  }
  if (!providerPluginEvaluationModuleExtensions.has(extension)) {
    return Object.freeze([]);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      .replace(/^#![^\r\n]*(?:\r?\n|$)/u, "");
  } catch {
    throw new Error(
      `provider plugin evaluation module ${path} must be valid UTF-8`,
    );
  }
  const scanner =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? providerPluginEvaluationImportScanners.ts
      : providerPluginEvaluationImportScanners.js;
  const imports = Object.freeze([...scanner.scanImports(source)]);
  if (imports.length > MAX_PROVIDER_PLUGIN_EVALUATION_IMPORTS_PER_MODULE) {
    throw new Error(
      `provider plugin evaluation module ${path} has too many static imports`,
    );
  }
  return imports;
}

function resolveProviderPluginEvaluationImport(
  importerPath: string,
  specifier: string,
  importKind: string,
): string | undefined {
  if (
    specifier.startsWith("node:")
    || specifier.startsWith("bun:")
    || providerPluginEvaluationRuntimeBuiltins.has(specifier)
  ) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) {
    throw new Error(
      `provider plugin evaluation module ${importerPath} imports unsupported absolute or URL dependency ${specifier}`,
    );
  }
  let resolvedPath: string;
  try {
    if (isAbsolute(specifier)) {
      resolvedPath = specifier;
    } else {
      resolvedPath = importKind === "require-call"
        ? createRequire(importerPath).resolve(specifier)
        : Bun.resolveSync(specifier, dirname(importerPath));
    }
  } catch (error) {
    throw new Error(
      `provider plugin evaluation module ${importerPath} has unresolved static dependency ${specifier}`,
      { cause: error },
    );
  }
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(resolvedPath)
    || !isAbsolute(resolvedPath)
  ) {
    throw new Error(
      `provider plugin evaluation dependency ${specifier} did not resolve to a local file`,
    );
  }
  let path: string;
  try {
    path = realpathSync(resolvedPath);
  } catch (error) {
    throw new Error(
      `provider plugin evaluation dependency ${specifier} resolved to an unreadable path`,
      { cause: error },
    );
  }
  classifyProviderPluginPhysicalPath(path);
  if (path === providerPluginApiBoundaryPath) return undefined;
  return path;
}

function captureProviderPluginEvaluationIdentity(
  pluginId: string,
  sources: readonly ProviderPluginImplementationSourceV1[],
): {
  readonly sourceDigests: ReadonlyMap<string, string>;
  readonly installedPackageDigests: ReadonlyMap<string, string>;
} {
  const sourceDigests = new Map<string, string>();
  const sourceBytes = new Map<string, Buffer>();
  let totalSourceBytes = 0;
  const captureRepositorySource = (
    path: string,
    label: string,
  ): Buffer => {
    const existing = sourceBytes.get(path);
    if (existing !== undefined) return existing;
    if (
      sourceDigests.size >= MAX_PROVIDER_PLUGIN_EVALUATION_CLOSURE_SOURCES
    ) {
      throw new Error(
        `provider plugin ${pluginId} evaluation source closure exceeds its file bound`,
      );
    }
    const bytes = readProviderPluginEvaluationSource(pluginId, path, label);
    if (
      totalSourceBytes + bytes.byteLength
        > MAX_PROVIDER_PLUGIN_EVALUATION_CLOSURE_BYTES
    ) {
      throw new Error(
        `provider plugin ${pluginId} evaluation source closure exceeds its byte bound`,
      );
    }
    totalSourceBytes += bytes.byteLength;
    sourceBytes.set(path, bytes);
    sourceDigests.set(
      path,
      createHash("sha256").update(bytes).digest("hex"),
    );
    return bytes;
  };
  for (const source of sources) {
    captureRepositorySource(source.path, source.label);
  }

  const pluginEntry = sources.find((source) => source.label === "plugin.ts");
  if (pluginEntry === undefined) {
    throw new Error(
      `provider plugin ${pluginId} must bind its plugin.ts implementation source`,
    );
  }
  const pending = [pluginEntry.path];
  const analyzedModules = new Set<string>();
  const installedPackageDigests = new Map<string, string>();
  let installedPackageBytes = 0;
  while (pending.length > 0) {
    pending.sort(compareProviderPluginEvaluationText);
    const path = pending.pop();
    if (path === undefined || analyzedModules.has(path)) continue;
    analyzedModules.add(path);

    let bytes: Buffer;
    const physicalPath = classifyProviderPluginPhysicalPath(path);
    if (physicalPath.kind === "installed-package") {
      const root = physicalPath.root;
      if (!installedPackageDigests.has(root)) {
        if (
          installedPackageDigests.size
            >= MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGES
        ) {
          throw new Error(
            `provider plugin ${pluginId} evaluation package closure exceeds its package bound`,
          );
        }
        const snapshot = snapshotProviderPluginEvaluationPackage(root);
        if (
          installedPackageBytes + snapshot.totalBytes
            > MAX_PROVIDER_PLUGIN_EVALUATION_PACKAGE_BYTES
        ) {
          throw new Error(
            `provider plugin ${pluginId} evaluation package closure exceeds its byte bound`,
          );
        }
        installedPackageBytes += snapshot.totalBytes;
        installedPackageDigests.set(root, snapshot.treeSha256);
      }
      bytes = readOwnedBoundedProviderPluginEvaluationFile(
        path,
        MAX_PROVIDER_PLUGIN_EVALUATION_SOURCE_BYTES,
        `provider plugin ${pluginId} evaluation package module ${relative(providerPluginRepositoryRoot, path)}`,
      );
    } else {
      bytes = captureRepositorySource(
        path,
        relative(providerPluginRepositoryRoot, path).split(sep).join("/"),
      );
    }
    for (const dependency of providerPluginEvaluationValueImports(bytes, path)) {
      // Literal dynamic imports can execute at module top level before the
      // definition is frozen. Bind them here even when they also sit behind a
      // branded lazy loader; the later runtime check is intentionally a
      // second guard, not a substitute for evaluation-time provenance.
      const child = resolveProviderPluginEvaluationImport(
        path,
        dependency.path,
        dependency.kind,
      );
      if (child !== undefined && !analyzedModules.has(child)) {
        pending.push(child);
      }
    }
  }
  return Object.freeze({
    sourceDigests: new Map(
      [...sourceDigests.entries()].sort(([left], [right]) =>
        compareProviderPluginEvaluationText(left, right)),
    ),
    installedPackageDigests: new Map(
      [...installedPackageDigests.entries()].sort(([left], [right]) =>
        compareProviderPluginEvaluationText(left, right)),
    ),
  });
}

/** Internal registry guard against forged post-validation projections. */
export function isValidatedProviderPlugin(
  value: ProviderPluginDefinitionV1 | ProviderPluginV1,
): value is ProviderPluginV1 {
  return validatedProviderPlugins.has(value);
}

/**
 * Registry-only evidence captured when a trusted source definition becomes an
 * executable object. It detects ordinary drift in every declared source and
 * the recursively imported repository descriptor closure before the registry's
 * later coherent snapshot. It cannot turn trusted in-process code into a
 * same-account hostile-writer sandbox or prove what Bun loaded during a race.
 */
export function providerPluginEvaluationSourceSha256(
  plugin: ProviderPluginV1,
): ReadonlyMap<string, string> | undefined {
  return providerPluginEvaluationSourceDigests.get(plugin);
}

/**
 * Registry-only exact package-tree identities for every statically
 * discoverable value import, including literal dynamic imports that could run
 * at module top level before the definition is frozen.
 */
export function providerPluginEvaluationInstalledPackageSha256(
  plugin: ProviderPluginV1,
): ReadonlyMap<string, string> | undefined {
  return providerPluginEvaluationInstalledPackageDigests.get(plugin);
}

/** Kernel-only immutable artifact identity for a validated portable projection. */
export function portableProviderPluginArtifactSha256(
  plugin: ProviderPluginV1,
): string | null {
  return portableProviderPluginArtifacts.get(plugin) ?? null;
}

/** Kernel-only virtual adapter owned by one validated portable binding. */
export function portableProviderPluginAdapter(
  binding: ProviderPluginBindingV1,
): { readonly adapterId: string; readonly manifest: WrenchManifest } | null {
  return portableProviderPluginAdapters.get(binding) ?? null;
}

/** Kernel-only exact portable identity for one validated operation route. */
export function portableProviderPluginOperationIdentity(
  binding: ProviderPluginBindingV1,
  operation: ProviderPluginOperationV1,
  contractVersion: number,
): PortableOperationIdentityV1 | null {
  return portableProviderPluginOperationIdentities.get(binding)?.get(
    `${operation.name}@${contractVersion}`,
  ) ?? null;
}

/** Exact immutable package operation that implements a portable subject probe. */
export function portableProviderPluginSubjectProbeIdentity(
  binding: ProviderPluginBindingV1,
): PortableOperationIdentityV1 | null {
  return portableProviderPluginSubjectProbeIdentities.get(binding) ?? null;
}

function requireExactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key)).sort();
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported keys: ${unexpected.join(", ")}`);
  }
}

function snapshotExactEnumerableDataProperties(
  value: unknown,
  keys: readonly string[],
  label: string,
): readonly unknown[] {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const expectedKeys = new Set<PropertyKey>(keys);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.size
    || actualKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}`);
  }
  return Object.freeze(keys.map((key) =>
    ownDataProperty(value, key, `${label}.${key}`)));
}

export function parseProviderPluginReconciliationContextV1(
  value: unknown,
): ProviderPluginReconciliationContextV1 {
  const [schemaVersion, kind, dispatchValue, targetValue] =
    snapshotExactEnumerableDataProperties(
      value,
      ["schemaVersion", "kind", "dispatch", "target"],
      "provider plugin reconciliation context",
    );
  if (
    schemaVersion !== 1
    || (
      kind !== "provider-accepted-target-presence"
      && kind !== "provider-bound-target-desired-state"
    )
  ) {
    throw new Error("provider plugin reconciliation context is malformed");
  }
  const [dispatchId, dispatchIndex, dispatchPlanned] =
    snapshotExactEnumerableDataProperties(
      dispatchValue,
      ["id", "index", "planned"],
      "provider plugin reconciliation context dispatch",
    );
  if (
    typeof dispatchId !== "string"
    || dispatchId.length > 256
    || !providerPluginDispatchIdPattern.test(dispatchId)
    || !Number.isSafeInteger(dispatchIndex)
    || !Number.isSafeInteger(dispatchPlanned)
    || (dispatchIndex as number) < 1
    || (dispatchPlanned as number) !== 1
    || dispatchIndex !== dispatchPlanned
  ) {
    throw new Error(
      "provider plugin reconciliation context dispatch is malformed",
    );
  }
  const [targetSchemaVersion, targetIdentifier] =
    snapshotExactEnumerableDataProperties(
      targetValue,
      ["schemaVersion", "identifier"],
      "provider plugin reconciliation context target",
    );
  if (
    targetSchemaVersion !== 1
    || typeof targetIdentifier !== "string"
    || targetIdentifier.length < 1
    || Buffer.byteLength(targetIdentifier, "utf8") > 8 * 1024
    || hasUnpairedSurrogate(targetIdentifier)
    || [...targetIdentifier].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined
        || codePoint === 0x7f
        || codePoint < 0x20;
    })
  ) {
    throw new Error(
      "provider plugin reconciliation context target is malformed",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind,
    dispatch: Object.freeze({
      id: dispatchId,
      index: dispatchIndex as number,
      planned: dispatchPlanned as number,
    }),
    target: Object.freeze({
      schemaVersion: 1,
      identifier: targetIdentifier,
    }),
  });
}

function snapshotBoundedDenseArray(
  value: unknown,
  label: string,
  maximumItems: number,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || (Object.getPrototypeOf(value) as unknown) !== Array.prototype
  ) {
    throw new Error(`${label} must be a bounded dense array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const rawLength: unknown = lengthDescriptor !== undefined
    && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : Number.NaN;
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 1
    || rawLength > maximumItems
  ) {
    throw new Error(
      `${label} must contain between 1 and ${maximumItems} items`,
    );
  }
  const expectedKeys = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: rawLength }, (_unused, index) => String(index)),
  ]);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.size
    || actualKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error(`${label} must be a bounded dense array`);
  }
  return Object.freeze(Array.from(
    { length: rawLength },
    (_unused, index) =>
      ownDataProperty(value, String(index), `${label}[${index}]`),
  ));
}

function requireNonEmptyArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error(`${label} must be a non-empty array`);
  }
}

function requireBoundedNonEmptyArray(
  value: unknown,
  label: string,
  maximumItems: number,
): void {
  requireNonEmptyArray(value, label);
  if ((value as readonly unknown[]).length > maximumItems) {
    throw new Error(`${label} may contain at most ${maximumItems} items`);
  }
}

function freezeStringList(
  values: readonly string[],
  label: string,
  maximumItems: number,
  allowEmpty = false,
): readonly string[] {
  if (
    !Array.isArray(values)
    || (!allowEmpty && values.length < 1)
    || values.length > maximumItems
  ) {
    throw new Error(
      `${label} must contain ${allowEmpty ? "at most" : "between 1 and"} ${maximumItems} strings`,
    );
  }
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length < 1) {
      throw new Error(`${label} must contain non-empty strings`);
    }
    result.push(value);
  }
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return Object.freeze(result);
}

function freezeInputField(
  field: ScalarInputField | FileInputField,
  label: string,
  maximumArrayItems: 25 | 100,
  nested?: boolean,
): ScalarInputField | FileInputField;
function freezeInputField(
  field: ArrayInputField,
  label: string,
  maximumArrayItems: 25 | 100,
  nested?: boolean,
): ArrayInputField;
function freezeInputField(
  field: InputField,
  label: string,
  maximumArrayItems: 25 | 100,
  nested?: boolean,
): InputField;
function freezeInputField(
  field: InputField,
  label: string,
  maximumArrayItems: 25 | 100,
  nested = false,
): InputField {
  if (
    typeof field !== "object"
    || field === null
    || typeof field.description !== "string"
    || field.description.length < 1
    || field.description.length > 500
  ) {
    throw new Error(`${label} must declare a bounded description`);
  }
  if (field.type === "file") {
    requireExactKeys(field, ["type", "description", "maxBytes", "mediaTypes"], label);
    if (
      !Number.isSafeInteger(field.maxBytes)
      || field.maxBytes < 1
      || field.maxBytes > 1024 * 1024 * 1024
    ) {
      throw new Error(`${label}.maxBytes must be a bounded positive integer`);
    }
    if (
      field.mediaTypes !== undefined
      && (
        field.mediaTypes.length < 1
        || field.mediaTypes.length > 32
        || field.mediaTypes.some((value) =>
          !/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/u.test(value))
      )
    ) {
      throw new Error(`${label}.mediaTypes must contain bounded media types`);
    }
    return Object.freeze({
      ...field,
      ...(field.mediaTypes === undefined
        ? {}
        : {
          mediaTypes: freezeStringList(
            field.mediaTypes,
            `${label}.mediaTypes`,
            32,
          ),
        }),
    });
  }
  if (field.type === "array") {
    requireExactKeys(field, ["type", "description", "items", "minItems", "maxItems"], label);
    if (
      !Number.isSafeInteger(field.minItems)
      || !Number.isSafeInteger(field.maxItems)
      || nested
      || field.minItems < 0
      || field.maxItems < field.minItems
      || field.maxItems < 1
      || field.maxItems > maximumArrayItems
    ) {
      throw new Error(`${label} must declare valid bounded item counts`);
    }
    return Object.freeze({
      ...field,
      items: freezeInputField(
        field.items,
        `${label}.items`,
        maximumArrayItems,
        true,
      ),
    });
  }
  requireExactKeys(
    field,
    [
      "type",
      "description",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "enum",
      "format",
      "urlPathPrefixes",
    ],
    label,
  );
  if (
    field.type !== "string"
    && field.type !== "number"
    && field.type !== "boolean"
  ) {
    throw new Error(`${label}.type is unsupported`);
  }
  const lengthBounds = field.minLength !== undefined
    || field.maxLength !== undefined;
  if (
    lengthBounds
    && (
      field.type !== "string"
      || (
        field.minLength !== undefined
        && (
          !Number.isSafeInteger(field.minLength)
          || field.minLength < 0
          || field.minLength > 1_000_000
        )
      )
      || (
        field.maxLength !== undefined
        && (
          !Number.isSafeInteger(field.maxLength)
          || field.maxLength < 1
          || field.maxLength > 1_000_000
        )
      )
      || (
        field.minLength !== undefined
        && field.maxLength !== undefined
        && field.minLength > field.maxLength
      )
    )
  ) {
    throw new Error(`${label} has invalid string length bounds`);
  }
  const numericBounds = field.minimum !== undefined
    || field.maximum !== undefined;
  if (
    numericBounds
    && (
      field.type !== "number"
      || (field.minimum !== undefined && !Number.isFinite(field.minimum))
      || (field.maximum !== undefined && !Number.isFinite(field.maximum))
      || (
        field.minimum !== undefined
        && field.maximum !== undefined
        && field.minimum > field.maximum
      )
    )
  ) {
    throw new Error(`${label} has invalid numeric bounds`);
  }
  if (
    field.format !== undefined
    && (
      field.type !== "string"
      || (field.format !== "url" && field.format !== "path-segment")
    )
  ) {
    throw new Error(`${label}.format is invalid`);
  }
  if (
    field.urlPathPrefixes !== undefined
    && (
      field.type !== "string"
      || field.format !== "url"
      || field.urlPathPrefixes.length < 1
      || field.urlPathPrefixes.length > 20
      || field.urlPathPrefixes.some((prefix) =>
        !prefix.startsWith("/")
        || prefix.startsWith("//")
        || prefix.length > 2_048
        || prefix.includes(String.fromCharCode(0)))
      || field.urlPathPrefixes.some((prefix) =>
        prefix.includes("\\")
        || prefix.includes("?")
        || prefix.includes("#")
        || /%(?:25|2e|2f|5c)/iu.test(prefix)
        || prefix.split("/").some((segment) =>
          segment === "." || segment === ".."))
    )
  ) {
    throw new Error(`${label}.urlPathPrefixes is invalid`);
  }
  if (field.enum !== undefined) {
    if (
      field.enum.length < 1
      || field.enum.length > 100
      || field.enum.some((value) =>
        typeof value !== field.type
        || (typeof value === "number" && !Number.isFinite(value)))
      || new Set(field.enum.map((value) => JSON.stringify(value))).size
        !== field.enum.length
    ) {
      throw new Error(`${label}.enum is invalid`);
    }
  }
  return Object.freeze({
    ...field,
    ...(field.enum === undefined ? {} : { enum: Object.freeze([...field.enum]) }),
    ...(field.urlPathPrefixes === undefined
      ? {}
      : {
        urlPathPrefixes: freezeStringList(
          field.urlPathPrefixes,
          `${label}.urlPathPrefixes`,
          20,
        ),
      }),
  });
}

function freezeInputSchema(
  schema: InputSchema,
  label: string,
  maximumArrayItems: 25 | 100,
): InputSchema {
  requireExactKeys(schema, ["properties", "required"], label);
  if (
    typeof schema.properties !== "object"
    || schema.properties === null
    || Array.isArray(schema.properties)
  ) {
    throw new Error(`${label}.properties must be an object`);
  }
  const propertyEntries: [string, InputField][] = [];
  for (const name in schema.properties) {
    if (!Object.hasOwn(schema.properties, name)) continue;
    if (propertyEntries.length === 100) {
      throw new Error(`${label}.properties may contain at most 100 fields`);
    }
    propertyEntries.push([name, schema.properties[name]!]);
  }
  propertyEntries.sort(([left], [right]) => left.localeCompare(right));
  const properties: Record<string, InputField> = {};
  for (const [name, field] of propertyEntries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name)) {
      throw new Error(`${label}.properties contains invalid field ${name}`);
    }
    properties[name] = freezeInputField(
      field,
      `${label}.properties.${name}`,
      maximumArrayItems,
    );
  }
  const required = freezeStringList(
    schema.required,
    `${label}.required`,
    100,
    true,
  );
  for (const name of required) {
    if (properties[name] === undefined) throw new Error(`${label}.required references ${name}`);
  }
  return Object.freeze({
    properties: Object.freeze(properties),
    required,
  });
}

function containsFileInput(field: InputField): boolean {
  return field.type === "file"
    || (field.type === "array" && field.items.type === "file");
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function freezeOperation(
  operation: ProviderPluginOperationDefinitionV1,
  transport: ProviderPluginTransport,
  sourceKind: ProviderPluginV1["sourceKind"],
): ProviderPluginOperationV1 {
  const official = transport === "provider-api";
  requireExactKeys(
    operation,
    [
      "name",
      "contractVersion",
      "historicalContractVersions",
      "risk",
      "input",
      "sideEffect",
      "idempotency",
      "dedupeWindowMs",
      "state",
      "dispatch",
      "implementation",
      "planDispatches",
      "validateInput",
      "validateSubjectInput",
      "reconciliation",
      "omni",
      "access",
      ...(official ? ["requiredScopeSets", "coverage"] : []),
    ],
    "provider plugin operation",
  );
  if (
    !isProviderPluginOperationName(operation.name)
  ) {
    throw new Error(`provider plugin operation ${String(operation.name)} must be a bounded dotted semantic name`);
  }
  if (
    !Number.isSafeInteger(operation.contractVersion)
    || operation.contractVersion < 1
    || operation.contractVersion > 1_000_000
  ) {
    throw new Error(`provider plugin operation ${operation.name} has an invalid contract version`);
  }
  if (
    operation.historicalContractVersions !== undefined
    && (
      !Array.isArray(operation.historicalContractVersions)
      || operation.historicalContractVersions.length
        >= MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION
    )
  ) {
    throw new Error(
      `provider plugin operation ${operation.name} may declare at most ${MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION - 1} historical contract versions`,
    );
  }
  const rawHistoricalContractVersions: readonly unknown[] =
    operation.historicalContractVersions === undefined
      ? []
      : operation.historicalContractVersions;
  const copiedHistoricalContractVersions: number[] = [];
  for (const version of rawHistoricalContractVersions) {
    if (
      typeof version !== "number"
      || !Number.isSafeInteger(version)
      || version < 1
      || version > 1_000_000
      || version >= operation.contractVersion
    ) {
      throw new Error(`provider plugin operation ${operation.name} has an invalid historical contract version`);
    }
    copiedHistoricalContractVersions.push(version);
  }
  const historicalContractVersions = Object.freeze(
    copiedHistoricalContractVersions,
  );
  if (new Set(historicalContractVersions).size !== historicalContractVersions.length) {
    throw new Error(`provider plugin operation ${operation.name} repeats a historical contract version`);
  }
  if (!["R1", "R2", "R3", "R4"].includes(operation.risk)) {
    throw new Error(`provider plugin operation ${operation.name} has an invalid risk`);
  }
  if (operation.state !== "observed" && operation.state !== "capture-required") {
    throw new Error(`provider plugin operation ${operation.name} has an invalid state`);
  }
  if (
    operation.access !== undefined
    && (
      operation.access !== "public"
      || official
      || sourceKind !== "built-in"
      || transport !== "web-session-api"
      || operation.risk !== "R1"
      || operation.state !== "observed"
      || operation.dispatch !== "none"
    )
  ) {
    throw new Error(
      `provider plugin operation ${operation.name} public access requires an observed dispatch-free built-in web-session R1 operation`,
    );
  }
  if (
    operation.dispatch !== "none"
    && operation.dispatch !== "single"
    && operation.dispatch !== "thread-items"
    && operation.dispatch !== "bounded-items"
  ) {
    throw new Error(`provider plugin operation ${operation.name} has an invalid dispatch policy`);
  }
  if (
    typeof operation.sideEffect !== "string"
    || operation.sideEffect.length < 1
    || operation.sideEffect.length > 500
    || hasControlCharacters(operation.sideEffect)
    || typeof operation.implementation !== "string"
    || operation.implementation.length < 1
    || operation.implementation.length > 500
    || hasControlCharacters(operation.implementation)
  ) {
    throw new Error(`provider plugin operation ${operation.name} has incomplete semantics`);
  }
  if (
    (operation.idempotency !== "none" && operation.idempotency !== "local-at-most-once")
    || !Number.isSafeInteger(operation.dedupeWindowMs)
    || operation.dedupeWindowMs < 0
    || operation.dedupeWindowMs > 30 * 24 * 60 * 60_000
    || typeof operation.planDispatches !== "function"
    || typeof operation.validateInput !== "function"
  ) {
    throw new Error(`provider plugin operation ${operation.name} has invalid host hooks`);
  }
  if (
    operation.risk === "R1"
    && (
      operation.sideEffect !== "none"
      || operation.dispatch !== "none"
      || operation.idempotency !== "none"
      || operation.dedupeWindowMs !== 0
      || operation.reconciliation !== undefined
      || Object.values(operation.input.properties).some(containsFileInput)
    )
  ) {
    throw new Error(
      `provider plugin operation ${operation.name} must keep R1 read semantics side-effect-free and dispatch-free`,
    );
  }
  if (
    (operation.risk === "R2" || operation.risk === "R3")
    && (
      operation.dispatch === "none"
      || operation.idempotency !== "local-at-most-once"
      || operation.dedupeWindowMs < 60_000
    )
  ) {
    throw new Error(
      `provider plugin operation ${operation.name} must bind every R2/R3 write to a confirmed dispatch and positive at-most-once window`,
    );
  }
  if (
    operation.risk === "R4"
    && operation.state !== "capture-required"
  ) {
    throw new Error(
      `provider plugin operation ${operation.name} must keep R4 authority capture-required`,
    );
  }
  if (
    operation.validateSubjectInput !== undefined
    && typeof operation.validateSubjectInput !== "function"
  ) {
    throw new Error(
      `provider plugin operation ${operation.name} has an invalid subject-input hook`,
    );
  }
  if (operation.reconciliation !== undefined) {
    if (
      typeof operation.reconciliation !== "object"
      || operation.reconciliation === null
    ) {
      throw new Error(
        `provider plugin operation ${operation.name} has an invalid reconciliation contract`,
      );
    }
    const reconciliationLabel =
      `provider plugin operation ${operation.name} reconciliation`;
    if (operation.reconciliation.kind === "boolean-desired-state") {
      requireExactKeys(
        operation.reconciliation,
        ["kind", "desiredState"],
        reconciliationLabel,
      );
      if (typeof operation.reconciliation.desiredState !== "function") {
        throw new Error(
          `provider plugin operation ${operation.name} has an invalid reconciliation contract`,
        );
      }
    } else if (
      operation.reconciliation.kind === "provider-accepted-target-presence"
      || operation.reconciliation.kind
        === "provider-bound-target-desired-state"
    ) {
      requireExactKeys(
        operation.reconciliation,
        operation.reconciliation.kind === "provider-accepted-target-presence"
          ? ["kind"]
          : ["kind", "desiredState"],
        reconciliationLabel,
      );
      if (
        operation.reconciliation.kind
          === "provider-bound-target-desired-state"
        && operation.reconciliation.desiredState !== false
      ) {
        throw new Error(
          `provider plugin operation ${operation.name} has an invalid reconciliation contract`,
        );
      }
      if (operation.dispatch !== "single") {
        const targetKind = operation.reconciliation.kind
          === "provider-accepted-target-presence"
          ? "provider-accepted"
          : "provider-bound";
        throw new Error(
          `provider plugin operation ${operation.name} ${targetKind} target reconciliation requires one exact dispatch`,
        );
      }
    } else {
      throw new Error(
        `provider plugin operation ${operation.name} has an invalid reconciliation contract`,
      );
    }
  }
  const isOmniInboxRead = operation.name === "messaging.list"
    || operation.name === "messaging.read";
  if (isOmniInboxRead && operation.omni === undefined) {
    throw new Error(
      `provider plugin operation ${operation.name} must declare supported or unsupported omni normalization`,
    );
  }
  if (!isOmniInboxRead && operation.omni !== undefined) {
    throw new Error(
      `provider plugin operation ${operation.name} cannot declare inbox normalization`,
    );
  }
  let omni: ProviderPluginOmniDefinitionV1 | undefined;
  if (operation.omni !== undefined) {
    if (
      typeof operation.omni !== "object"
      || operation.omni === null
    ) {
      throw new Error(
        `provider plugin operation ${operation.name} has an invalid omni normalization contract`,
      );
    }
    if (operation.omni.state === "supported") {
      requireExactKeys(
        operation.omni,
        ["state", "schemaVersion", "materializerId", "materializerVersion", "materialize"],
        `provider plugin operation ${operation.name} omni normalization`,
      );
      if (
        operation.state !== "observed"
        || operation.risk !== "R1"
        || operation.omni.schemaVersion !== 1
        || typeof operation.omni.materializerId !== "string"
        || !/^[a-z][a-z0-9-]{0,63}$/u.test(operation.omni.materializerId)
        || !Number.isSafeInteger(operation.omni.materializerVersion)
        || operation.omni.materializerVersion < 1
        || operation.omni.materializerVersion > 1_000_000
        || typeof operation.omni.materialize !== "function"
      ) {
        throw new Error(
          `provider plugin operation ${operation.name} has an invalid supported omni normalization contract`,
        );
      }
      omni = Object.freeze({
        state: "supported",
        schemaVersion: 1,
        materializerId: operation.omni.materializerId,
        materializerVersion: operation.omni.materializerVersion,
        materialize: operation.omni.materialize,
      });
    } else if (operation.omni.state === "unsupported") {
      requireExactKeys(
        operation.omni,
        ["state", "reason"],
        `provider plugin operation ${operation.name} omni normalization`,
      );
      if (
        typeof operation.omni.reason !== "string"
        || operation.omni.reason.length < 1
        || operation.omni.reason.length > 1_000
        || hasControlCharacters(operation.omni.reason)
      ) {
        throw new Error(
          `provider plugin operation ${operation.name} has an invalid unsupported omni normalization reason`,
        );
      }
      omni = Object.freeze({
        state: "unsupported",
        reason: operation.omni.reason,
      });
    } else {
      throw new Error(
        `provider plugin operation ${operation.name} has an invalid omni normalization state`,
      );
    }
  }
  const {
    historicalContractVersions: ignoredHistoricalContractVersions,
    ...operationWithoutHistory
  } = operation;
  void ignoredHistoricalContractVersions;
  const common = {
    ...operationWithoutHistory,
    ...(historicalContractVersions.length === 0 ? {} : { historicalContractVersions }),
    contractVersions: Object.freeze([
      ...historicalContractVersions,
      operation.contractVersion,
    ].sort((left, right) => left - right)),
    input: freezeInputSchema(
      operation.input,
      `provider plugin operation ${operation.name}.input`,
      official ? 100 : 25,
    ),
    planDispatches: conformingProviderPluginPlanDispatches(operation),
    ...(operation.reconciliation === undefined
      ? {}
      : operation.reconciliation.kind === "boolean-desired-state"
        ? {
          reconciliation: Object.freeze({
            kind: operation.reconciliation.kind,
            desiredState: operation.reconciliation.desiredState,
          }),
        }
        : operation.reconciliation.kind
            === "provider-bound-target-desired-state"
          ? {
            reconciliation: Object.freeze({
              kind: operation.reconciliation.kind,
              desiredState: operation.reconciliation.desiredState,
            }),
          }
          : {
            reconciliation: Object.freeze({
              kind: operation.reconciliation.kind,
            }),
          }),
    ...(omni === undefined ? {} : { omni }),
  };
  if (!official) return Object.freeze(common);
  const providerOperation = operation as ProviderApiPluginOperationDefinitionV1;
  requireBoundedNonEmptyArray(
    providerOperation.requiredScopeSets,
    `provider plugin operation ${operation.name} requiredScopeSets`,
    32,
  );
  for (const scopeSet of providerOperation.requiredScopeSets) {
    requireBoundedNonEmptyArray(
      scopeSet,
      `provider plugin operation ${operation.name} scope set`,
      32,
    );
  }
  const requiredScopeSets = providerOperation.requiredScopeSets.map(
    (scopeSet) =>
      freezeStringList(
        scopeSet,
        `provider plugin operation ${operation.name} scope set`,
        32,
      ),
  );
  requireBoundedNonEmptyArray(
    providerOperation.coverage,
    `provider plugin operation ${operation.name} coverage`,
    64,
  );
  return Object.freeze({
    ...common,
    requiredScopeSets: Object.freeze(requiredScopeSets),
    coverage: freezeStringList(
      providerOperation.coverage,
      `provider plugin operation ${operation.name} coverage`,
      64,
    ),
  });
}

function validateProviderRuntime(value: ProviderApiPluginRuntimeV1): ProviderApiPluginRuntimeV1 {
  requireExactKeys(value, ["execute", "executeMessagingPart"], "provider plugin runtime");
  if (typeof value.execute !== "function") throw new Error("provider plugin runtime must declare execute");
  if (
    value.executeMessagingPart !== undefined
    && typeof value.executeMessagingPart !== "function"
  ) throw new Error("provider plugin messaging action runtime hook is invalid");
  return Object.freeze({
    execute: value.execute,
    ...(value.executeMessagingPart === undefined
      ? {}
      : { executeMessagingPart: value.executeMessagingPart }),
  });
}

function validateWebRuntime(value: WebSessionPluginRuntimeV1): WebSessionPluginRuntimeV1 {
  requireExactKeys(
    value,
    ["probe", "execute", "executeMessagingPart", "executePublic", "reconcile", "linkedDeviceLifecycle"],
    "web-session plugin runtime",
  );
  if (typeof value.probe !== "function" || typeof value.execute !== "function") {
    throw new Error("web-session plugin runtime must declare probe and execute");
  }
  if (
    value.executePublic !== undefined
    && typeof value.executePublic !== "function"
  ) {
    throw new Error("web-session plugin public runtime hook is invalid");
  }
  if (
    value.executeMessagingPart !== undefined
    && typeof value.executeMessagingPart !== "function"
  ) throw new Error("web-session plugin messaging action runtime hook is invalid");
  if (value.reconcile !== undefined && typeof value.reconcile !== "function") {
    throw new Error("web-session plugin runtime reconciliation hook is invalid");
  }
  let linkedDeviceLifecycle:
    | ProviderPluginLinkedDeviceLifecycleRuntimeV1
    | undefined;
  if (value.linkedDeviceLifecycle !== undefined) {
    requireExactKeys(
      value.linkedDeviceLifecycle,
      ["inspect", "pair", "syncOnce"],
      "linked-device plugin lifecycle runtime",
    );
    if (
      typeof value.linkedDeviceLifecycle.inspect !== "function"
      || typeof value.linkedDeviceLifecycle.pair !== "function"
      || typeof value.linkedDeviceLifecycle.syncOnce !== "function"
    ) {
      throw new Error("linked-device plugin lifecycle runtime is invalid");
    }
    linkedDeviceLifecycle = Object.freeze({
      inspect: value.linkedDeviceLifecycle.inspect,
      pair: value.linkedDeviceLifecycle.pair,
      syncOnce: value.linkedDeviceLifecycle.syncOnce,
    });
  }
  return Object.freeze({
    probe: value.probe,
    execute: value.execute,
    ...(value.executeMessagingPart === undefined
      ? {}
      : { executeMessagingPart: value.executeMessagingPart }),
    ...(value.executePublic === undefined
      ? {}
      : { executePublic: value.executePublic }),
    ...(value.reconcile === undefined ? {} : { reconcile: value.reconcile }),
    ...(linkedDeviceLifecycle === undefined ? {} : { linkedDeviceLifecycle }),
  });
}

function validateLocalCliRuntime(
  value: LocalCliPluginRuntimeV1,
): LocalCliPluginRuntimeV1 {
  requireExactKeys(
    value,
    ["inspect", "probe", "execute", "executeMessagingPart", "reconcile"],
    "local CLI plugin runtime",
  );
  if (
    typeof value.inspect !== "function"
    || typeof value.probe !== "function"
    || typeof value.execute !== "function"
  ) {
    throw new Error("local CLI plugin runtime must declare inspect, probe, and execute");
  }
  if (value.reconcile !== undefined && typeof value.reconcile !== "function") {
    throw new Error("local CLI plugin runtime reconciliation hook is invalid");
  }
  if (
    value.executeMessagingPart !== undefined
    && typeof value.executeMessagingPart !== "function"
  ) throw new Error("local CLI plugin messaging action runtime hook is invalid");
  return Object.freeze({
    inspect: value.inspect,
    probe: value.probe,
    execute: value.execute,
    ...(value.executeMessagingPart === undefined
      ? {}
      : { executeMessagingPart: value.executeMessagingPart }),
    ...(value.reconcile === undefined ? {} : { reconcile: value.reconcile }),
  });
}

function memoizedRuntime<T>(
  loader: () => Promise<T>,
  validate: (value: T) => T,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  const loadRuntime = () => {
    providerPluginStartedRuntimeLoaders.add(loadRuntime);
    if (pending === undefined) {
      pending = Promise.resolve().then(async () => {
        const identity = providerPluginRuntimeLoadIdentities.get(loadRuntime);
        await identity?.verify("before");
        const runtime = validate(await loader());
        await identity?.verify("after");
        return runtime;
      });
    }
    return pending;
  };
  return loadRuntime;
}

export type ProviderPluginRuntimeLoadIdentityPhase = "before" | "after";

type ProviderPluginRuntimeLoadIdentity = {
  readonly token: string;
  readonly verify: (
    phase: ProviderPluginRuntimeLoadIdentityPhase,
  ) => void | Promise<void>;
};

const providerPluginRuntimeLoadIdentities = new WeakMap<
  () => Promise<unknown>,
  ProviderPluginRuntimeLoadIdentity
>();
const providerPluginLazyRuntimeLoaders = new WeakSet<
  () => Promise<unknown>
>();
const providerPluginStartedRuntimeLoaders = new WeakSet<
  () => Promise<unknown>
>();

/**
 * Registry-only binding between a lazy loader and the exact startup source
 * snapshot whose hash is published in plans and receipts.
 */
export function bindProviderPluginRuntimeLoadIdentity(
  loadRuntime: () => Promise<unknown>,
  identity: ProviderPluginRuntimeLoadIdentity,
): void {
  const current = providerPluginRuntimeLoadIdentities.get(loadRuntime);
  if (current !== undefined) {
    if (current.token !== identity.token) {
      throw new Error(
        "provider plugin runtime loader is already bound to a different implementation identity",
      );
    }
    return;
  }
  if (providerPluginStartedRuntimeLoaders.has(loadRuntime)) {
    throw new Error(
      "provider plugin runtime loader was invoked before its implementation identity was bound",
    );
  }
  providerPluginRuntimeLoadIdentities.set(
    loadRuntime,
    Object.freeze(identity),
  );
}

export function lazyProviderApiRuntime(
  loader: () => Promise<ProviderApiPluginRuntimeV1>,
): ProviderApiPluginRuntimeHooksV1 {
  const loadRuntime = memoizedRuntime(loader, validateProviderRuntime);
  providerPluginLazyRuntimeLoaders.add(loadRuntime);
  return Object.freeze({ loadRuntime });
}

export function lazyWebSessionRuntime(
  loader: () => Promise<WebSessionPluginRuntimeV1>,
): WebSessionPluginRuntimeHooksV1 {
  const loadRuntime = memoizedRuntime(loader, validateWebRuntime);
  providerPluginLazyRuntimeLoaders.add(loadRuntime);
  return Object.freeze({ loadRuntime });
}

export function lazyLocalCliRuntime(
  loader: () => Promise<LocalCliPluginRuntimeV1>,
): LocalCliPluginRuntimeHooksV1 {
  const loadRuntime = memoizedRuntime(loader, validateLocalCliRuntime);
  providerPluginLazyRuntimeLoaders.add(loadRuntime);
  return Object.freeze({ loadRuntime });
}

function freezeProviderPluginMessaging(
  value: ProviderPluginMessagingDefinitionV1 | undefined,
  operations: readonly ProviderPluginOperationV1[],
  surfaceId: string,
): ProviderPluginMessagingDefinitionV1 | undefined {
  if (value === undefined) return undefined;
  requireExactKeys(value, [
    "schemaVersion",
    "contractId",
    "network",
    "contextLiveness",
    "listOperation",
    "contextOperation",
    "coordinateKind",
    "enumerateRoutes",
    "resolveRoute",
    "parseTarget",
    "contextInput",
    "action",
  ], `provider plugin surface ${surfaceId} messaging SPI`);
  if (
    value.schemaVersion !== 1
    || typeof value.contractId !== "string"
    || !/^[a-z][a-z0-9.-]{0,127}\.v1$/u.test(value.contractId)
    || typeof value.network !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.network)
    || value.contextLiveness !== "fresh-as-of-live-preflight"
      && value.contextLiveness !== "freshness-unproven"
    || value.listOperation !== "messaging.list"
    || value.contextOperation !== "messaging.read"
    || value.coordinateKind !== "beeperConversation"
      && value.coordinateKind !== "imessageChat"
      && value.coordinateKind !== "whatsappJid"
    || typeof value.enumerateRoutes !== "function"
    || typeof value.resolveRoute !== "object"
    || value.resolveRoute === null
    || typeof value.parseTarget !== "function"
    || typeof value.contextInput !== "function"
  ) {
    throw new Error(
      `provider plugin surface ${surfaceId} has an invalid messaging SPI`,
    );
  }
  requireExactKeys(
    value.resolveRoute,
    ["operation", "input", "candidates"],
    `provider plugin surface ${surfaceId} messaging exact route resolution`,
  );
  if (
    typeof value.resolveRoute.operation !== "string"
    || !isProviderPluginOperationName(value.resolveRoute.operation)
    || typeof value.resolveRoute.input !== "function"
    || typeof value.resolveRoute.candidates !== "function"
  ) throw new Error(
    `provider plugin surface ${surfaceId} has an invalid exact messaging route resolver`,
  );
  const exactResolutionOperation = operations.find((candidate) =>
    candidate.name === value.resolveRoute.operation
    && candidate.contractVersion === 1);
  if (
    exactResolutionOperation === undefined
    || exactResolutionOperation.state !== "observed"
    || exactResolutionOperation.risk !== "R1"
  ) {
    throw new Error(
      `provider plugin surface ${surfaceId} messaging SPI requires one observed R1 exact route resolver`,
    );
  }
  for (const operationName of [value.listOperation, value.contextOperation]) {
    const operation = operations.find((candidate) =>
      candidate.name === operationName && candidate.contractVersion === 1);
    if (
      operation === undefined
      || operation.state !== "observed"
      || operation.risk !== "R1"
      || operation.omni?.state !== "supported"
    ) {
      throw new Error(
        `provider plugin surface ${surfaceId} messaging SPI requires observed normalized ${operationName}@1`,
      );
    }
  }
  if (typeof value.action !== "object" || value.action === null) {
    throw new Error(
      `provider plugin surface ${surfaceId} messaging SPI has an invalid action declaration`,
    );
  }
  if (value.action.state === "unavailable") {
    requireExactKeys(
      value.action,
      ["state", "reason", "reply"],
      `provider plugin surface ${surfaceId} messaging action`,
    );
    if (
      value.action.reply !== "unsupported"
      || typeof value.action.reason !== "string"
      || value.action.reason.length < 1
      || value.action.reason.length > 1_000
      || hasControlCharacters(value.action.reason)
    ) {
      throw new Error(
        `provider plugin surface ${surfaceId} messaging action unavailability is invalid`,
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      contractId: value.contractId,
      network: value.network,
      contextLiveness: value.contextLiveness,
      listOperation: value.listOperation,
      contextOperation: value.contextOperation,
      coordinateKind: value.coordinateKind,
      enumerateRoutes: value.enumerateRoutes,
      resolveRoute: Object.freeze({
        operation: value.resolveRoute.operation,
        input: value.resolveRoute.input,
        candidates: value.resolveRoute.candidates,
      }),
      parseTarget: value.parseTarget,
      contextInput: value.contextInput,
      action: Object.freeze({
        state: "unavailable",
        reason: value.action.reason,
        reply: "unsupported",
      }),
    });
  }
  if (value.action.state !== "supported") {
    throw new Error(
      `provider plugin surface ${surfaceId} messaging action has an invalid state`,
    );
  }
  const action = value.action;
  requireExactKeys(
    action,
    [
      "state",
      "operation",
      "reply",
      "livePreflight",
      "compileTurnPart",
      "mapAcceptedResult",
      "proveExpectedOwnPrefix",
      "reconciliation",
    ],
    `provider plugin surface ${surfaceId} messaging action`,
  );
  const actionOperation = operations.find((candidate) =>
    candidate.name === action.operation && candidate.contractVersion === 1);
  if (
    actionOperation === undefined
    || actionOperation.state !== "observed"
    || actionOperation.risk !== "R3"
    || action.reply !== "supported" && action.reply !== "unsupported"
    || typeof action.livePreflight !== "object"
    || action.livePreflight === null
    || typeof action.compileTurnPart !== "function"
    || typeof action.mapAcceptedResult !== "function"
    || typeof action.proveExpectedOwnPrefix !== "function"
    || typeof action.reconciliation !== "function"
  ) {
    throw new Error(
      `provider plugin surface ${surfaceId} messaging action must bind one observed R3 operation`,
    );
  }
  requireExactKeys(
    action.livePreflight,
    ["operation", "input", "snapshot"],
    `provider plugin surface ${surfaceId} messaging action live preflight`,
  );
  const livePreflightOperation = operations.find((candidate) =>
    candidate.name === action.livePreflight.operation
    && candidate.contractVersion === 1);
  if (
    livePreflightOperation === undefined
    || livePreflightOperation.state !== "observed"
    || livePreflightOperation.risk !== "R1"
    || typeof action.livePreflight.input !== "function"
    || typeof action.livePreflight.snapshot !== "function"
  ) throw new Error(
    `provider plugin surface ${surfaceId} messaging action requires one observed R1 live preflight`,
  );
  return Object.freeze({
    schemaVersion: 1,
    contractId: value.contractId,
    network: value.network,
    contextLiveness: value.contextLiveness,
    listOperation: value.listOperation,
    contextOperation: value.contextOperation,
    coordinateKind: value.coordinateKind,
    enumerateRoutes: value.enumerateRoutes,
    resolveRoute: Object.freeze({
      operation: value.resolveRoute.operation,
      input: value.resolveRoute.input,
      candidates: value.resolveRoute.candidates,
    }),
    parseTarget: value.parseTarget,
    contextInput: value.contextInput,
    action: Object.freeze({
      state: "supported",
      operation: action.operation,
      reply: action.reply,
      livePreflight: Object.freeze({
        operation: action.livePreflight.operation,
        input: action.livePreflight.input,
        snapshot: action.livePreflight.snapshot,
      }),
      compileTurnPart: action.compileTurnPart,
      mapAcceptedResult: action.mapAcceptedResult,
      proveExpectedOwnPrefix: action.proveExpectedOwnPrefix,
      reconciliation: action.reconciliation,
    }),
  });
}

function freezeBinding(
  binding: ProviderPluginBindingDefinitionV1,
  sourceKind: ProviderPluginV1["sourceKind"],
): ProviderPluginBindingV1 {
  requireExactKeys(
    binding,
    [
      "transport",
      "surfaceId",
      "origin",
      ...(binding.transport === "provider-api" ? ["runtimeOrigins"] : []),
      ...(binding.transport === "local-cli" ? ["tool"] : []),
      "manifestOrigins",
      "protectedHostnameFamilies",
      "authKinds",
      "operations",
      "subject",
      "messaging",
      ...(binding.transport === "linked-device"
        ? ["linkedDeviceLifecycle"]
        : []),
      "runtime",
    ],
    "provider plugin binding",
  );
  if (!providerPluginTransports.includes(binding.transport)) {
    throw new Error("provider plugin binding has an unsupported transport");
  }
  if (!isProviderPluginSurfaceId(binding.surfaceId)) {
    throw new Error(`provider plugin surface ID ${binding.surfaceId} must be strict lowercase kebab-case with at most 63 characters`);
  }
  let origin: URL;
  try {
    origin = new URL(binding.origin);
  } catch {
    throw new Error(`provider plugin surface ${binding.surfaceId} has an invalid origin`);
  }
  if (
    origin.protocol !== "https:"
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
    || binding.origin !== origin.origin
  ) {
    throw new Error(`provider plugin surface ${binding.surfaceId} must declare an exact credential-free HTTPS origin`);
  }
  let runtimeOrigins: `https://${string}`[] = [];
  if (binding.transport === "provider-api") {
    const declaredRuntimeOrigins = binding.runtimeOrigins ?? [binding.origin];
    requireBoundedNonEmptyArray(
      declaredRuntimeOrigins,
      `provider plugin surface ${binding.surfaceId} runtimeOrigins`,
      20,
    );
    runtimeOrigins = [...declaredRuntimeOrigins];
    for (const runtimeOrigin of runtimeOrigins) {
      let parsed: URL;
      try {
        parsed = new URL(runtimeOrigin);
      } catch {
        throw new Error(
          `provider plugin surface ${binding.surfaceId} has an invalid runtime origin`,
        );
      }
      if (
        parsed.protocol !== "https:"
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.pathname !== "/"
        || parsed.search !== ""
        || parsed.hash !== ""
        || runtimeOrigin !== parsed.origin
      ) {
        throw new Error(
          `provider plugin surface ${binding.surfaceId} must declare exact credential-free HTTPS runtime origins`,
        );
      }
    }
    if (new Set(runtimeOrigins).size !== runtimeOrigins.length) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} repeats a runtime origin`,
      );
    }
    if (!runtimeOrigins.includes(binding.origin)) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} runtime origins must include its primary origin`,
      );
    }
    runtimeOrigins.sort();
  }
  const declaredManifestOrigins = binding.manifestOrigins === undefined
    ? [binding.origin]
    : binding.manifestOrigins;
  requireBoundedNonEmptyArray(
    declaredManifestOrigins,
    `provider plugin surface ${binding.surfaceId} manifestOrigins`,
    20,
  );
  const manifestOrigins = [...declaredManifestOrigins];
  for (const manifestOrigin of manifestOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(manifestOrigin);
    } catch {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} has an invalid manifest origin`,
      );
    }
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || manifestOrigin !== parsed.origin
    ) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} must declare exact credential-free HTTPS manifest origins`,
      );
    }
  }
  if (new Set(manifestOrigins).size !== manifestOrigins.length) {
    throw new Error(
      `provider plugin surface ${binding.surfaceId} repeats a manifest origin`,
    );
  }
  const endpointHostnames = [
    ...runtimeOrigins.map((runtimeOrigin) =>
      new URL(runtimeOrigin).hostname.toLowerCase()),
    ...(binding.transport === "provider-api"
      ? []
      : [origin.hostname.toLowerCase()]),
    ...manifestOrigins.map((manifestOrigin) =>
      new URL(manifestOrigin).hostname.toLowerCase()),
  ];
  const declaredProtectedHostnameFamilies =
    binding.protectedHostnameFamilies === undefined
      ? [...new Set(endpointHostnames)]
      : binding.protectedHostnameFamilies;
  requireBoundedNonEmptyArray(
    declaredProtectedHostnameFamilies,
    `provider plugin surface ${binding.surfaceId} protectedHostnameFamilies`,
    20,
  );
  const protectedHostnameFamilies = [...declaredProtectedHostnameFamilies];
  for (const family of protectedHostnameFamilies) {
    if (
      typeof family !== "string"
      || family !== family.toLowerCase()
      || family.length > 253
      || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(family)
      || family.includes("..")
    ) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} has an invalid protected hostname family`,
      );
    }
  }
  if (
    new Set(protectedHostnameFamilies).size
    !== protectedHostnameFamilies.length
  ) {
    throw new Error(
      `provider plugin surface ${binding.surfaceId} repeats a protected hostname family`,
    );
  }
  for (const hostname of endpointHostnames) {
    if (
      !protectedHostnameFamilies.some((family) =>
        hostname === family || hostname.endsWith(`.${family}`))
    ) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} protected hostname families do not cover ${hostname}`,
      );
    }
  }
  requireBoundedNonEmptyArray(
    binding.authKinds,
    `provider plugin surface ${binding.surfaceId} authKinds`,
    binding.transport === "web-session-api" || binding.transport === "local-cli"
      ? 5
      : 1,
  );
  const acceptedAuthKinds = [...binding.authKinds];
  for (const kind of acceptedAuthKinds) {
    if (!authKinds.has(kind)) {
      throw new Error(`provider plugin surface ${binding.surfaceId} accepts unsupported auth kind ${String(kind)}`);
    }
  }
  if (new Set(acceptedAuthKinds).size !== acceptedAuthKinds.length) {
    throw new Error(`provider plugin surface ${binding.surfaceId} repeats an auth kind`);
  }
  acceptedAuthKinds.sort();
  if (
    binding.transport === "provider-api"
    && (acceptedAuthKinds.length !== 1 || acceptedAuthKinds[0] !== "oauth-token-file")
  ) {
    throw new Error(`provider plugin surface ${binding.surfaceId} provider-api auth must be oauth-token-file`);
  }
  if (
    binding.transport === "linked-device"
    && (acceptedAuthKinds.length !== 1 || acceptedAuthKinds[0] !== "linked-device-store")
  ) {
    throw new Error(`provider plugin surface ${binding.surfaceId} linked-device auth must be linked-device-store`);
  }
  if (
    binding.transport === "web-session-api"
    && acceptedAuthKinds.some((kind) => kind === "oauth-token-file" || kind === "linked-device-store")
  ) {
    throw new Error(`provider plugin surface ${binding.surfaceId} web-session-api auth must use browser-session credentials`);
  }
  const localCliTool = binding.transport === "local-cli"
    ? parseLocalCliToolIdentityV1(binding.tool)
    : undefined;
  requireBoundedNonEmptyArray(
    binding.operations,
    `provider plugin surface ${binding.surfaceId} operations`,
    MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING,
  );
  const operations = [...binding.operations].map((operation) =>
    freezeOperation(operation, binding.transport, sourceKind));
  operations.sort((left, right) =>
    left.name.localeCompare(right.name) || left.contractVersion - right.contractVersion);
  const operationKeys = operations.map((operation) =>
    `${operation.name}@${operation.contractVersion}`);
  if (new Set(operationKeys).size !== operationKeys.length) {
    throw new Error(`provider plugin surface ${binding.surfaceId} repeats an exact operation contract`);
  }
  const messaging = freezeProviderPluginMessaging(
    binding.messaging,
    operations,
    binding.surfaceId,
  );
  if (
    typeof binding.subject !== "object"
    || binding.subject === null
    || typeof binding.subject.format !== "string"
    || binding.subject.format.length < 1
    || typeof binding.subject.matches !== "function"
  ) {
    throw new Error(`provider plugin surface ${binding.surfaceId} must declare a subject matcher`);
  }
  requireExactKeys(binding.subject, ["format", "matches"], "provider plugin subject");
  if (
    typeof binding.runtime !== "object"
    || binding.runtime === null
    || typeof binding.runtime.loadRuntime !== "function"
  ) {
    throw new Error(`provider plugin surface ${binding.surfaceId} must declare a lazy runtime loader`);
  }
  const common = {
    surfaceId: binding.surfaceId,
    origin: binding.origin,
    manifestOrigins: Object.freeze(manifestOrigins),
    protectedHostnameFamilies: Object.freeze(
      protectedHostnameFamilies.sort(),
    ),
    authKinds: Object.freeze(acceptedAuthKinds),
    ...(messaging === undefined ? {} : { messaging }),
  };
  if (binding.transport === "provider-api") {
    requireExactKeys(binding.runtime, ["loadRuntime"], "provider plugin runtime hooks");
    const loadRuntime = binding.runtime.loadRuntime;
    const result: ProviderApiPluginBindingV1 = Object.freeze({
      ...common,
      transport: "provider-api",
      runtimeOrigins: Object.freeze(runtimeOrigins),
      operations: Object.freeze(operations) as readonly ProviderApiPluginOperationV1[],
      subject: Object.freeze({ ...binding.subject }),
      loadRuntime,
      execute: async (context: ProviderActionContext) =>
        (await loadRuntime()).execute(context),
      ...(messaging?.action.state === "supported"
        ? {
            executeMessagingPart: async (
              operation: string,
              input: OperationInput,
              auth: WrenchAuth,
              attempt: ProviderPluginMessagingActionAttemptV1,
            ) => {
              const hook = (await loadRuntime()).executeMessagingPart;
              if (hook === undefined) {
                throw new Error(
                  `provider plugin surface ${binding.surfaceId} declared messaging actions without a runtime hook`,
                );
              }
              return hook(operation, input, auth, attempt);
            },
          }
        : {}),
    });
    return result;
  }
  if (binding.transport === "local-cli") {
    requireExactKeys(binding.runtime, ["loadRuntime"], "local CLI plugin runtime hooks");
    const loadRuntime = binding.runtime.loadRuntime;
    const reconciles = operations.some(
      (operation) => operation.reconciliation !== undefined,
    );
    const reconcile: NonNullable<LocalCliPluginRuntimeV1["reconcile"]> = async (
      operationName,
      input,
      auth,
      context,
      options,
    ) => {
      const selectedOperation = operations.find((operation) =>
        operation.name === operationName
        && operation.reconciliation !== undefined);
      if (selectedOperation === undefined) {
        throw new Error(
          `provider plugin surface ${binding.surfaceId} has no reconciliation contract for ${operationName}`,
        );
      }
      const reconciliationKind = selectedOperation.reconciliation?.kind;
      const reconciliationContext =
        reconciliationKind === "provider-accepted-target-presence"
          || reconciliationKind === "provider-bound-target-desired-state"
          ? (() => {
              const parsed = parseProviderPluginReconciliationContextV1(context);
              if (parsed.kind !== reconciliationKind) {
                throw new Error(
                  `provider plugin surface ${binding.surfaceId} reconciliation target context kind changed`,
                );
              }
              return parsed;
            })()
          : (() => {
              if (context !== undefined) {
                throw new Error(
                  `provider plugin surface ${binding.surfaceId} boolean reconciliation does not accept target context`,
                );
              }
              return undefined;
            })();
      const hook = (await loadRuntime()).reconcile;
      if (hook === undefined) {
        throw new Error(
          `provider plugin surface ${binding.surfaceId} declared reconciliation without a runtime hook`,
        );
      }
      const value = await hook(
        operationName,
        input,
        auth,
        reconciliationContext,
        options,
      );
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("provider plugin reconciliation returned an invalid readback");
      }
      requireExactKeys(
        value,
        ["actualState", "reason"],
        "provider plugin reconciliation readback",
      );
      if (
        typeof value.actualState !== "boolean"
        || typeof value.reason !== "string"
        || value.reason.length < 1
        || value.reason.length > 200
      ) {
        throw new Error("provider plugin reconciliation returned an invalid readback");
      }
      return Object.freeze({
        actualState: value.actualState,
        reason: value.reason,
      });
    };
    const result: LocalCliPluginBindingV1 = Object.freeze({
      ...common,
      transport: "local-cli",
      tool: localCliTool!,
      operations: Object.freeze(operations) as readonly LocalCliPluginOperationV1[],
      loadRuntime,
      subject: Object.freeze({
        ...binding.subject,
        probe: async (
          auth: WrenchAuth,
          options?: ProviderPluginSubjectProbeOptionsV1,
        ) => {
          const subject = await (await loadRuntime()).probe(auth, options);
          if (
            typeof subject !== "string"
            || !binding.subject.matches(subject)
          ) {
            throw new Error(
              `provider plugin surface ${binding.surfaceId} returned a subject outside ${binding.subject.format}`,
            );
          }
          return subject;
        },
      }),
      inspect: async (environment, options) => {
        let artifact: LocalCliToolArtifactIdentityV1;
        try {
          artifact = localCliToolArtifactForCurrentRuntime(localCliTool!);
        } catch {
          return Object.freeze({
            ready: false,
            platform: process.platform,
            arch: process.arch,
            version: null,
            executableSha256: null,
            reason: `unsupported-runtime:${process.platform}/${process.arch}`,
          });
        }
        const cleanupFilesystem = inspectLocalCliCleanupFilesystemReadiness();
        if (!cleanupFilesystem.ready) {
          return Object.freeze({
            ready: false,
            platform: process.platform,
            arch: process.arch,
            version: null,
            executableSha256: null,
            reason: cleanupFilesystem.reason,
          });
        }
        const [ready, platform, arch, version, executableSha256, reason] =
          snapshotExactEnumerableDataProperties(
            await (await loadRuntime()).inspect(environment, options),
            [
              "ready",
              "platform",
              "arch",
              "version",
              "executableSha256",
              "reason",
            ],
            "local CLI runtime inspection status",
          );
        if (
          typeof ready !== "boolean"
          || typeof platform !== "string"
          || platform !== process.platform
          || typeof arch !== "string"
          || arch !== process.arch
          || (version !== null && (
            typeof version !== "string"
            || version.length < 1
            || version.length > 128
            || /[\u0000-\u001f\u007f-\u009f]/u.test(version)
            || hasUnpairedSurrogate(version)
          ))
          || (executableSha256 !== null && (
            typeof executableSha256 !== "string"
            || !/^[a-f0-9]{64}$/u.test(executableSha256)
          ))
          || (reason !== null && (
            typeof reason !== "string"
            || reason.length < 1
            || reason.length > 500
            || /[\u0000-\u001f\u007f-\u009f]/u.test(reason)
            || hasUnpairedSurrogate(reason)
          ))
          || (ready && (
            version !== localCliTool!.version
            || executableSha256 !== artifact.executableSha256
            || reason !== null
          ))
          || (!ready && reason === null)
        ) {
          throw new Error("local CLI runtime inspection returned an invalid status");
        }
        return Object.freeze({
          ready,
          platform,
          arch,
          version,
          executableSha256,
          reason,
        });
      },
      execute: async (manifest, recipe, input, auth, options) =>
        (await loadRuntime()).execute(manifest, recipe, input, auth, options),
      ...(messaging?.action.state === "supported"
        ? {
            executeMessagingPart: async (
              operation: string,
              input: OperationInput,
              auth: WrenchAuth,
              attempt: ProviderPluginMessagingActionAttemptV1,
            ) => {
              const hook = (await loadRuntime()).executeMessagingPart;
              if (hook === undefined) {
                throw new Error(
                  `provider plugin surface ${binding.surfaceId} declared messaging actions without a runtime hook`,
                );
              }
              return hook(operation, input, auth, attempt);
            },
          }
        : {}),
      ...(reconciles ? { reconcile } : {}),
    });
    return result;
  }
  requireExactKeys(binding.runtime, ["loadRuntime"], "web-session plugin runtime hooks");
  const loadRuntime = binding.runtime.loadRuntime;
  const execute: WebSessionOperationExecutor = async (
    manifest,
    recipe,
    input,
    auth,
    options,
  ) => (await loadRuntime()).execute(manifest, recipe, input, auth, options);
  const hasPublicOperations = operations.some(
    (operation) => operation.access === "public",
  );
  const executePublic: PublicWebSessionOperationExecutor = async (
    manifest,
    recipe,
    input,
    options,
  ) => {
    const runtime = await loadRuntime();
    if (runtime.executePublic === undefined) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} is missing its reviewed public runtime hook`,
      );
    }
    return runtime.executePublic(manifest, recipe, input, options);
  };
  const reconciles = operations.some(
    (operation) => operation.reconciliation !== undefined,
  );
  const reconcile: NonNullable<WebSessionPluginRuntimeV1["reconcile"]> = async (
    operationName,
    input,
    auth,
    context,
  ) => {
    const selectedOperation = operations.find((operation) =>
      operation.name === operationName
      && operation.reconciliation !== undefined);
    if (selectedOperation === undefined) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} has no reconciliation contract for ${operationName}`,
      );
    }
    const reconciliationKind = selectedOperation.reconciliation?.kind;
    const reconciliationContext =
      reconciliationKind === "provider-accepted-target-presence"
        || reconciliationKind === "provider-bound-target-desired-state"
        ? (() => {
            const parsed = parseProviderPluginReconciliationContextV1(context);
            if (parsed.kind !== reconciliationKind) {
              throw new Error(
                `provider plugin surface ${binding.surfaceId} reconciliation target context kind changed`,
              );
            }
            return parsed;
          })()
        : (() => {
            if (context !== undefined) {
              throw new Error(
                `provider plugin surface ${binding.surfaceId} boolean reconciliation does not accept target context`,
              );
            }
            return undefined;
          })();
    const hook = (await loadRuntime()).reconcile;
    if (hook === undefined) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} declared reconciliation without a runtime hook`,
      );
    }
    const value = await hook(
      operationName,
      input,
      auth,
      reconciliationContext,
    );
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
    ) {
      throw new Error("provider plugin reconciliation returned an invalid readback");
    }
    requireExactKeys(
      value,
      ["actualState", "reason"],
      "provider plugin reconciliation readback",
    );
    if (
      typeof value.actualState !== "boolean"
      || typeof value.reason !== "string"
      || value.reason.length < 1
      || value.reason.length > 200
    ) {
      throw new Error("provider plugin reconciliation returned an invalid readback");
    }
    return Object.freeze({
      actualState: value.actualState,
      reason: value.reason,
    });
  };
  let linkedDeviceLifecycle:
    | ProviderPluginLinkedDeviceLifecycleRuntimeV1
    | undefined;
  if (binding.transport === "linked-device") {
    const declaration = binding.linkedDeviceLifecycle;
    if (declaration !== undefined) {
      requireExactKeys(
        declaration,
        ["inspect", "pair", "syncOnce"],
        "linked-device plugin lifecycle",
      );
      if (
        declaration.inspect !== true
        || declaration.pair !== true
        || declaration.syncOnce !== true
      ) {
        throw new Error(
          `provider plugin surface ${binding.surfaceId} has an invalid linked-device lifecycle declaration`,
        );
      }
      const requireLifecycle = async ():
        Promise<ProviderPluginLinkedDeviceLifecycleRuntimeV1> => {
        const lifecycle = (await loadRuntime()).linkedDeviceLifecycle;
        if (lifecycle === undefined) {
          throw new Error(
            `provider plugin surface ${binding.surfaceId} declared linked-device lifecycle capabilities without runtime hooks`,
          );
        }
        return lifecycle;
      };
      linkedDeviceLifecycle = Object.freeze({
        inspect: async (environment) => {
          const value = await (await requireLifecycle()).inspect(environment);
          if (
            typeof value !== "object"
            || value === null
            || Array.isArray(value)
          ) {
            throw new Error("linked-device lifecycle inspection returned invalid status");
          }
          const keys = [
            "ready",
            "implementation",
            "version",
            "integrity",
            ...(value.setupCommand === undefined ? [] : ["setupCommand"]),
          ];
          requireExactKeys(
            value,
            keys,
            "linked-device lifecycle inspection status",
          );
          if (
            typeof value.ready !== "boolean"
            || typeof value.implementation !== "string"
            || value.implementation.length < 1
            || typeof value.version !== "string"
            || value.version.length < 1
            || typeof value.integrity !== "string"
            || value.integrity.length < 1
            || (
              value.setupCommand !== undefined
              && (
                typeof value.setupCommand !== "string"
                || value.setupCommand.length < 1
              )
            )
          ) {
            throw new Error("linked-device lifecycle inspection returned invalid status");
          }
          return Object.freeze({ ...value });
        },
        pair: async (auth, options) => {
          const subject = await (await requireLifecycle()).pair(auth, options);
          if (
            typeof subject !== "string"
            || !binding.subject.matches(subject)
          ) {
            throw new Error("linked-device lifecycle pairing returned an invalid subject");
          }
          return subject;
        },
        syncOnce: async (auth, options) => {
          const value = await (await requireLifecycle()).syncOnce(auth, options);
          if (
            typeof value !== "object"
            || value === null
            || Array.isArray(value)
          ) {
            throw new Error("linked-device lifecycle sync returned an invalid result");
          }
          requireExactKeys(
            value,
            ["itemsStored", "projection", "emitsProtocolAcknowledgements"],
            "linked-device lifecycle sync result",
          );
          if (
            !Number.isSafeInteger(value.itemsStored)
            || value.itemsStored < 0
            || typeof value.projection !== "string"
            || value.projection.length < 1
            || value.emitsProtocolAcknowledgements !== true
          ) {
            throw new Error("linked-device lifecycle sync returned an invalid result");
          }
          return Object.freeze({ ...value });
        },
      });
    }
  }
  const result: WebSessionApiPluginBindingV1 | LinkedDevicePluginBindingV1 =
    Object.freeze({
    ...common,
    transport: binding.transport,
    operations: Object.freeze(operations) as readonly WebSessionPluginOperationV1[],
    loadRuntime,
    subject: Object.freeze({
      ...binding.subject,
      probe: async (
        auth: WrenchAuth,
        options?: ProviderPluginSubjectProbeOptionsV1,
      ) => {
        const subject = await (await loadRuntime()).probe(auth, options);
        if (
          typeof subject !== "string"
          || !binding.subject.matches(subject)
        ) {
          throw new Error(
            `provider plugin surface ${binding.surfaceId} returned a subject outside ${binding.subject.format}`,
          );
        }
        return subject;
      },
    }),
    execute,
    ...(messaging?.action.state === "supported"
      ? {
          executeMessagingPart: async (
            operation: string,
            input: OperationInput,
            auth: WrenchAuth,
            attempt: ProviderPluginMessagingActionAttemptV1,
          ) => {
            const hook = (await loadRuntime()).executeMessagingPart;
            if (hook === undefined) {
              throw new Error(
                `provider plugin surface ${binding.surfaceId} declared messaging actions without a runtime hook`,
              );
            }
            return hook(operation, input, auth, attempt);
          },
        }
      : {}),
    ...(hasPublicOperations ? { executePublic } : {}),
    ...(reconciles ? { reconcile } : {}),
    ...(linkedDeviceLifecycle === undefined ? {} : { linkedDeviceLifecycle }),
  });
  return result;
}

/**
 * Validate and deeply freeze one trusted source plugin definition.
 *
 * V1 intentionally accepts only statically imported metadata. Runtime hooks
 * must remain behind a lazy loader; executable plugin code is not sandboxed.
 */
export function defineProviderPlugin(
  plugin: ProviderPluginDefinitionV1,
): ProviderPluginV1 {
  requireExactKeys(
    plugin,
    [
      "apiVersion",
      "id",
      "version",
      "displayName",
      "sourceKind",
      "implementationSources",
      "bindings",
    ],
    "provider plugin",
  );
  if (plugin.apiVersion !== PROVIDER_PLUGIN_API_VERSION) {
    throw new Error(`provider plugin ${String(plugin.id)} uses unsupported API version ${String(plugin.apiVersion)}`);
  }
  if (!isProviderPluginId(plugin.id)) {
    throw new Error("provider plugin ID must be strict lowercase kebab-case with at most 63 characters");
  }
  if (!pluginVersionPattern.test(plugin.version)) {
    throw new Error(`provider plugin ${plugin.id} must declare a semantic version`);
  }
  if (typeof plugin.displayName !== "string" || plugin.displayName.length < 1 || plugin.displayName.length > 100) {
    throw new Error(`provider plugin ${plugin.id} must declare a display name`);
  }
  if (plugin.sourceKind !== "built-in" && plugin.sourceKind !== "source") {
    throw new Error(`provider plugin ${plugin.id} has an unsupported source kind`);
  }
  requireBoundedNonEmptyArray(
    plugin.implementationSources,
    `provider plugin ${plugin.id} implementationSources`,
    MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES,
  );
  const sources = [...plugin.implementationSources].map((source) => {
    requireExactKeys(source, ["label", "url"], `provider plugin ${plugin.id} implementation source`);
    if (!sourceLabelPattern.test(source.label) || source.label.includes("..") || source.label.startsWith("/")) {
      throw new Error(`provider plugin ${plugin.id} has an unsafe implementation source label`);
    }
    const localFileProtocol = ["file", ":"].join("");
    if (!(source.url instanceof URL) || source.url.protocol !== localFileProtocol) {
      throw new Error(`provider plugin ${plugin.id} implementation sources must be file URLs`);
    }
    let stats: ReturnType<typeof lstatSync>;
    let realPath: string;
    try {
      const path = fileURLToPath(source.url);
      stats = lstatSync(path);
      realPath = realpathSync(path);
    } catch {
      throw new Error(`provider plugin ${plugin.id} implementation source ${source.label} is unreadable`);
    }
    const relativePath = relative(providerPluginSourceRoot, realPath);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || relativePath === ""
      || relativePath.startsWith("..")
      || isAbsolute(relativePath)
    ) {
      throw new Error(
        `provider plugin ${plugin.id} implementation source ${source.label} must be a regular file under the Wrench source root`,
      );
    }
    return Object.freeze({ label: source.label, path: realPath });
  });
  sources.sort((left, right) => left.label.localeCompare(right.label));
  if (new Set(sources.map((source) => source.label)).size !== sources.length) {
    throw new Error(`provider plugin ${plugin.id} repeats an implementation source label`);
  }
  if (!sources.some((source) => source.label === "plugin.ts")) {
    throw new Error(`provider plugin ${plugin.id} must bind its plugin.ts implementation source`);
  }
  requireBoundedNonEmptyArray(
    plugin.bindings,
    `provider plugin ${plugin.id} bindings`,
    MAX_PROVIDER_PLUGIN_BINDINGS,
  );
  let operationCount = 0;
  for (const binding of plugin.bindings) {
    requireBoundedNonEmptyArray(
      binding.operations,
      `provider plugin surface ${String(binding.surfaceId)} operations`,
      MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING,
    );
    operationCount += binding.operations.length;
    if (operationCount > MAX_PROVIDER_PLUGIN_OPERATIONS) {
      throw new Error(
        `provider plugin ${plugin.id} may declare at most ${MAX_PROVIDER_PLUGIN_OPERATIONS} operations`,
      );
    }
  }
  const bindings = [...plugin.bindings].map((binding) =>
    freezeBinding(binding, plugin.sourceKind));
  for (const binding of bindings) {
    if (!providerPluginLazyRuntimeLoaders.has(binding.loadRuntime)) {
      throw new Error(
        `provider plugin ${plugin.id} runtime must use the branded lazy runtime helper`,
      );
    }
  }
  bindings.sort((left, right) =>
    left.transport.localeCompare(right.transport) || left.surfaceId.localeCompare(right.surfaceId));
  const result = Object.freeze({
    ...plugin,
    implementationSources: Object.freeze(sources),
    bindings: Object.freeze(bindings),
  });
  const evaluationIdentity = captureProviderPluginEvaluationIdentity(
    plugin.id,
    sources,
  );
  providerPluginEvaluationSourceDigests.set(
    result,
    evaluationIdentity.sourceDigests,
  );
  providerPluginEvaluationInstalledPackageDigests.set(
    result,
    evaluationIdentity.installedPackageDigests,
  );
  validatedProviderPlugins.add(result);
  return result;
}

function freezePortableManifestValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) freezePortableManifestValue(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezePortableManifestValue(entry);
  }
  return Object.freeze(value);
}

/**
 * Project one already verified, content-addressed portable package into the
 * same logical registry shape as trusted source plugins.
 *
 * This does not trust package code in-process. Every runtime hook supplied by
 * the caller must be a kernel-owned wrapper around the portable child host.
 */
export function definePortableProviderPluginProjection(
  plugin: PortableProviderPluginProjectionDefinitionV1,
): ProviderPluginV1 {
  const [
    apiVersion,
    id,
    version,
    displayName,
    sourceKind,
    packageValue,
    rawBindings,
  ] = snapshotExactEnumerableDataProperties(
    plugin,
    [
      "apiVersion",
      "id",
      "version",
      "displayName",
      "sourceKind",
      "package",
      "bindings",
    ],
    "portable provider plugin projection",
  );
  if (
    apiVersion !== PROVIDER_PLUGIN_API_VERSION
    || sourceKind !== "portable"
    || !isProviderPluginId(id)
    || typeof version !== "string"
    || !pluginVersionPattern.test(version)
    || typeof displayName !== "string"
    || displayName.length < 1
    || displayName.length > 160
    || !isVerifiedPortableProviderPluginPackage(packageValue)
    || packageValue.manifest.id !== id
    || packageValue.manifest.version !== version
    || packageValue.manifest.displayName !== displayName
    || packageValue.manifest.hostApiVersion !== 1
  ) {
    throw new Error("portable provider plugin projection identity is invalid");
  }
  const portablePackage = Object.freeze({
    hostApiVersion: packageValue.manifest.hostApiVersion,
    bundleSha256: packageValue.bundleSha256,
    manifestSha256: packageValue.manifestSha256,
    capabilities: packageValue.manifest.capabilities,
  });
  const bindings = snapshotBoundedDenseArray(
    rawBindings,
    `portable provider plugin ${id} bindings`,
    MAX_PROVIDER_PLUGIN_BINDINGS,
  );
  let portableOperationCount = 0;
  const adapterIds = new Set<string>();
  const projected = bindings.map((rawEntry, index) => {
    const [
      adapterIdValue,
      manifestValue,
      portableBindingValue,
      bindingValue,
    ] = snapshotExactEnumerableDataProperties(
      rawEntry,
      ["adapterId", "manifest", "portableBinding", "binding"],
      `portable provider plugin ${id} binding projection ${index}`,
    );
    if (
      typeof adapterIdValue !== "string"
      || !/^[a-z][a-z0-9-]{0,47}$/u.test(adapterIdValue)
    ) {
      throw new Error(
        `portable provider plugin ${id} binding projection ${index} adapterId must be lowercase kebab-case with at most 48 characters`,
      );
    }
    if (adapterIds.has(adapterIdValue)) {
      throw new Error(
        `portable provider plugin ${id} repeats adapter ID ${adapterIdValue}`,
      );
    }
    if (
      typeof manifestValue !== "object"
      || manifestValue === null
      || typeof portableBindingValue !== "object"
      || portableBindingValue === null
      || typeof bindingValue !== "object"
      || bindingValue === null
    ) {
      throw new Error(
        `portable provider plugin ${id} has an invalid binding projection at index ${index}`,
      );
    }
    const adapterId = adapterIdValue;
    const manifest = manifestValue as WrenchManifest;
    const portableBinding =
      portableBindingValue as PortablePackageBindingV1;
    const bindingDefinition =
      bindingValue as ProviderPluginBindingDefinitionV1;
    if (bindingDefinition.transport === "local-cli") {
      throw new Error(
        `portable provider plugin ${id} cannot project a source-only local-cli binding`,
      );
    }
    adapterIds.add(adapterId);
    assertKernelPortableProviderPluginBindingProjection(
      bindingDefinition,
      packageValue,
      portableBinding,
      adapterId,
      manifest,
    );
    const binding = freezeBinding(bindingDefinition, "portable");
    if (binding.operations.length > MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING) {
      throw new Error(
        `provider plugin surface ${binding.surfaceId} operations may contain at most ${MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING} items`,
      );
    }
    portableOperationCount += binding.operations.length;
    if (portableOperationCount > MAX_PROVIDER_PLUGIN_OPERATIONS) {
      throw new Error(
        `portable provider plugin ${id} may declare at most ${MAX_PROVIDER_PLUGIN_OPERATIONS} operations`,
      );
    }
    const operationNames = Object.keys(manifest.operations).sort();
    const bindingOperationNames = binding.operations
      .map((operation) => operation.name)
      .sort();
    const expectedSchema = binding.transport === "provider-api" ? 3 : 4;
    if (
      portableBinding.adapterId !== adapterId
      || portableBinding.transport !== binding.transport
      || portableBinding.surfaceId !== binding.surfaceId
      || portableBinding.origin !== binding.origin
      || portableBinding.subject.format !== binding.subject.format
      || portableBinding.authKinds.length !== binding.authKinds.length
      || portableBinding.authKinds.some(
        (kind, index) => kind !== binding.authKinds[index],
      )
      || manifest.id !== adapterId
      || manifest.schemaVersion !== expectedSchema
      || manifest.surfaceId !== binding.surfaceId
      || manifest.origins.length !== binding.manifestOrigins.length
      || manifest.origins.some(
        (origin, index) => origin !== binding.manifestOrigins[index],
      )
      || operationNames.length !== bindingOperationNames.length
      || operationNames.some(
        (operation, index) => operation !== bindingOperationNames[index],
      )
    ) {
      throw new Error(
        `portable provider plugin ${id} adapter ${adapterId} does not match its binding`,
      );
    }
    const operationIdentities = new Map<
      string,
      PortableOperationIdentityV1
    >();
    for (const operation of binding.operations) {
      if (
        operation.contractVersions.length !== 1
        || operation.contractVersions[0] !== operation.contractVersion
      ) {
        throw new Error(
          `portable provider plugin ${id} operation ${operation.name} must own one current contract version`,
        );
      }
      const portableOperation = portableBinding.operations.find(
        (candidate) =>
          candidate.name === operation.name
          && candidate.contractVersion === operation.contractVersion,
      );
      if (
        portableOperation === undefined
        || portableOperation.risk !== operation.risk
        || portableOperation.state !== operation.state
        || portableOperation.dispatch !== operation.dispatch
        || portableOperation.sideEffect !== operation.sideEffect
        || portableOperation.idempotency !== operation.idempotency
        || portableOperation.dedupeWindowMs !== operation.dedupeWindowMs
        || portableOperation.implementation !== operation.implementation
        || JSON.stringify(portableOperation.input)
          !== JSON.stringify(operation.input)
      ) {
        throw new Error(
          `portable provider plugin ${id} operation ${operation.name} metadata does not match its runtime projection`,
        );
      }
      const identity = createPortableOperationIdentityV1({
        package: {
          id,
          version,
          ...portablePackage,
        },
        binding: portableBinding,
        operation: portableOperation,
      });
      operationIdentities.set(
        `${operation.name}@${operation.contractVersion}`,
        identity,
      );
    }
    if (
      operationIdentities.size !== portableBinding.operations.length
    ) {
      throw new Error(
        `portable provider plugin ${id} binding operation metadata is incomplete`,
      );
    }
    const projectedManifest = freezePortableManifestValue(
      structuredClone(manifest),
    );
    portableProviderPluginAdapters.set(binding, Object.freeze({
      adapterId,
      manifest: projectedManifest,
    }));
    portableProviderPluginOperationIdentities.set(
      binding,
      Object.freeze(operationIdentities),
    );
    const subjectProbe = portableBinding.subject.probe;
    if (subjectProbe !== null) {
      const identity = operationIdentities.get(
        `${subjectProbe.operation}@${subjectProbe.contractVersion}`,
      );
      if (identity === undefined) {
        throw new Error(
          `portable provider plugin ${id} subject probe identity is missing`,
        );
      }
      portableProviderPluginSubjectProbeIdentities.set(binding, identity);
    }
    return binding;
  });
  projected.sort((left, right) =>
    left.transport.localeCompare(right.transport)
    || left.surfaceId.localeCompare(right.surfaceId));
  const result: ProviderPluginV1 = Object.freeze({
    apiVersion,
    id,
    version,
    displayName,
    sourceKind: "portable",
    implementationSources: Object.freeze([]),
    bindings: Object.freeze(projected),
  });
  validatedProviderPlugins.add(result);
  portableProviderPluginArtifacts.set(
    result,
    packageValue.bundleSha256,
  );
  return result;
}
