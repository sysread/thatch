import { tool } from "@opencode-ai/plugin";
import type { ThatchDB, DedupCandidate } from "./db";
import type { EmbeddingModel } from "./embeddings";

function formatEntry(
  entry: Awaited<ReturnType<ThatchDB["showEntry"]>>,
): string | null {
  if (!entry) return null;

  const parts: string[] = [];
  let meta = `[${entry.store}]`;
  if (entry.branch) meta += ` branch:${entry.branch}`;
  if (entry.confidence) meta += ` confidence:${entry.confidence}`;
  parts.push(meta, "", entry.content);
  return parts.join("\n");
}

function formatRecallResult(
  entry: any,
): string {
  let meta = `store:${entry.store}`;
  if (entry.branch) meta += ` branch:${entry.branch}`;
  if (entry.confidence) meta += ` confidence:${entry.confidence}`;
  const score = entry._score.toFixed(3);

  return `[${meta}] [score:${score}]\n${entry.content}`;
}

// ---------------------------------------------------------------------------
// thatch_memory_remember
// ---------------------------------------------------------------------------

export function createRememberTool(
  db: ThatchDB,
  model: EmbeddingModel,
  defaultStore: string,
) {
  return tool({
    description:
      "Persist a piece of information in a thatch store. " +
      "Before writing, check if a memory with the same label already exists " +
      "(use thatch_memory_list or thatch_memory_show). If one exists, read it " +
      "and use overwrite: true to update it rather than creating a duplicate. " +
      "Each memory should be focused on a single topic. Write memories as " +
      "reference material for a future instance of yourself with zero context.",
    args: {
      label: tool.schema.string().describe(
        "Short descriptive title. Used for deduplication — same label in the same store is the same entry.",
      ),
      content: tool.schema.string().describe(
        "The information to remember. Self-contained, understandable without session context.",
      ),
      store: tool.schema.string().optional().describe(
        `Which store to write to. Defaults to the project store ("${defaultStore}").`,
      ),
      branch: tool.schema.string().optional().describe(
        "Git branch this memory is scoped to. Omit for project-wide memories.",
      ),
      confidence: tool.schema.number().int().min(1).max(10).optional().describe(
        "How well-established this observation is (1-10). 1-2: single signal. 5-6: moderate. 9: explicitly stated. 10: hard constraint.",
      ),
      overwrite: tool.schema.boolean().optional().describe(
        "Set to true to replace an existing memory with the same label.",
      ),
    },
    async execute(args, _ctx) {
      const store = args.store || defaultStore;
      const content = `# ${args.label}\n\n${args.content}`;
      const embedding = await model.passageEmbed(content);

      // Write-time collision check: the embedding is already computed, so
      // scanning the store is nearly free. The save proceeds regardless —
      // the agent decides whether and how to reconcile.
      const similar = db.findSimilar(store, embedding, {
        excludeSlug: db.slugify(args.label),
      });

      const result = db.remember(store, args.label, content, embedding, model.name, {
        branch: args.branch ?? undefined,
        confidence: args.confidence ?? undefined,
        overwrite: args.overwrite ?? undefined,
      });

      if (!result.ok) return result.error;

      const saved = `[saved] ${store} :: ${args.label}`;
      if (similar.length === 0) return saved;

      return (
        `${saved}\n\n` +
        `⚠ This memory is semantically similar to existing memories:\n` +
        similar.map((s) => `  - "${s.label}" (similarity ${s.score})`).join("\n") +
        `\n\nReview them with thatch_memory_show and decide how to reconcile: ` +
        `merge into one entry (thatch_memory_remember with overwrite: true, then ` +
        `thatch_memory_forget the other), or record that they are genuinely ` +
        `distinct with thatch_dedup_mark_checked.`
      );
    },
  });
}

// ---------------------------------------------------------------------------
// thatch_memory_recall
// ---------------------------------------------------------------------------

export function createRecallTool(
  db: ThatchDB,
  model: EmbeddingModel,
  defaultStore: string,
) {
  return tool({
    description:
      "Search memories across stores using natural language. " +
      `By default searches the project store ("${defaultStore}") and the "global" store together. ` +
      "Results are ranked by semantic similarity.",
    args: {
      query: tool.schema.string().describe("Natural language query to search for relevant memories."),
      store: tool.schema.string().optional().describe(
        "Limit search to a specific store. Omit to search the project store and global together.",
      ),
      branch: tool.schema.string().optional().describe(
        "Filter to memories scoped to this branch plus project-wide (unscoped) memories.",
      ),
      limit: tool.schema.number().int().min(1).max(20).optional().describe(
        "Maximum number of results. Default 10.",
      ),
    },
    async execute(args, _ctx) {
      const stores = args.store
        ? [args.store]
        : [defaultStore, "global"];
      const limit = args.limit ?? 10;

      const queryEmbedding = await model.queryEmbed(args.query);
      const results = db.recall(stores, queryEmbedding, {
        branch: args.branch ?? undefined,
        limit,
      });

      if (results.length === 0) return "No matching memories found.";

      return results.map(formatRecallResult).join("\n\n-----\n\n");
    },
  });
}

// ---------------------------------------------------------------------------
// thatch_memory_list
// ---------------------------------------------------------------------------

export function createListTool(db: ThatchDB, defaultStore: string) {
  return tool({
    description:
      "List all memory labels in a store with their metadata. " +
      "Use this to see what's available before pulling content into context.",
    args: {
      store: tool.schema.string().optional().describe(
        `Which store to list. Defaults to the project store ("${defaultStore}").`,
      ),
    },
    async execute(args, _ctx) {
      const store = args.store || defaultStore;
      const entries = db.listEntries(store);

      if (entries.length === 0) return `No memories in "${store}".`;

      return entries
        .map((e) => {
          let line = `[${store}] ${e.label}`;
          if (e.branch) line += ` (branch:${e.branch})`;
          if (e.confidence) line += ` (c:${e.confidence})`;
          line += ` (${e.updated_at})`;
          return line;
        })
        .join("\n");
    },
  });
}

// ---------------------------------------------------------------------------
// thatch_memory_show
// ---------------------------------------------------------------------------

export function createShowTool(db: ThatchDB, defaultStore: string) {
  return tool({
    description:
      "Return the full content of a memory by exact label. " +
      "Use this to read a memory after thatch_memory_list or thatch_memory_recall has surfaced it.",
    args: {
      label: tool.schema.string().describe("The exact label of the memory to read."),
      store: tool.schema.string().optional().describe(
        `Which store to read from. Defaults to the project store ("${defaultStore}").`,
      ),
    },
    async execute(args, _ctx) {
      const store = args.store || defaultStore;
      const entry = db.showEntry(store, args.label);

      if (!entry) return `No memory labeled "${args.label}" found in store "${store}".`;

      return formatEntry(entry) || "Error formatting entry.";
    },
  });
}

// ---------------------------------------------------------------------------
// thatch_memory_forget
// ---------------------------------------------------------------------------

export function createForgetTool(db: ThatchDB, defaultStore: string) {
  return tool({
    description:
      "Remove a memory by label from a store. " +
      "Use when asked to stop remembering something, or when consolidating duplicates.",
    args: {
      label: tool.schema.string().describe("The exact label of the memory to remove."),
      store: tool.schema.string().optional().describe(
        `Which store to remove from. Defaults to the project store ("${defaultStore}").`,
      ),
    },
    async execute(args, _ctx) {
      const store = args.store || defaultStore;
      const deleted = db.forgetEntry(store, args.label);

      if (!deleted) return `No memory labeled "${args.label}" found in store "${store}".`;

      return `[forgotten] ${store} :: ${args.label}`;
    },
  });
}

// ---------------------------------------------------------------------------
// thatch_store_list
// ---------------------------------------------------------------------------

export function createListStoresTool(db: ThatchDB) {
  return tool({
    description:
      "List all thatch stores available. The 'global' store exists by default; project stores are created automatically when memories are saved.",
    args: {},
    async execute(_args, _ctx) {
      const stores = db.listStores();
      if (stores.length === 0) return "No stores found.";
      return stores.map((s) => `- ${s}`).join("\n");
    },
  });
}

// ---------------------------------------------------------------------------
// thatch_find_duplicates
// ---------------------------------------------------------------------------

export function createFindDuplicatesTool(db: ThatchDB, defaultStore: string) {
  return tool({
    description:
      "Find memories with unusually similar content that may be candidates " +
      "for consolidation. Uses cosine similarity on embeddings. Related pairs " +
      "are grouped into clusters — a cluster of three or more usually means " +
      "one topic fragmented across entries that should be consolidated into " +
      "a single memory. Pairs already reviewed via thatch_dedup_mark_checked " +
      "are skipped.",
    args: {
      store: tool.schema.string().optional().describe(
        `Which store to check. Defaults to the project store ("${defaultStore}").`,
      ),
      threshold: tool.schema.number().min(0).max(1).optional().describe(
        "Similarity threshold (0-1). Default 0.85.",
      ),
    },
    async execute(args, _ctx) {
      const store = args.store || defaultStore;
      const threshold = args.threshold ?? 0.85;
      const candidates = db.findDuplicates(store, threshold);

      if (candidates.length === 0) return `No duplicate candidates found in "${store}" above threshold ${threshold}.`;

      return renderClusters(candidates);
    },
  });
}

/**
 * Groups candidate pairs into connected components over the similarity graph,
 * so a topic fragmented across N entries reads as one cluster instead of
 * O(N²) pairs. Verdicts stay pairwise (thatch_dedup_mark_checked) — this is
 * presentation only.
 */
function renderClusters(candidates: DedupCandidate[]): string {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };

  for (const c of candidates) union(c.slugA, c.slugB);

  const clusters = new Map<string, DedupCandidate[]>();
  for (const c of candidates) {
    const root = find(c.slugA);
    clusters.set(root, [...(clusters.get(root) ?? []), c]);
  }

  return [...clusters.values()]
    .map((pairs) => {
      const labels = new Set(pairs.flatMap((p) => [p.labelA, p.labelB]));
      const lines = pairs.map((p) => `  [score:${p.score}] "${p.labelA}" ↔ "${p.labelB}"`);
      return `Cluster of ${labels.size}:\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// thatch_dedup_mark_checked
// ---------------------------------------------------------------------------

export function createMarkCheckedTool(db: ThatchDB, defaultStore: string) {
  return tool({
    description:
      "Record the verdict for a duplicate-candidate pair after reviewing it, " +
      "so thatch_find_duplicates stops re-reporting the pair. Use after " +
      "resolving (or deciding not to touch) a pair it surfaced. Overwriting " +
      "either memory later clears the verdict automatically.",
    args: {
      label_a: tool.schema.string().describe("Label of the first memory in the pair."),
      label_b: tool.schema.string().describe("Label of the second memory in the pair."),
      status: tool.schema.string().describe(
        'The verdict: "duplicate", "supplement", "contradiction", or "unrelated".',
      ),
      store: tool.schema.string().optional().describe(
        `Store the pair lives in. Defaults to the project store ("${defaultStore}").`,
      ),
    },
    async execute(args, _ctx) {
      const store = args.store || defaultStore;
      db.markPairChecked(store, db.slugify(args.label_a), db.slugify(args.label_b), args.status);
      return `[checked] ${store} :: "${args.label_a}" ↔ "${args.label_b}" → ${args.status}`;
    },
  });
}
