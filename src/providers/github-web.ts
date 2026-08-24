/**
 * GitHub public profile policy and bounded profile-stat projection.
 *
 * The only executable exchange is the fixed credential-free REST user read.
 * Callers choose one username, never an endpoint, query, header, or response
 * projection.
 */

export const GITHUB_WEB_OPERATION_NAMES = Object.freeze([
  "profiles.read",
] as const);

export type GitHubWebOperationName =
  (typeof GITHUB_WEB_OPERATION_NAMES)[number];

export const GITHUB_WEB_OPERATIONS = Object.freeze({
  "profiles.read": Object.freeze({
    effect: "read" as const,
    risk: "R1" as const,
    state: "observed" as const,
    reason:
      "fixed credential-free REST user read binds the requested username, immutable numeric account ID, and canonical profile URL before projecting exact follower, following, and public repository counts",
  }),
});

export const GITHUB_APP_ORIGIN = "https://github.com";
export const GITHUB_API_ORIGIN = "https://api.github.com";

type JsonRecord = Record<string, unknown>;

export type GitHubProfileStats = {
  readonly schemaVersion: 1;
  readonly provider: "github";
  readonly target: {
    readonly kind: "profile";
    readonly id: string;
    readonly url: string;
  };
  readonly observedAt: string;
  readonly completeness: "complete";
  readonly metrics: {
    readonly followers: ExactCountMetric;
    readonly following: ExactCountMetric;
    readonly publicRepositories: ExactCountMetric;
  };
  readonly metadata: {
    readonly username: string;
    readonly displayName: string | null;
    readonly bio: string | null;
  };
};

type ExactCountMetric = {
  readonly status: "available";
  readonly value: number;
  readonly precision: "exact";
  readonly unit: "count";
};

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, label, maximum);
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a bounded integer`);
  }
  return value as number;
}

function exactCountMetric(value: unknown, label: string): ExactCountMetric {
  return Object.freeze({
    status: "available",
    value: boundedInteger(value, label),
    precision: "exact",
    unit: "count",
  });
}

export function githubUsername(value: unknown, label = "GitHub username"): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 39
    || /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be one canonical GitHub username`);
  }
  const username = value.toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(username)
    || username.includes("--")
  ) {
    throw new Error(`${label} must be one canonical GitHub username`);
  }
  return username;
}

function exactObservedAt(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("GitHub profile stats observedAt must be an exact UTC observation time");
  }
  return value;
}

function exactResponseUrl(
  value: unknown,
  origin: string,
  pathname: string,
  label: string,
): string {
  const raw = boundedString(value, label, 512);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be one exact URL`);
  }
  if (
    url.origin !== origin
    || url.pathname.toLowerCase() !== pathname.toLowerCase()
    || url.search !== ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new Error(`${label} did not bind the requested GitHub profile`);
  }
  return url.href;
}

/** Project one exact GitHub REST user response into the shared stat envelope. */
export function projectGitHubProfileStats(
  value: unknown,
  expectedUsername: string,
  observedAt: string,
): GitHubProfileStats {
  const username = githubUsername(expectedUsername);
  const profile = record(value, "GitHub profile stats");
  const responseUsername = githubUsername(
    profile.login,
    "GitHub profile stats login",
  );
  if (responseUsername !== username) {
    throw new Error("GitHub profile stats response did not bind the requested username");
  }
  if (profile.type !== "User") {
    throw new Error("GitHub profile stats response is not one user profile");
  }
  const id = boundedInteger(profile.id, "GitHub profile stats ID", 1);
  exactResponseUrl(
    profile.url,
    GITHUB_API_ORIGIN,
    `/users/${responseUsername}`,
    "GitHub profile stats API URL",
  );
  const profileUrl = exactResponseUrl(
    profile.html_url,
    GITHUB_APP_ORIGIN,
    `/${responseUsername}`,
    "GitHub profile stats public URL",
  );
  return Object.freeze({
    schemaVersion: 1,
    provider: "github",
    target: Object.freeze({
      kind: "profile",
      id: String(id),
      url: profileUrl,
    }),
    observedAt: exactObservedAt(observedAt),
    completeness: "complete",
    metrics: Object.freeze({
      followers: exactCountMetric(profile.followers, "GitHub followers"),
      following: exactCountMetric(profile.following, "GitHub following"),
      publicRepositories: exactCountMetric(
        profile.public_repos,
        "GitHub public repositories",
      ),
    }),
    metadata: Object.freeze({
      username: responseUsername,
      displayName: optionalString(
        profile.name,
        "GitHub profile stats display name",
        1_000,
      ),
      bio: optionalString(profile.bio, "GitHub profile stats bio", 10_000),
    }),
  });
}
