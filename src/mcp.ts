import { resolve } from "node:path";
import { z } from "zod";
import { ThatchDB, repoPathCache } from "./db";
import { mcpSessionID } from "./chat";
import { BgeEmbeddingModel } from "./embeddings";
import { detectRepo } from "./git";
import { checkSetup, setupClaudeCode, setupCursor } from "./setup";
import { TOOL_DEFS, trimHostContext, type CoreContext, type HostToolContext, type ToolDef } from "./tool-defs";
import { deepPassthrough } from "./tool-schema";
import { chatOpenTabs as chatOpenTabsProvider } from "./tab-state";
import { actionDefs, mcpSpelling, type ActionDef } from "./commands";
import { SidebandServer, sidebandSocketPath } from "./sideband";
import { peekQueue, consumeQueue, resetMissedCount } from "./extract-queue";
import { buildExtractionPayload } from "./extraction";
import { WatcherRegistry, ghApiRun } from "./watchers";
import { computePluginStage, computePluginChatWake, rehydrateOwnWatchers } from "./flush";
import { pluginToolName } from "./prompts";
import { createPluginLifecycle } from "./claude-plugin/lifecycle";
import { seedDefaultBehaviors } from "./seed-behaviors";
import { writeVersionFile, removeVersionFile, startVersionChecker, stopVersionChecker, getVersionChecker, readModLiveness, readRegimeMarker } from "./version-check";
import pkg from "../package.json";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// Standard JSON-RPC error codes
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// MCP protocol constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "thatch";
const SERVER_VERSION = pkg.version;

/**
 * MCP capabilities declared in the initialize response. Tools plus the
 * prompts that Cursor surfaces as slash commands; no resources or
 * subscriptions.
 */
const CAPABILITIES = {
  tools: { listChanged: false },
  prompts: { listChanged: false },
};

// ---------------------------------------------------------------------------
// Tool index - builds validators and JSON Schema once at server startup
// ---------------------------------------------------------------------------

interface CompiledTool {
  def: ToolDef;
  validator: (input: unknown) => Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

export function compileTools(opts?: { bundled?: boolean }): Map<string, CompiledTool> {
  const map = new Map<string, CompiledTool>();
  for (const def of TOOL_DEFS) {
    // opencodeDbOnly tools read opencode.db - wrong corpus on ANY Claude
    // Code server (bundled included). opencodeOnly tools split by server:
    // the watch family (bundledServable) serves on the BUNDLED server only
    // (it wires ctx.watchers; the mod's timer is its poller/delivery; the
    // standalone server has no registry and no delivery channel), while
    // the rest - the archaeology trio, the session-tab bridge family,
    // exit/compact - stay fenced on every MCP server. bundledOnly tools
    // are wired through the PLUGIN-regime bundled server's CoreContext
    // only.
    if (def.opencodeDbOnly) continue;
    if (def.bundledOnly && !opts?.bundled) continue;
    if (def.opencodeOnly && !(opts?.bundled && def.bundledServable)) continue;
    const schema = z.object(def.args);
    // The validator deep-passthroughs so typo'd keys survive into the
    // tool's accept-then-teach guards at EVERY object level ("you passed
    // 'labels'; did you mean 'label'?"; a typo'd config_set field). The
    // DECLARED inputSchema stays byte-identical to the strict shape:
    // tools/list advertises additionalProperties: false at every level,
    // and only our own validation loosens. The strictness stays in the
    // declaration because no host validates between caller and tool on
    // MCP - the declared schema IS the public contract. (opencode v2
    // loosens its declaration instead, because opencode-core validates
    // against it - see src/opencode/v2.ts.) A client that strips unknown
    // keys against the declared schema before sending still degrades to
    // the plain teaching text - nothing breaks.
    const validatorSchema = deepPassthrough(schema);
    map.set(def.name, {
      def,
      validator: (input: unknown) => validatorSchema.parse(input),
      inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Prompt index - the on-demand actions Cursor surfaces as slash commands
// ---------------------------------------------------------------------------

/**
 * The prompts the MCP server exposes: the shared actions minus the
 * opencode-only ones. Prompts render the same instruction bodies as the
 * command files (src/commands.ts) without the $ARGUMENTS section - the
 * optional focus argument stands in for it.
 */
export function compilePrompts(): Map<string, ActionDef> {
  const map = new Map<string, ActionDef>();
  for (const def of actionDefs()) {
    if (def.opencodeOnly) continue;
    map.set(def.name, { ...def, body: mcpSpelling(def.body) });
  }
  return map;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

/** How this server instance was started. "standalone" is the classic
 *  one-shot-hooks regime (sideband, version file, auto-refresh all live).
 *  "bundled" is the Claude Code plugin regime: the server ships inside the
 *  plugin, is reached in-process by the mod ($.mcp.call), and updates with
 *  it - so everything that exists to bridge "no in-process runtime" is
 *  skipped: no sideband (the shared hashed socket path would collide with
 *  a running Cursor/standalone server), no version file (plugin updates
 *  are the host's own mechanism; a shared version file would flip-flop the
 *  fallback regime's skew detection), no auto-refresh (setup is regime-2),
 *  no behavior seeding (idempotent but per-session waste). */
export type McpServerMode = "standalone" | "bundled";

/** Minutes without a mod liveness ping after which the bundled server
 *  warns that the mod's hooks have gone silent (the disabled-mod hole:
 *  disableAllHooks / allowManagedModsOnly stop the hooks but leave the
 *  server running). Conservative: prompts can legitimately pause for
 *  longer than this inside one working session, so the warning says
 *  "may", never "is". */
const MOD_LIVENESS_STALE_MS = 30 * 60 * 1000;

/**
 * Runs the thatch MCP server over stdio. Reads newline-delimited JSON-RPC from
 * stdin, writes responses to stdout. All diagnostics go to stderr - any stray
 * output on stdout corrupts the protocol.
 *
 * Repo identity is resolved from CLAUDE_PROJECT_DIR (set by Claude Code for
 * stdio servers) or the current working directory as a fallback. The embedding
 * model loads lazily on the first tool call that needs it, so the server
 * starts instantly and only pays the ~34 MB download cost when a memory is
 * actually written or recalled.
 *
 * A Unix domain socket sideband is opened at startup so that one-shot hook
 * processes (thatch flush-tools) can ask the warm MCP server to embed a
 * prompt and search for matches without loading the model themselves.
 */
export async function runMcpServer(mode: McpServerMode = "standalone"): Promise<void> {
  // Deliberate superset of detectRepo's own chain (src/git.ts): the pinned
  // THATCH_PROJECT_DIR (written into project-local MCP configs by setup)
  // beats ambient host vars, which beat the spawn cwd - the server's spawn
  // cwd is the one input no in-repo test can pin.
  const projectDir =
    process.env.THATCH_PROJECT_DIR ?? process.env.CURSOR_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  const home = process.env.HOME ?? "/tmp";
  const configHome = process.env.XDG_CONFIG_HOME ?? `${home}/.config`;
  const dbPath = process.env.THATCH_DB_PATH ?? `${configHome}/thatch/thatch.db`;
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  // The DB must exist before identity detection: detectRepo consults the
  // repo_paths cache when the project directory is gone (deleted worktree).
  const db: ThatchDB = new ThatchDB(dbPath, { chatOpenTabs: chatOpenTabsProvider(() => db.chatTabClosures()) });
  const detected = await detectRepo(projectDir, repoPathCache(db));
  // unknown-to-global, matching the hook's mapping (bin/thatch): chat
  // registration must follow the same store the tools would read, and
  // resolveStore degrades both spellings to the global store anyway. The
  // alignment keeps hook-registered and server-registered rows comparable
  // by project - which the `as` identity binding depends on.
  const repo = detected === "unknown" ? "global" : detected;
  const model = new BgeEmbeddingModel(modelName);

  // Bundled mode (plugin regime) skips everything that exists to bridge
  // "no in-process runtime" - see the McpServerMode doc comment.
  if (mode === "standalone") {
    await seedDefaultBehaviors(db, model);
  }

  // Extraction payload provider: peeks the file-backed queue and returns the
  // serialized JSON payload. Called by the get_extraction_payload tool when a
  // sub-agent needs to fetch the parent's queued interactions. Returns null
  // when no interactions are queued.
  const extractionPayloadProvider = (sessionID: string): string | null => {
    const interactions = peekQueue(sessionID);
    if (interactions.length === 0) return null;
    return buildExtractionPayload(interactions, repo);
  };

  // Drain a session's file-backed queue and reset its missed-nudge counter.
  // Called by extraction_done when a sub-agent passes the parent's session_id.
  // Without this, the MCP path's appendBatch self-detection would drain the
  // sub-agent's (empty) queue instead of the parent's.
  const drainExtractionQueue = (sessionID: string): void => {
    resetMissedCount(sessionID);
    consumeQueue(sessionID);
  };

  // The bundled server's session identity for the MODEL's tool calls: the
  // host's MCP client supplies no session context, but the mod's stage
  // call runs per prompt (before the turn's tool calls) and anchors
  // (server ppid -> the RAW host session id). The dispatcher synthesizes
  // the host context from it, so session-scoped tools (the watch family)
  // resolve their owner. In-memory; per-session by construction.
  const rawSessionByPid = new Map<number, string>();
  const rehydratedSessions = new Set<string>();

  // Bundled mode wires the WATCHER REGISTRY: the five watch tools serve
  // here (their opencodeOnly fence named the missing poller/delivery -
  // the mod's timer IS the poller and $.prompt.submit IS the delivery).
  // Registrations are DB-backed via the SAME journal hooks the opencode
  // runtime uses (runtime_state rows: durable across sessions, mod
  // reloads, and server restarts; the rehydrate re-arms every row at
  // startup). canDeliver is FALSE - events accumulate in the registry's
  // pending queue and the mod PULLS them on its clock beat
  // (plugin_watch_poll), the accumulate-poll-submit pattern.
  const watchers = mode === "bundled"
    ? new WatcherRegistry({
        directory: projectDir,
        journal: (sessionID, sessionWatchers) => {
          if (sessionWatchers.length === 0) db.runtimeStateDelete("watchers", sessionID);
          else db.runtimeStatePut("watchers", sessionID, sessionWatchers, projectDir);
        },
        journalPending: (sessionID, pending) => {
          if (pending === undefined) db.runtimeStateDelete("watcher_pending", sessionID);
          else db.runtimeStatePut("watcher_pending", sessionID, pending, projectDir);
        },
        onSessionDeath: () => {
          // Cleanup-only death handling (see the lifecycle's session-end):
          // the care-based death notices need the opencode spawn-metadata
          // coordinator link - a named gap on Claude Code.
        },
        deliver: async () => {
          // Unreachable: canDeliver is false - the mod's pull drains.
        },
        canDeliver: () => false,
        ghRunner: ghApiRun,
      })
    : null;
  if (mode === "bundled") {
    // The front door's instructions channel: no `thatch setup` runs in the
    // marketplace world, so the bundled server ensures the CLAUDE.md
    // block itself (idempotent; the guard-proof channel - the mod has no
    // prompt.compose). Best-effort: a read-only project degrades to
    // instructions-missing, surfaced by the tester's first look.
    try {
      const { ensurePluginInstructions } = await import("./setup");
      ensurePluginInstructions(projectDir);
    } catch (err) {
      console.error(`[thatch] could not ensure the CLAUDE.md instructions block: ${err}`);
    }
  }
  if (watchers) {
    // NO startup rehydrate: a bundled server re-arming every journaled
    // row would HIJACK the machine's watchers - rewriting pid/directory
    // on rows owned by LIVE opencode daemons (observed live: a QA round's
    // server rewrote all five rows on the machine, stranding a pending
    // notification against a dead pid). Rehydration is DEFERRED to the
    // stage anchor: when the session id is known, ONLY that session's
    // rows re-arm (its own continuity - a regenerated plugin's new server
    // picks its own session's watches back up); foreign rows are never
    // touched, and their owners' machinery rehydrates them.
    watchers.start();
  }

  const lifecycle = mode === "bundled"
    ? createPluginLifecycle({ db, model, repo, dbPath, watchers: watchers ?? undefined })
    : null;
  const ctx: CoreContext = {
    db,
    model,
    defaultStore: repo,
    extractionPayloadProvider,
    drainExtractionQueue,
    // The plugin regime's stage tool: the mod's prompt.submit handler calls
    // it per prompt ($.mcp.call), and the server runs the flush tiers
    // server-side (the sideband's role, reborn in-process).
    ...(mode === "bundled"
      ? {
          pluginStage: (prompt: string, sessionID: string, transcriptPath?: string) => {
            rawSessionByPid.set(process.ppid, sessionID);
            // The OWN-SESSION watcher rehydrate (once per session id): the
            // rows THIS session journaled re-arm under THIS server - the
            // plugin's continuity mechanism - and foreign rows are never
            // read, let alone rewritten.
            if (watchers && !rehydratedSessions.has(sessionID)) {
              rehydratedSessions.add(sessionID);
              void rehydrateOwnWatchers(db, watchers, sessionID);
            }
            return computePluginStage({ db, model, repo, dbPath, toolNamer: pluginToolName }, prompt, sessionID, transcriptPath);
          },
          pluginLifecycle: (event) => lifecycle!.handle(event),
          pluginChatWake: (sessionID: string) => computePluginChatWake(db, sessionID),
          ...(watchers ? { watchers } : {}),
          projectDir,
        }
      : {}),    // Same-machine tab reader: the MCP server can read the local opencode
    // state tree, so its roster renders the same open/recent split.
    openTabs: chatOpenTabsProvider(() => db.chatTabClosures()),
    // Claude Code identity anchor, two model-proof layers:
    //  1. The hooks record (parent pid -> session) from payloads the model
    //     cannot influence, and this server is a child of the same Claude
    //     Code process - current even after a session fork.
    //  2. CLAUDE_CODE_SESSION_ID, set by the host in this server's env at
    //     spawn ("retains the ID it was spawned with") - covers the case
    //     where hook and server parent pids diverge, but goes stale after a
    //     fork/continue, so it is the fallback, not the primary.
    // A miss on both falls back to the caller-claimed `as` (Cursor).
    chatDerivedIdentity: () => {
      const mapped = db.findChatSessionByHostPid(process.ppid, 600);
      if (mapped) return mapped;
      const envID = process.env.CLAUDE_CODE_SESSION_ID;
      return envID ? db.findChatSession(mcpSessionID(envID))?.session_id ?? null : null;
    },
  };
  const tools = compileTools({ bundled: mode === "bundled" });
  const prompts = compilePrompts();

  // Check whether `thatch setup` was run for the current host. If not, or if
  // markers are broken, surface a warning on the first tools/call response so
  // the agent can tell the user to run setup. Also emit to stderr for
  // visibility in host debug logs. Bundled mode skips this: the plugin IS
  // the install (its marker-based checkSetup logic is the fallback
  // regime's, and a plugin-only install writes no fallback markers).
  let setupWarning: string | null = null;
  // The regime marker decides what a STANDALONE server says: under the
  // plugin regime a standalone server should not be configured at all
  // (double delivery), so it warns instead of auto-refreshing (auto-
  // refresh would resurrect the deactivated fallback hooks and markers).
  const regimeMarker = mode === "standalone"
    // HOST-SCOPED: a mixed-host machine runs Cursor's standalone server
    // beside Claude's plugin regime - Cursor's marker absence must not
    // inherit Claude's (wrong advice + dead auto-refresh).
    ? readRegimeMarker(dbPath, process.env.CURSOR_PROJECT_DIR ? "cursor" : "claude")
    : null;
  if (mode === "standalone") {
    const setupStatus = checkSetup(projectDir);
    if (regimeMarker === "plugin") {
      setupWarning =
        "Thatch is in the PLUGIN regime (the Claude Code plugin owns this install), but a standalone thatch MCP server is still configured in this host's MCP config. Remove the mcpServers.thatch entry (`claude mcp remove thatch`, or delete it from .mcp.json) - both servers delivering means nudges and context arrive twice.";
      console.error(`[thatch] ${setupWarning}`);
    } else if (setupStatus && setupStatus.status !== "installed") {
      setupWarning = setupStatus.message;
      console.error(`[thatch] ${setupWarning}`);
    }
  }

  // Version warning: surfaced once on the first tools/call response. The
  // primary delivery channel is flush-tools (fires on every prompt), so this
  // is a backup. Combines npm update-available and version-skew warnings.
  // Bundled mode skips it: the server updates with the plugin, so skew
  // cannot arise there, and the shared version file belongs to the
  // standalone regime.
  let versionWarning: string | null = null;
  if (mode === "standalone") {
    const checker = getVersionChecker();
    if (checker) {
      const updateMsg = checker.getUpdateWarning();
      if (updateMsg) {
        versionWarning = updateMsg;
        console.error(`[thatch] ${updateMsg}`);
      }
    }
  }

  // Auto-refresh: if setup was previously run (markers exist), re-run the
  // install functions to update skills, instructions, and hooks that may have
  // drifted since the last `thatch setup`. All operations are idempotent --
  // they only write when content differs. This keeps MCP-host installations
  // up to date without requiring the user to manually re-run setup after
  // upgrading thatch. The MCP config itself is also re-written, but it
  // writes the same command that's already running, so it's a no-op in
  // practice. Bundled mode NEVER auto-refreshes: re-running the fallback
  // setup here would resurrect the deactivated settings hooks and CLAUDE.md
  // markers behind the plugin regime's back (the regime-warfare failure).
  if (mode === "standalone" && regimeMarker !== "plugin") {
    const setupStatus = checkSetup(projectDir);
    if (setupStatus?.status === "installed") {
      const thatchBin = resolve(process.argv[1] ?? process.execPath);
      const isGlobal = setupStatus.scope === "global";
      try {
        if (setupStatus.host === "claude") {
          setupClaudeCode(thatchBin, isGlobal, projectDir);
        } else if (setupStatus.host === "cursor") {
          setupCursor(thatchBin, isGlobal, projectDir);
        }
      } catch (err) {
        // Auto-refresh is best-effort. A failure here does not affect the
        // MCP server's ability to serve tool calls -- it just means skills
        // or instructions may be stale until the user re-runs setup.
        console.error(`[thatch] auto-refresh of skills/instructions failed: ${err}`);
      }
    }
  }

  // The sideband socket lets one-shot hook processes (flush-tools) ask the
  // warm MCP server to embed a prompt and search for matches - without
  // loading the ~34 MB model themselves. If the socket can't be opened
  // (permissions, tmpdir issues), the MCP server still works; only the
  // prompt-aware recall nudge degrades. Bundled mode skips it: the mod
  // reaches the server through $.mcp.call, and the shared hashed socket
  // path belongs to the standalone regime (a second bind would race a
  // running Cursor/standalone server).
  const sideband = new SidebandServer(sidebandSocketPath(dbPath), model, db);
  if (mode === "standalone") {
    try {
      sideband.start();
    } catch (err) {
      console.error(`[thatch] sideband socket failed: ${err}`);
    }
  }
  // In bundled mode the sideband NEVER starts and NEVER stops: stop()
  // unlinks the shared hashed socket path, which a live standalone/Cursor
  // server may own - unlinking it would silently kill the fallback
  // regime's recall nudges. The teardown gets a no-op shape instead.

  // Version file + npm update polling: standalone-regime machinery (the
  // hook processes' skew/update checks read these). Bundled mode touches
  // neither - a plugin-era write would flip-flop the fallback regime's
  // skew detection, and the plugin's own update channel replaces the
  // npm poll.
  if (mode === "standalone") {
    writeVersionFile(dbPath);
    startVersionChecker(dbPath);
  }

  // The disabled-mod warning (bundled mode): RE-EVALUATED PER tools/call,
  // not once at startup. A stamp fresh at startup can go stale mid-life
  // (the disableAllHooks case the detector exists for), and a stale stamp
  // at startup can belong to a PREVIOUS session (a false positive on the
  // user's return). The read is one cached file stat per call; the
  // warning surfaces once per session (the delivered flag below).
  let modWarningDelivered = false;

  // Idempotent teardown, shared by the stdin-end path (the host closed the
  // pipe - the normal shutdown) and the signal handlers (SIGINT/SIGTERM/
  // SIGHUP kill the process mid-loop, and without handlers they skipped
  // every teardown step). Order matters: the sideband goes first (nothing
  // may reach the model after disposal), the model's ONNX sessions release
  // before the db closes, and the db close runs in a finally so a disposal
  // failure cannot leak the connection.
  const teardown = createMcpTeardown({
    sideband: mode === "standalone" ? sideband : { stop() { /* never started - do not unlink the shared socket path */ } },
    model,
    db,
    dbPath,
    stopVersionChecker,
    // Bundled mode never wrote the version file - removing it here would
    // delete the STAMP a live standalone server owns (same shared path).
    removeVersionFile: mode === "standalone" ? removeVersionFile : () => {},
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      void teardown(signal).then(() => process.exit(0));
    });
  }

  // Read stdin line by line. Each line is a complete JSON-RPC message.
  const decoder = new TextDecoder();
  let buf = "";

  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk as unknown as ArrayBuffer);

    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        continue;
      }

      // Notifications (no id) are fire-and-forget - no response expected.
      const isNotification = req.id === null || req.id === undefined;
      // The disabled-mod staleness is measured BEFORE the tool runs: the
      // stage tool's own liveness stamp would defeat a post-call read.
      const isToolsCall = req.method === "tools/call";
      const modSilentAtCall = isToolsCall && mode === "bundled" && !modWarningDelivered && (() => {
        const lastPing = readModLiveness(dbPath);
        return lastPing !== null && Date.now() - lastPing > MOD_LIVENESS_STALE_MS;
      })();

      const res = await dispatch(req, tools, prompts, ctx, mode === "bundled"
        ? () => {
            const raw = rawSessionByPid.get(process.ppid);
            // The STORED key (the mcp hash), not the raw host id: the chat
            // rows and the watch journal are keyed by it - a raw id here
            // resolved every identity tool to "not registered" (the
            // round-4 finding).
            return raw ? trimHostContext({ sessionID: mcpSessionID(raw), agent: "" }) : undefined;
          }
        : undefined);
      if (res === null || isNotification) continue;

      // Surface the setup warning on the first tools/call response so the
      // agent sees it and can notify the user. Cleared after one surfacing.
      if (setupWarning && req.method === "tools/call" && !res.error) {
        const content = res.result?.content;
        if (Array.isArray(content) && content[0]?.text != null) {
          content[0].text = `[thatch] ${setupWarning}\n\n${content[0].text}`;
        }
        setupWarning = null;
      }

      // Surface the version warning once per session on the first tools/call.
      // The primary delivery channel is flush-tools (fires on every prompt),
      // so this is a backup for when hooks are missing or fail. Cleared after
      // one surfacing. In bundled mode the same slot carries the disabled-mod
      // warning instead (the plugin regime has no version-skew surface).
      if (isToolsCall && !res.error) {
        let warning: string | null;
        if (mode === "standalone") {
          warning = versionWarning;
        } else {
          // Measured pre-call (above); surfaced once per session.
          warning = modSilentAtCall
            ? "The thatch plugin's mod may not be delivering right now: its liveness ping is stale, so nudges and context injection may not reach the model (hooks may be disabled by disableAllHooks, --safe-mode, or a managed allowManagedModsOnly setting). If this session has been idle for a long time this warning may be spurious; otherwise tell the user their thatch plugin may not be delivering."
            : null;
          if (warning) console.error(`[thatch] ${warning}`);
        }
        if (warning) {
          const content = res.result?.content;
          if (Array.isArray(content) && content[0]?.text != null) {
            content[0].text = `[thatch] ${warning}\n\n${content[0].text}`;
          }
          if (mode === "standalone") versionWarning = null;
          else modWarningDelivered = true;
        }
      }

      send(res);
    }
  }

  await teardown("stdin-end");
}

/**
 * Builds the idempotent MCP-server teardown. Injected deps so tests can
 * spy on the close order without spawning anything: sideband first
 * (nothing may reach the model after disposal), version checker + file
 * next, the model's native ONNX sessions in a catch (a disposal failure
 * must not skip the db close), and the db in a finally.
 */
export function createMcpTeardown(deps: {
  sideband: { stop(): void };
  model: { dispose(): Promise<void> };
  db: { close(): void };
  dbPath: string;
  stopVersionChecker: () => void;
  removeVersionFile: (dbPath: string) => void;
}): (reason: string) => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return (reason: string): Promise<void> => {
    // Idempotent ACROSS awaits: a second call while the first teardown is
    // still running returns the IN-FLIGHT promise, so an early
    // process.exit(0) waits out the model disposal and the db close
    // instead of cutting them (a fresh resolve() skipped them). `torn`
    // tracking is subsumed: inFlight is set synchronously before any await.
    if (inFlight) return inFlight;
    void reason;
    // Every step is isolated: a teardown step's own failure must not
    // block the remaining ones (the sideband throwing on an
    // already-unlinked socket used to skip the model disposal and the
    // db close entirely).
    try {
      deps.sideband.stop();
    } catch (err) {
      console.error(`[thatch] MCP sideband stop failed: ${err}`);
    }
    try {
      deps.stopVersionChecker();
    } catch (err) {
      console.error(`[thatch] MCP version-checker stop failed: ${err}`);
    }
    try {
      deps.removeVersionFile(deps.dbPath);
    } catch (err) {
      console.error(`[thatch] MCP version-file removal failed: ${err}`);
    }
    inFlight = deps.model
      .dispose()
      .catch((err: unknown) => console.error(`[thatch] MCP model disposal failed: ${err}`))
      .finally(() => {
        try {
          deps.db.close();
        } catch (err) {
          console.error(`[thatch] MCP db close failed: ${err}`);
        }
      });
    return inFlight;
  };
}

/**
 * Dispatches a single JSON-RPC request to the appropriate handler. Returns
 * a response object, or null for notifications (which require no response).
 */
async function dispatch(
  req: JsonRpcRequest,
  tools: Map<string, CompiledTool>,
  prompts: Map<string, ActionDef>,
  ctx: CoreContext,
  hostContextFactory?: (validated: Record<string, unknown>) => HostToolContext | undefined,
): Promise<JsonRpcResponse | null> {
  const { id, method } = req;

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: CAPABILITIES,
        });

      case "notifications/initialized":
        // Client acknowledges our capabilities. No response needed.
        return null;

      case "tools/list":
        return ok(id, {
          tools: [...tools.values()].map((t) => ({
            name: t.def.name,
            description: t.def.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const name = req.params?.name;
        const args = req.params?.arguments ?? {};

        const compiled = tools.get(name);
        if (!compiled) {
          return ok(id, {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
          });
        }

        let validated: Record<string, unknown>;
        try {
          validated = compiled.validator(args);
        } catch (err: any) {
          const msg = err.issues
            ? err.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")
            : String(err?.message ?? err);
          return ok(id, {
            isError: true,
            content: [{ type: "text", text: `Invalid arguments: ${msg}` }],
          });
        }

        try {
          const text = await compiled.def.execute(validated, ctx, hostContextFactory?.(validated));
          return ok(id, {
            isError: false,
            content: [{ type: "text", text }],
          });
        } catch (err: any) {
          return ok(id, {
            isError: true,
            content: [{ type: "text", text: `Tool error: ${err?.message ?? err}` }],
          });
        }
      }

      case "prompts/list":
        return ok(id, {
          prompts: [...prompts.values()].map((p) => ({
            name: p.name,
            description: p.description,
            arguments: [
              {
                name: "focus",
                description: "Optional text for the action: a scope (for example, which store to work on), a review target (branch, PR, MR, or git range), or other context",
                required: false,
              },
            ],
          })),
        });

      case "prompts/get": {
        const prompt = prompts.get(req.params?.name);
        if (!prompt) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: METHOD_NOT_FOUND, message: `Unknown prompt: ${req.params?.name}` },
          };
        }
        const focus = req.params?.arguments?.focus;
        const text = focus
          ? `${prompt.body}\n\nFocus: ${focus}`
          : prompt.body;
        return ok(id, {
          description: prompt.description,
          messages: [{ role: "user", content: { type: "text", text } }],
        });
      }

      case "ping":
        return ok(id, {});

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INTERNAL_ERROR, message: err?.message ?? "Internal error" },
    };
  }
}

function ok(id: number | string | null, result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function send(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}
