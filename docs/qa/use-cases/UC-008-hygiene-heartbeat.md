# UC-008: Hygiene heartbeat

**Preconditions**
- A store with: one memory not updated or recalled in 90+ days; one memory scoped to a git
  branch that no longer exists; two near-duplicate memories (similarity > 0.85)
- A second, clean store for the negative case

**Steps**
1. `thatch hygiene` (from the repo)
2. `thatch reminder` (Claude Code hook shape) and `thatch reminder --json` (Cursor)
3. Start an opencode session and a Claude Code / Cursor session (the session-start path)
4. Run the same commands from a directory that is **not** a git repo

**Expected**
- The report names three signals — pending duplicate pairs, stale-memory count, orphaned-branch
  memory count — and **only the non-zero ones**. A fully healthy store prints "Store is healthy."
  (or `null`) and the reminder omits the hygiene block entirely.
- Both `reminder` shapes fold the hygiene block into the session-start text only when it is non-null.
- Outside a git repo, the orphaned-branch check is **skipped** — a missing branch list would
  otherwise make everything look orphaned; stale and dup signals still report.
- Signals are advisory: thatch never deletes or merges memories itself. The agent acts on the
  nudge to fix the store, by the same `memory_forget` / `dedup_mark_checked` tools as UC-002.

_Automatable: yes — `thatch hygiene` and `hygieneReport()` are pure functions over the DB and
git state (`hygiene.test.ts` covers the unit contract); the live session-injection path is
manual._