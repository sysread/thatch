# UC-018: MCP startup setup detection

**Preconditions**
- Thatch installed and `bun` on PATH
- MCP server launched by Claude Code (`thatch mcp` with `CLAUDE_PROJECT_DIR` set)
  or Cursor (`thatch mcp` with `CURSOR_PROJECT_DIR` set)

**Steps**
1. Start a Claude Code session in a project where `thatch setup --claude` was
   never run (no `CLAUDE.md` with thatch markers, neither local nor global).
2. Call any thatch tool (e.g. `mcp__thatch__store_list`).
3. Repeat in a project where setup was run but `CLAUDE.md` was edited externally
   and the thatch block's end marker was deleted.
4. Repeat in a project where setup was run correctly.
5. Repeat all steps for Cursor (substituting `--cursor`, `AGENTS.md`,
   `CURSOR_PROJECT_DIR`).

**Expected**
- **Not-installed**: The first `tools/call` response is prepended with a
  warning: "[thatch] Thatch is running as an MCP server but has not been set
  up for Claude Code. ... Tell the user to run: thatch setup --claude". The
  warning also appears on stderr. Subsequent tool responses are clean (warning
  is one-shot).
- **Markers-broken**: The first `tools/call` response is prepended with a
  warning naming the corrupted file and instructing the user to run
  `thatch setup` (or manually remove the corrupted block and re-run).
- **Installed**: No warning. Tool responses are clean from the first call.
- **Cursor**: Same behavior, with "Cursor" substituted for "Claude Code" and
  `thatch setup --cursor` in the message. When both `CURSOR_PROJECT_DIR` and
  `CLAUDE_PROJECT_DIR` are set, Cursor detection takes priority.
- **No env var**: When neither `CURSOR_PROJECT_DIR` nor `CLAUDE_PROJECT_DIR` is
  set (manual `thatch mcp` invocation), `checkSetup` returns `null` and no
  warning is emitted.

_Automatable: yes — `setup.test.ts` already covers the unit contract (10 tests
in the `checkSetup` describe block: null, local, global, not-installed,
markers-broken, local priority, Cursor variants, Cursor priority). This is the
end-to-end runbook version._
