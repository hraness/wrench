import { describe, expect, test } from "bun:test";

import {
  LINKEDIN_PROFILE_ACTIVITY_CURSOR_PREFIX,
  LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX,
  assertLinkedInProfileActivityRequest,
  encodeLinkedInProfileActivityCursor,
  linkedInProfileActivityFeed,
  linkedInProfileActivityInputIssues,
  linkedInProfileActivityPageUrl,
  linkedInProfileActivityTarget,
  linkedInProfileActivityTargetFromUrl,
  linkedInProfileActivityVariables,
  parseLinkedInProfileActivityCursor,
  projectLinkedInProfileActivityPage,
  resolveLinkedInProfileActivityBinding,
} from "./linkedin-web-feed";

const QUERY_HASH = "7f16f6612fc18a3623688ca7a74d7696";
const QUERY_ID = `${LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX}.${QUERY_HASH}`;
const PROFILE_URN = "urn:li:fsd_profile:ACoAAExactTargetProfile";
const ACTIVITY_URN = "urn:li:activity:7123456789012345678";
const UPDATE_URN = `urn:li:fsd_update:(${ACTIVITY_URN},FEED_DETAIL,EMPTY,DEFAULT,false)`;
const OBSERVED_AT = "2026-09-04T19:35:00.000Z";

const target = linkedInProfileActivityTarget({ vanity: "j-hawkins" });

function updateEntity(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    $type: "com.linkedin.voyager.dash.feed.Update",
    entityUrn: UPDATE_URN,
    commentary: {
      text: { text: "A public LinkedIn post about humor corpora." },
    },
    actor: {
      name: { text: "Jane Hawkins" },
      navigationContext: { actionTarget: "https://www.linkedin.com/in/j-hawkins" },
      urn: PROFILE_URN,
      subDescription: { text: "2d" },
    },
    metadata: {
      shareUrn: "urn:li:share:7123456789012345678",
      createdAt: 1_725_000_000_000,
    },
    resharedUpdate: null,
    ...overrides,
  };
}

function countsEntity(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    $type: "com.linkedin.voyager.dash.feed.SocialActivityCounts",
    urn: ACTIVITY_URN,
    numLikes: 42,
    numComments: 5,
    numShares: 1,
    ...overrides,
  };
}

function pageResponse(
  updates: readonly Readonly<Record<string, unknown>>[],
  included: readonly Readonly<Record<string, unknown>>[],
  paging: Readonly<Record<string, unknown>> | null = {
    count: updates.length,
    start: 0,
    links: [],
  },
): unknown {
  return {
    data: {
      data: {
        feedDashProfileUpdatesByMemberFeed: {
          $type: "com.linkedin.restli.common.CollectionResponse",
          "*elements": updates.map((update) => update.entityUrn),
          ...(paging === null ? {} : { paging }),
        },
      },
    },
    included: [...updates, ...included],
  };
}

describe("LinkedIn profile-activity targets", () => {
  test("accepts a profile URL, activity path, or vanity and normalizes one slug", () => {
    expect(linkedInProfileActivityTargetFromUrl("https://www.linkedin.com/in/j-hawkins/")).toEqual(target);
    expect(linkedInProfileActivityTargetFromUrl(
      "https://www.linkedin.com/in/J-Hawkins/recent-activity/all/",
    )).toEqual(target);
    expect(linkedInProfileActivityTarget({ vanity: "J-Hawkins" })).toEqual(target);
    expect(linkedInProfileActivityTarget({
      profile_url: "https://www.linkedin.com/in/j-hawkins/recent-activity/all",
      vanity: "j-hawkins",
    })).toEqual(target);
  });

  test("rejects mismatched vanity and URL, foreign hosts, and query strings", () => {
    expect(() => linkedInProfileActivityTarget({
      profile_url: "https://www.linkedin.com/in/j-hawkins/",
      vanity: "varunr96",
    })).toThrow("named different profiles");
    expect(() => linkedInProfileActivityTargetFromUrl("https://www.linkedin.com/feed/"))
      .toThrow("unsupported path");
    expect(() => linkedInProfileActivityTargetFromUrl(
      "https://www.linkedin.com/in/j-hawkins/?trk=public",
    )).toThrow("exact public LinkedIn origin");
    expect(() => linkedInProfileActivityTarget({})).toThrow("requires profile_url or vanity");
  });
});

describe("LinkedIn profile-activity cursors and requests", () => {
  test("round-trips a reviewed start cursor bound to the requested vanity", () => {
    const encoded = encodeLinkedInProfileActivityCursor({ slug: "j-hawkins", start: 20 });
    expect(encoded).toBe(`${LINKEDIN_PROFILE_ACTIVITY_CURSOR_PREFIX}:j-hawkins:20`);
    expect(parseLinkedInProfileActivityCursor(encoded, "J-Hawkins")).toEqual({
      slug: "j-hawkins",
      start: 20,
    });
    expect(parseLinkedInProfileActivityCursor(undefined, "j-hawkins")).toEqual({
      slug: "j-hawkins",
      start: 0,
    });
    expect(() => parseLinkedInProfileActivityCursor(encoded, "varunr96"))
      .toThrow("does not match the requested profile");
  });

  test("builds and gates the exact GraphQL page request", () => {
    const url = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 20,
    });
    expect(url.pathname).toBe("/voyager/api/graphql");
    expect(url.searchParams.get("includeWebMetadata")).toBe("true");
    expect(url.searchParams.get("queryId")).toBe(QUERY_ID);
    expect(url.searchParams.get("variables")).toBe(
      `(count:10,start:20,profileUrn:${PROFILE_URN})`,
    );
    expect(url.search).toBe(
      `?includeWebMetadata=true&queryId=${encodeURIComponent(QUERY_ID)}&variables=(count:10,start:20,profileUrn:urn%3Ali%3Afsd_profile%3AACoAAExactTargetProfile)`,
    );
    expect(() => assertLinkedInProfileActivityRequest({ method: "GET", url }, {
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 20,
    })).not.toThrow();
    expect(() => assertLinkedInProfileActivityRequest({ method: "GET", url }, {
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    })).toThrow("request binding changed");
  });

  test("resolves one observed query ID and profile URN and fails closed on ambiguity", () => {
    const url = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    });
    expect(resolveLinkedInProfileActivityBinding([
      { method: "GET", status: 200, url: url.href },
      { method: "GET", status: 200, url: url.href },
    ])).toEqual({ queryId: QUERY_ID, profileUrn: PROFILE_URN });
    expect(() => resolveLinkedInProfileActivityBinding([])).toThrow("was not found");
    const other = linkedInProfileActivityPageUrl({
      queryId: `${LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX}.8f05a4e5ad12d9cb2b56eaa22afbcab9`,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 0,
    });
    expect(() => resolveLinkedInProfileActivityBinding([
      { method: "GET", status: 200, url: url.href },
      { method: "GET", status: 200, url: other.href },
    ])).toThrow("is ambiguous");
  });

  test("parses Rest.li activity variables without inventing omitted start", () => {
    expect(linkedInProfileActivityVariables(`(count:10,profileUrn:${PROFILE_URN},start:20)`))
      .toEqual({ profileUrn: PROFILE_URN, count: 10, start: 20 });
    expect(linkedInProfileActivityVariables(`(profileUrn:${PROFILE_URN})`))
      .toEqual({ profileUrn: PROFILE_URN, count: null, start: null });
  });
});

describe("LinkedIn profile-activity projection", () => {
  test("projects authored text, engagement, media, and a next cursor when the page is full", () => {
    const nextPage = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 1,
      start: 1,
    });
    const page = projectLinkedInProfileActivityPage({
      response: pageResponse([updateEntity({
        imageComponent: { images: [{}] },
      })], [countsEntity()], {
        count: 1,
        start: 0,
        links: [{ rel: "next", href: nextPage.href }],
      }),
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 1,
      start: 0,
      observedAt: OBSERVED_AT,
    });
    expect(page).toMatchObject({
      schemaVersion: 1,
      provider: "linkedin",
      feed: "profile-activity",
      profile: {
        vanity: "j-hawkins",
        profileUrn: PROFILE_URN,
        url: "https://www.linkedin.com/in/j-hawkins/",
      },
      complete: false,
      nextCursor: `${LINKEDIN_PROFILE_ACTIVITY_CURSOR_PREFIX}:j-hawkins:1`,
    });
    expect(page.posts).toEqual([{
      activityUrn: ACTIVITY_URN,
      postUrn: "urn:li:share:7123456789012345678",
      url: `https://www.linkedin.com/feed/update/${ACTIVITY_URN}/`,
      authorVanity: "j-hawkins",
      authorUrn: PROFILE_URN,
      text: "A public LinkedIn post about humor corpora.",
      textComplete: true,
      createdAt: "2024-08-30T06:40:00.000Z",
      relativeTime: "2d",
      reactionCount: 42,
      commentCount: 5,
      repostCount: 1,
      hasMedia: true,
      kind: "original",
    }]);
    expect(page.items).toEqual([{
      activity_urn: ACTIVITY_URN,
      url: `https://www.linkedin.com/feed/update/${ACTIVITY_URN}/`,
    }]);
  });

  test("marks a reshare without attributing the original commentary and leaves missing counts null", () => {
    const page = projectLinkedInProfileActivityPage({
      response: pageResponse([updateEntity({
        commentary: { text: { text: "My quote." } },
        resharedUpdate: {
          commentary: { text: { text: "Original poster text that must not be attributed." } },
        },
        metadata: { createdAt: 1_725_000_000_000 },
      })], [], {
        count: 10,
        start: 0,
        total: 1,
        links: [],
      }),
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 10,
      start: 0,
      observedAt: OBSERVED_AT,
    });
    expect(page.complete).toBeTrue();
    expect(page.nextCursor).toBeNull();
    expect(page.posts[0]).toMatchObject({
      text: "My quote.",
      kind: "reshare",
      reactionCount: null,
      commentCount: null,
      repostCount: null,
      hasMedia: false,
    });
  });

  test("reports unknown completeness without inventing a cursor when paging is omitted", () => {
    const page = projectLinkedInProfileActivityPage({
      response: pageResponse([updateEntity()], [], null),
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 10,
      start: 0,
      observedAt: OBSERVED_AT,
    });
    expect(page.complete).toBeFalse();
    expect(page.nextCursor).toBeNull();
    expect(page.posts[0]?.reactionCount).toBeNull();
  });

  test("fails closed when an empty provider page claims or implies continuation", () => {
    expect(() => projectLinkedInProfileActivityPage({
      response: pageResponse([], [], null),
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 10,
      start: 20,
      observedAt: OBSERVED_AT,
    })).toThrow("did not advance its cursor");
    expect(() => projectLinkedInProfileActivityPage({
      response: pageResponse([], [], {
        count: 10,
        start: 20,
        links: [{
          rel: "next",
          href: linkedInProfileActivityPageUrl({
            queryId: QUERY_ID,
            profileUrn: PROFILE_URN,
            count: 10,
            start: 30,
          }).href,
        }],
      }),
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 10,
      start: 20,
      observedAt: OBSERVED_AT,
    })).toThrow("did not advance its cursor");
  });

  test("binds paging metadata and links to the exact requested collection", () => {
    const project = (paging: Readonly<Record<string, unknown>>) =>
      projectLinkedInProfileActivityPage({
        response: pageResponse([updateEntity()], [], paging),
        target,
        queryId: QUERY_ID,
        profileUrn: PROFILE_URN,
        limit: 10,
        start: 20,
        observedAt: OBSERVED_AT,
      });
    const nextPage = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 30,
    });
    expect(() => project({ count: 10, start: 0, links: [] }))
      .toThrow("did not bind the exact requested page");
    expect(() => project({ count: 1, start: 20, links: [] }))
      .toThrow("did not bind the exact requested page");
    expect(() => project({ count: 10, start: 20, links: {} }))
      .toThrow("links were invalid");
    expect(() => project({
      count: 10,
      start: 20,
      links: [{ rel: "next", href: nextPage.href }],
    })).toThrow("linked past a terminal short page");
    const foreign = new URL(nextPage);
    foreign.hostname = "example.com";
    expect(() => project({
      count: 10,
      start: 20,
      links: [{ rel: "next", href: foreign.href }],
    })).toThrow("changed the exact collection");
    const foreignQuery = linkedInProfileActivityPageUrl({
      queryId: `${LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX}.8f05a4e5ad12d9cb2b56eaa22afbcab9`,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 30,
    });
    expect(() => project({
      count: 10,
      start: 20,
      links: [{ rel: "next", href: foreignQuery.href }],
    })).toThrow("changed the exact collection");
    const repeated = linkedInProfileActivityPageUrl({
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      count: 10,
      start: 20,
    });
    expect(() => project({
      count: 10,
      start: 20,
      links: [{ rel: "next", href: repeated.href }],
    })).toThrow("changed the exact collection");
    expect(() => project({
      count: 10,
      start: 20,
      total: 31,
      links: [],
    })).toThrow("page length contradicted its paging total");
  });

  test("fails closed on an over-limit provider page, conflicting counts, and missing updates", () => {
    const second = updateEntity({
      entityUrn: "urn:li:fsd_update:(urn:li:activity:7123456789012345679,FEED_DETAIL,EMPTY,DEFAULT,false)",
    });
    expect(() => projectLinkedInProfileActivityPage({
      response: pageResponse([updateEntity(), second], []),
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 1,
      start: 0,
      observedAt: OBSERVED_AT,
    })).toThrow("exceeded the requested limit");
    expect(() => projectLinkedInProfileActivityPage({
      response: pageResponse([updateEntity()], [
        countsEntity({
          urn: `urn:li:fsd_socialActivityCounts:(${ACTIVITY_URN},LIKE)`,
          numLikes: 42,
        }),
        countsEntity({
          urn: `urn:li:fsd_socialActivityCounts:(${ACTIVITY_URN},COMMENT)`,
          numLikes: 7,
        }),
      ]),
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 10,
      start: 0,
      observedAt: OBSERVED_AT,
    })).toThrow("conflict for one activity URN");
    expect(() => projectLinkedInProfileActivityPage({
      response: {
        data: {
          data: {
            feedDashProfileUpdatesByMemberFeed: {
              $type: "com.linkedin.restli.common.CollectionResponse",
              "*elements": [UPDATE_URN],
              paging: { count: 1, start: 0, links: [] },
            },
          },
        },
        included: [],
      },
      target,
      queryId: QUERY_ID,
      profileUrn: PROFILE_URN,
      limit: 10,
      start: 0,
      observedAt: OBSERVED_AT,
    })).toThrow("omitted a referenced update");
  });
});

describe("LinkedIn profile-activity input issues", () => {
  test("keeps home free of profile selectors and requires a profile-activity target", () => {
    expect(linkedInProfileActivityFeed("profile-activity")).toBe("profile-activity");
    expect(linkedInProfileActivityInputIssues({
      feed: "home",
      profile_url: "https://www.linkedin.com/in/j-hawkins/",
    })).toContain("input.profile_url is not accepted for the capture-required home feed");
    expect(linkedInProfileActivityInputIssues({ feed: "profile-activity" }))
      .toContain("LinkedIn profile-activity feed requires profile_url or vanity");
    expect(linkedInProfileActivityInputIssues({
      feed: "profile-activity",
      vanity: "j-hawkins",
    })).toEqual([]);
  });
});
