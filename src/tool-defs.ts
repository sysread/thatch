import { z } from "zod";
import type { ThatchDB, DedupCandidate } from "./db";
import type { EmbeddingModel } from "./embeddings";

/**
 * Shared context passed to every tool's execute function. Framework-agnostic —
 * neither opencode nor MCP specific. The plugin wires real defaults; tests and
 * the MCP server inject whatever they need.
 */
export interface CoreContext {
  db: ThatchDB;
  model: EmbeddingModel;
  defaultStore: string;
}

/**
 * A tool definition — the single source of truth shared by the opencode plugin
 * wrapper (tools.ts) and the MCP server (mcp.ts). The `args` field is a ZodRawShape
 * (a plain object of Zod types), which opencode's `tool()` accepts directly and
 * the MCP server wraps in `z.object()` for validation and `z.toJSONSchema()` for
 * the protocol response.
 */
export interface ToolDef {
  name: string;
  description: string;
  args: Record<string, z.ZodType>;
  execute(args: Record<string, unknown>, ctx: CoreContext): Promise<string>;
}

// ---------------------------------------------------------------------------
// Formatting helpers — shared by all tools that render entries
// ---------------------------------------------------------------------------

function formatEntry(
  entry: Awaited<ReturnType<ThatchDB["showEntry"]>>,
): string | null {
  if (!entry) return null;

  const parts: string[] = [];
  let meta = `[${entry.store}]`;
  if (entry.branch) meta += ` branch:${entry.branch}`;
  if (entry.confidence) meta += ` confidence:${entry.confidence}`;
  if (entry.archived) meta += " archived:true";
  parts.push(meta, "", entry.content);
  return parts.join("\n");
}

function formatRecallResult(entry: any): string {
  let meta = `store:${entry.store}`;
  if (entry.branch) meta += ` branch:${entry.branch}`;
  if (entry.confidence) meta += ` confidence:${entry.confidence}`;
  if (entry.archived) meta += " archived:true";
  const score = entry._score.toFixed(3);
  return `[${meta}] [score:${score}]\n${entry.content}`;
}

/**
 * Groups candidate pairs into connected components over the similarity graph,
 * so a topic fragmented across N entries reads as one cluster instead of
 * O(N²) pairs. Verdicts stay pairwise (markChecked) — this is presentation only.
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
// Tool definitions
// ---------------------------------------------------------------------------

const rememberDef: ToolDef = {
  name: "memory_remember",
  description:
    "Persist a piece of information in a thatch store. " +
    "Before writing, check if a memory with the same label already exists " +
    "(use memory_list or memory_show). If one exists, read it " +
    "and use overwrite: true to update it rather than creating a duplicate. " +
    "Each memory should be focused on a single topic. Write memories as " +
    "reference material for a future instance of yourself with zero context.",
  args: {
    label: z.string().describe(
      "Short descriptive title. Used for deduplication — same label in the same store is the same entry.",
    ),
    content: z.string().describe(
      "The information to remember. Self-contained, understandable without session context.",
    ),
    store: z.string().optional().describe(
      "Which store to write to. Defaults to the project store.",
    ),
    branch: z.string().optional().describe(
      "Git branch this memory is scoped to. Omit for project-wide memories.",
    ),
    confidence: z.number().int().min(1).max(10).optional().describe(
      "How well-established this observation is (1-10). 1-2: single signal. 5-6: moderate. 9: explicitly stated. 10: hard constraint.",
    ),
    overwrite: z.boolean().optional().describe(
      "Set to true to replace an existing memory with the same label.",
    ),
    archived: z.boolean().optional().describe(
      "Mark this memory as a stable, long-term record that should not trigger hygiene nudges. " +
      "When updating an already-archived memory, this param is REQUIRED — " +
      "pass archived: true to keep it archived, or archived: false to unarchive.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const label = args.label as string;
    const content = `# ${label}\n\n${args.content as string}`;
    const embedding = await ctx.model.passageEmbed(content);

    const similar = ctx.db.findSimilar(store, embedding, {
      excludeSlug: ctx.db.slugify(label),
    });

    const result = ctx.db.remember(store, label, content, embedding, ctx.model.name, {
      branch: args.branch as string | undefined,
      confidence: args.confidence as number | undefined,
      overwrite: args.overwrite as boolean | undefined,
      archived: args.archived as boolean | undefined,
    });

    if (!result.ok) return result.error;

    const saved = `[saved] ${store} :: ${label}`;
    if (similar.length === 0) return saved;

    return (
      `${saved}\n\n` +
      `⚠ This memory is semantically similar to existing memories:\n` +
      similar.map((s) => `  - "${s.label}" (similarity ${s.score})`).join("\n") +
      `\n\nReview them with memory_show and decide how to reconcile: ` +
      `merge into one entry (memory_remember with overwrite: true, then ` +
      `memory_forget the other), or record that they are genuinely ` +
      `distinct with dedup_mark_checked.`
    );
  },
};

const recallDef: ToolDef = {
  name: "memory_recall",
  description:
    "Search memories across stores using natural language. " +
    "By default searches the project store and the \"global\" store together. " +
    "Results are ranked by semantic similarity.",
  args: {
    query: z.string().describe("Natural language query to search for relevant memories."),
    store: z.string().optional().describe(
      "Limit search to a specific store. Omit to search the project store and global together.",
    ),
    branch: z.string().optional().describe(
      "Filter to memories scoped to this branch plus project-wide (unscoped) memories.",
    ),
    limit: z.number().int().min(1).max(20).optional().describe(
      "Maximum number of results. Default 10.",
    ),
    includeArchived: z.boolean().optional().describe(
      "Include archived memories in results. Default false — archived memories are excluded.",
    ),
  },
  async execute(args, ctx) {
    const stores = args.store
      ? [args.store as string]
      : [ctx.defaultStore, "global"];
    const limit = (args.limit as number) ?? 10;

    const queryEmbedding = await ctx.model.queryEmbed(args.query as string);
    const results = ctx.db.recall(stores, queryEmbedding, {
      branch: args.branch as string | undefined,
      limit,
      includeArchived: args.includeArchived as boolean | undefined,
    });

    if (results.length === 0) return "No matching memories found.";

    return results.map(formatRecallResult).join("\n\n-----\n\n");
  },
};

const listDef: ToolDef = {
  name: "memory_list",
  description:
    "List all memory labels in a store with their metadata. " +
    "Use this to see what's available before pulling content into context.",
  args: {
    store: z.string().optional().describe(
      "Which store to list. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const entries = ctx.db.listEntries(store);

    if (entries.length === 0) return `No memories in "${store}".`;

    return entries
      .map((e) => {
        let line = `[${store}] ${e.label}`;
        if (e.branch) line += ` (branch:${e.branch})`;
        if (e.confidence) line += ` (c:${e.confidence})`;
        if (e.archived) line += " (archived)";
        line += ` (${e.updated_at})`;
        return line;
      })
      .join("\n");
  },
};

const showDef: ToolDef = {
  name: "memory_show",
  description:
    "Return the full content of a memory by exact label. " +
    "Use this to read a memory after memory_list or memory_recall has surfaced it.",
  args: {
    label: z.string().describe("The exact label of the memory to read."),
    store: z.string().optional().describe(
      "Which store to read from. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const entry = ctx.db.showEntry(store, args.label as string);

    if (!entry) return `No memory labeled "${args.label as string}" found in store "${store}".`;

    return formatEntry(entry) || "Error formatting entry.";
  },
};

const forgetDef: ToolDef = {
  name: "memory_forget",
  description:
    "Remove a memory by label from a store. " +
    "Use when asked to stop remembering something, or when consolidating duplicates.",
  args: {
    label: z.string().describe("The exact label of the memory to remove."),
    store: z.string().optional().describe(
      "Which store to remove from. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const deleted = ctx.db.forgetEntry(store, args.label as string);

    if (!deleted) return `No memory labeled "${args.label as string}" found in store "${store}".`;

    return `[forgotten] ${store} :: ${args.label as string}`;
  },
};

const listStoresDef: ToolDef = {
  name: "store_list",
  description:
    "List all thatch stores available. The 'global' store exists by default; project stores are created automatically when memories are saved.",
  args: {},
  async execute(_args, ctx) {
    const stores = ctx.db.listStores();
    if (stores.length === 0) return "No stores found.";
    return stores.map((s) => `- ${s}`).join("\n");
  },
};

const findDuplicatesDef: ToolDef = {
  name: "find_duplicates",
  description:
    "Find memories with unusually similar content that may be candidates " +
    "for consolidation. Uses cosine similarity on embeddings. Related pairs " +
    "are grouped into clusters — a cluster of three or more usually means " +
    "one topic fragmented across entries that should be consolidated into " +
    "a single memory. Pairs already reviewed via dedup_mark_checked " +
    "are skipped.",
  args: {
    store: z.string().optional().describe(
      "Which store to check. Defaults to the project store.",
    ),
    threshold: z.number().min(0).max(1).optional().describe(
      "Similarity threshold (0-1). Default 0.85.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const threshold = (args.threshold as number) ?? 0.85;
    const candidates = ctx.db.findDuplicates(store, threshold);

    if (candidates.length === 0) return `No duplicate candidates found in "${store}" above threshold ${threshold}.`;

    return renderClusters(candidates);
  },
};

const markCheckedDef: ToolDef = {
  name: "dedup_mark_checked",
  description:
    "Record the verdict for a duplicate-candidate pair after reviewing it, " +
    "so find_duplicates stops re-reporting the pair. Use after " +
    "resolving (or deciding not to touch) a pair it surfaced. Overwriting " +
    "either memory later clears the verdict automatically.",
  args: {
    label_a: z.string().describe("Label of the first memory in the pair."),
    label_b: z.string().describe("Label of the second memory in the pair."),
    status: z.string().describe(
      'The verdict: "duplicate", "supplement", "contradiction", or "unrelated".',
    ),
    store: z.string().optional().describe(
      "Store the pair lives in. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    ctx.db.markPairChecked(
      store,
      ctx.db.slugify(args.label_a as string),
      ctx.db.slugify(args.label_b as string),
      args.status as string,
    );
    return `[checked] ${store} :: "${args.label_a as string}" ↔ "${args.label_b as string}" → ${args.status as string}`;
  },
};

/**
 * All tool definitions, in the order they should be presented to the agent.
 * The opencode plugin wraps each in `tool()`; the MCP server exposes them
 * via `tools/list` and dispatches `tools/call` to their execute functions.
 */
export const TOOL_DEFS: ToolDef[] = [
  rememberDef,
  recallDef,
  listDef,
  showDef,
  forgetDef,
  listStoresDef,
  findDuplicatesDef,
  markCheckedDef,
];
