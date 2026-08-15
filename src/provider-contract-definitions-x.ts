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

const articlePublishV3 = Object.freeze({
  ...priorArticlePublish,
  contractVersion: 3,
}) satisfies ProviderContract;

const articleDraftSaveV1 = Object.freeze({
  ...priorArticlePublish,
  operation: "articles.draft.save",
  contractVersion: 1,
  risk: "R2",
  sideEffect: "Creates one private native X Article draft through the exact confirmed official API contract; it never publishes the draft.",
  implementation: "optional official image upload; POST /2/articles/draft; stop with one unpublished response-bound draft; account eligibility required",
}) satisfies ProviderContract;

/** Current X contracts plus the separate private Article-draft operation. */
export const xProviderContractDefinitions = Object.freeze([
  ...Object.values(providerContractDefinitions.x),
  articlePublishV2,
  articlePublishV3,
  articleDraftSaveV1,
] satisfies readonly ProviderContract[]);
