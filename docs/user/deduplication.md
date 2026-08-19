# Deduplication

When two memories are very similar, thatch surfaces them as duplicate
candidates. The agent decides whether to merge, keep both, or mark
them as distinct. Thatch never merges or deletes memories on its own.

## How it works

The dedup cycle is agent-driven:

1. **Find pairs.** `thatch_find_duplicates` searches for memory pairs
   whose cosine similarity exceeds the threshold (default 0.85). Pairs
   already reviewed via `thatch_dedup_mark_checked` are skipped. Related
   pairs are grouped into clusters: a cluster of 3+ labels usually
   means one topic fragmented across entries that should be consolidated.

2. **Classify.** The agent loads the `thatch-dedup-classifier` skill,
   reads both memories, and decides the relationship:
   - **Duplicate**: same information, merge into one.
   - **Supplement**: related but distinct, keep both.
   - **Contradiction**: conflicting information, resolve.
   - **Unrelated**: similar wording, different topic, mark and ignore.

3. **Reconcile.** For duplicates, the agent merges by updating one
   memory with `overwrite: true` and deleting the other with
   `thatch_memory_forget`. For contradictions, the agent resolves the
   conflict and updates. For supplements and unrelated pairs, no
   changes needed.

4. **Record verdict.** The agent calls `thatch_dedup_mark_checked` with
   the pair labels and the verdict. This stops `find_duplicates` from
   re-reporting the pair.

## Verdict lifecycle

Verdicts are not permanent. Overwriting either memory with
`overwrite: true` clears all verdicts involving that memory.
Deleting a memory with `thatch_memory_forget` also clears its
verdicts. This means a merged pair can re-flag if the merge creates
a new similarity with a different memory.

This is intended. A merge changes the content, which may create new
duplicate relationships that should be reviewed.

## When it fires

The dedup cycle is not automatic. It fires when:

- The agent calls `thatch_find_duplicates` directly (you ask, or the
  hygiene report motivates it).
- The hygiene report at session start shows duplicate candidates,
  prompting the agent to run `find_duplicates` and work through them.
- The write-time similarity warning fires on `thatch_memory_remember`,
  alerting the agent to near-duplicate entries.

## Limitations

- Similarity is cosine only. Two memories can say the same thing in
  different words and not be flagged. Two memories with similar wording
  but different meaning can false-flag.
- The 0.85 threshold is hardcoded. There is no configuration for it.
- The agent drives the cycle. Thatch never merges or deletes memories
  on its own. If the agent does not call `thatch_find_duplicates`,
  duplicates accumulate.
- Verdicts are cleared when either memory is updated. A merged pair can
  re-flag if the merge creates a new similarity with a different memory.
  This is intended, but it means dedup is not a one-time fix.

See [hygiene.md](hygiene.md) for the hygiene report and
[memory.md](memory.md) for the memory tools.
