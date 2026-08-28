/**
 * Side-effect-free provider-plugin authoring surface.
 *
 * Complete package and runtime validation remains available through
 * `wrench plugin check` and the explicitly trusted `wrench plugin test`
 * boundary. Importing this module never loads provider runtimes or local
 * state.
 */
import {
  isPortableProviderPluginVersion as isPortableProviderPluginVersionImplementation,
  isProviderPluginId as isProviderPluginIdImplementation,
  isProviderPluginOperationName as isProviderPluginOperationNameImplementation,
  isProviderPluginSurfaceId as isProviderPluginSurfaceIdImplementation,
  PROVIDER_PLUGIN_ID_MAX_LENGTH as providerPluginIdMaxLength,
  PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH as providerPluginOperationNameMaxLength,
} from "./provider-plugin-identifiers";

export const PROVIDER_PLUGIN_ID_MAX_LENGTH = providerPluginIdMaxLength;
export const PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH =
  providerPluginOperationNameMaxLength;
export const isPortableProviderPluginVersion =
  isPortableProviderPluginVersionImplementation;
export const isProviderPluginId = isProviderPluginIdImplementation;
export const isProviderPluginOperationName =
  isProviderPluginOperationNameImplementation;
export const isProviderPluginSurfaceId =
  isProviderPluginSurfaceIdImplementation;

export type {
  ProviderPluginId,
  ProviderPluginOperationName,
  ProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";

export type {
  LocalCliPluginBindingDefinitionV1,
  LocalCliPluginOperationDefinitionV1,
  LocalCliPluginRuntimeHooksV1,
  LocalCliPluginRuntimeStatusV1,
  LocalCliPluginRuntimeV1,
  LinkedDevicePluginBindingDefinitionV1,
  PortableProviderPluginProjectionDefinitionV1,
  ProviderApiPluginBindingDefinitionV1,
  ProviderApiPluginOperationDefinitionV1,
  ProviderPluginAuthKind,
  ProviderPluginAcceptedTargetReconciliationContextV1,
  ProviderPluginBindingDefinitionV1,
  ProviderPluginContractStateV1,
  ProviderPluginDefinitionV1,
  ProviderPluginImplementationSourceDefinitionV1,
  ProviderPluginLinkedDeviceLifecycleRuntimeV1,
  ProviderPluginOmniDefinitionV1,
  ProviderPluginOperationDefinitionV1,
  ProviderPluginReconciliationDefinitionV1,
  ProviderPluginReconciliationContextV1,
  ProviderPluginReconciliationOptionsV1,
  ProviderPluginSubjectDefinitionV1,
  ProviderPluginTransport,
  WebSessionApiPluginBindingDefinitionV1,
  WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";

export {
  localCliToolArtifactForCurrentRuntime,
  parseLocalCliToolIdentityV1,
} from "./local-cli-tool-identity";

export type {
  LocalCliToolArtifactIdentityV1,
  LocalCliToolIdentityV1,
} from "./local-cli-tool-identity";

export type {
  LocalCliCleanupResourceIdentityV1,
  LocalCliPrivateRootIdentityV1,
  LocalCliProcessGroupIdentityV1,
  ProviderPluginCleanupResourceIdentity,
} from "./provider-plugin-cleanup-resource";

export {
  MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
  MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION,
  WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID,
  WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT,
  WRENCH_MESSAGING_CONTEXT_INSTANCE_V1_CONTRACT_ID,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT,
  createBeeperMessageLikeMeContextBindingV1,
  createWrenchMessagingReceiptBindingV1,
  messageLikeMeSourceConversationCoordinateBindingV1,
  parseMessageLikeMeSourceConversationCoordinateV1,
  parseWrenchMessagingClientIntentBindingV1,
  parseWrenchMessagingContextBindingV1,
  wrenchMessagingContextBindingSha256V1,
} from "./message-like-me-agentic-messaging";

export type {
  MessageLikeMeSourceConversationCoordinateBindingV1,
  MessageLikeMeSourceConversationCoordinateV1,
  WrenchMessagingClientIntentBindingV1,
  WrenchMessagingContextBindingV1,
  WrenchMessagingReceiptBindingV1,
  WrenchMessagingReceiptStateV1,
} from "./message-like-me-agentic-messaging";

export {
  startProviderPluginCleanupTrackedOperation,
} from "./provider-plugin-cleanup-execution";

export type {
  ProviderPluginCleanupBarrierRegistrar,
  ProviderPluginCleanupProofController,
  ProviderPluginCleanupResourcePublisher,
} from "./provider-plugin-cleanup-execution";

export type {
  LocalCliDispatchEvent,
  LocalCliExecution,
  LocalCliExecutionOptions,
  LocalCliFileResolver,
  LocalCliOperationDeadline,
  LocalCliOperationExecutor,
  LocalCliProviderAcceptedMutationTargetEvent,
  LocalCliProviderBoundMutationTargetEvent,
} from "./local-cli-execution";

export type { LocalCliRecipe } from "./model";

export type {
  PortableLinkedDevicePluginBindingV1,
  PortableProviderApiPluginBindingV1,
  PortableProviderApiPluginOperationV1,
  PortableProviderPluginAuthKind,
  PortableProviderPluginBindingV1,
  PortableProviderPluginCapabilitiesV1,
  PortableProviderPluginFileV1,
  PortableProviderPluginManifestV1,
  PortableProviderPluginProvenanceV1,
  PortableProviderPluginSessionMaterialName,
  PortableProviderPluginTransport,
  PortableWebSessionApiPluginBindingV1,
  PortableWebSessionPluginOperationV1,
} from "./provider-plugin-package";

export type {
  PortablePluginCapabilityRequest,
  PortablePluginCapabilityResult,
  PortablePluginCredentialBinding,
  PortablePluginCredentialSink,
  PortablePluginHttpBody,
  PortablePluginIdentity,
  PortablePluginInvocationAuth,
  PortablePluginInvocationFile,
  PortablePluginJsonObject,
  PortablePluginJsonValue,
  PortablePluginRoute,
  PortablePluginVersionedStateResult,
  PortableProviderPluginHostMessage,
  PortableProviderPluginMessage,
  PortableProviderPluginMessageResult,
  PortableProviderPluginProcessMessage,
} from "./provider-plugin-protocol";

export {
  ARTICLE_DRAFT_DOCUMENT_IMAGE_SCHEMA_VERSION,
  ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION,
  MAX_ARTICLE_DRAFT_BLOCKS,
  MAX_ARTICLE_DRAFT_CHARACTERS,
  MAX_ARTICLE_DRAFT_DOCUMENT_BYTES,
  articleDraftDocumentIssues,
  articleDraftDocumentV2Issues,
  parseArticleDraftDocument,
  parseArticleDraftDocumentV2,
} from "./article-draft-document";

export type {
  ArticleDraftDocument,
  ArticleDraftDocumentLimits,
  ArticleDraftDocumentV2,
  ArticleDraftDocumentV2Limits,
  ArticleDraftImageBlock,
  ArticleDraftLinkRange,
  ArticleDraftStyleRange,
  ArticleDraftTextBlock,
  ArticleDraftTextBlockType,
} from "./article-draft-document";

export {
  MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS,
  projectXStatusArticleEmbed,
} from "./article-draft-embeds";

export type {
  ArticleDraftEmbedTarget,
  XStatusArticleEmbed,
} from "./article-draft-embeds";
