/**
 * GitHub public user and organization policy with bounded statistics
 * projections. Callers choose one canonical account name, never an endpoint,
 * query, header, response projection, or pagination cursor.
 */

export const GITHUB_WEB_OPERATION_NAMES = Object.freeze([
  "profiles.read",
  "organizations.read",
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
  "organizations.read": Object.freeze({
    effect: "read" as const,
    risk: "R1" as const,
    state: "observed" as const,
    reason:
      "fixed credential-free REST organization read binds the requested organization, immutable numeric account ID, canonical public URL, exact follower count, and declared public repository count before a bounded completed public-repository pagination sums every exact stargazer count",
  }),
});

export const GITHUB_APP_ORIGIN = "https://github.com";
export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_REPOSITORIES_PER_PAGE = 100;
export const GITHUB_MAX_ORGANIZATION_REPOSITORIES = 10_000;
export const GITHUB_MAX_ORGANIZATION_REPOSITORY_PAGES = Math.ceil(
  GITHUB_MAX_ORGANIZATION_REPOSITORIES / GITHUB_REPOSITORIES_PER_PAGE,
);

type JsonRecord = Record<string, unknown>;

type ExactCountMetric = {
  readonly status: "available";
  readonly value: number;
  readonly precision: "exact";
  readonly unit: "count";
};

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

export type GitHubOrganizationRead = {
  readonly id: number;
  readonly organization: string;
  readonly url: string;
  readonly followers: number;
  readonly publicRepositories: number;
};

export type GitHubOrganizationRepository = {
  readonly id: number;
  readonly stars: number;
};

export type GitHubOrganizationStats = {
  readonly schemaVersion: 1;
  readonly provider: "github";
  readonly target: {
    readonly kind: "organization";
    readonly id: string;
    readonly url: string;
  };
  readonly observedAt: string;
  readonly completeness: "complete";
  readonly metrics: {
    readonly stars: ExactCountMetric;
    readonly followers: ExactCountMetric;
  };
  readonly metadata: {
    readonly organization: string;
    readonly publicRepositories: number;
  };
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

export function githubOrganization(
  value: unknown,
  label = "GitHub organization",
): string {
  return githubUsername(value, label);
}

function exactObservedAt(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("GitHub statistics observedAt must be an exact UTC observation time");
  }
  return value;
}

function exactResponseUrl(
  value: unknown,
  origin: string,
  pathname: string,
  label: string,
  targetLabel: string,
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
    throw new Error(`${label} did not bind the requested GitHub ${targetLabel}`);
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
    "profile",
  );
  const profileUrl = exactResponseUrl(
    profile.html_url,
    GITHUB_APP_ORIGIN,
    `/${responseUsername}`,
    "GitHub profile stats public URL",
    "profile",
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

/** Bind the organization response before any public-repository page is read. */
export function parseGitHubOrganizationRead(
  value: unknown,
  expectedOrganization: string,
): GitHubOrganizationRead {
  const organization = githubOrganization(expectedOrganization);
  const response = record(value, "GitHub organization stats");
  const responseOrganization = githubOrganization(
    response.login,
    "GitHub organization stats login",
  );
  if (responseOrganization !== organization) {
    throw new Error("GitHub organization stats response did not bind the requested organization");
  }
  if (response.type !== "Organization") {
    throw new Error("GitHub organization stats response is not one organization");
  }
  const id = boundedInteger(response.id, "GitHub organization stats ID", 1);
  exactResponseUrl(
    response.url,
    GITHUB_API_ORIGIN,
    `/orgs/${responseOrganization}`,
    "GitHub organization stats API URL",
    "organization",
  );
  const url = exactResponseUrl(
    response.html_url,
    GITHUB_APP_ORIGIN,
    `/${responseOrganization}`,
    "GitHub organization stats public URL",
    "organization",
  );
  return Object.freeze({
    id,
    organization: responseOrganization,
    url,
    followers: boundedInteger(
      response.followers,
      "GitHub organization followers",
    ),
    publicRepositories: boundedInteger(
      response.public_repos,
      "GitHub organization public repositories",
    ),
  });
}

/** Bind one listed public repository to the already-bound organization. */
export function projectGitHubOrganizationRepository(
  value: unknown,
  organization: GitHubOrganizationRead,
): GitHubOrganizationRepository {
  const repository = record(value, "GitHub organization public repository");
  const owner = record(repository.owner, "GitHub organization repository owner");
  const ownerOrganization = githubOrganization(
    owner.login,
    "GitHub organization repository owner login",
  );
  if (
    ownerOrganization !== organization.organization
    || boundedInteger(owner.id, "GitHub organization repository owner ID", 1)
      !== organization.id
    || owner.type !== "Organization"
  ) {
    throw new Error("GitHub organization repository did not bind the requested organization");
  }
  if (repository.private !== false || repository.visibility !== "public") {
    throw new Error("GitHub organization repository is not one public repository");
  }
  const name = boundedString(
    repository.name,
    "GitHub organization repository name",
    100,
  );
  const fullName = boundedString(
    repository.full_name,
    "GitHub organization repository full name",
    256,
  );
  if (
    fullName.toLowerCase() !== `${organization.organization}/${name}`.toLowerCase()
  ) {
    throw new Error("GitHub organization repository did not bind its public name");
  }
  return Object.freeze({
    id: boundedInteger(repository.id, "GitHub organization repository ID", 1),
    stars: boundedInteger(
      repository.stargazers_count,
      "GitHub organization repository stargazers",
    ),
  });
}

/** Project the completed, already-bound public organization repository set. */
export function projectGitHubOrganizationStats(
  organization: GitHubOrganizationRead,
  totalStars: number,
  observedAt: string,
): GitHubOrganizationStats {
  return Object.freeze({
    schemaVersion: 1,
    provider: "github",
    target: Object.freeze({
      kind: "organization",
      id: String(organization.id),
      url: organization.url,
    }),
    observedAt: exactObservedAt(observedAt),
    completeness: "complete",
    metrics: Object.freeze({
      stars: exactCountMetric(totalStars, "GitHub organization stars"),
      followers: exactCountMetric(
        organization.followers,
        "GitHub organization followers",
      ),
    }),
    metadata: Object.freeze({
      organization: organization.organization,
      publicRepositories: organization.publicRepositories,
    }),
  });
}
