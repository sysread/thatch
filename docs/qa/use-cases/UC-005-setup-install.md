# UC-005: Setup install (Claude Code and Cursor)

**Preconditions**
- Thatch installed and `bun` on PATH
- Target config dirs writable (`$XDG_CONFIG_HOME`, `$CLAUDE_CONFIG_DIR`, `~/.cursor`)

**Steps**
1. From a project root: `thatch setup --claude`
2. From the same project root: `thatch setup --cursor`
3. Repeat both commands (re-run idempotence and drift recovery)
4. Add a non-thatch hook to `.claude/settings.json` and `.cursor/hooks.json`,
   then re-run setup
5. From elsewhere: `thatch setup --cursor --global`, then `thatch setup --claude --global`

**Expected**
- `--claude` project-local writes `.mcp.json` (`mcpServers.thatch`, stdio + `["mcp"]`),
  appends a thatch block to `CLAUDE.md` bracketed by start/end markers (replaced, not
  duplicated, on re-run), writes `.claude/settings.json` hooks (`SessionStart` -> `thatch reminder`,
  `PostToolBatch` -> `thatch buffer-batch`, `UserPromptSubmit` -> `thatch flush-tools`), and installs
  **12 shared skills** (no code-review coordinator) to `$CLAUDE_CONFIG_DIR/skills/` — user-scoped
  even in project-local mode.
- `--cursor` project-local writes `.cursor/mcp.json`, appends to `AGENTS.md`, writes
  `.cursor/hooks.json` in the **flat format** (`{version:1, hooks:{...}}`): `sessionStart` ->
  `thatch reminder --json`, `postToolUse` -> `thatch buffer-tool`, `beforeSubmitPrompt` ->
  `thatch flush-tools --json`; and installs 12 shared skills to `~/.cursor/skills/`.
- Re-run is idempotent: instructions are not duplicated, thatch hooks are replaced (not appended),
  and non-thatch hooks are preserved. A legacy `thatch echo` hook is replaced with `flush-tools`.
- `--global` (Claude) writes `~/.claude/CLAUDE.md` + `~/.claude/settings.json` but **no project
  `.mcp.json`** — it prints a `claude mcp add --scope user` command instead. `--global` (Cursor)
  writes `~/.cursor/mcp.json`, `~/.cursor/AGENTS.md`, `~/.cursor/hooks.json`, `~/.cursor/skills/`.

_Automatable: yes — file presence and shape assertions on `.mcp.json`, `hooks.json`,
`CLAUDE.md`/`AGENTS.md` blocks, and the skills directory. `setup.test.ts` already covers the
unit contract; this is the end-to-end runbook version._
