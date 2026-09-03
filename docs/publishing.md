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

Release verification starts from a depth-one, credential-free checkout of the
requested tag. `scripts/release-ref-authority.ts` reads only the exact remote
`main` ref and the bounded `refs/tags/v*` inventory. The combined inventory must
be canonical UTF-8, at most 64 KiB and 500 rows, and stable across two reads.
The helper imports only those governed refs with tags disabled and without
writing `FETCH_HEAD`. Wrench release tags are lightweight direct commit tags.
The requested tag and checkout must name one commit `C`, and protected linear
`main` must equal or descend from `C`. An annotated requested tag, moved ref,
divergence, rollback, or malformed advertisement fails closed. A higher raw
`v*` tag is only a queued release request; bounded non-draft, non-prerelease,
immutable Releases determine completed-release ordering.

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

The tag-push Release workflow intentionally executes source `S=C`: GitHub loads
the workflow bytes from the tagged product/source commit. Release-control bytes
in `C` must therefore contain the final reviewed repair before the tag exists.
For v0.16.3, do not create a tag from
`c2d956ca4102d38c29e24ca4e13f26ce862b47f3` or reuse any stage produced from a
source that predates this repair. If release controls change materially after
staging, that stage is ineligible for tagging; create and verify a fresh stage
from the final repaired descendant.

The read-only classifier compares the current and prior `package.json` files. A
manifest edit with an unchanged version succeeds without running the verify or
OIDC jobs. A prerelease, malformed version, downgrade, unavailable push base, or
event source outside protected `main`'s linear history fails closed.

Both classifier and verifier use an exact depth-one, no-tag, credential-free
checkout of the event source `C`. They bind the advertised protected `main`
tip `M` twice, import only that governed history under a temporary private ref,
and require `C=M` or strict linear ancestry `C<M`. A later no-version-change
push may therefore advance `main` during the long package gate without
changing the artifact already bound to `C`; a later workflow change still makes
that stage ineligible for tagging under the rule above. For a push, the
classifier also requires GitHub's exact nonzero `before` commit to be present
and an ancestor of `C`, removes the ref, and reads the prior manifest by object
ID. Manual recovery has no prior commit. Neither path uses a broad ref fetch, a forced
refspec, or `FETCH_HEAD` as authority.

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
`@hraness/wrench@0.16.3` after approving its stage. Keep the public coordinate
and tag literal through the final registry checks, then create `v0.16.3` on the
exact staged source commit:

```sh
npm view @hraness/wrench@0.16.3 name version dist \
  --json \
  --registry=https://registry.npmjs.org
git tag v0.16.3
git push origin refs/tags/v0.16.3
```

The staging workflow runs on GitHub-hosted runners with Node 24, npm 11.19.0,
Bun 1.3.14, disabled package-manager caching, and no stored npm token. It binds
the verified artifact and final tarball hash to source `C`. The checkout-free
terminal OIDC job observes the combined governed refs twice with one
`ls-remote` connection per observation, requesting exact protected `main` and
the prospective tag together. Each canonical advertisement is capped at 64 KiB
and 500 rows, must contain one `main` row and no requested tag, and the pair
must be byte-identical. If advertised main is `M!=C`, one authenticated,
strictly parsed comparison must prove positive-ahead linear ancestry `C<M`,
with `behind_by=0`, exact base and merge base `C`, and terminal commit `M`.
The tarball hash precedes both observations and the second advertisement is
immediately adjacent to `npm stage publish`. A protected descendant advance
after that last read leaves the quarantined, reviewable stage bound to `C`;
tagging and publication rebind the approved bytes before release. These are
repeated governed-ref observations, not an atomic snapshot. The job does not
initialize or fetch a repository, execute checked-out scripts, or use
`FETCH_HEAD`. Its only GitHub token permission is `contents:read`, alongside
OIDC `id-token:write`. The main-only `npm-stage` environment applies only to
this terminal job and has no required deployment reviewers.

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

Live ruleset `21832074` targets exactly `refs/heads/website-production` and
`refs/heads/website-production-canary`. It has no bypass actors,
`current_user_can_bypass=never`, and exact creation, deletion, and
non-fast-forward rules. Live ruleset `21887484` targets the same refs with one
update restriction and exactly one `Integration` bypass for dedicated App
`4783991` with `bypass_mode=always`. Together they deny ref creation, deletion,
non-fast-forward movement, and every update except the dedicated App's admitted
fast-forward. Production-only freeze ruleset `22149969` adds no-bypass creation,
update, deletion, and non-fast-forward restrictions while production remains
safely frozen. The App-only writer passed the positive and negative canary
proofs retained below, but the production freeze blocks its use until a fresh
release-owner audit. GitHub Actions App Integration 15368 is not the
production writer and must not be configured as the update-rule bypass.

The retained canary proof is evidence, never standing
mutation authority.
Before every required fast-forward, fresh administrator readback must
reconfirm the exact permanent rulesets and target refs and the sole App
`4783991` `Integration` bypass. It must prove that the App registration still
grants exactly `metadata:read`, `contents:write`, and `workflows:write` with no
other permission, and that installation `158077029` still selects exactly
repository `hraness/wrench` at ID `1316443113`. The
`production-ref-writer-key` environment still has `deployment=false`, a
main-only branch policy, sole reviewer `0thernet`, `prevent_self_review=false`,
administrator bypass disabled, exactly the four variables
`WRENCH_RELEASE_APP_ID`, `WRENCH_RELEASE_APP_CLIENT_ID`,
`WRENCH_RELEASE_APP_SLUG`, and `WRENCH_RELEASE_APP_INSTALLATION_ID`, and
exactly the `WRENCH_RELEASE_APP_PRIVATE_KEY` secret. Any drift leaves
production unchanged. This evidence correction does not authorize removal of
live production freeze `22149969`.

Checked-in `CODEOWNERS` assigns source ownership and notification for the
workflow, Release helper, and publishing policy paths. It does not claim live or
independent review enforcement. Live Protect-main ruleset `20921911` has no
bypass actors, retains the pull-request path and exact Required integration
check, requires no approving review, and does not require code-owner review.
Wrench currently has one eligible maintainer, so
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
control path. The direct lightweight tag must remain on the verified release
commit `C`, and protected linear `main` at each observation must equal or
descend from `C`. That descendant movement is release-authority-safe only while
`git diff --quiet --no-ext-diff --no-textconv C M -- .github/workflows`
confirms that the workflow definitions are unchanged. The early release check
and both publication-boundary checks enforce that condition using the exact
imported `C` and `M` objects. After completed-release-order validation and
immediately before the irreversible create request, authenticated GitHub API
reads still bind both coordinates. The release-ref helper then observes
the combined governed `main` and `refs/tags/v*` advertisement twice, through
one `ls-remote` connection per observation, and requires the two canonical
advertisements to be equal. This is a bounded repeated observation, not an
atomic provider snapshot. Protected tag immutability and monotonic main ancestry
keep a later main fast-forward from changing `C`; that movement remains
release-authority-safe only when it also preserves the workflow definitions.
The terminal readback repeats both the authenticated API checks and the
combined-advertisement helper, including the workflow-tree comparison. A
workflow change in the irreducible prewrite-to-POST window may make GitHub's
Release POST fail closed; the workflow never deletes, patches, or rolls back a
Release in response. The POST uses `make_latest=legacy`; a higher raw
`v*` tag is only another queued request, while bounded published immutable
Releases define completed ordering. If the terminal readback observes another
immutable Release as Latest, this release remains valid and the workflow fails
with explicit recovery guidance for the observed Latest coordinate. A
supersession after that final read is not observable by the completed workflow.

Immediately before the tag push that dispatches **Release**, a signed-in
administrator must read back immutable Releases as `enabled=true`. The workflow
token deliberately keeps only `contents:write` and cannot read that
Administration endpoint. This fresh control-plane check is therefore a trusted
operator boundary, with a residual administrator-toggle window that repeated
workflow reads cannot remove. The created and terminal Release readbacks must
still report `immutable=true`.

Run this with the signed-in administrator session immediately before creating
the tag. It records both the required enabled state and GitHub's
`enforced_by_owner` diagnostic without granting the workflow Administration:

```bash
immutable_release_state="$(gh api \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2026-03-10' \
  /repos/hraness/wrench/immutable-releases \
  --jq '{enabled: .enabled, enforced_by_owner: .enforced_by_owner}')"
IMMUTABLE_RELEASE_STATE="$immutable_release_state" node <<'NODE'
const value = JSON.parse(process.env.IMMUTABLE_RELEASE_STATE ?? "null");
if (
  value === null ||
  typeof value !== "object" ||
  Array.isArray(value) ||
  Object.keys(value).sort().join(",") !== "enabled,enforced_by_owner" ||
  value.enabled !== true ||
  typeof value.enforced_by_owner !== "boolean"
) process.exit(1);
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
```

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
repository. The reviewed workflow source `W` originates from `main`; the
automatic head SHA must instead equal the peeled immutable tag commit `C`.
Manual recovery carries no upstream SHA. Both paths check out exact `W`, bind
the package version from `C`, verify the immutable asset-free Latest Release,
and prove `C<=W<=M` for protected current main `M` before any provider or ref
work. Main may advance by protected linear fast-forward after dispatch without
invalidating reviewed `W`.

That promotion checkout is depth one with tags and credentials disabled. The
same bounded release-ref helper observes `main` and the bounded `refs/tags/v*`
inventory in one combined governed-ref advertisement per observation. It then
imports only exact advertised `main` and the requested lightweight tag, without
writing `FETCH_HEAD`, proves the requested tag is direct commit `C` and proves
`C<=W<=M`, and requires a second combined advertisement to equal the first.
Raw tag order is not completed-release order. Every
later promotion job checks out only the already-verified workflow SHA at depth
one with tags disabled; provider and App/CAS authority remain separate from Git
ref discovery.

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
push. It still revalidates reviewed workflow-source ancestry, the peeled tag,
immutable Release, Latest, the baseline, authenticated server time, and the
terminal ref before emitting a receipt.

Only an actual fast-forward enters `production-ref-writer-key`, configured with
`deployment: false` so the secret-bearing job does not create a GitHub
Deployment record that could collide with the Vercel-only Production inventory.
The environment must permit only `main`, require reviewer `0thernet`, disable
admin bypass, set `prevent_self_review=false` because that reviewer is currently
the sole eligible maintainer, and store only `WRENCH_RELEASE_APP_PRIVATE_KEY`
plus the reviewed App ID, client ID, slug, and selected installation ID
variables. The job repeats the full `C<=W<=M`, peeled-tag, immutable Release,
and Latest authority check after environment approval and before mutation.

The writer authenticates one private Hraness-owned GitHub App. The App
registration and every minted token close to exactly `metadata:read`,
`contents:write`, and `workflows:write`, with no Administration or other
permission. Workflows write is required because an admitted fast-forward may
introduce reviewed `.github/workflows` changes. Runtime checks bind the
configured App and selected installation identities, request that exact
permission set on a token narrowed to repository ID `1316443113`, and require
the minted token response to name only that repository. That runtime token
proof does not prove the installation-wide selected-repository set. Before
admitting the key, privileged setup must exhaustively read every repository
selected for the installation with the administrator identity, prove that the
unique result is `hraness/wrench` at ID `1316443113`, and retain the exact
readback with the canary evidence.

The single-use permission and writer proof completed on 2026-09-02 from exact
current-main workflow SHA
`fb876445334bb74abcb3592a5aaae2672c7b2d96` in workflow `345799741`, run
`33691443614`, attempt 1, dispatched by `0thernet` (`actor_id=894119`).
An ordinary `0thernet` `P` to `C` update was denied in Rule Suite `3922909251`.
The dedicated App bot then performed the only admitted leased fast-forward in
Rule Suite `3922938237`; the update restriction failed and was admitted only by
the exact App Integration bypass, while the lifecycle rules passed. The canary
moved from `P=6d9096b0fabbc03ede0741ec4931fbe19127440c` to
`C=0bf88a064233635e0c5485c61f9c533974a7dca4`. Production remained
`33309c470336127228b959e2aaa54138247b9684`, and `main` remained the workflow
SHA. The canary remains at `C` and must never be reset, deleted, or repurposed.

The durable pre-cleanup archive's `PRE_CLEANUP_MANIFEST.tsv` SHA-256 is
`cf899eac777336a06dd3d19c41512ae60d1e19f848fdf709c5284ddf73564815`.
It binds exact App `4783991` and selected installation `158077029`.

A separate one-shot key-setup proof for that exact App and installation is
anchored by the packet `SHA256SUMS` SHA-256
`62449019d3a2c6c5bed4c1f5d25d9a5383f95e865da7335a579e1cbe28f2b148`,
the complete `EXECUTION_JOURNAL.jsonl` SHA-256
`4facee05aa0493bb3f724a47729079fd107f4f2d029a4547d5fcbd0df2fa9560`,
and the `KEY_PROOF_RECEIPT_V3.json` SHA-256
`a3d75a3adf39286cab828ea0dd3ac0e3c8242e9a18c73f51f06f20bde0e0e468`.
Its terminal journal-record digest is
`9d6c91d29fb8932a6abba9b2f9d4822a153011d0642dd61150a4b9a8bf8da75b`.
These four anchors identify the one-shot key-setup proof.

The base64-decoded `WRENCH_RELEASE_APP_CANARY_EVIDENCE_V2` value emitted by
workflow run `33691443614` ends at its closing `}` byte with no trailing line
feed and has SHA-256
`b3b285d8d8965851595ff991ba4a4ffa327b605350c161fca36dc09a32b5bb27`.
Archived file `terminal.canary-evidence.json` contains those same JSON bytes
plus exactly one trailing line feed and has SHA-256
`5b5161fbaea60b29bac64881680e7954631c157b2cb5a0a8e84d1dc1b9f415ec`.
The raw prove-job log response bytes for job `100450916193` have SHA-256
`eb79ede7214e1b3085d7f787cd91df8b23f9150f805c13d5e5675df934b70510`.
Archived whole-run log file `terminal.run.log` is a separate, larger byte
sequence with SHA-256
`eb930fec28427928a328a89f61874920ebc18694484b0ffd70051d660ca703e8`.
These four hashes label four distinct retained or fetched byte representations
and are not interchangeable.

The evidence binds exact App `4783991`, bot `323289432`, selected installation
`158077029` and repository, the admitted push output SHA-256
`93f5eaa8169aa38b358f7eb3e80b30f80f0cb3fd4eb3d37fe6ac60673b02f9fd`,
the stale-lease rejection output SHA-256
`ca646017da1c8e57ef915b6b76e4e808a41a1e0492454ca0b0c3176f7a504b8a`,
unchanged control fingerprints, and the activation workflow's
cleanup-qualified revocation receipt
`{converged:true, observationCount:2, propagationObserved:false,
stableDenials:2}`. Lifecycle ruleset `21832074` remained no-bypass. Update
ruleset `21887484` admitted only App `4783991` as an `Integration` with
`bypass_mode=always`. Production-only freeze ruleset `22149969` remained
no-bypass. The production helper remains hard-bound to `website-production`
and was not reused for the canary.

This checked cleanup removes the single-use workflow and helper after retaining
their run, job log, App and installation readbacks, environment admission,
administrator ruleset projections, ordinary-denial and App-bypass Rule Suites,
canonical evidence, and SHA-256 digests. After this cleanup is merged and its
merged-source CI is green, delete the six temporary lifecycle, update, and freeze
ruleset fingerprint variables by exact name:
`WRENCH_RELEASE_LIFECYCLE_RULESET_ID`,
`WRENCH_RELEASE_LIFECYCLE_RULESET_UPDATED_AT`,
`WRENCH_RELEASE_UPDATE_RULESET_ID`,
`WRENCH_RELEASE_UPDATE_RULESET_UPDATED_AT`,
`WRENCH_RELEASE_PRODUCTION_FREEZE_RULESET_ID`, and
`WRENCH_RELEASE_PRODUCTION_FREEZE_RULESET_UPDATED_AT`. Read the environment back and
require exactly the four reviewed App ID, client ID, slug, and installation ID
variables plus the single private key secret, with its main-only branch policy,
reviewer, `prevent_self_review` setting, and disabled admin bypass unchanged.
Retain both permanent rulesets, the canary at `C`, and the production-only
freeze. Remove the freeze later only by its captured numeric ID after a fresh
release-owner audit; uncertainty leaves production safely frozen.

The minted token must carry a bounded one-hour expiry and fit the streamed
response parser. The helper masks it and passes it only through a private
`GIT_ASKPASS` environment. Because the writer checks out only exact reviewed
workflow source `W`, it first fetches only the verified tag through the fixed HTTPS
repository URL, peels that fetched object locally, and requires the result to
equal the independently verified release SHA. It does not check out or execute
tagged code. The same ephemeral credential boundary then runs one fixed push
with the explicit compare-and-swap lease
`--force-with-lease=refs/heads/website-production:<expected-old>`. The push has
one exact source-to-destination refspec, no followed tags, no hooks, no persisted
Git configuration or checkout credential, no interactive prompt, and a
60-second cap on each Git process.

After the operation, the shared helper sends exactly one nonredirecting
`DELETE /installation/token` request and requires an HTTP 204 with absent or
canonical-zero `Content-Length` and zero body bytes. Its GitHub `Date` header,
and the `Date` header on every accepted HTTP 200 or 401 observation, must be
canonical and strictly precede the minted token's exact `expires_at`.
The monotonic completion of that response anchors a separate 30-second
half-open request-start window `[start, deadline)`. A response that completes
exactly at the deadline remains eligible; a later completion fails. The helper
may make at most ten reads of the token's exact `/installation/repositories`
endpoint at absolute offsets 0, 250,
500, 1,000, 2,000, 4,000, 8,000, 16,000, 24,000, and 29,000 milliseconds. Each
read is admitted and timed from one authoritative request-begin clock sample,
then capped at the lesser of ten seconds and that sample's remaining window.
Request,
body, and sleep latency are charged to the same window. A missed absolute slot
is skipped instead of triggering a burst or sliding later observations. An HTTP
200 before denial must still name the exact singleton selected Wrench
repository. Acceptance requires HTTP 401 on two distinct scheduled reads; a
later 200 after a 401, only one 401, any other status, a redirect, malformed or
oversized authority data, transport or sleep failure, clock drift, or deadline
inconsistency is indeterminate and fails closed. If every observation that can
start before the deadline remains authorized, the result is a distinct
nonconvergence failure even when charged latency reduces the number of reads.
The sanitized receipt sets `propagationObserved=false` only when the first two
observations are the required 401 pair and no authorized 200 was observed. It
sets `propagationObserved=true` only when at least one exact authorized 200
precedes the final two stable 401 observations. An advanced
`wrench-provider-promotion-v2` receipt must retain that exact bounded object as
`releaseAppRevocation`; the no-write `already-exact` path must instead bind the
field to `null` and never mint a token.
This operational ceiling is a
Wrench fail-closed policy, not a GitHub revocation-propagation SLA. No action is
retried, and operation and revocation failures are both retained when they
coincide. The exact production-ref post-read begins only after convergence.
Every read-only `gh api` child receives `GH_TOKEN` but has every
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
and `C<=W<=M`, and pin one deployment. Each workflow-source check reads
protected main twice, accepts only identical or strict linear-forward movement,
and rejects rollback or divergence. A protected descendant advance after the
final read remains safe; neither path claims an atomic cross-system snapshot.
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
control flow can make at most 209 REST calls in the provider outcome job. The
worst missing-Release path uses 16 calls, including all five bounded release
pages plus the empty sentinel page. The immutable Release and downstream
promotion workflows together use at most 330 REST calls, leaving 670 calls
under the repository `GITHUB_TOKEN` limit of 1,000 REST requests per hour. The
promotion helper itself uses at most 21 read-only REST calls; its leased Git
push and at most fourteen App REST requests do not consume that `GITHUB_TOKEN`
budget. Those App requests are the three setup and mint calls, one DELETE, and
at most ten convergence probes. Git authentication is outside that REST bound. Five
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
`main` first. Then dispatch **Promote website production** from current `main`
with the immutable Latest stable tag. Recovery never reruns or changes the tag
Release. It resolves the peeled tag as verified release commit `C`, keeps that
coordinate distinct from reviewed workflow source `W`, and proves `C<=W<=M`
against protected current main. An
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
Release, and the separate main-origin workflow advances `website-production`
only after it revalidates that release authority. The production verifier then
independently rechecks the promoted commit, tag, registry coordinate, and
immutable Latest Release.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/), [staged
publishing](https://docs.npmjs.com/staged-publishing/), and [dual-use package
publishing](https://docs.npmjs.com/policies/dual-use/).
