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
  extractionDirectPrompt,
  predictionNudge,
  behaviorNudge,
  versionWarningNudge,
  type NudgeMatch,
} from "./prompts";
import { ExtractionPipeline, type ToolInteraction } from "./extraction";
import { installSkills, SHARED_SKILLS, OPENCODE_ONLY_SKILLS } from "./skills";
import { hygieneReport } from "./hygiene";
import { seedDefaultBehaviors } from "./seed-behaviors";
import { startVersionChecker, stopVersionChecker, getVersionChecker, readOnDiskVersion, compareSemver } from "./version-check";
import pkg from "../package.json";

// ---------------------------------------------------------------------------
// V1 server export - tools, prompt injection, session hooks
// ---------------------------------------------------------------------------

// Minimum cosine score for the prompt-aware recall nudge. Lower than
// findDuplicates' 0.85 (near-dupes) because "relates to" is a weaker signal
// than "duplicate." Tunable via THATCH_RECALL_THRESHOLD.
const RECALL_THRESHOLD = parseFloat(process.env.THATCH_RECALL_THRESHOLD ?? "0.55");

// Prompts shorter than this skip the recall nudge - trivially short prompts
// like "yes" or "ok" match too broadly to be useful.
const MIN_PROMPT_LEN = 10;

// Minimum cosine score for the prediction auto-fire. Higher than the
// recall nudge (0.55) because surfacing a user-preference nudge is more
// disruptive than surfacing a memory -- the agent may act on it or
// surface it to the user. 0.60 cuts noise in dense embedding spaces
// while still catching genuinely related contexts.
const PREDICTION_THRESHOLD = parseFloat(process.env.THATCH_PREDICTION_THRESHOLD ?? "0.60");

// Same threshold for behavior auto-fire. Same rationale: surfacing a
// self-discipline rule is disruptive and should only fire when the
// situation genuinely matches.
const BEHAVIOR_THRESHOLD = parseFloat(process.env.THATCH_BEHAVIOR_THRESHOLD ?? "0.60");

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

  // Seed default behaviors into the global store on first run, and
  // update them when their content changes across releases. Idempotent:
  // behaviors are matched by key stamp, not by cosine similarity, so
  // user-codified behaviors are never overwritten. See seed-behaviors.ts
  // for the full mechanism.
  await seedDefaultBehaviors(db, model);

  // Start background npm update polling. The checker caches the latest
  // version in memory and to a file. Never blocks the plugin or tool calls.
  // The opencode plugin path has no hook/server split, so version skew
  // between hooks and server is not a concern here. But two opencode
  // sessions on different versions sharing one DB can cause schema/data
  // corruption. The npm update nudge covers the "please update" case.
  // The on-disk version check (readOnDiskVersion) catches the case where
  // the user ran `npm update` but hasn't restarted opencode yet.
  startVersionChecker(dbPath);

  // The running version, frozen at module load time. Compared against the
  // on-disk package.json version on each chat.message to detect post-upgrade
  // non-restart.
  const runningVersion = pkg.version;

  // Sessions currently being compacted. chat.message nudges are skipped while
  // a session is in this set - the agent can't call tools during summary
  // generation, so a recall or extraction nudge would cause a blocked-tool
  // error. Cleared by experimental.compaction.autocontinue (success), the
  // session.compacted event (redundant belt-and-suspenders), or chat.message
  // itself when a non-compaction message arrives (compaction failure fallback
  // - autocontinue never fired, so the next real user message clears the
  // stale flag). If all three somehow miss, the flag leaks (graceful
  // degradation: nudges stay off for that session, but no crash).
  const compacting = new Set<string>();

  // Per-session count of consecutive extraction nudges delivered without any
  // memory_remember call in between. Drives nudge escalation: the agent gets
  // a couple of polite chances, then the tone shifts to directive, then to
  // all-caps shouting. Reset to 0 whenever the agent writes a memory.
  const missedNudges = new Map<string, number>();

  // Parent-child session mapping for cross-session buffer drain. opencode
  // creates real child sessions with their own IDs for sub-agents; without
  // this map, a memory_remember call in a child (e.g. a background
  // fact-extractor task) drains the child's empty buffer but leaves the
  // parent's buffer untouched, causing the nudge to replay indefinitely.
  // Populated from session.created events that carry a parentID.
  const childToParent = new Map<string, string>();

  // Snapshot of the parent's buffer at the moment each child was dispatched.
  // When the child writes a memory, consumeSnapshot drains only these entries
  // (by reference identity), preserving interleaved-turn entries that arrived
  // while the sub-agent was running. Without this, the child's memory_remember
  // would drain the parent's ENTIRE buffer - silently dropping facts from
  // any tool calls the parent made concurrently with the sub-agent.
  const parentSnapshots = new Map<string, ToolInteraction[]>();

  // Parent sessions with an active direct-extraction child. When the parent
  // goes idle with pending tool interactions, the plugin creates a child
  // session and prompts it directly (via the SDK client) instead of injecting
  // a nudge into the next user message. This set suppresses the nudge path
  // while the child runs, and prevents re-triggering if the parent goes idle
  // again before the child finishes. Cleared when the child goes idle, errors,
  // or is deleted. If direct extraction fails, the set is cleared so the nudge
  // path takes over as a fallback on the next chat.message.
  const extracting = new Set<string>();

  // Child session IDs created by triggerExtraction (direct extraction only).
  // The child idle handler uses this to distinguish plugin-created extraction
  // children from task-dispatched sub-agents (code review specialists, the
  // nudge-path fact-extractor, any model-dispatched task). Only extraction
  // children get the full cleanup: buffer drain, session deletion, toast.
  // Non-extraction children get the old behavior (completeAccepted +
  // missedNudges.reset) so their sessions are not deleted out from under the
  // task tool that dispatched them.
  const extractionChildren = new Set<string>();

  // Per-child-session extraction metrics for the toast notification. When the
  // child session goes idle, these counts are formatted into a toast that
  // shows the user thatch is working without polluting the conversation.
  // Keyed by child session ID. Cleaned up on child idle, error, or deletion.
  const childMetrics = new Map<string, { new: number; updated: number; deleted: number }>();

  // Skills always install to the global opencode config - installing into the
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

  // Direct extraction: create a child session linked to the parent and prompt
  // it with the extraction payload. The child runs the fact-extractor skill,
  // writes memories, and goes idle. The existing childToParent / snapshot
  // drain machinery handles buffer cleanup. The nudge path is a fallback if
  // this throws.
  //
  // Does NOT call extraction.accept - entries stay in pending so consumeSnapshot
  // can drain them by reference identity when the child writes a memory. The
  // extracting set (not accept) suppresses the nudge in chat.message.
  //
  // The child ID is added to extractionChildren so the idle handler can
  // distinguish plugin-created extraction children from task-dispatched
  // sub-agents. Only extraction children get the full cleanup (buffer drain,
  // session deletion, toast).
  async function triggerExtraction(parentID: string): Promise<void> {
    extracting.add(parentID);

    const batch = extraction.peek(parentID);
    const promptText = extractionDirectPrompt(batch.length, parentID);

    const result = await client.session.create({
      body: { parentID, title: "thatch-extraction" },
    });
    // session.created event fires here, setting childToParent and
    // parentSnapshots (snapshot of the full pending buffer, since we
    // have not called accept).
    const childId = result.data!.id;
    extractionChildren.add(childId);

    // Clean up the child session and all map entries if prompting fails.
    // Without this, the child exists on the server but was never prompted,
    // so it never goes idle and the maps leak.
    const cleanupChild = () => {
      extracting.delete(parentID);
      extractionChildren.delete(childId);
      childToParent.delete(childId);
      parentSnapshots.delete(childId);
      childMetrics.delete(childId);
      try { client.session.delete({ path: { id: childId } }); } catch {}
    };

    const bgEnabled =
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS === "true" ||
      process.env.OPENCODE_EXPERIMENTAL === "true";

    if (bgEnabled) {
      try {
        await client.session.promptAsync({
          path: { id: childId },
          body: {
            parts: [{ type: "text", text: promptText }],
          },
        });
      } catch (err) {
        console.error(`[thatch] extraction promptAsync failed: ${err}`);
        cleanupChild();
        throw err;
      }
    } else {
      // Fire and forget - the parent is already idle, so blocking the event
      // handler would only delay other event processing. The child runs to
      // completion and its idle event triggers cleanup.
      client.session
        .prompt({
          path: { id: childId },
          body: {
            parts: [{ type: "text", text: promptText }],
          },
        })
        .catch((err: unknown) => {
          console.error(`[thatch] extraction child failed: ${err}`);
          cleanupChild();
        });
    }
  }

  return {
    tool: createTools(db, model, repo, {
      extractionPayloadProvider: (sessionID: string): string | null => {
        const interactions = extraction.peek(sessionID);
        const accepted = extraction.peekAccepted(sessionID);
        const all = [...accepted, ...interactions];
        if (all.length === 0) return null;
        return extraction.buildPayload(all, repo);
      },
    }),

    // 1. System prompt - always in context.
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(sys);
    },

    // 2. Compaction context - re-familiarizes after compaction. The flag
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

    // 3. Tool buffering - feeds the extraction pipeline (direct extraction
    //    via SDK or nudge fallback). Excluded tools:
    //    - thatch_*: extracting facts from memory ops would echo the store
    //    - skill/task: meta-tools that orchestrate agent behavior (loading
    //      skills, dispatching sub-agents). Buffering them creates a feedback
    //      loop - extraction triggers a skill load, which gets buffered, which
    //      triggers another extraction on the next turn.
    //    Memory writes consume the buffer and reset the missed-nudge counter.
    //    The buffer is NOT drained on nudge delivery - it persists until the
    //    agent writes a memory, so ignored nudges accumulate and the payload
    //    grows with each missed cycle.
    //
    //    Buffer lifecycle is AMQP-style accept/complete, so a failed
    //    extractor does not silently drop unprocessed interactions:
    //    - thatch_extraction_done in the parent ACCEPTS the buffer: it moves
    //      to a holding area and the nudge quiets, but entries are not
    //      dropped yet.
    //    - COMPLETE drops the held entries. Signals: a memory_remember or
    //      extraction_done call in a child session of that parent (the
    //      extractor confirming it processed them), or the child going idle
    //      (a no-save run that never acks still counts as processed).
    //    - REQUEUE returns the held entries to pending. Signals: the child
    //      session errors or is deleted before completing.
    //
    //    A memory_remember call in a child session (sub-agent) also drains
    //    the parent's pending buffer - but only the entries that existed at
    //    dispatch time (the snapshot). Entries from interleaved turns survive
    //    so their facts aren't silently dropped.
    "tool.execute.after": async (input, output) => {
      if (input.tool === "thatch_memory_remember") {
        extraction.consume(input.sessionID);
        missedNudges.delete(input.sessionID);
        // Track extraction metrics for toast display. Counted for any
        // child session (both direct-extraction and nudge-path sub-agents)
        // since childToParent covers both. The toast only fires for
        // extraction children (extractionChildren set) on idle.
        const parentID = childToParent.get(input.sessionID);
        if (parentID) {
          const metrics = childMetrics.get(input.sessionID) ?? { new: 0, updated: 0, deleted: 0 };
          if (input.args?.overwrite) metrics.updated++;
          else metrics.new++;
          childMetrics.set(input.sessionID, metrics);
          // Complete the parent's accepted entries (the extractor confirmed
          // it is alive and saving) and drain the parent's snapshot entries
          // from the pending buffer. If no snapshot was recorded (unreachable
          // when childToParent has the entry, since both are set together in
          // session.created), skip the drain rather than dropping the entire
          // buffer - interleaved-turn entries that arrived while the child
          // was running must survive for the next extraction cycle.
          extraction.completeAccepted(parentID);
          const snapshot = parentSnapshots.get(input.sessionID);
          if (snapshot) {
            extraction.consumeSnapshot(parentID, snapshot);
            parentSnapshots.delete(input.sessionID);
          }
          missedNudges.delete(parentID);
        }
        return;
      }
      // thatch_extraction_done has two roles depending on the session:
      // - parent, after dispatching the fact-extractor: ACCEPT the buffer
      //   (quiet the nudge, hold the entries for completion).
      // - child extractor, at the end of its run: COMPLETE the parent's
      //   accepted entries, including no-save runs that write no memory,
      //   and drop the child's own buffer (its work is done).
      if (input.tool === "thatch_extraction_done") {
        const parentID = childToParent.get(input.sessionID);
        if (parentID) {
          extraction.completeAccepted(parentID);
          missedNudges.delete(parentID);
          extraction.consume(input.sessionID);
        } else {
          extraction.accept(input.sessionID);
        }
        missedNudges.delete(input.sessionID);
        return;
      }
      // Track memory deletions in child sessions for the toast metrics.
      // Same scoping as the remember handler above - only child sessions,
      // not the parent or manual memory writes from the user's session.
      if (input.tool === "thatch_memory_forget" && childToParent.has(input.sessionID)) {
        const metrics = childMetrics.get(input.sessionID) ?? { new: 0, updated: 0, deleted: 0 };
        metrics.deleted++;
        childMetrics.set(input.sessionID, metrics);
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

    // 4. Per-message nudge - two priority tiers:
    //   a. Extraction nudge: prior tool interactions are queued for fact
    //      extraction (carries the JSON payload for thatch-fact-extractor).
    //   b. Recall + prediction + behavior nudge: when no extraction is pending, embed
    //      the user's prompt (shared embedding for all three) and:
    //        - search memories by cosine (recall nudge)
    //        - search matchers by cosine, score predictions (prediction fire)
    //        - search behavior matchers by cosine, score behaviors (behavior fire)
    //      All three fire independently; any subset may inject.
    //      The auto-fires reuse the embedding already computed for recall,
    //      adding only cosine scans against the matchers tables.
    //      No extra model calls.
    //
    // Skipped during compaction: the agent can't call tools while generating
    // a summary, so a nudge that says "use thatch_memory_recall" triggers a
    // blocked-tool error.
    "chat.message": async (input, output) => {
      if (compacting.has(input.sessionID)) {
        // The session is marked as compacting. If this message is the
        // compaction summary generation itself (has a compaction-type part),
        // suppress nudges - tools are blocked during summary generation and a
        // nudge would cause a blocked-tool error. If it is NOT a compaction
        // message, compaction has already failed (autocontinue never fired)
        // and the user is sending a new message. Clear the stale flag and
        // proceed normally - tools are available again.
        const isCompactionMsg = (output.parts as any[]).some((p) => p.type === "compaction");
        if (isCompactionMsg) return;
        compacting.delete(input.sessionID);
      }

      // Version warning: check if the on-disk package.json version differs
      // from the running version (user upgraded but didn't restart opencode),
      // or if the npm poller found a newer version. Best-effort: any failure
      // silently skips. Injected as a synthetic part so the LLM sees it and
      // can tell the user to restart.
      try {
        const onDisk = readOnDiskVersion();
        const checker = getVersionChecker();
        const npmUpdate = checker?.getUpdateWarning() ?? null;
        const skewWarning = onDisk && compareSemver(runningVersion, onDisk) < 0
          ? `thatch was upgraded to v${onDisk} but this session is running v${runningVersion}. Restart opencode to apply the update.`
          : null;
        const warning = skewWarning ?? npmUpdate;
        if (warning) {
          output.parts.push({
            id: `prt_thatch_ver_${Math.random().toString(36).slice(2)}`,
            sessionID: input.sessionID,
            messageID: input.messageID ?? output.message.id,
            type: "text",
            text: versionWarningNudge(warning),
            synthetic: true,
          });
          try {
            const short = skewWarning
              ? `\u26A0\uFE0F thatch upgraded to v${onDisk} (running v${runningVersion})`
              : `\u26A0\uFE0F thatch v${checker?.getLatestVersion()} is available`;
            await client.tui.showToast({
              body: {
                message: short,
                variant: "warning",
                duration: 5000,
              },
            });
          } catch {
            // TUI may not be connected. Best-effort.
          }
        }
      } catch {
        // Best-effort. Version check failure must not block nudges.
      }

      // Extraction nudge (fallback path). Skipped when the extracting set
      // is active - that means a direct-extraction child session is running
      // and the plugin is handling extraction via the SDK. The nudge fires
      // here only when direct extraction was never triggered or threw.
      if (!extracting.has(input.sessionID) && extraction.pending(input.sessionID)) {
        const batch = extraction.peek(input.sessionID);
        const missed = missedNudges.get(input.sessionID) ?? 0;
        const text = extractionNudge(batch.length, missed, "thatch_memory_remember", input.sessionID);
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

      // No extraction pending - try the prompt-aware recall nudge. Extract
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

        // Recall nudge: separate try/catch so a memory-search failure
        // does not block the prediction fire (they share only the embedding).
        try {
          const results = db.search([repo, "global"], embedding, { limit: 5 });
          const matches: NudgeMatch[] = results
            .filter((r) => r._score >= RECALL_THRESHOLD)
            .map((r) => ({ label: r.label, score: Math.round(r._score * 1000) / 1000 }));

          if (matches.length > 0) {
            output.parts.push({
              id: `prt_thatch_${Math.random().toString(36).slice(2)}`,
              sessionID: input.sessionID,
              messageID: input.messageID ?? output.message.id,
              type: "text",
              text: recallNudge(matches),
              synthetic: true,
            });
            try {
              await client.tui.showToast({
                body: {
                  message: `\u{1F4AD} recalled ${matches.length} memor${matches.length === 1 ? "y" : "ies"}`,
                  variant: "info",
                  duration: 3000,
                },
              });
            } catch {
              // TUI may not be connected. Best-effort.
            }
          }
        } catch (err) {
          console.error(`[thatch] recall nudge failed: ${err}`);
        }

        // Prediction fire: independent of recall; a failure here does
        // not affect the recall nudge that may have already been pushed.
        try {
          const predItems = db.scorePredictionNudge([repo, "global"], embedding, PREDICTION_THRESHOLD);
          if (predItems.length > 0) {
            output.parts.push({
              id: `prt_thatch_${Math.random().toString(36).slice(2)}`,
              sessionID: input.sessionID,
              messageID: input.messageID ?? output.message.id,
              type: "text",
              text: predictionNudge(predItems),
              synthetic: true,
            });
            try {
              await client.tui.showToast({
                body: {
                  message: `\u{1F4AD} ${predItems.length} prediction${predItems.length === 1 ? "" : "s"} surfaced`,
                  variant: "info",
                  duration: 3000,
                },
              });
            } catch {
              // TUI may not be connected. Best-effort.
            }
          }
        } catch (err) {
          console.error(`[thatch] prediction nudge failed: ${err}`);
        }

        // Behavior fire: independent of recall and prediction. Same
        // embedding, one more cosine scan against behavior_matchers.
        try {
          const behaviorItems = db.scoreBehaviorNudge([repo, "global"], embedding, BEHAVIOR_THRESHOLD);
          if (behaviorItems.length > 0) {
            output.parts.push({
              id: `prt_thatch_${Math.random().toString(36).slice(2)}`,
              sessionID: input.sessionID,
              messageID: input.messageID ?? output.message.id,
              type: "text",
              text: behaviorNudge(behaviorItems),
              synthetic: true,
            });
            try {
              await client.tui.showToast({
                body: {
                  message: `\u{1F4AD} ${behaviorItems.length} behavior${behaviorItems.length === 1 ? "" : "s"} surfaced`,
                  variant: "info",
                  duration: 3000,
                },
              });
            } catch {
              // TUI may not be connected. Best-effort.
            }
          }
        } catch (err) {
          console.error(`[thatch] behavior nudge failed: ${err}`);
        }
      } catch (err) {
        console.error(`[thatch] nudge hook failed: ${err}`);
      }
    },

    // 5. Session-start reminder, carrying the hygiene heartbeat. Hygiene is
    //    best-effort: a failure there must not cost the reminder itself.
    //
    // Also tracks parent-child session relationships for cross-session buffer
    // drain. session.created with a parentID records the mapping AND
    // snapshots the parent's current buffer so the child's later
    // memory_remember drains only those snapshot entries, not the parent's
    // entire buffer (which may have grown from interleaved turns).
    //
    // Child lifecycle events: idle means the extractor finished; error or
    // deletion before completion means the facts were never extracted, so
    // entries go back to pending. Only extraction children (created by
    // triggerExtraction, tracked in extractionChildren) get the full cleanup
    // (buffer drain, session deletion, toast). Task-dispatched sub-agents
    // get the old behavior (completeAccepted + missedNudges.reset) so their
    // sessions are not deleted out from under the task tool.
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties.info;
        if (info.parentID) {
          childToParent.set(info.id, info.parentID);
          parentSnapshots.set(info.id, [...extraction.peek(info.parentID)]);
          // Child sessions don't need the session-start reminder - only
          // top-level sessions do. Returning here prevents extraction
          // children from receiving the hygiene report and tool overview.
          return;
        }
      }
      if (event.type === "session.error") {
        const childID = event.properties.sessionID;
        const parentID = childID ? childToParent.get(childID) : undefined;
        if (parentID && childID) {
          extraction.requeueAccepted(parentID);
          extracting.delete(parentID);
          childToParent.delete(childID);
          parentSnapshots.delete(childID);
          childMetrics.delete(childID);
          extractionChildren.delete(childID);
        }
        return;
      }
      if (event.type === "session.status" && event.properties.status?.type === "idle") {
        const sessionID = event.properties.sessionID;
        const parentID = sessionID ? childToParent.get(sessionID) : undefined;
        if (parentID && sessionID) {
          // A child session went idle. Two cases:
          // - Extraction child (created by triggerExtraction, tracked in
          //   extractionChildren): drain the parent's snapshot, fire a toast
          //   with metrics, delete the child session, clean up all maps.
          // - Task-dispatched sub-agent (code review specialist, nudge-path
          //   fact-extractor, any model-dispatched task): complete the
          //   parent's accepted entries and reset missedNudges. Do NOT drain
          //   the buffer or delete the session - the task tool that
          //   dispatched the sub-agent needs to read its output.
          if (extractionChildren.has(sessionID)) {
            // Drain the parent's snapshot entries from the pending buffer.
            // If the child wrote memories, consumeSnapshot already ran in
            // tool.execute.after and the snapshot is gone - nothing to
            // drain. If the child did a no-save run, the snapshot entries
            // are still in the buffer and need to be drained here so they
            // don't replay as a nudge on the next chat.message. Never drain
            // the entire buffer - interleaved-turn entries must survive.
            const snapshot = parentSnapshots.get(sessionID);
            if (snapshot) {
              extraction.consumeSnapshot(parentID, snapshot);
            }

            // Fire a toast with the extraction metrics. Only show a toast
            // when memories were actually written - no toast for no-save
            // runs to avoid notification fatigue.
            const metrics = childMetrics.get(sessionID);
            const parts: string[] = [];
            if (metrics) {
              if (metrics.new > 0) parts.push(`new: ${metrics.new}`);
              if (metrics.updated > 0) parts.push(`updated: ${metrics.updated}`);
              if (metrics.deleted > 0) parts.push(`deleted: ${metrics.deleted}`);
            }
            if (parts.length > 0) {
              try {
                await client.tui.showToast({
                  body: { message: `\u{1F4AD} ${parts.join(", ")}`, variant: "success", duration: 4000 },
                });
              } catch {
                // TUI may not be connected (e.g. headless mode).
              }
            }

            extraction.completeAccepted(parentID);
            missedNudges.delete(parentID);
            extracting.delete(parentID);
            childToParent.delete(sessionID);
            parentSnapshots.delete(sessionID);
            childMetrics.delete(sessionID);
            extractionChildren.delete(sessionID);
            extraction.consume(sessionID);
            // Delete the child session to avoid clutter.
            try {
              await client.session.delete({ path: { id: sessionID } });
            } catch {
              // Best-effort - the child is idle and harmless if not deleted.
            }
          } else {
            // Task-dispatched sub-agent went idle. Complete the parent's
            // accepted entries (from the nudge-path extraction_done accept)
            // and reset missedNudges. Retained for the nudge fallback path.
            extraction.completeAccepted(parentID);
            missedNudges.delete(parentID);
          }
          return;
        }
        // Parent went idle - trigger direct extraction if there are pending
        // tool interactions and no extraction is already running. Falls
        // back to the nudge path on the next chat.message if this throws.
        if (
          sessionID &&
          !compacting.has(sessionID) &&
          !extracting.has(sessionID) &&
          extraction.pending(sessionID)
        ) {
          try {
            await triggerExtraction(sessionID);
          } catch (err) {
            console.error(`[thatch] direct extraction trigger failed: ${err}`);
            extracting.delete(sessionID);
          }
        }
        return;
      }
      if (event.type === "session.deleted") {
        const id = event.properties.info.id;
        // A child deleted before completing never processed its payload.
        const parentID = childToParent.get(id);
        if (parentID) {
          extraction.requeueAccepted(parentID);
          extracting.delete(parentID);
        }
        childToParent.delete(id);
        parentSnapshots.delete(id);
        childMetrics.delete(id);
        extractionChildren.delete(id);
        // A deleted parent takes its accepted entries with it.
        extraction.completeAccepted(id);
        extracting.delete(id);
        return;
      }

      // session.compacted fires on successful compaction. Redundant with
      // experimental.compaction.autocontinue, but belt-and-suspenders: if
      // autocontinue didn't fire or wasn't installed, the event still clears
      // the compacting flag so nudges resume.
      if (event.type === "session.compacted") {
        compacting.delete(event.properties.sessionID);
        return;
      }

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
            parts: [{ type: "text", text: sessionStartReminder(repo, hygiene), synthetic: true }],
          },
        });
      } catch (err) {
        console.error(`[thatch] session-start reminder failed: ${err}`);
      }
    },

    dispose: async () => {
      stopVersionChecker();
      db.close();
    },
  };
};

export { hygieneReport } from "./hygiene";
