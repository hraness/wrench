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
  LinkedDevicePluginBindingDefinitionV1,
  PortableProviderPluginProjectionDefinitionV1,
  ProviderApiPluginBindingDefinitionV1,
  ProviderApiPluginOperationDefinitionV1,
  ProviderPluginAuthKind,
  ProviderPluginBindingDefinitionV1,
  ProviderPluginContractStateV1,
  ProviderPluginDefinitionV1,
  ProviderPluginImplementationSourceDefinitionV1,
  ProviderPluginLinkedDeviceLifecycleRuntimeV1,
  ProviderPluginOmniDefinitionV1,
  ProviderPluginOperationDefinitionV1,
  ProviderPluginReconciliationDefinitionV1,
  ProviderPluginSubjectDefinitionV1,
  ProviderPluginTransport,
  WebSessionApiPluginBindingDefinitionV1,
  WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";

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
  ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION,
  MAX_ARTICLE_DRAFT_BLOCKS,
  MAX_ARTICLE_DRAFT_CHARACTERS,
  MAX_ARTICLE_DRAFT_DOCUMENT_BYTES,
  articleDraftDocumentIssues,
  parseArticleDraftDocument,
} from "./article-draft-document";

export type {
  ArticleDraftDocument,
  ArticleDraftDocumentLimits,
  ArticleDraftLinkRange,
  ArticleDraftStyleRange,
  ArticleDraftTextBlock,
  ArticleDraftTextBlockType,
} from "./article-draft-document";
