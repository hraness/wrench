import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  webImplementationSources,
  webSessionContractOperations,
} from "../../provider-plugin-builtins";
import { CLASIFICADOS_LISTINGS_SEARCH_CONTRACT } from "../../providers/clasificados-web";

const operations = webSessionContractOperations(
  [CLASIFICADOS_LISTINGS_SEARCH_CONTRACT],
  "689290bbaf7b3ddd83ca48f22c33008ae1bb2ffed2f5aa89fd3a77aed873d298",
).map((operation) => Object.freeze({
  ...operation,
  access: "public" as const,
}));

export const clasificadosWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "clasificados-web",
  version: "1.0.0",
  displayName: "ClasificadosOnline Public Rental Listings",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/read-failure.ts", "../../providers/read-failure.ts"],
    ["providers/rental-listings.ts", "../../providers/rental-listings.ts"],
    ["providers/clasificados-web.ts", "../../providers/clasificados-web.ts"],
    ["providers/clasificados-web-runtime.ts", "../../providers/clasificados-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "clasificados",
    origin: "https://www.clasificadosonline.com",
    manifestOrigins: ["https://www.clasificadosonline.com"],
    protectedHostnameFamilies: ["www.clasificadosonline.com"],
    authKinds: ["browser-profile"],
    operations,
    subject: {
      format: "clasificados:public",
      matches: (value) => value === "clasificados:public",
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/clasificados-web-runtime");
      return {
        probe: runtime.probeClasificadosWebSubject,
        execute: runtime.executeClasificadosAuthenticatedOperation,
        executePublic: (_manifest, recipe, input, options) => {
          if (recipe.action !== "listings.search") {
            return Promise.reject(
              new Error("Clasificados public operation is not installed"),
            );
          }
          return runtime.executeClasificadosPublicListingsSearch(
            recipe,
            input,
            undefined,
            options.operationDeadline,
          );
        },
      };
    }),
  }],
});

export default clasificadosWebPlugin;
