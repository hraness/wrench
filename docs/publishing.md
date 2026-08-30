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

Checked-in `CODEOWNERS` assigns source ownership and notification for the
workflow, Release helper, and publishing policy paths. It does not claim live or
independent review enforcement. Live Protect-main ruleset `20921911` still
carries an OrganizationAdmin `always` bypass, requires no approving review, and
does not require code-owner review. Privileged reconciliation must remove that
bypass while retaining the pull-request path and exact Required integration
check. Wrench currently has one eligible maintainer, so
`require_code_owner_review` must remain `false` and the approval minimum must
remain zero until a second eligible independent code owner exists. Enabling it
now would make the repository unreviewable rather than safer. Repository Actions
default to read, and the checked workflow census leaves only the Release
`publish` job with a `contents: write` `GITHUB_TOKEN`; the separate promotion job
keeps that token read-only and uses the short-lived App token only inside the
leased Git push.

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
The create request supplies the verified SHA as `target_commitish`, but GitHub
does not use that field when the tag already exists, and live readback may report
the default branch. Promotion therefore treats `target_commitish` as
non-authoritative. It binds the stable Release ID and publication time across
the authority sandwich and every promotion/outcome receipt readback while the
exact tag name, encoded peeled-tag commit, immutable state, Latest Release, and
current-main ancestry provide release authority.

The separate **Promote website production** workflow is loaded from current
default-branch `main`. GitHub starts it after **Release** completes, and manual
recovery dispatches this workflow directly from current `main` with an untrusted
stable-tag input. The automatic path treats the entire `workflow_run` payload as
foreign data. It requires repository `hraness/wrench` with numeric ID
`1316443113`, Release workflow ID `323493609`, exact workflow name and path, a
tag `push`, first attempt, successful conclusion, and this repository as the head
repository. The workflow source must equal current `main`; the automatic head
SHA must instead equal the peeled immutable tag commit, and that release commit
must be an ancestor of the current-main workflow source. Manual recovery carries
no upstream SHA. Both paths check out the exact current-main source, bind the
package version from the peeled tag commit and the newest stable tag, and verify
the immutable asset-free Latest Release before any provider or ref work.

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
admin bypass, set `prevent_self_review=false` because that reviewer is currently
the sole eligible maintainer, and store only `WRENCH_RELEASE_APP_PRIVATE_KEY`
plus the reviewed App ID, client ID, slug, and selected installation ID
variables. The job repeats the full current-main, peeled-tag, immutable Release,
and Latest authority check after environment approval and before mutation.

The writer authenticates one private Hraness-owned GitHub App. The checked
provisional source and initial App registration close to exactly
`metadata:read` and `contents:write`, with no Administration permission. Runtime
checks bind the configured App and selected installation identities, request a
token narrowed to repository ID `1316443113`, and require the minted token
response to name only that repository. That runtime token proof does not prove
the installation-wide selected-repository set. Before admitting the key,
privileged setup must exhaustively read every repository selected for the
installation with the administrator identity, prove that the unique result is
`hraness/wrench` at ID `1316443113`, and retain the exact readback with the
canary evidence.

The contents-only permission set is provisional until one exact `P` to `C`
transition on persistent ref `refs/heads/website-production-canary` proves a
leased fast-forward where `C` contains the real workflow-file changes. Create
that canary ref once at `P` before its creation rule becomes active, then retain
it at `C`; the transition is single-use, and the ref must never be reset,
deleted, or repurposed. Its no-bypass creation, deletion, and non-fast-forward
rules and its App-only update rule must exactly mirror the production layers. A
separately reviewed temporary workflow loaded from exact current `main` may run
the bounded proof, but it must be removed after its exact run, ref, ruleset,
rule-suite, token-revocation, and ordinary-actor denial evidence is retained.
The production helper remains hard-bound to `website-production` and must not be
made caller-selectable for the canary. The release remains unready for
production activation or final product merge until that proof passes. If GitHub
rejects the push because the App also needs Workflows permission, preserve the
exact failure evidence and keep production frozen. A separate reviewed source
and App-registration change may then add exactly `workflows:write`, after which
the complete canary must run again. Never broaden the App silently or during a
failed canary.

The temporary **Prove release App canary** workflow is the single-use exception
to the production writer boundary. It has no inputs and accepts only a first
attempt `workflow_dispatch` by `0thernet` (`actor_id=894119`) from exact protected
current `main` in Wrench repository ID `1316443113`. Its fixed coordinate has
three consecutive commits. `P` is the merged #105 commit that first suppresses
Vercel deployments for `website-production-canary`; `C` is the direct-child
control merge whose exact 11-file delta contains the real Release and promotion
workflow changes; and `D` is the direct-child four-file temporary canary source.
The helper requires the same byte-identical Vercel exclusion at `P`, `C`, and
`D`. The checked source binds `P` and `C` to those immutable merge SHAs
separately from two retained 40-hex sentinel fixtures. The parser proves the
exact fixed coordinate is accepted while either unresolved sentinel always
fails before any GitHub read or mutation. The repository workflow
history must contain exactly this one active first-attempt dispatch and no prior
or concurrent run of the temporary workflow. That durable one-shot admission is
rechecked immediately before and after the write; a fresh dispatch is not a
second permissible attempt merely because GitHub numbers it attempt 1.

A read-only preflight binds `D` to the workflow context, checkout, current
default-branch ref, protected ref, maintainer identity, run ID, repository, exact
`P` canary ref, unchanged production ref, and the same four applicable rules on
production and canary. Those four rules must resolve to one repository-owned
lifecycle ruleset containing only creation, deletion, and non-fast-forward, and
one repository-owned update ruleset containing only an update restriction with
fetch-and-merge disabled. The environment job repeats the complete readback and
requires the ruleset IDs and `updated_at` values to equal the privileged
fingerprints stored in `production-ref-writer-key`. Read-only GitHub responses
cannot prove bypass actors; the separately captured administrator JSON must bind
the lifecycle ruleset to no bypass and the update ruleset to the one exact
release App Integration with `always`, never `exempt`.

Only the second job enters
`environment: { name: production-ref-writer-key, deployment: false }`. It reuses
the production App identity, selected-installation, one-repository token,
masking, and revocation helper, but uses a separate temporary writer that is
hard-bound to `refs/heads/website-production-canary`. The writer performs one
complete main, production, canary, and ruleset readback after minting the token,
then performs one successful explicit
`--force-with-lease=refs/heads/website-production-canary:P` fast-forward from
`P` to `C`, then proves that a distinct `P` to `D` write is rejected by the stale
`P` lease. It never has a
mutation endpoint or refspec for `main` or `website-production`. After the token
is revoked, one bounded token-authenticated repository read must return 401.
Read-only terminal checks require `main=D`, production unchanged, canary `C`,
both rulesets unchanged, and non-regressing authenticated GitHub server dates.

The workflow emits one secret-free bounded evidence record containing the run,
actor, repository, `P`, `C`, `D`, production ref, App identity, ruleset IDs,
node IDs and timestamps, authenticated before/write-bound/after times, and
digests of the successful and stale-lease Git results. The secret-bearing proof
step passes that record only as a canonical base64url step output. A following
step receives no App key, token, preflight receipt, or App configuration. It
decodes and revalidates the exact schema, run, repository, actor, and `P`/`C`/`D`
coordinate, then writes the single
`WRENCH_RELEASE_APP_CANARY_EVIDENCE_V1=` marker to the job summary and the
downloadable Actions job log. The output alone is not retained evidence because
the Actions API does not expose step or job outputs after the run.

Before cleanup, capture the `prove` job ID and retrieve its downloaded Actions
job log. Feed that one bounded log to the checked parser:

```sh
gh api /repos/hraness/wrench/actions/jobs/<prove-job-id>/logs \
  | node scripts/release-app-canary.mjs parse-evidence-log
```

The parser accepts at most 4 MiB, requires exactly one marker (with only an
optional GitHub timestamp prefix), decodes at most 16 KiB, rejects noncanonical
JSON or any extra field, and prints one canonical JSON record. Retain that JSON,
its SHA-256, the original downloaded log, and the run/job IDs outside the
temporary branch before merging cleanup. A missing, duplicate, malformed, or
unparseable marker invalidates the proof and must never be reconstructed from a
human transcription or from the inaccessible workflow output. An administrator
must bind that record to the unique repository Rule Suite for the `P` to `C`
transition, exact
github-actions workflow run, release App actor, update-rule bypass, passing
destructive rules, and pushed-at interval. Any error, transport ambiguity,
unexpected ref state, missing Rule Suite, or post-read mismatch makes the proof
unusable. Never rerun that workflow or reset the persistent canary. A failed
attempt can continue only through a newly reviewed consecutive coordinate and
new probe ref. After successful evidence capture, a separate checked cleanup PR
must reverse all four temporary path changes: delete this workflow and helper,
remove this temporary documentation block, and remove the temporary canary tests
and imports from the shared workflow test. Retain the `C` canary ref, its mirrored
rulesets, the Vercel exclusion, and the external evidence permanently.

The minted token must carry a bounded one-hour expiry and fit the streamed
response parser. The helper masks it and passes it only through a private
`GIT_ASKPASS` environment. Because the writer checks out only exact current-main
workflow source, it first fetches only the verified tag through the fixed HTTPS
repository URL, peels that fetched object locally, and requires the result to
equal the independently verified release SHA. It does not check out or execute
tagged code. The same ephemeral credential boundary then runs one fixed push
with the explicit compare-and-swap lease
`--force-with-lease=refs/heads/website-production:<expected-old>`. The push has
one exact source-to-destination refspec, no followed tags, no hooks, no persisted
Git configuration or checkout credential, no interactive prompt, and a
60-second cap on each Git process. The App token is revoked before the exact production-ref post-read;
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
control flow can make at most 197 REST calls in the provider outcome job. The
worst missing-Release path uses 16 calls, including all five bounded release
pages plus the empty sentinel page. The immutable Release and downstream
promotion workflows together use at most 278 REST calls, leaving 722 calls
under the repository `GITHUB_TOKEN` limit of 1,000 REST requests per hour. The
promotion helper itself uses at most 13 read-only REST
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
the tag Release. It resolves the peeled tag as the verified release SHA, keeps
that coordinate distinct from the exact current-main workflow SHA, and requires
the release commit to remain an ancestor of the workflow source. An
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
