import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { ThatchDB } from "./db";
import { BgeEmbeddingModel } from "./embeddings";
import { detectRepo, detectWorktreeKind } from "./git";
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
import { installOpencodeCommands, COMPACT_READY_TOKEN, EXIT_READY_TOKEN } from "./commands";
import { hygieneReport } from "./hygiene";
import { seedDefaultBehaviors } from "./seed-behaviors";
import { startVersionChecker, stopVersionChecker, getVersionChecker, readOnDiskVersion, compareSemver } from "./version-check";
import { WatcherRegistry, ghApiRun, ghAvailable } from "./watchers";
import { watcherNotificationNudge, chatNotificationNudge, chatEchoText, isChatEchoParts } from "./prompts";
import { ChatPoller, createWakeGate, isDefaultSessionTitle, isPidAlive } from "./chat";
import { chatEnabled, chatAutoRegister, loadConfig } from "./config";
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

// Wrap-up command registry: command name as opencode derives it from the
// installed file path (~/.config/opencode/command/thatch/<name>.md), the
// greenlight token the command instructs the model to end its response with,
// and which TUI action the greenlight triggers.
const WRAPUP_COMMANDS: Record<string, { token: string; kind: "compact" | "exit" }> = {
  "thatch/compact": { token: COMPACT_READY_TOKEN, kind: "compact" },
  "thatch/exit": { token: EXIT_READY_TOKEN, kind: "exit" },
};

export const server: Plugin = async ({ client, worktree }) => {
  // The opencode server's cwd is wherever the server happened to start;
  // `worktree` is the project this plugin instance actually serves.
  const repo = await detectRepo(worktree);
  const home = process.env.HOME ?? "/tmp";
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const dbPath = process.env.THATCH_DB_PATH ?? join(configHome, "thatch", "thatch.db");
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  // Whether cross-session chat is on (chat.enabled, default on). Read once
  // at init: it gates the chat poller and the prompt's chat section. The
  // chat tools re-read the file per call, so a toggle takes effect there
  // without a restart.
  const chatOn = chatEnabled(loadConfig(dbPath).config);

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

  // Latest observed opencode session status per session ("busy" | "idle" |
  // "retry"). Keys enter from session.status events and leave only in
  // session.deleted (which shrinks the chat poller's hosted set). Readers:
  // the watcher registry's and the chat poller's canDeliver gates
  // (proactive prompts only fire into idle sessions, never into a running
  // turn), and the chat poller's hostedSessions set (the sessions this
  // process may deliver chat mail to - the map's keys).
  const sessionStatus = new Map<string, string>();

  // The proactive-prompt gate, shared by both delivery registries (watchers
  // and chat). Two layers, in cost order: the compacting set and the
  // event-fed sessionStatus map answer cheaply, and a final check verifies
  // against the server's live status - the map is only as fresh as the
  // event stream, and a stale "idle" turns a wake into mid-turn context
  // injection (observed live: a session read mail mid-burst, contradicted
  // its own in-flight plan, and looped).
  const canPromptSession = createWakeGate({
    isCompacting: (sessionID) => compacting.has(sessionID),
    mappedStatus: (sessionID) => sessionStatus.get(sessionID),
    fetchStatuses: async () => {
      const { data } = await client.session.status();
      return data ?? {};
    },
    onStatusError: (sessionID, err) => {
      console.error(`[thatch] status check failed for ${sessionID}: ${err}`);
    },
  });

  // In-memory watcher registry for proactive event notifications (GitHub PR
  // and branch watching, plus local command watches). Deliberately
  // process-scoped: no SQLite, no cross-restart state. See src/watchers.ts
  // for the rationale.
  //
  // Delivery prompts the session with a synthetic part - the same mechanism
  // opencode uses for background task completions - so a watched event
  // triggers a model turn even when the user is away. Events carry pointer
  // data plus machine status (check conclusions, exit codes); the model
  // fetches logs and further details itself with gh.
  const watchers = new WatcherRegistry({
    deliver: async (sessionID, events) => {
      // Events carry their watch's target label from the registry, so the
      // notification header is correct for every source (PRs, branches,
      // commands, CI events whose URLs would not parse).
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: watcherNotificationNudge(events[0]?.target ?? "watched target", events, watchers.pollSeconds), synthetic: true }],
        },
      });
      // Toast: the notification part is TUI-hidden, so without this the
      // user watching the session sees the model wake up with no visible
      // cause. Announce what fired. Failed checks/workflows surface as a
      // warning variant; routine events as info. Best-effort - the TUI may
      // not be connected (headless mode).
      const failed = events.some((e) => e.summary.includes("failure"));
      const more = events.length > 1 ? ` +${events.length - 1} more` : "";
      try {
        await client.tui.showToast({
          body: {
            message: `\u23F0 ${events[0]?.target ?? "watched target"}: ${events[0]?.summary ?? ""}${more}`,
            variant: failed ? "warning" : "info",
            duration: 5000,
          },
        });
      } catch {
        // TUI may not be connected. Best-effort.
      }
    },
    canDeliver: canPromptSession,
    ghRunner: ghApiRun,
  });
  // gh presence decides whether watch_create and watch_branch_create work;
  // checked lazily by the tools, but log once at startup so misconfiguration
  // is visible in debug logs. watch_command_create needs only bash, not gh.
  void ghAvailable().then((ok) => {
    if (!ok) console.error("[thatch] gh CLI not found - GitHub watch tools will report unavailable");
  });
  watchers.start();

  // The proactive-prompt gate, shared by both delivery registries
  // (watchers and chat). Two layers, in cost order: the compacting set and
  // the event-fed sessionStatus map answer cheaply, and a final check
  // verifies against the server's live status - the map is only as fresh
  // as the event stream, and a stale "idle" turns a wake into mid-turn
  // context injection (observed live: a session read mail mid-burst,
  // contradicted its own in-flight plan, and looped).
  const chatPoller = new ChatPoller({
    store: db,
    hostedSessions: () => {
      // Ownership, not event history: this harness beats and delivers for
      // every project session stamped with its pid (the sweep claims
      // orphans). Sub-agent children are excluded even if someone
      // registered one - a registered child would be heartbeat-ed
      // fresh-forever and burn nudge budget on undeliverable wake
      // prompts.
      return db
        .ownedChatSessions(repo, process.pid)
        .map((r) => r.session_id)
        .filter((id) => !childToParent.has(id));
    },
    deliver: async (sessionID, senders, count) => {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: chatNotificationNudge(senders, count), synthetic: true }],
        },
      });
      try {
        await client.tui.showToast({
          body: {
            message: `\u{1F4AC} chat: ${count} unread from ${senders.join(", ")}`,
            variant: "info",
            duration: 5000,
          },
        });
      } catch {
        // TUI may not be connected. Best-effort.
      }
    },
    canDeliver: canPromptSession,
  });
  // With chat disabled the tools refuse, so the poller would only heartbeat
  // sessions and burn wake budget against a feature the user turned off.
  if (chatOn) chatPoller.start();

  // Startup sweep + hourly re-sweep: membership in the roster tracks what
  // is LOADED in a live harness, not what recently moved. A harness restart
  // fires no events for sessions that are merely loaded (resume fires
  // nothing either - session IDs persist across restarts), so the sweep
  // registers the project's top-level sessions from client.session.list at
  // init, re-runs hourly to catch mid-run loads, and ADOPTS rows whose
  // owning harness died (dead pid): re-stamping the pid and beating them
  // fresh - a live harness can wake any of its project's sessions. All of
  // it is idempotent; registration assigns pool names, and a real title
  // rides the topic column like everyone else's.
  const chatSweep = async () => {
    // Feature-detect: an older opencode client may not expose
    // session.list. The sweep is best-effort (idle registration still
    // covers those sessions), so an absent method skips silently
    // instead of logging an error on every startup.
    if (typeof client.session?.list !== "function") return;
    const { data } = await client.session.list();
    for (const s of data ?? []) {
      if ((s as any).parentID) continue; // top-level sessions only
      const title = s.title ?? "";
      // Same placeholder guard as the idle path: a fresh session may still
      // carry opencode's pre-autotitle title.
      const topic = title && !isDefaultSessionTitle(title) ? title : null;
      const res = db.registerChatSession(s.id, repo, topic, "opencode", null, detectWorktreeKind(worktree), process.pid);
      // Converge the topic for sessions that already had a row: the title
      // may have changed while they were away.
      if (res.ok && topic) db.refreshChatTopic(s.id, topic);
    }
    // Adopt the dead: opencode rows of this project whose owning pid no
    // longer exists. Their harness is gone; this one is alive and takes
    // over the beating and delivery - listed or not, a dead-owner row is
    // claimable. MCP rows are turn-driven and have no pid - never touched.
    // register() is idempotent for the row (and respects leave tombstones
    // - a session the user left stays gone); the heartbeat then re-stamps
    // ownership and freshness, which the register-existing path
    // deliberately does not.
    for (const row of db.listChatSessions()) {
      if (row.project !== repo || row.host_kind !== "opencode") continue;
      if (row.host_pid != null && isPidAlive(row.host_pid)) continue; // a live harness owns it
      const res = db.registerChatSession(row.session_id, repo, row.topic, "opencode", null, row.worktree, process.pid);
      if (res.ok) db.heartbeatChatSessions([row.session_id]);
    }
    // Asleep-mail: a restarted harness may hold sessions with unread mail
    // that queued while they were down. Deliver now through the normal
    // path (gate, nudge, toast, stamps) instead of making the session wait
    // out the first poll cycle - the restarted session learns what it
    // missed at startup, which is the whole point of the sweep.
    await chatPoller.deliverPending();
  };
  if (chatOn && chatAutoRegister(loadConfig(dbPath).config)) {
    void chatSweep().catch((err) => {
      console.error(`[thatch] chat startup sweep failed: ${err}`);
    });
    const sweepTimer = setInterval(() => {
      void chatSweep().catch((err) => {
        console.error(`[thatch] chat sweep failed: ${err}`);
      });
    }, 3_600_000);
    sweepTimer.unref?.();
  }

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

  // Wrap-up slash commands (/thatch/compact, /thatch/exit) awaiting their
  // greenlight check. command.execute.before marks the session when one of
  // these commands runs; when the session next goes idle, the plugin reads
  // the final assistant message for the ready token (the greenlight) and
  // triggers the TUI action. Token absence means the model listed blockers
  // instead, so nothing fires beyond a toast. Cleared on resolution or on
  // session deletion.
  const pendingWrapUp = new Map<string, { token: string; kind: "compact" | "exit" }>();

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

  // Same for the wrap-up slash commands: synced into the global config dir on
  // every load so template updates self-heal. Config is loaded before plugins
  // during server startup, so a first-ever install lands on the next start.
  try {
    installOpencodeCommands(configHome);
  } catch (err) {
    console.error(`[thatch] command install failed: ${err}`);
  }

  const sys = systemPrompt(repo, chatOn);
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
      watcherRegistry: watchers,
      projectDir: worktree,
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
      // Chat conversational events echo back into the transcript as visible
      // message parts. Plugin tools render as muted one-line entries with
      // the output hidden behind a default-off TUI toggle, so without this
      // the human watching a session never sees the conversation happen.
      // Delivery is a non-synthetic noReply promptAsync: the part renders
      // as a visible bubble and starts no model turn (the server's prompt
      // path returns before the completion loop). Non-synthetic also means
      // later turns see the echo in context - a small duplication of the
      // tool call it mirrors, accepted for visibility. Fire-and-forget: an
      // echo failure must never fail the tool call it follows.
      if (input.tool.startsWith("thatch_chat_")) {
        const echo = chatEchoText(
          input.tool,
          (input.args ?? {}) as Record<string, unknown>,
          typeof output.output === "string" ? output.output : "",
        );
        if (echo) {
          void client.session
            .promptAsync({
              path: { id: input.sessionID },
              body: {
                noReply: true,
                parts: [{ type: "text", text: echo }],
              },
            })
            .catch((err) => {
              // The echo must never fail the tool call, but a silent catch
              // would hide a systemic promptAsync failure (bubbles would
              // stop appearing everywhere with no diagnostics).
              console.error(`[thatch] chat echo delivery failed: ${err}`);
            });
        }
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
    // Wrap-up commands mark their session here; the actual trigger happens
    // on the session's next idle event, once the model's greenlight response
    // is complete.
    "command.execute.before": async (input) => {
      const wrapUp = WRAPUP_COMMANDS[input.command];
      if (wrapUp) pendingWrapUp.set(input.sessionID, wrapUp);
    },

    "chat.message": async (input, output) => {
      // Chat transcript echoes are non-synthetic noReply parts, so they
      // arrive here like any user message - but no model turn ever reads
      // them, and the nudge machinery would embed and scan their text for
      // nothing (and fire spurious toasts when thresholds cross). Skip
      // them entirely.
      if (isChatEchoParts(output.parts)) return;
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
      if (event.type === "session.status") {
        const sessionID = event.properties.sessionID;
        const statusType = event.properties.status?.type;
        // Record the latest status so the watcher registry can gate
        // proactive prompt delivery on idle sessions.
        if (sessionID && statusType) sessionStatus.set(sessionID, statusType);
        if (statusType !== "idle") return;
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
        // Wrap-up command resolution: the session went idle right after
        // /thatch/compact or /thatch/exit. The final assistant message's
        // trailing token is the greenlight - the command instructs the model
        // to end with it only after flushing persistence and confirming no
        // loose ends. Token absence means the model listed blockers, so the
        // action never fires; a toast points the user at the blockers above.
        const wrapUp = sessionID ? pendingWrapUp.get(sessionID) : undefined;
        if (wrapUp) {
          pendingWrapUp.delete(sessionID);
          let ready = false;
          try {
            const { data } = await client.session.messages({ path: { id: sessionID } });
            const last = [...(data ?? [])].reverse().find((m) => m.info.role === "assistant");
            const text = (last?.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("\n")
              .trimEnd();
            ready = text.endsWith(wrapUp.token);
          } catch (err) {
            console.error(`[thatch] wrap-up message fetch failed: ${err}`);
          }
          if (ready) {
            // An exit-greenlit session is leaving the process: leave the
            // chat directory too, so other sessions stop addressing mail to
            // a roster entry whose host is about to vanish. The unregister
            // tombstone also stops any straggler auto-register from
            // resurrecting the row during shutdown. Compact keeps the
            // session alive, so only the exit path does this.
            if (wrapUp.kind === "exit") {
              try {
                db.unregisterChatSession(sessionID);
              } catch (err) {
                console.error(`[thatch] chat unregister on exit failed: ${err}`);
              }
            }
            try {
              if (wrapUp.kind === "compact") {
                // executeCommand only accepts legacy alias names;
                // "session_compact" maps to the TUI's session.compact action,
                // the same thing the built-in /compact command runs.
                await client.tui.executeCommand({ body: { command: "session_compact" } });
              } else {
                // No exit alias exists, so publish the TUI keymap command
                // directly - the same dispatch as the /exit slash command.
                await client.tui.publish({
                  body: { type: "tui.command.execute", properties: { command: "app.exit" } },
                });
              }
            } catch (err) {
              console.error(`[thatch] wrap-up action failed: ${err}`);
            }
            // Skip extraction and pending deliveries: compaction is starting
            // (the checklist drained the buffer) or the process is exiting.
            return;
          }
          try {
            await client.tui.showToast({
              body: {
                message:
                  wrapUp.kind === "compact"
                    ? "\u23F8 Not compacting - resolve the items listed above, then run /thatch/compact again"
                    : "\u23F8 Not exiting - resolve the items listed above, then run /thatch/exit again",
                variant: "warning",
                duration: 8000,
              },
            });
          } catch {
            // TUI may not be connected (e.g. headless mode).
          }
          // Blocked: fall through so extraction and pending deliveries still
          // run - the model may have buffered tool interactions to flush.
        }
        // Auto-registration: every top-level opencode session joins the
        // chat directory on its first idle event (unless the user turned
        // auto-registration off). The name is assigned, never chosen - a
        // pool draw plus a never-reused counter, kept short because it
        // appears in wake prompts and rosters. The live session title rides
        // the topic column instead (refreshed on every idle), so the name
        // and the description stay separate identities. Fire-and-forget: a
        // failed registration or title fetch must never block event
        // delivery.
        if (chatOn && chatAutoRegister(loadConfig(dbPath).config) && sessionID && !db.hasChatLeaveTombstone(sessionID)) {
          void (async () => {
            try {
              const { data } = await client.session.get({ path: { id: sessionID } });
              const title = data?.title ?? "";
              // Placeholder titles never become topics (the real one
              // converges on a later idle via refreshChatTopic).
              const topic = title && !isDefaultSessionTitle(title) ? title : null;
              const res = db.registerChatSession(sessionID, repo, topic, "opencode", null, detectWorktreeKind(worktree), process.pid);
              // The topic converges as the auto-titler lands a real title:
              // registration is once-per-session, so later idles must
              // refresh it explicitly.
              if (res.ok && topic) db.refreshChatTopic(sessionID, topic);
              if (res.ok && res.created) {
                // First registration is the one moment the user should
                // notice: a quiet toast, not a conversation message.
                try {
                  await client.tui.showToast({ body: { message: `registered in chat as ${res.name}`, variant: "info", duration: 4000 } });
                } catch {
                  // Headless or disconnected TUI - registration stands.
                }
              }
            } catch (err) {
              console.error(`[thatch] chat auto-register failed for ${sessionID}: ${err}`);
            }
          })();
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
        // The session just became idle, so watcher events queued while it
        // was busy can be delivered now - the poll interval may otherwise
        // hold them for up to a full cycle. Best-effort; failures stay
        // pending and retry on the next poll.
        try {
          await watchers.deliverPending();
        } catch (err) {
          console.error(`[thatch] watcher delivery on idle failed: ${err}`);
        }
        // Same for chat messages: mail that arrived mid-turn lands now
        // instead of waiting for the next poll cycle.
        try {
          await chatPoller.deliverPending();
        } catch (err) {
          console.error(`[thatch] chat delivery on idle failed: ${err}`);
        }
        return;
      }
      if (event.type === "session.deleted") {
        const id = event.properties.info.id;
        // Shrink the chat poller's hosted set FIRST: the rest of this
        // branch runs extraction calls that could throw on a transient DB
        // error, and a leaked status key would keep heartbeat-ing a dead
        // session as permanently fresh.
        sessionStatus.delete(id);
        // Tombstone the auto-registerer: an idle IIFE already in flight
        // (title fetch pending) would otherwise re-insert a directory row
        // for a session the user just deleted - a week-long roster zombie
        // whose host is gone. The unregister below tombstones (see
        // ChatStore.unregister), and the tombstone is cleared only by an
        // explicit chat_register rejoin, so a genuinely new session is
        // unaffected.
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
        pendingWrapUp.delete(id);
        // A deleted parent takes its accepted entries with it, and its
        // watchers die with it - the session that would receive their
        // notifications no longer exists.
        extraction.completeAccepted(id);
        extracting.delete(id);
        watchers.cancelSession(id);
        // Leaving the chat directory is the graceful-exit fast path; a
        // crashed process never fires session.deleted, so the heartbeat
        // staleness in chat_list is the covering signal for that case.
        try {
          db.unregisterChatSession(id);
        } catch (err) {
          console.error(`[thatch] chat unregister on delete failed: ${err}`);
        }
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
      watchers.dispose();
      chatPoller.dispose();
      // Release native ONNX sessions while the worker is still healthy. Left
      // to Bun's teardown, their NAPI finalizers panic the process (see
      // BgeEmbeddingModel.dispose).
      await model.dispose();
      db.close();
    },
  };
};

export { hygieneReport } from "./hygiene";
