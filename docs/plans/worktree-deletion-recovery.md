# Plan: survive worktree deletion (repo path cache + cwd fallback)

Status: CONSENSUS (round 5, five fresh-context review rounds). Ready to
implement.

## Problem

opencode sessions run inside git worktrees (`~/dev/wt-<repo>/<branch>`).
When the worktree is deleted after its branch merges:

- **Store identity corruption.** `detectRepo` (src/git.ts:78) runs
  `git remote get-url origin` and `git rev-parse --git-common-dir` with
  `cwd` set to the session directory. When that directory is deleted, Bun
  rejects the spawn (ENOENT at chdir; verified empirically), both probes
  throw, and the final fallback (src/git.ts:105) returns the directory
  basename -- for a wt worktree, the branch name. That plausible-but-wrong
  name becomes the project store, and memories silently target a store no
  future session reads. The `"unknown"` sentinel (which degrades to the
  global store, src/tool-defs.ts:38) is not reachable on this path: a real
  deleted-worktree path is never empty, so the `|| "unknown"` at
  src/git.ts:105 never fires for it. (A degenerate input like `/` does
  return `"unknown"` today; that case is unaffected by this plan.)
- **Watcher cwd pinning.** `watch_command_create` captures the project dir
  at registration (src/tool-defs.ts:1460-1464) and the poll runner spawns
  `bash -c` there every cycle (src/watchers.ts:440). A deleted cwd makes
  every poll reject; the watcher spins errors forever.

Only four surfaces pin a cwd for spawning: src/git.ts:82, src/git.ts:92,
src/git.ts:119 (`listBranches`), and src/watchers.ts:440. The `gh api`
spawn (src/watchers.ts:318) uses absolute REST paths and no cwd -- it is
unaffected. Watchers are in-memory only by documented contract
(src/watchers.ts:19-28).

**Host behavior when the directory is gone (verified in the opencode
monorepo, packages/opencode/src/project + packages/core/src/project.ts and
packages/core/src/fs-util.ts):** opencode does not refuse to resume. It
walks up from the missing directory, finds no `.git`, and boots the global
project with `worktree = "/"` while still passing the session's original
(deleted) path as `directory` (packages/opencode/src/plugin/index.ts:153-157).
Separately, Bun cannot launch at all from a deleted cwd, so per-prompt hook
processes in that case never run -- they are not a recovery surface. The
recovery surfaces are: resumed opencode sessions (via `ctx.directory`) and
any host that spawns from a healthy cwd while passing the deleted path via
`CLAUDE_PROJECT_DIR` / `CURSOR_PROJECT_DIR` (env has priority at
src/git.ts:79).

## Design

### 1. `repo_paths` cache table

```sql
CREATE TABLE IF NOT EXISTS repo_paths (
  worktree_path TEXT PRIMARY KEY,
  main_path     TEXT NOT NULL,
  repo_slug     TEXT NOT NULL,
  resolved_at   INTEGER NOT NULL
);
```

- Follows the existing `CREATE TABLE IF NOT EXISTS` + ad-hoc migration
  pattern (src/db.ts:89+). Writes use `ON CONFLICT DO UPDATE` upsert
  (existing idiom, src/db.ts:544).
- **Key normalization.** The key is `realpathSync(dir)` at write time (the
  directory exists then). On macOS, `/var/...` and `/private/var/...` are
  the same directory with different path forms. Reads try the raw path
  first, then `realpathSync(dirname(dir)) + basename(dir)` for the
  deleted-directory case.
- **Cache access is injected, not imported.** src/git.ts stays DB-free.
  `detectRepo` and the new helpers take an optional cache accessor
  (`{ get(dir): Row | null; put(row): void }`); callers with a DB in scope
  pass an adapter over the `repo_paths` table. Where the DB does not exist
  yet, creation is reordered ahead of detection: src/index.ts:168 vs :171
  and src/mcp.ts:124 vs :131. Callers without a cache behave as today plus
  the `"unknown"`-on-deleted-dir fix.
- **Write trigger.** Only on successful resolution via the remote or
  common-dir probes -- never from the basename fallback (caching that
  output would store the exact garbage the cache exists to fix). Writes
  are read-then-maybe-write: skip when the row already matches.
  Frequency note: in the opencode plugin, detection runs once at init
  (src/index.ts:168); the flush-tools hook runs per prompt but only on the
  Claude Code / Cursor hosts (bin/thatch:973-974, :1006).

### 2. main_path derivation

New helper in src/git.ts, run unconditionally at cache-write time:

```ts
// resolveMainCheckout(dir): Promise<string | null>
// Runs `git rev-parse --path-format=absolute --git-common-dir` with cwd=dir.
// Returns null when git fails or is not a repo.
```

`--path-format=absolute` makes the output absolute in every live case
(verified empirically): a linked worktree reports the main checkout's
absolute `.git`, a root checkout reports its own absolute `.git`. So
`main_path = dirname(output)` uniformly. A bare repo reports
`/path/repo.git`, which fails the `endsWith("/.git")` check; the resulting
nonsense `main_path` fails validation and is handled by the eviction rules
below -- documented at the write site, not special-cased.

detectRepo's public signature stays `Promise<string>`; a sibling helper
`resolveMainPath(dir, cache?): Promise<string | null>` reads and validates
a cache row for consumers that need the path.

### 3. detectRepo recovery for a deleted directory

When both git probes throw:

1. `statSync(dir)` fails (directory gone): consult the cache.
   - Cache hit, and the cached `main_path` validates (below): return the
     cached `repo_slug`.
   - Cache hit with failed validation: return `"unknown"`.
   - Cache miss: return `"unknown"`, never the basename. This preserves
     the documented contract -- unidentifiable contexts must be `"unknown"`,
     never a plausible wrong identity (src/tool-defs.ts:33-41).
2. Directory exists but is not a git repo: basename fallback unchanged
   (its legitimate use).

**Validation and eviction rules (definitive-invalidation only).**
Validation of a cache hit runs, with cwd = cached `main_path`:

1. `statSync(main_path)` -- if it throws (main checkout also gone), the
   row is KEPT (the checkout may be re-cloned) and this call degrades to
   `"unknown"`. Transient spawn errors also keep the row. Never evict on
   an error that might be transient -- a wrongly evicted row permanently
   downgrades identity, which is worse than the status quo it replaces.
2. `git rev-parse --git-common-dir` -- a throw here (not a nonzero exit
   from a live dir) is likewise treated as transient; row kept.
3. Identity check: `git remote get-url origin` in `main_path` must parse
   to the cached `repo_slug`. A nonzero exit or unparseable remote on a
   live directory is DEFINITIVE (the path exists but is not the recorded
   repo -- re-cloned, replaced, or no longer a repo): evict the row,
   return `"unknown"`. A thrown spawn error is transient and keeps the
   row.

**Plugin identity recovery on resume.** The opencode plugin detects
identity from `ctx.directory` (falling back to `ctx.worktree` when
absent) instead of `ctx.worktree` alone. This touches the destructure and
type at src/index.ts:165-168, not just the call. For a resumed session in
a deleted worktree, the framework hands the plugin the original deleted
path as `directory` and `"/"` as `worktree`; keying on `directory` lets
the cache return the true store identity. Tool execution dirs
(`ctx.projectDir`) continue to use the framework's worktree value.

**CLI consistency.** `bin/thatch` `defaultStore()` (bin/thatch:76-82) lacks
the `unknown -> global` mapping that the tool layer applies. The mapping is
added there so all surfaces agree. `detectRepo` consumers that benefit from
the `"unknown"` change are enumerated for tests: `chatHookLine`
(bin/thatch:100), `flush-predictions` (bin/thatch:1217), `reminder`
(bin/thatch:729), `hygiene` (bin/thatch:769).

### 4. Shared cwd fallback at the pinned spawn sites

A helper in src/git.ts:

```ts
// resolveSpawnCwd(dir, cache?): Promise<string | null>
// dir if it exists; else the validated cached main_path; else null.
```

- `listBranches` (src/git.ts:119) uses it directly: valid pinned cwd >
  cached main checkout > current error behavior. `runWatchedCommand` gets
  the same fallback via the plugin's runner wrapper (section 5) rather
  than calling the helper itself. Branch visibility is unaffected by the
  fallback (worktrees share `refs/heads` and config; only HEAD and the
  index are per-worktree). For `listBranches` this upgrades a fail-safe
  (`[]` -> hygiene skips the orphan check) to a correct answer.
- Inside `detectRepo` itself, the two probes use the same fallback so a
  deleted worktree with a valid cache recovers without special casing.
- **Surfacing.** The watcher poll loop logs the fallback once per watcher
  (a flag, not every cycle -- poll errors already log every cycle at
  src/watchers.ts:1071-1073 and spam is the existing failure mode). There
  is no LLM-facing surface at poll time; the notification text is not
  modified.

### 5. Watcher fallback resolved per poll via the injected runner

The plugin wires a `commandRunner` into the registry
(src/watchers.ts:234, option declared at :251, currently passed only by
tests; the plugin will start passing one at src/index.ts:247-279, where db
is in scope). The plugin's runner is a wrapper that resolves the cwd per
poll:

```ts
// plugin scope, where db is available
const runner = async (command, cwd, timeoutMs) => {
  const resolved = await resolveSpawnCwd(cwd, cacheAdapter);
  if (resolved && resolved !== cwd && !loggedFallback.has(cwd)) {
    console.error(`worktree deleted; watcher falling back to ${resolved}`);
    loggedFallback.add(cwd); // key on the dead cwd: same once-per-watcher granularity
  }
  return runWatchedCommand(command, resolved ?? cwd, timeoutMs);
};
```

- Resolution order: explicit `cd` > watcher cwd (if it still exists) >
  cached main checkout > fail. This is the only mechanism that actually
  recovers a watcher whose worktree dies mid-watch -- a fallback captured
  at registration would be the same live path as the cwd and therefore
  useless, which the previous plan revision got wrong.
- The registry keeps its no-DB contract with no new options: the cache
  adapter is closed over in plugin scope, outside the registry.
- New optional param `cd` (z.string()) on `watch_command_create`,
  validated at registration: the baseline run (src/watchers.ts:971-985)
  spawns with it, so a dead path fails registration with the existing
  friendly error (src/watchers.ts:441-443).
- `cd` is not persisted to SQLite; watchers are in-memory by contract
  (src/watchers.ts:19-28). A watcher whose fallback path itself later
  dies fails its polls -- acceptable under the same lifetime contract.
- `watch_create` and `watch_branch_create` get no `cd`: they run only gh
  REST calls with absolute paths (src/watchers.ts:595-607); their only
  directory-sensitive input is the init-time `ctx.defaultStore`, which
  step 3 fixes at the source.

## Tests

- `tests/git-integration.test.ts` (real tmp repos, existing scaffolding):
  `git worktree add` + `rm -rf` the worktree; assert cache-backed slug and
  main-path recovery; cache miss yields `"unknown"`, not the branch name;
  existing non-git dir still yields the basename; realpath canonicalization
  via a symlinked temp path; recycled main_path with a different origin
  evicts (definitive) and yields `"unknown"`; missing main_path (stat
  throws) keeps the row and yields `"unknown"`.
- `tests/watchers.test.ts` (injected `commandRunner` harness, lines 781+):
  resolution ordering (cd > cwd > captured fallback), fallback logged once,
  dead cd rejected at registration, watcher registered against a healthy
  dir whose fallback was captured before deletion keeps polling.
- `tests/tool-defs.test.ts`: `cd` schema presence and validation; the
  existing unknown-to-global tests (lines 326, 477) cover the tool side.

## Accepted risks and deferred items

- Rows for dead worktrees accumulate until definitively invalidated;
  bounded by worktrees ever seen. Optional prune deferred.
- Poll-time fallback is not surfaced to the LLM mid-poll (console.error
  once per watcher). The eventual notification reports the condition
  result, same as today.
- A fallback watcher runs its command from the main checkout root, so
  commands using relative paths may observe different state -- potentially
  a false exit 0 instead of a failure. Strictly better than today's
  permanent error spin, but a real semantic difference worth knowing.
- Bare-repo `main_path` is nonsense until first validation evicts it;
  documented at the write site rather than special-cased.
- `mkdtemp`/git path-form divergence claim verified in direction (Bun
  normalizes cwd to the realpath form); the exact tmpdir form difference
  is covered defensively by the dual read-path anyway.
