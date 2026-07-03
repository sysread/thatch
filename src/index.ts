import { join } from "node:path";
import { existsSync } from "node:fs";
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
import { DedupPipeline } from "./dedup";
import { installSkills } from "./skills";

// ---------------------------------------------------------------------------
// V1 server export — tools, prompt injection, session hooks
// ---------------------------------------------------------------------------

export const server: Plugin = async ({ client, worktree }) => {
  const repo = await detectRepo();
  const home = process.env.HOME ?? "/tmp";
  const dbPath = process.env.THATCH_DB_PATH ?? join(home, ".config", "thatch", "thatch.db");
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  const db = new ThatchDB(dbPath);
  const model = new BgeEmbeddingModel(modelName);
  const extraction = new ExtractionPipeline();
  const dedup = new DedupPipeline();

  // Install skill files matching the plugin's installation scope.
  // Project-local install → project skills dir. Global install → global skills dir.
  const projectSkillsDir = join(worktree, ".opencode", "skills");
  const globalSkillsDir = join(home, ".config", "opencode", "skills");
  const projectPluginsDir = join(worktree, ".opencode", "plugins");
  const skillsDir = existsSync(projectPluginsDir) ? projectSkillsDir : globalSkillsDir;
  installSkills(skillsDir);

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
    },

    // 1. System prompt — always in context.
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(sys);
    },

    // 2. Compaction context — re-familiarizes after compaction.
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(compact);
    },

    // 3. Per-message nudges — lightweight reminders on each user message.
    "chat.message": async (_input, output) => {
      const nudges: string[] = [];

      if (extraction.pending) {
        nudges.push(
          `[thatch] ${extraction.bufferSize} recent tool interactions are available for fact extraction. ` +
          `Use the skill tool to load thatch-fact-extractor, review the queued interactions, ` +
          `then use thatch_memory_remember to save any new durable facts.`,
        );
        extraction.flush();
      }

      if (nudges.length > 0) {
        output.parts.unshift({ type: "text", text: nudges.join("\n") } as any);
      }
    },

    // 4. Events — startup reminders and tool buffering.
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
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
            // fail silently
          }
          return;
        }

        case "tool.execute.after": {
          extraction.push({
            tool: (event.properties as any)?.tool ?? "unknown",
            sessionID: (event.properties as any)?.sessionID ?? "",
            args: (event.properties as any)?.args ?? {},
            title: (event.properties as any)?.title ?? "",
            output: (event.properties as any)?.output ?? "",
          });
          return;
        }
      }
    },

    dispose: async () => {
      db.close();
    },
  };
};

// ---------------------------------------------------------------------------
// thatch_find_duplicates tool
// ---------------------------------------------------------------------------

function createFindDuplicatesTool(db: ThatchDB, defaultStore: string) {
  return tool({
    description:
      "Find memories with unusually similar content that may be candidates " +
      "for consolidation. Uses cosine similarity on embeddings.",
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
