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
import { DedupPipeline } from "./dedup";

// ---------------------------------------------------------------------------
// V1 server export — tools, prompt injection, session hooks
// ---------------------------------------------------------------------------

export const server: Plugin = async ({ client }) => {
  const repo = await detectRepo();
  const home = process.env.HOME ?? "/tmp";
  const dbPath = process.env.THATCH_DB_PATH ?? join(home, ".config", "thatch", "thatch.db");
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  const db = new ThatchDB(dbPath);
  const model = new BgeEmbeddingModel(modelName);
  const extraction = new ExtractionPipeline();
  const dedup = new DedupPipeline();

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

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(sys);
    },

    "experimental.session.compacting": async (_input, output) => {
      output.context.push(compact);
    },

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

        case "session.idle": {
          const sessionID = (event.properties as any)?.id;
          if (!sessionID) return;

          if (extraction.pending) {
            await runExtraction(client as any, db, model, extraction, repo, sessionID);
          }

          await runDedup(client as any, db, model, dedup, repo, sessionID);
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

// ---------------------------------------------------------------------------
// Extraction — background subagent session
// ---------------------------------------------------------------------------

async function runExtraction(
  client: any,
  db: ThatchDB,
  model: BgeEmbeddingModel,
  pipeline: ExtractionPipeline,
  projectStore: string,
  sessionID: string,
): Promise<void> {
  const interactions = pipeline.flush();
  if (interactions.length === 0) return;

  const payload = pipeline.buildPayload(interactions, projectStore);
  await runSubagent(client, db, model, "thatch-fact-extractor", payload,
    (json) => pipeline.applyActions(db, model, json),
    sessionID, "extraction");
}

// ---------------------------------------------------------------------------
// Deduplication — background subagent session
// ---------------------------------------------------------------------------

async function runDedup(
  client: any,
  db: ThatchDB,
  model: BgeEmbeddingModel,
  dedup: DedupPipeline,
  projectStore: string,
  sessionID: string,
): Promise<void> {
  const threshold = parseFloat(process.env.THATCH_DEDUP_THRESHOLD ?? "0.80");
  const candidates = dedup.findCandidates(db, [projectStore, "global"], threshold);
  if (candidates.length === 0) return;

  // Process up to 3 candidates per idle cycle.
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const payload = dedup.buildPayload(candidate);
      await runSubagent(client, db, model, "thatch-dedup-classifier", payload,
        async (json: any) => {
          const classification = json as import("./dedup").DedupClassification;
          const result = await dedup.applyClassification(db, model, candidate.store, candidate, classification);
          db.markPairChecked(candidate.store, candidate.slugA, candidate.slugB, classification.relationship);

          try {
            await client.app.log({
              body: { service: "thatch", level: "info", message: result },
            });
          } catch { /* ok */ }
        },
        sessionID, "dedup");
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Shared subagent runner
// ---------------------------------------------------------------------------

async function runSubagent(
  client: any,
  _db: ThatchDB,
  _model: BgeEmbeddingModel,
  agent: string,
  payload: string,
  apply: (json: any) => Promise<any>,
  parentSessionID: string,
  label: string,
): Promise<void> {
  let childID: string | undefined;

  try {
    const created: any = await client.session.create({
      parentID: parentSessionID,
      title: `thatch ${label}`,
    });
    childID = created.data?.id ?? (created as any).id;
    if (!childID) return;

    const result: any = await client.session.prompt({
      path: { id: childID },
      body: {
        agent,
        parts: [{ type: "text", text: payload }],
      },
    });

    const body = result.data ?? result;
    const parts = body.parts ?? [];
    const text = parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");

    const json = extractJson(text);
    if (json) {
      await apply(json);
    }
  } catch {
    // background work is best-effort
  } finally {
    if (childID) {
      try {
        await client.session.delete({ path: { id: childID } });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function extractJson(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
