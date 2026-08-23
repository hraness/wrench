import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  browserSessionAuthKinds,
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";
import {
  isCanonicalMetaNumericId,
  type MetaWebSite,
} from "../../providers/meta-web";
import { materializeInstagramMessagingList } from "../../providers/meta-omni";

function metaOmniDefinitions(site: MetaWebSite) {
  if (site === "facebook-group") return Object.freeze({});
  return Object.freeze({
    "messaging.list": Object.freeze({
      ...(site === "instagram"
        ? {
            state: "supported" as const,
            schemaVersion: 1 as const,
            materializerId: "instagram-messaging-list",
            materializerVersion: 2,
            materialize: materializeInstagramMessagingList,
          }
        : {
            state: "unsupported" as const,
            reason: `${site} messaging list semantics remain capture-required`,
          }),
    }),
    "messaging.read": Object.freeze({
      state: "unsupported" as const,
      reason: `${site} message reads remain capture-required`,
    }),
  });
}

const metaWebSites = Object.freeze([
  "instagram",
  "threads",
  "facebook",
  "facebook-page",
  "facebook-group",
  "facebook-marketplace",
] as const satisfies readonly MetaWebSite[]);

const origins = {
  instagram: "https://www.instagram.com",
  threads: "https://www.threads.com",
  facebook: "https://www.facebook.com",
  "facebook-page": "https://www.facebook.com",
  "facebook-group": "https://www.facebook.com",
  "facebook-marketplace": "https://www.facebook.com",
} as const satisfies Readonly<Record<MetaWebSite, `https://${string}`>>;

const protectedHostnameFamilies = {
  instagram: ["instagram.com"],
  threads: ["threads.com"],
  facebook: ["facebook.com"],
  "facebook-page": ["facebook.com"],
  "facebook-group": ["facebook.com"],
  "facebook-marketplace": ["facebook.com"],
} as const satisfies Readonly<Record<MetaWebSite, readonly string[]>>;

const subjectFormats = {
  instagram: "instagram:<numeric-id>",
  threads: "threads:<numeric-id>",
  facebook: "facebook:user:<numeric-id>",
  "facebook-page": "facebook:user:<numeric-id>",
  "facebook-group": "facebook:user:<numeric-id>",
  "facebook-marketplace": "facebook:user:<numeric-id>",
} as const satisfies Readonly<Record<MetaWebSite, string>>;

function subjectMatches(site: MetaWebSite, value: string): boolean {
  const prefix = site === "instagram"
    ? "instagram:"
    : site === "threads"
      ? "threads:"
      : "facebook:user:";
  return value.startsWith(prefix)
    && isCanonicalMetaNumericId(value.slice(prefix.length));
}

const historicalVersions = Object.freeze({
  instagram: Object.freeze({
    "comments.read": Object.freeze([1]),
    "feeds.read": Object.freeze([1]),
    "messaging.list": Object.freeze([1]),
  }),
  threads: Object.freeze({
    "feeds.read": Object.freeze([1]),
    "posts.publish": Object.freeze([1, 2, 3, 4]),
  }),
  facebook: Object.freeze({
    "feeds.read": Object.freeze([1]),
    "messaging.list": Object.freeze([1]),
  }),
  "facebook-page": Object.freeze({}),
  "facebook-group": Object.freeze({
    "feeds.read": Object.freeze([1]),
  }),
  "facebook-marketplace": Object.freeze({
    "feeds.read": Object.freeze([1]),
    "listings.read": Object.freeze([1]),
  }),
} satisfies Readonly<
  Record<MetaWebSite, Readonly<Record<string, readonly number[]>>>
>);

const contractSemanticIdentities = Object.freeze({
  instagram: "3e2f5a7d655030588754ffe64141f4108e76c57f227fe903549ba192f1735c68",
  threads: "04b95f200d512ef150043986fea9a106a401c5b7a2ba501cd454983edcacb00a",
  facebook: "f4724c9619794070da784d03fdaef5889cc4f3d237f9f402e9d5a53f7c156184",
  "facebook-page": "0a13cbe416286efe003ecf9c28fefcbd45c5d1f3b62a94936d9278ad8e488ada",
  "facebook-group": "30717a546b60658ecc2e199a14babb4fa2b46afd1e8d9113044a1b7afda3d376",
  "facebook-marketplace": "396567380895c017c3385048b4c6971e68be82f446fab052f1605d52934ee4cd",
} as const satisfies Readonly<Record<MetaWebSite, string>>);

export const metaWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "meta-web",
  version: "1.2.0",
  displayName: "Meta Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/cursor-token.ts", "../../cursor-token.ts"],
    ["kernel/storage.ts", "../../storage.ts"],
    ["kernel/state-helper.ts", "../../state-helper.ts"],
    ["kernel/state-helper.bunfig.toml", "../../state-helper.bunfig.toml"],
    ["kernel/path-helper.ts", "../../path-helper.ts"],
    ["providers/iso-bmff.ts", "../../providers/iso-bmff.ts"],
    ["providers/meta-web.ts", "../../providers/meta-web.ts"],
    ["providers/meta-web-runtime.ts", "../../providers/meta-web-runtime.ts"],
    ["providers/meta-bootstrap.ts", "../../providers/meta-bootstrap.ts"],
    ["providers/meta-facebook-group.ts", "../../providers/meta-facebook-group.ts"],
    ["providers/meta-marketplace-relay.ts", "../../providers/meta-marketplace-relay.ts"],
    ["providers/meta-relay-bundle.ts", "../../providers/meta-relay-bundle.ts"],
    ["providers/meta-web-descriptors.ts", "../../providers/meta-web-descriptors.ts"],
    ["providers/contact-projection.ts", "../../providers/contact-projection.ts"],
    ["providers/meta-omni.ts", "../../providers/meta-omni.ts"],
  ]),
  bindings: metaWebSites.map((site) => ({
    transport: "web-session-api" as const,
    surfaceId: site,
    origin: origins[site],
    protectedHostnameFamilies: protectedHostnameFamilies[site],
    authKinds: browserSessionAuthKinds,
    operations: webSessionContractOperations(
      Object.values(webSessionContractDefinitions[site]),
      contractSemanticIdentities[site],
      historicalVersions[site],
      metaOmniDefinitions(site),
    ).map((operation) => site === "threads"
      && (operation.name === "posts.publish" || operation.name === "media.publish")
      ? Object.freeze({
          ...operation,
          reconciliation: Object.freeze({
            kind: "provider-accepted-target-presence" as const,
          }),
        })
      : operation),
    subject: {
      format: subjectFormats[site],
      matches: (value: string) => subjectMatches(site, value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/meta-web-runtime");
      return {
        probe: (auth, options) =>
          runtime.probeMetaWebSubject(site, auth, options),
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeMetaWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth, context) => {
          if (
            site !== "threads"
            || (operation !== "posts.publish" && operation !== "media.publish")
            || context?.kind !== "provider-accepted-target-presence"
          ) {
            throw new Error(`${site} ${operation} has no reconciliation hook`);
          }
          const readback = await runtime.readThreadsWebPublishedMutationTarget({
            site: "threads",
            action: operation,
            contractVersion: operation === "posts.publish" ? 5 : 1,
            timeoutMs: 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
          }, input, auth, context.target.identifier);
          return {
            actualState: readback.present,
            reason: "exact-target-readback",
          };
        },
      };
    }),
  })),
});

export default metaWebPlugin;
