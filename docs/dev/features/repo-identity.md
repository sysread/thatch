# Repo identity

## What it does

Every thatch surface keys memory on a repo identity string (the "project
store"). Identity is resolved once per process at init by `detectRepo()`,
then threaded as the default store to tools, prompts, nudges, and chat
registration. This feature covers how identity is resolved, and how it
survives the deletion of the directory identity was resolved from -- the
worktree-merged-and-cleaned-up case.

The same resolution also decides where git subprocesses spawn: watchers
and branch listing run `git`/`bash` with `cwd` set to the project
directory, which stops working when that directory is deleted.

## How it works

### Resolution chain (`detectRepo`, src/git.ts)

1. Parse `owner/repo` from `git remote get-url origin`.
2. Fall back to the basename of the main checkout, resolved from
   `git rev-parse --path-format=absolute --git-common-dir`. The absolute
   flag makes the output uniform: a linked worktree reports the MAIN
   checkout's `.git`, a root checkout reports its own -- so the basename
   is the repo, never the worktree/branch directory.
3. Fall back to the directory basename (existing, non-git directories).
4. When the directory no longer exists, steps 1-2 cannot run (spawning
   with a deleted cwd rejects), so the `repo_paths` cache is consulted;
   a miss returns `"unknown"` -- never the basename, which for a worktree
   is the branch name and would mint a plausible-but-wrong store.

Callers treat `"unknown"` as unknown identity: the tool layer maps it to
the global store, and the CLI's `defaultStore()` applies the same mapping.

### The `repo_paths` cache (src/db.ts)

One row per worktree directory (realpath-canonicalized key): the main
checkout path and the repo slug recorded while the directory was alive.
Writes happen only on successful resolution via steps 1-2, never from the
basename fallback. Access is injected (`RepoPathCache` interface, adapted
by `repoPathCache(db)` in src/db.ts) so src/git.ts stays database-free.

Path-form handling matters on macOS, where `/var/...` and
`/private/var/...` are the same directory in different forms. Writes
canonicalize with `realpathSync` (the directory exists at write time);
reads try the raw path first, then the parent-realpath form, because a
deleted directory cannot itself be realpathed.

### Recovery and eviction rules

A cache hit is validated against the CURRENT state of its main checkout
before it is trusted:

| Observation | Verdict |
|-------------|---------|
| Main checkout missing (`statSync` throws) | Keep row, degrade to `"unknown"` -- a re-clone may be in progress |
| Spawn failure against main checkout | Keep row (transient) |
| Main checkout live but `git rev-parse` exits nonzero | Evict (definitive: no longer a repo) |
| `git remote get-url origin` parses to a different slug | Evict (definitive: path recycled or re-cloned from elsewhere) |
| Remote matches (or, with no remote, the slug still equals the main checkout's basename) | Valid -- identity recovered |

Eviction is definitive-only. A wrongly evicted row permanently downgrades
identity to `"unknown"`, which is worse than serving a stale row for one
more call.

### The spawn-cwd fallback (`resolveSpawnCwd`, src/git.ts)

`resolveSpawnCwd(dir, cache)` returns the directory when it exists, else
the validated main checkout from the cache, else null. Worktrees share
`refs/heads` and config with the main checkout -- only HEAD and the index
are per-worktree -- so git reads are equivalent from either. Consumers:

- `listBranches` falls back to the main checkout instead of returning
  `[]` (which made hygiene skip the orphaned-branch check).
- The opencode plugin wraps its watcher `commandRunner` with
  `withCwdFallback` (src/watchers.ts): the spawn cwd is resolved per poll,
  so a watcher whose worktree dies mid-watch recovers instead of spinning
  ENOENT errors until the TTL. The fallback is logged once per dead
  directory.
- `watch_command_create` accepts a `cd` override, validated at
  registration by the baseline run (a nonexistent path is rejected).

## Key invariants

- Identity resolution returns a correct slug or `"unknown"` -- never a
  plausible wrong name. A wrong-but-plausible name defeats the
  degrade-to-global safety net.
- The cache is only written from live resolutions, and only via the
  remote or common-dir probes.
- Eviction is definitive-only.
- The cache key is the realpath at write time; reads try raw and
  parent-realpath forms.

## Interactions with other features

- Database ([database.md](database.md)): the `repo_paths` table.
- Watchers ([watchers.md](watchers.md)): the per-poll cwd fallback wraps
  the watcher command runner; `watch_command_create` takes `cd`.
- Hygiene ([hygiene.md](hygiene.md)): `listBranches` falls back to the
  cached main checkout, so the orphaned-branch check survives worktree
  deletion.

## Source files

- `src/git.ts` -- resolution chain, cache validation, spawn-cwd fallback
- `src/db.ts` -- `repo_paths` table, accessors, `repoPathCache` adapter
- `src/runtime.ts` -- plugin init order (DB before detection), identity from
  the session directory, watcher runner wrapper
- `src/mcp.ts` -- MCP server init order
- `bin/thatch` -- CLI `defaultStore()` and hook-line identity resolution
