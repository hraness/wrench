import { describe, expect, test } from "bun:test";

import {
  TWITCH_ABOUT_PANEL_REVISION,
  TWITCH_CURRENT_VIEWER_REVISION,
  TWITCH_WEB_CLIENT_ID,
  parseTwitchCurrentViewerResponse,
  parseTwitchProfileResponse,
  projectTwitchProfileStats,
  twitchCurrentViewerRequest,
  twitchLogin,
  twitchProfileRequest,
} from "./twitch-web";

const viewerResponse = [{ data: { currentUser: { id: "123456789" } } }];
const profileResponse = [{
  data: {
    user: {
      id: "123456789",
      followers: { totalCount: 17 },
    },
  },
}];

describe("Twitch profile response binding", () => {
  test("pins the exact reviewed registered-query request shapes", () => {
    expect(TWITCH_WEB_CLIENT_ID).toBe(
      "kimne78kx3ncx6brgo4mv6wki5h1ko",
    );
    expect(TWITCH_CURRENT_VIEWER_REVISION).toBe(
      "6c870de60372d53089341c8af304c35c541754b72550eb2672224b017a39512e",
    );
    expect(TWITCH_ABOUT_PANEL_REVISION).toBe(
      "3b9cd4edd28e8e6f7ba6152a56157bc2b1c1a8f6e81d70808ad1b85250e5288f",
    );
    expect(twitchCurrentViewerRequest()).toEqual([{
      operationName: "TopNav_CurrentUser",
      variables: {},
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: TWITCH_CURRENT_VIEWER_REVISION,
        },
      },
    }]);
    expect(twitchProfileRequest("wrench_test")).toEqual([{
      operationName: "ChannelRoot_AboutPanel",
      variables: {
        channelLogin: "wrench_test",
        skipSchedule: true,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: TWITCH_ABOUT_PANEL_REVISION,
        },
      },
    }]);
  });

  test("binds the exact requested target to the current viewer ID", () => {
    const viewer = parseTwitchCurrentViewerResponse(viewerResponse);
    const profile = parseTwitchProfileResponse(
      profileResponse,
      "wrench_test",
      viewer,
    );
    expect(profile).toEqual({
      id: "123456789",
      login: "wrench_test",
      followers: 17,
    });
    expect(projectTwitchProfileStats(
      profile,
      "2026-08-25T12:34:56.789Z",
    )).toEqual({
      schemaVersion: 1,
      provider: "twitch",
      target: {
        kind: "profile",
        id: "123456789",
        url: "https://www.twitch.tv/wrench_test",
      },
      observedAt: "2026-08-25T12:34:56.789Z",
      completeness: "complete",
      metrics: {
        followers: {
          status: "available",
          value: 17,
          precision: "exact",
          unit: "count",
        },
      },
      metadata: { login: "wrench_test" },
    });
  });

  test("preserves an exact zero follower count as available", () => {
    const viewer = parseTwitchCurrentViewerResponse(viewerResponse);
    const profile = parseTwitchProfileResponse([{
      data: {
        user: {
          id: "123456789",
          followers: { totalCount: 0 },
        },
      },
    }], "wrench_test", viewer);
    expect(projectTwitchProfileStats(
      profile,
      "2026-08-25T12:34:56.789Z",
    ).metrics.followers).toEqual({
      status: "available",
      value: 0,
      precision: "exact",
      unit: "count",
    });
  });

  test("rejects identity, target, GraphQL, and batch drift", () => {
    const viewer = parseTwitchCurrentViewerResponse(viewerResponse);
    expect(() => parseTwitchProfileResponse([{
      data: {
        user: {
          id: "987654321",
          followers: { totalCount: 17 },
        },
      },
    }], "wrench_test", viewer)).toThrow("did not bind the current viewer ID");
    expect(() => parseTwitchCurrentViewerResponse([{
      errors: [{ message: "private provider error" }],
      data: null,
    }])).toThrow("returned GraphQL errors");
    expect(() => parseTwitchCurrentViewerResponse([])).toThrow(
      "must be one exact GraphQL batch result",
    );
    expect(() => parseTwitchCurrentViewerResponse([
      viewerResponse[0],
      viewerResponse[0],
    ])).toThrow("must be one exact GraphQL batch result");
    expect(() => parseTwitchCurrentViewerResponse([{
      data: { currentUser: null },
    }])).toThrow("must be an object");
  });

  test("rejects missing, nonnumeric, negative, fractional, and unsafe counts", () => {
    const viewer = parseTwitchCurrentViewerResponse(viewerResponse);
    for (const totalCount of [
      undefined,
      "17",
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => parseTwitchProfileResponse([{
        data: {
          user: {
            id: "123456789",
            followers: { totalCount },
          },
        },
      }], "wrench_test", viewer)).toThrow(
        "must be an exact nonnegative safe integer",
      );
    }
  });
});

test("accepts only exact lowercase Twitch logins", () => {
  expect(twitchLogin("wrench_test")).toBe("wrench_test");
  for (const login of ["Wrench_Test", "abc", "has-dash", "", "a".repeat(26)]) {
    expect(() => twitchLogin(login)).toThrow(
      "must be one exact lowercase Twitch login",
    );
  }
});
