# UC-004: Inspecting stores from the shell

**Preconditions**
- Bun on PATH; thatch installed (`npm i -g @jeffober/thatch` or a checkout)
- At least one memory saved via opencode

**Steps**
1. `thatch stores` — list all stores.
2. `cd` into the project's repo, then `thatch list` — labels default to the
   repo's store.
3. `thatch show <label>` — full content.
4. `thatch search "some topic"` — semantic search (downloads/loads the real
   embedding model on first use; prints a loading notice to stderr).
5. `thatch search some topic` (unquoted, multi-word).
6. `thatch search "query" bogus-store`.

**Expected**
- Steps 1–4 behave as described; search results are ranked with scores.
- Step 5 exits non-zero with an error telling you to quote the query —
  it must NOT silently search a store named "topic".
- Step 6 exits non-zero listing the stores that do exist.
- All commands respect `THATCH_DB_PATH` and `$XDG_CONFIG_HOME`.
