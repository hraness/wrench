import {
  providerContractDefinitions,
  type ProviderContract,
} from "./provider-contract-definitions";

const priorArticlePublish = providerContractDefinitions.x["articles.publish"];

const articlePublishV2 = Object.freeze({
  ...priorArticlePublish,
  contractVersion: 2,
  input: Object.freeze({
    ...priorArticlePublish.input,
    properties: Object.freeze({
      ...priorArticlePublish.input.properties,
      draft_only: Object.freeze({
        type: "boolean" as const,
        description: "When true, save the reviewed Article as a private draft and never call the publish endpoint",
        enum: Object.freeze([true] as const),
      }),
    }),
  }),
  implementation: "optional official image upload; POST /2/articles/draft; when draft_only is true stop with an unpublished draft, otherwise POST /2/articles/{id}/publish; account eligibility required",
}) satisfies ProviderContract;

/** Current X contracts plus the exact retained Article-publish v1 reader. */
export const xProviderContractDefinitions = Object.freeze([
  ...Object.values(providerContractDefinitions.x),
  articlePublishV2,
] satisfies readonly ProviderContract[]);
