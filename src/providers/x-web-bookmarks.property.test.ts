import { expect, test } from "bun:test";
import { assertProperty, fc } from "../test-support";

import {
  normalizeXWebUrtTimeline,
  parseXWebBookmarkExportPage,
  parseXWebBookmarkExportRecord,
  projectXWebBookmarkExportPage,
  projectXWebBookmarkExportRecord,
  projectXWebFeedPost,
} from "./x-web";

const createdAt = "Tue Jul 22 12:00:00 +0000 2026";

function tweetResult(
  id: string,
  author: { readonly id: string; readonly username: string; readonly name: string },
  text: string,
): unknown {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: {
      user_results: {
        result: {
          __typename: "User",
          rest_id: author.id,
          core: { name: author.name, screen_name: author.username },
        },
      },
    },
    legacy: {
      full_text: text,
      created_at: createdAt,
      user_id_str: author.id,
    },
  };
}

function timelineItem(id: string, result: unknown): unknown {
  return {
    entryId: `tweet-${id}`,
    sortIndex: id,
    content: {
      entryType: "TimelineTimelineItem",
      itemContent: {
        itemType: "TimelineTweet",
        tweet_results: { result },
      },
    },
  };
}

function cursorEntry(value: string): unknown {
  return {
    entryId: "cursor-bottom",
    sortIndex: "1",
    content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value },
  };
}

function bookmarksResponse(entries: readonly unknown[]): unknown {
  return {
    data: {
      bookmark_timeline_v2: {
        timeline: { instructions: [{ type: "TimelineAddEntries", entries }] },
      },
    },
  };
}

const postIdArb = fc.stringMatching(/^[1-9][0-9]{0,18}$/u);
const handleArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,14}$/u);
const nameArb = fc.string({ minLength: 1, maxLength: 40 }).filter((value) =>
  !/[\u0000-\u001f\u007f]/u.test(value)
);
const textArb = fc.string({ minLength: 0, maxLength: 80 }).filter((value) =>
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
);
const asciiTextArb = fc
  .array(fc.integer({ min: 0, max: 0x7f }), { maxLength: 40 })
  .map((codes) => String.fromCharCode(...codes));
const cursorArb = fc.uuid().map((value) => `bookmark-cursor-${value}`);

test("bookmark export records keep post_id equal to the tweet rest_id and round-trip", () => {
  assertProperty(fc.property(
    postIdArb,
    postIdArb,
    handleArb,
    nameArb,
    textArb,
    (postId, authorId, username, name, text) => {
      const normalized = normalizeXWebUrtTimeline({
        instructions: [{
          type: "TimelineAddEntries",
          entries: [timelineItem(postId, tweetResult(postId, { id: authorId, username, name }, text))],
        }],
      });
      expect(normalized.items).toHaveLength(1);
      const post = projectXWebFeedPost(normalized.items[0]!);
      expect(post).not.toBeNull();
      expect(post!.id).toBe(postId);
      const record = projectXWebBookmarkExportRecord(post!);
      expect(record.post_id).toBe(postId);
      expect(record.url).toBe(`https://x.com/i/status/${postId}`);
      expect(record.author_username).toBe(username.toLowerCase());
      expect(record.author_name).toBe(name);
      expect(record.text).toBe(text);
      expect(record.folder_id).toBeNull();
      expect(record.bookmarked_at).toBeNull();
      expect(parseXWebBookmarkExportRecord(record)).toEqual(record);
    },
  ));
});

test("bookmark pages preserve unique post_id order and never leak a truncated cursor", () => {
  assertProperty(fc.property(
    fc.uniqueArray(
      fc.record({
        id: postIdArb,
        authorId: postIdArb,
        username: handleArb,
        name: nameArb,
        text: textArb,
      }),
      { minLength: 1, maxLength: 8, selector: (item) => item.id },
    ),
    cursorArb,
    fc.integer({ min: 1, max: 8 }),
    (rows, cursor, limit) => {
      const response = bookmarksResponse([
        ...rows.map((row) => timelineItem(row.id, tweetResult(
          row.id,
          { id: row.authorId, username: row.username, name: row.name },
          row.text,
        ))),
        cursorEntry(cursor),
      ]);
      const page = projectXWebBookmarkExportPage(response, limit);
      expect(page.feed).toBe("bookmarks");
      expect(page.items.map((item) => item.post_id)).toEqual(rows.slice(0, limit).map((row) => row.id));
      expect(new Set(page.items.map((item) => item.post_id)).size).toBe(page.items.length);
      if (rows.length > limit) {
        expect(page.cursor).toBeNull();
        expect(JSON.stringify(page)).not.toContain(cursor);
      } else {
        expect(page.cursor).toBe(cursor);
      }
      expect(parseXWebBookmarkExportPage(page)).toEqual(page);
    },
  ));
});

test("property: tweet body text admits TAB, LF, and CR and rejects every other C0 or DEL", () => {
  assertProperty(fc.property(
    postIdArb,
    asciiTextArb,
    (postId, raw) => {
      const allowed = !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw);
      const response = bookmarksResponse([
        timelineItem(postId, tweetResult(postId, { id: "1", username: "a", name: "A" }, raw)),
      ]);
      if (allowed) {
        const page = projectXWebBookmarkExportPage(response, 1);
        expect(page.posts[0]!.text).toBe(raw);
        expect(page.items[0]!.text).toBe(raw);
        expect(parseXWebBookmarkExportPage(page).posts[0]!.text).toBe(raw);
        return;
      }
      expect(() => projectXWebBookmarkExportPage(response, 1)).toThrow(
        "X post text must be bounded public text",
      );
    },
  ));
});
