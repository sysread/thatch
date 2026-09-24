import { join } from "node:path";
import { createDebugLog } from "./debug";
import { ThatchDB, repoPathCache } from "./db";
import { SharedModelPool } from "./embeddings";
import { detectRepo, detectWorktreeKind, resolveSpawnCwd } from "./git";
import { buildCoreContext } from "./tool-defs";
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
  skewWarningText,
  type NudgeMatch,
} from "./prompts";
import { ExtractionPipeline, type ToolInteraction } from "./extraction";
import type { CoreContext } from "./tool-defs";
import { installSkills, SHARED_SKILLS, OPENCODE_ONLY_SKILLS } from "./skills";
import { installOpencodeCommands, opencodeActionCommandDefs, removeWrapUpCommandFiles, COMPACT_READY_TOKEN, EXIT_READY_TOKEN } from "./commands";
import { hygieneReport } from "./hygiene";
import { seedDefaultBehaviors } from "./seed-behaviors";
import { startVersionChecker, stopVersionChecker, getVersionChecker, readOnDiskVersion, compareSemver } from "./version-check";
import { WatcherRegistry, ghApiRun, ghAvailable, runWatchedCommand, withCwdFallback, type Watcher } from "./watchers";
import { watcherNotificationNudge, chatNotificationNudge, chatEchoText, isChatEchoParts } from "./prompts";
import { ChatPoller, createWakeGate, hostedSessionIds, isDefaultSessionTitle } from "./chat";
import { chatEnabled, chatAutoRegister, loadConfig } from "./config";
import { osProcessArgs, startupSessionId, continuesLastSessionFromArgv, continuesLastSessionId } from "./os-args";
import type { HostCapabilities } from "./capabilities";
import pkg from "../package.json";

// ---------------------------------------------------------------------------
// Shared plugin runtime - host-agnostic across opencode v1 and v2
// ---------------------------------------------------------------------------

// Minimum cosine score for the prompt-aware recall nudge. Lower than
// findDuplicates' 0.85 (near-dupes) because "relates to" is a weaker signal
// than "duplicate." Tunable via THATCH_RECALL_THRESHOLD.
const RECALL_THRESHOLD = parseFloat(process.env.THATCH_RECALL_THRESHOLD ?? "0.55");

/** Process-wide pool for the shared embedding models (see SharedModelPool). */
const sharedModels = new SharedModelPool();

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

// The handler-set shape both host adapters consume. The methods correspond
// to the v1 hook surface (plus the per-call coreContext and the
// host-agnostic debug log); the v2 adapter routes its domain hooks into
// these same methods. Part and message shapes are kept structural (the v1
// bodies already treat parts loosely) so neither adapter has to convert
// host SDK types.
export interface ThatchRuntime {
  /** The shared per-call context both adapters register TOOL_DEFS with. */
  coreContext: CoreContext;
  /** The host-agnostic diagnostic log (THATCH_DEBUG; no-op when unset). */
  debug(tag: string, message: string): void;
  /**
   * Session IDs with live child bookkeeping (in-flight extraction children).
   * The v2 adapter seeds its event-forwarding set from this after a reload:
   * the rehydrated child maps must be visible to the pump's directory
   * filter, or a below-root launch drops the child's events again.
   */
  childSessionIds(): string[];
  onSystemTransform(output: { system: string[] }): Promise<void>;
  onSessionCompacting(input: { sessionID: string }, output: { context: string[] }): Promise<void>;
  onCompactionAutocontinue(input: { sessionID: string }): Promise<void>;
  onToolExecuteAfter(
    input: { tool: string; sessionID: string; args?: unknown },
    output: { title: string; output: string },
  ): Promise<void>;
  onCommandExecuteBefore(input: { command: string; sessionID: string }): Promise<void>;
  onChatMessage(
    input: { sessionID: string; messageID?: string },
    output: { parts: any[]; message: { id: string } },
  ): Promise<void>;
  onEvent(event: any): Promise<void>;
  dispose(): Promise<void>;
}

export async function createRuntime(input: {
  capabilities: HostCapabilities;
  directory: string;
  worktree: string;
}): Promise<ThatchRuntime> {
  const { capabilities: caps, directory, worktree } = input;
  // The opencode server's cwd is wherever the server happened to start;
  // `worktree` is the project this plugin instance actually serves.
  // `directory` is the session's own directory - on resume after the
  // worktree was deleted, opencode reassigns worktree to "/" (it walks up
  // from the missing dir, finds no .git, and boots the global project) but
  // still forwards the original path as directory, which is the only input
  // the repo_paths cache can recover identity from.
  const home = process.env.HOME ?? "/tmp";
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const dbPath = process.env.THATCH_DB_PATH ?? join(configHome, "thatch", "thatch.db");
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  // The DB must exist before identity detection: detectRepo consults the
  // repo_paths cache when the session directory is gone.
  const db = new ThatchDB(dbPath);
  const repoCache = repoPathCache(db);
  const repo = await detectRepo(directory ?? worktree, repoCache);

  // Whether cross-session chat is on (chat.enabled, default on). Read once
  // at init: it gates the chat poller and the prompt's chat section. The
  // chat tools re-read the file per call, so a toggle takes effect there
  // without a restart.
  const chatOn = chatEnabled(loadConfig(dbPath).config);

  const debug = createDebugLog(dbPath);

  // Shared embedding model: refcounted per db path (see SharedModelPool).
  const model = sharedModels.acquire(dbPath, modelName);
  const releaseModel = () => sharedModels.release(dbPath);

  // Extraction buffer, journaled to runtime_state so a v2 plugin reload
  // (same process, graph rebuilt) can rehydrate it.
  const extraction = new ExtractionPipeline((kind, sessionID, value) => {
    if (value === undefined) db.runtimeStateDelete(kind, sessionID);
    else db.runtimeStatePut(kind, sessionID, value, directory);
  });

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
      return (await caps.fetchStatuses()) ?? {};
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
  // Watched-command runner: resolves the spawn cwd per poll. When the
  // project directory is deleted mid-watch (worktree merged and cleaned up),
  // the poll falls back to the repo_paths cache's main checkout instead of
  // spinning ENOENT errors until the TTL. The wrapper logs the fallback
  // once per dead directory - per-cycle error logging is the existing
  // failure mode and it spams.
  const watchedCommandRunner = withCwdFallback(runWatchedCommand, (cwd) => resolveSpawnCwd(cwd, repoCache), (from, to) => {
    console.error(`[thatch] project directory ${from} deleted; watcher falling back to main checkout ${to}`);
  });

  const watchers = new WatcherRegistry({
    // Journal watcher definitions so a v2 plugin reload (same process) can
    // re-arm them; the registry journals after every membership change.
    journal: (sessionID, sessionWatchers) => {
      if (sessionWatchers.length === 0) db.runtimeStateDelete("watchers", sessionID);
      else db.runtimeStatePut("watchers", sessionID, sessionWatchers, directory);
    },
    deliver: async (sessionID, events) => {
      // Events carry their watch's target label from the registry, so the
      // notification header is correct for every source (PRs, branches,
      // commands, CI events whose URLs would not parse).
      await caps.promptSession(
        sessionID,
        {
          parts: [
            { type: "text", text: watcherNotificationNudge(events[0]?.target ?? "watched target", events, watchers.pollSeconds), synthetic: true },
          ],
        },
        "async",
      );
      // Toast: the notification part is TUI-hidden, so without this the
      // user watching the session sees the model wake up with no visible
      // cause. Announce what fired. Failed checks/workflows surface as a
      // warning variant; routine events as info. Best-effort - the TUI may
      // not be connected (headless mode).
      const failed = events.some((e) => e.summary.includes("failure"));
      const more = events.length > 1 ? ` +${events.length - 1} more` : "";
      try {
        await caps.showToast({
          message: `⏰ ${events[0]?.target ?? "watched target"}: ${events[0]?.summary ?? ""}${more}`,
          variant: failed ? "warning" : "info",
          duration: 5000,
        });
      } catch {
        // TUI may not be connected. Best-effort.
      }
    },
    canDeliver: canPromptSession,
    ghRunner: ghApiRun,
    commandRunner: watchedCommandRunner,
  });
  // gh presence decides whether watch_create and watch_branch_create work;
  // checked lazily by the tools, but log once at startup so misconfiguration
  // is visible in debug logs. watch_command_create needs only bash, not gh.
  void ghAvailable().then((ok) => {
    if (!ok) console.error("[thatch] gh CLI not found - GitHub watch tools will report unavailable");
  });
  watchers.start();

  // The session this harness was launched to resume, resolved at startup:
  // `-s <id>` names it on the command line, `-c` means "most recent in this
  // directory" and resolves through the SDK. Either way the poller hosts it
  // from the first beat, so the heartbeat and delivery are live before the
  // user's first prompt.
  // Startup-resumed chat sessions. A Set (not a scalar): one plugin
  // instance can serve several sessions - shared-server tabs in the same
  // directory each resolve their own -c/-s target.
  const resumedSessions = new Set<string>();

  // Chat names assigned by the startup resume paths (-s and -c) wait here
  // until the session's first message or idle event, which toast them. At
  // plugin-init time the TUI is not yet connected, so an immediate toast
  // would be dropped silently.
  const chatStartupNames = new Map<string, string>();

  const chatPoller = new ChatPoller({
    store: db,
    hostedSessions: () =>
      hostedSessionIds({
        statusKeys: sessionStatus.keys(),
        resumedSessions: resumedSessions,
        registeredRows: db.listChatSessions(),
        hostScope: caps.hostScope,
        worktree,
        exclude: childToParent.keys(),
      }),
    deliver: async (sessionID, senders, count) => {
      await caps.promptSession(
        sessionID,
        {
          parts: [{ type: "text", text: chatNotificationNudge(senders, count), synthetic: true }],
        },
        "async",
      );
      try {
        await caps.showToast({
          message: `💬 chat: ${count} unread from ${senders.join(", ")}`,
          variant: "info",
          duration: 5000,
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

  // Startup registration: `opencode -s <id>` continues a session whose
  // directory row may predate this process (its harness died, or the
  // machine restarted); `opencode -c` continues the most recent session in
  // this directory. The framework passes no session id to plugins and
  // resuming fires no events, so the command line is the source (see
  // startupSessionId). Registering here RECLAIMS the row - the name is
  // owned by the session id and never changes - and refreshes its
  // heartbeat: synchronously for -s (local SQLite, it cannot fail on a
  // server that is still starting); for -c after an SDK list call resolves
  // the target. The async tail (title fetch, asleep-mail delivery) is
  // best-effort - the poller retries whatever it misses, and the first
  // idle converges the topic.
  const reclaimTail = (sessionID: string) => {
    void (async () => {
      try {
        const data = await caps.sessionGet(sessionID);
        const title = data?.title ?? "";
        const topic = title && !isDefaultSessionTitle(title) ? title : null;
        if (topic) db.refreshChatTopic(sessionID, topic);
      } catch {
        // Server may still be starting; the topic converges on the
        // session's first idle either way.
      }
      try {
        // Asleep-mail: deliver what queued while this session was away,
        // through the normal path (gate, nudge, toast, stamps).
        await chatPoller.deliverPending();
      } catch {
        // The poller cycle retries delivery; nothing to do here.
      }
    })();
  };
  const osArgs = osProcessArgs();
  const startupSession = startupSessionId(osArgs);
  const continueLast = !startupSession && (continuesLastSessionFromArgv(process.argv) || continuesLastSessionFromArgv(osArgs));
  const autoRegisterOn = chatAutoRegister(loadConfig(dbPath).config);
  const tombstoned = startupSession ? db.hasChatLeaveTombstone(startupSession) : false;
  debug("chat:startup", `init: argv=${JSON.stringify(process.argv.slice(0, 8))} osArgs=${JSON.stringify(osArgs.slice(0, 8))} parsed=${startupSession} continue=${continueLast} chatOn=${chatOn} autoRegister=${autoRegisterOn} tombstone=${startupSession ? tombstoned : "n/a"}`);
  if (chatOn && autoRegisterOn && startupSession && !tombstoned) {
    resumedSessions.add(startupSession);
    const res = db.registerChatSession(startupSession, repo, null, "opencode", null, detectWorktreeKind(worktree));
    debug("chat:startup", `registration for ${startupSession}: ok=${res.ok} name=${res.ok ? res.name : res.error}`);
    if (res.ok) {
      chatStartupNames.set(startupSession, res.name);
      reclaimTail(startupSession);
    }
  } else if (chatOn && autoRegisterOn && continueLast) {
    void (async () => {
      try {
        const data = await caps.sessionList();
        const target = continuesLastSessionId(data ?? []);
        debug("chat:startup", `-c resolved: ${target ?? "none"}`);
        if (!target || db.hasChatLeaveTombstone(target)) return;
        resumedSessions.add(target);
        const res = db.registerChatSession(target, repo, null, "opencode", null, detectWorktreeKind(worktree));
        debug("chat:startup", `registration for ${target}: ok=${res.ok} name=${res.ok ? res.name : res.error}`);
        if (res.ok) {
          chatStartupNames.set(target, res.name);
          reclaimTail(target);
        }
      } catch (err) {
        console.error(`[thatch] chat -c startup registration failed: ${err}`);
      }
    })();
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
  // session and prompts it directly through the host's prompt capability
  // instead of injecting a nudge into the next user message. This set
  // suppresses the nudge path
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

  // Journal the child bookkeeping (parent link, buffer snapshot, metrics) so
  // a v2 plugin reload can rehydrate an in-flight extraction instead of
  // orphaning it. A child with no parent entry journals a delete.
  const journalChild = (childId: string) => {
    const parentID = childToParent.get(childId);
    if (!parentID) {
      db.runtimeStateDelete("child", childId);
      return;
    }
    db.runtimeStatePut("child", childId, {
      parentID,
      snapshot: parentSnapshots.get(childId) ?? [],
      metrics: childMetrics.get(childId) ?? { new: 0, updated: 0, deleted: 0 },
    }, directory);
  };

  // Wrap-up slash commands (/thatch/compact, /thatch/exit) awaiting their
  // greenlight check. command.execute.before marks the session when one of
  // these commands runs; when the session next goes idle, the plugin reads
  // the final assistant message for the ready token (the greenlight) and
  // triggers the TUI action. Token absence means the model listed blockers
  // instead, so nothing fires beyond a toast. Cleared on resolution or on
  // session deletion.
  const pendingWrapUp = new Map<string, { token: string; kind: "compact" | "exit" }>();

  // Rehydrate persisted runtime state (docs/plans/plugin-state-persistence.md).
  // Rows are instance-scoped (kind+session, tagged with the writer's pid and
  // location directory):
  // - same pid, same directory: a v2 plugin reload rebuilt THIS instance's
  //   graph - rehydrate everything.
  // - same pid, other directory: a live sibling instance's rows (one serve
  //   hosts one instance per location) - leave them alone; hydrating them
  //   would double-poll watchers and re-deliver another instance's state.
  // - foreign pid: a process restart, whose sessions died with their
  //   harness. Only a startup-resumed session (-s/-c) in this directory
  //   inherits recovery-safe state; everything else is pruned.
  const rehydratedSessions = new Set<string>();
  const rehydrated: Record<string, number> = {};
  for (const row of db.runtimeStateAll()) {
    const samePid = row.pid === process.pid;
    const ownDirectory = row.directory === directory;
    const isStartup = startupSession !== undefined && row.sessionID === startupSession;
    if (samePid && !ownDirectory) continue; // live sibling - untouched
    if (!samePid && !(isStartup && ownDirectory)) {
      db.runtimeStateDelete(row.kind, row.sessionID);
      continue;
    }
    if (row.kind === "buffer") {
      extraction.hydrate(row.value as ToolInteraction[], []);
    } else if (row.kind === "accepted") {
      extraction.hydrate([], row.value as ToolInteraction[]);
    } else if (row.kind === "watchers") {
      watchers.hydrate((row.value ?? []) as Watcher[]);
    } else if (row.kind === "child") {
      const rec = row.value as { parentID?: string; snapshot?: ToolInteraction[]; metrics?: { new: number; updated: number; deleted: number } };
      if (samePid && rec?.parentID) {
        // Reload: the child may still be running - restore its live
        // bookkeeping so its idle event finds the maps populated.
        childToParent.set(row.sessionID, rec.parentID);
        parentSnapshots.set(row.sessionID, rec.snapshot ?? []);
        extractionChildren.add(row.sessionID);
        extracting.add(rec.parentID);
        if (rec.metrics) childMetrics.set(row.sessionID, rec.metrics);
      } else {
        // Restart: the child ran in the dead process and no execution event
        // will ever arrive for it. Recover the snapshot as plain pending
        // entries (extraction stays available) and drop the record - never
        // restore `extracting`, which would suppress both extraction paths
        // for the resumed session forever.
        if (isStartup && rec?.parentID === startupSession && Array.isArray(rec.snapshot)) {
          for (const interaction of rec.snapshot) extraction.push(interaction);
        }
        db.runtimeStateDelete(row.kind, row.sessionID);
        continue;
      }
    } else if (row.kind === "wrapup") {
      if (!samePid) {
        // An armed wrap-up inherited across a restart could auto-fire
        // compact/exit on the resumed session's first idle if the final
        // message already carries the token. Too dangerous to inherit.
        db.runtimeStateDelete(row.kind, row.sessionID);
        continue;
      }
      pendingWrapUp.set(row.sessionID, row.value as { token: string; kind: "compact" | "exit" });
    } else {
      continue; // unknown kind - leave it for a future version
    }
    rehydrated[row.kind] = (rehydrated[row.kind] ?? 0) + 1;
    rehydratedSessions.add(row.sessionID);
  }
  if (Object.keys(rehydrated).length > 0) {
    const counts = Object.entries(rehydrated)
      .map(([kind, n]) => `${kind}=${n}`)
      .join(" ");
    debug("runtime:rehydrate", `restored ${counts}`);
    // Ping the restored sessions directly: the reload/restart happened
    // outside their event stream, so without this the sessions would not
    // know the plugin is back (and the pump's hosted set would wait for
    // their next event to re-form). Synthetic + noReply: never starts a
    // model turn, and on v2 session.synthetic is TUI-hidden.
    for (const sessionID of rehydratedSessions) {
      if (!chatOn) break;
      void caps
        .promptSession(
          sessionID,
          {
            parts: [
              {
                type: "text",
                text: "[thatch] plugin reloaded - persisted state restored (extraction buffers, watchers, wrap-ups). No action needed.",
                synthetic: true,
              },
            ],
            noReply: true,
          },
          "async",
        )
        .catch(() => {
          // The session may be gone (restart prune edge) - the poller's
          // normal gates handle delivery; nothing to do here.
        });
    }
  }

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
  // Hosts that register commands natively (v2) get the action commands as
  // files only - the wrap-ups register in code (onCommandExecuteBefore), and a file with
  // the same name as a registered command would collide.
  try {
    if (caps.nativeCommands) removeWrapUpCommandFiles(configHome);
    installOpencodeCommands(configHome, caps.nativeCommands ? opencodeActionCommandDefs() : undefined);
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

    const result = await caps.sessionCreate({
      parentID,
      title: "thatch-extraction",
    });
    // session.created event fires here, setting childToParent and
    // parentSnapshots (snapshot of the full pending buffer, since we
    // have not called accept).
    const childId = result.id;
    extractionChildren.add(childId);
    // v2's session API cannot create a CHILD session (no parentID in its
    // create input), so the adapter returns a top-level session and no
    // session.created event carries the parent mapping. Set both here
    // eagerly; on v1 the event sets the same values (idempotent).
    if (!childToParent.has(childId)) {
      childToParent.set(childId, parentID);
      parentSnapshots.set(childId, [...extraction.peek(parentID)]);
    }
    journalChild(childId);

    // Clean up the child session and all map entries if prompting fails.
    // Without this, the child exists on the server but was never prompted,
    // so it never goes idle and the maps leak.
    const cleanupChild = () => {
      extracting.delete(parentID);
      extractionChildren.delete(childId);
      childToParent.delete(childId);
      parentSnapshots.delete(childId);
      childMetrics.delete(childId);
      journalChild(childId);
      try { void caps.sessionDelete(childId); } catch {}
    };

    const bgEnabled =
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS === "true" ||
      process.env.OPENCODE_EXPERIMENTAL === "true";

    if (bgEnabled) {
      try {
        await caps.promptSession(
          childId,
          {
            parts: [{ type: "text", text: promptText }],
          },
          "async",
        );
      } catch (err) {
        console.error(`[thatch] extraction child prompt failed: ${err}`);
        cleanupChild();
        throw err;
      }
    } else {
      // Fire and forget - the parent is already idle, so blocking the event
      // handler would only delay other event processing. The child runs to
      // completion and its idle event triggers cleanup.
      caps
        .promptSession(
          childId,
          {
            parts: [{ type: "text", text: promptText }],
          },
          "sync",
        )
        .catch((err: unknown) => {
          console.error(`[thatch] extraction child failed: ${err}`);
          cleanupChild();
        });
    }
  }

  return {
    coreContext: buildCoreContext(db, model, repo, {
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
    debug,
    childSessionIds: () => [...extractionChildren],

    // 1. System prompt - always in context.
    onSystemTransform: async (output) => {
      output.system.push(sys);
    },

    // 2. Compaction context - re-familiarizes after compaction. The flag
    //    suppresses chat.message nudges during summary generation (tool
    //    calls are blocked there).
    onSessionCompacting: async (input, output) => {
      compacting.add(input.sessionID);
      output.context.push(compact);
    },

    // 2b. Clear the compacting flag after compaction succeeds so chat.message
    //     nudges resume for the synthetic auto-continue turn and beyond.
    onCompactionAutocontinue: async (input) => {
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
    onToolExecuteAfter: async (input, output) => {
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
          if ((input.args as any)?.overwrite) metrics.updated++;
          else metrics.new++;
          childMetrics.set(input.sessionID, metrics);
          journalChild(input.sessionID);
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
          journalChild(input.sessionID);
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
        // noReply hosts only: on a host whose prompt endpoint starts a real
        // model turn, delivering the echo would create a turn that calls
        // chat tools, which echoes again - the loop the noReply flag exists
        // to prevent.
        if (echo && caps.noReplyDelivery) {
          void caps
            .promptSession(
              input.sessionID,
              {
                noReply: true,
                parts: [{ type: "text", text: echo }],
              },
              "async",
            )
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
        args: (input.args as Record<string, unknown>) ?? {},
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
    onCommandExecuteBefore: async (input) => {
      const wrapUp = WRAPUP_COMMANDS[input.command];
      if (wrapUp) {
        pendingWrapUp.set(input.sessionID, wrapUp);
        // Journaled so a v2 plugin reload before the session's next idle
        // does not silently drop the armed wrap-up.
        db.runtimeStatePut("wrapup", input.sessionID, wrapUp, directory);
      }
    },

    onChatMessage: async (input, output) => {
      // Chat transcript echoes are non-synthetic noReply parts, so they
      // arrive here like any user message - but no model turn ever reads
      // them, and the nudge machinery would embed and scan their text for
      // nothing (and fire spurious toasts when thresholds cross). Skip
      // them entirely.
      if (isChatEchoParts(output.parts)) return;

      // Prompt-path registration: a brand-new session joins the chat
      // directory the moment its first real user message arrives - before
      // the model runs - so it is addressable within that first turn (the
      // first-idle path alone leaves a turn-long dark window). Local
      // SQLite, so it runs inline; on an already-registered session this
      // is a free mid-turn heartbeat touch. Sub-agent children are excluded
      // (they register only by mistake, and their deletion tombstones the
      // row), as are sessions that left via chat_unregister. The idle path
      // below stays as the backstop and converges the topic.
      if (
        chatOn &&
        chatAutoRegister(loadConfig(dbPath).config) &&
        input.sessionID &&
        !childToParent.has(input.sessionID) &&
        !db.hasChatLeaveTombstone(input.sessionID)
      ) {
        try {
          const res = db.registerChatSession(input.sessionID, repo, null, "opencode", null, detectWorktreeKind(worktree));
          // First registration - or a startup resume reclaiming its name,
          // announced here because the TUI was not connected at init - is
          // the one moment the user should notice: a quiet toast, not a
          // conversation message.
          if (res.ok && (res.created || chatStartupNames.has(input.sessionID))) {
            chatStartupNames.delete(input.sessionID);
            try {
              await caps.showToast({ message: res.created ? `registered in chat as ${res.name}` : `rejoined chat as ${res.name}`, variant: "info", duration: 4000 });
            } catch {
              // Headless or disconnected TUI - registration stands.
            }
          }
        } catch (err) {
          console.error(`[thatch] chat prompt-register failed for ${input.sessionID}: ${err}`);
        }
      }

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
          ? skewWarningText(onDisk, runningVersion)
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
              ? `⚠️ thatch upgraded to v${onDisk} (running v${runningVersion})`
              : `⚠️ thatch v${checker?.getLatestVersion()} is available`;
            await caps.showToast({
              message: short,
              variant: "warning",
              duration: 5000,
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
              await caps.showToast({
                message: `💭 recalled ${matches.length} memor${matches.length === 1 ? "y" : "ies"}`,
                variant: "info",
                duration: 3000,
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
              await caps.showToast({
                message: `💭 ${predItems.length} prediction${predItems.length === 1 ? "" : "s"} surfaced`,
                variant: "info",
                duration: 3000,
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
              await caps.showToast({
                message: `💭 ${behaviorItems.length} behavior${behaviorItems.length === 1 ? "" : "s"} surfaced`,
                variant: "info",
                duration: 3000,
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
    onEvent: async (event) => {
      if (event.type === "session.created") {
        const info = event.properties.info;
        if (info.parentID) {
          childToParent.set(info.id, info.parentID);
          parentSnapshots.set(info.id, [...extraction.peek(info.parentID)]);
          journalChild(info.id);
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
          journalChild(childID);
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
                await caps.showToast({
                  message: `💭 ${parts.join(", ")}`,
                  variant: "success",
                  duration: 4000,
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
            journalChild(sessionID);
            extraction.consume(sessionID);
            // Delete the child session to avoid clutter.
            try {
              await caps.sessionDelete(sessionID);
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
          db.runtimeStateDelete("wrapup", sessionID);
          let ready = false;
          try {
            const data = await caps.sessionMessages(sessionID);
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
                await caps.compactSession(sessionID);
              } else {
                await caps.exitHost();
              }
            } catch (err) {
              console.error(`[thatch] wrap-up action failed: ${err}`);
            }
            // Skip extraction and pending deliveries: compaction is starting
            // (the checklist drained the buffer) or the process is exiting.
            return;
          }
          try {
            await caps.showToast({
              message:
                wrapUp.kind === "compact"
                  ? "⏸ Not compacting - resolve the items listed above, then run /thatch/compact again"
                  : "⏸ Not exiting - resolve the items listed above, then run /thatch/exit again",
              variant: "warning",
              duration: 8000,
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
              const data = await caps.sessionGet(sessionID);
              const title = data?.title ?? "";
              // Placeholder titles never become topics (the real one
              // converges on a later idle via refreshChatTopic).
              const topic = title && !isDefaultSessionTitle(title) ? title : null;
              const res = db.registerChatSession(sessionID, repo, topic, "opencode", null, detectWorktreeKind(worktree));
              // The topic converges as the auto-titler lands a real title:
              // registration is once-per-session, so later idles must
              // refresh it explicitly.
              if (res.ok && topic) db.refreshChatTopic(sessionID, topic);
              // First registration - or a startup resume reclaiming its
              // name, announced here because the TUI was not connected at
              // init - is the one moment the user should notice: a quiet
              // toast, not a conversation message.
              if (res.ok && (res.created || chatStartupNames.has(sessionID))) {
                chatStartupNames.delete(sessionID);
                try {
                  await caps.showToast({ message: res.created ? `registered in chat as ${res.name}` : `rejoined chat as ${res.name}`, variant: "info", duration: 4000 });
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
            debug("extraction", `direct extraction trigger failed for ${sessionID}: ${err}`);
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
        journalChild(id);
        pendingWrapUp.delete(id);
        db.runtimeStateDelete("wrapup", id);
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

      // noReply hosts only: a host without noReply delivery would turn the
      // reminder into a real model turn replying to itself. The system
      // prompt (onSystemTransform) still carries the essentials everywhere.
      // The gate precedes the hygiene scan so v2 sessions (and any other
      // noReply-less host) do not pay a DB + repo scan for a skipped report.
      if (!caps.noReplyDelivery) return;

      let hygiene: string | null = null;
      try {
        hygiene = await hygieneReport(db, repo, worktree, repoCache);
      } catch (err) {
        console.error(`[thatch] hygiene report failed: ${err}`);
      }

      try {
        await caps.promptSession(
          id,
          {
            noReply: true,
            parts: [{ type: "text", text: sessionStartReminder(repo, hygiene), synthetic: true }],
          },
          "sync",
        );
      } catch (err) {
        console.error(`[thatch] session-start reminder failed: ${err}`);
      }
    },

    dispose: async () => {
      stopVersionChecker();
      watchers.dispose();
      chatPoller.dispose();
      await releaseModel();
      // Note: the runtime_state journal is deliberately NOT cleared here.
      // Disposal happens before every v2 plugin reload, and the reloaded
      // setup() rehydrates from it; stale rows from dead processes are
      // pruned by the setup-time partition instead.
      db.close();
    },
  };
}
