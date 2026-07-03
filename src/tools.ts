import { tool } from "@opencode-ai/plugin";
import type { ThatchDB } from "./db";
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

      const result = db.remember(store, args.label, content, embedding, "bge-small-en-v1.5", {
        branch: args.branch ?? undefined,
        confidence: args.confidence ?? undefined,
        overwrite: args.overwrite ?? undefined,
      });

      if (!result.ok) return result.error;
      return `[saved] ${store} :: ${args.label}`;
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
