import { z } from "zod";
import type { ThatchDB, DedupCandidate, MemoryRow } from "./db";
import type { EmbeddingModel } from "./embeddings";
import { predictionVerb } from "./prompts";
import { resolveOpencodeDbPath, SessionDB, partToTimelineEntry, partToFullJson, messageToFullJson } from "./session-db";

// Near-duplicate thresholds for matcher/prediction/behavior dedup at
// creation time. Matches the thatch_find_duplicates threshold (0.85).
const MATCHER_DEDUP_COSINE = 0.85;
const PREDICTION_DEDUP_COSINE = 0.85;
const BEHAVIOR_DEDUP_COSINE = 0.85;

// Minimum matcher cosine to consider a prediction relevant. Matches the
// auto-fire threshold in index.ts (PREDICTION_THRESHOLD). The query tool
// should not return predictions from near-zero-similarity matchers that
// would never fire in the auto-fire.
const PREDICTION_QUERY_THRESHOLD = 0.60;

/**
 * Shared context passed to every tool's execute function. Framework-agnostic -
 * neither opencode nor MCP specific. The plugin wires real defaults; tests and
 * the MCP server inject whatever they need.
 */
export interface CoreContext {
  db: ThatchDB;
  model: EmbeddingModel;
  defaultStore: string;
  /** Peeks the extraction buffer for a session and returns the serialized
   *  JSON payload (same shape as buildExtractionPayload). Returns null when
   *  no interactions are queued. Used by the get_extraction_payload tool so
   *  the sub-agent fetches the payload as a tool response instead of
   *  receiving it inline in the nudge text. */
  extractionPayloadProvider?: (sessionID: string) => string | null;
  /** Drains a session's extraction queue. On the MCP path this deletes the
   *  file-backed queue and resets the missed-nudge counter. On the opencode
   *  path this is unused (the tool.execute.after hook handles drain via
   *  childToParent). Called by extraction_done when the sub-agent passes
   *  the parent's session_id. */
  drainExtractionQueue?: (sessionID: string) => void;
}

/**
 * Per-call host context identifying the session a tool call belongs to.
 * opencode's plugin system supplies it on every tool execution; MCP servers
 * have no session concept and omit it. Only tools that need session identity
 * consume it - the rest ignore the third execute parameter.
 */
export interface HostToolContext {
  sessionID: string;
  agent: string;
}

/**
 * A tool definition - the single source of truth shared by the opencode plugin
 * wrapper (tools.ts) and the MCP server (mcp.ts). The `args` field is a ZodRawShape
 * (a plain object of Zod types), which opencode's `tool()` accepts directly and
 * the MCP server wraps in `z.object()` for validation and `z.toJSONSchema()` for
 * the protocol response.
 */
export interface ToolDef {
  name: string;
  description: string;
  args: Record<string, z.ZodType>;
  execute(args: Record<string, unknown>, ctx: CoreContext, host?: HostToolContext): Promise<string>;
  /**
   * When true, the tool exists only on the opencode plugin path and the MCP
   * server filters it out of tools/list. Used for tools that depend on host
   * capabilities MCP hosts lack (e.g. session identity).
   */
  opencodeOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Formatting helpers - shared by all tools that render entries
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
  meta += ` created:${entry.created_at} updated:${entry.updated_at}`;
  parts.push(meta, "", entry.content);
  return parts.join("\n");
}

function formatRecallResult(entry: MemoryRow & { _score: number }): string {
  let meta = `store:${entry.store}`;
  if (entry.branch) meta += ` branch:${entry.branch}`;
  if (entry.confidence) meta += ` confidence:${entry.confidence}`;
  if (entry.archived) meta += " archived:true";
  meta += ` updated:${entry.updated_at}`;
  const score = entry._score.toFixed(3);
  return `[${meta}] [score:${score}]\n${entry.content}`;
}

/**
 * Groups candidate pairs into connected components over the similarity graph,
 * so a topic fragmented across N entries reads as one cluster instead of
 * O(N²) pairs. Verdicts stay pairwise (markChecked) - this is presentation only.
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
      "Short descriptive title. Used for deduplication - same label in the same store is the same entry.",
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
      "When updating an already-archived memory, this param is REQUIRED - " +
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
      "Include archived memories in results. Default false - archived memories are excluded.",
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
    "are grouped into clusters - a cluster of three or more usually means " +
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
 * Fetches the queued extraction payload for a session. The sub-agent calls
 * this with the parent's session ID to retrieve the tool interactions that
 * need fact extraction, instead of receiving them inline in the nudge text.
 * This keeps the full payload out of the main session's context window.
 */
const getExtractionPayloadDef: ToolDef = {
  name: "get_extraction_payload",
  description:
    "Retrieve the queued tool interactions for extraction. Call this with " +
    "the session_id from the extraction nudge to get the JSON payload " +
    "(interactions, projectStore, globalStore). Then run the " +
    "thatch-fact-extractor skill on the returned payload.",
  args: {
    session_id: z.string().describe(
      "The session ID from the extraction nudge. This is the parent session " +
      "whose tool interactions are queued for extraction.",
    ),
  },
  async execute(args, ctx) {
    if (!ctx.extractionPayloadProvider) {
      return "Extraction payload retrieval is not available in this host.";
    }
    const payload = ctx.extractionPayloadProvider(args.session_id as string);
    if (!payload) {
      return "No queued tool interactions found for this session.";
    }
    return payload;
  },
};

/**
 * Extraction-buffer acknowledgment, with AMQP-style accept/complete roles.
 *
 * Called in a PARENT session after dispatching the fact-extractor, it accepts
 * the buffer: entries move to a holding area and the nudge quiets, but they
 * are not dropped until the extractor completes. Called in a CHILD extractor
 * at the end of its run, it completes the parent's accepted entries -
 * including no-save runs that write no memory. If the child errors or is
 * deleted before either signal, the host requeues the entries so the facts
 * are not lost.
 *
 * The actual state changes happen in the host's post-tool hook
 * (tool.execute.after for opencode, PostToolBatch/appendBatch for MCP) -
 * this tool's execute function is a no-op confirmation. The tool exists so
 * the model has a recognizable tool name to key on. In the MCP path the
 * file-backed queue is consumed on this call (or on any memory_remember),
 * which is durable across interruption because the queue persists on disk
 * until then.
 *
 * The optional session_id parameter lets a sub-agent drain the PARENT's
 * file-backed queue on the MCP path, where the sub-agent's session ID
 * differs from the parent's and appendBatch's self-detection would drain
 * the wrong (empty) queue.
 */
const extractionDoneDef: ToolDef = {
  name: "extraction_done",
  description:
    "Acknowledge extraction-buffer work. In a parent session, call after " +
    "dispatching the fact-extractor to a sub-agent: accepts the buffer " +
    "(quiets the nudge) while keeping entries until the extractor completes. " +
    "In the fact-extractor sub-agent, call at the end of the run to mark the " +
    "entries complete, even when nothing was worth saving. Pass session_id " +
    "when running as a sub-agent to drain the parent session's queue.",
  args: {
    session_id: z.string().optional().describe(
      "The parent session's ID, when called from a sub-agent on the MCP " +
      "path. Drains the parent's file-backed queue. Omit when called from " +
      "the parent session itself (opencode path handles drain via hooks).",
    ),
  },
  async execute(args, ctx) {
    const sessionID = args.session_id as string | undefined;
    if (sessionID && ctx.drainExtractionQueue) {
      ctx.drainExtractionQueue(sessionID);
    }
    return "[acknowledged]";
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
      const verb = predictionVerb(s.evidence_count);
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
      // provenance, but do NOT adjust confidence - "create" is
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

// ---------------------------------------------------------------------------
// Behavior engine: LLM self-discipline rules with ham/spam feedback
// ---------------------------------------------------------------------------

const behaviorCodifyDef: ToolDef = {
  name: "behavior_codify",
  description:
    "Codify a self-discipline rule: when situation X arises, you should " +
    "do Y. Use when you recognize a situation you should react to in a " +
    "specific, repeatable way that is NOT a user preference (use " +
    "prediction_update for those). The rule is about your own operational " +
    "discipline, not what the user wants. Examples: check the whole " +
    "codebase for a library before importing it; investigate disabled " +
    "tests before touching the area; read a large function fully before " +
    "editing it.",
  args: {
    situation: z.string().describe(
      "Description of the situation that triggers this behavior. What context " +
      "or task type makes this rule apply?",
    ),
    behavior: z.string().describe(
      "The behavioral rule. What should you do when this situation arises?",
    ),
    rationale: z.string().describe(
      "Why you are codifying this rule. What happened that made you realize " +
      "this behavior is worth persisting?",
    ),
    store: z.string().optional().describe(
      "Store to write to. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const situationText = args.situation as string;
    const behaviorText = args.behavior as string;
    const rationale = args.rationale as string;

    const matcherEmbed = await ctx.model.passageEmbed(situationText);
    const behaviorEmbed = await ctx.model.passageEmbed(behaviorText);

    return ctx.db.transaction(() => {
      let matcherId = ctx.db.findNearestBehaviorMatcher(store, matcherEmbed, BEHAVIOR_DEDUP_COSINE)?.id;
      if (!matcherId) matcherId = ctx.db.createBehaviorMatcher(store, situationText, matcherEmbed, ctx.model.name);

      let behaviorId = ctx.db.findNearestBehavior(store, behaviorEmbed, BEHAVIOR_DEDUP_COSINE)?.id;
      if (!behaviorId) {
        behaviorId = ctx.db.createBehavior(store, behaviorText, rationale, behaviorEmbed, ctx.model.name);
        ctx.db.createBehaviorEdge(matcherId, behaviorId, 1.0);
        ctx.db.addBehaviorProvenance(behaviorId, "codify", rationale);
        return `[codified] ${store} :: "${behaviorText}" for "${situationText}"`;
      }

      ctx.db.createBehaviorEdge(matcherId, behaviorId, 1.0);
      ctx.db.addBehaviorProvenance(behaviorId, "codify", rationale);
      const existing = ctx.db.getBehavior(behaviorId);
      return `[linked] "${existing?.statement ?? behaviorText}" for "${situationText}" confidence=${(existing?.confidence ?? 0).toFixed(2)} (${existing?.confirm_count ?? 0}/${existing?.disconfirm_count ?? 0})`;
    });
  },
};

const behaviorFeedbackDef: ToolDef = {
  name: "behavior_feedback",
  description:
    "Record ham/spam feedback on a surfaced behavior. When the behavior " +
    "nudge surfaces rules and you evaluate each against the current " +
    "situation, call this with relevant: true (ham) if the rule applies, " +
    "or relevant: false (spam) if it does not. This trains the classifier " +
    "so future nudges are more accurate. Also use when the user corrects " +
    "your behavior and you realize a codified rule led you astray or " +
    "should have been followed.",
  args: {
    behavior: z.string().describe(
      "The behavior statement to provide feedback on. Use behavior_list " +
      "to find the exact text; matching is semantic (cosine >= 0.85).",
    ),
    relevant: z.boolean().describe(
      "true (ham) if the behavior is relevant to the current situation. " +
      "false (spam) if it is not relevant.",
    ),
    context: z.string().describe(
      "Brief description of the current situation, so the feedback is " +
      "auditable in provenance.",
    ),
    store: z.string().optional().describe(
      "Store to search. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const behaviorText = args.behavior as string;
    const relevant = args.relevant as boolean;
    const contextText = args.context as string;

    const behaviorEmbed = await ctx.model.passageEmbed(behaviorText);
    const behavior = ctx.db.findNearestBehavior(store, behaviorEmbed, BEHAVIOR_DEDUP_COSINE);
    if (!behavior) return `No behavior matching "${behaviorText}" found in "${store}".`;

    const signal = relevant ? "confirm" : "disconfirm";
    ctx.db.transaction(() => {
      ctx.db.adjustBehaviorConfidence(behavior.id, signal);
      ctx.db.addBehaviorProvenance(behavior.id, signal, `${relevant ? "ham" : "spam"}: ${contextText}`);
    });
    const updated = ctx.db.getBehavior(behavior.id);
    return `[${signal}] "${updated?.statement ?? behaviorText}" confidence=${(updated?.confidence ?? 0).toFixed(2)} (${updated?.confirm_count ?? 0}/${updated?.disconfirm_count ?? 0})`;
  },
};

const behaviorListDef: ToolDef = {
  name: "behavior_list",
  description:
    "List all codified behaviors with their matchers, confidence, and " +
    "evidence count. For inspection and debugging.",
  args: {
    store: z.string().optional().describe(
      "Which store to list. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const behaviors = ctx.db.listBehaviors(store);
    if (behaviors.length === 0) return `No behaviors in "${store}".`;
    return behaviors.map((b) => {
      const matchers = b.matchers.map((m) => `    - "${m.description}" (w:${m.weight})`).join("\n");
      const provenance = ctx.db.getBehaviorProvenance(b.id);
      const provLines = provenance.map((pr) => `    - [${pr.created_at.slice(0, 10)}] ${pr.signal}: ${pr.detail ?? ""}`).join("\n");
      return `[${b.confidence.toFixed(2)} conf, ${b.evidence_count} tests] ${b.statement}` +
        (b.rationale ? `\n  rationale: ${b.rationale}` : "") +
        (matchers ? `\n  matchers:\n${matchers}` : "") +
        (provLines ? `\n  provenance:\n${provLines}` : "");
    }).join("\n\n");
  },
};

const behaviorDeleteDef: ToolDef = {
  name: "behavior_delete",
  description:
    "Delete a codified behavior. Useful when a behavior was created in " +
    "error or is no longer relevant. Edges and provenance are deleted " +
    "automatically (cascade).",
  args: {
    statement: z.string().describe(
      "The behavior statement to delete. Use behavior_list to find the " +
      "exact text; matching is semantic (cosine >= 0.85).",
    ),
    store: z.string().optional().describe(
      "Store to delete from. Defaults to the project store.",
    ),
  },
  async execute(args, ctx) {
    const store = (args.store as string) || ctx.defaultStore;
    const statementText = args.statement as string;
    const behaviorEmbed = await ctx.model.passageEmbed(statementText);
    const behavior = ctx.db.findNearestBehavior(store, behaviorEmbed, BEHAVIOR_DEDUP_COSINE);
    if (!behavior) return `No behavior matching "${statementText}" found in "${store}".`;
    const deleted = ctx.db.deleteBehavior(behavior.id);
    if (!deleted) return `Failed to delete behavior "${behavior.statement}".`;
    return `[deleted] "${behavior.statement}" from "${store}"`;
  },
};

/**
 * Reports the calling session's identity. opencode does not surface its
 * session ID to the model, so the model cannot learn it any other way -
 * yet it needs the ID to call thatch_get_extraction_payload /
 * thatch_extraction_done on the parent's behalf and for session
 * archaeology against opencode.db. MCP hosts have no session concept,
 * hence opencodeOnly.
 */
const getSessionInfoDef: ToolDef = {
  name: "get_session_info",
  description:
    "Return the current session's identity: the host session ID and the " +
    "agent name running this turn (e.g. build, plan, or a sub-agent type). " +
    "opencode-only: MCP hosts have no session concept. Use the session ID " +
    "when a nudge tells you to call a tool with the parent's session_id, " +
    "or to query past sessions in ~/.local/share/opencode/opencode.db.",
  args: {},
  opencodeOnly: true,
  async execute(_args, _ctx, host) {
    if (!host) {
      return "Session identity is unavailable: this host did not provide a session context.";
    }
    return `sessionID: ${host.sessionID}\nagent: ${host.agent}`;
  },
};

/**
 * Lets the model search its own past opencode conversations. The model only
 * knows the current session id (via get_session_info); everything before
 * compaction or in earlier sessions is invisible to it otherwise. Returns
 * the same JSONL timeline shape as `thatch session search`, with previews
 * truncated so a result set stays context-affordable; session_get fetches
 * full content for interesting hits.
 */
const sessionSearchDef: ToolDef = {
  name: "session_search",
  description:
    "Search past opencode session conversations by substring (or regex with " +
    "regex: true). Matches decoded message text, tool outputs, and reasoning " +
    "across all sessions (or one session with session_id). Returns JSONL " +
    "entries with ids for follow-up: call session_get with a hit's part_id " +
    "or msg_id to retrieve the full content. opencode-only.",
  args: {
    query: z.string().describe(
      "Substring to find (case-insensitive), or a regular expression when regex is true.",
    ),
    regex: z.boolean().optional().describe(
      "Treat query as a regular expression instead of a plain substring.",
    ),
    session_id: z.string().optional().describe(
      "Narrow the search to one session. Omit to search all sessions.",
    ),
    limit: z.number().optional().describe(
      "Maximum matches to return (default 200, oldest first).",
    ),
  },
  opencodeOnly: true,
  async execute(args) {
    const dbPath = resolveOpencodeDbPath();
    if (!dbPath) {
      return "Session search is unavailable: no opencode database was found (set OPENCODE_DB to point at one).";
    }
    const db = new SessionDB(dbPath);
    try {
      const matches = db.search(args.query as string, {
        regex: args.regex === true,
        sessionID: args.session_id as string | undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      if (matches.length === 0) return `No matches for "${args.query}".`;
      // Session titles orient cross-session results the same way the CLI
      // search does; cached because matches cluster by session.
      const titles = new Map<string, string | null>();
      return matches
        .map((part) => {
          if (!titles.has(part.sessionId)) {
            titles.set(part.sessionId, db.getSession(part.sessionId)?.title ?? null);
          }
          return JSON.stringify({
            session_id: part.sessionId,
            session_title: titles.get(part.sessionId),
            ...partToTimelineEntry(part),
          });
        })
        .join("\n");
    } finally {
      db.close();
    }
  },
};

/**
 * Fetches the full, untruncated content of one part or message found via
 * session_search. Tool parts carry their complete args and output - the
 * detail the timeline preview truncates.
 */
const sessionGetDef: ToolDef = {
  name: "session_get",
  description:
    "Retrieve the full content of one conversation item by id. Pass a " +
    "part_id (from session_search or session list) for one content piece, " +
    "or a msg_id for an entire message with all of its parts. Tool parts " +
    "include their complete input arguments and output. opencode-only.",
  args: {
    id: z.string().describe(
      "A part id (prt_...) or message id (msg_...) from session_search results.",
    ),
  },
  opencodeOnly: true,
  async execute(args) {
    const dbPath = resolveOpencodeDbPath();
    if (!dbPath) {
      return "Session retrieval is unavailable: no opencode database was found (set OPENCODE_DB to point at one).";
    }
    const db = new SessionDB(dbPath);
    try {
      const id = args.id as string;
      if (id.startsWith("msg_")) {
        const message = db.getMessage(id);
        if (!message) return `No message "${id}" found.`;
        return JSON.stringify(messageToFullJson(message), null, 2);
      }
      const part = db.getPart(id);
      if (!part) return `No part "${id}" found.`;
      return JSON.stringify(partToFullJson(part), null, 2);
    } finally {
      db.close();
    }
  },
};

/**
 * All tool definitions, in the order they should be presented to the agent.
 * The opencode plugin wraps each in `tool()`; the MCP server exposes the
 * non-opencodeOnly ones via `tools/list` and dispatches `tools/call` to
 * their execute functions.
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
  getExtractionPayloadDef,
  predictionQueryDef,
  predictionUpdateDef,
  predictionListDef,
  predictionDeleteDef,
  behaviorCodifyDef,
  behaviorFeedbackDef,
  behaviorListDef,
  behaviorDeleteDef,
  getSessionInfoDef,
  sessionSearchDef,
  sessionGetDef,
];
