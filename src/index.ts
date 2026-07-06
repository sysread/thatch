import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
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
  createFindDuplicatesTool,
  createMarkCheckedTool,
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
