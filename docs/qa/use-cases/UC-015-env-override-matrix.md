# UC-015: Environment variable override matrix

**Preconditions**
- Writable temp directories; `bun` on PATH

**Steps**
Set each variable and confirm the effect at the documented resolution point.

| Variable | Set to | Expected effect |
|----------|--------|------------------|
| `THATCH_DB_PATH` | a temp file path | the SQLite DB is created there (CLI + plugin + MCP) |
| `XDG_CONFIG_HOME` | a temp dir | the default DB (`$XDG_CONFIG_HOME/thatch/thatch.db`) and opencode skill dir move there; the real `~/.config` is untouched |
| `CLAUDE_CONFIG_DIR` | a temp dir | `thatch setup --claude --global` writes CLAUDE.md, settings.json, and skills under that dir; project-local keeps project paths but skills under the custom dir |
| `THATCH_QUEUE_DIR` | a temp dir | extraction-queue JSONL files land there instead of `$XDG_CACHE_HOME/thatch/queue` |
| `THATCH_RECALL_THRESHOLD` | a low value (e.g. `0.2`) | the prompt-aware recall nudge fires for weaker matches (a prompt that matched nothing at 0.55 now surfaces results) |
| `THATCH_MODEL` | a different model name | new memories carry the new model tag and vector dimension; old memories become invisible to search (see UC-012) |

**Expected**
- Each override takes effect at the point the docs describe (see
  `docs/dev/setup-and-hooks.md` and the dev README config section). None require
  a restart beyond the process that reads them.
- `THATCH_DB_PATH` and `XDG_CONFIG_HOME` change the **same** sideband socket
  path (it is a hash of the resolved DB path) — so a hook process and the MCP
  server must both resolve the same DB path or they miss each other.

_Automatable: yes — env resolution is deterministic and side-effect-free;
`setup.test.ts` already covers `CLAUDE_CONFIG_DIR`; the rest follow the same
shape._
