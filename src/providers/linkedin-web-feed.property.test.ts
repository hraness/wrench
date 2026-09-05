import { expect, test } from "bun:test";
import { assertProperty, fc } from "../test-support";

import {
  LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX,
  encodeLinkedInProfileActivityCursor,
  linkedInProfileActivityPageUrl,
  linkedInProfileActivityTargetFromVanity,
  parseLinkedInProfileActivityCursor,
  projectLinkedInProfileActivityPage,
} from "./linkedin-web-feed";

const HEX = "0123456789abcdef";
const vanity = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/u);
const start = fc.integer({ min: 0, max: 10_000 });
const queryHash = fc
  .array(fc.constantFrom(...HEX), { minLength: 32, maxLength: 32 })
  .map((characters) => characters.join(""));
const profileUrn = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$/u)
  .map((value) => `urn:li:fsd_profile:${value}`);

test("LinkedIn profile-activity cursors round-trip the requested vanity and start", () => {
  assertProperty(fc.property(vanity, start, (slug, offset) => {
    const encoded = encodeLinkedInProfileActivityCursor({ slug, start: offset });
    expect(parseLinkedInProfileActivityCursor(encoded, slug)).toEqual({
      slug: slug.toLowerCase(),
      start: offset,
    });
  }));
});

test("LinkedIn profile-activity page URLs bind exactly one registered query and profile URN", () => {
  assertProperty(fc.property(
    queryHash,
    profileUrn,
    fc.integer({ min: 1, max: 100 }),
    start,
    (hash, urn, count, offset) => {
      const url = linkedInProfileActivityPageUrl({
        queryId: `${LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX}.${hash}`,
        profileUrn: urn,
        count,
        start: offset,
      });
      expect(url.searchParams.get("queryId")).toBe(
        `${LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX}.${hash}`,
      );
      expect(url.searchParams.get("variables")).toBe(
        `(count:${count},profileUrn:${urn},start:${offset})`,
      );
    },
  ));
});

test("LinkedIn profile-activity projection never invents engagement counts", () => {
  assertProperty(fc.property(
    fc.integer({ min: 10, max: 20 }).map((value) => String(7_123_456_789_012_345_000n + BigInt(value))),
    fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
    (activityId, likes) => {
      const activityUrn = `urn:li:activity:${activityId}`;
      const updateUrn = `urn:li:fsd_update:(${activityUrn},FEED_DETAIL,EMPTY,DEFAULT,false)`;
      const included: unknown[] = [{
        $type: "com.linkedin.voyager.dash.feed.Update",
        entityUrn: updateUrn,
        commentary: { text: { text: "property" } },
        resharedUpdate: null,
      }];
      if (likes !== undefined) {
        included.push({
          $type: "com.linkedin.voyager.dash.feed.SocialActivityCounts",
          urn: activityUrn,
          numLikes: likes,
        });
      }
      const page = projectLinkedInProfileActivityPage({
        response: {
          data: {
            data: {
              feedDashProfileUpdatesByMemberFeed: {
                $type: "com.linkedin.restli.common.CollectionResponse",
                "*elements": [updateUrn],
                paging: { count: 10, start: 0, total: 1, links: [] },
              },
            },
          },
          included,
        },
        target: linkedInProfileActivityTargetFromVanity("j-hawkins"),
        queryId: `${LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX}.7f16f6612fc18a3623688ca7a74d7696`,
        profileUrn: "urn:li:fsd_profile:ACoAAPropertyProfile",
        limit: 10,
        start: 0,
        observedAt: "2026-09-04T19:35:00.000Z",
      });
      expect(page.posts).toHaveLength(1);
      expect(page.posts[0]?.reactionCount).toBe(likes ?? null);
      expect(page.posts[0]?.commentCount).toBeNull();
      expect(page.posts[0]?.repostCount).toBeNull();
    },
  ));
});
