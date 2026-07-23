import { z } from "zod";
import type { ThatchDB, DedupCandidate } from "./db";
import type { EmbeddingModel } from "./embeddings";

// Near-duplicate thresholds for matcher/prediction dedup at creation time.
// Matches the thatch_find_duplicates threshold (0.85).
const MATCHER_DEDUP_COSINE = 0.85;
const PREDICTION_DEDUP_COSINE = 0.85;

// Minimum matcher cosine to consider a prediction relevant. Matches the
// auto-fire threshold in index.ts (PREDICTION_THRESHOLD). The query tool
// should not return predictions from near-zero-similarity matchers that
// would never fire in the auto-fire.
const PREDICTION_QUERY_THRESHOLD = 0.45;

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
 * Acknowledge that the extraction nudge has been handled. Drains the
 * extraction buffer so the nudge does not replay on the next turn.
 *
 * The actual draining happens in the host's post-tool hook
 * (tool.execute.after for opencode, PostToolBatch/appendBatch for MCP) —
 * this tool's execute function is a no-op confirmation. The tool exists so
 * the model can call it in the parent session after dispatching the
 * fact-extractor to a sub-agent, giving the hook a recognizable tool name
 * to key on. Without it, the buffer only drains when a memory_remember
 * call lands in the same session (or a tracked child session), which fails
 * if the sub-agent errors out or the host doesn't expose parent-child
 * session relationships.
 */
const extractionDoneDef: ToolDef = {
  name: "extraction_done",
  description:
    "Acknowledge that the extraction nudge has been dispatched to a sub-agent. " +
    "Drains the extraction buffer so the nudge does not replay. " +
    "Call this in the parent session after dispatching a background task " +
    "to run the thatch-fact-extractor skill.",
  args: {},
  async execute() {
    return "[acknowledged] extraction buffer drained";
  },
};

// ---------------------------------------------------------------------------
// Prediction engine: user decision model
// ---------------------------------------------------------------------------

const predictionQueryDef: ToolDef = {
  name: "prediction_query",
  description:
    "Query the user decision model for scored predictions matching a " +
    "context. Returns predictions with confidence and evidence count. " +
    "Use when facing a judgment call about scope, appropriateness, or " +
    "methodology and the auto-injected prediction block did not already " +
    "cover the situation.",
  args: {
    context: z.string().describe(
      "The situation or context to match against. Describe the decision being faced.",
    ),
    store: z.string().optional().describe(
      "Store to search. Defaults to the project store and global together.",
    ),
  },
  async execute(args, ctx) {
    const stores = args.store
      ? [args.store as string]
      : [ctx.defaultStore, "global"];
    const embedding = await ctx.model.queryEmbed(args.context as string);
    const matchers = ctx.db.findMatchers(stores, embedding, { limit: 5 })
      .filter((m) => m.score >= PREDICTION_QUERY_THRESHOLD);
    if (matchers.length === 0) return "No matching predictions found.";
    const scored = ctx.db.scorePredictions(matchers);
    if (scored.length === 0) return "No matching predictions found.";
    return scored.map((s) => {
      const verb = s.evidence_count === 0 ? "you may prefer" : "you tend to";
      return `[${s.confidence.toFixed(2)} conf, ${s.evidence_count} tests] ` +
        `When ${s.matcher_description}: ${verb} ${s.statement}`;
    }).join("\n");
  },
};

const predictionUpdateDef: ToolDef = {
  name: "prediction_update",
  description:
    "Create, reinforce, or weaken a prediction in the user decision " +
    "model. Use when the user corrects you, answers a question, or " +
    "provides a clear signal about their preferences or decision-making " +
    "strategy. The tool handles matcher and prediction lookup, dedup, " +
    "and confidence adjustment automatically.",
  args: {
    matcher: z.string().describe(
      "Description of the situation. What decision was being made?",
    ),
    prediction: z.string().describe(
      "The user's preference or tendency in this situation.",
    ),
    signal: z.enum(["confirm", "disconfirm", "soft", "create"]).describe(
      "What happened: confirm (user confirmed the prediction), " +
      "disconfirm (user pushed back), soft (weak disconfirm, user " +
      "partially disagreed), create (new observation).",
    ),
    rationale: z.string().describe(
      "Why this prediction was formed or updated. What did the user say or do?",
    ),
    store: z.string().optional().describe(
      "Store to write to. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const matcherText = args.matcher as string;
    const predictionText = args.prediction as string;
    const signal = args.signal as "confirm" | "disconfirm" | "soft" | "create";
    const rationale = args.rationale as string;

    const matcherEmbed = await ctx.model.passageEmbed(matcherText);
    const predEmbed = await ctx.model.passageEmbed(predictionText);

    // All read-modify-write mutations run inside a transaction so a
    // failure mid-sequence (FK violation, I/O error) rolls back the
    // entire operation rather than leaving orphans (matcher without
    // prediction, prediction without edge, edge without confidence).
    return ctx.db.transaction(() => {
      // Dedup matchers: find an existing matcher above the cosine threshold
      // rather than always creating a new one.
      let matcherId = ctx.db.findNearestMatcher(store, matcherEmbed, MATCHER_DEDUP_COSINE)?.id;
      if (!matcherId) matcherId = ctx.db.createMatcher(store, matcherText, matcherEmbed, ctx.model.name);

      // Store-wide dedup: search the entire store for a near-identical
      // prediction, not just this matcher's edges. If found, link this
      // matcher to the existing prediction via an edge rather than
      // creating a second row with the same statement.
      let predictionId = ctx.db.findNearestPrediction(store, predEmbed, PREDICTION_DEDUP_COSINE)?.id;

      if (!predictionId) {
        // No near-identical prediction exists; create one and link it.
        predictionId = ctx.db.createPrediction(store, predictionText, rationale, predEmbed, ctx.model.name);
        ctx.db.createEdge(matcherId, predictionId, 1.0);

        // When the signal is confirm/disconfirm/soft (not create), apply
        // it immediately so the first signal isn't lost. The prediction
        // starts at p0 with 0 evidence; without this, the agent's
        // "confirm" would be discarded and the prediction would have
        // 0 confirms.
        if (signal !== "create") {
          ctx.db.adjustConfidence(predictionId, signal === "soft" ? "soft" : signal === "confirm" ? "confirm" : "disconfirm");
          ctx.db.addProvenance(predictionId, signal, rationale);
          const updated = ctx.db.getPrediction(predictionId);
          return `[created + ${signal}] "${updated?.statement ?? predictionText}" confidence=${(updated?.confidence ?? 0).toFixed(2)} (${updated?.confirm_count ?? 0}/${updated?.disconfirm_count ?? 0})`;
        }
        ctx.db.addProvenance(predictionId, "create", rationale);
        return `[created] ${store} :: "${predictionText}" for "${matcherText}"`;
      }

      // Ensure an edge links this matcher to the existing prediction.
      // createEdge uses ON CONFLICT DO NOTHING, so existing edge weights
      // are preserved.
      ctx.db.createEdge(matcherId, predictionId, 1.0);

      // "create" on an existing prediction means the agent re-observed
      // the same preference in a new context. Link the edge and record
      // provenance, but do NOT adjust confidence — "create" is
      // confidence-neutral, not a disconfirm.
      if (signal === "create") {
        ctx.db.addProvenance(predictionId, "create", rationale);
        const existing = ctx.db.getPrediction(predictionId);
        return `[linked] "${existing?.statement ?? predictionText}" for "${matcherText}" confidence=${(existing?.confidence ?? 0).toFixed(2)} (${existing?.confirm_count ?? 0}/${existing?.disconfirm_count ?? 0})`;
      }

      // Signal is confirm, disconfirm, or soft. Map the tool's 4-value
      // enum to adjustConfidence's 3-value enum.
      ctx.db.adjustConfidence(predictionId, signal === "soft" ? "soft" : signal === "confirm" ? "confirm" : "disconfirm");
      ctx.db.addProvenance(predictionId, signal, rationale);
      const updated = ctx.db.getPrediction(predictionId);
      return `[${signal}] "${updated?.statement ?? predictionText}" confidence=${(updated?.confidence ?? 0).toFixed(2)} (${updated?.confirm_count ?? 0}/${updated?.disconfirm_count ?? 0})`;
    });
  },
};

const predictionListDef: ToolDef = {
  name: "prediction_list",
  description:
    "List all predictions in the user decision model with their matchers, " +
    "confidence, and evidence count. For inspection and debugging.",
  args: {
    store: z.string().optional().describe(
      "Which store to list. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const predictions = ctx.db.listPredictions(store);
    if (predictions.length === 0) return `No predictions in "${store}".`;
    return predictions.map((p) => {
      const matchers = p.matchers.map((m) => `    - "${m.description}" (w:${m.weight})`).join("\n");
      const provenance = ctx.db.getProvenance(p.id);
      const provLines = provenance.map((pr) => `    - [${pr.created_at.slice(0, 10)}] ${pr.signal}: ${pr.detail ?? ""}`).join("\n");
      return `[${p.confidence.toFixed(2)} conf, ${p.evidence_count} tests] ${p.statement}` +
        (p.rationale ? `\n  rationale: ${p.rationale}` : "") +
        (matchers ? `\n  matchers:\n${matchers}` : "") +
        (provLines ? `\n  provenance:\n${provLines}` : "");
    }).join("\n\n");
  },
};

const predictionDeleteDef: ToolDef = {
  name: "prediction_delete",
  description:
    "Delete a prediction from the user decision model. Useful when a " +
    "prediction was created in error or is no longer relevant. Edges " +
    "and provenance are deleted automatically (cascade).",
  args: {
    statement: z.string().describe(
      "The prediction statement to delete. Use prediction_list to find the exact text; matching is semantic (cosine >= 0.85).",
    ),
    store: z.string().optional().describe(
      "Store to delete from. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const statementText = args.statement as string;
    const predEmbed = await ctx.model.passageEmbed(statementText);
    const prediction = ctx.db.findNearestPrediction(store, predEmbed, PREDICTION_DEDUP_COSINE);
    if (!prediction) return `No prediction matching "${statementText}" found in "${store}".`;
    const deleted = ctx.db.deletePrediction(prediction.id);
    if (!deleted) return `Failed to delete prediction "${prediction.statement}".`;
    return `[deleted] "${prediction.statement}" from "${store}"`;
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
  extractionDoneDef,
  predictionQueryDef,
  predictionUpdateDef,
  predictionListDef,
  predictionDeleteDef,
];
