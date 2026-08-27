import { describe, expect, test } from "bun:test";

import { providerPluginRegistry } from "./provider-plugins";
import { webSessionContractDefinitions } from "./web-session-contract-definitions";
import { BLUESKY_WEB_OPERATIONS } from "./providers/bluesky-web";
import { HACKER_NEWS_WEB_OPERATIONS } from "./providers/hacker-news-web";
import { LINKEDIN_WEB_OPERATIONS } from "./providers/linkedin-web";
import { META_WEB_OPERATIONS } from "./providers/meta-web";
import { REDDIT_WEB_OPERATIONS } from "./providers/reddit-web";
import { SUBSTACK_WEB_OPERATIONS } from "./providers/substack-web";
import { TIKTOK_WEB_OPERATIONS } from "./providers/tiktok-web";
import { WHATSAPP_WEB_OPERATIONS } from "./providers/whatsapp-web";

type OperationPolicy = {
  readonly risk: string;
  readonly state: string;
};

const providerOperationPolicies = {
  bluesky: BLUESKY_WEB_OPERATIONS,
  facebook: META_WEB_OPERATIONS.facebook,
  "facebook-group": META_WEB_OPERATIONS["facebook-group"],
  "facebook-marketplace": META_WEB_OPERATIONS["facebook-marketplace"],
  "facebook-page": META_WEB_OPERATIONS["facebook-page"],
  "hacker-news": HACKER_NEWS_WEB_OPERATIONS,
  instagram: META_WEB_OPERATIONS.instagram,
  linkedin: LINKEDIN_WEB_OPERATIONS,
  reddit: REDDIT_WEB_OPERATIONS,
  substack: SUBSTACK_WEB_OPERATIONS,
  tiktok: TIKTOK_WEB_OPERATIONS,
  threads: META_WEB_OPERATIONS.threads,
  whatsapp: WHATSAPP_WEB_OPERATIONS,
} as const satisfies Readonly<Record<
  string,
  Readonly<Record<string, OperationPolicy>>
>>;

describe("provider operation contract parity", () => {
  test("keeps every registered route aligned with its active contract state and risk", () => {
    for (const [site, definitions] of Object.entries(
      webSessionContractDefinitions,
    )) {
      const binding = providerPluginRegistry.resolveRoute("local-cli", site)
        ?? providerPluginRegistry.requireSessionRoute(site);
      const contracts = definitions as Readonly<Record<string, {
        readonly contractVersion: number;
        readonly risk: string;
        readonly state: string;
      }>>;
      const activeOperations = binding.operations.filter((operation) =>
        operation.contractVersion === contracts[operation.name]?.contractVersion
      );
      expect(activeOperations.map(({ name }) => name).sort()).toEqual(
        Object.keys(contracts).sort(),
      );
      for (const operation of activeOperations) {
        expect(operation).toMatchObject({
          contractVersion: contracts[operation.name]?.contractVersion,
          risk: contracts[operation.name]?.risk,
          state: contracts[operation.name]?.state,
        });
      }
    }
  });

  test("keeps provider-owned runtime policy maps exhaustive and canonical", () => {
    for (const [site, policies] of Object.entries(providerOperationPolicies)) {
      const contracts = webSessionContractDefinitions[
        site as keyof typeof webSessionContractDefinitions
      ] as Readonly<Record<string, OperationPolicy>>;
      expect(Object.keys(policies).sort()).toEqual(Object.keys(contracts).sort());
      for (const [operation, policy] of Object.entries(policies)) {
        expect(policy).toMatchObject({
          risk: contracts[operation]?.risk,
          state: contracts[operation]?.state,
        });
      }
    }
  });
});
