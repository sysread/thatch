---
name: thatch-plugin-qa
description: Perform QA of the thatch Claude Code plugin regime (the in-process mod + bundled MCP server) from INSIDE a Claude Code session - verify the install artifacts, walk the per-step QA-pin checklists, and report verdicts. Audience: QA runners (Jeff, joe, release checkers) running a Claude Code CLI session with the thatch plugin loaded. Not for opencode sessions and not for the thatch repo's own unit tests.
---

# Thatch plugin QA (Claude Code side)

You are QA-ing the thatch Claude Code plugin regime from the plugin's host
side. You run inside a Claude Code session with the plugin loaded (via
`--plugin-dir` or an installed plugin), and your job is to turn the QA pins
into verdicts.

**Prerequisite**: the `claude` CLI is installed and logged in on this
machine. This leg never runs in CI or docker - it uses YOUR login.

## The invariant (binding on every check)

**Assert only from surfaces the plugin writes: the thatch db, the
extraction queue dir, the debug log, and files under the plugin tree.
Never treat the model's prose as a verdict.** A session saying "it works"
is not evidence; a stamped liveness file is. Future QA use-case authors
inherit this rule - it is what makes a check reproducible.

## Orientation: what to inspect first

Run these once per QA session and keep the outputs at hand:

1. `echo $CLAUDE_CONFIG_DIR` (or default `~/.claude`) - the plugin lives at
   `<configDir>/thatch-plugin/` (global) or `<repo>/.claude/thatch-plugin/`
   (local). Confirm `.claude-plugin/plugin.json`, `hooks/hooks.json`
   (`modules: ["./register.js"]`), `hooks/register.js`, `hooks/mod.js`,
   `hooks/instructions.js` all exist. **Verify the manifest's
   `mcpServers.thatch.command` points at the checkout you are testing** -
   a path into a different tree (a global install) is the mixed-source
   bug; setup refuses it, and the manifest pin confirms it.
2. `claude plugin list` - the plugin's Version, Scope, Status lines.
3. The db: `$THATCH_DB_PATH` or `~/.config/thatch/thatch.db`. Most verdicts
   are rows in it (chat_sessions, runtime_state, chat_messages).
4. The extraction queue: `$THATCH_QUEUE_DIR` or the tmp cache dir derived
   from the db path. Queue files are JSONL, one interaction per line.
5. The FAILURE surfaces: `<pluginRoot>/mod-failures.log` (the mod's
   fail-open crossings - the last 20 with reasons) and the SERVER's stderr
   (visible in the session's debug output with `claude --debug`, or the
   tier-failure `[thatch]` lines on the server side). There is no
   THATCH_DEBUG debug log on the plugin path.

## Step A pins: stage, identity, liveness

- **Stage delivery crossing** (the core pin): send a user prompt. The mod's
  `prompt.submit` must call the bundled server's `plugin_stage` tool.
  PASS: the mod liveness stamp file (beside the db or in the tmp cache dir
  `thatch-<sha256(dbPath)[:16]>`) has a timestamp from this run. FAIL
  fallback: the mod's hooks are silenced (disableAllHooks / managed
  allowManagedModsOnly) - check `/plugin` shows the plugin enabled, and
  `mod-failures.log` carries the stage-failure line (the fail-open logs
  the reason; the file's ABSENCE with a processed prompt means the hooks
  never ran at all).
- **Instructions delivery**: instructions ride the CLAUDE.md static block
  (the plugin-spelled tool list - `mcp__plugin_thatch_thatch__*`), ensured
  by setup AND by the bundled server at startup. There is NO
  `prompt.compose` hook (the guard passes over it). PASS: the project's
  CLAUDE.md holds the `<!-- thatch:begin -->` block with the
  `mcp__plugin_thatch_thatch__` spellings; the model can call the tools it
  names.
- **Identity anchor**: after one prompt, the db's chat_sessions has an mcp
  row (host_kind `mcp`, a pool-minted name). FAIL fallback: the stage's
  ensure did not run - check the debug log for the stage call.
- **Disabled-mod detector**: with hooks disabled (`/plugin` -> disable,
  then re-enable WITHOUT reloading), the next tool response after 30 idle
  minutes prepends the may-not-be-delivering warning, exactly once.

## Step B pins: alerts, wrap-ups

- **Alert mapping**: a failed round (force a provider error or abort) -
  PASS: `mod-failures.log`/the server stderr show the lifecycle's error
  forward and the notify dispatcher's compose line. An abort (ESC) must
  NEVER notify.
- **Guard caveat**: where the built-in guard loads (managed settings or a
  Team/Enterprise login), the mod's `classic.*` hooks do not run - pause
  (PermissionRequest) and provider-error (StopFailure) alerts are DARK
  there; `/plugin` names the bypassed hooks. The core delivery
  (`prompt.submit`, `tool.call`, `turn.*`) is not on the guard's bypass
  list and runs everywhere.
- **Wrap-up protocol**: arm via `/thatch_compact` (the mod command), then
  call the `compact` tool. Un-armed greenlight gets the `[not armed]`
  teaching text (accept-then-teach). PASS: armed + greenlit + turn end
  fires the host action (compact) or the safe-to-close notification (exit
  - no host close API exists; that degradation is by design).

## Step C pins: chat wake, adoption

- **Wake delivery**: seed mail via `thatch chat broadcast "QA wake test"`
  (broadcast is the CLI's send path - it reaches every registered session
  including this one); within ~30s the wake arrives as a system-submitted
  TURN (not a nudge in context). PASS: the message row's delivered_at is
  stamped without any model tool call. (There is no `thatch chat send`
  subcommand - broadcast is the only CLI write path.)
- **Continuation adoption**: resume a session (the id forks) - the chat
  identity FOLLOWS: the new session's stage re-registers under the old
  name (the transcript-tail walk). PASS: one roster row, the original
  name, fresh last_seen.

## Step D pins: buffering, watchers

- **Buffer push**: do tool work (read files, run commands). PASS: the
  queue file gains non-`mcp__thatch__` interactions with their input and
  result text. Subagent tool calls buffer too (same session key); the
  work MARK stays main-conversation.
- **Save gate**: a saving `memory_remember` drains the queue + resets the
  missed counter (the opencode drain semantics, server-side).
- **Watcher round-trip**: `watch_command_create` with a condition that
  becomes TRUE LATER - the tool runs the command once at registration as
  validation and REFUSES a command that already exits a watched code (the
  condition is already met), so `true` or `test -f` on an existing file is
  refused BY DESIGN. PASS: register `test -f <a path that does not exist
  yet>`, create the marker (e.g. `touch` it), and the first poll cycle
  after that fires: a runtime_state row (kind `watchers`), the pending
  journal row drains, the notification arrives as a turn. The
  archaeology trio (get_session_info, session_search,
  session_get) and exit/compact must NOT exist as tools here (the fence).

## The update story pins

- **Update-available warning** (once implemented): with a newer npm
  version published, the bundled server's first tool response carries the
  update warning - no version file involved on this path.
- **Host update signal**: `claude plugin update thatch@<marketplace>` then
  `/reload-plugins` applies it; the session's durable state (db, queues)
  survives. The prompt-cache warning on reload is expected (session-static
  instructions) and costs one uncached turn.

## Manual-only checks (never automatable)

- The `/plugin` panel's UI states (scopes, Update now, the prompt-cache
  warning dialog).
- Prompt-cache behavior across reloads (the one-uncached-request cost).
- The ppid anchor under the DESKTOP app (assumes one session per host
  process - unverified there; if desktop serves multiple sessions per
  process, identity misattributes - report it).
- Voice/alert channels end-to-end (banner + speech need a desktop).

## Coexistence note: the built-in security guard

Claude Code's built-in guard (`cc-plugin-sec-default`) loads on managed
settings AND on Team/Enterprise logins. Where it loads, a user-installed
mod's hooks on some events **never run** (`/plugin` shows the note): all
`classic.*` events, `prompt.compose`, `prompt.section`, `prompt.context`,
`session.compact`, `settings.read`, and the attachment/hook-context
`session.append` doors. What still runs and matters here: `prompt.submit`
(nudge/stage delivery), `tool.call` (buffering + the work mark),
`turn.start`/`turn.complete` (the alert round shape), `session.start`/
`session.end`, and the timers. What goes dark under the guard: the pause
alerts (PermissionRequest) and provider-error alerts (StopFailure) - the
debug log shows whether a hook was skipped. Instructions are immune by
design: they ride the CLAUDE.md static block, never a mod hook.

**Tool names in plugin sessions are prefixed
`mcp__plugin_thatch_thatch__`** (the host namespaces a plugin's own
bundled server) - not the `mcp__thatch__` of a standalone registration.
The instructions' tool list and the extraction nudge render the plugin
spelling; bare names (`memory_recall`, `chat_read`) map to it.

## Teardown: restoring your harness after QA

Verified round-trip (plugin install, then hooks restore, checked end to
end in the QA flow). Run these from the thatch repo checkout.

**Back to the hook regime** (keep thatch, drop the plugin): re-run
`thatch setup --claude` (add `--global` if that is your QA scope). It
clears the plugin-regime marker, reinstalls the settings hooks, the
CLAUDE.md block, and the MCP registration, and tells you to remove the
plugin. Then delete the plugin directory:
`rm -rf ~/.claude/thatch-plugin` (or your project's
`.claude/thatch-plugin`).

**Everything thatch, fully gone**:

1. Remove the plugin: `rm -rf ~/.claude/thatch-plugin`; a
   marketplace-installed one is removed with
   `claude plugin uninstall thatch@<marketplace>`.
2. If a hook regime was ever installed, remove its writers by hand:
   - the hooks block in `~/.claude/settings.json` (or the project's
     `.claude/settings.json`) - the entries whose commands run `thatch`;
   - the CLAUDE.md block between `<!-- thatch:begin -->` and
     `<!-- thatch:end -->`;
   - the `thatch` entry under `mcpServers` in `.mcp.json`
     (`claude mcp remove thatch` for user scope).
3. Shared state and skills: `~/.config/thatch/` (the database, config,
   and regime marker), `~/.claude/skills/thatch-*`, the model cache
   (`~/Library/Caches/thatch` / `$XDG_CACHE_HOME/thatch`), and the npm
   package (`npm uninstall -g @jeffober/thatch`).

**If the plugin is broken and delivers nothing**: any `thatch` CLI command
warns when the plugin regime is installed but the plugin has not pinged,
and prints the exact re-run/load instruction. Re-running
`thatch setup --claude` restores the hook regime even when the plugin is
completely dead - that is the always-works way back.

## Reporting

For each pin: PASS / FAIL (+ the surface evidence: file paths, row ids,
log lines). A FAIL names the documented fallback from the plan
(docs/plans/claude-code-holistic-integration.md, "Pins at
implementation"). Never mark a pin PASS from the model's own claims about
itself.
