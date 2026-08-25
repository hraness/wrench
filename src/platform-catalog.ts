/**
 * Reviewed policy catalog for social-site adapters.
 *
 * `adapter-eligible` means that wrench may represent the operation after a
 * site-specific adapter has been derived and reviewed. It does not mean that
 * an adapter, selector, or browser recipe currently exists.
 */

export const semanticOperationNames = [
  "content.read",
  "content.clip",
  "profiles.read",
  "organizations.read",
  "contacts.list",
  "contacts.search",
  "feeds.read",
  "messaging.list",
  "messaging.search",
  "messaging.read",
  "messaging.send",
  "comments.read",
  "comments.create",
  "replies.create",
  "posts.read",
  "posts.publish",
  "threads.publish",
  "reactions.set",
  "likes.set",
  "media.read",
  "media.publish",
  "articles.read",
  "articles.draft.save",
  "articles.publish",
  "listings.read",
  "listings.publish",
  "relationships.follow.set",
  "relationships.recommendations.read",
  "relationships.connect",
  "posts.repost",
  "posts.quote",
  "content.share",
  "content.save",
  "content.edit",
  "content.delete",
  "content.schedule",
  "content.audience.set",
  "communities.membership.set",
  "communities.membership.manage",
  "administration.manage",
  "commerce.purchase",
  "account.delete",
  "moderation.bulk",
] as const;

export type SemanticOperationName = (typeof semanticOperationNames)[number];

export const socialPlatformIds = [
  "linkedin",
  "x",
  "reddit",
  "github",
  "hacker-news",
  "whatsapp",
  "substack",
  "instagram",
  "threads",
  "facebook",
  "tiktok",
  "twitch",
  "youtube",
  "bluesky",
] as const;

export type SocialPlatformId = (typeof socialPlatformIds)[number];

export const platformSurfaceIds = [
  "linkedin",
  "x",
  "reddit",
  "github",
  "hacker-news",
  "whatsapp",
  "substack",
  "instagram",
  "threads",
  "facebook",
  "facebook-page",
  "facebook-group",
  "facebook-marketplace",
  "tiktok",
  "twitch",
  "youtube",
  "bluesky",
] as const;

export type PlatformSurfaceId = (typeof platformSurfaceIds)[number];
export type PlatformFacet = "default" | "page" | "group" | "marketplace";

type EligibleRisk = "R1" | "R2" | "R3";

export type CapabilityPolicy =
  | {
      readonly state: "adapter-eligible";
      readonly risk: EligibleRisk;
      readonly meaning: string;
    }
  | {
      readonly state: "unsupported";
      readonly reason: string;
    }
  | {
      readonly state: "not-applicable";
      readonly reason: string;
    }
  | {
      readonly state: "R4";
      readonly risk: "R4";
      readonly reason: string;
    };

export type OperationPolicyMatrix = Readonly<Record<SemanticOperationName, CapabilityPolicy>>;

type OperationGroups = {
  readonly R1: readonly SemanticOperationName[];
  readonly R2: readonly SemanticOperationName[];
  readonly R3: readonly SemanticOperationName[];
  readonly unsupported: readonly SemanticOperationName[];
  readonly notApplicable: readonly SemanticOperationName[];
  readonly R4: readonly SemanticOperationName[];
};

const operationMeanings = {
  "content.read": "Read one bounded content target",
  "content.clip": "Capture one bounded content target locally",
  "profiles.read": "Read one explicitly selected member or account profile",
  "organizations.read": "Read one explicitly selected organization or page",
  "contacts.list": "List one bounded provider-defined contact collection with explicit metadata and statistics completeness",
  "contacts.search": "Search one bounded provider-defined contact candidate window",
  "feeds.read": "Read one explicitly selected bounded feed or timeline",
  "messaging.list": "List one bounded provider-visible inbox or message-event collection",
  "messaging.search": "Search one bounded provider-visible conversation candidate window",
  "messaging.read": "Read one explicitly targeted conversation",
  "messaging.send": "Send one message to an explicit conversation",
  "comments.read": "Read bounded comments and replies on one target",
  "comments.create": "Publish one comment on an explicit target",
  "replies.create": "Publish one reply to an explicit target",
  "posts.read": "Read one post or a bounded post collection",
  "posts.publish": "Publish one post",
  "threads.publish": "Publish one ordered bounded root-and-replies thread",
  "reactions.set": "Set or clear one reversible reaction",
  "likes.set": "Set or clear one reversible like",
  "media.read": "Read metadata for explicitly targeted media",
  "media.publish": "Publish one bounded media item",
  "articles.read": "Read one native long-form article",
  "articles.draft.save": "Save one private native long-form article draft",
  "articles.publish": "Publish one native long-form article",
  "listings.read": "Read one explicitly targeted marketplace listing",
  "listings.publish": "Publish one marketplace listing",
  "relationships.follow.set": "Follow or unfollow one explicit account or free publication",
  "relationships.recommendations.read": "Read one bounded page of provider-recommended connections",
  "relationships.connect": "Send one connection request to an explicit account",
  "posts.repost": "Repost or undo one explicit post without added commentary",
  "posts.quote": "Publish one quoted repost with explicit commentary",
  "content.share": "Share one explicit content item to one provider-visible target",
  "content.save": "Save, bookmark, star, or unsave one explicit content item privately",
  "content.edit": "Edit one explicitly targeted authored item",
  "content.delete": "Delete one explicitly targeted authored item",
  "content.schedule": "Schedule one explicit content draft for publication",
  "content.audience.set": "Change the audience or visibility of one existing content item",
  "communities.membership.set": "Join or leave one explicit community as the current user",
  "communities.membership.manage": "Approve, remove, invite, or change another community member",
  "administration.manage": "Change roles, permissions, business settings, or administrative configuration",
  "commerce.purchase": "Commit a purchase or financial obligation",
  "account.delete": "Delete an account or platform identity",
  "moderation.bulk": "Apply moderation to multiple targets",
} as const satisfies Readonly<Record<SemanticOperationName, string>>;

function buildOperationMatrix(groups: OperationGroups): OperationPolicyMatrix {
  const policies: Partial<Record<SemanticOperationName, CapabilityPolicy>> = {};

  const add = (name: SemanticOperationName, policy: CapabilityPolicy): void => {
    if (policies[name] !== undefined) {
      throw new Error(`Duplicate platform-catalog operation classification: ${name}`);
    }
    policies[name] = policy;
  };

  for (const risk of ["R1", "R2", "R3"] as const) {
    for (const name of groups[risk]) {
      add(name, {
        state: "adapter-eligible",
        risk,
        meaning: `${operationMeanings[name]}; a reviewed adapter is still required`,
      });
    }
  }
  for (const name of groups.unsupported) {
    add(name, {
      state: "unsupported",
      reason: `${operationMeanings[name]} has no reviewed policy on this surface`,
    });
  }
  for (const name of groups.notApplicable) {
    add(name, {
      state: "not-applicable",
      reason: `${operationMeanings[name]} has no distinct native concept on this surface`,
    });
  }
  for (const name of groups.R4) {
    add(name, {
      state: "R4",
      risk: "R4",
      reason: `${operationMeanings[name]} is outside wrench's executable safety boundary`,
    });
  }

  // Collection reads are the list-shaped counterparts of the existing
  // target-shaped operations. Keep their reviewed risk aligned by default so
  // every surface receives an explicit policy without duplicating the same
  // classification across the catalog. A concrete adapter still has to expose
  // a truthful provider-specific collection and its completeness limits.
  if (policies["feeds.read"] === undefined) {
    const posts = policies["posts.read"];
    add("feeds.read", posts?.state === "adapter-eligible"
      ? {
          state: "adapter-eligible",
          risk: "R1",
          meaning: `${operationMeanings["feeds.read"]}; a reviewed adapter is still required`,
        }
      : posts?.state === "not-applicable"
        ? {
            state: "not-applicable",
            reason: `${operationMeanings["feeds.read"]} has no distinct native concept on this surface`,
          }
      : {
          state: "unsupported",
          reason: `${operationMeanings["feeds.read"]} has no reviewed policy on this surface`,
        });
  }
  if (policies["messaging.list"] === undefined) {
    const messages = policies["messaging.read"];
    add("messaging.list", messages?.state === "adapter-eligible"
      ? {
          state: "adapter-eligible",
          risk: "R1",
          meaning: `${operationMeanings["messaging.list"]}; a reviewed adapter is still required`,
        }
      : messages?.state === "not-applicable"
        ? {
            state: "not-applicable",
            reason: `${operationMeanings["messaging.list"]} has no distinct native concept on this surface`,
          }
      : {
          state: "unsupported",
          reason: `${operationMeanings["messaging.list"]} has no reviewed policy on this surface`,
        });
  }

  // Identity and discovery reads are intentionally opt-in. Unlike feed and
  // inbox collection aliases, these operations do not inherit support from a
  // nearby target read because doing so would overclaim a provider-specific
  // people, organization, or recommendation surface.
  for (const name of [
    "profiles.read",
    "organizations.read",
    "contacts.list",
    "contacts.search",
    "messaging.search",
    "relationships.recommendations.read",
  ] as const) {
    if (policies[name] === undefined) {
      add(name, {
        state: "unsupported",
        reason: `${operationMeanings[name]} has no reviewed policy on this surface`,
      });
    }
  }

  const missing = semanticOperationNames.filter((name) => policies[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing platform-catalog operation classifications: ${missing.join(", ")}`);
  }
  const ordered = Object.fromEntries(
    semanticOperationNames.map((name) => [name, policies[name]]),
  );
  return Object.freeze(ordered) as OperationPolicyMatrix;
}

export const textMeasurementNames = [
  "unicode-code-points",
  "utf16-code-units",
  "x-conservative-weighted",
] as const;

export type TextMeasurementName = (typeof textMeasurementNames)[number];

export type CodePointWeightRange = {
  readonly start: number;
  readonly end: number;
  readonly weight: number;
};

export type TextWeightPolicy = {
  readonly defaultWeight: number;
  readonly ranges: readonly CodePointWeightRange[];
  /** A recognized URL weighs at least this much; raw weight is never discarded. */
  readonly minimumUrlWeight?: number;
};

export const textWeightPolicies = {
  "unicode-code-points": {
    defaultWeight: 1,
    ranges: [],
  },
  "utf16-code-units": {
    defaultWeight: 1,
    ranges: [{ start: 0x10_000, end: 0x10_ffff, weight: 2 }],
  },
  "x-conservative-weighted": {
    defaultWeight: 2,
    ranges: [
      { start: 0x0000, end: 0x10ff, weight: 1 },
      { start: 0x2000, end: 0x200d, weight: 1 },
      { start: 0x2010, end: 0x201f, weight: 1 },
      { start: 0x2032, end: 0x2037, weight: 1 },
    ],
    minimumUrlWeight: 23,
  },
} as const satisfies Readonly<Record<TextMeasurementName, TextWeightPolicy>>;

export const compositionTextFormatNames = [
  "plain-text",
  "decimal-amount",
  "currency-code",
  "provider-option",
  "location-label",
] as const;

export type CompositionTextFormatName = (typeof compositionTextFormatNames)[number];

export type CompositionTextField = {
  readonly name:
    | "title"
    | "body"
    | "caption"
    | "price"
    | "currency"
    | "category"
    | "condition"
    | "location"
    | "delivery";
  readonly required: boolean;
  /** A deliberately conservative workflow bound, not a provider maximum. */
  readonly safeMaxUnits: number;
  readonly measurement: TextMeasurementName;
  /** Provider-neutral value semantics; provider-option requires a stable reviewed adapter enum. */
  readonly format: CompositionTextFormatName;
};

export const attachmentKinds = [
  "image",
  "video",
  "audio",
  "gif",
  "document",
  "link",
] as const;

export type AttachmentKind = (typeof attachmentKinds)[number];

export type AttachmentPolicy =
  | {
      readonly state: "none";
      readonly reason: string;
    }
  | {
      readonly state: "allowed";
      readonly minItems: number;
      readonly maxItems: number;
      readonly kinds: readonly AttachmentKind[];
      readonly note: string;
    };

export const compositionNames = [
  "message",
  "comment",
  "reply",
  "post",
  "media",
  "article",
  "listing",
] as const;

export type CompositionName = (typeof compositionNames)[number];

export type CompositionPolicy = {
  readonly text: readonly CompositionTextField[];
  readonly attachments: AttachmentPolicy;
};

type FeatureExclusion =
  | { readonly state: "unsupported"; readonly reason: string }
  | { readonly state: "not-applicable"; readonly reason: string }
  | { readonly state: "R4"; readonly risk: "R4"; readonly reason: string };

export type LongFormAccessPolicy =
  | {
      readonly state: "adapter-eligible";
      readonly operation: SemanticOperationName;
      readonly form: "native-article" | "expanded-post";
      readonly note: string;
    }
  | FeatureExclusion;

export type ThreadReadPolicy =
  | {
      readonly state: "adapter-eligible";
      readonly operation: "content.read";
      readonly note: string;
    }
  | FeatureExclusion;

export type ThreadPublishPolicy =
  | {
      readonly state: "adapter-eligible";
      readonly operation: "threads.publish";
      readonly rootOperation: "posts.publish";
      readonly continuationOperation: "replies.create";
      readonly safeMaxItems: number;
      readonly note: string;
    }
  | FeatureExclusion;

export type ExactOriginPolicy = {
  readonly exactOrigins: readonly `https://${string}`[];
  readonly additionalExactOrigins:
    | { readonly state: "forbidden" }
    | {
        readonly state: "adapter-declared";
        readonly kind: "publication-origin";
        readonly maxOrigins: 1;
        readonly note: string;
      };
};

export type PlatformSurfaceCatalogEntry = {
  readonly id: PlatformSurfaceId;
  readonly platform: SocialPlatformId;
  readonly facet: PlatformFacet;
  readonly displayName: string;
  readonly originPolicy: ExactOriginPolicy;
  readonly operations: OperationPolicyMatrix;
  readonly compositions: Readonly<Partial<Record<CompositionName, CompositionPolicy>>>;
  readonly longForm: {
    readonly read: LongFormAccessPolicy;
    readonly publish: LongFormAccessPolicy;
  };
  readonly threads: {
    readonly read: ThreadReadPolicy;
    readonly publish: ThreadPublishPolicy;
  };
};

const exactOrigins = (...origins: readonly `https://${string}`[]): ExactOriginPolicy => ({
  exactOrigins: origins,
  additionalExactOrigins: { state: "forbidden" },
});

const publicationOrigins = (...origins: readonly `https://${string}`[]): ExactOriginPolicy => ({
  exactOrigins: origins,
  additionalExactOrigins: {
    state: "adapter-declared",
    kind: "publication-origin",
    maxOrigins: 1,
    note: "A custom publication host must be declared as one exact HTTPS origin in the reviewed adapter",
  },
});

const field = (
  name: CompositionTextField["name"],
  safeMaxUnits: number,
  measurement: TextMeasurementName,
  required = true,
  format: CompositionTextFormatName = "plain-text",
): CompositionTextField => ({ name, required, safeMaxUnits, measurement, format });

const noAttachments = (reason: string): AttachmentPolicy => ({ state: "none", reason });

const attachments = (
  maxItems: number,
  kinds: readonly AttachmentKind[],
  note: string,
  minItems = 0,
): AttachmentPolicy => ({ state: "allowed", minItems, maxItems, kinds, note });

const excludedFeature = (
  state: FeatureExclusion["state"],
  reason: string,
): FeatureExclusion => state === "R4"
  ? { state, risk: "R4", reason }
  : { state, reason };

const longForm = (
  operation: SemanticOperationName,
  form: "native-article" | "expanded-post",
  note: string,
): LongFormAccessPolicy => ({ state: "adapter-eligible", operation, form, note });

const threadRead = (note: string): ThreadReadPolicy => ({
  state: "adapter-eligible",
  operation: "content.read",
  note,
});

const threadPublish = (safeMaxItems: number, note: string): ThreadPublishPolicy => ({
  state: "adapter-eligible",
  operation: "threads.publish",
  rootOperation: "posts.publish",
  continuationOperation: "replies.create",
  safeMaxItems,
  note,
});

const NA_LONG_FORM = excludedFeature("not-applicable", "This surface has no distinct native long-form article model");
const UNSUPPORTED_LONG_FORM = excludedFeature("unsupported", "No native long-form workflow is catalogued for this surface");
const NA_THREADS = excludedFeature("not-applicable", "This surface has no ordered multi-post thread model");
const UNSUPPORTED_THREADS = excludedFeature("unsupported", "No ordered multi-post thread workflow is catalogued for this surface");

export const socialPlatformCatalog = {
  linkedin: {
    id: "linkedin",
    platform: "linkedin",
    facet: "default",
    displayName: "LinkedIn",
    originPolicy: exactOrigins("https://www.linkedin.com"),
    operations: buildOperationMatrix({
      R1: [
        "content.read",
        "content.clip",
        "profiles.read",
        "organizations.read",
        "contacts.list",
        "feeds.read",
        "messaging.list",
        "messaging.read",
        "comments.read",
        "posts.read",
        "media.read",
        "articles.read",
        "relationships.recommendations.read",
      ],
      R2: ["reactions.set", "relationships.follow.set", "content.save", "articles.draft.save", "communities.membership.set"],
      R3: [
        "comments.create",
        "replies.create",
        "messaging.send",
        "posts.publish",
        "media.publish",
        "articles.publish",
        "relationships.connect",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.edit",
        "content.schedule",
      ],
      unsupported: ["threads.publish"],
      notApplicable: ["likes.set", "listings.read", "listings.publish"],
      R4: [
        "content.delete",
        "content.audience.set",
        "communities.membership.manage",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 8_000, "utf16-code-units", false)],
        attachments: attachments(1, ["image", "video", "document", "link"], "One reviewed message attachment; message-request restrictions remain provider-enforced"),
      },
      comment: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("body", 3_000, "utf16-code-units")],
        attachments: attachments(20, ["image", "video", "document", "link"], "Up to 20 images, or one reviewed video, document, or link card; adapters must enforce the media-kind union"),
      },
      media: {
        text: [field("body", 3_000, "utf16-code-units"), field("title", 200, "utf16-code-units", false)],
        attachments: attachments(1, ["video"], "Exactly one reviewed video upload", 1),
      },
      article: {
        text: [field("title", 150, "utf16-code-units"), field("body", 125_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "link"], "One reviewed cover image or source link"),
      },
    },
    longForm: {
      read: longForm("articles.read", "native-article", "Read one LinkedIn article"),
      publish: longForm("articles.publish", "native-article", "Publish one LinkedIn article through a reviewed authenticated web-session contract"),
    },
    threads: { read: UNSUPPORTED_THREADS, publish: UNSUPPORTED_THREADS },
  },

  x: {
    id: "x",
    platform: "x",
    facet: "default",
    displayName: "X",
    originPolicy: exactOrigins("https://x.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "messaging.read", "comments.read", "posts.read", "media.read", "articles.read"],
      R2: ["likes.set", "relationships.follow.set", "content.save", "articles.draft.save", "communities.membership.set"],
      R3: [
        "messaging.send",
        "replies.create",
        "posts.publish",
        "threads.publish",
        "articles.publish",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.edit",
        "content.delete",
        "content.schedule",
      ],
      unsupported: ["media.publish"],
      notApplicable: ["comments.create", "reactions.set", "listings.read", "listings.publish", "relationships.connect"],
      R4: [
        "content.audience.set",
        "communities.membership.manage",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "x-conservative-weighted", false)],
        attachments: attachments(1, ["image", "video", "gif", "link"], "One reviewed message attachment"),
      },
      reply: {
        text: [field("body", 280, "x-conservative-weighted", false)],
        attachments: attachments(4, ["image", "video", "gif", "link"], "Up to four images, or one GIF/video; adapters must enforce the media-kind union"),
      },
      post: {
        text: [field("body", 280, "x-conservative-weighted", false)],
        attachments: attachments(4, ["image", "video", "gif", "link"], "Up to four images, or one GIF/video; adapters must enforce the media-kind union"),
      },
      article: {
        text: [field("title", 100, "x-conservative-weighted"), field("body", 20_000, "x-conservative-weighted")],
        attachments: attachments(1, ["image", "link"], "One reviewed native-article attachment"),
      },
    },
    longForm: {
      read: longForm("articles.read", "native-article", "Read one native X article when entitled"),
      publish: longForm("articles.publish", "native-article", "Publish one native X article when entitled"),
    },
    threads: {
      read: threadRead("Read one bounded X post thread"),
      publish: threadPublish(25, "Publish one root post optionally followed by bounded self-replies"),
    },
  },

  reddit: {
    id: "reddit",
    platform: "reddit",
    facet: "default",
    displayName: "Reddit",
    originPolicy: exactOrigins("https://www.reddit.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "messaging.read", "comments.read", "posts.read", "media.read"],
      R2: ["reactions.set", "relationships.follow.set", "content.save", "communities.membership.set"],
      R3: [
        "messaging.send",
        "comments.create",
        "replies.create",
        "posts.publish",
        "media.publish",
        "posts.repost",
        "content.share",
        "content.edit",
        "content.delete",
      ],
      unsupported: ["content.schedule"],
      notApplicable: [
        "likes.set",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "posts.quote",
        "threads.publish",
      ],
      R4: [
        "content.audience.set",
        "communities.membership.manage",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: noAttachments("Message attachments are not catalogued"),
      },
      comment: {
        text: [field("body", 2_000, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 2_000, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("title", 280, "utf16-code-units"), field("body", 10_000, "utf16-code-units", false)],
        attachments: attachments(1, ["image", "video", "link"], "One reviewed post attachment"),
      },
      media: {
        text: [field("title", 280, "utf16-code-units"), field("body", 10_000, "utf16-code-units", false)],
        attachments: attachments(1, ["video"], "Exactly one reviewed video upload", 1),
      },
    },
    longForm: {
      read: longForm("posts.read", "expanded-post", "Read one native long self-post"),
      publish: longForm("posts.publish", "expanded-post", "Publish one native long self-post"),
    },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  github: {
    id: "github",
    platform: "github",
    facet: "default",
    displayName: "GitHub",
    originPolicy: exactOrigins("https://github.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "organizations.read"],
      R2: [],
      R3: [],
      unsupported: [
        "messaging.read",
        "messaging.send",
        "comments.read",
        "comments.create",
        "replies.create",
        "posts.read",
        "posts.publish",
        "threads.publish",
        "likes.set",
        "reactions.set",
        "media.read",
        "media.publish",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.recommendations.read",
        "relationships.follow.set",
        "relationships.connect",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.save",
        "content.edit",
        "content.schedule",
        "content.audience.set",
        "communities.membership.set",
      ],
      notApplicable: [],
      R4: [
        "content.delete",
        "communities.membership.manage",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {},
    longForm: {
      read: UNSUPPORTED_LONG_FORM,
      publish: UNSUPPORTED_LONG_FORM,
    },
    threads: {
      read: UNSUPPORTED_THREADS,
      publish: UNSUPPORTED_THREADS,
    },
  },

  "hacker-news": {
    id: "hacker-news",
    platform: "hacker-news",
    facet: "default",
    displayName: "Hacker News",
    originPolicy: exactOrigins("https://news.ycombinator.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "comments.read", "posts.read"],
      R2: ["reactions.set", "content.save"],
      R3: ["comments.create", "replies.create", "posts.publish", "content.edit"],
      unsupported: [],
      notApplicable: [
        "messaging.read",
        "messaging.send",
        "likes.set",
        "media.read",
        "media.publish",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.follow.set",
        "relationships.connect",
        "posts.repost",
        "posts.quote",
        "threads.publish",
        "content.share",
        "content.schedule",
        "content.audience.set",
        "communities.membership.set",
        "communities.membership.manage",
        "commerce.purchase",
      ],
      R4: ["content.delete", "administration.manage", "account.delete", "moderation.bulk"],
    }),
    compositions: {
      comment: {
        text: [field("body", 2_000, "utf16-code-units")],
        attachments: noAttachments("Comments are text-only in the catalog"),
      },
      reply: {
        text: [field("body", 2_000, "utf16-code-units")],
        attachments: noAttachments("Replies are text-only in the catalog"),
      },
      post: {
        text: [field("title", 80, "utf16-code-units"), field("body", 2_000, "utf16-code-units", false)],
        attachments: attachments(1, ["link"], "One explicitly supplied destination link"),
      },
    },
    longForm: {
      read: longForm("posts.read", "expanded-post", "Read one Ask or Show text post"),
      publish: longForm("posts.publish", "expanded-post", "Publish one bounded text post"),
    },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  whatsapp: {
    id: "whatsapp",
    platform: "whatsapp",
    facet: "default",
    displayName: "WhatsApp Web",
    originPolicy: exactOrigins("https://web.whatsapp.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "contacts.list", "messaging.read", "media.read"],
      R2: ["reactions.set", "content.save"],
      R3: ["messaging.send", "content.share", "content.edit"],
      unsupported: ["content.clip", "media.publish", "communities.membership.set"],
      notApplicable: [
        "comments.read",
        "comments.create",
        "replies.create",
        "posts.read",
        "posts.publish",
        "threads.publish",
        "likes.set",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.follow.set",
        "relationships.connect",
        "posts.repost",
        "posts.quote",
        "content.schedule",
        "content.audience.set",
      ],
      R4: [
        "content.delete",
        "communities.membership.manage",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 2_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "audio", "document", "link"], "One explicitly selected message attachment"),
      },
    },
    longForm: { read: NA_LONG_FORM, publish: NA_LONG_FORM },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  substack: {
    id: "substack",
    platform: "substack",
    facet: "default",
    displayName: "Substack",
    originPolicy: publicationOrigins("https://substack.com", "https://www.substack.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "organizations.read", "messaging.read", "comments.read", "posts.read", "media.read", "articles.read"],
      R2: ["likes.set", "relationships.follow.set", "content.save"],
      R3: [
        "messaging.send",
        "comments.create",
        "replies.create",
        "posts.publish",
        "media.publish",
        "articles.publish",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.edit",
        "content.delete",
        "content.schedule",
      ],
      unsupported: ["articles.draft.save", "threads.publish", "communities.membership.set"],
      notApplicable: ["reactions.set", "listings.read", "listings.publish", "relationships.connect"],
      R4: [
        "content.audience.set",
        "communities.membership.manage",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: noAttachments("Chat attachments are not catalogued"),
      },
      comment: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "link"], "One reviewed Note attachment"),
      },
      media: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: attachments(1, ["video"], "Exactly one reviewed Note video upload", 1),
      },
      article: {
        text: [field("title", 160, "utf16-code-units"), field("body", 50_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "audio", "link"], "One reviewed lead attachment; rich body media needs separate review"),
      },
    },
    longForm: {
      read: longForm("articles.read", "native-article", "Read one entitled publication article"),
      publish: longForm("articles.publish", "native-article", "Publish one publication article"),
    },
    threads: { read: UNSUPPORTED_THREADS, publish: UNSUPPORTED_THREADS },
  },

  instagram: {
    id: "instagram",
    platform: "instagram",
    facet: "default",
    displayName: "Instagram",
    originPolicy: exactOrigins("https://www.instagram.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "contacts.list", "messaging.read", "comments.read", "posts.read", "media.read"],
      R2: ["reactions.set", "likes.set", "relationships.follow.set", "content.save"],
      R3: [
        "messaging.send",
        "comments.create",
        "replies.create",
        "media.publish",
        "content.delete",
        "posts.repost",
        "content.share",
        "content.edit",
      ],
      unsupported: ["content.schedule"],
      notApplicable: [
        "posts.publish",
        "threads.publish",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "posts.quote",
        "communities.membership.set",
        "communities.membership.manage",
      ],
      R4: [
        "content.audience.set",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "link"], "One explicitly selected message attachment"),
      },
      comment: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      media: {
        text: [field("caption", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["video"], "Exactly one plan-bound MP4 video", 1),
      },
    },
    longForm: { read: NA_LONG_FORM, publish: NA_LONG_FORM },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  threads: {
    id: "threads",
    platform: "threads",
    facet: "default",
    displayName: "Threads",
    originPolicy: exactOrigins("https://www.threads.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "messaging.read", "comments.read", "posts.read", "media.read"],
      R2: ["likes.set", "relationships.follow.set", "content.save"],
      R3: [
        "messaging.send",
        "replies.create",
        "posts.publish",
        "media.publish",
        "threads.publish",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.edit",
      ],
      unsupported: ["articles.read", "articles.draft.save", "articles.publish", "content.schedule"],
      notApplicable: [
        "comments.create",
        "reactions.set",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "communities.membership.set",
        "communities.membership.manage",
        "commerce.purchase",
      ],
      R4: ["content.delete", "content.audience.set", "administration.manage", "account.delete", "moderation.bulk"],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "link"], "One explicitly selected message attachment"),
      },
      reply: {
        text: [field("body", 450, "unicode-code-points")],
        attachments: attachments(1, ["image", "video", "gif", "link"], "One reviewed reply attachment"),
      },
      post: {
        text: [field("body", 450, "unicode-code-points")],
        attachments: attachments(1, ["image", "video", "gif", "link"], "One reviewed post attachment"),
      },
      media: {
        text: [field("body", 450, "unicode-code-points")],
        attachments: attachments(1, ["video"], "Exactly one reviewed video upload", 1),
      },
    },
    longForm: { read: UNSUPPORTED_LONG_FORM, publish: UNSUPPORTED_LONG_FORM },
    threads: {
      read: threadRead("Read one bounded Threads post thread"),
      publish: threadPublish(25, "Publish one root post optionally followed by bounded self-replies"),
    },
  },

  facebook: {
    id: "facebook",
    platform: "facebook",
    facet: "default",
    displayName: "Facebook",
    originPolicy: exactOrigins("https://www.facebook.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "contacts.list", "messaging.read", "comments.read", "posts.read", "media.read"],
      R2: ["reactions.set", "likes.set", "relationships.follow.set", "content.save"],
      R3: [
        "messaging.send",
        "comments.create",
        "replies.create",
        "posts.publish",
        "media.publish",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.edit",
      ],
      unsupported: ["content.schedule"],
      notApplicable: [
        "threads.publish",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "communities.membership.set",
        "communities.membership.manage",
      ],
      R4: [
        "content.delete",
        "content.audience.set",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "document", "link"], "One explicitly selected message attachment"),
      },
      comment: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "link"], "One reviewed personal-profile post attachment"),
      },
      media: {
        text: [field("caption", 1_000, "utf16-code-units", false)],
        attachments: attachments(1, ["image", "video"], "Exactly one reviewed personal-profile media item", 1),
      },
    },
    longForm: {
      read: longForm("posts.read", "expanded-post", "Read one expanded personal-profile post"),
      publish: longForm("posts.publish", "expanded-post", "Publish one expanded personal-profile post"),
    },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  "facebook-page": {
    id: "facebook-page",
    platform: "facebook",
    facet: "page",
    displayName: "Facebook Page",
    originPolicy: exactOrigins("https://www.facebook.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "messaging.read", "comments.read", "posts.read", "media.read"],
      R2: ["reactions.set", "likes.set", "relationships.follow.set", "content.save"],
      R3: [
        "messaging.send",
        "comments.create",
        "replies.create",
        "posts.publish",
        "media.publish",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.edit",
        "content.schedule",
      ],
      unsupported: [],
      notApplicable: [
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "threads.publish",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "communities.membership.set",
        "communities.membership.manage",
      ],
      R4: [
        "content.delete",
        "content.audience.set",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "document", "link"], "One explicitly selected message attachment"),
      },
      comment: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "link"], "One reviewed Page post attachment"),
      },
      media: {
        text: [field("caption", 1_000, "utf16-code-units", false)],
        attachments: attachments(1, ["image", "video"], "Exactly one reviewed Page media item", 1),
      },
    },
    longForm: {
      read: longForm("posts.read", "expanded-post", "Read one expanded Page post"),
      publish: longForm("posts.publish", "expanded-post", "Publish one expanded Page post"),
    },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  "facebook-group": {
    id: "facebook-group",
    platform: "facebook",
    facet: "group",
    displayName: "Facebook Group",
    originPolicy: exactOrigins("https://www.facebook.com"),
    operations: buildOperationMatrix({
      R1: [
        "content.read",
        "content.clip",
        "feeds.read",
        "comments.read",
        "posts.read",
        "media.read",
      ],
      R2: ["reactions.set", "likes.set", "content.save", "communities.membership.set"],
      R3: [
        "comments.create",
        "replies.create",
        "posts.publish",
        "media.publish",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.edit",
      ],
      unsupported: ["content.schedule"],
      notApplicable: [
        "messaging.read",
        "messaging.send",
        "threads.publish",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.follow.set",
        "relationships.connect",
        "commerce.purchase",
      ],
      R4: [
        "content.delete",
        "content.audience.set",
        "communities.membership.manage",
        "administration.manage",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      comment: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["image", "video", "link"], "One reviewed Group post attachment"),
      },
      media: {
        text: [field("caption", 1_000, "utf16-code-units", false)],
        attachments: attachments(1, ["image", "video"], "Exactly one reviewed Group media item", 1),
      },
    },
    longForm: {
      read: longForm("posts.read", "expanded-post", "Read one expanded Group post"),
      publish: longForm("posts.publish", "expanded-post", "Publish one expanded Group post"),
    },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  "facebook-marketplace": {
    id: "facebook-marketplace",
    platform: "facebook",
    facet: "marketplace",
    displayName: "Facebook Marketplace",
    originPolicy: exactOrigins("https://www.facebook.com"),
    operations: buildOperationMatrix({
      R1: [
        "content.read",
        "content.clip",
        "feeds.read",
        "messaging.read",
        "media.read",
        "listings.read",
      ],
      R2: ["content.save"],
      R3: ["messaging.send", "listings.publish", "content.share", "content.edit"],
      unsupported: ["media.publish"],
      notApplicable: [
        "comments.read",
        "comments.create",
        "replies.create",
        "posts.read",
        "posts.publish",
        "threads.publish",
        "reactions.set",
        "likes.set",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "relationships.follow.set",
        "relationships.connect",
        "posts.repost",
        "posts.quote",
        "content.schedule",
        "content.audience.set",
        "communities.membership.set",
        "communities.membership.manage",
        "administration.manage",
      ],
      R4: ["content.delete", "commerce.purchase", "account.delete", "moderation.bulk"],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: noAttachments("Marketplace message attachments are not catalogued"),
      },
      listing: {
        text: [
          field("title", 80, "utf16-code-units"),
          field("body", 1_000, "utf16-code-units"),
          field("price", 24, "unicode-code-points", true, "decimal-amount"),
          field("currency", 3, "unicode-code-points", true, "currency-code"),
          field("category", 120, "unicode-code-points", true, "provider-option"),
          field("condition", 80, "unicode-code-points", true, "provider-option"),
          field("location", 160, "unicode-code-points", true, "location-label"),
          field("delivery", 80, "unicode-code-points", true, "provider-option"),
        ],
        attachments: attachments(4, ["image"], "One to four explicitly selected listing images", 1),
      },
    },
    longForm: { read: NA_LONG_FORM, publish: NA_LONG_FORM },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  tiktok: {
    id: "tiktok",
    platform: "tiktok",
    facet: "default",
    displayName: "TikTok",
    originPolicy: exactOrigins("https://www.tiktok.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "messaging.read", "comments.read", "posts.read", "media.read"],
      R2: ["likes.set", "relationships.follow.set", "content.save"],
      R3: [
        "messaging.send",
        "comments.create",
        "replies.create",
        "posts.publish",
        "media.publish",
        "posts.repost",
        "content.share",
        "content.delete",
        "content.schedule",
      ],
      unsupported: ["content.edit"],
      notApplicable: [
        "reactions.set",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "threads.publish",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "posts.quote",
        "communities.membership.set",
        "communities.membership.manage",
      ],
      R4: [
        "content.audience.set",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "utf16-code-units")],
        attachments: attachments(1, ["video", "link"], "One explicitly selected message attachment"),
      },
      comment: {
        text: [field("body", 100, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 100, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Text-post media is handled as media.publish"),
      },
      media: {
        text: [field("caption", 500, "utf16-code-units", false)],
        attachments: attachments(1, ["image", "video"], "Exactly one reviewed media item", 1),
      },
    },
    longForm: { read: NA_LONG_FORM, publish: NA_LONG_FORM },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  twitch: {
    id: "twitch",
    platform: "twitch",
    facet: "default",
    displayName: "Twitch",
    originPolicy: exactOrigins(
      "https://www.twitch.tv",
      "https://gql.twitch.tv",
    ),
    operations: buildOperationMatrix({
      R1: ["profiles.read"],
      R2: [],
      R3: [],
      unsupported: [
        "content.read",
        "content.clip",
        "organizations.read",
        "contacts.list",
        "contacts.search",
        "feeds.read",
        "messaging.list",
        "messaging.search",
        "messaging.read",
        "messaging.send",
        "comments.read",
        "comments.create",
        "replies.create",
        "posts.read",
        "posts.publish",
        "threads.publish",
        "likes.set",
        "reactions.set",
        "media.read",
        "media.publish",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.recommendations.read",
        "relationships.follow.set",
        "relationships.connect",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.save",
        "content.edit",
        "content.schedule",
        "communities.membership.set",
      ],
      notApplicable: [],
      R4: [
        "content.delete",
        "content.audience.set",
        "communities.membership.manage",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {},
    longForm: {
      read: UNSUPPORTED_LONG_FORM,
      publish: UNSUPPORTED_LONG_FORM,
    },
    threads: {
      read: UNSUPPORTED_THREADS,
      publish: UNSUPPORTED_THREADS,
    },
  },

  youtube: {
    id: "youtube",
    platform: "youtube",
    facet: "default",
    displayName: "YouTube",
    originPolicy: exactOrigins("https://www.youtube.com", "https://studio.youtube.com"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "comments.read", "posts.read", "media.read"],
      R2: ["likes.set", "relationships.follow.set", "content.save"],
      R3: ["comments.create", "replies.create", "posts.publish", "media.publish", "content.edit", "content.delete", "content.schedule"],
      unsupported: [],
      notApplicable: [
        "messaging.read",
        "messaging.send",
        "reactions.set",
        "threads.publish",
        "articles.read",
        "articles.draft.save",
        "articles.publish",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "posts.repost",
        "posts.quote",
        "content.share",
        "communities.membership.set",
        "communities.membership.manage",
      ],
      R4: [
        "content.audience.set",
        "administration.manage",
        "commerce.purchase",
        "account.delete",
        "moderation.bulk",
      ],
    }),
    compositions: {
      comment: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Comment attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: noAttachments("Reply attachments are not catalogued"),
      },
      post: {
        text: [field("body", 500, "utf16-code-units")],
        attachments: attachments(1, ["image"], "One reviewed Community post image"),
      },
      media: {
        text: [field("title", 90, "utf16-code-units"), field("caption", 1_000, "utf16-code-units", false)],
        attachments: attachments(1, ["video"], "Exactly one reviewed video upload", 1),
      },
    },
    longForm: { read: NA_LONG_FORM, publish: NA_LONG_FORM },
    threads: { read: NA_THREADS, publish: NA_THREADS },
  },

  bluesky: {
    id: "bluesky",
    platform: "bluesky",
    facet: "default",
    displayName: "Bluesky",
    originPolicy: exactOrigins("https://bsky.app"),
    operations: buildOperationMatrix({
      R1: ["content.read", "content.clip", "profiles.read", "messaging.read", "comments.read", "posts.read", "media.read"],
      R2: ["likes.set", "relationships.follow.set", "content.save"],
      R3: [
        "messaging.send",
        "replies.create",
        "posts.publish",
        "media.publish",
        "threads.publish",
        "posts.repost",
        "posts.quote",
        "content.share",
        "content.delete",
      ],
      unsupported: ["articles.read", "articles.draft.save", "articles.publish", "content.edit", "content.schedule"],
      notApplicable: [
        "comments.create",
        "reactions.set",
        "listings.read",
        "listings.publish",
        "relationships.connect",
        "content.audience.set",
        "communities.membership.set",
        "communities.membership.manage",
        "commerce.purchase",
      ],
      R4: ["administration.manage", "account.delete", "moderation.bulk"],
    }),
    compositions: {
      message: {
        text: [field("body", 1_000, "unicode-code-points")],
        attachments: noAttachments("Message attachments are not catalogued"),
      },
      reply: {
        text: [field("body", 280, "unicode-code-points")],
        attachments: attachments(1, ["image", "video", "gif", "link"], "One reviewed reply attachment"),
      },
      post: {
        text: [field("body", 280, "unicode-code-points")],
        attachments: attachments(1, ["image", "video", "gif", "link"], "One reviewed post attachment"),
      },
      media: {
        text: [field("body", 280, "unicode-code-points")],
        attachments: attachments(1, ["video"], "Exactly one reviewed video upload", 1),
      },
    },
    longForm: { read: UNSUPPORTED_LONG_FORM, publish: UNSUPPORTED_LONG_FORM },
    threads: {
      read: threadRead("Read one bounded Bluesky post thread"),
      publish: threadPublish(25, "Publish one root post optionally followed by bounded self-replies"),
    },
  },
} as const satisfies Readonly<Record<PlatformSurfaceId, PlatformSurfaceCatalogEntry>>;

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!Number.isInteger(following) || following < 0xdc00 || following > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function weightPolicyIssue(policy: TextWeightPolicy): string | null {
  if (!Number.isSafeInteger(policy.defaultWeight) || policy.defaultWeight < 1) {
    return "Text weights must be positive safe integers";
  }
  if (
    policy.minimumUrlWeight !== undefined
    && (!Number.isSafeInteger(policy.minimumUrlWeight) || policy.minimumUrlWeight < 1)
  ) {
    return "The minimum URL weight must be a positive safe integer";
  }
  let previousEnd = -1;
  for (const range of policy.ranges) {
    if (
      !Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.end)
      || !Number.isSafeInteger(range.weight)
      || range.start < 0
      || range.end > 0x10_ffff
      || range.start > range.end
      || range.start <= previousEnd
      || range.weight < 1
    ) {
      return "Text weight ranges must be ordered, disjoint Unicode ranges with positive safe-integer weights";
    }
    previousEnd = range.end;
  }
  return null;
}

function assertWeightPolicy(policy: TextWeightPolicy): void {
  const issue = weightPolicyIssue(policy);
  if (issue !== null) throw new RangeError(issue);
}

function weightCodePoint(codePoint: number, policy: TextWeightPolicy): number {
  for (const range of policy.ranges) {
    if (codePoint < range.start) break;
    if (codePoint <= range.end) return range.weight;
  }
  return policy.defaultWeight;
}

function rawWeightedLength(text: string, policy: TextWeightPolicy): number {
  let length = 0;
  for (const symbol of text) {
    const codePoint = symbol.codePointAt(0);
    if (codePoint === undefined) continue;
    length += weightCodePoint(codePoint, policy);
    if (!Number.isSafeInteger(length)) throw new RangeError("Weighted text length exceeds the safe integer range");
  }
  return length;
}

type WeightedUnit = { readonly text: string; readonly weight: number };

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const TRAILING_URL_PUNCTUATION = /[!'),.:;?\]}]+$/u;

function* graphemeUnits(text: string, policy: TextWeightPolicy): Generator<WeightedUnit> {
  for (const part of graphemeSegmenter.segment(text)) {
    yield { text: part.segment, weight: rawWeightedLength(part.segment, policy) };
  }
}

function* weightedUnits(text: string, policy: TextWeightPolicy): Generator<WeightedUnit> {
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const index = match.index;
    const matched = match[0];
    if (index > cursor) yield* graphemeUnits(text.slice(cursor, index), policy);

    const trailing = TRAILING_URL_PUNCTUATION.exec(matched)?.[0] ?? "";
    const core = trailing.length === 0 ? matched : matched.slice(0, -trailing.length);
    if (core.length === 0) {
      yield* graphemeUnits(matched, policy);
    } else {
      yield {
        text: core,
        weight: policy.minimumUrlWeight === undefined
          ? rawWeightedLength(core, policy)
          : Math.max(rawWeightedLength(core, policy), policy.minimumUrlWeight),
      };
      if (trailing.length > 0) yield* graphemeUnits(trailing, policy);
    }
    cursor = index + matched.length;
  }
  if (cursor < text.length) yield* graphemeUnits(text.slice(cursor), policy);
}

/** Measure well-formed Unicode without splitting UTF-16 surrogate pairs. */
export function weightedTextLength(text: string, policy: TextWeightPolicy): number {
  if (!hasWellFormedUnicode(text)) throw new TypeError("Text must contain well-formed Unicode");
  assertWeightPolicy(policy);
  let length = 0;
  for (const unit of weightedUnits(text, policy)) {
    length += unit.weight;
    if (!Number.isSafeInteger(length)) throw new RangeError("Weighted text length exceeds the safe integer range");
  }
  return length;
}

export type WeightedThreadChunk = {
  readonly text: string;
  readonly weightedLength: number;
};

export type ThreadSplitResult =
  | { readonly ok: true; readonly chunks: readonly WeightedThreadChunk[] }
  | { readonly ok: false; readonly reason: "invalid-unicode" }
  | { readonly ok: false; readonly reason: "invalid-bounds" }
  | { readonly ok: false; readonly reason: "invalid-weight-policy"; readonly issue: string }
  | {
      readonly ok: false;
      readonly reason: "unit-too-large";
      readonly unit: string;
      readonly unitWeight: number;
    }
  | {
      readonly ok: false;
      readonly reason: "too-many-items";
      readonly maxItems: number;
    };

export type ThreadSplitOptions = {
  readonly maxWeightedLength: number;
  readonly maxItems: number;
  readonly weightPolicy: TextWeightPolicy;
};

/**
 * Greedily split a thread at Unicode grapheme or recognized-URL boundaries.
 * The chunks concatenate to the exact input; numbering and remote publication
 * remain the caller's responsibility.
 */
export function splitWeightedThread(text: string, options: ThreadSplitOptions): ThreadSplitResult {
  if (!hasWellFormedUnicode(text)) return { ok: false, reason: "invalid-unicode" };
  if (
    !Number.isSafeInteger(options.maxWeightedLength)
    || options.maxWeightedLength < 1
    || !Number.isSafeInteger(options.maxItems)
    || options.maxItems < 1
  ) {
    return { ok: false, reason: "invalid-bounds" };
  }
  const weightIssue = weightPolicyIssue(options.weightPolicy);
  if (weightIssue !== null) {
    return { ok: false, reason: "invalid-weight-policy", issue: weightIssue };
  }

  const chunks: WeightedThreadChunk[] = [];
  let currentText = "";
  let currentWeight = 0;

  const push = (): boolean => {
    if (currentText.length === 0) return true;
    if (chunks.length >= options.maxItems) return false;
    chunks.push({ text: currentText, weightedLength: currentWeight });
    currentText = "";
    currentWeight = 0;
    return true;
  };

  for (const unit of weightedUnits(text, options.weightPolicy)) {
    if (unit.weight > options.maxWeightedLength) {
      return { ok: false, reason: "unit-too-large", unit: unit.text, unitWeight: unit.weight };
    }
    if (currentWeight > 0 && currentWeight + unit.weight > options.maxWeightedLength && !push()) {
      return { ok: false, reason: "too-many-items", maxItems: options.maxItems };
    }
    currentText += unit.text;
    currentWeight += unit.weight;
  }

  if (!push()) return { ok: false, reason: "too-many-items", maxItems: options.maxItems };
  return { ok: true, chunks };
}
