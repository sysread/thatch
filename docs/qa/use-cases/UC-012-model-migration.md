# UC-012: THATCH_MODEL migration (mixed embedding dimensions)

**Preconditions**
- A store with memories embedded by a model of dimension A (e.g. the default
  384-dim `bge-small-en-v1.5`)
- A second model available whose vectors have a **different** dimension

**Steps**
1. `export THATCH_MODEL=<other-model>` (different vector dimension).
2. Start a fresh session. `memory_list` and `memory_show` an old memory by label.
3. `memory_recall` for a topic that matches an old memory.
4. Save a new memory with the new model; `memory_recall` for it.
5. `memory_show` an old memory and inspect its `model` tag.

**Expected**
- `list` and `show` still return the old memories — the data is intact, **not
  corrupted and not deleted**.
- `recall` returns **no matches** for the old memories: entries whose vector
  dimension differs from the query are skipped, not scored. This is a silent
  skip, not an error.
- The new memory embeds at the new dimension and is recallable.
- `show` reveals the old memories carry the old model tag while new ones carry
  the new tag. There is **no automatic re-embedding** — old memories stay
  invisible to search until re-saved.

_Automatable: yes — dimension-skip and data-intact assertions are pure DB calls;
use two `MockEmbeddingModel` instances with different dimensions (no network, no
real model download)._
