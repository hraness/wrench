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
exception must never be repeated.

The live repository currently applies active ruleset `21832074` only to
`refs/heads/website-production`. It has no bypass actors,
`current_user_can_bypass=never`, and exact `deletion` and `non_fast_forward`
rules. That narrow layer makes the established ref protected against deletion
and non-fast-forward movement. It does not restrict ordinary fast-forward
updates, protect creation, prove a dedicated writer, or provide canary evidence.
The dedicated App installation, `production-ref-writer-key` environment,
App-only update rule, creation rule, persistent canary, and their live readbacks
remain mandatory reconciliation work. Do not describe those controls as active
until their out-of-band setup and positive and negative canary proofs are
complete. GitHub Actions App Integration 15368 is not the production writer and
must not be configured as the update-rule bypass.

Checked-in `CODEOWNERS` assigns the workflow, Release helper, and publishing
policy paths to `0thernet`, but that source declaration does not claim live
review enforcement. Live Protect-main ruleset `20921911` still carries an
OrganizationAdmin `always` bypass, requires no approving review, and does not
require code-owner review. The privileged reconciliation must remove that
bypass and enable code-owner review before the App key is admitted. Repository
Actions default to read, and the checked workflow census leaves only the
Release `publish` job with a `contents: write` `GITHUB_TOKEN`; the separate
promotion job keeps that token read-only and uses the short-lived App token only
inside the leased Git push.

After the one-time bootstrap has established `website-production`, the tag
workflow rebuilds and compares the exact public npm package, creates or verifies
the non-draft, non-prerelease immutable GitHub Release, and proves that Release
is Latest. It does not read or update `website-production`, wait for Vercel, or
receive the dedicated App key. The Release lookup accepts only an exact REST 200
or 404 response.
Only an authenticated exact 404 permits one REST create request with
server-generated notes; authentication, transport, other API, or malformed
response failures abort. The workflow validates an exact REST readback before
checking Latest. It does not use opaque `gh release view` or
`gh release create` commands, so hidden requests cannot escape the bounded
control path. The tag and its peeled commit must remain exact current `main`
before creation and at the terminal readback.

The separate **Promote website production** workflow is loaded from current
default-branch `main`. GitHub starts it after **Release** completes, and manual
recovery dispatches this workflow directly from current `main` with an untrusted
stable-tag input. The automatic path treats the entire `workflow_run` payload as
foreign data. It requires repository `hraness/wrench` with numeric ID
`1316443113`, Release workflow ID `323493609`, exact workflow name and path, a
tag `push`, first attempt, successful conclusion, this repository as the head
repository, and one head SHA and tag that both equal current `main`. Both paths
check out that exact current-main source, bind its package version and newest
stable tag, and verify the immutable asset-free Latest Release before any
provider or ref work.

Before any key-gated job starts, a read-only job records a bounded, complete
snapshot of GitHub's Production deployments. Authenticated GitHub
`Date` headers bracket that snapshot without trusting the runner clock. The job
uses bounded GraphQL pages to read the complete current inventory of at most 500
Production deployments. It validates each deployment's exact SHA, task,
Production environment and original environment, pinned Vercel bot, state, and
current `latestStatus`. Two stable, order-independent reads bind the branch and
the complete current-state fingerprint. The global receipt does not depend on
older deployment-status rows because GitHub removes previous deployment
statuses after 90 days while preserving the current status on the deployment.
The baseline outputs whether the established production ref already equals the
verified release. The already-exact branch takes a separate read-only job. That
job has no environment admission, App variable, private key, token mint, or Git
push. It still revalidates current-main workflow source, the peeled tag,
immutable Release, Latest, the baseline, authenticated server time, and the
terminal ref before emitting a receipt.

Only an actual fast-forward enters `production-ref-writer-key`, configured with
`deployment: false` so the secret-bearing job does not create a GitHub
Deployment record that could collide with the Vercel-only Production inventory.
The environment must permit only `main`, require reviewer `0thernet`, disable
admin bypass, and store only `WRENCH_RELEASE_APP_PRIVATE_KEY` plus the reviewed
App ID, client ID, slug, and selected installation ID variables. The job repeats
the full current-main, peeled-tag, immutable Release, and Latest authority check
after environment approval and before mutation.

The writer authenticates one private Hraness-owned GitHub App installed only on
repository ID `1316443113`. Its App, installation, and minted token must all
close to exactly `metadata:read` and `contents:write`; Administration and
Workflows permissions are forbidden. The minted token response must name that
sole selected repository, carry a bounded one-hour expiry, and fit the streamed
response parser. The helper masks the token, passes it only through a private
`GIT_ASKPASS` environment, and runs one fixed HTTPS push with the explicit
compare-and-swap lease
`--force-with-lease=refs/heads/website-production:<expected-old>`. The push has
one exact source-to-destination refspec, no tags, no hooks, no persisted Git
configuration or checkout credential, no interactive prompt, and a 60-second
process cap. The App token is revoked before the exact production-ref post-read;
operation and revocation failures are both retained when they coincide. Every
read-only `gh api` child receives `GH_TOKEN` but has every
`WRENCH_RELEASE_APP_*` value removed from its environment. A missing branch,
moved tag, concurrent ref update, divergence, rollback, server-time regression,
source drift, token-scope drift, push rejection, revocation failure, or post-read
mismatch fails closed. The workflow never creates, deletes, force-moves, or
recreates the branch.

A dependent job with only `contents: read` and `deployments: read` owns the
bounded provider wait. After a new fast-forward, it accepts exactly one new
GitHub Production deployment whose SHA is the verified release commit, whose
task is `deploy`, whose environment and original environment are `Production`,
and whose creator is the pinned Vercel bot. Recovery from an already-exact
branch instead selects the unique newest deployment for the verified SHA and
requires it to postdate the immutable Release. A newer or same-second deployment
for another SHA blocks recovery when its current Vercel status is successful.
A newer terminal failure, error, or inactive deployment does not displace the
exact successful candidate. Both paths require the REST deployment's lowercase
40-hex `.ref` to equal its `.sha` and the verified release commit. The matching
GraphQL deployment must expose `ref: null` while `commitOid` equals that same
commit. These source fields remain in the pinned candidate fingerprint. Both
paths recheck the exact tag, immutable Release, Latest Release, production ref,
and current-main workflow source, and pin one deployment. The automatic
`workflow_run` and manual recovery coordinates both remain bound to the current
default-branch head throughout the read-only outcome proof.
Every poll rereads the complete GraphQL current-state inventory. The pinned
candidate also gets an exhaustive, order-independent REST status-history read
with a 500-row cap and empty sentinel page. Any retained failure, error, or
inactive row rejects the candidate even when a newer row says success. GraphQL
`latestStatus.id` must equal the REST status `node_id`; that current status must
keep its exact GitHub
deployment URL, Production environment, pinned Vercel creator, and one shared
canonical `https://wrench-<id>-hraness.vercel.app` target, environment, and log
URL. Same-second status rows are resolved only by that cross-API node identity.
The job requires the initial success observation plus two complete consistent
readbacks, repeats the complete deployment inventory after the final status
read, and sandwiches terminal state with exact tag, Release, Latest, ref, and
workflow-source authority reads. The observation window starts immediately
before the first provider read, after the initial authority checks. Production
uses exactly 20 observation slots anchored to that start at offsets zero through
19 minutes inside the half-open monotonic `[start, deadline)` window. API latency
reduces the sleep before the next absolute slot instead of sliding the schedule,
and both success confirmations consume the same 20-minute window. Each `gh api`
process has a 60-second cap reduced to the remaining window. No provider API
process starts with less than one millisecond remaining, and every completed
process must strictly advance the injected monotonic clock.
After an unsuccessful slot 20, the default cadence performs only a final bounded
sleep to the 20-minute deadline and rejects without starting another API read.
A reduced poll count or test cadence rejects immediately after its configured
final observation. An early sleep resolution cannot trigger another provider
read before its absolute slot. The contract makes no visibility claim for a
deployment that changes after the slot-20 query completes. A final external read
that completes exactly at the deadline remains eligible from its captured
completion; no redundant clock sample or later API read follows it. A later
completion, a frozen or regressing clock, poll-budget exhaustion before the
deadline, or an empty or nonterminal result fails closed. The workflow job has
a separate 30-minute timeout, leaving ten minutes for checkout, Node setup, and
runner teardown around the product deadline.

The bounded request contract is separate for REST and GraphQL. The current
control flow can make at most 197 REST calls in the provider outcome job and 277
REST calls across the immutable Release and downstream promotion workflows,
leaving 723 calls under the repository `GITHUB_TOKEN` limit of 1,000 REST
requests per hour. The promotion helper itself uses at most 13 read-only REST
calls; its leased Git push and four App-authentication requests do not consume
that `GITHUB_TOKEN` budget. Five
bounded GraphQL pages across two baseline reads, 20 observations, and two
confirmations make at most 120 requests. Each response must cost no more than
two points, for a 240-point ceiling and 760 points of headroom under the
separate 1,000-point GraphQL limit. API errors, malformed or incomplete
pagination, rate-limit drift,
timestamp ambiguity, competing deployments, identity drift, Latest Release or
workflow-source drift, terminal failure, timeout, or final readback drift fail
the promotion workflow. Read-only GitHub responses are capped at 8 MiB; App
identity, installation, token, and revocation responses are streamed under a
1 MiB cap; and each encoded cross-job receipt is capped at 64 KiB. This check
needs no Vercel token, PAT, or redeploy.

If promotion fails after the immutable Release exists, merge the reviewed fix to
`main` first. Then dispatch **Promote website production** from exact current
`main` with the immutable Latest stable tag. Recovery never reruns or changes
the tag Release, and it cannot promote an older workflow source. An
already-exact recovery remains entirely outside the key environment. A required
fast-forward repeats every authority check after reviewer admission before it
mints the one-repository App token. Never rerun an ambiguous App push, bypass the
explicit lease, or write the production branch manually.

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
reason to trust deployment environment variables. Keep `.git` out of
`.vercelignore` so the Git-connected shallow clone retains the metadata needed
for this independent check. Canonical npm name, version, and SHA-512 integrity
are sufficient at this layer because the tag Release workflow first rebuilds
and compares the exact tarball with canonical npm before creating the immutable
Release, and the separate current-main workflow advances `website-production`
only after it revalidates that release authority. The production verifier then
independently rechecks the promoted commit, tag, registry coordinate, and
immutable Latest Release.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/), [staged
publishing](https://docs.npmjs.com/staged-publishing/), and [dual-use package
publishing](https://docs.npmjs.com/policies/dual-use/).
