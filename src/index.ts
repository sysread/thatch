import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { ThatchDB } from "./db";
import { BgeEmbeddingModel } from "./embeddings";
import { detectRepo } from "./git";
import {
  createRememberTool,
  createRecallTool,
  createListTool,
  createShowTool,
  createForgetTool,
  createListStoresTool,
} from "./tools";
import {
  systemPrompt,
  compactionContext,
  sessionStartReminder,
} from "./prompts";
import { ExtractionPipeline } from "./extraction";
import { installSkills } from "./skills";

// ---------------------------------------------------------------------------
// V1 server export — tools, prompt injection, session hooks
// ---------------------------------------------------------------------------

export const server: Plugin = async ({ client, worktree }) => {
  // The opencode server's cwd is wherever the server happened to start;
  // `worktree` is the project this plugin instance actually serves.
  const repo = await detectRepo(worktree);
  const home = process.env.HOME ?? "/tmp";
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const dbPath = process.env.THATCH_DB_PATH ?? join(configHome, "thatch", "thatch.db");
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  const db = new ThatchDB(dbPath);
  const model = new BgeEmbeddingModel(modelName);
  const extraction = new ExtractionPipeline();

  // Skills always install to the global opencode config — installing into the
  // worktree would mutate the user's repo (untracked files in git status).
  // A failed install degrades the nudge workflow but must not kill the plugin.
  try {
    installSkills(join(configHome, "opencode", "skills"));
  } catch (err) {
    console.error(`[thatch] skill install failed: ${err}`);
  }

  const sys = systemPrompt(repo);
  const compact = compactionContext(repo);

  return {
    tool: {
      thatch_memory_remember: createRememberTool(db, model, repo),
      thatch_memory_recall: createRecallTool(db, model, repo),
      thatch_memory_list: createListTool(db, repo),
      thatch_memory_show: createShowTool(db, repo),
      thatch_memory_forget: createForgetTool(db, repo),
      thatch_store_list: createListStoresTool(db),
      thatch_find_duplicates: createFindDuplicatesTool(db, repo),
      thatch_dedup_mark_checked: createMarkCheckedTool(db, repo),
    },

    // 1. System prompt — always in context.
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(sys);
    },

    // 2. Compaction context — re-familiarizes after compaction.
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(compact);
    },

    // 3. Tool buffering — feeds the extraction nudge. Thatch's own tools are
    // excluded: extracting facts from memory operations would just echo the
    // store back into itself.
    "tool.execute.after": async (input, output) => {
      if (input.tool.startsWith("thatch_")) return;
      extraction.push({
        tool: input.tool,
        sessionID: input.sessionID,
        args: input.args ?? {},
        title: output.title,
        output: typeof output.output === "string" ? output.output : "",
      });
    },

    // 4. Per-message nudge — when interactions are queued, hand the agent the
    // actual payload; the thatch-fact-extractor skill's contract is "you will
    // be given a JSON payload", so the nudge must carry it.
    "chat.message": async (input, output) => {
      if (!extraction.pending(input.sessionID)) return;

      const batch = extraction.flush(input.sessionID);
      const payload = extraction.buildPayload(batch, repo);
      const text =
        `[thatch] ${batch.length} recent tool interactions are queued for fact extraction. ` +
        `Use the skill tool to load thatch-fact-extractor, then use thatch_memory_remember ` +
        `to save any new durable facts from this payload:\n${payload}`;

      output.parts.push({
        id: `prt_thatch_${Math.random().toString(36).slice(2)}`,
        sessionID: input.sessionID,
        messageID: input.messageID ?? output.message.id,
        type: "text",
        text,
        synthetic: true,
      });
    },

    // 5. Session-start reminder.
    event: async ({ event }) => {
      if (event.type !== "session.created") return;
      const id = event.properties.info.id;
      try {
        await client.session.prompt({
          path: { id },
          body: {
            noReply: true,
            parts: [{ type: "text", text: sessionStartReminder(repo) }],
          },
        });
      } catch (err) {
        console.error(`[thatch] session-start reminder failed: ${err}`);
      }
    },

    dispose: async () => {
      db.close();
    },
  };
};

// ---------------------------------------------------------------------------
// Dedup tools — thatch_find_duplicates surfaces candidate pairs; the agent
// classifies them (thatch-dedup-classifier skill), applies changes through the
// ordinary memory tools, and records the verdict with thatch_dedup_mark_checked
// so settled pairs stop being re-reported.
// ---------------------------------------------------------------------------

function createFindDuplicatesTool(db: ThatchDB, defaultStore: string) {
  return tool({
    description:
      "Find memories with unusually similar content that may be candidates " +
      "for consolidation. Uses cosine similarity on embeddings. Pairs already " +
      "reviewed via thatch_dedup_mark_checked are skipped.",
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

      return candidates
        .map((c) =>
          `[score:${c.score}] "${c.labelA}" ↔ "${c.labelB}"`,
        )
        .join("\n");
    },
  });
}

function createMarkCheckedTool(db: ThatchDB, defaultStore: string) {
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
