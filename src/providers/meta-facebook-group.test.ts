import { describe, expect, test } from "bun:test";

import { normalizeFacebookGroupFeedHtml } from "./meta-facebook-group";

const VIEWER_ID = "24680";
const GROUP_ID = "13579";

function html(...values: readonly unknown[]): string {
  return values.map((value) =>
    `<script type="application/json">${JSON.stringify(value)}</script>`).join("");
}

function viewer(viewerId = VIEWER_ID, actorId = viewerId): unknown {
  return {
    require: [
      ["CurrentUserInitialData", [], {
        ACCOUNT_ID: viewerId,
        USER_ID: viewerId,
        NAME: "Private fixture viewer",
      }, 7],
      ["RelayAPIConfigDefaults", [], { actorID: actorId }, 8],
    ],
  };
}

function placeholder(index: number, groupId = GROUP_ID): unknown {
  return {
    cursor: `placeholder-${index}`,
    node: {
      __typename: "GroupsSectionHeaderUnit",
      __isFeedUnit: "GroupsSectionHeaderUnit",
      id: `placeholder-node-${index}`,
      target_group: { id: groupId },
    },
  };
}

function root(
  count = 1,
  groupId = GROUP_ID,
  typed = true,
): unknown {
  return {
    result: {
      data: {
        group: {
          ...(typed
            ? { __typename: "Group" }
            : {
                if_viewer_can_see_content: {
                  __typename: "Group",
                  id: groupId,
                },
              }),
          id: groupId,
          group_feed: {
            edges: Array.from({ length: count }, (_, index) =>
              placeholder(index, groupId)),
          },
        },
      },
    },
  };
}

function postEdge(
  index: number,
  options: {
    readonly postId?: string;
    readonly groupId?: string;
    readonly nodeId?: string;
    readonly nestedNodeId?: string;
    readonly nestedPostId?: string;
    readonly actorId?: string;
    readonly innerActorId?: string;
    readonly message?: unknown;
    readonly creationTime?: unknown;
    readonly cursor?: string;
  } = {},
): unknown {
  const groupId = options.groupId ?? GROUP_ID;
  const postId = options.postId ?? String(9_000 + index);
  const nodeId = options.nodeId ?? `opaque-node-${index}`;
  const actorId = options.actorId ?? String(800 + index);
  const innerActorId = options.innerActorId ?? actorId;
  return {
    path: ["group", "group_feed", "edges", index],
    data: {
      cursor: options.cursor ?? `edge-${index}`,
      node: {
        __typename: "Story",
        __isFeedUnit: "Story",
        id: nodeId,
        post_id: postId,
        creation_time: options.creationTime ?? 100 + index,
        actors: [{ id: actorId, name: `Actor ${index}` }],
        to: { __typename: "Group", id: groupId },
        comet_sections: {
          content: {
            story: {
              id: options.nestedNodeId ?? nodeId,
              post_id: options.nestedPostId ?? postId,
              target_group: { id: groupId },
              actors: [{ id: innerActorId, name: `Actor ${index}` }],
              message: options.message === undefined
                ? { text: `Message ${index}` }
                : options.message,
            },
          },
        },
      },
    },
    extensions: { is_final: false, prefetch_uris_v2: [] },
  };
}

function finalPage(
  hasNextPage = true,
  endCursor: unknown = "next-page",
  isFinal: unknown = true,
): unknown {
  return {
    path: ["group", "group_feed"],
    data: {
      page_info: {
        has_next_page: hasNextPage,
        end_cursor: endCursor,
      },
    },
    extensions: { is_final: isFinal, prefetch_uris_v2: [] },
  };
}

function streamResult(
  result: unknown,
  options: {
    readonly key?: string;
    readonly method?: string;
    readonly args?: readonly unknown[];
  } = {},
): unknown {
  return {
    require: [["ScheduledServerJS", "handle", null, [{
      __bbox: {
        require: [["RelayPrefetchedStreamCache", options.method ?? "next", options.args ?? [], [
          options.key
            ?? "adp_CometGroupDiscussionRootSuccessQueryRelayPreloader_Test_abc123",
          { __bbox: { result } },
        ]]],
      },
    }]]],
  };
}

function legacyRelayPrefetchResult(result: unknown): unknown {
  return {
    require: [["RelayPrefetch", [], {
      __bbox: { result },
    }, 7]],
  };
}

function legacyScheduledServerResult(result: unknown): unknown {
  return {
    require: [["ScheduledServerJS", "handle", null, [{
      __bbox: { result },
    }]]],
  };
}

function feed(
  options: {
    readonly count?: number;
    readonly groupId?: string;
    readonly typed?: boolean;
    readonly edges?: readonly unknown[];
    readonly final?: unknown;
  } = {},
): string {
  const count = options.count ?? 2;
  const groupRoot = root(
    1,
    options.groupId,
    options.typed,
  ) as { readonly result: unknown };
  return html(
    viewer(),
    streamResult(groupRoot.result),
    ...(options.edges ?? Array.from({ length: count }, (_, index) =>
      postEdge(index + 1, options.groupId === undefined
        ? {}
        : { groupId: options.groupId }))).map((value) => streamResult(value)),
    streamResult(options.final ?? finalPage()),
  );
}

function nestedContainer(depth: number): unknown {
  let value: unknown = { hidden: true };
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

describe("Facebook Group direct-HTML feed normalization", () => {
  test("binds viewer and Group while assembling streamed replacements", () => {
    expect(normalizeFacebookGroupFeedHtml(
      feed(),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toEqual({
      feed: "group",
      group_id: GROUP_ID,
      posts: [
        {
          id: "9001",
          creation_time: 101,
          message: "Message 1",
          actors: [{ id: "801", name: "Actor 1" }],
        },
        {
          id: "9002",
          creation_time: 102,
          message: "Message 2",
          actors: [{ id: "802", name: "Actor 2" }],
        },
      ],
      provider_has_next_page: true,
      next_cursor: null,
      continuation_supported: false,
      truncated: false,
      complete: false,
    });
  });

  test("rejects the personal-home-feed stream envelope on the Group surface", () => {
    const groupRoot = root() as { readonly result: unknown };
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(groupRoot.result, {
          key: "adp_CometModernHomeFeedQueryRelayPreloader_Test_abc123",
        }),
        postEdge(1),
        finalPage(),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("outside its reviewed Relay envelope");
  });

  test("accepts only the exact Group preloader stream in root-edge-final order", () => {
    const groupRoot = root() as { readonly result: unknown };
    expect(normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(groupRoot.result),
        streamResult(postEdge(1)),
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toMatchObject({
      posts: [{ id: "9001" }, { id: "9002" }],
    });

    for (const wrapper of [
      streamResult(groupRoot.result, { key: "adp_UnrelatedRelayPreloader_abc123" }),
      streamResult(groupRoot.result, { method: "unreviewed" }),
      streamResult(groupRoot.result, { args: ["unexpected"] }),
    ]) {
      expect(() => normalizeFacebookGroupFeedHtml(
        html(viewer(), wrapper, postEdge(1), finalPage()),
        VIEWER_ID,
        GROUP_ID,
        2,
      )).toThrow("outside its reviewed Relay envelope");
    }
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(postEdge(1)),
        streamResult(groupRoot.result),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("outside its reviewed order");
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(groupRoot.result),
        streamResult(finalPage()),
        streamResult(postEdge(1)),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("outside its reviewed order");
  });

  test("binds every streamed fragment to the initial Group preloader key", () => {
    const groupRoot = root() as { readonly result: unknown };
    const rootKey =
      "adp_CometGroupDiscussionRootSuccessQueryRelayPreloader_Test_root";
    const differentKey =
      "adp_CometGroupDiscussionRootSuccessQueryRelayPreloader_Test_different";
    for (const [edgeKey, finalKey] of [
      [differentKey, rootKey],
      [rootKey, differentKey],
    ] as const) {
      expect(() => normalizeFacebookGroupFeedHtml(
        html(
          viewer(),
          streamResult(groupRoot.result, { key: rootKey }),
          streamResult(postEdge(1), { key: edgeKey }),
          streamResult(postEdge(2), { key: edgeKey }),
          streamResult(finalPage(), { key: finalKey }),
        ),
        VIEWER_ID,
        GROUP_ID,
        2,
      )).toThrow("bound preloader key");
    }
  });

  test("never exposes a cursor when the local limit would skip provider items", () => {
    expect(normalizeFacebookGroupFeedHtml(
      feed(),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toMatchObject({
      posts: [{ id: "9001" }],
      provider_has_next_page: true,
      next_cursor: null,
      continuation_supported: false,
      truncated: true,
      complete: false,
    });

    expect(normalizeFacebookGroupFeedHtml(
      feed({ final: finalPage(false, "terminal-page") }),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toMatchObject({
      provider_has_next_page: false,
      next_cursor: null,
      continuation_supported: false,
      truncated: false,
      complete: true,
    });
  });

  test("accepts the observed untyped envelope only with its exact typed access marker", () => {
    const normalized = normalizeFacebookGroupFeedHtml(
      feed({ typed: false }),
      VIEWER_ID,
      GROUP_ID,
      2,
    );
    expect(normalized.group_id).toBe(GROUP_ID);
    expect(normalized.posts[0]?.id).toBe("9001");
  });

  test("rejects viewer, root, typed-marker, and story target drift", () => {
    expect(() => normalizeFacebookGroupFeedHtml(
      feed(),
      "99999",
      GROUP_ID,
      2,
    )).toThrow("bound viewer");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed().replace('"actorID":"24680"', '"actorID":"99999"'),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("actor did not match the bound viewer");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ groupId: "97531" }),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("requested Group target");

    const untyped = root(1) as {
      result: { data: { group: Record<string, unknown> } };
    };
    const group = untyped.result.data.group;
    delete group.__typename;
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(untyped.result),
        streamResult(postEdge(1)),
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("access marker");

    const userTyped = root(1, GROUP_ID, false) as {
      result: { data: { group: Record<string, unknown> } };
    };
    userTyped.result.data.group.__typename = "User";
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(userTyped.result),
        streamResult(postEdge(1)),
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("changed its Group typename");

    expect(() => normalizeFacebookGroupFeedHtml(
      feed({
        edges: [
          postEdge(1, { groupId: "97531" }),
          postEdge(2),
        ],
      }),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("requested Group target");
  });

  test("rejects duplicate roots, indices, cursors, posts, and actors", () => {
    const firstRoot = root() as { readonly result: unknown };
    const secondRoot = root() as { readonly result: unknown };
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(firstRoot.result),
        streamResult(secondRoot.result),
        streamResult(postEdge(1)),
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("exactly one group-feed root");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ edges: [postEdge(1), postEdge(1)] }),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("duplicate edge index");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({
        edges: [
          postEdge(1, { cursor: "same-cursor" }),
          postEdge(2, { cursor: "same-cursor" }),
        ],
      }),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("duplicate edge cursor");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({
        edges: [
          postEdge(1, { postId: "9000" }),
          postEdge(2, { postId: "9000" }),
        ],
      }),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("duplicate post ID");

    const duplicateActorEdge = postEdge(1) as {
      data: { node: { actors: unknown[] } };
    };
    duplicateActorEdge.data.node.actors.push({ id: "801", name: "Again" });
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ count: 1, edges: [duplicateActorEdge] }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("duplicate actor ID");
  });

  test("rejects provider errors and roots or patches outside reviewed envelopes", () => {
    const validRoot = root() as {
      readonly result: { readonly data: unknown };
    };
    const malformedWrappedData = validRoot.result.data;
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult({
          ...validRoot.result,
          errors: [{ message: "private provider rejection" }],
        }),
        streamResult(postEdge(1)),
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("contained provider errors");
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        {
          require: [{
            __bbox: { result: { data: malformedWrappedData } },
          }],
        },
        postEdge(1),
        postEdge(2),
        finalPage(),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("outside its reviewed Relay envelope");
    expect(() => normalizeFacebookGroupFeedHtml(
      `${feed()}${html(streamResult({
        errors: [{ message: "private sibling rejection" }],
      }))}`,
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("contained provider errors");
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        { wrapper: root() },
        streamResult(postEdge(1)),
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("outside its reviewed Relay envelope");
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(validRoot.result),
        { wrapper: postEdge(1) },
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("outside its reviewed envelope");
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(validRoot.result),
        streamResult({
          ...(postEdge(1) as Record<string, unknown>),
          errors: {},
        }),
        streamResult(postEdge(2)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("errors must be an array");
  });

  test("rejects direct and generic legacy RelayPrefetch or ScheduledServerJS envelopes", () => {
    const groupRoot = root(1) as { readonly result: unknown };
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        groupRoot,
        streamResult(postEdge(1)),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("outside its reviewed Relay envelope");
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(groupRoot.result),
        postEdge(1),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("outside its reviewed envelope");

    for (const wrap of [
      legacyRelayPrefetchResult,
      legacyScheduledServerResult,
    ]) {
      expect(() => normalizeFacebookGroupFeedHtml(
        html(
          viewer(),
          wrap(groupRoot.result),
          streamResult(postEdge(1)),
          streamResult(finalPage()),
        ),
        VIEWER_ID,
        GROUP_ID,
        1,
      )).toThrow("outside its reviewed Relay envelope");

      expect(() => normalizeFacebookGroupFeedHtml(
        html(
          viewer(),
          streamResult(groupRoot.result),
          wrap(postEdge(1)),
          streamResult(finalPage()),
        ),
        VIEWER_ID,
        GROUP_ID,
        1,
      )).toThrow("outside its reviewed envelope");
    }
  });

  test("rejects sparse, out-of-range, and unsupported stream paths", () => {
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ edges: [postEdge(2)] }),
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("not contiguous");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ count: 1, edges: [postEdge(500)] }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("out-of-bounds");
    const groupRoot = root(1) as { readonly result: unknown };
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(groupRoot.result),
        streamResult({
          path: ["group", "group_feed", "unknown"],
          data: {},
          extensions: { is_final: false },
        }),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("unsupported group-feed path");
  });

  test("requires exactly one final, strictly typed bounded page_info", () => {
    const groupRoot = root(1) as { readonly result: unknown };
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(groupRoot.result),
        streamResult(postEdge(1)),
      ),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("exactly one final page-info");
    expect(() => normalizeFacebookGroupFeedHtml(
      html(
        viewer(),
        streamResult(groupRoot.result),
        streamResult(postEdge(1)),
        streamResult(finalPage()),
        streamResult(finalPage()),
      ),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("outside its reviewed order");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ count: 1, final: finalPage(true, "next", false) }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("was not final");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ count: 1, final: finalPage(true, "x".repeat(4_097)) }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("bounded string");

    const malformed = finalPage() as {
      data: { page_info: Record<string, unknown> };
    };
    malformed.data.page_info.has_next_page = "yes";
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({ count: 1, final: malformed }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("must be boolean");
  });

  test("rejects nested Story identity, actor, and timestamp drift", () => {
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({
        count: 1,
        edges: [postEdge(1, { nestedNodeId: "other-node" })],
      }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("nested Story identity");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({
        count: 1,
        edges: [postEdge(1, { innerActorId: "999" })],
      }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("nested Story actors");
    expect(() => normalizeFacebookGroupFeedHtml(
      feed({
        count: 1,
        edges: [postEdge(1, { creationTime: -1 })],
      }),
      VIEWER_ID,
      GROUP_ID,
      1,
    )).toThrow("non-negative safe integer");
  });

  test("validates the public argument bounds before interpreting content", () => {
    expect(() => normalizeFacebookGroupFeedHtml("", VIEWER_ID, GROUP_ID, 0))
      .toThrow("between 1 and 30");
    expect(() => normalizeFacebookGroupFeedHtml("", VIEWER_ID, GROUP_ID, 31))
      .toThrow("between 1 and 30");
    expect(() => normalizeFacebookGroupFeedHtml("", "not-an-id", GROUP_ID, 1))
      .toThrow("stable decimal ID");
    expect(() => normalizeFacebookGroupFeedHtml("", VIEWER_ID, "group-name", 1))
      .toThrow("stable decimal ID");
  });

  test("rejects nonempty content hidden beyond the reviewed traversal depth", () => {
    expect(() => normalizeFacebookGroupFeedHtml(
      `${feed()}${html(nestedContainer(41))}`,
      VIEWER_ID,
      GROUP_ID,
      2,
    )).toThrow("reviewed depth bound");
  });
});
