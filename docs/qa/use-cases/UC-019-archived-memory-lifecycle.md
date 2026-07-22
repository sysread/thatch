# UC-019: Archived memory lifecycle

_Automatable: archive guard + search/dedup/staleness exclusion are pure DB
contract testable with a temp DB._

**Preconditions**
- thatch plugin active in an opencode session (or CLI with a test store)

**Steps**
1. Save a memory scoped to a feature branch:
   `thatch_memory_remember` with `branch: "feature-x"`, `label: "Feature X design decisions"`, `content: "..."`.
2. Merge or delete the branch. Save a consolidated archived memory:
   `thatch_memory_remember` with `overwrite: true`, `archived: true`,
   `branch: "feature-x"`, same label, consolidated content.
3. Search for content related to the archived memory:
   `thatch_memory_recall` with a relevant query (no `includeArchived`).
4. Search again with `includeArchived: true`.
5. Attempt to update the archived memory's content without passing the
   `archived` param.
6. Unarchive the memory: `thatch_memory_remember` with `overwrite: true`,
   `archived: false`.

**Expected**
- Step 2: the memory is saved with `archived: true`. The `archived` column is
  set to 1 in the database.
- Step 3: the archived memory does NOT appear in search results — `search`
  filters `WHERE archived = 0`.
- Step 4: the archived memory DOES appear when `includeArchived: true` is
  passed.
- Step 5: the tool returns an error: `"Feature X design decisions" is
  archived. Pass archived: true to keep it archived, or archived: false to
  unarchive it.` The content is NOT updated.
- Step 6: the memory is unarchived (`archived` column set to 0). It reappears
  in normal search results.
- `find_duplicates` does not surface archived memories as candidates.
- `staleEntryCount` (hygiene) does not count archived memories as stale.
