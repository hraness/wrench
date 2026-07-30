import type { WrenchAuth } from "./auth";
import type { ProviderContract } from "./provider-contract-definitions";
import type {
  FileInputValue,
  WrenchManifest,
  OperationInput,
  ProviderRecipe,
} from "./model";
import type {
  LoadedOAuthToken,
  OAuthTokenAuth,
  ProviderHttpClient,
} from "./provider-http";

export type ProviderExecution = {
  readonly status: "succeeded" | "failed" | "partial" | "indeterminate";
  readonly output: unknown;
  readonly finalUrl: string | null;
  readonly dispatchStarted: boolean;
  readonly dispatch: {
    readonly planned: number;
    readonly started: number;
    readonly verified: number;
  };
  readonly error?: string;
};

export type ProviderDispatchEvent = {
  readonly id: string;
  readonly index: number;
  readonly progress: ProviderExecution["dispatch"];
};

export type ProviderFile = {
  readonly value: FileInputValue;
  readonly path: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly sha256: string;
};

/**
 * Exact capability surface loaned to one trusted official-provider
 * implementation. This leaf is registry-free so the implementation cannot
 * acquire the host's process-global catalog through its context types.
 */
export type ProviderActionContext = {
  readonly manifest: WrenchManifest;
  readonly recipe: ProviderRecipe;
  readonly contract: ProviderContract;
  readonly input: OperationInput;
  readonly auth: OAuthTokenAuth;
  readonly token: LoadedOAuthToken;
  readonly http: ProviderHttpClient;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly remainingTimeMs: () => number;
  readonly resolveFiles: (inputName: string) => Promise<readonly ProviderFile[]>;
  readonly beginDispatch: () => Promise<{
    readonly verify: () => Promise<void>;
  }>;
  readonly dispatch: <T>(action: () => Promise<T>) => Promise<T>;
  readonly addRequiredScopes: (scopes: readonly string[]) => void;
  readonly setOutput: (value: unknown) => void;
  readonly setFinalUrl: (value: string) => void;
};

/** Compile-time proof that provider auth remains an owned Wrench auth variant. */
export type ProviderContextAuth = Extract<WrenchAuth, { readonly kind: "oauth-token-file" }>;
