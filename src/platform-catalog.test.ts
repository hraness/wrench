import { describe, expect, test } from "bun:test";

import {
  attachmentKinds,
  compositionNames,
  compositionTextFormatNames,
  platformSurfaceIds,
  semanticOperationNames,
  socialPlatformCatalog,
  socialPlatformIds,
  splitWeightedThread,
  textMeasurementNames,
  textWeightPolicies,
  weightedTextLength,
  type CompositionName,
  type PlatformSurfaceId,
  type PlatformSurfaceCatalogEntry,
  type SemanticOperationName,
} from "./platform-catalog";

const surfaces: readonly PlatformSurfaceCatalogEntry[] = Object.values(socialPlatformCatalog);

const r1Operations = new Set<SemanticOperationName>([
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
  "listings.read",
  "relationships.recommendations.read",
]);

const r2Operations = new Set<SemanticOperationName>([
  "reactions.set",
  "likes.set",
  "relationships.follow.set",
  "content.save",
  "communities.membership.set",
]);

const r3Operations = new Set<SemanticOperationName>([
  "messaging.send",
  "comments.create",
  "replies.create",
  "posts.publish",
  "threads.publish",
  "media.publish",
  "articles.publish",
  "listings.publish",
  "relationships.connect",
  "posts.repost",
  "posts.quote",
  "content.share",
  "content.edit",
  "content.schedule",
]);

const r4Operations = new Set<SemanticOperationName>([
  "commerce.purchase",
  "account.delete",
  "moderation.bulk",
  "content.delete",
  "content.audience.set",
  "communities.membership.manage",
  "administration.manage",
]);

type PolicyLane = "R1" | "R2" | "R3" | "R4" | "unsupported" | "not-applicable";

function policyLane(
  policy: PlatformSurfaceCatalogEntry["operations"][SemanticOperationName],
): PolicyLane {
  return policy.state === "adapter-eligible" ? policy.risk : policy.state;
}

type CommonActionContract = {
  readonly messaging: readonly [read: PolicyLane, send: PolicyLane];
  readonly commenting: readonly [read: PolicyLane, create: PolicyLane, reply: PolicyLane];
  readonly posting: readonly [read: PolicyLane, publish: PolicyLane];
  readonly liking: readonly [like: PolicyLane, reaction: PolicyLane];
  readonly media: readonly [read: PolicyLane, publish: PolicyLane];
};

const commonActionContracts = {
  linkedin: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["not-applicable", "R2"],
    media: ["R1", "unsupported"],
  },
  x: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "not-applicable", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "not-applicable"],
    media: ["R1", "unsupported"],
  },
  reddit: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["not-applicable", "R2"],
    media: ["R1", "unsupported"],
  },
  "hacker-news": {
    messaging: ["not-applicable", "not-applicable"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["not-applicable", "R2"],
    media: ["not-applicable", "not-applicable"],
  },
  whatsapp: {
    messaging: ["R1", "R3"],
    commenting: ["not-applicable", "not-applicable", "not-applicable"],
    posting: ["not-applicable", "not-applicable"],
    liking: ["not-applicable", "R2"],
    media: ["R1", "unsupported"],
  },
  substack: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "not-applicable"],
    media: ["R1", "unsupported"],
  },
  instagram: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "not-applicable"],
    liking: ["R2", "R2"],
    media: ["R1", "R3"],
  },
  threads: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "not-applicable", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "not-applicable"],
    media: ["R1", "unsupported"],
  },
  facebook: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "R2"],
    media: ["R1", "R3"],
  },
  "facebook-page": {
    messaging: ["R1", "R3"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "R2"],
    media: ["R1", "R3"],
  },
  "facebook-group": {
    messaging: ["not-applicable", "not-applicable"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "R2"],
    media: ["R1", "R3"],
  },
  "facebook-marketplace": {
    messaging: ["R1", "R3"],
    commenting: ["not-applicable", "not-applicable", "not-applicable"],
    posting: ["not-applicable", "not-applicable"],
    liking: ["not-applicable", "not-applicable"],
    media: ["R1", "unsupported"],
  },
  tiktok: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "not-applicable"],
    media: ["R1", "R3"],
  },
  youtube: {
    messaging: ["not-applicable", "not-applicable"],
    commenting: ["R1", "R3", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "not-applicable"],
    media: ["R1", "R3"],
  },
  bluesky: {
    messaging: ["R1", "R3"],
    commenting: ["R1", "not-applicable", "R3"],
    posting: ["R1", "R3"],
    liking: ["R2", "not-applicable"],
    media: ["R1", "unsupported"],
  },
} as const satisfies Readonly<Record<PlatformSurfaceId, CommonActionContract>>;

const binaryAttachmentCompositions = {
  linkedin: ["message", "post", "article"],
  x: ["message", "reply", "post", "article"],
  reddit: ["post"],
  "hacker-news": [],
  whatsapp: ["message"],
  substack: ["post", "article"],
  instagram: ["message", "media"],
  threads: ["message", "reply", "post"],
  facebook: ["message", "post", "media"],
  "facebook-page": ["message", "post", "media"],
  "facebook-group": ["post", "media"],
  "facebook-marketplace": ["listing"],
  tiktok: ["message", "media"],
  youtube: ["post", "media"],
  bluesky: ["reply", "post"],
} as const satisfies Readonly<Record<PlatformSurfaceId, readonly CompositionName[]>>;

const expandedExecutableOperationNames = [
  "relationships.follow.set",
  "relationships.connect",
  "posts.repost",
  "posts.quote",
  "content.share",
  "content.save",
  "content.edit",
  "content.schedule",
  "communities.membership.set",
  "threads.publish",
] as const satisfies readonly SemanticOperationName[];

type ExpandedExecutableContract = {
  readonly R2: readonly SemanticOperationName[];
  readonly R3: readonly SemanticOperationName[];
};

const expandedExecutableContracts = {
  linkedin: {
    R2: ["relationships.follow.set", "content.save", "communities.membership.set"],
    R3: ["relationships.connect", "posts.repost", "posts.quote", "content.share", "content.edit", "content.schedule"],
  },
  x: {
    R2: ["relationships.follow.set", "content.save", "communities.membership.set"],
    R3: ["posts.repost", "posts.quote", "content.share", "content.edit", "content.schedule", "threads.publish"],
  },
  reddit: {
    R2: ["relationships.follow.set", "content.save", "communities.membership.set"],
    R3: ["posts.repost", "content.share", "content.edit"],
  },
  "hacker-news": { R2: ["content.save"], R3: ["content.edit"] },
  whatsapp: { R2: ["content.save"], R3: ["content.share", "content.edit"] },
  substack: {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["posts.repost", "posts.quote", "content.share", "content.edit", "content.schedule"],
  },
  instagram: {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["posts.repost", "content.share", "content.edit"],
  },
  threads: {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["posts.repost", "posts.quote", "content.share", "content.edit", "threads.publish"],
  },
  facebook: {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["posts.repost", "posts.quote", "content.share", "content.edit"],
  },
  "facebook-page": {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["posts.repost", "posts.quote", "content.share", "content.edit", "content.schedule"],
  },
  "facebook-group": {
    R2: ["content.save", "communities.membership.set"],
    R3: ["posts.repost", "posts.quote", "content.share", "content.edit"],
  },
  "facebook-marketplace": { R2: ["content.save"], R3: ["content.share", "content.edit"] },
  tiktok: {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["posts.repost", "content.share", "content.schedule"],
  },
  youtube: {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["content.edit", "content.schedule"],
  },
  bluesky: {
    R2: ["relationships.follow.set", "content.save"],
    R3: ["posts.repost", "posts.quote", "content.share", "threads.publish"],
  },
} as const satisfies Readonly<Record<PlatformSurfaceId, ExpandedExecutableContract>>;

const neverExecutableOperationNames = [
  "content.delete",
  "content.audience.set",
  "communities.membership.manage",
  "administration.manage",
  "commerce.purchase",
  "account.delete",
  "moderation.bulk",
] as const satisfies readonly SemanticOperationName[];

const compositionOperations = {
  message: "messaging.send",
  comment: "comments.create",
  reply: "replies.create",
  post: "posts.publish",
  media: "media.publish",
  article: "articles.publish",
  listing: "listings.publish",
} as const satisfies Readonly<Record<CompositionName, SemanticOperationName>>;

describe("social platform catalog", () => {
  test("covers every required platform and gives Facebook separate personal, Page, Group, and Marketplace facets", () => {
    expect(Object.keys(socialPlatformCatalog)).toEqual([...platformSurfaceIds]);
    expect(new Set(surfaces.map((surface) => surface.platform))).toEqual(new Set(socialPlatformIds));
    expect(surfaces.filter((surface) => surface.platform === "facebook").map((surface) => surface.facet)).toEqual([
      "default",
      "page",
      "group",
      "marketplace",
    ]);
    expect(surfaces.filter((surface) => surface.platform !== "facebook").every((surface) => surface.facet === "default")).toBeTrue();
  });

  test("declares only exact HTTPS navigation origins", () => {
    for (const surface of surfaces) {
      expect(surface.originPolicy.exactOrigins.length).toBeGreaterThan(0);
      expect(new Set(surface.originPolicy.exactOrigins).size).toBe(surface.originPolicy.exactOrigins.length);
      for (const origin of surface.originPolicy.exactOrigins) {
        const parsed = new URL(origin);
        expect(parsed.protocol).toBe("https:");
        expect(parsed.username).toBe("");
        expect(parsed.password).toBe("");
        expect(parsed.pathname).toBe("/");
        expect(parsed.search).toBe("");
        expect(parsed.hash).toBe("");
        expect(parsed.origin).toBe(origin);
        expect(origin).not.toContain("*");
      }
    }
  });

  test("allows only Substack to add one adapter-declared publication origin", () => {
    for (const surface of surfaces) {
      const additional = surface.originPolicy.additionalExactOrigins;
      if (surface.id === "substack") {
        expect(additional).toMatchObject({
          state: "adapter-declared",
          kind: "publication-origin",
          maxOrigins: 1,
        });
      } else {
        expect(additional).toEqual({ state: "forbidden" });
      }
    }
  });

  test("classifies every semantic operation exactly once on every surface", () => {
    for (const surface of surfaces) {
      expect(Object.keys(surface.operations)).toEqual([...semanticOperationNames]);
    }
  });

  test("pins messaging, commenting, posting, liking, and media contracts for every surface", () => {
    for (const surfaceId of platformSurfaceIds) {
      const operations = socialPlatformCatalog[surfaceId].operations;
      const expected = commonActionContracts[surfaceId];
      expect({
        messaging: [policyLane(operations["messaging.read"]), policyLane(operations["messaging.send"])],
        commenting: [
          policyLane(operations["comments.read"]),
          policyLane(operations["comments.create"]),
          policyLane(operations["replies.create"]),
        ],
        posting: [policyLane(operations["posts.read"]), policyLane(operations["posts.publish"])],
        liking: [policyLane(operations["likes.set"]), policyLane(operations["reactions.set"])],
        media: [policyLane(operations["media.read"]), policyLane(operations["media.publish"])],
      }).toEqual({
        messaging: [...expected.messaging],
        commenting: [...expected.commenting],
        posting: [...expected.posting],
        liking: [...expected.liking],
        media: [...expected.media],
      });
    }
  });

  test("keeps bounded feed and inbox listings explicit and aligned with each native surface", () => {
    for (const surfaceId of platformSurfaceIds) {
      const operations = socialPlatformCatalog[surfaceId].operations;
      if (surfaceId === "facebook-marketplace") {
        expect(policyLane(operations["feeds.read"])).toBe("R1");
      } else {
        expect(policyLane(operations["feeds.read"])).toBe(policyLane(operations["posts.read"]));
      }
      expect(policyLane(operations["messaging.list"])).toBe(policyLane(operations["messaging.read"]));
    }
    expect(socialPlatformCatalog.x.operations["feeds.read"]).toMatchObject({ state: "adapter-eligible", risk: "R1" });
    expect(socialPlatformCatalog.x.operations["messaging.list"]).toMatchObject({ state: "adapter-eligible", risk: "R1" });
  });

  test("enables LinkedIn identity discovery without overclaiming it on other surfaces", () => {
    for (const operation of [
      "profiles.read",
      "organizations.read",
      "relationships.recommendations.read",
    ] as const) {
      expect(socialPlatformCatalog.linkedin.operations[operation]).toMatchObject({
        state: "adapter-eligible",
        risk: "R1",
      });
      for (const surfaceId of platformSurfaceIds) {
        if (surfaceId === "linkedin") continue;
        expect(socialPlatformCatalog[surfaceId].operations[operation].state).toBe("unsupported");
      }
    }
  });

  test("keeps reversible X likes in the reviewed R2 policy lane", () => {
    expect(socialPlatformCatalog.x.operations["likes.set"]).toMatchObject({ state: "adapter-eligible", risk: "R2" });
  });

  test("pins every surface that can bind a binary media attachment", () => {
    for (const surfaceId of platformSurfaceIds) {
      const surface: PlatformSurfaceCatalogEntry = socialPlatformCatalog[surfaceId];
      const actual = compositionNames.filter((name) => {
        const attachmentPolicy = surface.compositions[name]?.attachments;
        return attachmentPolicy?.state === "allowed"
          && attachmentPolicy.kinds.some((kind) => kind !== "link");
      });
      expect(actual).toEqual([...binaryAttachmentCompositions[surfaceId]]);
    }
  });

  test("pins expanded relationship, distribution, save, edit, schedule, membership, and thread actions", () => {
    for (const surfaceId of platformSurfaceIds) {
      const operations = socialPlatformCatalog[surfaceId].operations;
      const actual = {
        R2: expandedExecutableOperationNames.filter((name) => policyLane(operations[name]) === "R2"),
        R3: expandedExecutableOperationNames.filter((name) => policyLane(operations[name]) === "R3"),
      };
      const expected = expandedExecutableContracts[surfaceId];
      expect(actual).toEqual({ R2: [...expected.R2], R3: [...expected.R3] });
    }
  });

  test("never makes destructive, audience, member-admin, financial, or administrative actions executable", () => {
    for (const surface of surfaces) {
      for (const operationName of neverExecutableOperationNames) {
        expect(surface.operations[operationName].state).not.toBe("adapter-eligible");
      }
      expect(surface.operations["content.delete"]).toMatchObject({ state: "R4", risk: "R4" });
    }
  });

  test("keeps read, reversible, outward, and forbidden risks in their semantic lanes", () => {
    const states = new Set<string>();
    for (const surface of surfaces) {
      for (const [name, policy] of Object.entries(surface.operations) as [SemanticOperationName, PlatformSurfaceCatalogEntry["operations"][SemanticOperationName]][]) {
        states.add(policy.state);
        if (policy.state === "adapter-eligible") {
          if (policy.risk === "R1") expect(r1Operations.has(name)).toBeTrue();
          if (policy.risk === "R2") expect(r2Operations.has(name)).toBeTrue();
          if (policy.risk === "R3") expect(r3Operations.has(name)).toBeTrue();
        } else if (policy.state === "R4") {
          expect(policy.risk).toBe("R4");
          expect(r4Operations.has(name)).toBeTrue();
        }
      }
    }
    expect(states).toEqual(new Set(["adapter-eligible", "unsupported", "not-applicable", "R4"]));
  });

  test("provides one bounded composition policy for every eligible publishing operation", () => {
    for (const surface of surfaces) {
      for (const name of compositionNames) {
        const operation = surface.operations[compositionOperations[name]];
        const composition = surface.compositions[name];
        expect(composition !== undefined).toBe(operation.state === "adapter-eligible");
        if (composition === undefined) continue;

        expect(composition.text.length).toBeGreaterThan(0);
        expect(new Set(composition.text.map((text) => text.name)).size).toBe(composition.text.length);
        for (const text of composition.text) {
          expect(Number.isSafeInteger(text.safeMaxUnits)).toBeTrue();
          expect(text.safeMaxUnits).toBeGreaterThan(0);
          expect(text.safeMaxUnits).toBeLessThanOrEqual(125_000);
          expect(textMeasurementNames).toContain(text.measurement);
          expect(compositionTextFormatNames).toContain(text.format);
        }

        if (composition.attachments.state === "allowed") {
          expect(Number.isSafeInteger(composition.attachments.minItems)).toBeTrue();
          expect(Number.isSafeInteger(composition.attachments.maxItems)).toBeTrue();
          expect(composition.attachments.minItems).toBeGreaterThanOrEqual(0);
          expect(composition.attachments.maxItems).toBeGreaterThanOrEqual(composition.attachments.minItems);
          expect(composition.attachments.maxItems).toBeLessThanOrEqual(20);
          expect(composition.attachments.kinds.length).toBeGreaterThan(0);
          expect(new Set(composition.attachments.kinds).size).toBe(composition.attachments.kinds.length);
          expect(composition.attachments.kinds.every((kind) => attachmentKinds.includes(kind))).toBeTrue();
        }
      }
    }
    expect(socialPlatformCatalog.linkedin.compositions.post?.attachments).toMatchObject({ state: "allowed", maxItems: 20 });
    expect(socialPlatformCatalog.x.compositions.post?.attachments).toMatchObject({ state: "allowed", maxItems: 4 });
  });

  test("requires a conservative provider-neutral Marketplace listing shape", () => {
    const listing = socialPlatformCatalog["facebook-marketplace"].compositions.listing;
    expect(listing).toBeDefined();
    if (listing === undefined) return;

    expect(listing.text.map(({ name, required, safeMaxUnits, format }) => ({
      name,
      required,
      safeMaxUnits,
      format,
    }))).toEqual([
      { name: "title", required: true, safeMaxUnits: 80, format: "plain-text" },
      { name: "body", required: true, safeMaxUnits: 1_000, format: "plain-text" },
      { name: "price", required: true, safeMaxUnits: 24, format: "decimal-amount" },
      { name: "currency", required: true, safeMaxUnits: 3, format: "currency-code" },
      { name: "category", required: true, safeMaxUnits: 120, format: "provider-option" },
      { name: "condition", required: true, safeMaxUnits: 80, format: "provider-option" },
      { name: "location", required: true, safeMaxUnits: 160, format: "location-label" },
      { name: "delivery", required: true, safeMaxUnits: 80, format: "provider-option" },
    ]);
    expect(listing.attachments).toMatchObject({
      state: "allowed",
      minItems: 1,
      maxItems: 4,
      kinds: ["image"],
    });
  });

  test("references only eligible operations from native long-form and thread policies", () => {
    for (const surface of surfaces) {
      for (const access of [surface.longForm.read, surface.longForm.publish]) {
        if (access.state === "adapter-eligible") {
          expect(surface.operations[access.operation].state).toBe("adapter-eligible");
        }
      }
      if (surface.threads.read.state === "adapter-eligible") {
        expect(surface.operations[surface.threads.read.operation].state).toBe("adapter-eligible");
      }
      if (surface.threads.publish.state === "adapter-eligible") {
        expect(surface.threads.publish.operation).toBe("threads.publish");
        expect(surface.operations[surface.threads.publish.operation]).toMatchObject({ state: "adapter-eligible", risk: "R3" });
        expect(surface.operations[surface.threads.publish.rootOperation]).toMatchObject({ state: "adapter-eligible", risk: "R3" });
        expect(surface.operations[surface.threads.publish.continuationOperation]).toMatchObject({ state: "adapter-eligible", risk: "R3" });
        expect(surface.threads.publish.safeMaxItems).toBeGreaterThan(1);
        expect(surface.threads.publish.safeMaxItems).toBeLessThanOrEqual(25);
      } else {
        expect(surface.operations["threads.publish"].state).toBe(surface.threads.publish.state);
      }
    }
  });

  test("catalogues ordered bounded thread publishing only on X, Threads, and Bluesky", () => {
    const eligible = platformSurfaceIds.filter((surfaceId) => (
      socialPlatformCatalog[surfaceId].operations["threads.publish"].state === "adapter-eligible"
    ));
    expect(eligible).toEqual(["x", "threads", "bluesky"]);
  });

  test("catalogues official native long-form publishing only where a reviewed route exists", () => {
    for (const surfaceId of ["linkedin", "x", "substack"] as const) {
      const surface = socialPlatformCatalog[surfaceId];
      expect(surface.operations["articles.publish"]).toMatchObject({
        state: "adapter-eligible",
        risk: "R3",
      });
      expect(surface.compositions.article).toBeDefined();
      expect(surface.longForm.publish).toMatchObject({
        state: "adapter-eligible",
        operation: "articles.publish",
        form: "native-article",
      });
    }
  });

  test("contains policy only, with no selectors, request endpoints, or credential mechanisms", () => {
    const serialized = JSON.stringify(socialPlatformCatalog).toLowerCase();
    for (const forbidden of ["selector", "xpath", "document.query", "javascript", "cookie", "authorization header", "api endpoint"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("weighted Unicode helpers", () => {
  test("uses code points, UTF-16 units, and conservative X weights explicitly", () => {
    expect(weightedTextLength("A🙂", textWeightPolicies["unicode-code-points"])).toBe(2);
    expect(weightedTextLength("A🙂", textWeightPolicies["utf16-code-units"])).toBe(3);
    expect(weightedTextLength("A🙂", textWeightPolicies["x-conservative-weighted"])).toBe(3);
    expect(weightedTextLength("https://x.co", textWeightPolicies["x-conservative-weighted"])).toBe(23);
    expect(weightedTextLength("https://x.co.", textWeightPolicies["x-conservative-weighted"])).toBe(24);
  });

  test("never splits a grapheme cluster", () => {
    const family = "👨‍👩‍👧‍👦";
    const policy = textWeightPolicies["x-conservative-weighted"];
    const familyWeight = weightedTextLength(family, policy);
    const result = splitWeightedThread(`${family}${family}`, {
      maxWeightedLength: familyWeight,
      maxItems: 2,
      weightPolicy: policy,
    });
    expect(result).toEqual({
      ok: true,
      chunks: [
        { text: family, weightedLength: familyWeight },
        { text: family, weightedLength: familyWeight },
      ],
    });
  });

  test("never splits a recognized URL even when the policy has no URL weight override", () => {
    const url = "https://example.com/a-long-path";
    const result = splitWeightedThread(url, {
      maxWeightedLength: 10,
      maxItems: 10,
      weightPolicy: textWeightPolicies["unicode-code-points"],
    });
    expect(result).toEqual({
      ok: false,
      reason: "unit-too-large",
      unit: url,
      unitWeight: [...url].length,
    });
  });

  test("rejects malformed Unicode, invalid bounds, oversized units, and too many chunks", () => {
    const policy = textWeightPolicies["unicode-code-points"];
    expect(() => weightedTextLength("\ud800", policy)).toThrow("well-formed Unicode");
    expect(splitWeightedThread("\ud800", { maxWeightedLength: 10, maxItems: 1, weightPolicy: policy })).toEqual({
      ok: false,
      reason: "invalid-unicode",
    });
    expect(splitWeightedThread("a", { maxWeightedLength: 0, maxItems: 1, weightPolicy: policy })).toEqual({
      ok: false,
      reason: "invalid-bounds",
    });
    const invalidPolicy = { defaultWeight: 0, ranges: [] } as const;
    expect(() => weightedTextLength("a", invalidPolicy)).toThrow("positive safe integers");
    expect(splitWeightedThread("a", { maxWeightedLength: 1, maxItems: 1, weightPolicy: invalidPolicy })).toEqual({
      ok: false,
      reason: "invalid-weight-policy",
      issue: "Text weights must be positive safe integers",
    });
    expect(splitWeightedThread("e\u0301", { maxWeightedLength: 1, maxItems: 2, weightPolicy: policy })).toEqual({
      ok: false,
      reason: "unit-too-large",
      unit: "e\u0301",
      unitWeight: 2,
    });
    expect(splitWeightedThread("abc", { maxWeightedLength: 1, maxItems: 2, weightPolicy: policy })).toEqual({
      ok: false,
      reason: "too-many-items",
      maxItems: 2,
    });
  });

  test("preserves empty text without inventing an empty remote post", () => {
    expect(splitWeightedThread("", {
      maxWeightedLength: 280,
      maxItems: 25,
      weightPolicy: textWeightPolicies["x-conservative-weighted"],
    })).toEqual({ ok: true, chunks: [] });
  });
});
