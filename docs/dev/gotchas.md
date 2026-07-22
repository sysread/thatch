# Gotchas

Non-obvious invariants and footguns. If something behaves strangely, check
here first. These are the things that have already cost time.

## Embeddings

- **Embedding spaces are discriminated by vector _dimension_, not model tag.**
  `recall` / `findDuplicates` skip entries whose vector length differs from the
  query. The `model` column is informational only. Switching `THATCH_MODEL`
  makes old memories _invisible_ to search (not corrupted, not deleted — just
  skipped) until re-saved. There is no automatic re-embedding.
- **Embedding serialization honors `byteOffset`/`byteLength`.** transformers.js
  can return a `Float32Array` that is a _view_ into a larger tensor buffer.
  Serializing the whole backing buffer corrupts vectors. Always serialize the
  view's own bytes, not the underlying buffer.
- **BGE asymmetric search**: queries get the prefix
  `"Represent this sentence for searching relevant passages: "`; passages get
  no prefix. `queryEmbed` vs `passageEmbed` — don't swap them.

## Search vs recall

- **`search` scores; `recall` scores _and_ stamps telemetry.** `search` records
  no usage. The prompt-aware recall nudge deliberately uses `db.search()` (not
  `recall`) so nudges don't inflate the "used recently" signal. Only explicit
  `thatch_memory_recall` / CLI `search` stamp `recall_count`/`last_recalled_at`.
- **`findSimilar` excludes the slug being written** (self-exclusion on
  overwrite), so overwriting a memory doesn't warn against itself.

## Writes

- **The write-time similarity warning never blocks the save.** `remember` always
  proceeds; the warning lists >= 0.85-similar entries and asks the agent to
  reconcile (merge or `dedup_mark_checked`). Don't add blocking logic here.
- **`overwrite: true` clears stale dedup verdicts** for that slug. Forgetting an
  entry clears all verdicts involving it. Both make a pair eligible for
  re-reporting by `find_duplicates`. This is intended.
- **Archived memories are excluded by default.** `search`, `findDuplicates`,
  and `staleEntryCount` all filter `WHERE archived = 0`. To search archived
  memories, pass `includeArchived: true` to `thatch_memory_recall`. To archive
  a memory, write it with `archived: true`; to unarchive, `archived: false`.
- **Updating an archived memory requires explicit `archived` param.** If the
  entry is already archived and a `remember` call omits the `archived` param,
  the tool returns an error (`db.ts:211`). Pass `archived: true` to keep it
  archived or `archived: false` to unarchive. This guard prevents accidental
  unarchival via an unrelated content update.

## Hooks (opencode)

- **`tool.execute.after` is a plugin hook, NOT a bus event.** It must stay on
  the hook object returned by `server`. Moving it into the `event` handler
  (where `session.created` lives) silently never fires it — the event bus has
  no such event. This was dead for weeks because the failure was invisible.
- **`tool.execute.after` excludes `skill` and `task` tools**, not just
  `thatch_*`. Buffering them creates a feedback loop: the nudge triggers a
  skill load, which gets buffered, which triggers another nudge on the next
  turn.
- **Hook failures are logged with a `[thatch]` prefix and never swallowed.** Two
  hooks were dead for weeks before failures were made visible. If you add a
  hook, log on failure.
- **`chat.message` has two priority tiers**: extraction nudge first (returns
  early), then the prompt-aware recall nudge. Don't run both in one turn.
- **The extraction nudge peeks, never flushes.** The buffer is NOT drained
  on nudge delivery (`index.ts:169` — `peek()` call). It persists until the
  agent writes a memory or calls `thatch_extraction_done`. Ignored nudges
  accumulate; the `missedNudges` counter escalates the tone (polite at 0-1
  misses, insistent at 2, ALL-CAPS at 3+). The counter resets when the
  buffer drains.
- **A child sub-agent's `thatch_memory_remember` drains the parent's buffer**
  via the `childToParent` Map (`index.ts:65` declaration, `index.ts:131`
  lookup). Without this, dispatching the fact-extractor as a background task
  would write memories in the child but never clear the parent's queue — the
  nudge would replay every turn. `thatch_extraction_done` is the
  belt-and-suspenders explicit acknowledgment: it drains the buffer without
  requiring a memory write (covers cases where the sub-agent errors out or the
  host doesn't expose parent-child session relationships).

## Hooks (Claude Code / Cursor)

- **`PostToolBatch`/`postToolUse` must be silent** (no stdout). The agent loop
  must not block on a payload that should be invisible until the next prompt.
  Only `flush-tools` prints.
- **The recall nudge arrives at the _start_ of the next turn** in Claude
  Code/Cursor, not the end of the current one like opencode's `chat.message`. A
  file-backed queue bridges calls that have no shared state.
- **Cursor uses `conversation_id`** where Claude Code uses `session_id`.
  `buffer-tool` normalizes the former to a safe filename and tries multiple
  field names for the tool response.
- **`--json` flips the output shape.** `reminder --json` and `flush-tools
  --json` emit `{ additional_context: "..." }` for Cursor; plain stdout for
  Claude Code. The flag is baked into the installed hook command.

## Sideband

- **Socket path = SHA-256 of the DB path**, under `os.tmpdir()`. The MCP server
  and hook processes compute it independently — no out-of-band coordination.
  Changing `THATCH_DB_PATH` moves the socket; a stale socket from a crash is
  cleaned up on connection error.
- **Sideband failure never blocks.** Server down, stale socket, or a >2 s
  timeout all return `null`, and `flush-tools` falls back to the static write
  nudge. Never hard-fail the agent over a recall nudge.

## Setup

- **Skills are always user-scoped**, even in project-local setup. The project's
  `.claude/settings.json` and `CLAUDE.md` stay in the repo, but skills live
  under `$CLAUDE_CONFIG_DIR/skills/` / `~/.cursor/skills/`. Installing into the
  worktree would mutate the user's repo.
- **`appendBlock` leaves content alone if the markers don't parse.** If the
  start marker is found but the end marker isn't, the whole block is skipped
  rather than half-replaced. Fix the markers or delete the block manually.
- **The binary path is baked into installed hook commands.** `thatch setup`
  resolves `<bin>` from PATH (or the script's absolute path) and writes it into
  every hook command, so hooks survive after the setup session ends.

## Tests

- **DB tests use real SQLite files in `mkdtempSync`, not `:memory:`.** WAL
  behavior differs in-memory and would mask bugs. Temp dirs are removed in
  `afterEach`.
- **`BgeEmbeddingModel`'s real `PipelineFactory` is untested** — downloading the
  model violates the no-network rule. Lazy-load and retry logic are tested with
  an injected mock factory. The real model is exercised only by real use.
- **`bun test` does not typecheck**, and `tsconfig.json` excludes `tests`. Test
  type errors are editor-only noise unless you run `tsc` on the test files
  directly. Keep test files type-clean anyway so the editor stays quiet.
