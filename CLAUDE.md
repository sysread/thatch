# thatch

OpenCode plugin: persistent agent memory via local embeddings + SQLite.
Bun-only (bun:sqlite, Bun.$) — it does not run under Node.

## Commands

```bash
bun install            # deps
bun test               # full suite (<1s, no network)
bun run bin/thatch     # CLI: stores|list|show|search|forget
bunx tsc --noEmit      # typecheck (tests are excluded from tsconfig)
```

mise.toml exists for local convenience only (bun pin, task aliases). mise is
NOT installed in Claude Code cloud sandboxes — use the bun commands above.
Never run `bin/release` / `mise run release`: releases are the maintainer's
prerogative (tag push → GitHub Actions → npm via OIDC trusted publishing).

## Orientation

- `docs/dev/README.md` — architecture, module map, plugin hooks, data flow,
  design invariants. Read this before changing src/.
- `docs/plans/` — decision records; 002 explains why extraction/dedup are
  agent-driven and the opencode hook-wiring gotchas.
- `docs/qa/README.md` — test conventions and coverage map.

## Invariants (see docs/plans/002)

- The plugin never writes memories autonomously; agents do, via tools.
- Embedding spaces are discriminated by vector dimension, not model tag.
- Skills are plugin-owned, installed to $XDG_CONFIG_HOME/opencode/skills,
  never into the worktree.
- Hook failures are logged with a [thatch] prefix, never swallowed.
