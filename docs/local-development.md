# Local Wrench development

Use a stable lane for real work and a separate worktree lane for development.
This keeps local source edits, dependencies, builds, and private state from
changing underneath another chat or the installed `wrench` command.

## Stable and development lanes

Keep the control checkout on `main` and use it to create and retire worktrees.
Keep the normally installed `wrench` command and its normal state for trusted
day-to-day work, especially provider mutations. Do not globally link a changing
development checkout over that command.

Give every development chat a unique task name. Its worktree gets a
`codex/<task>` branch, its own frozen Bun install, and private state and media
roots. Chats that may edit source must not share a task worktree. They may run
in parallel when each uses its own task.

The helpers require Bun 1.3.14. Git worktrees cannot inherit uncommitted files,
so first commit the local-development setup and any source every new task needs.
The helper uses the control checkout's current `HEAD` by default; fetch and
advance that checkout only when you explicitly want a newer base:

```sh
git fetch --prune origin # optional: refresh the local base first
./scripts/local-dev/new-worktree codex-20260814-example
```

The helper does not fetch or merge implicitly. `WRENCH_WORKTREE_BASE` may select
another locally known commit or ref. By default it creates the worktree in a
sibling directory named `<control-checkout>-worktrees`. Set an absolute
`WRENCH_WORKTREE_ROOT` to put worktrees elsewhere:

```sh
WRENCH_WORKTREE_ROOT=/absolute/path/wrench-worktrees \
  ./scripts/local-dev/new-worktree codex-20260814-example
```

Task names contain only lowercase letters, digits, and internal hyphens and are
at most 48 characters. The helper refuses an existing target or branch and
runs `bun install --frozen-lockfile` only after Git creates the worktree. If the
install fails, it leaves the worktree in place for inspection or an explicit
cleanup.

## Run the current source

Invoke the task's source CLI through the control checkout's runner:

```sh
./scripts/local-dev/run-wrench codex-20260814-example doctor --json
```

The runner starts a new Bun process against that worktree's source on every
call and disables Bun's automatic package installation. A tiny tracked launcher
binds Bun to the worktree's configuration before restoring the caller's working
directory and loading `src/cli.ts`. No build or global relink is needed: a
completed edit is visible to the next invocation. An already-running invocation
keeps the code it loaded, so source edits do not hot-swap its process. Let
long-running commands finish before changing behavior they depend on. The
runner also disables caller `.env` loading and verifies the exact registered
`codex/<task>` worktree before executing it. Ambient `BUN_CONFIG_FILE`,
`BUN_OPTIONS`, and `NODE_OPTIONS` runtime hooks are discarded as part of that
boundary.

The runner briefly enters the Wrench worktree to bind Bun configuration; the
tracked launcher restores the caller directory before the CLI loads. Relative
CLI inputs and outputs therefore continue to resolve from the caller's
directory:

```sh
cd /absolute/path/to/a/caller-project
/absolute/path/to/wrench/scripts/local-dev/run-wrench \
  codex-20260814-example doctor --json
```

Each task uses these private roots by default:

```text
$HOME/.local/share/wrench-dev/<task>/state
$HOME/.local/share/wrench-dev/<task>/media
```

Move that development root with an absolute `WRENCH_DEV_HOME`. Use the same
overrides for every invocation of a task:

```sh
WRENCH_WORKTREE_ROOT=/absolute/path/wrench-worktrees \
WRENCH_DEV_HOME=/absolute/private/path/wrench-dev \
  /absolute/path/to/wrench/scripts/local-dev/run-wrench \
  codex-20260814-example doctor --json
```

Never point a development task at the stable Wrench state or media roots, and
never symlink state, media, auth, browser profiles, `node_modules`, or `dist`
between tasks.

### Mutation boundary

State isolation also isolates confirmation, dispatch, and at-most-once
evidence. Separate task ledgers cannot coordinate with each other or with the
stable installation. Do not submit the same real R2 or R3 provider mutation
from multiple lanes. Route real mutations through one stable Wrench
installation and its normal state. Use development roots for reads, local
fixtures, and deliberately isolated test accounts or targets.

## Refresh the Agent Skill

The repository's `skills/wrench/` directory is the skill source; an agent does
not automatically read edits from that directory. Keep the normally installed
skill pinned to the same stable release as plain `wrench`; CLI worktree
iteration does not require replacing it.

Skill replacement is a serialized maintenance boundary, not hot reload. When
no active task may still discover or use the installed Wrench skill, validate
the revision, stage a complete copy on the same filesystem but outside Codex's
skill-discovery directory, and publish that complete tree with rollback. Then
refresh Codex and start a new task. Do not run `rsync --delete` directly into
the live installed directory, and do not switch one user-level skill between
parallel worktrees.

For example, after quiescing Wrench tasks:

```sh
(
  set -eu
  CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
  CODEX_SKILLS_HOME="$CODEX_ROOT/skills"
  SKILL_SWAP_ROOT="$CODEX_ROOT/local-skill-snapshots/wrench"
  mkdir -p "$SKILL_SWAP_ROOT"
  SKILL_SWAP="$(mktemp -d "$SKILL_SWAP_ROOT/swap.XXXXXX")"
  SKILL_STAGE="$SKILL_SWAP/stage"
  SKILL_BACKUP="$SKILL_SWAP/previous"
  cp -R ./skills/wrench "$SKILL_STAGE"
  mv "$CODEX_SKILLS_HOME/wrench" "$SKILL_BACKUP"
  if ! mv "$SKILL_STAGE" "$CODEX_SKILLS_HOME/wrench"; then
    mv "$SKILL_BACKUP" "$CODEX_SKILLS_HOME/wrench"
    exit 1
  fi
)
```

The preserved `local-skill-snapshots/wrench/swap.*/previous` directory is an
explicit rollback candidate outside live skill discovery; inspect and retire it
manually only after the new skill is accepted. The quiesced replacement has a
brief gap between moving the prior directory aside and publishing the complete
staged tree, and the snippet restores the prior directory if publication fails.
Adjust the destination if the agent host uses a different skills directory.
Existing tasks may have already loaded instructions, so the safe guarantee is
only that new tasks started after the refresh see the new complete snapshot.
When testing local code, tell the new task the absolute `run-wrench` command and
task name so it does not fall back to the stable `wrench` executable.

## Verify and retire a task

Run the complete gate inside the task worktree before handing off a change:

```sh
cd /absolute/path/wrench-worktrees/codex-20260814-example
bun run check
```

Before cleanup, make sure no chat or shell is using the worktree and commit or
otherwise preserve wanted changes. Then remove the exact worktree through Git,
delete its branch only after Git accepts the removal, and prune stale metadata:

```sh
git -C /absolute/path/to/wrench worktree remove \
  /absolute/path/wrench-worktrees/codex-20260814-example
git -C /absolute/path/to/wrench branch -d codex/codex-20260814-example
git -C /absolute/path/to/wrench worktree prune
```

Review the exact `<WRENCH_DEV_HOME>/<task>` directory separately before
deleting it. It can contain private auth, provider, plugin, and media state. Do
not use a broad glob or remove the worktree directory directly.
