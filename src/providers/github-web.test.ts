import { describe, expect, test } from "bun:test";

import {
  githubOrganization,
  githubUsername,
  parseGitHubOrganizationRead,
  projectGitHubOrganizationRepository,
  projectGitHubOrganizationStats,
  projectGitHubProfileStats,
} from "./github-web";

const profileResponse = {
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

const organizationResponse = {
  login: "hraness",
  id: 24680,
  type: "Organization",
  url: "https://api.github.com/orgs/hraness",
  html_url: "https://github.com/hraness",
  followers: 8,
  public_repos: 2,
};

const repository = {
  id: 13579,
  name: "jungle",
  full_name: "hraness/jungle",
  owner: { login: "hraness", id: 24680, type: "Organization" },
  private: false,
  visibility: "public",
  stargazers_count: 31,
};

describe("GitHub public profile projection", () => {
  test("binds one exact user and projects exact public counters", () => {
    expect(projectGitHubProfileStats(
      profileResponse,
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
      { ...profileResponse, login: "someone-else" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("did not bind the requested username");
    expect(() => projectGitHubProfileStats(
      { ...profileResponse, html_url: "https://github.com/someone-else" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("did not bind the requested GitHub profile");
    expect(() => projectGitHubProfileStats(
      { ...profileResponse, followers: "42" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("GitHub followers must be a bounded integer");
    expect(() => projectGitHubProfileStats(
      { ...profileResponse, type: "Organization" },
      "0thernet",
      "2026-08-24T12:34:56.789Z",
    )).toThrow("is not one user profile");
  });
});

describe("GitHub public organization projection", () => {
  test("binds the organization and sums only exact public repository stars", () => {
    const organization = parseGitHubOrganizationRead(
      organizationResponse,
      "HRANESS",
    );
    expect(organization).toEqual({
      id: 24680,
      organization: "hraness",
      url: "https://github.com/hraness",
      followers: 8,
      publicRepositories: 2,
    });
    expect(projectGitHubOrganizationRepository(repository, organization)).toEqual({
      id: 13579,
      stars: 31,
    });
    expect(projectGitHubOrganizationStats(
      organization,
      49,
      "2026-08-24T12:34:56.789Z",
    )).toEqual({
      schemaVersion: 1,
      provider: "github",
      target: {
        kind: "organization",
        id: "24680",
        url: "https://github.com/hraness",
      },
      observedAt: "2026-08-24T12:34:56.789Z",
      completeness: "complete",
      metrics: {
        stars: {
          status: "available",
          value: 49,
          precision: "exact",
          unit: "count",
        },
        followers: {
          status: "available",
          value: 8,
          precision: "exact",
          unit: "count",
        },
      },
      metadata: { organization: "hraness", publicRepositories: 2 },
    });
  });

  test("rejects target, owner, visibility, and counter drift", () => {
    const organization = parseGitHubOrganizationRead(organizationResponse, "hraness");
    expect(() => parseGitHubOrganizationRead(
      { ...organizationResponse, login: "someone-else" },
      "hraness",
    )).toThrow("did not bind the requested organization");
    expect(() => parseGitHubOrganizationRead(
      { ...organizationResponse, type: "User" },
      "hraness",
    )).toThrow("is not one organization");
    expect(() => projectGitHubOrganizationRepository(
      { ...repository, owner: { ...repository.owner, id: 999 } },
      organization,
    )).toThrow("did not bind the requested organization");
    expect(() => projectGitHubOrganizationRepository(
      { ...repository, visibility: "private" },
      organization,
    )).toThrow("is not one public repository");
    expect(() => projectGitHubOrganizationRepository(
      { ...repository, stargazers_count: "31" },
      organization,
    )).toThrow("stargazers must be a bounded integer");
  });
});

test("accepts only canonical GitHub user and organization names", () => {
  expect(githubUsername("0THERNET")).toBe("0thernet");
  expect(githubOrganization("HRANESS")).toBe("hraness");
  for (const username of ["-bad", "bad-", "bad--name", "bad.name", ""]) {
    expect(() => githubUsername(username)).toThrow(
      "must be one canonical GitHub username",
    );
    expect(() => githubOrganization(username)).toThrow(
      "must be one canonical GitHub username",
    );
  }
});
