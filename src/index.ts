import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { ThatchDB } from "./db";
import { BgeEmbeddingModel } from "./embeddings";
import { detectRepo } from "./git";
import { createTools } from "./tools";
import {
  systemPrompt,
  compactionContext,
  sessionStartReminder,
  recallNudge,
  extractionNudge,
  type NudgeMatch,
} from "./prompts";
import { ExtractionPipeline } from "./extraction";
import { installSkills, SHARED_SKILLS, OPENCODE_ONLY_SKILLS } from "./skills";
import { hygieneReport } from "./hygiene";

// ---------------------------------------------------------------------------
// V1 server export — tools, prompt injection, session hooks
// ---------------------------------------------------------------------------

// Minimum cosine score for the prompt-aware recall nudge. Lower than
// findDuplicates' 0.85 (near-dupes) because "relates to" is a weaker signal
// than "duplicate." Tunable via THATCH_RECALL_THRESHOLD.
const RECALL_THRESHOLD = parseFloat(process.env.THATCH_RECALL_THRESHOLD ?? "0.55");

// Prompts shorter than this skip the recall nudge — trivially short prompts
// like "yes" or "ok" match too broadly to be useful.
const MIN_PROMPT_LEN = 10;

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

  // Sessions currently being compacted. chat.message nudges are skipped while
  // a session is in this set — the agent can't call tools during summary
  // generation, so a recall or extraction nudge would cause a blocked-tool
  // error. Cleared by experimental.compaction.autocontinue. If compaction
  // fails, the entry leaks (graceful degradation: nudges stay off for that
  // session, but no crash).
  const compacting = new Set<string>();

  // Per-session count of consecutive extraction nudges delivered without any
  // memory_remember call in between. Drives nudge escalation: the agent gets
  // a couple of polite chances, then the tone shifts to directive, then to
  // all-caps shouting. Reset to 0 whenever the agent writes a memory.
  const missedNudges = new Map<string, number>();

  // Skills always install to the global opencode config — installing into the
  // worktree would mutate the user's repo (untracked files in git status).
  // A failed install degrades the nudge workflow but must not kill the plugin.
  try {
    installSkills(join(configHome, "opencode", "skills"), [
      ...SHARED_SKILLS,
      ...OPENCODE_ONLY_SKILLS,
    ]);
  } catch (err) {
    console.error(`[thatch] skill install failed: ${err}`);
  }

  const sys = systemPrompt(repo);
  const compact = compactionContext(repo);

  return {
    tool: createTools(db, model, repo),

    // 1. System prompt — always in context.
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(sys);
    },

    // 2. Compaction context — re-familiarizes after compaction. The flag
    //    suppresses chat.message nudges during summary generation (tool
    //    calls are blocked there).
    "experimental.session.compacting": async (input, output) => {
      compacting.add(input.sessionID);
      output.context.push(compact);
    },

    // 2b. Clear the compacting flag after compaction succeeds so chat.message
    //     nudges resume for the synthetic auto-continue turn and beyond.
    "experimental.compaction.autocontinue": async (input) => {
      compacting.delete(input.sessionID);
    },

    // 3. Tool buffering — feeds the extraction nudge. Excluded tools:
    //    - thatch_*: extracting facts from memory ops would echo the store
    //    - skill/task: meta-tools that orchestrate agent behavior (loading
    //      skills, dispatching sub-agents). Buffering them creates a feedback
    //      loop — the nudge triggers a skill load, which gets buffered, which
    //      triggers another nudge on the next turn.
    //    Memory writes consume the buffer and reset the missed-nudge counter.
    //    The buffer is NOT drained on nudge delivery — it persists until the
    //    agent writes a memory, so ignored nudges accumulate and the payload
    //    grows with each missed cycle.
    "tool.execute.after": async (input, output) => {
      if (input.tool === "thatch_memory_remember") {
        extraction.consume(input.sessionID);
        missedNudges.delete(input.sessionID);
        return;
      }
      if (input.tool.startsWith("thatch_") || input.tool === "skill" || input.tool === "task") return;
      extraction.push({
        tool: input.tool,
        sessionID: input.sessionID,
        args: input.args ?? {},
        title: output.title,
        output: typeof output.output === "string" ? output.output : "",
      });
    },

    // 4. Per-message nudge — two priority tiers:
    //   a. Extraction nudge: prior tool interactions are queued for fact
    //      extraction (carries the JSON payload for thatch-fact-extractor).
    //   b. Recall nudge: the user's prompt semantically matches existing
    //      memories — surface that prior knowledge exists before the agent
    //      responds. Uses the in-process warm model (no sideband needed).
    //
    // Skipped during compaction: the agent can't call tools while generating
    // a summary, so a nudge that says "use thatch_memory_recall" triggers a
    // blocked-tool error.
    "chat.message": async (input, output) => {
      if (compacting.has(input.sessionID)) return;
      if (extraction.pending(input.sessionID)) {
        const batch = extraction.peek(input.sessionID);
        const payload = extraction.buildPayload(batch, repo);
        const missed = missedNudges.get(input.sessionID) ?? 0;
        const text = extractionNudge(batch.length, missed, "thatch_memory_remember", payload);
        missedNudges.set(input.sessionID, missed + 1);

        output.parts.push({
          id: `prt_thatch_${Math.random().toString(36).slice(2)}`,
          sessionID: input.sessionID,
          messageID: input.messageID ?? output.message.id,
          type: "text",
          text,
          synthetic: true,
        });
        return;
      }

      // No extraction pending — try the prompt-aware recall nudge. Extract
      // the user's prompt text from the message parts, embed it with the
      // warm in-process model, and search for matches. Best-effort: any
      // failure (no text, model not loaded, empty store) silently skips.
      try {
        const promptText = (output.parts as any[])
          .filter((p) => p.type === "text" && !p.synthetic)
          .map((p) => p.text)
          .join(" ");
        if (promptText.length < MIN_PROMPT_LEN) return;

        const embedding = await model.queryEmbed(promptText);
        const results = db.search([repo, "global"], embedding, { limit: 5 });
        const matches: NudgeMatch[] = results
          .filter((r) => r._score >= RECALL_THRESHOLD)
          .map((r) => ({ label: r.label, score: Math.round(r._score * 1000) / 1000 }));

        if (matches.length === 0) return;

        output.parts.push({
          id: `prt_thatch_${Math.random().toString(36).slice(2)}`,
          sessionID: input.sessionID,
          messageID: input.messageID ?? output.message.id,
          type: "text",
          text: recallNudge(matches),
          synthetic: true,
        });
      } catch (err) {
        console.error(`[thatch] recall nudge failed: ${err}`);
      }
    },

    // 5. Session-start reminder, carrying the hygiene heartbeat. Hygiene is
    // best-effort: a failure there must not cost the reminder itself.
    event: async ({ event }) => {
      if (event.type !== "session.created") return;
      const id = event.properties.info.id;

      let hygiene: string | null = null;
      try {
        hygiene = await hygieneReport(db, repo, worktree);
      } catch (err) {
        console.error(`[thatch] hygiene report failed: ${err}`);
      }

      try {
        await client.session.prompt({
          path: { id },
          body: {
            noReply: true,
            parts: [{ type: "text", text: sessionStartReminder(repo, hygiene) }],
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

export { hygieneReport } from "./hygiene";
