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
import type { MetaWebSite } from "../../providers/meta-web";

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
  if (site === "instagram") return /^instagram:[0-9]{1,32}$/u.test(value);
  if (site === "threads") return /^threads:[0-9]{1,32}$/u.test(value);
  return /^facebook:user:[0-9]{1,32}$/u.test(value);
}

const historicalVersions = Object.freeze({
  instagram: Object.freeze({}),
  threads: Object.freeze({}),
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
  instagram: "d99d945f1735472c4dabe9c182f6a87aa8c5048456488de601d7da3550f9a742",
  threads: "da1a94589371ce2cbb13d1cbf4c903cc1284b633c744ce0291681ef291f83f59",
  facebook: "d6398bbc522567efb2dc0267a40fea785261621e0f4ca855a1c20a47b980e1f2",
  "facebook-page": "0a13cbe416286efe003ecf9c28fefcbd45c5d1f3b62a94936d9278ad8e488ada",
  "facebook-group": "30717a546b60658ecc2e199a14babb4fa2b46afd1e8d9113044a1b7afda3d376",
  "facebook-marketplace": "396567380895c017c3385048b4c6971e68be82f446fab052f1605d52934ee4cd",
} as const satisfies Readonly<Record<MetaWebSite, string>>);

export const metaWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "meta-web",
  version: "1.0.0",
  displayName: "Meta Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/cursor-token.ts", "../../cursor-token.ts"],
    ["kernel/storage.ts", "../../storage.ts"],
    ["kernel/state-helper.ts", "../../state-helper.ts"],
    ["kernel/state-helper.bunfig.toml", "../../state-helper.bunfig.toml"],
    ["kernel/path-helper.ts", "../../path-helper.ts"],
    ["providers/meta-web.ts", "../../providers/meta-web.ts"],
    ["providers/meta-web-runtime.ts", "../../providers/meta-web-runtime.ts"],
    ["providers/meta-bootstrap.ts", "../../providers/meta-bootstrap.ts"],
    ["providers/meta-facebook-group.ts", "../../providers/meta-facebook-group.ts"],
    ["providers/meta-marketplace-relay.ts", "../../providers/meta-marketplace-relay.ts"],
    ["providers/meta-relay-bundle.ts", "../../providers/meta-relay-bundle.ts"],
    ["providers/meta-web-descriptors.ts", "../../providers/meta-web-descriptors.ts"],
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
    ),
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
      };
    }),
  })),
});

export default metaWebPlugin;
