import type {
  IdempotencyKind,
  InputSchema,
  OfficialProviderId,
  OperationInput,
  OperationRisk,
  ProviderRecipe,
} from "./model";
import type { ProviderPluginOperationName } from "./provider-plugin-identifiers";
import type { ProviderPluginContractStateV1 } from "./provider-plugin";

/** Provider-owned bounded coverage label; the kernel does not close this set. */
export type ProviderCoverage = string;

export type ProviderContract = {
  readonly provider: OfficialProviderId;
  readonly operation: ProviderPluginOperationName;
  readonly contractVersion: number;
  readonly risk: OperationRisk;
  readonly sideEffect: string;
  readonly idempotency: IdempotencyKind;
  readonly dedupeWindowMs: number;
  readonly input: InputSchema;
  readonly state: ProviderPluginContractStateV1;
  /** Any one complete set authorizes the base operation. */
  readonly requiredScopeSets: readonly (readonly string[])[];
  readonly dispatch: "none" | "single" | "thread-items";
  readonly coverage: readonly ProviderCoverage[];
  /** Fixed endpoint families and semantic caveats bound into confirmation plans. */
  readonly implementation: string;
};

type ProviderContractDefinition = Omit<
  ProviderContract,
  "sideEffect" | "idempotency" | "dedupeWindowMs" | "state"
>;

const string = (
  description: string,
  options: {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly enum?: readonly string[];
  } = {},
) => ({ type: "string", description, ...options }) as const;

const number = (
  description: string,
  minimum: number,
  maximum: number,
) => ({ type: "number", description, minimum, maximum }) as const;

const boolean = (description: string, allowed?: readonly boolean[]) => ({
  type: "boolean",
  description,
  ...(allowed === undefined ? {} : { enum: allowed }),
}) as const;

const file = (
  description: string,
  maxBytes: number,
  mediaTypes: readonly string[],
) => ({ type: "file", description, maxBytes, mediaTypes }) as const;

const array = <T extends ReturnType<typeof string> | ReturnType<typeof number> | ReturnType<typeof file>>(
  description: string,
  items: T,
  minItems: number,
  maxItems: number,
) => ({ type: "array", description, items, minItems, maxItems }) as const;

function isFileInputValue(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { readonly kind?: unknown }).kind === "file"
    && typeof (value as { readonly reference?: unknown }).reference === "string";
}

const linkedinDefinitions = {
  "contacts.list": {
    provider: "linkedin",
    operation: "contacts.list",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        start: number("Zero-based first-degree connection offset; defaults to 0", 0, 100_000),
        count: number("Bounded first-degree connection count; defaults to 10", 1, 50),
      },
      required: [],
    },
    requiredScopeSets: [["r_1st_connections", "r_liteprofile"]],
    dispatch: "none",
    coverage: [
      "first-degree-connections",
      "authenticated-viewer-binding",
      "connection-localized-names",
      "locale-selection-evidence",
      "connection-set-total",
      "offset-paging",
      "unavailable-message-statistics",
    ],
    implementation: "pre-network scope and person-URN validation, then subject-bound GET /v2/me?projection=(id) and an exact byte comparison between the authenticated person URN and OAuth locator before GET /v2/connections?q=viewer&projection=(elements(*(to~)),paging); exact offset-page, decorated person identity, locale-selection evidence, and total-count validation; restricted r_1st_connections and r_liteprofile approval required; no inbox or web fallback; message statistics are explicitly unavailable",
  },
  "posts.read": {
    provider: "linkedin",
    operation: "posts.read",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        mode: string("Read one post or list posts by one author", { enum: ["one", "author"] }),
        post_urn: string("Exact LinkedIn share or UGC Post URN", { minLength: 1, maxLength: 500 }),
        author: string("Exact person or organization author URN", { minLength: 1, maxLength: 500 }),
        start: number("Zero-based author-list offset", 0, 100_000),
        count: number("Bounded result count", 1, 100),
        sort: string("Author-list ordering", { enum: ["LAST_MODIFIED", "CREATED"] }),
        view: string("Reader-visible or author-visible representation", { enum: ["READER", "AUTHOR"] }),
      },
      required: ["mode"],
    },
    requiredScopeSets: [["r_member_social"], ["r_organization_social"]],
    dispatch: "none",
    coverage: ["post", "author-posts"],
    implementation: "GET /rest/posts/{urn}; FINDER /rest/posts?q=author; LinkedIn-Version 202606; no home-feed reconstruction",
  },
  "posts.publish": {
    provider: "linkedin",
    operation: "posts.publish",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        author: string("Exact authenticated person or administered organization URN", { minLength: 1, maxLength: 500 }),
        body: string("Exact post commentary", { minLength: 1, maxLength: 3_000 }),
        visibility: string("Post visibility", { enum: ["PUBLIC", "CONNECTIONS"] }),
        media: array(
          "Images, or one video/document",
          file("One reviewed post attachment; video must be MP4 and at least 75,000 bytes, with duration and codec validated by LinkedIn processing", 500 * 1024 * 1024, [
            "image/jpeg",
            "image/png",
            "image/gif",
            "video/mp4",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ]),
          1,
          20,
        ),
        media_title: string("Required title for a document; optional video title", { minLength: 1, maxLength: 200 }),
        alt_text: string("Optional image alternative text", { minLength: 1, maxLength: 4_000 }),
        article_url: string("Optional exact HTTPS source for an external article-card post", { minLength: 1, maxLength: 8_192 }),
        article_title: string("Optional external article-card title", { minLength: 1, maxLength: 399 }),
        article_description: string("Optional external article-card description", { minLength: 1, maxLength: 4_000 }),
      },
      required: ["author", "body"],
    },
    requiredScopeSets: [["w_member_social"], ["w_organization_social"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "initialize fixed LinkedIn image/document/video upload; upload bytes without OAuth on signed video parts; poll assets to AVAILABLE with actor-specific read scope; finalize video; POST /rest/posts; external article cards require explicit source/title and omit thumbnail; no URL scraping",
  },
  "posts.repost": {
    provider: "linkedin",
    operation: "posts.repost",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        author: string("Exact authenticated person or administered organization URN", { minLength: 1, maxLength: 500 }),
        target_urn: string("Exact LinkedIn share or UGC Post URN to reshare", { minLength: 1, maxLength: 500 }),
        body: string("Exact reshare commentary", { minLength: 1, maxLength: 3_000 }),
        visibility: string("Reshare visibility", { enum: ["PUBLIC", "CONNECTIONS"] }),
      },
      required: ["author", "target_urn", "body"],
    },
    requiredScopeSets: [["w_member_social"], ["w_organization_social"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "POST /rest/posts with exact reshareContext.parent; main-feed distribution; actor- and subject-bound",
  },
  "comments.read": {
    provider: "linkedin",
    operation: "comments.read",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        target_urn: string("Exact post or composite parent-comment URN", { minLength: 1, maxLength: 1_000 }),
        start: number("Zero-based comment offset", 0, 100_000),
        count: number("Bounded comment count", 1, 100),
      },
      required: ["target_urn"],
    },
    requiredScopeSets: [["r_member_social_feed"], ["r_organization_social_feed"]],
    dispatch: "none",
    coverage: ["comments"],
    implementation: "GET /rest/socialActions/{target}/comments; one level per request; explicit parent query for replies",
  },
  "comments.create": {
    provider: "linkedin",
    operation: "comments.create",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        actor: string("Exact authenticated person or administered organization URN", { minLength: 1, maxLength: 500 }),
        target_urn: string("Exact post URN used in the endpoint path", { minLength: 1, maxLength: 1_000 }),
        object_urn: string("Exact root activity/object URN required by LinkedIn", { minLength: 1, maxLength: 1_000 }),
        body: string("Exact comment text", { minLength: 1, maxLength: 500 }),
      },
      required: ["actor", "target_urn", "object_urn", "body"],
    },
    requiredScopeSets: [["w_member_social_feed"], ["w_organization_social_feed"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "POST /rest/socialActions/{post}/comments with explicit actor and object URNs; text only",
  },
  "replies.create": {
    provider: "linkedin",
    operation: "replies.create",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        actor: string("Exact authenticated person or administered organization URN", { minLength: 1, maxLength: 500 }),
        parent_comment_urn: string("Exact composite parent-comment URN", { minLength: 1, maxLength: 1_000 }),
        object_urn: string("Exact root post/object URN", { minLength: 1, maxLength: 1_000 }),
        body: string("Exact reply text", { minLength: 1, maxLength: 500 }),
      },
      required: ["actor", "parent_comment_urn", "object_urn", "body"],
    },
    requiredScopeSets: [["w_member_social_feed"], ["w_organization_social_feed"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "POST /rest/socialActions/{parent-comment}/comments with explicit parentComment and object; text only",
  },
  "reactions.set": {
    provider: "linkedin",
    operation: "reactions.set",
    contractVersion: 1,
    risk: "R2",
    input: {
      properties: {
        actor: string("Exact authenticated person or administered organization URN", { minLength: 1, maxLength: 500 }),
        target_urn: string("Exact post or comment URN", { minLength: 1, maxLength: 1_000 }),
        reaction: string("Required reaction type when enabled is true; omitted when false", { enum: ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT"] }),
        enabled: boolean("Create the named reaction when true; clear any current actor reaction when false"),
      },
      required: ["actor", "target_urn", "enabled"],
    },
    requiredScopeSets: [["w_member_social_feed"], ["w_organization_social_feed"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "POST /rest/reactions?actor=... for a named reaction; DELETE composite reaction key clears any current actor reaction",
  },
} as const satisfies Readonly<Record<string, ProviderContractDefinition>>;

const xDefinitions = {
  "feeds.read": {
    provider: "x",
    operation: "feeds.read",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        feed: string("Exact official timeline or discovery surface", { enum: ["home-reverse-chronological", "user", "mentions", "list", "recent-search", "bookmarks"] }),
        user_id: string("Exact 1-19 digit X user ID for user or mentions feeds", { minLength: 1, maxLength: 19 }),
        list_id: string("Exact 1-19 digit X List ID", { minLength: 1, maxLength: 19 }),
        query: string("Recent-search query covering at most seven days", { minLength: 1, maxLength: 512 }),
        cursor: string("Opaque provider pagination token", { minLength: 1, maxLength: 4_096 }),
        limit: number("Bounded result count", 1, 100),
        since_id: string("Return posts newer than this 1-19 digit post ID", { minLength: 1, maxLength: 19 }),
        until_id: string("Return posts older than this 1-19 digit post ID", { minLength: 1, maxLength: 19 }),
        start_time: string("Inclusive ISO-8601 start time", { minLength: 20, maxLength: 40 }),
        end_time: string("Exclusive ISO-8601 end time", { minLength: 20, maxLength: 40 }),
        exclude_replies: boolean("Exclude replies where the endpoint supports it"),
        exclude_reposts: boolean("Exclude reposts where the endpoint supports it"),
        sort: string("Recent-search ordering", { enum: ["recency", "relevancy"] }),
      },
      required: ["feed"],
    },
    requiredScopeSets: [["tweet.read", "users.read"]],
    dispatch: "none",
    coverage: ["home-reverse-chronological", "user-posts", "mentions", "list-posts", "recent-search-7-days", "bookmarks"],
    implementation: "fixed X v2 reverse-chron/user/mentions/List/recent-search/bookmark endpoints with endpoint-specific no-skip page minima; never For You",
  },
  "posts.read": {
    provider: "x",
    operation: "posts.read",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        post_ids: array("Unique exact X post IDs", string("One exact 1-19 digit post ID", { minLength: 1, maxLength: 19 }), 1, 100),
      },
      required: ["post_ids"],
    },
    requiredScopeSets: [["tweet.read", "users.read"]],
    dispatch: "none",
    coverage: ["post"],
    implementation: "GET /2/tweets by bounded IDs with fixed rich fields and expansions",
  },
  "comments.read": {
    provider: "x",
    operation: "comments.read",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        post_id: string("Exact 1-19 digit root X post ID", { minLength: 1, maxLength: 19 }),
        window: string("Recent seven-day search or entitled full-archive search", { enum: ["recent-7-days", "full-archive"] }),
        cursor: string("Opaque reply-search next token", { minLength: 1, maxLength: 4_096 }),
        limit: number("Bounded reply count", 10, 100),
      },
      required: ["post_id"],
    },
    requiredScopeSets: [["tweet.read", "users.read"]],
    dispatch: "none",
    coverage: ["replies-recent-search-7-days", "replies-full-archive-search"],
    implementation: "GET recent or entitled full-archive search query conversation_id; cursor-preserving and never labeled complete",
  },
  "messaging.list": {
    provider: "x",
    operation: "messaging.list",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        view: string("Legacy DM events, encrypted Chat conversations, or encrypted Chat events", { enum: ["all", "participant", "conversation", "chat-conversations", "chat-events"] }),
        target_id: string("Exact participant, legacy DM conversation, or Chat conversation ID selected by view", { minLength: 1, maxLength: 39 }),
        cursor: string("Opaque legacy DM or Chat pagination token", { minLength: 1, maxLength: 4_096 }),
        limit: number("Bounded event or conversation count", 1, 100),
      },
      required: ["view"],
    },
    requiredScopeSets: [["dm.read", "tweet.read", "users.read"]],
    dispatch: "none",
    coverage: ["dm-events-30-days", "chat-conversations", "chat-encrypted-events"],
    implementation: "subject-bound GET legacy DM events or encrypted Chat conversations/events; Chat exposes metadata, request presence, and ciphertext envelopes but not plaintext or inbox folders",
  },
  "messaging.read": {
    provider: "x",
    operation: "messaging.read",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        event_id: string("Exact 1-19 digit legacy DM event ID", { minLength: 1, maxLength: 19 }),
      },
      required: ["event_id"],
    },
    requiredScopeSets: [["dm.read", "tweet.read", "users.read"]],
    dispatch: "none",
    coverage: ["dm-event"],
    implementation: "subject-bound GET /2/dm_events/{event}; exact response identity; legacy DM only, not encrypted Chat",
  },
  "messaging.send": {
    provider: "x",
    operation: "messaging.send",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        target_kind: string("Send to one participant or existing legacy DM conversation", { enum: ["participant", "conversation"] }),
        target_id: string("Exact participant or legacy DM conversation ID", { minLength: 1, maxLength: 39 }),
        body: string("Optional exact legacy DM text; text or media is required", { minLength: 1, maxLength: 1_000 }),
        media: file("Optional single legacy DM image, GIF, or video", 512 * 1024 * 1024, ["image/jpeg", "image/png", "image/gif", "video/mp4"]),
        media_alt_text: string("Optional accessibility text applied to reviewed JPEG/PNG DM media", { minLength: 1, maxLength: 1_000 }),
        recipient_opted_in: boolean("Required acknowledgement that the recipient opted into automated contact", [true]),
      },
      required: ["target_kind", "target_id", "recipient_opted_in"],
    },
    requiredScopeSets: [["dm.write", "dm.read", "tweet.read", "users.read"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "optional official media upload then POST legacy DM message; explicit opt-in; not encrypted Chat",
  },
  "posts.publish": {
    provider: "x",
    operation: "posts.publish",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        body: string("Optional exact post text; text, media, or a poll is required", { minLength: 1, maxLength: 280 }),
        media: array("Up to four images, or one GIF/video", file("One reviewed X post attachment", 512 * 1024 * 1024, ["image/jpeg", "image/png", "image/gif", "video/mp4"]), 1, 4),
        media_alt_texts: array("Accessibility text aligned one-to-one with JPEG/PNG media", string("One exact image description", { minLength: 1, maxLength: 1_000 }), 1, 4),
        poll_options: array("Two to four poll choices", string("One poll choice", { minLength: 1, maxLength: 25 }), 2, 4),
        poll_duration_minutes: number("Poll duration in minutes", 5, 10_080),
        reply_settings: string("Who may reply; everyone means omit the provider field", { enum: ["everyone", "mentionedUsers", "following", "subscribers", "verified"] }),
        community_id: string("Optional exact 1-19 digit Community ID", { minLength: 1, maxLength: 19 }),
        made_with_ai: boolean("When true, label the attached media as AI-generated; true requires media"),
      },
      required: [],
    },
    requiredScopeSets: [["tweet.read", "tweet.write", "users.read"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "optional official X v2 media upload then POST /2/tweets; media/poll union enforced",
  },
  "replies.create": {
    provider: "x",
    operation: "replies.create",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        target_post_id: string("Exact 1-19 digit X post ID being replied to", { minLength: 1, maxLength: 19 }),
        body: string("Optional exact reply text; text or media is required", { minLength: 1, maxLength: 280 }),
        media: array("Up to four images, or one GIF/video", file("One reviewed reply attachment", 512 * 1024 * 1024, ["image/jpeg", "image/png", "image/gif", "video/mp4"]), 1, 4),
        media_alt_texts: array("Accessibility text aligned one-to-one with JPEG/PNG media", string("One exact image description", { minLength: 1, maxLength: 1_000 }), 1, 4),
        recipient_opted_in: boolean("Required acknowledgement of recipient opt-in for an automated reply", [true]),
        author_invited_reply: boolean("Required acknowledgement that the author mentioned or quoted the replying account", [true]),
      },
      required: ["target_post_id", "recipient_opted_in", "author_invited_reply"],
    },
    requiredScopeSets: [["tweet.read", "tweet.write", "users.read"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "POST /2/tweets reply; self-serve author-invitation and automated-recipient-opt-in acknowledgements required",
  },
  "threads.publish": {
    provider: "x",
    operation: "threads.publish",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        items: array("Exact ordered thread segments", string("One exact thread segment", { minLength: 1, maxLength: 280 }), 1, 25),
        media: array("Up to 25 reviewed thread attachments in dispatch order", file("One reviewed thread attachment", 512 * 1024 * 1024, ["image/jpeg", "image/png", "image/gif", "video/mp4"]), 1, 25),
        media_item_indices: array("One-based thread item index aligned one-to-one with media", number("One-based thread item index", 1, 25), 1, 25),
        media_alt_texts: array("Accessibility text aligned one-to-one with JPEG/PNG thread media", string("One exact image description", { minLength: 1, maxLength: 1_000 }), 1, 25),
      },
      required: ["items"],
    },
    requiredScopeSets: [["tweet.read", "tweet.write", "users.read"]],
    dispatch: "thread-items",
    coverage: ["write-result"],
    implementation: "sequential POST /2/tweets; each continuation replies to immediately preceding returned ID; a normal partial return includes committed IDs for manual reconciliation and is never replayed automatically",
  },
  "posts.repost": {
    provider: "x",
    operation: "posts.repost",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        post_id: string("Exact 1-19 digit X post ID", { minLength: 1, maxLength: 19 }),
        enabled: boolean("Repost when true; undo the authenticated account's repost when false"),
      },
      required: ["post_id", "enabled"],
    },
    requiredScopeSets: [["tweet.read", "tweet.write", "users.read"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "POST or DELETE /2/users/{me}/retweets desired-state endpoint",
  },
  "content.save": {
    provider: "x",
    operation: "content.save",
    contractVersion: 1,
    risk: "R2",
    input: {
      properties: {
        post_id: string("Exact 1-19 digit X post ID", { minLength: 1, maxLength: 19 }),
        enabled: boolean("Bookmark when true; remove the bookmark when false"),
      },
      required: ["post_id", "enabled"],
    },
    requiredScopeSets: [["bookmark.write", "tweet.read", "users.read"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "POST or DELETE /2/users/{me}/bookmarks desired-state endpoint",
  },
  "articles.publish": {
    provider: "x",
    operation: "articles.publish",
    contractVersion: 1,
    risk: "R3",
    input: {
      properties: {
        title: string("Exact X Article title", { minLength: 1, maxLength: 100 }),
        body: string("Plain-text Article body converted to deterministic DraftJS blocks", { minLength: 1, maxLength: 20_000 }),
        cover: file("Optional Article cover image", 5 * 1024 * 1024, ["image/jpeg", "image/png"]),
        cover_alt_text: string("Optional accessibility text applied to the reviewed Article cover", { minLength: 1, maxLength: 1_000 }),
      },
      required: ["title", "body"],
    },
    requiredScopeSets: [["tweet.read", "tweet.write", "users.read"]],
    dispatch: "single",
    coverage: ["write-result"],
    implementation: "optional official image upload; POST /2/articles/draft; POST /2/articles/{id}/publish; account eligibility required",
  },
} as const satisfies Readonly<Record<string, ProviderContractDefinition>>;

const gmailDefinitions = {
  "contacts.list": {
    provider: "gmail",
    operation: "contacts.list",
    contractVersion: 4,
    risk: "R1",
    input: {
      properties: {
        collection: string("Google contact projection; defaults to saved contacts", { enum: ["contacts", "other-contacts", "interactions"] }),
        after: string("Optional inclusive whole-second UTC lower bound for incremental interactions", { minLength: 24, maxLength: 24 }),
        before: string("Fixed whole-second UTC cutoff required only for the interactions projection", { minLength: 24, maxLength: 24 }),
        cursor: string("Opaque Google People or Gmail API next-page token", { minLength: 1, maxLength: 4_096 }),
        include_stats: boolean("Compute bounded sent and received Gmail statistics; defaults to true"),
        limit: number("Bounded page count; defaults to 20 for contacts and 100 for interactions", 1, 100),
        stats_scan_limit: number("Maximum messages scanned per contact and direction when include_stats is true; defaults to 100; limit multiplied by this value cannot exceed 2000", 1, 2_000),
      },
      required: [],
    },
    requiredScopeSets: [
      [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://mail.google.com/",
      ],
      [
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      [
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      [
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://mail.google.com/",
      ],
    ],
    dispatch: "none",
    coverage: [
      "contacts",
      "other-contacts",
      "contact-metadata",
      "contact-email-addresses",
      "optional-sent-counts",
      "optional-received-counts",
      "optional-last-sent-at",
      "optional-last-received-at",
      "bounded-stat-completeness",
      "messages-in-fixed-half-open-window",
      "spam-and-trash-excluded",
      "draft-and-chat-excluded",
      "sent-and-received-message-counts",
      "first-and-last-interaction-times",
      "30-90-365-day-counts",
      "per-direction-completeness",
      "opaque-pagination-evidence",
      "send-as-alias-exclusion",
    ],
    implementation: "subject-bound People contacts plus Gmail interactions; saved contacts expand by batchGet; Other contacts retain their limited projection; interactions use one fixed half-open epoch window, list send-as aliases on page one, disable spam/trash, read metadata only, skip drafts/chats and lower-bound overlap, derive direction from SENT, dedupe addresses per message, expose rolling counts and undated lower bounds, emit opaque ID evidence, and never read bodies",
  },
  "messaging.list": {
    provider: "gmail",
    operation: "messaging.list",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        view: string("List the inbox or execute one explicit Gmail search", { enum: ["inbox", "search"] }),
        query: string("Exact Gmail search expression; required only for search", { minLength: 1, maxLength: 512 }),
        cursor: string("Opaque Gmail next-page token", { minLength: 1, maxLength: 4_096 }),
        limit: number("Bounded thread count", 1, 100),
        include_spam_trash: boolean("Include matching spam and trash threads for search"),
      },
      required: ["view"],
    },
    requiredScopeSets: [
      ["https://www.googleapis.com/auth/gmail.readonly"],
      ["https://www.googleapis.com/auth/gmail.modify"],
      ["https://mail.google.com/"],
    ],
    dispatch: "none",
    coverage: ["inbox-threads", "search-threads", "thread-metadata", "thread-urls", "replayable-read-input"],
    implementation: "subject-bound GET Gmail /gmail/v1/users/me/threads with fixed INBOX selection or one bounded query, followed by bounded metadata reads that emit exact thread URLs and messaging.read input; no modify, acknowledgement, or read-receipt request",
  },
  "messaging.read": {
    provider: "gmail",
    operation: "messaging.read",
    contractVersion: 1,
    risk: "R1",
    input: {
      properties: {
        thread_id: string("Exact Gmail thread ID", { minLength: 1, maxLength: 256 }),
      },
      required: ["thread_id"],
    },
    requiredScopeSets: [
      ["https://www.googleapis.com/auth/gmail.readonly"],
      ["https://www.googleapis.com/auth/gmail.modify"],
      ["https://mail.google.com/"],
    ],
    dispatch: "none",
    coverage: ["thread", "message-metadata", "render-safe-bodies", "attachment-metadata", "thread-url"],
    implementation: "subject-bound GET Gmail /gmail/v1/users/me/threads/{thread} with exact response identity, bounded MIME projection, stable part identities, attachment metadata, and an exact Gmail thread URL; no modify, acknowledgement, or read-receipt request",
  },
} as const satisfies Readonly<Record<string, ProviderContractDefinition>>;

type BoundProviderContracts<
  Definitions extends Readonly<Record<string, ProviderContractDefinition>>,
> = {
  readonly [Operation in keyof Definitions]: Definitions[Operation] & Pick<
    ProviderContract,
    "sideEffect" | "idempotency" | "dedupeWindowMs" | "state"
  >;
};

function bindProviderSemantics<
  Definitions extends Readonly<Record<string, ProviderContractDefinition>>,
>(definitions: Definitions): BoundProviderContracts<Definitions> {
  return Object.fromEntries(Object.entries(definitions).map(([operation, definition]) => {
    const mutating = definition.risk === "R2" || definition.risk === "R3";
    return [operation, Object.freeze({
      ...definition,
      sideEffect: mutating
        ? `Mutates ${definition.provider} through the exact confirmed ${definition.operation} official API contract.`
        : "none",
      idempotency: mutating ? "local-at-most-once" : "none",
      dedupeWindowMs: mutating ? 86_400_000 : 0,
      state: "observed",
    })];
  })) as BoundProviderContracts<Definitions>;
}

const linkedin = bindProviderSemantics(linkedinDefinitions);
const x = bindProviderSemantics(xDefinitions);
const gmail = bindProviderSemantics(gmailDefinitions);

export const providerContractDefinitions = { gmail, linkedin, x } as const;

export { planProviderContractDispatches } from "./provider-contract-planning";

export function providerContractConditionalInputIssues(
  recipe: Pick<ProviderRecipe, "provider" | "action">,
  input: OperationInput,
): readonly string[] {
  const issues: string[] = [];
  const xId = (name: string, value: unknown): void => {
    if (typeof value === "string" && !/^[0-9]{1,19}$/u.test(value)) {
      issues.push(`input.${name} must be a 1-19 digit X object ID`);
    }
  };
  const xConversationId = (name: string, value: unknown): void => {
    if (typeof value === "string" && !/^(?:[0-9]{15,19}|[0-9]{1,19}-[0-9]{1,19})$/u.test(value)) {
      issues.push(`input.${name} must be an exact legacy X DM conversation ID`);
    }
  };
  if (recipe.provider === "linkedin" && recipe.action === "posts.read") {
    if (input.mode === "one") {
      if (typeof input.post_urn !== "string") issues.push("input.post_urn is required when mode is one");
      if (input.author !== undefined) issues.push("input.author is not accepted when mode is one");
    }
    if (input.mode === "author") {
      if (typeof input.author !== "string") issues.push("input.author is required when mode is author");
      if (input.post_urn !== undefined) issues.push("input.post_urn is not accepted when mode is author");
    }
  }
  if (recipe.provider === "linkedin" && recipe.action === "posts.publish") {
    const media = input.media;
    if (Array.isArray(media) && typeof input.article_url === "string") issues.push("input.media and input.article_url are mutually exclusive");
    if (typeof input.article_url === "string") {
      try {
        const url = new URL(input.article_url);
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
          issues.push("input.article_url must be a credential-free HTTPS URL");
        }
      } catch {
        issues.push("input.article_url must be a credential-free HTTPS URL");
      }
      if (typeof input.article_title !== "string") issues.push("input.article_title is required with input.article_url");
    } else if (input.article_title !== undefined || input.article_description !== undefined) {
      issues.push("input.article_title and input.article_description require input.article_url");
    }
    if (input.alt_text !== undefined && !Array.isArray(media)) issues.push("input.alt_text requires input.media");
    if (input.media_title !== undefined && !Array.isArray(media)) issues.push("input.media_title requires input.media");
  }
  if (recipe.provider === "linkedin" && recipe.action === "reactions.set") {
    if (input.enabled === true && typeof input.reaction !== "string") {
      issues.push("input.reaction is required when input.enabled is true");
    }
    if (input.enabled === false && input.reaction !== undefined) {
      issues.push("input.reaction is not accepted when input.enabled is false because the operation clears any current reaction");
    }
  }
  if (recipe.provider === "x" && recipe.action === "feeds.read") {
    const feedLabel = typeof input.feed === "string" ? input.feed : "unknown feed";
    if ((input.feed === "user" || input.feed === "mentions") && typeof input.user_id !== "string") {
      issues.push("input.user_id is required for user and mentions feeds");
    }
    if (input.feed === "list" && typeof input.list_id !== "string") issues.push("input.list_id is required for the list feed");
    if (input.feed === "recent-search" && typeof input.query !== "string") issues.push("input.query is required for recent-search");
    if (input.feed !== "user" && input.feed !== "mentions" && input.user_id !== undefined) {
      issues.push("input.user_id is accepted only for user and mentions feeds");
    }
    if (input.feed !== "list" && input.list_id !== undefined) issues.push("input.list_id is accepted only for the list feed");
    if (input.feed !== "recent-search" && input.query !== undefined) {
      issues.push("input.query is accepted only for recent-search");
    }
    const supportsTimeAndIdBounds = input.feed === "home-reverse-chronological"
      || input.feed === "user"
      || input.feed === "mentions"
      || input.feed === "recent-search";
    for (const name of ["since_id", "until_id", "start_time", "end_time"] as const) {
      if (!supportsTimeAndIdBounds && input[name] !== undefined) {
        issues.push(`input.${name} is not accepted for ${feedLabel}`);
      }
    }
    if (input.feed !== "home-reverse-chronological" && input.feed !== "user") {
      if (input.exclude_replies !== undefined) issues.push(`input.exclude_replies is not accepted for ${feedLabel}`);
      if (input.exclude_reposts !== undefined) issues.push(`input.exclude_reposts is not accepted for ${feedLabel}`);
    }
    if (input.feed !== "recent-search" && input.sort !== undefined) {
      issues.push(`input.sort is accepted only for recent-search`);
    }
    xId("user_id", input.user_id);
    xId("list_id", input.list_id);
    xId("since_id", input.since_id);
    xId("until_id", input.until_id);
    if ((input.feed === "user" || input.feed === "mentions") && typeof input.limit === "number" && input.limit < 5) {
      issues.push("input.limit must be at least 5 for user and mentions feeds");
    }
    if (input.feed === "recent-search" && typeof input.limit === "number" && input.limit < 10) {
      issues.push("input.limit must be at least 10 for recent-search");
    }
    for (const name of ["start_time", "end_time"] as const) {
      const value = input[name];
      if (typeof value === "string" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)))) {
        issues.push(`input.${name} must be a valid UTC RFC 3339 timestamp`);
      }
    }
  }
  if (recipe.provider === "x" && recipe.action === "posts.read") {
    if (Array.isArray(input.post_ids)) {
      for (const [index, value] of input.post_ids.entries()) xId(`post_ids[${index}]`, value);
      if (input.post_ids.every((value) => typeof value === "string") && new Set(input.post_ids).size !== input.post_ids.length) {
        issues.push("input.post_ids must contain unique X post IDs");
      }
    }
  }
  if (recipe.provider === "x" && recipe.action === "comments.read") xId("post_id", input.post_id);
  if (recipe.provider === "x" && recipe.action === "messaging.list") {
    const needsTarget = input.view === "participant" || input.view === "conversation" || input.view === "chat-events";
    if (needsTarget && typeof input.target_id !== "string") {
      issues.push("input.target_id is required for participant, conversation, and chat-events views");
    }
    if ((input.view === "all" || input.view === "chat-conversations") && input.target_id !== undefined) {
      issues.push(`input.target_id is not accepted when view is ${input.view}`);
    }
    if (input.view === "participant") xId("target_id", input.target_id);
    if (input.view === "conversation") xConversationId("target_id", input.target_id);
    if (input.view === "chat-events" && typeof input.target_id === "string"
      && !/^(?:[0-9]{1,19}|[0-9]{1,19}-[0-9]{1,19}|g[0-9]{1,19})$/u.test(input.target_id)) {
      issues.push("input.target_id must be an exact X Chat recipient or conversation ID");
    }
    if (input.view === "chat-events" && typeof input.target_id === "string" && input.target_id.includes("-")) {
      const [left, right] = input.target_id.split("-");
      if (left === right) issues.push("input.target_id must identify two different X Chat participants");
    }
  }
  if (recipe.provider === "x" && recipe.action === "messaging.read") xId("event_id", input.event_id);
  if (recipe.provider === "x" && recipe.action === "messaging.send") {
    if (input.target_kind === "participant") xId("target_id", input.target_id);
    if (input.target_kind === "conversation") xConversationId("target_id", input.target_id);
    if (input.target_kind === "conversation" && typeof input.target_id === "string" && input.target_id.includes("-")) {
      const [left, right] = input.target_id.split("-");
      if (left === right) issues.push("input.target_id must identify two different legacy X DM participants");
    }
    if (typeof input.body !== "string" && !isFileInputValue(input.media)) {
      issues.push("input.body or input.media is required for an X Direct Message");
    }
    if (input.media_alt_text !== undefined && !isFileInputValue(input.media)) {
      issues.push("input.media_alt_text requires input.media");
    }
  }
  if (recipe.provider === "x" && recipe.action === "posts.publish") {
    const hasPoll = Array.isArray(input.poll_options) || input.poll_duration_minutes !== undefined;
    if (hasPoll && (!Array.isArray(input.poll_options) || typeof input.poll_duration_minutes !== "number")) {
      issues.push("input.poll_options and input.poll_duration_minutes must be supplied together");
    }
    if (hasPoll && Array.isArray(input.media)) issues.push("input.media and poll inputs are mutually exclusive");
    if (typeof input.body !== "string" && !Array.isArray(input.media) && !hasPoll) {
      issues.push("input.body, input.media, or complete poll inputs are required for an X post");
    }
    if (input.made_with_ai === true && !Array.isArray(input.media)) {
      issues.push("input.made_with_ai can be true only when reviewed media is attached");
    }
    if (input.media_alt_texts !== undefined) {
      if (!Array.isArray(input.media)) issues.push("input.media_alt_texts requires input.media");
      else if (!Array.isArray(input.media_alt_texts) || input.media_alt_texts.length !== input.media.length) {
        issues.push("input.media_alt_texts must align one-to-one with input.media");
      }
    }
    xId("community_id", input.community_id);
  }
  if (recipe.provider === "x" && recipe.action === "replies.create") {
    xId("target_post_id", input.target_post_id);
    if (typeof input.body !== "string" && !Array.isArray(input.media)) {
      issues.push("input.body or input.media is required for an X reply");
    }
    if (input.media_alt_texts !== undefined) {
      if (!Array.isArray(input.media)) issues.push("input.media_alt_texts requires input.media");
      else if (!Array.isArray(input.media_alt_texts) || input.media_alt_texts.length !== input.media.length) {
        issues.push("input.media_alt_texts must align one-to-one with input.media");
      }
    }
  }
  if (recipe.provider === "x" && recipe.action === "threads.publish") {
    const media = input.media;
    const indices = input.media_item_indices;
    if (Array.isArray(media) !== Array.isArray(indices)) {
      issues.push("input.media and input.media_item_indices must be supplied together");
    }
    if (Array.isArray(media) && Array.isArray(indices) && media.length !== indices.length) {
      issues.push("input.media_item_indices must align one-to-one with input.media");
    }
    if (Array.isArray(indices) && Array.isArray(input.items)) {
      for (const [index, value] of indices.entries()) {
        if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1 || value > input.items.length)) {
          issues.push(`input.media_item_indices[${index}] must name an existing one-based thread item`);
        }
      }
    }
    if (input.media_alt_texts !== undefined) {
      if (!Array.isArray(media)) issues.push("input.media_alt_texts requires input.media");
      else if (!Array.isArray(input.media_alt_texts) || input.media_alt_texts.length !== media.length) {
        issues.push("input.media_alt_texts must align one-to-one with input.media");
      }
    }
  }
  if (recipe.provider === "x" && (recipe.action === "posts.repost" || recipe.action === "content.save")) {
    xId("post_id", input.post_id);
  }
  if (recipe.provider === "x") {
    for (const name of ["limit", "poll_duration_minutes"] as const) {
      const value = input[name];
      if (typeof value === "number" && !Number.isSafeInteger(value)) issues.push(`input.${name} must be a safe integer`);
    }
  }
  if (recipe.provider === "x"
    && (recipe.action === "articles.draft.save" || recipe.action === "articles.publish")
    && input.cover_alt_text !== undefined && !isFileInputValue(input.cover)) {
    issues.push("input.cover_alt_text requires input.cover");
  }
  return issues;
}
