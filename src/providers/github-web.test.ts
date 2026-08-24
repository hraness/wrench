import { describe, expect, test } from "bun:test";

import {
  githubUsername,
  projectGitHubProfileStats,
} from "./github-web";

const response = {
  login: "0thernet",
  id: 123456,
  type: "User",
  url: "https://api.github.com/users/0thernet",
  html_url: "https://github.com/0thernet",
  followers: 42,
  following: 7,
  public_repos: 19,
  name: "0thernet",
  bio: "tools for thought",
};

describe("GitHub public profile projection", () => {
  test("binds one exact user and projects exact public counters", () => {
    expect(projectGitHubProfileStats(
      response,
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toEqual({
      schemaVersion: 1,
      provider: "github",
      target: {
        kind: "profile",
        id: "123456",
        url: "https://github.com/0thernet",
      },
      observedAt: "2026-08-24T12:34:56.789Z",
      completeness: "complete",
      metrics: {
        followers: {
          status: "available",
          value: 42,
          precision: "exact",
          unit: "count",
        },
        following: {
          status: "available",
          value: 7,
          precision: "exact",
          unit: "count",
        },
        publicRepositories: {
          status: "available",
          value: 19,
          precision: "exact",
          unit: "count",
        },
      },
      metadata: {
        username: "0thernet",
        displayName: "0thernet",
        bio: "tools for thought",
      },
    });
  });

  test("rejects target drift and non-exact counters", () => {
    expect(() => projectGitHubProfileStats(
      { ...response, login: "someone-else" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("did not bind the requested username");
    expect(() => projectGitHubProfileStats(
      { ...response, html_url: "https://github.com/someone-else" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("did not bind the requested GitHub profile");
    expect(() => projectGitHubProfileStats(
      { ...response, followers: "42" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("GitHub followers must be a bounded integer");
    expect(() => projectGitHubProfileStats(
      { ...response, type: "Organization" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("is not one user profile");
  });

  test("accepts only canonical GitHub usernames", () => {
    expect(githubUsername("0THERNET")).toBe("0thernet");
    for (const username of ["-bad", "bad-", "bad--name", "bad.name", ""]) {
      expect(() => githubUsername(username)).toThrow(
        "must be one canonical GitHub username",
      );
    }
  });
});
