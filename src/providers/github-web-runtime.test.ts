import { describe, expect, test } from "bun:test";

import type { PinnedHttpsFetch } from "../pinned-https";
import { executeGitHubPublicProfileRead } from "./github-web-runtime";

const recipe = {
  site: "github",
  action: "profiles.read",
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
