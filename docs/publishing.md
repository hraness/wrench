# Publish Wrench

Wrench uses one interactive first publication and stage-only trusted publishing
for later versions. npm requires a package to exist before `npm stage publish`
can use it, so the bootstrap cannot use the staging workflow.

## Keep discovery metadata aligned

The exact npm keyword list is checked by `scripts/package-smoke.ts` in source
and in the packed artifact. Repository topics are maintainer-managed discovery
metadata, not release identity. Keep this checked topic set aligned through the
GitHub repository settings: `agent-skills`, `agent-tools`, `ai-agents`, `beeper`,
`browser-automation`, `bun`, `cli`, `coding-agents`, `cross-provider`,
`developer-tools`, `knowledge-base`, `local-first`, `media-archive`, `messaging`,
`provider-plugins`, `tool-calling`, `typescript`, `typescript-sdk`,
`web-automation`, and `web-capture`. Do not grant a release workflow repository
administration permission only to synchronize topics.

## Bootstrap the npm package

This section records the one-time bootstrap of `@hraness/wrench@0.15.1`.
That package is already public. Do not reuse these bootstrap commands for any
later version. Follow [Stage a later version](#stage-a-later-version) instead.

Start from the current `main` commit after the required checks pass. Use Node
24, npm 11.19.0, and Bun 1.3.14. Do not create the release tag yet.

1. Install the frozen graph without lifecycle scripts.

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   ```

2. Run the complete repository gate.

   ```sh
   bun run check
   ```

3. Confirm that the build did not change the checked package outputs.

   ```sh
   git status --porcelain --untracked-files=all -- dist bun.lock
   ```

   Continue only when this command produces no output.

4. Create and smoke one exact npm tarball.

   ```sh
   wrench_npm_artifact="$(mktemp -d)"
   wrench_npm_json="$wrench_npm_artifact/npm-pack.json"
   npm pack \
     --ignore-scripts \
     --json \
     --pack-destination "$wrench_npm_artifact" \
     --registry=https://registry.npmjs.org > "$wrench_npm_json"
   wrench_npm_archive="$wrench_npm_artifact/hraness-wrench-0.15.1.tgz"
   bun run ./scripts/package-smoke.ts \
     --archive "$wrench_npm_archive" \
     --pack-json "$wrench_npm_json"
   ```

   Review the complete npm inventory, integrity, file count, packed size, and
   unpacked size. The smoke validates those reported values against the same
   tarball and installs it with npm in a clean consumer.

5. Publish that reviewed file with the signed-in maintainer session.

   ```sh
   wrench_npm_cache="$(mktemp -d)"
   npm publish "$wrench_npm_archive" \
     --access public \
     --cache "$wrench_npm_cache" \
     --ignore-scripts \
     --registry=https://registry.npmjs.org
   ```

   Complete npm's interactive two-factor authentication. Never put an npm
   password, one-time password, recovery code, session cookie, or token in Git,
   a workflow, a task file, or chat.

## Verify the registry artifact

Download the public package and compare it with the reviewed bootstrap file
before configuring automation or creating `v0.15.1`.

```sh
npm view @hraness/wrench@0.15.1 version \
  --registry=https://registry.npmjs.org
wrench_registry_artifact="$(mktemp -d)"
wrench_registry_json="$wrench_registry_artifact/npm-pack.json"
wrench_registry_view_json="$wrench_registry_artifact/npm-view.json"
npm pack @hraness/wrench@0.15.1 \
  --ignore-scripts \
  --json \
  --pack-destination "$wrench_registry_artifact" \
  --registry=https://registry.npmjs.org > "$wrench_registry_json"
npm view @hraness/wrench@0.15.1 name version dist \
  --json \
  --registry=https://registry.npmjs.org > "$wrench_registry_view_json"
wrench_registry_archive="$wrench_registry_artifact/hraness-wrench-0.15.1.tgz"
bun run ./scripts/npm-package-identity.ts \
  --source-archive "$wrench_npm_archive" \
  --source-pack-json "$wrench_npm_json" \
  --registry-archive "$wrench_registry_archive" \
  --registry-pack-json "$wrench_registry_json" \
  --registry-view-json "$wrench_registry_view_json" \
  --expected-name @hraness/wrench \
  --expected-version 0.15.1
bun run ./scripts/package-smoke.ts \
  --archive "$wrench_registry_archive" \
  --pack-json "$wrench_registry_json"
```

Continue only when the canonical package-identity comparison and the
clean-consumer smoke pass. The comparator binds both archives to their own npm
pack metadata, binds the downloaded archive to canonical registry metadata,
and requires identical paths, entry types, modes, sizes, and file bytes. It
deliberately ignores gzip transport headers, archive ownership, timestamps,
and tar entry ordering. The tag workflow repeats this source-to-registry
comparison before it creates the immutable GitHub Release.

## Configure stage-only trusted publishing

Create a GitHub environment named `npm-stage` after the first package is public.
Restrict its deployment branches to `main`. The `npm-stage` environment has no
required deployment reviewers, so passing **Verify exact package** allows
**Stage exact package** to start automatically. Do not add a secret to the
environment. npm's separate human inspection and two-factor approval remain
mandatory before the version becomes public.

If the current npm trust relationship does not name that environment, inspect
and revoke it before creating the replacement:

```sh
npm trust list @hraness/wrench \
  --json \
  --registry=https://registry.npmjs.org
npm trust revoke @hraness/wrench \
  --id <trust-id> \
  --registry=https://registry.npmjs.org
```

Configure the exact GitHub Actions identity:

```sh
npm trust github @hraness/wrench \
  --file npm-stage.yml \
  --repo hraness/wrench \
  --environment npm-stage \
  --allow-stage-publish \
  --registry=https://registry.npmjs.org
npm trust list @hraness/wrench \
  --json \
  --registry=https://registry.npmjs.org
npm access set mfa=publish @hraness/wrench \
  --registry=https://registry.npmjs.org
```

Complete each interactive two-factor authentication prompt. The trust
relationship must name `hraness/wrench`, the exact `npm-stage.yml` filename, the
`npm-stage` environment, and only `npm stage publish`. The package access setting
must require two-factor authentication and disallow traditional publishing
tokens. Do not add an npm token to GitHub.

## Create the first tag

Create the matching tag on the same `main` commit only after the registry
artifact and trusted-publisher settings are verified.

```sh
git tag v0.15.1
git push origin refs/tags/v0.15.1
```

The tag is a release request. Wait for the read-only verification job to
rebuild and compare the exact public npm tarball, then verify that the GitHub
Release is non-draft, immutable, and Latest.

## Stage a later version

1. Merge a monotonically greater stable version to `main`. A push that changes
   `package.json` starts **Stage npm package** automatically.
2. Wait for **Verify exact package**. It packs, smokes, and uploads one exact
   tarball with its `npm-pack.json`.
3. **Stage exact package** starts automatically through the main-only
   `npm-stage` environment. Only this minimal OIDC job can submit the verified
   tarball to npm's staging area.
4. Inspect the uploaded artifact and the staged npm package, then approve the
   npm stage with human two-factor authentication.
5. Download and smoke the public registry package.
6. Create the matching `v<version>` tag on the staged source commit.

The read-only classifier compares the current and prior `package.json` files. A
manifest edit with an unchanged version succeeds without running the verify or
OIDC jobs. A prerelease, malformed version, downgrade, unavailable push base, or
non-current `main` commit fails closed.

If the automatic run did not start or failed before npm accepted the stage,
dispatch **Stage npm package** from the current `main` branch. Manual recovery
runs the same verification and main-only environment path. Do not dispatch a
replacement after npm has accepted a stage for that version; continue with
inspection and two-factor approval.

Use the canonical registry for every inspection and promotion command:

```sh
npm stage list @hraness/wrench \
  --json \
  --registry=https://registry.npmjs.org
npm stage view <stage-id> \
  --json \
  --registry=https://registry.npmjs.org
npm stage download <stage-id> \
  --registry=https://registry.npmjs.org
npm stage approve <stage-id> \
  --registry=https://registry.npmjs.org
```

To complete this source version's release, download and smoke
`@hraness/wrench@0.16.2` after approving its stage. Keep the public coordinate
and tag literal through the final registry checks, then create `v0.16.2` on the
exact staged source commit:

```sh
npm view @hraness/wrench@0.16.2 name version dist \
  --json \
  --registry=https://registry.npmjs.org
git tag v0.16.2
git push origin refs/tags/v0.16.2
```

The staging workflow runs on GitHub-hosted runners with Node 24, npm 11.19.0,
Bun 1.3.14, disabled package-manager caching, and no stored npm token. It binds
the verified artifact to the current `main` commit, refetches `main` before
staging, and aborts if that commit is no longer the default-branch head. The
main-only `npm-stage` environment applies only to the terminal OIDC job and has
no required deployment reviewers.

`scripts/package-budget.ts` owns the shared packed-byte, unpacked-byte, and
file-count ceilings used by artifact inspection and the clean-consumer smoke.
Remeasure the candidate with the pinned npm version after any reviewed payload
change. Keep enough packed-byte room for the observed Linux and macOS gzip
spread without replacing the path and content checks with a broad size limit.

## Deploy the release-bound website

Configure the Vercel project's Production Branch as `website-production` and
keep Vercel System Environment Variables enabled for builds. The checked-in
build command injects exact non-secret marker
`WRENCH_VERCEL_BUILD=release-bound-v1`. Local admission is allowed only when
that marker and every Vercel signal are absent. Any marked or Vercel-signaled
build requires the exact marker, `VERCEL=1`, a valid `VERCEL_ENV`, and an exact
nonempty `VERCEL_GIT_COMMIT_REF`; missing, malformed, or inconsistent platform
state fails before external verification or site generation. Production also
requires `VERCEL_GIT_COMMIT_REF=website-production`, while that ref is rejected
for a non-production deployment.
`main` and pull requests are preview sources only; they may describe a package
candidate that has not completed npm staging, tagging, or immutable Release
publication, so they must never replace the public production site.

Vercel will not accept a Production Branch that does not exist. For the one-time
migration only, first verify the current immutable Latest Release against its
exact remote tag commit and canonical npm version, then create
`website-production` once at that release commit with the GitHub create-ref API.
Fail if the branch already exists, and never bootstrap it from `main` or an
unreleased candidate. Configure Vercel only after that exact ref exists. This
exception must never be repeated: after initial setup, the release workflow is
the sole writer and every change is a checked, non-force fast-forward.

After the one-time bootstrap has established `website-production`, the tag
workflow rebuilds and compares the exact public npm package, creates or verifies
the non-draft, non-prerelease immutable GitHub Release, and proves that Release
is Latest. Its final step requires the production branch to resolve to one exact
commit, then fast-forwards it to the verified tag commit. It sends `force=false`
and fails closed on a missing or malformed branch, moved tag, divergence,
rollback, or post-update mismatch. The workflow never recreates the branch.

If that workflow fails after publishing the immutable Release but before the
website source advances, merge the reviewed workflow fix to `main` first. Then
dispatch **Release** from the current `main` ref with the required exact stable
`release_tag`. The recovery path checks out that tag, repeats the complete
source and public npm verification, requires the tag to remain the newest
stable tag reachable from `main`, and revalidates the existing immutable Latest
Release before it can advance `website-production`. It does not recreate or
modify a conforming existing Release. The dispatch workflow source commit must
equal the current default-branch head both before the tag checkout and again
before the write-scoped job; ordinary tag-push releases do not depend on `main`
remaining unchanged. Never rerun a stale tag workflow or write the production
branch manually.

Vercel runs the checked-in marked `website:vercel-build` command. Valid preview
and development builds, plus true local builds with no Vercel signal, generate
the site without external release checks. A production build first requires the
checked-out HEAD and root package version to equal the exact `v<version>` commit
returned by GitHub's bounded public commit API, requires canonical npm to
contain that version with SHA-512 integrity, and requires the matching immutable
GitHub Release to be non-draft, non-prerelease, and Latest. Public JSON response
bodies and the fixed local `git rev-parse HEAD` child output are streamed under
fixed byte bounds. Only then does the build derive the public release
identity and provider capability attestation from that exact source tree.

This production admission assumes a Vercel Git deployment whose checkout keeps
a resolvable Git `HEAD`; missing repository metadata is a hard failure, not a
reason to trust deployment environment variables. Canonical npm name, version,
and SHA-512 integrity are sufficient at this layer because the only workflow
allowed to advance `website-production` after that one-time bootstrap first
rebuilds the tag and compares its
exact tarball with canonical npm before creating the immutable Release. The
production verifier then independently rechecks the promoted commit, tag,
registry coordinate, and immutable Latest Release.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/), [staged
publishing](https://docs.npmjs.com/staged-publishing/), and [dual-use package
publishing](https://docs.npmjs.com/policies/dual-use/).
