/**
 * Network-inert Facebook Group feed projection.
 *
 * The source HTML comes from a direct authenticated GET of
 * `/groups/{numeric-id}/`. Ordinary provider access logs may record the GET,
 * but wrench sends no client-interaction or mutation request and never retries
 * an indeterminate read. This module parses inert JSON only; it never executes
 * page JavaScript or performs a request.
 */
import { assertMetaCometReadActor } from "./meta-bootstrap";
import {
  isReviewedFacebookGroupRelayResultEnvelope,
  parseFacebookViewerId,
  parseMetaJsonScripts,
} from "./meta-web";

type JsonRecord = Record<string, unknown>;

type IndexedEdge = {
  readonly index: number;
  readonly edge: JsonRecord;
};

export type FacebookGroupFeedPost = {
  readonly id: string;
  readonly creation_time: number;
  readonly message: string | null;
  readonly actors: readonly {
    readonly id: string | null;
    readonly name: string | null;
  }[];
};

export type FacebookGroupFeed = {
  readonly feed: "group";
  readonly group_id: string;
  readonly posts: readonly FacebookGroupFeedPost[];
  readonly provider_has_next_page: boolean;
  readonly next_cursor: string | null;
  readonly continuation_supported: boolean;
  readonly truncated: boolean;
  readonly complete: boolean;
};

const MAX_TREE_NODES = 250_000;
const MAX_TREE_DEPTH = 40;
const MAX_CONTAINER_ENTRIES = 10_000;
const MAX_PROVIDER_EDGES = 500;
const MAX_ACTORS = 20;
const FACEBOOK_GROUP_STREAM_KEY_PATTERN =
  /^adp_CometGroupDiscussionRootSuccessQueryRelayPreloader_[A-Za-z0-9_]{1,192}$/u;
const FACEBOOK_GROUP_STREAM_RESULT_PATH = Object.freeze([
  "require",
  "[]",
  "[]",
  "[]",
  "__bbox",
  "require",
  "[]",
  "[]",
  "[]",
  "__bbox",
  "result",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) throw new Error(`${label} changed its reviewed fields`);
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\0]/u.test(value)
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, label, maximum, 0);
}

function decimalId(value: unknown, label: string, maximum = 32): string {
  const id = boundedString(value, label, maximum);
  if (!/^[0-9]+$/u.test(id) || id === "0") {
    throw new Error(`${label} must be a stable decimal ID`);
  }
  return id;
}

function boundedInteger(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
  ) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function walk(
  roots: readonly unknown[],
  visit: (value: unknown, path: readonly string[]) => void,
): void {
  const stack: {
    readonly value: unknown;
    readonly depth: number;
    readonly path: readonly string[];
  }[] = roots
    .map((value) => ({
      value,
      depth: 0,
      path: Object.freeze([]),
    }))
    .reverse();
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    nodes += 1;
    if (nodes > MAX_TREE_NODES) {
      throw new Error("Facebook Group bootstrap exceeded its reviewed structural bound");
    }
    visit(item.value, item.path);
    if (item.depth >= MAX_TREE_DEPTH) {
      if (
        (Array.isArray(item.value) && item.value.length > 0)
        || (isRecord(item.value) && Object.keys(item.value).length > 0)
      ) {
        throw new Error("Facebook Group bootstrap exceeded its reviewed depth bound");
      }
      continue;
    }
    if (Array.isArray(item.value)) {
      if (item.value.length > MAX_CONTAINER_ENTRIES) {
        throw new Error("Facebook Group bootstrap contained an oversized array");
      }
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: item.value[index],
          depth: item.depth + 1,
          path: Object.freeze([...item.path, "[]"]),
        });
      }
      continue;
    }
    if (!isRecord(item.value)) continue;
    const entries = Object.entries(item.value);
    if (entries.length > MAX_CONTAINER_ENTRIES) {
      throw new Error("Facebook Group bootstrap contained an oversized object");
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      stack.push({
        value: entry[1],
        depth: item.depth + 1,
        path: Object.freeze([...item.path, entry[0]]),
      });
    }
  }
}

function pathEquals(
  value: readonly string[],
  expected: readonly string[],
): boolean {
  return value.length === expected.length
    && value.every((segment, index) => segment === expected[index]);
}

function reviewedFacebookGroupStreamKey(
  roots: readonly unknown[],
  path: readonly string[],
  value: unknown,
): string | null {
  if (
    !pathEquals(path, FACEBOOK_GROUP_STREAM_RESULT_PATH)
    || !isReviewedFacebookGroupRelayResultEnvelope(roots, path, value)
  ) return null;

  const keys = new Set<string>();
  for (const root of roots) {
    if (!isRecord(root) || !isUnknownArray(root.require)) continue;
    for (const scheduled of root.require) {
      if (
        !isUnknownArray(scheduled)
        || scheduled.length !== 4
        || scheduled[0] !== "ScheduledServerJS"
        || scheduled[1] !== "handle"
        || scheduled[2] !== null
        || !isUnknownArray(scheduled[3])
      ) continue;
      for (const scheduledPayload of scheduled[3]) {
        if (
          !isRecord(scheduledPayload)
          || !isRecord(scheduledPayload.__bbox)
          || !isUnknownArray(scheduledPayload.__bbox.require)
        ) continue;
        for (const streamValue of scheduledPayload.__bbox.require) {
          if (
            !isUnknownArray(streamValue)
            || streamValue.length !== 4
            || streamValue[0] !== "RelayPrefetchedStreamCache"
            || streamValue[1] !== "next"
            || !isUnknownArray(streamValue[2])
            || streamValue[2].length !== 0
            || !isUnknownArray(streamValue[3])
            || streamValue[3].length !== 2
            || typeof streamValue[3][0] !== "string"
            || !FACEBOOK_GROUP_STREAM_KEY_PATTERN.test(streamValue[3][0])
          ) continue;
          const payload = streamValue[3][1];
          if (
            isRecord(payload)
            && isRecord(payload.__bbox)
            && payload.__bbox.result === value
          ) keys.add(streamValue[3][0]);
        }
      }
    }
  }
  if (keys.size !== 1) {
    throw new Error("Facebook Group result did not bind exactly one reviewed preloader key");
  }
  return [...keys][0] as string;
}

function assertEmptyProviderErrors(value: JsonRecord, label: string): void {
  if (!Object.hasOwn(value, "errors")) return;
  if (!Array.isArray(value.errors)) {
    throw new Error(`${label}.errors must be an array`);
  }
  if (value.errors.length > 0) {
    throw new Error(`${label} contained provider errors`);
  }
}

function assertExpectedGroup(
  value: unknown,
  expectedGroupId: string,
  label: string,
  requireTypename: boolean,
): JsonRecord {
  const group = record(value, label);
  if (requireTypename && group.__typename !== "Group") {
    throw new Error(`${label} must be a typed Group`);
  }
  if (
    group.__typename !== undefined
    && group.__typename !== "Group"
  ) throw new Error(`${label} changed its Group typename`);
  if (decimalId(group.id, `${label}.id`) !== expectedGroupId) {
    throw new Error(`${label} changed the requested Group target`);
  }
  return group;
}

function assertTypedGroupRoot(group: JsonRecord, expectedGroupId: string): void {
  if (group.__typename === "Group") {
    assertExpectedGroup(group, expectedGroupId, "Facebook Group feed root", true);
    return;
  }
  if (group.__typename !== undefined) {
    throw new Error("Facebook Group feed root changed its Group typename");
  }
  // The observed Comet group-feed root omits __typename but carries this
  // exact access-gated typed Group record under the same root.
  assertExpectedGroup(
    group.if_viewer_can_see_content,
    expectedGroupId,
    "Facebook Group feed root access marker",
    true,
  );
}

function validatePlaceholder(
  value: unknown,
  index: number,
  expectedGroupId: string,
): string | null {
  if (value === null) return null;
  const edge = record(value, `Facebook Group placeholder edge[${index}]`);
  exactKeys(edge, ["cursor", "node"], `Facebook Group placeholder edge[${index}]`);
  const cursor = boundedString(
    edge.cursor,
    `Facebook Group placeholder edge[${index}].cursor`,
    4_096,
  );
  const node = record(edge.node, `Facebook Group placeholder edge[${index}].node`);
  if (
    node.__typename !== "GroupsSectionHeaderUnit"
    || node.__isFeedUnit !== "GroupsSectionHeaderUnit"
  ) {
    throw new Error(`Facebook Group placeholder edge[${index}] changed its header-unit markers`);
  }
  const target = record(
    node.target_group,
    `Facebook Group placeholder edge[${index}].target_group`,
  );
  if (
    target.__typename !== undefined
    && target.__typename !== "Group"
  ) throw new Error(`Facebook Group placeholder edge[${index}] changed its Group typename`);
  if (
    decimalId(
      target.id,
      `Facebook Group placeholder edge[${index}].target_group.id`,
    ) !== expectedGroupId
  ) throw new Error(`Facebook Group placeholder edge[${index}] changed the requested Group target`);
  return cursor;
}

function rootPlaceholders(
  roots: readonly unknown[],
  expectedGroupId: string,
): {
  readonly count: number;
  readonly cursors: readonly string[];
  readonly streamKey: string;
} {
  const candidates: {
    readonly group: JsonRecord;
    readonly streamKey: string;
  }[] = [];
  walk(roots, (value, path) => {
    const streamKey = reviewedFacebookGroupStreamKey(roots, path, value);
    if (
      isRecord(value)
      && streamKey !== null
    ) {
      assertEmptyProviderErrors(value, "Facebook Group reviewed Relay envelope");
    }
    if (!isRecord(value) || !isRecord(value.data)) return;
    const group = value.data.group;
    if (!isRecord(group) || !isRecord(group.group_feed)) return;
    if (streamKey === null) {
      throw new Error("Facebook Group feed root appeared outside its reviewed Relay envelope");
    }
    assertEmptyProviderErrors(value, "Facebook Group feed envelope");
    candidates.push(Object.freeze({ group, streamKey }));
  });
  if (candidates.length !== 1) {
    throw new Error("Facebook Group response did not contain exactly one group-feed root");
  }
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error("Facebook Group feed root disappeared");
  const { group, streamKey } = candidate;
  if (decimalId(group.id, "Facebook Group feed root.id") !== expectedGroupId) {
    throw new Error("Facebook Group feed root changed the requested Group target");
  }
  assertTypedGroupRoot(group, expectedGroupId);
  const feed = record(group.group_feed, "Facebook Group feed root.group_feed");
  exactKeys(feed, ["edges"], "Facebook Group feed root.group_feed");
  if (!Array.isArray(feed.edges) || feed.edges.length > MAX_PROVIDER_EDGES) {
    throw new Error("Facebook Group placeholder edges must be a bounded array");
  }
  const cursors: string[] = [];
  const seenCursors = new Set<string>();
  for (const [index, edge] of feed.edges.entries()) {
    const cursor = validatePlaceholder(edge, index, expectedGroupId);
    if (cursor === null) continue;
    if (seenCursors.has(cursor)) {
      throw new Error("Facebook Group placeholders contained a duplicate edge cursor");
    }
    seenCursors.add(cursor);
    cursors.push(cursor);
  }
  return {
    count: feed.edges.length,
    cursors: Object.freeze(cursors),
    streamKey,
  };
}

function stream(
  roots: readonly unknown[],
  placeholderCount: number,
  expectedStreamKey: string,
): {
  readonly edges: readonly IndexedEdge[];
  readonly hasNextPage: boolean;
  readonly endCursor: string;
} {
  const indexed = new Map<number, JsonRecord>();
  const pageInfoCandidates: JsonRecord[] = [];
  let finalFragments = 0;
  let streamPhase: "before-root" | "edges" | "final" = "before-root";

  walk(roots, (value, pathToValue) => {
    const streamKey = reviewedFacebookGroupStreamKey(
      roots,
      pathToValue,
      value,
    );
    if (
      isRecord(value)
      && isRecord(value.data)
      && isRecord(value.data.group)
      && isRecord(value.data.group.group_feed)
      && streamKey !== null
    ) {
      if (streamKey !== expectedStreamKey) {
        throw new Error("Facebook Group stream changed its bound preloader key");
      }
      if (streamPhase !== "before-root") {
        throw new Error("Facebook Group stream emitted its initial root out of order");
      }
      streamPhase = "edges";
    }
    if (!isRecord(value) || !Array.isArray(value.path)) return;
    const path = value.path;
    if (path[0] !== "group" || path[1] !== "group_feed") return;
    if (streamKey === null) {
      throw new Error("Facebook Group stream patch appeared outside its reviewed envelope");
    }
    if (streamKey !== expectedStreamKey) {
      throw new Error("Facebook Group stream changed its bound preloader key");
    }
    if (streamPhase !== "edges") {
      throw new Error("Facebook Group stream patch appeared outside its reviewed order");
    }
    assertEmptyProviderErrors(value, "Facebook Group stream envelope");
    const extensions = record(value.extensions, "Facebook Group stream extensions");
    if (typeof extensions.is_final !== "boolean") {
      throw new Error("Facebook Group stream extensions.is_final must be boolean");
    }
    if (extensions.is_final) finalFragments += 1;

    if (
      path.length === 4
      && path[2] === "edges"
      && typeof path[3] === "number"
    ) {
      const index = path[3];
      if (
        !Number.isSafeInteger(index)
        || index < placeholderCount
        || index >= MAX_PROVIDER_EDGES
      ) throw new Error("Facebook Group stream used an out-of-bounds edge index");
      if (extensions.is_final) {
        throw new Error("Facebook Group edge fragment unexpectedly ended the stream");
      }
      if (indexed.has(index)) {
        throw new Error("Facebook Group stream contained a duplicate edge index");
      }
      const edge = record(value.data, `Facebook Group streamed edge[${index}]`);
      exactKeys(edge, ["cursor", "node"], `Facebook Group streamed edge[${index}]`);
      indexed.set(index, edge);
      return;
    }

    if (path.length === 2) {
      if (!extensions.is_final) {
        throw new Error("Facebook Group page-info fragment was not final");
      }
      streamPhase = "final";
      const data = record(value.data, "Facebook Group final stream data");
      exactKeys(data, ["page_info"], "Facebook Group final stream data");
      pageInfoCandidates.push(
        record(data.page_info, "Facebook Group final page_info"),
      );
      return;
    }

    throw new Error("Facebook Group stream used an unsupported group-feed path");
  });

  if (
    pageInfoCandidates.length !== 1
    || finalFragments !== 1
  ) {
    throw new Error("Facebook Group response did not contain exactly one final page-info fragment");
  }
  const edges = [...indexed.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, edge]) => Object.freeze({ index, edge }));
  if (edges.some((edge, index) => edge.index !== placeholderCount + index)) {
    throw new Error("Facebook Group stream edge indices were not contiguous");
  }

  const pageInfo = pageInfoCandidates[0];
  if (pageInfo === undefined) throw new Error("Facebook Group final page_info disappeared");
  exactKeys(
    pageInfo,
    ["end_cursor", "has_next_page"],
    "Facebook Group final page_info",
  );
  return {
    edges: Object.freeze(edges),
    hasNextPage: exactBoolean(
      pageInfo.has_next_page,
      "Facebook Group page_info.has_next_page",
    ),
    endCursor: boundedString(
      pageInfo.end_cursor,
      "Facebook Group page_info.end_cursor",
      4_096,
    ),
  };
}

function actors(
  value: unknown,
  label: string,
): readonly FacebookGroupFeedPost["actors"][number][] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_ACTORS) {
    throw new Error(`${label} must be a bounded actor array`);
  }
  const seen = new Set<string>();
  const projected = value.map((actorValue, index) => {
    const actor = record(actorValue, `${label}[${index}]`);
    const id = actor.id === undefined || actor.id === null
      ? null
      : decimalId(actor.id, `${label}[${index}].id`);
    const name = optionalString(actor.name, `${label}[${index}].name`, 512);
    if (id === null && name === null) {
      throw new Error(`${label}[${index}] omitted both reviewed actor fields`);
    }
    if (id !== null && seen.has(id)) {
      throw new Error(`${label} contained a duplicate actor ID`);
    }
    if (id !== null) seen.add(id);
    return Object.freeze({ id, name });
  });
  return Object.freeze(projected);
}

function sameActors(
  left: readonly FacebookGroupFeedPost["actors"][number][],
  right: readonly FacebookGroupFeedPost["actors"][number][],
): boolean {
  return left.length === right.length
    && left.every((actor, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && actor.id === candidate.id
        && actor.name === candidate.name;
    });
}

function projectPost(
  edge: IndexedEdge,
  expectedGroupId: string,
): FacebookGroupFeedPost {
  const label = `Facebook Group streamed edge[${edge.index}]`;
  boundedString(edge.edge.cursor, `${label}.cursor`, 4_096);
  const node = record(edge.edge.node, `${label}.node`);
  if (node.__typename !== "Story" || node.__isFeedUnit !== "Story") {
    throw new Error(`${label}.node changed its Story markers`);
  }
  const id = decimalId(node.post_id, `${label}.node.post_id`);
  const nodeId = boundedString(node.id, `${label}.node.id`, 256);
  assertExpectedGroup(
    node.to,
    expectedGroupId,
    `${label}.node.to`,
    true,
  );
  const creationTime = boundedInteger(
    node.creation_time,
    `${label}.node.creation_time`,
  );
  const outerActors = actors(node.actors, `${label}.node.actors`);

  const sections = record(node.comet_sections, `${label}.node.comet_sections`);
  const content = record(sections.content, `${label}.node.comet_sections.content`);
  const story = record(content.story, `${label}.node.comet_sections.content.story`);
  if (
    boundedString(story.id, `${label}.story.id`, 256) !== nodeId
    || decimalId(story.post_id, `${label}.story.post_id`) !== id
  ) throw new Error(`${label} changed its nested Story identity`);
  const target = record(story.target_group, `${label}.story.target_group`);
  if (
    target.__typename !== undefined
    && target.__typename !== "Group"
  ) throw new Error(`${label}.story.target_group changed its Group typename`);
  if (decimalId(target.id, `${label}.story.target_group.id`) !== expectedGroupId) {
    throw new Error(`${label}.story changed the requested Group target`);
  }
  const innerActors = actors(story.actors, `${label}.story.actors`);
  if (
    outerActors.length > 0
    && innerActors.length > 0
    && !sameActors(outerActors, innerActors)
  ) throw new Error(`${label} changed its nested Story actors`);

  const messageRecord = story.message === undefined || story.message === null
    ? null
    : record(story.message, `${label}.story.message`);
  const message = messageRecord === null
    ? null
    : optionalString(messageRecord.text, `${label}.story.message.text`, 20_000);
  return Object.freeze({
    id,
    creation_time: creationTime,
    message,
    actors: outerActors.length > 0 ? outerActors : innerActors,
  });
}

export function normalizeFacebookGroupFeedHtml(
  html: unknown,
  expectedViewerId: string,
  expectedGroupId: string,
  limit: number,
): FacebookGroupFeed {
  const viewerId = decimalId(expectedViewerId, "expected Facebook viewer ID");
  const groupId = decimalId(expectedGroupId, "expected Facebook Group ID");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new Error("Facebook Group feed limit must be an integer between 1 and 30");
  }
  const roots = parseMetaJsonScripts(html);
  if (parseFacebookViewerId(html) !== viewerId) {
    throw new Error("Facebook Group feed response changed its bound viewer");
  }
  assertMetaCometReadActor(roots, viewerId);
  const placeholders = rootPlaceholders(roots, groupId);
  const providerPage = stream(
    roots,
    placeholders.count,
    placeholders.streamKey,
  );
  const seenPostIds = new Set<string>();
  const seenCursors = new Set(placeholders.cursors);
  const posts = providerPage.edges.map((edge) => {
    const cursor = boundedString(
      edge.edge.cursor,
      `Facebook Group streamed edge[${edge.index}].cursor`,
      4_096,
    );
    if (seenCursors.has(cursor)) {
      throw new Error("Facebook Group feed contained a duplicate edge cursor");
    }
    seenCursors.add(cursor);
    const post = projectPost(edge, groupId);
    if (seenPostIds.has(post.id)) {
      throw new Error("Facebook Group feed contained a duplicate post ID");
    }
    seenPostIds.add(post.id);
    return post;
  });
  const truncated = posts.length > limit;
  return Object.freeze({
    feed: "group",
    group_id: groupId,
    posts: Object.freeze(posts.slice(0, limit)),
    provider_has_next_page: providerPage.hasNextPage,
    // This reviewed contract is first-page-only. The provider cursor proves
    // completeness of the assembled page but is not an executable request
    // capability and must never escape as one.
    next_cursor: null,
    continuation_supported: false,
    truncated,
    complete: !providerPage.hasNextPage && !truncated,
  });
}
