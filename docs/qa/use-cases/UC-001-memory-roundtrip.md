# UC-001: Remember and recall across sessions

**Preconditions**
- thatch configured as a plugin in opencode (npm or local path)
- Working directory is a git repo with an `origin` remote

**Steps**
1. In an opencode session, ask the agent to remember a distinctive fact, e.g.
   "remember that our staging DB lives at staging-db.internal:5432".
2. Confirm the agent calls `thatch_memory_remember` and reports `[saved]`.
3. End the session. Start a fresh session in the same repo.
4. Ask a related question: "where does staging data live?"

**Expected**
- The agent calls `thatch_memory_recall` and surfaces the saved fact with a
  similarity score.
- `thatch list` (CLI) shows the memory in the repo's store (named
  `owner/repo` from the git remote), not in `global`.
- Saving the same label again without `overwrite: true` is rejected with an
  error naming the label and store.
