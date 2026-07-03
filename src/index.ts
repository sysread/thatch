import { homedir } from "node:os";
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
} from "./tools";

/**
 * Thatch opencode plugin — persistent memory with local embeddings.
 *
 * On startup, detects the current repo identity (owner/repo from git remote)
 * and opens (or creates) a SQLite database at ~/.config/thatch/thatch.db.
 * The embedding model (bge-small-en-v1.5) is lazy-loaded on first use.
 */
export const server: Plugin = async () => {
  const repo = await detectRepo();
  const dbPath = process.env.THATCH_DB_PATH ?? join(homedir(), ".config", "thatch", "thatch.db");
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  const db = new ThatchDB(dbPath);
  const model = new BgeEmbeddingModel(modelName);

  return {
    tool: {
      thatch_memory_remember: createRememberTool(db, model, repo),
      thatch_memory_recall: createRecallTool(db, model, repo),
      thatch_memory_list: createListTool(db, repo),
      thatch_memory_show: createShowTool(db, repo),
      thatch_memory_forget: createForgetTool(db, repo),
      thatch_store_list: createListStoresTool(db),
    },
    dispose: async () => {
      db.close();
    },
  };
};
