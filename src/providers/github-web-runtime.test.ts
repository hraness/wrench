import { describe, expect, test } from "bun:test";

import type { PinnedHttpsFetch } from "../pinned-https";
import {
  executeGitHubPublicOrganizationRead,
  executeGitHubPublicProfileRead,
} from "./github-web-runtime";

const recipe = {
  site: "github",
  action: "profiles.read",
  contractVersion: 1,
  timeoutMs: 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
} as const;

const organizationRecipe = {
  site: "github",
  action: "organizations.read",
  contractVersion: 1,
  timeoutMs: 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
} as const;

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
  bio: null,
};

describe("GitHub public profile runtime", () => {
  test("uses only the fixed public REST route and reviewed headers", async () => {
    let calls = 0;
    const fetch: PinnedHttpsFetch = (url, init, timeoutMs) => {
      calls += 1;
      expect(url.href).toBe("https://api.github.com/users/0thernet");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "wrench-github-profile-stats/1.0.0",
          "x-github-api-version": "2026-03-10",
        },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(timeoutMs).toBe(60_000);
      return Promise.resolve(new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    };
    const result = await executeGitHubPublicProfileRead(
      recipe,
      { username: "0thernet" },
      { fetch, now: () => Date.parse("2026-08-24T12:34:56.789Z") },
      undefined,
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      status: "succeeded",
      finalUrl: "https://github.com/0thernet",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      output: {
        provider: "github",
        target: { id: "123456", url: "https://github.com/0thernet" },
        metrics: {
          followers: { value: 42 },
          following: { value: 7 },
          publicRepositories: { value: 19 },
        },
      },
    });
  });

  test("rejects widened inputs, statuses, and content types", async () => {
    const ok: PinnedHttpsFetch = () => Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(executeGitHubPublicProfileRead(
      recipe,
      { username: "0thernet", endpoint: "https://example.com" },
      { fetch: ok },
      undefined,
    )).rejects.toThrow("accepts only input.username");
    await expect(executeGitHubPublicProfileRead(
      recipe,
      { username: "0thernet" },
      {
        fetch: () => Promise.resolve(new Response("missing", {
          status: 404,
          headers: { "content-type": "application/json" },
        })),
      },
      undefined,
    )).rejects.toThrow("returned unreviewed status 404");
    await expect(executeGitHubPublicProfileRead(
      recipe,
      { username: "0thernet" },
      {
        fetch: () => Promise.resolve(new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "text/plain" },
        })),
      },
      undefined,
    )).rejects.toThrow("returned an unreviewed content type");
  });
});

const organization = {
  login: "hraness",
  id: 24680,
  type: "Organization",
  url: "https://api.github.com/orgs/hraness",
  html_url: "https://github.com/hraness",
  followers: 8,
  public_repos: 2,
};

function repository(index: number, stars = index): Record<string, unknown> {
  return {
    id: 10_000 + index,
    name: `repo-${index}`,
    full_name: `hraness/repo-${index}`,
    owner: { login: "hraness", id: 24680, type: "Organization" },
    private: false,
    visibility: "public",
    stargazers_count: stars,
  };
}

describe("GitHub public organization statistics runtime", () => {
  test("uses only the fixed organization and completed public repository routes", async () => {
    const seen: string[] = [];
    const fetch: PinnedHttpsFetch = (url, init, timeoutMs) => {
      seen.push(url.href);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "wrench-github-organization-stats/1.1.0",
          "x-github-api-version": "2026-03-10",
        },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(timeoutMs).toBe(60_000);
      if (url.pathname === "/orgs/hraness") {
        return Promise.resolve(new Response(JSON.stringify(organization), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([
        repository(1, 31),
        repository(2, 18),
      ]), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    };
    const result = await executeGitHubPublicOrganizationRead(
      organizationRecipe,
      { organization: "hraness" },
      { fetch, now: () => Date.parse("2026-08-24T12:34:56.789Z") },
      undefined,
    );
    expect(seen).toEqual([
      "https://api.github.com/orgs/hraness",
      "https://api.github.com/orgs/hraness/repos?type=public&per_page=100&page=1",
    ]);
    expect(result).toMatchObject({
      status: "succeeded",
      finalUrl: "https://github.com/hraness",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      output: {
        provider: "github",
        target: {
          kind: "organization",
          id: "24680",
          url: "https://github.com/hraness",
        },
        metrics: {
          stars: { value: 49 },
          followers: { value: 8 },
        },
      },
    });
  });

  test("requires every declared page once and rejects incomplete pagination", async () => {
    const pagedOrganization = { ...organization, public_repos: 101 };
    const firstPage = Array.from({ length: 100 }, (_, index) => repository(index + 1));
    const fetch: PinnedHttpsFetch = (url) => {
      if (url.pathname === "/orgs/hraness") {
        return Promise.resolve(new Response(JSON.stringify(pagedOrganization), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      const page = url.searchParams.get("page");
      if (page === "1") {
        return Promise.resolve(new Response(JSON.stringify(firstPage), {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: "<https://api.github.com/orgs/hraness/repos?type=public&per_page=100&page=2>; rel=\"next\"",
          },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([repository(101)]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    };
    const result = await executeGitHubPublicOrganizationRead(
      organizationRecipe,
      { organization: "hraness" },
      { fetch, now: () => Date.parse("2026-08-24T12:34:56.789Z") },
      undefined,
    );
    expect(result.output).toMatchObject({
      metrics: { stars: { value: 5_151 }, followers: { value: 8 } },
    });

    const missingNext: PinnedHttpsFetch = (url) => {
      if (url.pathname === "/orgs/hraness") {
        return Promise.resolve(new Response(JSON.stringify(pagedOrganization), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify(firstPage), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    };
    await expect(executeGitHubPublicOrganizationRead(
      organizationRecipe,
      { organization: "hraness" },
      { fetch: missingNext },
      undefined,
    )).rejects.toThrow("pagination did not complete the declared public repository set");
  });

  test("rejects widened inputs and incomplete or drifted repository sets", async () => {
    const ok: PinnedHttpsFetch = (url) => Promise.resolve(new Response(JSON.stringify(
      url.pathname === "/orgs/hraness" ? organization : [repository(1), repository(1)],
    ), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(executeGitHubPublicOrganizationRead(
      organizationRecipe,
      { organization: "hraness", page: 2 },
      { fetch: ok },
      undefined,
    )).rejects.toThrow("accepts only input.organization");
    await expect(executeGitHubPublicOrganizationRead(
      organizationRecipe,
      { organization: "hraness" },
      { fetch: ok },
      undefined,
    )).rejects.toThrow("pagination repeated one repository");
  });
});
