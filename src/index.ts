import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { define } from "@opencode-ai/plugin/v2/promise";
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
import { FACT_EXTRACTOR_PROMPT } from "./extraction";

// ---------------------------------------------------------------------------
// V1 server export — tools, prompt injection, session hooks
// ---------------------------------------------------------------------------

export const server: Plugin = async ({ client }) => {
  const repo = await detectRepo();
  const dbPath = process.env.THATCH_DB_PATH ?? join(homedir(), ".config", "thatch", "thatch.db");
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  const db = new ThatchDB(dbPath);
  const model = new BgeEmbeddingModel(modelName);

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
    },

    // Belt-and-suspenders: inject thatch instructions at three surfaces.
    //
    // 1. System prompt — always in context, the primary reference.
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(sys);
    },

    // 2. Compaction context — re-familiarizes the agent after compaction.
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(compact);
    },

    // 3. Session startup — a no-reply reminder injected at session creation.
    event: async ({ event }) => {
      if (event.type !== "session.created") return;
      const id = (event.properties as any)?.id;
      if (!id) return;

      try {
        await client.session.prompt({
          path: { id },
          body: {
            noReply: true,
            parts: [{ type: "text", text: sessionStartReminder(repo) }],
          },
        });
      } catch {
        // fail silently — don't break the session over a reminder
      }
    },

    dispose: async () => {
      db.close();
    },
  };
};

// ---------------------------------------------------------------------------
// V2 export — registers the fact-extractor subagent
// ---------------------------------------------------------------------------

const v2 = define({
  id: "thatch",
  setup: async (ctx) => {
    await ctx.agent.transform(async (draft) => {
      draft.update("thatch-fact-extractor", (agent) => {
        agent.mode = "subagent";
        agent.hidden = true;
        agent.system = FACT_EXTRACTOR_PROMPT;
        agent.description =
          "Extracts durable project facts, user preferences, and environmental knowledge from tool interactions.";
        agent.steps = 3;
      });
    });
  },
});

export const { id, setup } = v2;
