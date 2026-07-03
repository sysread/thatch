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
import { FACT_EXTRACTOR_PROMPT, ExtractionPipeline } from "./extraction";

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
  const pipeline = new ExtractionPipeline();

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
          pipeline.push({
            tool: (event.properties as any)?.tool ?? "unknown",
            sessionID: (event.properties as any)?.sessionID ?? "",
            args: (event.properties as any)?.args ?? {},
            title: (event.properties as any)?.title ?? "",
            output: (event.properties as any)?.output ?? "",
          });
          return;
        }

        case "session.idle": {
          if (!pipeline.pending) return;
          const sessionID = (event.properties as any)?.id;
          if (!sessionID) return;
          await runExtraction(client as any, db, model, pipeline, repo, sessionID);
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
  let childID: string | undefined;

  try {
    const created: any = await client.session.create({
      parentID: sessionID,
      title: "thatch extraction",
    });
    childID = created.data?.id ?? (created as any).id;
    if (!childID) return;

    const result: any = await client.session.prompt({
      path: { id: childID },
      body: {
        agent: "thatch-fact-extractor",
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
    if (json?.actions?.length) {
      const results = await pipeline.applyActions(db, model, json);
      for (const r of results) {
        try {
          await client.app.log({
            body: { service: "thatch", level: "info", message: r },
          });
        } catch {
          // log fail is fine
        }
      }
    }
  } catch {
    // Extraction is best-effort — never break the user's session
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
  // Try to find a JSON object in the response
  const m = text.match(/\{[\s\S]*"actions"[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

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
